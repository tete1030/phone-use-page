# 部署指南

[完整安装部署手册](docs/SETUP.md)涵盖设备授权、原生/Linux Docker 启动、HTTPS 代理、可选 Cloudflare Tunnel、自建 coturn、Cloudflare TURN、验证、升级和回滚。

## 按需选择

- **本机或仅 WSS**：不需要 TURN 账号、中继密钥、域名、公网 IP 或入站媒体端口。使用环境变量示例，或 Docker 的 `compose.yaml` + `compose.wss.yaml`。
- **自建 TURN**：使用可达的 coturn 主机和自行选择的 DNS/TLS 服务；配合 `compose.coturn.yaml` 及私有密钥/地址。独立 Linux TURN 示例位于 `examples/coturn/`。
- **Cloudflare TURN**：独立可选；使用 `compose.turn.yaml` 和服务端专用密钥。控制台 DNS/代理可以继续使用其他供应商。
- **两种 TURN**：以 coturn 为主，叠加 `compose.fallback.yaml`；WSS 可以独立启用或关闭。
- **HTTP 隧道**：任何满足 HTTPS/WebSocket 要求的隧道均可；手册包含可选 Cloudflare Tunnel 配置。隧道传输页面/WSS，独立的 TURN 媒体不经过该 HTTP 通道。

变量行为和支持的组合见[配置参考](docs/CONFIGURATION.md)。操作系统、安卓、浏览器、IPv4/IPv6 和基础设施限制见[通用性与支持边界](docs/PORTABILITY.md)。

## 已有部署

环境变量示例现在默认仅启用 WSS，并将 HTTP 绑定到回环地址。已有显式配置不会被自动改写；省略 `WEBRTC_ENABLED` 时，仍默认 `1` 以兼容旧部署。请明确设置视频开关和监听地址。

Compose 要求提供实际的 `CONSOLE_UID`、`CONSOLE_GID` 和 `ANDROID_USB_GID`，不再猜测 1000/46。单台已授权设备可以留空 `ANDROID_SERIAL`；多设备或希望设备未连接时启动，应显式设置。修改前备份私有配置和状态；准备脚本不要用 sudo 运行，不同设备不要共用电源恢复记录或会话状态。

私有环境变量、凭据、ADB 密钥、证书、状态、路由/代理配置、截图录像和部署历史不能进入 Git。升级/回滚时保留旧镜像，使用正确的叠加文件及挂载，仅重建控制台。验证已登录状态下的真实视频和操作，而不只看健康检查。
