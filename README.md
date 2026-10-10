# Phone Use Page

A browser-based, rootless Android console for humans and browser-capable agents.
It combines a live phone screen, an accessible UI tree, text input and a restricted JavaScript automation API.

## Features

- Responsive two-column workspace: near-full-height phone video on the left, controls and inspection on the right.
- Parallel video connection attempts with promotion from WSS to Cloudflare TURN to your own TURN server; manual transport selection is also available.
- Click, drag, long press, navigation, notification shade and quick-settings controls.
- A real HTML textbox for the confirmed Android input target: `fill`, typing, Unicode text, Enter and Tab, with native readback verification.
- UHID hardware-keyboard reports for raw keys and shortcuts; normal text bypasses IME composition through UI Automator text replacement.
- Installed apps, recent tasks, process diagnostics, screenshots, video reconnect and an operation timeline.
- A restricted QuickJS device API with unique-target matching, cancellation and a 60-second task limit.
- Password login, persistent secure sessions, one active control page, five-minute inactivity disconnect and temporary stay-awake restoration.
- Bounded request audit logs with client IP, user agent and session metadata; passwords, cookies, text and script bodies are excluded.

The UI is currently in Chinese. No root or bootloader unlock is required.

## Requirements

- Node.js 22.12+, Python 3.11+, ADB and an Android device with USB debugging authorized.
- Python venv/pip; `uv` is optional for the provided setup script.
- A current Chromium browser for WebCodecs/WebRTC. HTTPS is required outside localhost.
- FFmpeg when enabling adaptive WSS encoding.
- Linux for the USB Docker Compose configuration. Native development can also run on macOS; Docker Desktop USB/host networking is not equivalent to Linux.

Some Android vendors require an additional USB-debugging security setting for event injection. Hardware-keyboard and UI accessibility behavior also depend on the device and app.

See the [complete Setup manual](docs/SETUP.md), [configuration reference](docs/CONFIGURATION.md) and [portability boundaries](docs/PORTABILITY.md) for a new installation. No specific phone, NAS, router, DNS or proxy product is required.

## Run Locally

```sh
sh scripts/setup.sh
cp .env.example .env
mkdir -p .local
chmod 700 .local
```

Create `.local/console-password` containing your own password of 12-512 characters and set its permissions to `0600`. No default password is shipped.
Set `ANDROID_SERIAL` in `.env` if multiple devices are attached; otherwise the native server selects the single connected device. Use `adb devices` to discover your device.

The supplied env examples use WSS only: `WEBRTC_ENABLED=0`, `VIDEO_WSS_FALLBACK=1`. This requires no TURN key or external STUN service. Enable direct WebRTC, self-hosted TURN or Cloudflare TURN independently when needed; [transport recipes](docs/SETUP.md#5-select-video-transports) cover each combination. Use `WSS_ADAPTIVE_ENCODER=0` if you do not want FFmpeg adaptation.

```sh
sh scripts/start.sh
```

Open `http://localhost:8780/`. Click **唤醒并解锁** to wake/unlock a device without a passcode; passcode entry remains a manual device operation.

The confirmed phone input appears as a browser textbox named **手机输入框: ...**. Agents should fill that textbox, rather than attempting to fill the video surface. Enter/Tab are sent after the text is verified; Shift+Enter inserts a newline. The right-side text editor exposes the same target and a draft mode.

## Docker and Remote Access

See [DEPLOYMENT.md](DEPLOYMENT.md) for the Linux USB container, reverse proxy, base paths, TURN credentials, WSS and rollback procedure.
All device identifiers, passwords, relay URLs, proxy addresses and key files belong in private local configuration.

## Verification

```sh
npm run build
PYTHON_PATH=.venv/bin/python npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
CHROME_PATH=/path/to/chrome npm run test:ui
npm run check:compose # requires the Docker Compose plugin
```

Browser checks use synthetic fixtures; they do not control a real device. Live tests are separate opt-in scripts under `tests/`; configure your own device/URLs/secrets and review their effects before running them. Capture output is written under ignored `.local/`.

## Limitations

- Custom-drawn interfaces, protected video and some WebViews may not expose usable nodes or text actions.
- Password fields are not mirrored. Text replacement does not synchronize Android cursor position, selection or IME composition.
- An IME may interpret raw hardware keys; UHID is not a guarantee of literal Unicode text entry.
- Clipboard reading can be empty or restricted by Android; the UI reports an unavailable result explicitly.
- The UI tree and video have separate freshness indicators. Frame age and network round-trip time are not end-to-end capture latency.
- Stable DOM/Android targets reduce churn but cannot guarantee the lifetime of an agent tool's own accessibility snapshot references.
- A device action that already started cannot be rolled back when a script is cancelled.

## Privacy and Security

See [docs/SECURITY.md](docs/SECURITY.md). `.local/`, `.env`, certificates, device keys, captures, audit stores and site-specific deployment automation must stay private.
Docker builds use an allowlisted context, and Git excludes runtime/private directories. Run `npm run check:publication` before committing or publishing.

## License

Application code is MIT licensed. The unmodified vendored scrcpy 3.3.3 server is Apache-2.0 licensed; its license and attribution are retained in [vendor/README.md](vendor/README.md) and `vendor/scrcpy-LICENSE`. Dependency licenses remain their own; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
