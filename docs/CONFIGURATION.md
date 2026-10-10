# 配置参考

原生启动通过 `sh scripts/start.sh` 或 `npm start` 读取 `.env`，已导出的进程环境变量优先。`npm run dev` 不自动加载 `.env`；可自行加载环境，或使用 `node --env-file-if-exists=.env --import tsx src/server.ts`。

Docker Compose 从指定的私有 `--env-file .local/compose.env` 读取变量替换值，只向容器传递所选 Compose 文件明确声明的变量。`CF_TURN_KEY_PATH` 等主机路径不是应用变量，叠加文件将其映射为容器路径。未列出的运行时变量需在私有叠加配置中增加 `environment:` 项；不要把凭据写入镜像。

原生相对路径以仓库工作目录为基准，启动/构建脚本会切换至该目录。容器路径与主机路径不同。开关使用 `0` / `1`，不是 `true` / `false`。修改后需重启进程或重建容器，仅编辑私有环境文件不会改变运行中的容器。

## 核心与设备

| 应用变量 | 默认值 | 含义 |
| --- | --- | --- |
| `HOST` | 原生 `127.0.0.1`；镜像/基础 Compose 为 `0.0.0.0` | HTTP 监听地址。compose.env 示例选择回环地址。网络可达与 Host 授权是两件事。 |
| `PORT` | `8780` | HTTP 端口；Compose 使用 `CONSOLE_HTTP_PORT` 配置。TLS 在代理/隧道处终止。 |
| `ANDROID_SERIAL` | 自动选择 | USB 或已授权无线 ADB 标识。多台已授权设备需显式选择；显式设置也允许设备未连接时启动。不预设型号。 |
| `ADB_PATH` | PATH 中的 `adb` | 原生 ADB 可执行文件；镜像设为 `/usr/bin/adb`。所有客户端使用本地 TCP 5037 服务。 |
| `PYTHON_PATH` | `.venv/bin/python` 的绝对路径 | UI 桥接解释器，也可为 PATH 中的命令；镜像设为 `/opt/venv/bin/python`。 |
| `CONSOLE_AWAKE_STATE` | `.local/awake-state.json` | 原始电源设置的私有恢复记录。更换设备前恢复/审查，每台设备使用独立状态。 |
| `KEEP_SCREEN_ON` | 关闭 | 旧版 scrcpy 唤醒/保持亮屏开关。通常留空：页面生命周期已请求保持亮屏并恢复设置。不绕过锁屏或厂商策略。 |

五分钟无操作、45 秒心跳丢失、单个在线控制页面及 60 秒 JS 任务限制，是当前固定应用策略。设备必须接受底层设置，失败会明确显示。

## 鉴权与代理

| 应用变量 | 默认值 | 含义 |
| --- | --- | --- |
| `CONSOLE_PASSWORD_FILE` | 无 | 私有可读文件，权限 `0600`，密码长 12–512 个字符；去掉末尾一个换行。建议优先使用文件。 |
| `CONSOLE_PASSWORD` | 无 | 另一种固定密码来源。两种来源只能选一种。环境变量可能被主机/容器管理员看到。 |
| `AUTH_DATA_DIR` | `.local/auth` | 持久私有鉴权/会话目录；镜像使用 `/app/.local/auth`。审计位于相邻的 `../audit`。 |
| `AUTH_REMEMBER_DAYS` | `90` | 持久登录天数，整数 1–180。不勾选保持登录时为 8 小时。 |
| `CONSOLE_PUBLIC_ORIGIN` | 未设置，仅本机 Host 策略 | 精确 HTTPS origin，包含外部端口，不含路径或末尾斜杠，如 `https://phone.example.com` 或 `https://console.example.com:9443`。启用 Secure Cookie 和 HTTPS 检查。 |
| `CONSOLE_BASE_PATH` | `/` | 以 `/` 分隔且结尾为 `/` 的前缀，例如 `/phone/`。代理必须保留此路径。 |
| `CONSOLE_COOKIE_PATH` | 基础路径 | HTTPS 下必须与基础路径一致。示例显式设为 `/`；使用子路径时两者一起修改。 |
| `TRUST_PROXY` | 无 | 逗号分隔的代理/连接器 socket 来源 IP 或受限 CIDR，不接受主机名或信任整个互联网。决定可信协议/IP 转发。 |

