import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { ConsoleError } from './types.js';

const exec = promisify(execFile);
const remote = '/data/local/tmp/android-console-screencap';
// AOSP 12 screencap plus: -s captures FLAG_SECURE layers, -w/-H scale the
// capture buffer. Building it needs the platform tree; keep the binary here so
// the console only needs the device's own root channel at runtime.
const expectedSha = 'c6838b114aabc590ac60d622b26e2e6d717f7c68eaf06a47f04dcd9a814f3aa6';

export class SecureFrame {
  private pushed?: Promise<void>;
  private inFlight?: Promise<Buffer>;
  private last?: { size: string; at: number; image: Buffer };

  constructor(private adb: string, private serial: string) {}

  private async ensureBinary() {
    this.pushed ||= (async () => {
      const file = resolve('vendor/screencap-secure-arm64');
      const data = await readFile(file);
      const sha = createHash('sha256').update(data).digest('hex');
      if (sha !== expectedSha) throw new Error('vendor/screencap-secure-arm64 checksum mismatch: ' + sha);
      const check = async () => {
        try {
          const out = await exec(this.adb, ['-s', this.serial, 'shell', 'sha256sum ' + remote], { timeout: 10000 });
          return out.stdout.trim().split(/\s+/)[0] === sha;
        } catch {
          return false;
        }
      };
      if (!(await check())) {
        await exec(this.adb, ['-s', this.serial, 'push', file, remote], { timeout: 60000, maxBuffer: 1 << 20 });
        await exec(this.adb, ['-s', this.serial, 'shell', 'chmod 755 ' + remote], { timeout: 10000 });
        if (!(await check())) throw new Error('device copy of secure screencap does not match vendor binary');
      }
    })().catch(error => {
      this.pushed = undefined;
      throw error;
    });
    return this.pushed;
  }

  async capture(width?: number, height?: number): Promise<Buffer> {
    const size = width && height ? width + 'x' + height : 'full';
    if (this.last && this.last.size === size && Date.now() - this.last.at < 500) return this.last.image;
    this.inFlight ||= this.run(width, height).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async run(width?: number, height?: number): Promise<Buffer> {
    await this.ensureBinary();
    const args = [remote, '-s', '-p'];
    if (width && height) args.push('-w', String(width), '-H', String(height));
    let stdout: Buffer;
    try {
      const out = await exec(this.adb, ['-s', this.serial, 'exec-out', '/debug_ramdisk/su', '-c', args.join(' ')], { encoding: 'buffer', maxBuffer: 32 << 20, timeout: 20000 });
      stdout = out.stdout;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConsoleError('SECURE_CAPTURE_FAILED', '安全截图失败：' + detail, 502);
    }
    if (stdout.length < 1024 || stdout[0] !== 0x89 || stdout.subarray(1, 4).toString('latin1') !== 'PNG') {
      throw new ConsoleError('SECURE_CAPTURE_FAILED', '安全截图失败：设备没有返回 PNG（检查 /debug_ramdisk/su 是否可用）', 502);
    }
    this.last = { size: width && height ? width + 'x' + height : 'full', at: Date.now(), image: stdout };
    return stdout;
  }
}
