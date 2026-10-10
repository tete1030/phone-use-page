# Setup Manual

This guide starts with a local phone console, then adds optional remote access and video relays. You can stop at any stage. No specific phone vendor, NAS, router, DNS provider, domain registrar or proxy manager is required. All addresses below are documentation examples. Store real configuration under ignored `.local/` or `.env`; do not commit it.

## Contents

1. [Choose a topology](#1-choose-a-topology)
2. [Connect and authorize Android](#2-connect-and-authorize-android)
3. [Run natively on Linux or macOS](#3-run-natively-on-linux-or-macos)
4. [Run with Docker on Linux](#4-run-with-docker-on-linux)
5. [Select video transports](#5-select-video-transports)
6. [Publish through any HTTPS reverse proxy](#6-publish-through-any-https-reverse-proxy)
7. [Optional Cloudflare Tunnel](#7-optional-cloudflare-tunnel)
8. [Optional self-hosted coturn](#8-optional-self-hosted-coturn)
9. [Optional Cloudflare TURN](#9-optional-cloudflare-turn)
10. [Verify and troubleshoot](#10-verify-and-troubleshoot)
11. [Operate, upgrade and recover](#11-operate-upgrade-and-recover)

Also read [the environment-variable reference](CONFIGURATION.md), [portability boundaries](PORTABILITY.md) and [security guidance](SECURITY.md).

## 1. Choose a Topology

The **console host** runs Node/Python/ADB and needs access to the phone. A **proxy/tunnel connector** carries browser HTTPS and WebSocket traffic to the console. A **TURN host**, if used, relays WebRTC media. These can be separate machines; running the console on a VPS does not grant it USB access to a phone at home.

| Goal | Suggested starting point | Public inbound ports |
| --- | --- | --- |
| Same computer | Native console, localhost, WSS only | None |
| Private remote use | HTTPS proxy or localhost SSH forwarding, WSS only | Depends on your HTTPS/SSH service |
| Public URL without inbound forwarding | An outbound HTTP tunnel, WSS only | None on the console's network |
| Lower-latency relay video | HTTPS path plus self-hosted TURN or Cloudflare TURN | Self-hosted TURN needs its listener and relay ports; Cloudflare TURN needs outbound connectivity |
| Direct WebRTC | HTTPS path plus reachable server UDP and optional STUN | Console's UDP media range when forwarding is needed |

WSS carries H.264 video over the **same** origin as the page, with inter-frame compression. WebRTC media travels on a separate path. A Cloudflare HTTP Tunnel does not forward ordinary browser TURN/UDP media. Cloudflare Tunnel and Cloudflare TURN are independent products; either can be used without the other.

Start with WSS only to verify the phone, auth and HTTPS path. Add relays only if your latency/network needs justify them. The supplied environment examples choose WSS only. Runtime defaults for deployments without these examples remain WebRTC on/WSS off for compatibility; set both flags explicitly.

## 2. Connect and Authorize Android

Install Google's [Android SDK Platform Tools](https://developer.android.com/tools/releases/platform-tools) using the method appropriate to your OS. ADB must be on PATH, or set `ADB_PATH` to its absolute executable path. On Android:

1. Enable developer options using your vendor's documented procedure (often repeated taps on Build number).
2. Enable USB debugging, connect a data-capable USB cable, unlock the phone and approve the computer's RSA fingerprint.
3. Run `adb devices -l`. The desired row must say `device`, not `unauthorized`, `offline` or `no permissions`.
4. If touch/key injection is blocked, inspect the device's debugging security/enterprise policies. Some vendors have an extra setting. SIM cards, Xiaomi accounts, bootloader unlock and root are not requirements of this project.

Android 5+ is scrcpy's baseline, but features also depend on UI Automator, the app and vendor policies. UHID keyboards are attempted and verified, then fall back to keycodes if unsupported. Protected/custom-rendered apps may have video or UI-tree restrictions. Wake/unlock does not bypass a PIN/password. See [PORTABILITY.md](PORTABILITY.md) for the full boundary.

`ANDROID_SERIAL` accepts the identifier printed by ADB, including an authorized wireless identifier such as `device.example.test:5555`. For wireless debugging, pair/connect with ADB using Android's documented flow **before** starting this app; keep ADB on a private network. This app uses the local ADB server on TCP 5037 and does not advertise remote ADB-server support.

Without `ANDROID_SERIAL`, one authorized device is selected automatically. Multiple authorized devices require an explicit choice. For a server that starts while its phone is unplugged, set the serial explicitly; subsequent polls can reconnect to that device. One console process controls one device.

### Linux USB Permissions

macOS native ADB normally needs no udev rule. On Linux, inspect the actual USB device ownership and your distribution's Android rules before installing anything. Do not assume the existence or numeric ID of `plugdev`.

The optional helper takes the **actual** USB serial and four-hex-digit vendor ID (discover these with `lsusb`/`udevadm`):

```sh
ANDROID_USB_GROUP="$(id -gn)" sh scripts/install-usb-rule.sh DEVICE_SERIAL USB_VENDOR_ID
```

It uses sudo to install a narrowly scoped rule, backs up an existing rule, reloads udev, and grants that group access to that device. Reconnect and verify ADB. The group GID used later by the container must match this rule, or an existing rule you choose to use. A USB bus/device number is not a group GID. If group membership changes, a new login may be needed.

## 3. Run Natively on Linux or macOS

Requirements: Git, Node.js 22.12+, Python 3.11+ with venv/pip, ADB and a current Chromium browser. FFmpeg is optional for WSS adaptation. Install using your OS/package manager; `uv` is optional. The helper uses `uv` if present and Python venv/pip otherwise. Override `SETUP_PYTHON` if your desired Python is not `python3`.

```sh
git clone https://github.com/tete1030/phone-use-page.git
cd phone-use-page
sh scripts/setup.sh
cp .env.example .env
mkdir -p .local
chmod 700 .local
chmod 600 .env
```

Create a private password file without putting the password in shell history. This example refuses to overwrite an existing file:

```sh
python3 - <<'PY'
import getpass, os
password = getpass.getpass('Console password (12-512 characters): ')
if not 12 <= len(password) <= 512:
    raise SystemExit('Invalid password length')
fd = os.open('.local/console-password', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    output.write(password + '\n')
PY
```

Edit private `.env`. For a minimal local setup:

```dotenv
HOST=127.0.0.1
PORT=8780
CONSOLE_PASSWORD_FILE=.local/console-password
PYTHON_PATH=.venv/bin/python
WEBRTC_ENABLED=0
VIDEO_WSS_FALLBACK=1
WSS_ADAPTIVE_ENCODER=1
WEBRTC_STUN_URL=
```

Set `ANDROID_SERIAL` when needed. If FFmpeg is missing or too expensive for the host, set `WSS_ADAPTIVE_ENCODER=0`: WSS then sends the phone's original H.264 stream. Install FFmpeg and use `FFMPEG_PATH` if it is outside PATH. Audio is not captured.

```sh
sh scripts/start.sh
```

Open `http://localhost:8780/`, log in and confirm actual video/input. Localhost is a browser secure context, so WSS video works even though the local socket is `ws://`. Arbitrary remote HTTP is not: use HTTPS for remote browsers. The server intentionally restricts unconfigured Host headers to loopback.

Native Windows setup scripts are not provided. A Linux host/VM with confirmed USB passthrough is an alternative; verify the device appears there. Docker Desktop on Windows/macOS does not inherit Linux USB/host-network behavior.

## 4. Run with Docker on Linux

The supplied Compose recipe requires Linux Docker Engine and the Compose plugin, USB visibility under `/dev/bus/usb`, and Python 3 for the build/preparation helpers. It works independently of any NAS/container-management product. Native Node/Python dependencies are built inside the image. Do not use `privileged: true` as a shortcut.

1. Clone the repository, authorize ADB on this host and create `.local/console-password` as above.
2. Prepare state/keys as your intended runtime user, without sudo:

   ```sh
   sh scripts/prepare-docker.sh
   ```

   It fills `CONSOLE_UID`/`CONSOLE_GID` from your current user, creates private writable directories, and copies existing host ADB keys only when absent. It does not replace an existing `.local/compose.env`.

3. Edit `.local/compose.env`. Set `ANDROID_USB_GID` to the actual USB access group ID. If you installed the helper rule using your primary group above, that is the result of `id -g`. Otherwise inspect the existing USB rule/ownership. Review the generated UID/GID; all secret/state mounts must be readable/writable by that runtime user. Set your serial if needed.
4. Build an image and save its printed tag as `ANDROID_CONSOLE_IMAGE` in private `.local/compose.env`:

   ```sh
   sh scripts/build-image.sh
   ```

   The builder runs type/unit/Python checks and verifies the vendored server. No published/prebuilt image is assumed. Other CPU architectures need their own build verification.

5. Start **only WSS**, with no relay keys:

   ```sh
   docker compose --env-file .local/compose.env -f compose.yaml -f compose.wss.yaml config --quiet
   docker compose --env-file .local/compose.env -f compose.yaml -f compose.wss.yaml up -d --no-build console
   docker compose --env-file .local/compose.env -f compose.yaml -f compose.wss.yaml ps
   ```

The configuration contains the HTTP bind address, user/group, device access and state mounts. Default example HTTP binding is `127.0.0.1`, suitable for a proxy/connector on the **same host**. For a connector on another machine/container network, deliberately set `CONSOLE_HTTP_HOST=0.0.0.0` or an appropriate host address and restrict inbound access to that connector. Linux `network_mode: host` does not use a Compose `ports:` section. Media ranges also use host ports directly.

A NAS GUI, systemd or another container manager can translate these same image/env/user/USB/mount/network settings. That is an alternative deployment wrapper, not an app requirement.

## 5. Select Video Transports

Use native `.env` for native startup or private `.local/compose.env` plus the listed Compose files for containers. A `.env` file containing app values does not configure container environment variables unless the Compose file forwards them; use the container recipe consistently.

| Enabled video paths | Native settings | Compose files (always start with `compose.yaml`) |
| --- | --- | --- |
| WSS only, both TURN services off | `WEBRTC_ENABLED=0`, `VIDEO_WSS_FALLBACK=1` | `compose.wss.yaml`; no TURN overlay |
| Direct WebRTC only | `WEBRTC_ENABLED=1`, `WEBRTC_TURN_PROVIDER=none`, `VIDEO_WSS_FALLBACK=0` | Base only; set flags in compose.env |
| Direct WebRTC + WSS | Same, but `VIDEO_WSS_FALLBACK=1` | Base only; set flags in compose.env |
| Self-hosted TURN only / + WSS | `WEBRTC_ENABLED=1`, provider `coturn`, `COTURN_KEY_FILE`, `COTURN_URL`; WSS `0` / `1` | `compose.coturn.yaml`; set WSS flag |
| Cloudflare TURN only / + WSS | `WEBRTC_ENABLED=1`, provider `cloudflare`, `CF_TURN_KEY_FILE`; WSS `0` / `1` | `compose.turn.yaml`; set WSS flag |
| Both TURN services, without / with WSS | Provider `coturn`, `WEBRTC_TURN_FALLBACK=cloudflare`, both key files; WSS `0` / `1` | `compose.coturn.yaml`, `compose.fallback.yaml`; set WSS flag |

TURN defaults to relay-only ICE. For direct WebRTC, set `WEBRTC_STUN_URL` to a reachable STUN service, or leave it empty for host candidates only (for example, a reachable LAN). STUN is discovery, not relaying. Inconsistent setups such as disabling both WebRTC and WSS fail startup.

When WebRTC is disabled, its unused settings/key files are ignored and no ICE peers, STUN discovery or TURN credential requests are created. To disable a particular TURN provider, remove its Compose overlay and remove the provider/fallback setting. Do not stack `compose.wss.yaml` with TURN overlays; it is the exclusive WSS recipe. Removing an overlay also removes that secret mount.

Auto mode starts enabled paths concurrently, displays the first real frame, promotes a higher-priority path when ready and closes lower-priority paths. Priority is self-hosted TURN > Cloudflare TURN > WSS, or direct WebRTC > WSS in the direct configuration. Manual radio selection uses only the selected enabled path; a saved selection no longer available falls back to Auto.

### Direct WebRTC and NAT

Use `WEBRTC_PORT_MIN/MAX` (default UDP 50000-50031), allow the range on the console host, and forward that same range/ports through each relevant NAT only if needed. Set `WEBRTC_PUBLIC_IP` to a real public IPv4 only when the one-to-one mapping is valid; an arbitrary discovered IP, proxy exit IP or hostname is not valid.

CGNAT, symmetric NAT, endpoint firewall/browser restrictions, double NAT and missing NAT hairpin can prevent this path. IPv6 media is not implemented by the current server. If the ISP blocks inbound 80/443, use another allowed service port or an outbound HTTP tunnel; neither 80 nor 443 is a required inbound home port. TURN/WSS remain alternatives.

## 6. Publish Through Any HTTPS Reverse Proxy

Obtain a domain/hostname and trusted TLS certificate using your chosen DNS provider, CA and renewal method. Choose a public URL, for example `https://phone.example.com` or `https://console.example.com:9443/phone/`. No proxy-manager product is required.

For the first URL, set:

```dotenv
CONSOLE_PUBLIC_ORIGIN=https://phone.example.com
CONSOLE_BASE_PATH=/
CONSOLE_COOKIE_PATH=/
TRUST_PROXY=127.0.0.1/32
```

Use the proxy's **actual socket source address** as seen by the app, not the browser's IP or an entire public provider IP list. If your local connector uses IPv6 loopback, trust `::1/128` too, only if that is your actual topology. For a remote/container proxy choose its explicit address/restricted subnet. Restrict direct console access, because a client able to originate from a trusted proxy address can supply forwarded headers.

The proxy must:

- Preserve the public `Host` (including external port when used), original HTTPS scheme, and the configured request path.
- Set `X-Forwarded-Proto: https` and an accurate forwarded client-IP chain; trust only known upstream hops.
- Upgrade WebSockets and allow long-lived `/ws/events`, `/ws/control` and `/ws/video` connections. Do not buffer video or impose a short read timeout.
- Proxy to the console HTTP address reachable **from the proxy**. Its `localhost` is not another host/container's localhost.

A generic Nginx TLS-server location (certificate/listen directives belong to your existing TLS setup):

```nginx
location / {
    proxy_pass http://127.0.0.1:8780;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

For `https://console.example.com:9443/phone/`, use `CONSOLE_PUBLIC_ORIGIN=https://console.example.com:9443`, base and cookie paths `/phone/`, and a `location /phone/` with `proxy_pass http://127.0.0.1:8780` **without a trailing slash/path rewrite**. The app itself handles `/phone/`. External origin includes the port but no path; cookie/base path includes the path but no origin. Secure cookies require the app to recognize the original HTTPS scheme through the trusted proxy.

For private occasional access, `ssh -L 8780:127.0.0.1:8780 user@console-host` and local `http://localhost:8780` is another option for a locally configured console; do not simultaneously advertise an unrelated public origin and expect both origin policies to match.

## 7. Optional Cloudflare Tunnel

Use this section only if you choose Cloudflare for the **HTTP/WSS path**. It does not configure TURN or require an inbound router forwarding rule. For a normal published hostname, Cloudflare requires a site/zone eligible for Tunnel publication, generally an active Cloudflare-managed DNS zone. That is a requirement of this optional service, not of Phone Use Page. Do not assume your current registrar/DNS is already Cloudflare; follow [Cloudflare's prerequisites](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/), including any supported partial-zone options for your plan.

### Dashboard-Managed Tunnel

1. In your account's Zero Trust/Tunnel area, create a `cloudflared` tunnel. UI names may change; use the current official creation guide.
2. Install `cloudflared` on a host that can reach the console. Follow the dashboard's connector instructions; keep the generated connector token private. A container or OS service is optional. Prefer private token files/service configuration to a token in shell history; do not publish commands containing the real token.
3. Add a published application/hostname such as `phone.example.com` with service **HTTP** `127.0.0.1:8780` when connector and console share the host. With different hosts, use the reachable internal address. A bridge-networked `cloudflared` container cannot reach the host console at its own loopback; use appropriate Linux host networking or an explicit reachable host address.
4. Set the application's exact `CONSOLE_PUBLIC_ORIGIN=https://phone.example.com`, correct base/cookie paths, and `TRUST_PROXY` for the connector/proxy's actual source address. Keep the public Host unchanged, or set the tunnel's HTTP Host Header to the exact console hostname. Ensure forwarded HTTPS is preserved. Restart the console with the same chosen video recipe.
5. Wait for Tunnel Healthy and DNS/certificate readiness; verify login, assets and all three WebSocket paths. App authentication still applies. Cloudflare Access can add a second identity layer, but your agent must be able to complete that login; do not assume an interactive Access flow is usable by every agent.

A root subdomain is simplest. For a subpath, preserve `/phone/` through ingress and set the app's base/cookie path to `/phone/`; Tunnel ingress path matching does not strip the path automatically.

### Locally Managed Tunnel (Alternative)

Use this only if you prefer local credentials/config rather than dashboard-managed tokens. Authenticate/create and route your own tunnel according to the [official local-management guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/):

```sh
cloudflared tunnel login
cloudflared tunnel create phone-use-page
cloudflared tunnel route dns TUNNEL_UUID phone.example.com
```

The login certificate and tunnel credential JSON are private. Put configuration/credential files outside tracked paths (for example `.local/cloudflared/`), restrict permissions and use absolute paths:

```yaml
tunnel: YOUR_TUNNEL_UUID
credentials-file: /absolute/private/path/tunnel-credentials.json
ingress:
  - hostname: phone.example.com
    service: http://127.0.0.1:8780
  - service: http_status:404
```

Validate then run (replace the path with your real file):

```sh
cloudflared tunnel --config /absolute/private/path/config.yml ingress validate
cloudflared tunnel --config /absolute/private/path/config.yml run
```

The final catch-all is required. Adapt service address, Host and trusted proxy settings exactly as in the dashboard-managed recipe. Install a persistent service using your OS's service manager if desired. Do not assume Tunnel policies permit unlimited video traffic; review your provider's current service terms and limits.

## 8. Optional Self-Hosted coturn

The console integration currently uses **TURN over TLS/TCP** and coturn's REST-style HMAC shared-secret authentication. Plain `turn:` URLs/static username-password lists are not supported by this integration. TLS-over-TCP is the browser-to-relay transport; the allocation relays UDP between peers, so a UDP relay range is still needed.

### Choose and Reach the TURN Host

Choose a VPS/public server, or a reachable host behind your own NAT. It need not be the console host. Obtain a hostname such as `turn.example.com`, point an ordinary A record to its actual public IPv4, and obtain a trusted certificate for that name. Use any DNS/CA tooling you prefer. If the DNS provider offers an HTTP/CDN proxy, use **DNS-only** for ordinary TURN: an HTTP proxy/tunnel does not carry TURN TLS. Avoid publishing AAAA unless your TURN listener/firewall/relay setup really supports it.

This example listener uses TCP 5349 and UDP relay 52000-52063. You can choose another allowed TLS port, such as 8443; ensure the URL, listener, mapping and firewall agree. No inbound 443/80 requirement is assumed. Check host firewall, cloud security groups, upstream router/NAT and ISP/CGNAT. A HTTPS GET that reaches this port proves neither TURN allocation nor media success: TURN is not HTTP.

If inbound 80/443 is unavailable, a CA's DNS-01 challenge can validate the TURN hostname through your DNS provider instead of a web listener. Use a renewal method supported by your DNS/CA tools, including protected DNS API credentials where needed. A Cloudflare edge certificate for a Tunnel page does not provide coturn's local certificate/private key; obtain and maintain those separately.

### Generate Private REST Secret and Configuration

```sh
mkdir -p .local/coturn
chmod 700 .local/coturn
cp examples/coturn/turnserver.conf.example .local/coturn/turnserver.conf
chmod 600 .local/coturn/turnserver.conf
python3 - <<'PY'
import json, os, secrets
path = '.local/coturn-key.json'
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    json.dump({'secret': secrets.token_hex(32)}, output)
PY
```

The JSON secret must be 64 hexadecimal characters. Transfer the same secret securely into coturn's private `static-auth-secret`; never put it in the public example. Edit private `turnserver.conf`:

- `listening-ip` and `relay-ip`: actual local interface address on the TURN host; the documentation address is not bindable there.
- `realm`/`server-name`: your TURN hostname. `tls-listening-port`: your chosen TCP listener port.
- `cert`/`pkey`: full trusted certificate chain and private key, readable by the TURN runtime. Renew them and reload/restart coturn as your certificate tooling requires.
- `min-port`/`max-port`: UDP relay range allowed/forwarded by your actual network.
- Behind NAT, add `external-ip=PUBLIC_IPV4/LOCAL_RELAY_IPV4` and a matching one-to-one UDP port mapping. On a public-interface VPS, use the actual interface topology instead. Dynamic public-IP changes require DNS **and** coturn external-address updates.
- Keep `use-auth-secret`, authentication, private-address peer restrictions, quotas and traffic limits. Review loopback/multicast/IPv6 protections supported by your coturn version. The small example quotas are starting limits, not capacity recommendations. Do not remove private peer restrictions just to make a LAN test pass; prefer public relay candidates or a narrowly approved peer address for an isolated test.

Install coturn natively with your chosen OS package/service manager, or use the independent Linux Docker example. For Docker, choose a reviewed pinned image tag/digest and write an ignored env file (e.g. `.local/coturn.env`):

```dotenv
COTURN_IMAGE=coturn/coturn:4.6.3
TURN_UID=
TURN_GID=
TURN_CONFIG_PATH=/absolute/private/path/turnserver.conf
TURN_CERTIFICATE_DIR=/absolute/private/path/certificates
```

Fill `TURN_UID`/`TURN_GID` with `id -u`/`id -g` for the user owning the private config/certificates on the **TURN host**; these can differ from the console host. The official example image defaults to `nobody`, which cannot read an unrelated owner's `0600` secret, so the Compose recipe deliberately overrides its runtime user. The protected files must remain readable by the configured user, not made world-readable.

```sh
docker compose --env-file .local/coturn.env -f examples/coturn/compose.yaml config --quiet
docker compose --env-file .local/coturn.env -f examples/coturn/compose.yaml up -d
```

This independent TURN container uses Linux host networking; it has no connection to a particular NAS GUI. The config is mounted at `/etc/coturn/turnserver.conf` and certificate directory at `/certificates`. The console must separately have its own private JSON secret file; no writable secret volume is shared with the browser.

The recipe drops all capabilities except `NET_BIND_SERVICE`, because the tested official 4.6.3 binary carries that file capability and needs it in the bounding set even with a high listener port. It keeps `no-new-privileges` and a read-only root filesystem. Other images may package the executable differently; review their [upstream image instructions](https://github.com/coturn/coturn/tree/master/docker/coturn) and filesystem/user requirements. The provided example was checked in an isolated container with a temporary certificate and TLS handshake; your public routing/authenticated media path still needs separate validation.

If certificate files are symlinks, also mount their real targets or export the complete files to a private directory; mounting only a `live` directory whose links point outside the mount will fail. Include that export/reload in your renewal hook. Synchronize clocks on the console/TURN hosts for expiring REST credentials. The stateless REST example puts any local SQLite cache in `/tmp`; database-backed persistent users would need their own private persistent database recipe.

### Configure the Console

Native `.env`:

```dotenv
WEBRTC_ENABLED=1
WEBRTC_TURN_PROVIDER=coturn
WEBRTC_ICE_MODE=relay
WEBRTC_TURN_TTL_SECONDS=600
COTURN_KEY_FILE=.local/coturn-key.json
COTURN_URL=turns:turn.example.com:5349?transport=tcp
VIDEO_WSS_FALLBACK=1
```

For Docker, set `COTURN_KEY_PATH=./.local/coturn-key.json`, `COTURN_URL`, TTL and WSS flag in private compose.env, then use `compose.yaml` + `compose.coturn.yaml`. The overlay mounts the file and sets the container's `COTURN_KEY_FILE` automatically.

By default the server uses the same URL as the browser. If the console needs a different reachable internal listener, set `COTURN_SERVER_URL`, for example `turns:192.0.2.10:5349?transport=tcp`. TLS certificate validation still uses the hostname from **COTURN_URL**. This is not permission to skip certificate validation. Both peers must be able to reach the advertised relay candidates; backend LAN allocation success alone does not prove public-browser success.

## 9. Optional Cloudflare TURN

Cloudflare TURN needs a Cloudflare account with its Realtime TURN product available, a dedicated TURN key, and outbound access from both browser and console. It does **not** require using Cloudflare DNS/Tunnel for your console domain. Check current billing terms in your account before enabling it; [billing notifications](https://developers.cloudflare.com/billing/notifications/) warn but are not a monetary hard cap.

1. Open [Cloudflare Realtime](https://dash.cloudflare.com/?to=/:account/calls) in your own account, enable the required product/subscription if applicable, and create a dedicated TURN key. Use a descriptive name for this deployment.
2. Store the **TURN key ID and the token associated with that key** server-side. Do not substitute an account-wide API token or browser TURN username/password. Follow the [official TURN credential guide](https://developers.cloudflare.com/realtime/turn/generate-credentials/).
3. Create ignored `.local/cloudflare-turn-key.json` with this shape, substituting real values privately:

   ```json
   {"keyId":"YOUR_TURN_KEY_ID","apiToken":"YOUR_TURN_KEY_TOKEN"}
   ```

   Set mode `0600` and the correct runtime owner. The key ID must be 32 hex characters; the key token is validated by the app. Do not paste it into an issue/chat, commit it, log it or include it in a client bundle.

4. For native startup set:

   ```dotenv
   WEBRTC_ENABLED=1
   WEBRTC_TURN_PROVIDER=cloudflare
   WEBRTC_ICE_MODE=relay
   CF_TURN_KEY_FILE=.local/cloudflare-turn-key.json
   WEBRTC_TURN_TTL_SECONDS=600
   VIDEO_WSS_FALLBACK=1
   ```

   For Docker set `CF_TURN_KEY_PATH=./.local/cloudflare-turn-key.json`, TTL and WSS flag in private compose.env, then use `compose.yaml` + `compose.turn.yaml`. This does not mount or enable self-hosted TURN.

5. The console creates separate short-lived browser/sender credentials through Cloudflare's API, refreshes them before expiry and attempts revocation on disconnect. It filters the supplied ICE URLs to `turns:turn.cloudflare.com:443?transport=tcp`; no home inbound 443 is used. The browser receives only short-lived credentials, not the long-term key/token. The console needs outbound HTTPS to `rtc.live.cloudflare.com` and TURN TLS to `turn.cloudflare.com:443`; the browser also needs TURN TLS reachability. Ordinary HTTPS support in an agent browser does not guarantee TURN support.
6. For both relays plus WSS, keep the coturn primary, add `WEBRTC_TURN_FALLBACK=cloudflare` natively or use `compose.yaml` + `compose.coturn.yaml` + `compose.fallback.yaml` in Docker. The full priority order then applies. To stop Cloudflare use, remove its fallback/overlay and secret mount, restart the console and optionally revoke the dedicated key in Cloudflare.

Configure billing alerts/quotas independently in your account. This app does not enforce a universal dollar limit. Parallel probes, refreshes and both relay legs can consume traffic; an alert is not a guarantee of a maximum final bill.

In the account's Billing/Notifications area, create a spending/budget notification if supported by your plan, choose your own currency/threshold and recipients, save it, and verify it is enabled. A threshold such as $50 is only an example of an alert budget, not a server hard cap. Check whether the notification covers the whole account or the TURN product, and review the TURN usage dashboard after a trial session. Keep payment/subscription approval separate from configuring a local key file.

## 10. Verify and Troubleshoot

Verify in layers and from the **actual remote browser/agent network**:

1. `adb devices -l` reports the intended device; a local native session can observe/control it.
2. `/health` is healthy, but this only checks HTTP liveness. Confirm unauthenticated requests see login and cannot invoke controls.
3. HTTPS public Host/origin and trusted proxy scheme are correct; login persists as expected. Do not diagnose cookies using HTTP after setting an HTTPS public origin.
4. Page assets and event/control/video WebSockets work. In WSS-only mode there should be no TURN attempts; decoded/drawn frames should increase after waking an unlocked phone. An empty ICE candidate list is normal for WSS.
5. For each enabled WebRTC relay, select it manually, copy connection diagnostics and confirm relay candidates, a succeeded selected pair **and real rendered frames**. LAN success is not internet success; an HTTPS request to a TURN port is not a TURN test.
6. Try a harmless app/navigation action and Unicode text in a nonpassword field. Read the result's verification status: a sent raw key is not proof that the app accepted it. Refresh UI targets after changes.
7. Verify second-page takeover, five-minute idle disconnect, reconnect and restoration of the device's original stay-awake setting. Lock-screen/password restrictions are expected.

| Symptom | Checks / resolution |
| --- | --- |
| `no permissions` / container sees no device | Actual udev/USB group GID, `/dev/bus/usb` mount, cgroup permissions, data cable and VM passthrough; do not guess a vendor ID/group number. |
| `unauthorized` | Unlock phone and approve the relevant ADB key; container may use a different key if none was copied. |
| `HOST_REJECTED` | Public Host/origin mismatch, proxy rewriting Host, access through a different domain/port. |
| `HTTPS_REQUIRED` / login cookie missing | Correct original scheme, trusted connector source IP, Secure cookies, exact origin/base/cookie path and client HTTPS. |
| Page loads but WSS fails | WebSocket Upgrade/path/Origin/auth, connector reachability, proxy read timeout and Chromium WebCodecs support. Inspect copied diagnostics. |
| TURN 701 / no relay candidate | DNS/TLS/listener reachability, browser egress restrictions, cert name/chain/time, REST secret/key or expired credentials. TLS/HTTP alone is insufficient. |
| Relay exists but ICE/media fails | Actual public relay IP and UDP mapping, peer restrictions/quotas, cloud/host/router firewall, selected pair, browser codec and frames. |
| Black/frozen screen with live UI tree | Video and UI have separate freshness; inspect pause reason, screen/lock state and last-frame age, then wake or reconnect video. A maintained connection is not fresh pixels. |
| WSS adaptation unavailable or slow | FFmpeg executable/CPU/codec support; disable adaptation or lower capture limits. TCP head-of-line delays can remain on lossy networks. |
| Nodes/text absent or rejected | UI Automator/app accessibility, protected/custom UI, ambiguous/current target or focus; do not substitute a model-specific selector. |
| Phone still sleeps | Actual charging mode, power permissions/vendor policy, device thermal/power state; stay-awake is a verified request, not an OS bypass. |

Local synthetic verification:

```sh
npm run build
PYTHON_PATH=.venv/bin/python npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
npm run check:compose # optional for native-only users; requires the Docker Compose plugin
npx playwright install chromium
CHROME_PATH="$(node --input-type=module -e 'import {chromium} from "playwright"; process.stdout.write(chromium.executablePath())')" npm run test:ui
```

`check:compose` uses synthetic values and only renders configurations; it does not create containers or read production secrets. Browser/unit tests do not certify every Android vendor, architecture, NAT or tunnel. Opt-in live scripts control devices and include scenario-specific assertions; review/adapt them before use. Do not run live tests against a real production browser session accidentally: only one page can own the phone.

## 11. Operate, Upgrade and Recover

- Keep state, auth/session stores, ADB keys and power recovery data persistent/private and owned by the runtime user. Native state is under `.local/`; container state/home are private bind mounts. Use separate state for separate phone instances. Restore/review power settings before repointing an old instance at a different phone.
- An active page requests USB/AC stay-awake. Five minutes without explicit interaction disconnects all control/media and stops observations; heartbeat/network liveness is separate (45 seconds). Screen off/lock pauses video frames while keeping an existing connection alive; keepalives still use some bandwidth. Reconnect can resume without logging in again if its cookie remains valid.
- Requests are audited in `audit/requests.jsonl` and `requests.previous.jsonl` under the persistent state tree (5 MB rotation). They include client IP, user agent, session, endpoint/result metadata. Passwords, cookies, TURN credentials, typed text and JS bodies are excluded. A shared password identifies a session, not a named person. Proxy trust controls the accuracy of IP attribution.
- Back up private env, state, keys and previous image before upgrading. Build/test, change only the intended image/config and recreate the console with the **same chosen Compose files**. Verify actual public login/video/input. Do not drop an overlay unintentionally or use `down -v` to upgrade.
- To roll back, restore the previous image/private config and recreate with its original overlays/mounts. Preserve ADB keys, sessions and power recovery. Stop gracefully when possible. If a crash prevented restoring power settings, reconnect to the same phone and let recovery run; inspect the private saved state and Android setting before any manual correction.
- Changing the configured password requires a restart; existing sessions are cleared when the stored password hash no longer matches. To remove a stolen TURN key, revoke/rotate it at the provider and update private files; removing it from Git or the browser is not rotation.
- Expose only the intended HTTPS/proxy and TURN ports. Keep ADB, private state/config and management services inaccessible from the internet. Review new files with `npm run check:publication` after staging; documentation examples must remain examples.
