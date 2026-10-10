# scrcpy server

- Version: 3.3.3, unmodified official release binary.
- Source: https://github.com/Genymobile/scrcpy/tree/v3.3.3
- Binary: https://github.com/Genymobile/scrcpy/releases/download/v3.3.3/scrcpy-server-v3.3.3
- License: Apache License 2.0; full text in `scrcpy-LICENSE`.
- SHA-256: `7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0`.

The console verifies this hash before pushing the binary to the phone. Tango
client packages are version-pinned independently in `package-lock.json` and
use `AdbScrcpyOptions3_3_3` for this server protocol. The server is placed at
`/data/local/tmp/android-console-scrcpy.jar` and started through authorized ADB;
no root or bootloader unlock is required. Attribution: Genymobile and scrcpy
contributors. Dependency licenses remain in their installed packages.