目前只有一个固定密码账号。会话/IP 审计不等于个人身份或角色授权。更改密码后重启会使已存会话失效。代理/隧道 SSO 是额外可选层。

## 视频、STUN 与中继选择

| 应用变量 | 运行时默认值 | 含义 |
| --- | --- | --- |
| `WEBRTC_ENABLED` | `1` | `0` 关闭全部 WebRTC/ICE/STUN/TURN，此时必须启用 WSS。示例设为 `0`。 |
| `VIDEO_WSS_FALLBACK` | `0` | `1` 启用同源 WebSocket H.264。虽然沿用 fallback 名称，它可作为唯一通道。示例设为 `1`。 |
| `WSS_ADAPTIVE_ENCODER` | 原生未设置时为 `0`；Compose 为 `1` | FFmpeg 自适应编码，失败时回退到原始 H.264。设为 `0` 可直接发送手机视频流，减少主机 CPU 消耗。 |
| `FFMPEG_PATH` | PATH 中的 `ffmpeg` | 原生可执行文件。镜像含 FFmpeg；自定义容器路径需私有叠加配置和对应程序。 |
| `VIDEO_MAX_SIZE` | `1920` | 最大采集尺寸，整数 256–4096；`0` 表示不设上限。仍受设备编码/显示能力限制。 |
| `VIDEO_MAX_FPS` | `30` | 源视频采集帧率上限，整数 1–60；实际帧率取决于屏幕和设备。 |
| `VIDEO_BIT_RATE` | `4000000` | 源 H.264 目标码率，单位 bit/s，整数 128000–20000000；不是流量硬上限。 |
| `WEBRTC_STUN_URL` | `stun:stun.cloudflare.com:3478` | 一个 `stun:hostname:UDP-port`；留空可关闭外部发现。示例已关闭。此处尚未支持多服务器、TLS STUN 或 IPv6 字面地址配置。 |
| `WEBRTC_PORT_MIN/MAX` | `50000` / `50031` | 服务端本地 UDP 范围：1024–65535 内的 2–256 个端口，仅启用 WebRTC 时使用，含中继模式。与 coturn 中继端口范围不同。 |
| `WEBRTC_PUBLIC_IP` | 未设置 | 可选公网 IPv4，用于真实一对一直连媒体 NAT 映射。不能填 TURN/代理主机名或出口 IP。仅中继回答中忽略此值。 |
| `WEBRTC_ICE_GATHER_MS` | `8000` | 服务端 ICE 候选采集参数，整数 3000–20000 ms。浏览器 Cloudflare 候选等待另设为 45 秒。 |
| `WEBRTC_TURN_PROVIDER` | `none` | `none` 为直连，`coturn` 为自建中继，`cloudflare` 为 Cloudflare 中继。仅 WSS 无需密钥。 |
| `WEBRTC_ICE_MODE` | 无 TURN 时 `all`；TURN 时 `relay` | `all` 允许直连/STUN 和已配置中继；`relay` 必须有 TURN。双服务配置要求 coturn 以 relay 模式作为主服务。 |
| `WEBRTC_TURN_FALLBACK` | 未设置 | `cloudflare` 为 coturn relay 主服务增加第二种中继，可独立移除；浏览器并行探测。 |
| `WEBRTC_TURN_TTL_SECONDS` | `14400` | 凭据有效期，整数 600–172800 秒。建议专用部署设为 600。coturn Compose 仅在环境中未设置 TTL 时默认 600。 |

`WEBRTC_ENABLED=0` 时，忽略未使用的 WebRTC 配置、密钥和备用中继。禁用通道在生成凭据/协商设备前即被拒绝。Compose 会保留显式留空的 STUN 配置。至少要启用一个视频通道。

