import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import type { AdbDeviceState, AdbHealthSnapshot } from './types.js';

export interface AdbRunResult { code: number | null; stdout: string; stderr: string }
export type AdbRunner = (args: string[], timeoutMs: number) => Promise<AdbRunResult>;
export interface AdbRecoveryResult { steps: string[]; state: AdbHealthSnapshot }

export interface AdbHealthOptions {
  adbPath: string;
  serial: string;
  /** Rebuild the layers that ride on the transport (UI bridge, scrcpy) after it is back. */
  onRestore: () => Promise<void>;
  run?: AdbRunner;
  now?: () => number;
  /** Gesture- or task-level work must not be interrupted by a transport reset. */
  isIdle?: () => boolean;
  probeIntervalMs?: number;
  reconnectWaitMs?: number;
  serverWaitMs?: number;
  restartCooldownMs?: number;
  restartWindowMs?: number;
  maxRestartsPerWindow?: number;
  maxAttemptsBeforePause?: number;
  pauseMs?: number;
  auto?: boolean;
  log?: (line: string) => void;
}

const messages: Record<AdbDeviceState, string> = {
  device: '设备在线',
  offline: '设备离线：transport 被占用，或 adbd 正在重启',
  unauthorized: '设备未授权：adbd 重启后需要重新确认 USB 调试',
  missing: '设备不在设备列表：USB 可能被其他程序或另一台 adb server 占用',
  server_error: 'adb server 不可用：可能被其他 adb 客户端重启或版本不匹配',
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)));

function defaultRunner(adbPath: string): AdbRunner {
  return (args, timeoutMs) => new Promise(resolve => {
    execFile(adbPath, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const raw = (error as (Error & { code?: number | string }) | null)?.code;
      resolve({
        code: typeof raw === 'number' ? raw : error ? 1 : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr || (error ? error.message : '')),
      });
    });
  });
}

/**
 * Watches the adb transport under the console and puts it back when an outside
 * client takes it away (`kill-server`, a version-mismatched server restart, a
 * USB grab, or an `adb root` that restarts adbd).
 *
 * Automatic attempts are deliberately restrained: reconnect first, restart the
 * server at most every `restartCooldownMs` and `maxRestartsPerWindow` times per
 * window, back off between attempts, and stop trying altogether for `pauseMs`
 * once `maxAttemptsBeforePause` is reached — so the console does not fight an
 * external adb user in a loop. `recover(true)` (the UI button) ignores the
 * gates and resets the backoff.
 */
export class AdbHealth extends EventEmitter {
  private readonly options: AdbHealthOptions;
  private readonly run: AdbRunner;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly auto: boolean;
  private state: AdbHealthSnapshot = { phase: 'ok', detail: 'device', busy: false, lastOkAt: null, lastAttemptAt: null, lastError: null, attempts: 0, nextAttemptAt: null };
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<AdbRecoveryResult>;
  private restarts: number[] = [];
  private pausedUntil = 0;

  constructor(options: AdbHealthOptions) {
    super();
    this.options = options;
    this.run = options.run ?? defaultRunner(options.adbPath);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (line => console.error('[adb-health] ' + line));
    this.auto = options.auto ?? process.env.ADB_AUTO_RECOVER !== '0';
  }

