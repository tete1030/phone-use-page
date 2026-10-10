# 部署配置示例

先阅读[部署场景与配置示例](../../docs/DEPLOYMENT_SCENARIOS.md)和[主机与 ADB 配置](../../docs/HOST_SETUP.md)。

`local.env.example` 是可复制到仓库根目录 `.env` 的完整原生配置；仍需准备私有密码文件和已授权设备。

其他 `*.compose.env.example` 是**差异配置片段**，不能单独替代完整 compose.env。先运行 `scripts/prepare-docker.sh`，填好镜像、实际 UID/GID、USB 访问组和私有路径，再把所需片段中的字段合并到 `.local/compose.env`，同名字段只保留最终值。选一个网页入口，再按需选一个视频方案；不要覆盖掉自己的用户 ID、密码路径或状态目录。

| 示例 | 用途 |
| --- | --- |
| [local.env.example](local.env.example) | 本机原生运行，localhost、仅 WSS，无域名或 TURN 依赖 |
| [home-proxy.compose.env.example](home-proxy.compose.env.example) | 家宽网关 HTTPS 反代，非标准公网端口及 `/phone/` 子路径 |
| [tunnel-wss.compose.env.example](tunnel-wss.compose.env.example) | 同机 Cloudflare Tunnel，独立子域名、仅 WSS |
| [video-coturn.compose.env.example](video-coturn.compose.env.example) | 自建 TURN 加 WSS；与任意网页入口组合 |
| [video-cloudflare.compose.env.example](video-cloudflare.compose.env.example) | Cloudflare TURN 加 WSS；不需要自建 TURN |
| [video-combined.compose.env.example](video-combined.compose.env.example) | 自建 TURN、Cloudflare TURN、WSS 并行择优 |
| [video-direct.compose.env.example](video-direct.compose.env.example) | 可选 WebRTC 直连/STUN，加 WSS |
| [gateway-nginx.conf.example](gateway-nginx.conf.example) | 网关 Nginx HTTPS 反代示例，放在 `http {}` 上下文中 |
| [cloudflared.yml.example](cloudflared.yml.example) | 本地管理的 Cloudflare Tunnel，不适用于直接替换控制台管理 token |
| [home-turnserver.conf.example](home-turnserver.conf.example) | 家宽 NAT 后的 coturn，公网地址映射、TLS 5349、UDP 52000–52063 |

域名和 IP 均为文档保留值，不代表真实可达设备。`192.0.2.1`、`.20`、`.30` 分别代表网关、控制台、TURN 主机；`203.0.113.10` 代表示例公网 IPv4。复制后替换为实际地址。密码、TURN token、共享密钥和证书私钥必须留在 `.local/` 等私有路径中。

本次示例检查包括：两个网页入口与五种视频选择的 10 个组合，加原有配置共 21 项 Compose 检查；Nginx 真实语法检查；cloudflared ingress 校验；coturn 配置解析与 TLS 监听。工具验证在隔离环境中使用临时证书/虚拟值，没有登录真实账户，也没有验证你的公网 DNS、证书信任、NAT 或手机。部署后仍按场景指南验收。