WSS 自适应编码选择 4/8/12 FPS 和 600 kbps/1.2 Mbps/1.8 Mbps 上限档位，保留分辨率并使用 baseline H.264。源配置影响所有通道；WSS 二次编码是独立环节，可能增加 CPU 消耗。协议开销、中继收发两端、重试及探测另耗流量。不采集音频。末帧年龄/RTT 不是对采集到显示延迟的保证。

## TURN 凭据

| 应用变量 | 含义 |
| --- | --- |
| `COTURN_KEY_FILE` | 私有 JSON `{"secret":"64_HEX_CHARACTERS"}`。同一 32 字节十六进制密钥需填入私有 coturn `static-auth-secret`，不是浏览器静态用户名/密码。仅启用 coturn 时需要。 |
| `COTURN_URL` | 浏览器地址 `turns:hostname:port?transport=tcp`。证书、监听和名称必须匹配，要求 TLS/TCP。 |
| `COTURN_SERVER_URL` | 可选服务端地址，默认与浏览器相同。可使用内网地址，但 TLS 服务端名称仍以浏览器主机名校验。 |
| `CF_TURN_KEY_FILE` | 私有 JSON `{"keyId":"...","apiToken":"..."}`，存储专用 TURN key/token。仅启用 Cloudflare 主服务或备用服务时需要。 |

密钥文件必须是普通文件，不超过 4096 字节，POSIX 权限为 `0600`，字段有效且运行用户可读。Cloudflare TURN key 的 token 不是通用账号 API token。浏览器/发送端使用独立短期凭据。自建凭据按 TTL 到期，清理时关闭活动分配。两种集成目前都使用 TLS/TCP，并非支持所有 TURN 鉴权/传输方式。

## Compose 与安装脚本的主机变量

这些变量配置脚本/Compose，而不是直接配置应用：

| 变量 | 含义 |
| --- | --- |
| `ANDROID_CONSOLE_IMAGE` | `scripts/build-image.sh` 构建的镜像，不假设已发布镜像仓库。 |
| `CONSOLE_UID/GID` | 必填实际运行 UID/GID。新建 compose.env 时准备脚本填入当前用户 ID，不假定为 1000。 |
| `ANDROID_USB_GID` | 必填实际 USB 访问组 ID，不默认 46/plugdev。 |
| `CONSOLE_HTTP_HOST/PORT` | 对应应用 HOST/PORT。示例选择回环；未使用示例时基础 Compose 默认 `0.0.0.0:8780`。 |
| `CONSOLE_PASSWORD_PATH` | 主机密码文件，只读挂载到 `/run/secrets/console-password`。 |
| `CONSOLE_STATE_PATH` | 主机私有状态，挂载到 `/app/.local`。 |
| `CONSOLE_HOME_PATH` | 主机私有容器 home/ADB 密钥，挂载到 `/home/node`。 |
| `COTURN_KEY_PATH` | 仅 coturn 叠加配置使用的主机 JSON 路径。 |
| `CF_TURN_KEY_PATH` | 仅 Cloudflare 叠加/备用配置使用的主机 JSON 路径。 |
| `SETUP_PYTHON` | 新建原生 venv 的解释器，默认 python3。已有 venv 必须为 3.11+。 |
| `ADB_KEY_SOURCE_DIR` | 准备脚本的可选 ADB 密钥来源，默认调用用户的 `.android`。保留已存在的目标密钥。 |
| `ANDROID_USB_GROUP` | 可选 Linux udev 脚本的组名。旧默认 plugdev 会检查是否存在，请显式提供实际组名。 |
| `ANDROID_USB_VENDOR_ID` | 未传命令参数时，udev 脚本使用的四位十六进制厂商 ID。 |

`compose.wss.yaml` 强制仅 WSS，不挂载 TURN 密钥。coturn/Cloudflare 叠加文件各自启用服务并挂载对应密钥。备用叠加文件为 coturn 增加 Cloudflare，并尊重 WSS 开关。参见[视频通道配置](SETUP.md#5-select-video-transports)。