  snapshot(): AdbHealthSnapshot { return { ...this.state }; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.checkNow(); }, this.options.probeIntervalMs ?? 8000);
    this.timer.unref?.();
    void this.checkNow();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** `adb devices` is cheap and reliable enough to classify what the transport is doing. */
  async probe(): Promise<AdbDeviceState> {
    const result = await this.run(['devices'], 4000);
    if (result.code !== 0) return 'server_error';
    const line = result.stdout.split('\n').find(entry => entry.startsWith(this.options.serial + '\t'));
    if (!line) return /cannot connect to daemon|server version/i.test(result.stderr) ? 'server_error' : 'missing';
    const detail = (line.split('\t')[1] || '').trim();
    if (detail === 'device' || detail === 'offline' || detail === 'unauthorized') return detail;
    return 'missing';
  }

  recover(force = false): Promise<AdbRecoveryResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runRecovery(force).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  /** One probe + (when due) one restrained recovery attempt; the timer calls this. */
  async checkNow() {
    if (this.inFlight) return;
    const detail = await this.probe().catch(() => 'server_error' as AdbDeviceState);
    if (detail === 'device') {
      const wasBad = this.state.phase !== 'ok';
      this.markOk();
      // `adb devices` itself restarts a killed server; the transport came back
      // without a recovery run, so the layers above it still need a rebuild.
      if (wasBad) { try { await this.options.onRestore(); } catch (error) { this.log('restore failed: ' + String(error)); } }
      return;
    }
    const now = this.now();
    if (this.pausedUntil && now >= this.pausedUntil) { this.pausedUntil = 0; this.state.attempts = 0; }
    this.setState({ ...this.state, phase: this.state.phase === 'paused' && this.pausedUntil ? 'paused' : 'degraded', detail, lastError: messages[detail] });
    if (!this.auto || !this.canAttempt(now)) return;
    if (this.options.isIdle && !this.options.isIdle()) return;
    await this.recover(false).catch(error => this.log('recover failed: ' + String(error)));
  }

  private async runRecovery(force: boolean): Promise<AdbRecoveryResult> {
    const steps: string[] = [];
    const startedAt = this.now();
    let detail = await this.probe().catch(() => 'server_error' as AdbDeviceState);
    if (detail === 'device') {
      this.markOk();
      // 手动恢复即使链路已通也要重建页面/视频层，用来清掉半死的 scrcpy/worker。
      if (force) { try { await this.options.onRestore(); } catch (error) { this.log('restore failed: ' + String(error)); } }
      return { steps, state: this.snapshot() };
    }

    this.setState({ ...this.state, phase: 'recovering', busy: true, detail, lastAttemptAt: startedAt, attempts: this.state.attempts + 1, lastError: this.state.lastError ?? messages[detail] });
    steps.push('reconnect');
    await this.run(['-s', this.options.serial, 'reconnect'], 4000).catch(() => undefined);
    if (detail === 'offline' || detail === 'unauthorized') await this.run(['reconnect', 'offline'], 4000).catch(() => undefined);
    detail = await this.waitForDevice(this.options.reconnectWaitMs ?? 8000);

    if (detail !== 'device' && (force || this.canRestartServer(this.now()))) {
      steps.push('restart-server');
      this.restarts.push(this.now());
      await this.run(['kill-server'], 6000).catch(() => undefined);
      await this.run(['start-server'], 20000).catch(() => undefined);
      detail = await this.waitForDevice(this.options.serverWaitMs ?? 15000);
    } else if (detail !== 'device') {
      steps.push('restart-skipped');
    }

    if (detail === 'device') {
      this.setState({ ...this.state, phase: 'ok', busy: false, detail: 'device', lastOkAt: this.now(), lastError: null, attempts: 0, nextAttemptAt: null });
      this.pausedUntil = 0;
      try { await this.options.onRestore(); } catch (error) { this.log('restore failed: ' + String(error)); }
    } else {
      this.fail(detail);
    }
    return { steps, state: this.snapshot() };
  }

  private fail(detail: AdbDeviceState) {
    const now = this.now();
    const attempts = this.state.attempts;
    const max = this.options.maxAttemptsBeforePause ?? 8;
    const paused = attempts >= max;
    const nextAttemptAt = paused ? now + (this.options.pauseMs ?? 300000) : now + this.backoff(attempts);
    this.pausedUntil = paused ? nextAttemptAt : 0;
    this.setState({ ...this.state, phase: paused ? 'paused' : 'degraded', busy: false, detail, lastError: messages[detail], nextAttemptAt });
  }

  private backoff(attempts: number) { return Math.min(300000, 5000 * 2 ** Math.max(0, attempts - 1)); }

  private canAttempt(now: number) {
    if (this.state.phase === 'paused' && this.pausedUntil) return now >= this.pausedUntil;
    return this.state.nextAttemptAt === null || now >= this.state.nextAttemptAt;
  }

  private canRestartServer(now: number) {
    const windowMs = this.options.restartWindowMs ?? 600000;
    this.restarts = this.restarts.filter(at => now - at < windowMs);
    const last = this.restarts[this.restarts.length - 1];
    if (last !== undefined && now - last < (this.options.restartCooldownMs ?? 60000)) return false;
    return this.restarts.length < (this.options.maxRestartsPerWindow ?? 3);
  }

  private async waitForDevice(limitMs: number): Promise<AdbDeviceState> {
    const deadline = this.now() + limitMs;
    let detail: AdbDeviceState = 'missing';
    do {
      detail = await this.probe().catch(() => 'server_error' as AdbDeviceState);
      if (detail === 'device') return detail;
      await sleep(Math.min(500, deadline - this.now()));
    } while (this.now() < deadline);
    return detail;
  }

  private markOk() {
    this.setState({ ...this.state, phase: 'ok', busy: false, detail: 'device', lastOkAt: this.now(), lastError: null, attempts: 0, nextAttemptAt: null });
    this.pausedUntil = 0;
  }

  private setState(next: AdbHealthSnapshot) {
    const prev = this.state;
    const changed = prev.phase !== next.phase || prev.detail !== next.detail || prev.busy !== next.busy
      || prev.lastError !== next.lastError || prev.attempts !== next.attempts || prev.nextAttemptAt !== next.nextAttemptAt;
    this.state = next;
    if (changed) this.emit('state', this.snapshot());
  }
}
