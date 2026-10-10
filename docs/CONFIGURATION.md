# Configuration Reference

Native startup reads `.env` via `sh scripts/start.sh` / `npm start`; exported process environment takes precedence. `npm run dev` does not load `.env` automatically. Use your own environment loader or `node --env-file-if-exists=.env --import tsx src/server.ts`.

Docker Compose reads interpolation values from the specified private `--env-file .local/compose.env` and forwards only variables declared in the selected Compose files. Host paths such as `CF_TURN_KEY_PATH` are not app variables; overlays map them to container paths. For an unlisted runtime variable, add a private override with an `environment:` entry. Do not bake credentials into the image.

Native paths are resolved from the repository working directory; startup/build helpers change there. Container paths differ from host paths. Flags use `0` / `1`, not `true` / `false`. Changes require restarting/recreating the process; editing a private env file alone does not change a running container.

## Core and Device

| App variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` native; `0.0.0.0` image/base Compose | HTTP bind address. Sample compose.env chooses loopback. Bind reachability and Host authorization are separate. |
| `PORT` | `8780` | HTTP listener; Compose exposes this as `CONSOLE_HTTP_PORT`. TLS terminates at a proxy/tunnel. |
| `ANDROID_SERIAL` | Auto-select | USB or already authorized wireless ADB identifier. Multiple authorized devices require explicit choice; explicit selection permits startup while disconnected. No model default. |
| `ADB_PATH` | `adb` on PATH | Native ADB executable; image sets `/usr/bin/adb`. All clients use the local server on TCP 5037. |
| `PYTHON_PATH` | Absolute `.venv/bin/python` | UI bridge interpreter or command on PATH; image sets `/opt/venv/bin/python`. |
| `CONSOLE_AWAKE_STATE` | `.local/awake-state.json` | Private original-power-setting recovery record. Restore/review before switching devices; separate state per device. |
| `KEEP_SCREEN_ON` | Off | Legacy scrcpy power-on/stay-awake flag. Normally leave unset: page lifecycle already requests/restores stay-awake. Does not bypass locks/vendor policy. |

Five-minute inactivity, 45-second lost-heartbeat timeout, single-control-page policy and 60-second JS-task limit are current fixed application policies. The device must accept underlying settings; failures are shown explicitly.

## Authentication and Proxy

| App variable | Default | Meaning |
| --- | --- | --- |
| `CONSOLE_PASSWORD_FILE` | None | Private readable file (`0600`), password length 12-512. One trailing line ending stripped. Prefer to an env password. |
| `CONSOLE_PASSWORD` | None | Alternative fixed password. Set exactly one source. Env values may be visible to host/container administrators. |
| `AUTH_DATA_DIR` | `.local/auth` | Persistent private auth/session directory; image uses `/app/.local/auth`. Audit directory is adjacent `../audit`. |
| `AUTH_REMEMBER_DAYS` | `90` | Persistent-login days, integer 1-180. Unchecked Remember lasts 8 hours. |
| `CONSOLE_PUBLIC_ORIGIN` | Unset/local Host policy | Exact HTTPS origin, including external port, without path/trailing slash: `https://phone.example.com` or `https://console.example.com:9443`. Enables Secure cookie/HTTPS checks. |
| `CONSOLE_BASE_PATH` | `/` | Slash-delimited prefix ending with `/`, e.g. `/phone/`. Proxy must preserve it. |
| `CONSOLE_COOKIE_PATH` | Base path | Must match base for HTTPS. Samples set `/` explicitly; change both for a subpath. |
| `TRUST_PROXY` | None | Comma-separated explicit socket-source proxy/connector IPs or restricted CIDRs. No hostnames/all-internet trust. Determines trusted scheme/IP forwarding. |

Only one fixed-password account is implemented. Session/IP auditing is not per-person identity or role authorization. Password changes invalidate stored sessions on restart. Proxy/tunnel SSO is optional and additional.

## Video, STUN and Relay Selection

