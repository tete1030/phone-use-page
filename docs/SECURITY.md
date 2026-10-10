# Security and Publication Boundaries

The public tree contains application code, generic Compose configuration, sanitized examples, synthetic tests and upstream license/attribution material.

## Keep Private

- `.local/` and `.env*` except `.env.example`.
- Passwords, Cloudflare TURN tokens, coturn shared secrets, authentication/session stores and device ADB keys.
- Actual device serials, personal hosts/IPs, certificate material, reverse-proxy/router configuration and deployment history.
- Screenshots/video, packet captures, browser HAR files, audit logs and script execution output.
- `deploy/`: local site automation is deliberately ignored and is not required to build the application.

Examples contain reserved documentation domains/addresses and obvious placeholders. Credentials must be provided as private files or environment values; no default password is included.

## Before Publication

Run `npm run check:publication` after staging. It examines the staged Git blobs, rejects private paths, known credential formats, credential-bearing URLs and personal deployment markers, and verifies the official vendored binary checksum. It does not print matched credentials. The same check can run in CI.

This is a guardrail, not a proof that any future arbitrary data is safe to publish. Review newly added captures and fixtures; do not bypass the check for production credentials. If a real secret is ever published, rotate it; deleting the current file does not remove old Git history.

## Runtime Controls

Passwords are verified with scrypt; authentication, Origin/CSRF checks and independent page-control tokens protect device operations. Only one control page can be active. Script execution uses a restricted QuickJS child process rather than browser/Node evaluation. Password fields are not mirrored; unique-target matching and native text readback avoid ambiguous writes.

Raw events only confirm sending unless a defined effect has been verified. Some Android apps do not expose accessible/writable nodes; the console must not infer success from a generic event acknowledgment.

The HTTP process should be behind HTTPS for remote use. Keep ADB private, limit trusted proxies, protect private mounts and maintain TURN authentication/TLS and relay access rules for your own network.

Do not include credentials, device data or private logs in public GitHub issues. Use a private channel for a vulnerability report involving nonpublic information.
