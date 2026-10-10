# scrcpy 服务端

- 版本：3.3.3，未经修改的官方发布二进制。
- 源码：https://github.com/Genymobile/scrcpy/tree/v3.3.3
- 二进制：https://github.com/Genymobile/scrcpy/releases/download/v3.3.3/scrcpy-server-v3.3.3
- 许可证：Apache License 2.0，完整法律原文见 `scrcpy-LICENSE`。
- SHA-256 校验和：`7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0`。

控制台在向手机推送二进制前验证该校验和。Tango 客户端包在 `package-lock.json` 中独立锁定版本，并使用 `AdbScrcpyOptions3_3_3` 与此服务端协议通信。服务端放置于 `/data/local/tmp/android-console-scrcpy.jar`，通过已授权的 ADB 启动，无需 root 或解锁 Bootloader。

署名：Genymobile 及 scrcpy 贡献者。依赖的许可证保留在已安装的软件包中。上游许可证按原文保留，本说明不替代其授权条款。