| App variable | Runtime default | Meaning |
| --- | --- | --- |
| `WEBRTC_ENABLED` | `1` | `0` disables all WebRTC/ICE/STUN/TURN work. WSS must then be enabled. Samples set `0`. |
| `VIDEO_WSS_FALLBACK` | `0` | `1` enables same-origin WebSocket H.264. Despite the legacy name, it can be the only transport. Samples set `1`. |
| `WSS_ADAPTIVE_ENCODER` | `0` native if unset; `1` Compose | FFmpeg adaptation; on failure falls back to original H.264. `0` reduces host CPU by sending the phone stream directly. |
| `FFMPEG_PATH` | `ffmpeg` on PATH | Native executable. Image includes FFmpeg; custom container path needs a private override and executable. |
| `VIDEO_MAX_SIZE` | `1920` | Maximum capture dimension, integer 256-4096 or `0` for uncapped. Actual device codec/display capability limits apply. |
| `VIDEO_MAX_FPS` | `30` | Source capture upper FPS, integer 1-60; actual rate depends on screen/device. |
| `VIDEO_BIT_RATE` | `4000000` | Source H.264 target bits/s, integer 128000-20000000; not a guaranteed traffic cap. |
| `WEBRTC_STUN_URL` | `stun:stun.cloudflare.com:3478` | One `stun:hostname:UDP-port` or empty to disable external discovery. Samples disable it. Multiple servers/TLS STUN/IPv6 literal configuration not implemented here. |
| `WEBRTC_PORT_MIN/MAX` | `50000` / `50031` | Local server UDP range, 2-256 ports within 1024-65535. Used only with WebRTC, including relay mode. Different from coturn relay range. |
| `WEBRTC_PUBLIC_IP` | Unset | Optional public IPv4 injected for a real one-to-one direct-media NAT mapping. Not a TURN/proxy hostname or exit IP. Ignored in relay-only answers. |
| `WEBRTC_ICE_GATHER_MS` | `8000` | Server ICE-gather setting, integer 3000-20000 ms. Browser Cloudflare candidate wait is separately 45 seconds. |
| `WEBRTC_TURN_PROVIDER` | `none` | `none` direct RTC, `coturn` self-hosted relay, `cloudflare` Cloudflare relay. WSS-only needs no key. |
| `WEBRTC_ICE_MODE` | `all` for none; `relay` for TURN | `all` allows direct/STUN and configured relay; `relay` requires TURN. Two-provider fallback requires coturn relay-mode primary. |
| `WEBRTC_TURN_FALLBACK` | Unset | `cloudflare` adds a second relay to coturn relay-mode primary. Independently removable; browser probes are parallel. |
| `WEBRTC_TURN_TTL_SECONDS` | `14400` | Credential TTL, integer 600-172800. Suggested dedicated setup: 600. Coturn Compose defaults to 600 only if your env has no existing TTL. |

With `WEBRTC_ENABLED=0`, unused RTC settings/keys/fallback are ignored. Disabled providers are rejected before credentials/device negotiation. Explicit empty STUN stays empty through Compose. At least one video transport must be enabled.

Adaptive WSS selects 4/8/12 FPS and 600 kbps/1.2 Mbps/1.8 Mbps upper profiles, preserves resolution and uses baseline H.264. Source settings affect all transports; WSS adaptation is separate and can increase CPU. Overhead/relay legs/retries/probes add traffic. Audio is off. Frame age/RTT are not guaranteed capture-to-display latency.

## TURN Credentials

| App variable | Meaning |
| --- | --- |
| `COTURN_KEY_FILE` | Private JSON `{"secret":"64_HEX_CHARACTERS"}`. Same 32-byte hex secret in private coturn `static-auth-secret`; not a browser static user/password. Only required for enabled coturn. |
| `COTURN_URL` | Browser-facing `turns:hostname:port?transport=tcp`. Certificate/listener/name must match. TLS/TCP required. |
| `COTURN_SERVER_URL` | Optional server-facing URL, defaults to browser URL. May be internal; TLS server-name validation still uses browser hostname. |
| `CF_TURN_KEY_FILE` | Private JSON `{"keyId":"...","apiToken":"..."}` with dedicated TURN key/token. Only required for enabled Cloudflare primary/fallback. |

Key files must be regular, <=4096 bytes, private (`0600` on POSIX), valid and runtime-readable. A Cloudflare TURN key token is not a general account API token. Browser/sender short-lived credentials are separate. Self-hosted credentials expire by TTL; active allocations close on cleanup. Both integrations currently use TLS/TCP, not every possible TURN auth/transport.

## Compose/Setup Host Variables

These configure scripts/Compose rather than the app:

| Variable | Meaning |
| --- | --- |
| `ANDROID_CONSOLE_IMAGE` | Image built by `scripts/build-image.sh`; no registry publication is assumed. |
| `CONSOLE_UID/GID` | Required runtime UID/GID. Preparation fills current user's IDs for a new compose.env; no assumed 1000. |
| `ANDROID_USB_GID` | Required actual USB access group ID; no 46/plugdev default. |
| `CONSOLE_HTTP_HOST/PORT` | App HOST/PORT. Sample chooses loopback; base Compose without sample defaults to `0.0.0.0:8780`. |
| `CONSOLE_PASSWORD_PATH` | Host password file, mounted read-only at `/run/secrets/console-password`. |
| `CONSOLE_STATE_PATH` | Host private state, mounted at `/app/.local`. |
| `CONSOLE_HOME_PATH` | Host private container home/ADB keys, mounted at `/home/node`. |
| `COTURN_KEY_PATH` | Host JSON path for coturn overlay only. |
| `CF_TURN_KEY_PATH` | Host JSON path for Cloudflare overlay/fallback only. |
| `SETUP_PYTHON` | Interpreter for a new native venv, defaults to python3. Existing venv must be 3.11+. |
| `ADB_KEY_SOURCE_DIR` | Optional ADB-key source for preparation, default invoking user's `.android`. Existing target keys retained. |
| `ANDROID_USB_GROUP` | Group name for optional Linux udev helper. Legacy default plugdev is validated; explicitly supply your actual group. |
| `ANDROID_USB_VENDOR_ID` | Four hex digits for udev helper if not passed as argument. |

`compose.wss.yaml` forces WSS-only, no TURN key mounts. Coturn/Cloudflare overlays enable and mount their own key. Fallback overlay adds Cloudflare to coturn and respects WSS flag. See [Setup transport recipes](SETUP.md#5-select-video-transports).
