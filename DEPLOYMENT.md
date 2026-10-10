# Deployment

Use the [complete Setup manual](docs/SETUP.md) for device authorization, native/Linux Docker startup, HTTPS proxying, optional Cloudflare Tunnel, self-hosted coturn, Cloudflare TURN, validation, upgrades and rollback.

## Choose What You Need

- **Local or WSS-only**: no TURN account, relay key, domain, public IP or inbound media ports required. Start with the env examples, or Docker `compose.yaml` + `compose.wss.yaml`.
- **Your own TURN**: any reachable coturn host and DNS/TLS provider; use `compose.coturn.yaml` plus your private secret/URL. A separate Linux TURN recipe is in `examples/coturn/`.
- **Cloudflare TURN**: independently optional; use `compose.turn.yaml` and your dedicated server-side key. Console DNS/proxy can remain with another provider.
- **Both TURN services**: coturn primary plus `compose.fallback.yaml`; WSS can be enabled or disabled independently.
- **HTTP tunnel**: any suitable HTTPS/WebSocket tunnel; Cloudflare Tunnel has an optional recipe. It handles page/WSS traffic, not the separate TURN media path.

For variable behavior and supported combinations, see [CONFIGURATION.md](docs/CONFIGURATION.md). For OS, Android, browser, IPv4/IPv6 and infrastructure boundaries, see [PORTABILITY.md](docs/PORTABILITY.md).

## Existing Deployments

The env examples now default to WSS only and loopback HTTP. Existing explicit settings are not rewritten; `WEBRTC_ENABLED` defaults to `1` when omitted for compatibility. Set your own video flags and bind address explicitly.

Compose requires `CONSOLE_UID`, `CONSOLE_GID` and actual `ANDROID_USB_GID` instead of guessing 1000/46. `ANDROID_SERIAL` can be empty for one authorized device; set it explicitly for multiple devices or startup while disconnected. Back up private env/state before changes; do not run the preparation helper with sudo or share power/session state between devices.

Keep private env, credentials, ADB keys, certificates, state, router/proxy configs, captures and deployment history out of Git. Upgrade/rollback by retaining the old image and recreating only the console with the correct overlays/mounts. Validate authenticated video/controls, not just health.
