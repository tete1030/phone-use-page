# Deployment

This guide uses example hosts and addresses. Replace them with your own settings in ignored private files; do not edit a public example to contain production credentials.

## Linux USB Container

1. Install Docker/Compose and authorize ADB on the device. Set `ANDROID_SERIAL` from `adb devices`.
2. Create `.local/console-password` with a 12-512 character password and mode `0600`.
3. Prepare private state and ADB keys:

```sh
export CONSOLE_UID=$(id -u)
export CONSOLE_GID=$(id -g)
sh scripts/prepare-docker.sh
```

Edit `.local/compose.env`: set the device serial, UID/GID and USB group GID (`getent group plugdev`). `CONSOLE_PASSWORD_PATH`, `CONSOLE_STATE_PATH` and `CONSOLE_HOME_PATH` point to ignored local files/directories. Native ADB keys are copied into private container home only if they are not already present.

```sh
sh scripts/build-image.sh
```

Set `ANDROID_CONSOLE_IMAGE` in `.local/compose.env` to the image printed by the build, then start:

```sh
docker compose --env-file .local/compose.env -f compose.yaml up -d --no-build console
```

The container uses host networking on Linux, listens on `0.0.0.0:8780`, runs as your configured UID, drops capabilities, mounts secrets read-only and keeps the root filesystem read-only. HTTP is not a replacement for HTTPS on a remote connection. ADB stays on the host loopback interface; do not publish port 5037.

For USB permissions, the generic helper takes your device serial and USB vendor ID:

```sh
sh scripts/install-usb-rule.sh DEVICE_SERIAL USB_VENDOR_ID
```

This changes Linux udev rules using sudo. Native macOS development uses host ADB instead; this Linux USB configuration is not directly portable to Docker Desktop.

## HTTPS Reverse Proxy and Base Path

Use a TLS reverse proxy with WebSocket upgrades and configure the exact public origin:

```dotenv
CONSOLE_PUBLIC_ORIGIN=https://phone.example.com
CONSOLE_BASE_PATH=/
CONSOLE_COOKIE_PATH=/
# Trust only the actual reverse proxy address/network:
TRUST_PROXY=192.0.2.10/32
```

A subpath can use `CONSOLE_PUBLIC_ORIGIN=https://example.com`, `CONSOLE_BASE_PATH=/phone/`, and a matching cookie path. Preserve the path when proxying. Cookie Secure mode is enabled for the HTTPS public origin; sessions are HttpOnly and SameSite=Strict.

Forward client addresses only through a trusted proxy. Do not configure trust for arbitrary internet clients. A Cloudflare HTTP Tunnel can carry HTTP/WSS signaling and WSS video, but it does not automatically relay WebRTC media.

## Video Options

The default setup uses STUN/WebRTC. Publish the configured UDP range if direct media is needed; port mapping/NAT must match the advertised address. Do not assume a successful LAN test proves internet reachability.

For WSS over the same HTTPS path, set these in private compose.env:

```dotenv
VIDEO_WSS_FALLBACK=1
WSS_ADAPTIVE_ENCODER=1
```

WSS uses WebCodecs H.264. Adaptive encoding preserves resolution and selects 4/8/12fps with 600kbps/1.2Mbps/1.8Mbps maxima. Actual bandwidth includes protocol overhead; FFmpeg consumes host CPU.

### Your Own TURN

Prepare a private `0600` JSON file matching this shape; the strings below are placeholders, not usable credentials:

```json
{"secret":"YOUR_64_CHARACTER_HEXADECIMAL_SHARED_SECRET"}
```

Generate 32 random bytes encoded as 64 hexadecimal characters for `secret`, and configure the same value as coturn's static auth secret. The browser TURN hostname determines TLS certificate validation.

Configure the browser-facing URL and optionally a backend-specific URL with the correct TLS server name:

```dotenv
COTURN_URL=turns:turn.example.com:5349?transport=tcp
COTURN_SERVER_URL=turns:turn.example.com:5349?transport=tcp
COTURN_KEY_PATH=./.local/coturn-key.json
WEBRTC_TURN_TTL_SECONDS=600
```

```sh
docker compose --env-file .local/compose.env -f compose.yaml -f compose.coturn.yaml up -d --no-build console
```

A sanitized server configuration starting point is in `examples/coturn/turnserver.conf.example`. Configure its certificate, realm, shared secret, listening/relay IPs, public NAT address and relay ports for your network. Do not expose an unauthenticated relay or blindly copy firewall rules from another deployment.

### Cloudflare TURN

Create a dedicated key in your own Cloudflare Realtime account. Store a `0600` private JSON file:

```json
{"keyId":"YOUR_TURN_KEY_ID","apiToken":"YOUR_TURN_KEY_TOKEN"}
```

For Cloudflare only, add `compose.turn.yaml`. For parallel self-hosted TURN + Cloudflare TURN + WSS, use all three files:

```sh
docker compose --env-file .local/compose.env -f compose.yaml -f compose.coturn.yaml -f compose.fallback.yaml up -d --no-build console
```

Auto mode starts all configured paths and upgrades according to self-hosted TURN > Cloudflare TURN > WSS when real video becomes available. It closes lower-priority paths after promotion. Manual mode connects only the chosen path. Parallel probes and retries can consume relay traffic and create short-lived credentials; configure billing alerts in your own account. Alerts are not a hard spending cap.

## Persistent Private State

The whole state directory must remain private and persistent: authentication/session data, tasks, request audit logs and `awake-state.json` for power-setting recovery. Container ADB private keys live under its private home `.android/`.

An active page keeps a plugged-in device awake. After 300 seconds without explicit interaction, the service closes control/media, stops observation and restores original power settings. Heartbeats and automatic refresh do not count as activity. Network heartbeat loss has a separate 45-second timeout. Inactivity disconnect does not delete login cookies; refresh or reconnect to resume.

Request audit files are `audit/requests.jsonl` and `audit/requests.previous.jsonl` in the persistent state directory, with 5MB rotation. They include IP, user agent and session metadata but not passwords, cookies, TURN credentials, text values or JS bodies. Do not publish these logs.

## Upgrade and Rollback

Back up private compose.env with its permissions and retain the previous image. Build/test first, change only the image value, and recreate only console using the same Compose overrides that your deployment already uses. Verify health, authenticated page/assets, actual video and input behavior; health alone is not media validation.

Rollback restores the previous private compose.env/image and recreates console with the same overrides. Preserve auth, ADB keys, power recovery and audit state. Never commit your rollback files or site-specific proxy/router configuration.
