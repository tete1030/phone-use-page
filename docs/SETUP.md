# 安装部署完整手册

本手册从本机手机控制台开始，逐步加入可选远程访问和视频中继。可以停在任意阶段，不要求特定手机厂商、NAS、路由器、DNS 服务、域名注册商或代理管理器。文中的地址均为示例；真实配置放在被 Git 忽略的 `.local/` 或 `.env` 中，不要提交。

还未选定方案时，先看[默认部署条件与场景指南](DEPLOYMENT_SCENARIOS.md)。需要具体文件时，查看[配置示例目录](../examples/deployment/README.md)；主机工具、权限和 ADB 准备见[主机与 ADB 配置](HOST_SETUP.md)。

## 目录

1. [选择部署拓扑](#1-choose-a-topology)
2. [连接并授权安卓设备](#2-connect-and-authorize-android)
3. [Linux 或 macOS 原生运行](#3-run-natively-on-linux-or-macos)
4. [Linux Docker 部署](#4-run-with-docker-on-linux)
5. [选择视频通道](#5-select-video-transports)
6. [通过任意 HTTPS 反向代理发布](#6-publish-through-any-https-reverse-proxy)
7. [可选：Cloudflare Tunnel](#7-optional-cloudflare-tunnel)
8. [可选：自建 coturn](#8-optional-self-hosted-coturn)
9. [可选：Cloudflare TURN](#9-optional-cloudflare-turn)
10. [验证与排障](#10-verify-and-troubleshoot)
11. [运行维护、升级与恢复](#11-operate-upgrade-and-recover)

另请阅读[环境变量参考](CONFIGURATION.md)、[兼容性与运行要求](PORTABILITY.md)和[安全说明](SECURITY.md)。

<a name="1-choose-a-topology"></a>

## 1. 选择部署拓扑

**控制台主机**运行 Node/Python/ADB，需要能访问手机。**代理/隧道连接器**将浏览器 HTTPS 和 WebSocket 流量传到控制台。使用 TURN 时，**TURN 主机**中继 WebRTC 媒体。这些角色可以分布在不同机器上；把控制台运行在 VPS 上，不会自动获得家中手机的 USB 访问能力。

| 目标 | 建议起点 | 公网入站端口 |
| --- | --- | --- |
| 同一台电脑使用 | 原生控制台、localhost、仅 WSS | 无 |
| 私有远程访问 | HTTPS 代理或 localhost SSH 转发、仅 WSS | 取决于 HTTPS/SSH 服务 |
| 无入站转发的公网网址 | 出站 HTTP 隧道、仅 WSS | 控制台网络无需开放 |
| 更低延迟的中继视频 | HTTPS 页面通道，加自建 TURN 或 Cloudflare TURN | 自建 TURN 需开放监听和中继端口；Cloudflare TURN 需出站可达 |
| WebRTC 直连 | HTTPS 页面通道、可达的服务端 UDP、可选 STUN | 需要转发时开放控制台 UDP 媒体范围 |

WSS 使用与页面**同源**的连接传输 H.264 视频，包含帧间压缩。WebRTC 媒体走独立通道。Cloudflare HTTP Tunnel 不转发普通浏览器的 TURN/UDP 媒体。Cloudflare Tunnel 与 Cloudflare TURN 是独立产品，可以分别使用。

建议先用仅 WSS 验证手机、鉴权和 HTTPS，再按网络和延迟需求添加中继。附带环境变量示例默认仅 WSS。为兼容旧部署，未使用这些示例的运行时默认仍为开启 WebRTC、关闭 WSS；请明确设置两个开关。

<a name="2-connect-and-authorize-android"></a>

## 2. 连接并授权安卓设备

按操作系统的安装方式获取 Google [Android SDK Platform Tools](https://developer.android.com/tools/releases/platform-tools)。ADB 需在 PATH 中，或将 `ADB_PATH` 设为可执行文件的绝对路径。在手机上：

1. 按厂商说明启用开发者选项，常见方法是连续点击版本号。
2. 开启 USB 调试，连接可传数据的 USB 线，解锁手机并确认电脑的 RSA 指纹授权。
3. 运行 `adb devices -l`。目标设备应显示 `device`，而不是 `unauthorized`、`offline` 或 `no permissions`。
4. 如果点击/按键注入被阻止，检查调试安全设置和企业管理策略；部分厂商有额外开关。本项目不要求 SIM 卡、小米账号、解锁 Bootloader 或 root。

Android 5+ 是 scrcpy 的基础要求，具体功能还取决于 UI Automator、应用和厂商策略。UHID 键盘会尝试注册并验证，不支持时回退到 keycode。受保护或自绘应用可能限制视频/UI 树读取。唤醒并解锁不会绕过 PIN/密码。完整边界见 [PORTABILITY.md](PORTABILITY.md)。

`ANDROID_SERIAL` 接受 ADB 显示的设备标识，包括已授权无线设备，例如 `device.example.test:5555`。无线调试需**先**按安卓官方流程完成配对/连接，再启动应用；ADB 应留在私有网络中。本应用使用本地 TCP 5037 ADB 服务，目前不对外承诺远程 ADB 服务配置。

未设置 `ANDROID_SERIAL` 时，自动选择单台已授权设备；多台已授权设备需显式选择。如果服务器启动时手机可能未连接，应显式设置序列号，后续轮询可重新连接到该设备。每个控制台进程管理一台设备。

### Linux USB 权限

macOS 原生 ADB 通常无需 udev 规则。Linux 上应先检查实际 USB 所有者及发行版已有安卓规则，不要假定 `plugdev` 存在或其组号固定。

可选脚本需要**真实** USB 序列号及四位十六进制厂商 ID，可用 `lsusb`/`udevadm` 查询：

```sh
ANDROID_USB_GROUP="$(id -gn)" sh scripts/install-usb-rule.sh DEVICE_SERIAL USB_VENDOR_ID
```

脚本使用 sudo 安装仅匹配该设备的规则，备份已有规则、重载 udev，并授予指定组访问权限。重新插拔后检查 ADB。后续容器的 USB 组 GID 必须匹配此规则，或你选用的已有规则。USB 总线/设备编号不是组 GID；修改组成员关系后可能需要重新登录。

<a name="3-run-natively-on-linux-or-macos"></a>

## 3. Linux 或 macOS 原生运行

需要 Git、Node.js 22.12+、带 venv/pip 的 Python 3.11+、ADB 和较新 Chromium。FFmpeg 用于可选 WSS 自适应编码。使用自己的操作系统/包管理器安装；`uv` 可选，存在时脚本使用它，否则使用 Python venv/pip。如果所需 Python 不是 `python3`，设置 `SETUP_PYTHON`。

```sh
git clone https://github.com/tete1030/phone-use-page.git
cd phone-use-page
sh scripts/setup.sh
cp .env.example .env
mkdir -p .local
chmod 700 .local
chmod 600 .env
```

创建私有密码文件，避免把密码放进 shell 历史。以下示例不会覆盖已有文件：

```sh
python3 - <<'PY'
import getpass, os
password = getpass.getpass('控制台密码（12–512 个字符）：')
if not 12 <= len(password) <= 512:
    raise SystemExit('密码长度不符合要求')
fd = os.open('.local/console-password', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    output.write(password + '\n')
PY
```

编辑私有 `.env`。最小本机配置如下：

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

按需设置 `ANDROID_SERIAL`。没有 FFmpeg，或不希望消耗编码 CPU 时，设 `WSS_ADAPTIVE_ENCODER=0`，WSS 将发送手机原始 H.264。安装 FFmpeg 后，如不在 PATH 中，可设置 `FFMPEG_PATH`。本项目不采集音频。

```sh
sh scripts/start.sh
```

打开 `http://localhost:8780/`，登录并验证真实画面/输入。浏览器将 localhost 视为安全上下文，因此本地 socket 使用 `ws://` 时也能播放 WSS 视频。任意远程 HTTP 不满足这一条件，远程浏览器应使用 HTTPS。未配置公网访问时，服务有意将允许的 Host 限制为回环地址。

未提供原生 Windows 安装脚本。可以使用已确认 USB 透传的 Linux 主机/虚拟机，并验证设备在其中可见。Windows/macOS Docker Desktop 不具备与 Linux 相同的 USB/主机网络行为。

<a name="4-run-with-docker-on-linux"></a>

## 4. Linux Docker 部署

附带 Compose 方案需要 Linux Docker Engine、Compose 插件、可访问的 `/dev/bus/usb`，以及构建/准备脚本所需的 Python 3。它不依赖任何 NAS/容器管理产品。Node/Python 依赖在镜像内构建；不要用 `privileged: true` 代替正确权限配置。

1. 克隆仓库，在该主机上授权 ADB，并按前文创建 `.local/console-password`。
2. 以预期运行用户准备状态/密钥，不使用 sudo：

   ```sh
   sh scripts/prepare-docker.sh
   ```

   脚本按当前用户填入 `CONSOLE_UID`/`CONSOLE_GID`，创建私有可写目录，仅在目标密钥缺失时复制主机已有 ADB 密钥，不替换已有 `.local/compose.env`。

3. 编辑 `.local/compose.env`，将 `ANDROID_USB_GID` 设为真实 USB 访问组 ID。如果前文规则使用你的主组，则是 `id -g` 的结果；否则检查已有 USB 规则/所有者。核对生成的 UID/GID，运行用户需能读取密钥并写入状态挂载。按需设置设备序列号。
4. 构建镜像，将输出标签填入私有 `.local/compose.env` 的 `ANDROID_CONSOLE_IMAGE`：

   ```sh
   sh scripts/build-image.sh
   ```

   构建器运行类型、单元和 Python 检查，并验证附带服务端。项目不假定已有预构建/公开镜像；其他 CPU 架构需分别验证构建。

5. 启动**仅 WSS**，不需要中继密钥：

   ```sh
   docker compose --env-file .local/compose.env -f compose.yaml -f compose.wss.yaml config --quiet
   docker compose --env-file .local/compose.env -f compose.yaml -f compose.wss.yaml up -d --no-build console
   docker compose --env-file .local/compose.env -f compose.yaml -f compose.wss.yaml ps
   ```

配置包含 HTTP 监听地址、运行用户/组、设备权限和状态挂载。环境示例默认绑定 `127.0.0.1`，适合同**一台主机**上的代理/连接器。代理位于其他机器或容器网络时，按实际拓扑设 `CONSOLE_HTTP_HOST=0.0.0.0` 或合适的主机地址，并将入站访问限制为该连接器。Linux `network_mode: host` 不使用 Compose `ports:`；媒体端口也直接使用主机端口。

NAS 界面、systemd 或其他容器管理器可以复现同样的镜像、环境、用户、USB、挂载和网络设置。这些是可选部署工具，不是应用要求。

<a name="5-select-video-transports"></a>

## 5. 选择视频通道

原生运行使用 `.env`，容器使用私有 `.local/compose.env` 和下列 Compose 文件。应用 `.env` 中的值不会自动进入容器，除非 Compose 明确转发；容器部署请统一使用对应方案。

| 启用的视频通道 | 原生设置 | 叠加的 Compose 文件，均以 `compose.yaml` 为基础 |
| --- | --- | --- |
| 仅 WSS，关闭两种 TURN | `WEBRTC_ENABLED=0`、`VIDEO_WSS_FALLBACK=1` | `compose.wss.yaml`，不叠加 TURN 文件 |
| 仅 WebRTC 直连 | `WEBRTC_ENABLED=1`、`WEBRTC_TURN_PROVIDER=none`、`VIDEO_WSS_FALLBACK=0` | 仅基础文件，在 compose.env 设置开关 |
| WebRTC 直连 + WSS | 同上，但 `VIDEO_WSS_FALLBACK=1` | 仅基础文件，在 compose.env 设置开关 |
| 仅自建 TURN / 加 WSS | `WEBRTC_ENABLED=1`、服务为 `coturn`、设置 `COTURN_KEY_FILE` 和 `COTURN_URL`；WSS 为 `0` / `1` | `compose.coturn.yaml`，设置 WSS 开关 |
| 仅 Cloudflare TURN / 加 WSS | `WEBRTC_ENABLED=1`、服务为 `cloudflare`、设置 `CF_TURN_KEY_FILE`；WSS 为 `0` / `1` | `compose.turn.yaml`，设置 WSS 开关 |
| 两种 TURN，不带 / 带 WSS | 服务为 `coturn`、`WEBRTC_TURN_FALLBACK=cloudflare`、设置两个密钥文件；WSS 为 `0` / `1` | `compose.coturn.yaml`、`compose.fallback.yaml`，设置 WSS 开关 |

TURN 默认使用仅中继 ICE。直连时，将 `WEBRTC_STUN_URL` 设为可达 STUN 服务，或留空只使用主机候选，例如双方可达的局域网。STUN 负责发现地址，不负责中继。同时关闭 WebRTC 和 WSS 等无可用通道配置会导致启动失败。

关闭 WebRTC 后，忽略其未使用的设置/密钥文件，不创建 ICE 连接、STUN 发现或 TURN 凭据请求。关闭某种 TURN 时，移除对应 Compose 叠加文件和服务/备用配置。不要将 `compose.wss.yaml` 与 TURN 文件叠加，它是独立的仅 WSS 方案。移除叠加文件也会移除相应密钥挂载。

自动模式并行启动已启用通道，先显示首个实际视频帧；更高优先级就绪后升级，并关闭低优先级通道。优先级为自建 TURN > Cloudflare TURN > WSS；直连配置中为 WebRTC 直连 > WSS。手动单选只使用所选已启用通道；保存的选择不再可用时回退到自动模式。

### WebRTC 直连与 NAT

使用 `WEBRTC_PORT_MIN/MAX`，默认 UDP 50000–50031；在控制台主机放行，并仅在需要时穿过相关 NAT 做相同范围、相同端口映射。只有真实一对一映射有效时，才将 `WEBRTC_PUBLIC_IP` 设为真实公网 IPv4。随意发现的 IP、代理出口 IP 或主机名不是有效替代值。

CGNAT、对称 NAT、终端防火墙/浏览器限制、双重 NAT 或缺少 NAT 回流均可能阻断直连。当前服务端未实现 IPv6 媒体。运营商封锁入站 80/443 时，可使用其他允许端口或出站 HTTP 隧道，不要求家庭网络开放这两个端口；TURN/WSS 仍可作为替代通道。

<a name="6-publish-through-any-https-reverse-proxy"></a>

## 6. 通过任意 HTTPS 反向代理发布

使用自己选择的 DNS 服务、CA 和续期方式准备域名/主机名及可信 TLS 证书。选择公网 URL，例如 `https://phone.example.com` 或 `https://console.example.com:9443/phone/`，不要求特定代理管理器。

第一个 URL 的配置：

```dotenv
CONSOLE_PUBLIC_ORIGIN=https://phone.example.com
CONSOLE_BASE_PATH=/
CONSOLE_COOKIE_PATH=/
TRUST_PROXY=127.0.0.1/32
```

可信代理应填写应用看到的**实际 socket 来源地址**，不是浏览器 IP，也不是供应商全部公网 IP。如果本地连接器实际使用 IPv6 回环，可同时信任 `::1/128`。远程/容器代理使用其明确地址或受限子网。限制绕过代理直接访问控制台：能从可信地址发起连接的客户端，可以提供转发请求头。

代理必须：

- 保留公网 `Host`，使用外部端口时也保留端口；保留原始 HTTPS 协议和配置的请求路径。
- 设置 `X-Forwarded-Proto: https` 和准确的客户端 IP 转发链，只信任已知上游节点。
- 支持 WebSocket 升级及长连接 `/ws/events`、`/ws/control`、`/ws/video`；不缓冲视频，不设置过短读取超时。
- 将请求转发到**代理自身可达**的控制台 HTTP 地址。其 `localhost` 不代表另一台主机/容器的 localhost。

通用 Nginx TLS 服务 location 示例，证书和 listen 指令由你已有的 TLS 配置提供：

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

对于 `https://console.example.com:9443/phone/`，设 `CONSOLE_PUBLIC_ORIGIN=https://console.example.com:9443`，基础路径及 Cookie 路径均为 `/phone/`。使用 `location /phone/`，其中 `proxy_pass http://127.0.0.1:8780` **不要添加末尾斜杠或重写路径**，应用自己处理 `/phone/`。公网 origin 含端口、不含路径；Cookie/基础路径含路径、不含 origin。Secure Cookie 要求应用通过可信代理识别原始 HTTPS 协议。

偶尔私有访问，也可对按本机配置运行的控制台使用 `ssh -L 8780:127.0.0.1:8780 user@console-host`，随后访问本地 `http://localhost:8780`。不要同时设置不相关公网 origin，并假定两个访问入口都满足同一来源策略。

<a name="7-optional-cloudflare-tunnel"></a>

## 7. 可选：Cloudflare Tunnel

仅在选择 Cloudflare 承载 **HTTP/WSS 通道**时使用本节。它不配置 TURN，也不需要入站路由转发。普通公网主机名要求网站/区域满足 Cloudflare Tunnel 发布条件，通常为已激活、由 Cloudflare 管理 DNS 的区域。这是可选产品要求，不是 Phone Use Page 的要求。不要假定现有注册商/DNS 已是 Cloudflare；按[官方前置条件](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)操作，并确认当前套餐是否支持所需部分区域配置。

### 控制台管理的隧道

1. 在自己的 Cloudflare 账号 Zero Trust/Tunnel 页面创建 `cloudflared` 隧道。界面名称可能变化，以最新官方指南为准。
2. 在可达控制台的主机安装 `cloudflared`，按页面连接器说明启动。生成的连接器 token 保持私有。可以使用容器或系统服务；优先用私有 token 文件/服务配置，避免密码令牌进入 shell 历史，不发布含真实 token 的命令。
3. 添加公网应用/主机名，例如 `phone.example.com`。同机连接器使用 **HTTP** 服务 `127.0.0.1:8780`；跨主机使用可达内网地址。桥接网络中的 `cloudflared` 容器不能从自己的回环地址访问主机控制台，应使用合适的 Linux 主机网络或明确可达的主机地址。
4. 配置精确的 `CONSOLE_PUBLIC_ORIGIN=https://phone.example.com`、正确基础/Cookie 路径和实际连接器来源对应的 `TRUST_PROXY`。保留公网 Host，或将隧道 HTTP Host Header 设为精确控制台主机名；确保转发的 HTTPS 协议保留。按同一视频方案重启控制台。
5. 等待隧道显示 Healthy、DNS 和证书就绪，验证登录、资源及三种 WebSocket 路径。应用自身鉴权仍有效。Cloudflare Access 可再增加身份层，但智能体需能完成该登录，不要假定所有智能体都能完成交互式 Access 流程。

独立子域名、根路径最简单。使用子路径时，在 ingress 中保留 `/phone/`，应用基础和 Cookie 路径也设为 `/phone/`；隧道路径匹配不会自动移除该前缀。

### 本地管理的隧道（另一种方式）

希望在本地管理凭据/配置而非使用控制台 token 时，可按[官方本地管理指南](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/)认证、创建并设置自己的隧道路由：

```sh
cloudflared tunnel login
cloudflared tunnel create phone-use-page
cloudflared tunnel route dns TUNNEL_UUID phone.example.com
```

登录证书和隧道凭据 JSON 都是私有文件。将配置/凭据放在未跟踪路径，例如 `.local/cloudflared/`，限制权限，并使用绝对路径：

```yaml
tunnel: YOUR_TUNNEL_UUID
credentials-file: /absolute/private/path/tunnel-credentials.json
ingress:
  - hostname: phone.example.com
    service: http://127.0.0.1:8780
  - service: http_status:404
```

先验证再运行，路径替换为自己的真实文件：

```sh
cloudflared tunnel --config /absolute/private/path/config.yml ingress validate
cloudflared tunnel --config /absolute/private/path/config.yml run
```

末尾默认匹配规则是必需的。服务地址、Host 和可信代理按控制台管理方案同样配置。可按操作系统的服务管理方式持久运行。不要假定隧道政策允许无限视频流量，需查看供应商当前服务条款和限制。

<a name="8-optional-self-hosted-coturn"></a>

## 8. 可选：自建 coturn

目前集成使用 **TLS/TCP 上的 TURN**，以及 coturn REST 风格 HMAC 共享密钥鉴权，不支持直接使用明文 `turn:` URL 或静态用户名/密码列表。TLS/TCP 是浏览器到中继的传输；分配后的中继仍在对端之间使用 UDP，因此还需要 UDP 中继端口范围。

### 选择并连通 TURN 主机

可以选择 VPS、公网服务器或自己的 NAT 后可达主机，不要求与控制台同机。准备 `turn.example.com` 等主机名，将普通 A 记录指向真实公网 IPv4，并申请该名称的可信证书。可使用任意 DNS/CA 工具。如果 DNS 提供商提供 HTTP/CDN 代理，普通 TURN 应使用**仅 DNS**，HTTP 代理/隧道不承载 TURN TLS。除非 TURN 监听、防火墙和中继真实支持 IPv6，否则不要添加 AAAA。

示例使用 TCP 5349 和 UDP 52000–52063。可以选择 8443 等其他允许的 TLS 端口，但 URL、监听、映射和防火墙必须一致。不假定入站 443/80 可用。检查主机防火墙、云安全组、上游路由/NAT、运营商和 CGNAT。HTTPS GET 到达此端口不证明 TURN 分配或媒体成功，因为 TURN 不是 HTTP。

无法使用入站 80/443 时，可通过 CA 的 DNS-01 挑战验证域名，不需要网页监听。选择 DNS/CA 工具支持的续期方式，妥善保存所需 DNS API 凭据。Cloudflare Tunnel 页面的边缘证书不提供 coturn 所需本地证书/私钥，需单独申请和维护。

### 生成私有 REST 密钥与配置

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

JSON 密钥必须为 64 位十六进制字符。将同一个密钥安全地写入 coturn 私有配置的 `static-auth-secret`，不要改公开示例。编辑私有 `turnserver.conf`：

- `listening-ip` 和 `relay-ip`：TURN 主机真实本地接口地址，文档示例地址不能直接绑定。
- `realm`/`server-name`：自己的 TURN 主机名；`tls-listening-port`：选定的 TCP 监听端口。
- `cert`/`pkey`：完整可信证书链及私钥，需由运行用户读取；按证书工具要求续期并重载/重启 coturn。
- `min-port`/`max-port`：实际网络已放行/映射的 UDP 中继范围。
- NAT 后添加 `external-ip=PUBLIC_IPV4/LOCAL_RELAY_IPV4`，并配置相同端口的一对一 UDP 映射。公网接口 VPS 则按真实接口拓扑配置。动态公网 IP 变化需同时更新 DNS **和** coturn 对外地址。
- 保留 `use-auth-secret`、鉴权、私有地址对端限制、配额和流量限制。核对所用 coturn 版本的回环、组播及 IPv6 防护。示例小配额是起点，不是容量建议。不要仅为局域网测试通过而删除私有对端限制，优先使用公网 relay 候选，或仅对隔离测试添加明确批准的单个地址。

可按自己的操作系统包/服务管理器安装 coturn，或使用独立 Linux Docker 示例。选择已审查的固定镜像标签/摘要，创建被 Git 忽略的环境文件，例如 `.local/coturn.env`：

```dotenv
COTURN_IMAGE=coturn/coturn:4.6.3
TURN_UID=
TURN_GID=
TURN_CONFIG_PATH=/absolute/private/path/turnserver.conf
TURN_CERTIFICATE_DIR=/absolute/private/path/certificates
```

`TURN_UID`/`TURN_GID` 填入 **TURN 主机**上拥有私有配置/证书的用户 `id -u`/`id -g` 结果，可能与控制台主机不同。示例官方镜像默认用户为 `nobody`，读不到其他用户的 `0600` 密钥，因此 Compose 显式覆盖运行用户。应让指定用户可读受保护文件，不要改为所有人可读。

```sh
docker compose --env-file .local/coturn.env -f examples/coturn/compose.yaml config --quiet
docker compose --env-file .local/coturn.env -f examples/coturn/compose.yaml up -d
```

独立 TURN 容器使用 Linux 主机网络，不依赖特定 NAS 界面。配置挂载到 `/etc/coturn/turnserver.conf`，证书目录挂载到 `/certificates`。控制台还需自己的私有 JSON 密钥文件；不会向浏览器共享可写密钥卷。

示例删除所有 capabilities，仅保留 `NET_BIND_SERVICE`。经过测试的官方 4.6.3 可执行文件携带此文件权限，即使使用高端口也需要在能力边界中保留它。仍启用 `no-new-privileges` 和只读根文件系统。其他镜像封装可能不同，按[上游镜像说明](https://github.com/coturn/coturn/tree/master/docker/coturn)核对文件系统/用户要求。示例已在隔离容器中通过临时证书和 TLS 握手测试，公网路由及已鉴权媒体通道仍需单独验证。

证书是符号链接时，还需挂载链接目标，或将完整文件导出到私有目录；只挂载指向卷外文件的 `live` 目录会失败。将导出/重载加入续期钩子。同步控制台和 TURN 主机时钟，确保短期 REST 凭据有效。无状态 REST 示例把本地 SQLite 缓存放在 `/tmp`；持久数据库用户需另配私有持久数据库。

可选的[容器内 TURN 维护器](TURN_MAINTENANCE.md)可以检查证书并热更新 TLS、维护动态公网地址、管理有期限的诊断日志，替代宿主 cron。文档包含通用 Docker 示例、DockerMan 配置要点、与 NPM/Certbot 的窄范围证书挂载方式和回滚步骤；不要求特定网关或 NAS。

### 配置控制台

原生 `.env`：

```dotenv
WEBRTC_ENABLED=1
WEBRTC_TURN_PROVIDER=coturn
WEBRTC_ICE_MODE=relay
WEBRTC_TURN_TTL_SECONDS=600
COTURN_KEY_FILE=.local/coturn-key.json
COTURN_URL=turns:turn.example.com:5349?transport=tcp
VIDEO_WSS_FALLBACK=1
```

Docker 在私有 compose.env 设置 `COTURN_KEY_PATH=./.local/coturn-key.json`、`COTURN_URL`、TTL 和 WSS 开关，再使用 `compose.yaml` + `compose.coturn.yaml`。叠加文件会挂载密钥，并自动设置容器内 `COTURN_KEY_FILE`。

服务端默认使用与浏览器相同 URL。如果控制台需访问另一个可达内网监听，可设 `COTURN_SERVER_URL`，例如 `turns:192.0.2.10:5349?transport=tcp`。TLS 证书仍按 **COTURN_URL** 中的主机名校验，不能跳过证书验证。双方都需能到达声明的 relay 候选；后端局域网分配成功不等于公网浏览器成功。

<a name="9-optional-cloudflare-turn"></a>

## 9. 可选：Cloudflare TURN

需要已开通可用 Realtime TURN 产品的 Cloudflare 账号、专用 TURN key，以及浏览器和控制台的出站连通性。控制台域名**不需要**使用 Cloudflare DNS/Tunnel。启用前检查自己账号的最新计费条款；[账单通知](https://developers.cloudflare.com/billing/notifications/)用于预警，不是金额硬上限。

1. 在自己的账号打开 [Cloudflare Realtime](https://dash.cloudflare.com/?to=/:account/calls)，按需开通产品/订阅，创建专用 TURN key，并取清晰的部署名称。
2. 在服务端保存 **TURN key ID 和该 key 对应 token**，不要替换成账号通用 API token 或浏览器 TURN 用户名/密码。按[官方 TURN 凭据指南](https://developers.cloudflare.com/realtime/turn/generate-credentials/)配置。
3. 创建被 Git 忽略的 `.local/cloudflare-turn-key.json`，结构如下，真实值仅在私有文件中填写：

   ```json
   {"keyId":"YOUR_TURN_KEY_ID","apiToken":"YOUR_TURN_KEY_TOKEN"}
   ```

   设置权限 `0600` 和正确运行用户。key ID 需为 32 位十六进制，token 由应用校验。不要将它粘贴到 issue/聊天、提交代码、写入日志或打包到前端。

4. 原生运行设置：

   ```dotenv
   WEBRTC_ENABLED=1
   WEBRTC_TURN_PROVIDER=cloudflare
   WEBRTC_ICE_MODE=relay
   CF_TURN_KEY_FILE=.local/cloudflare-turn-key.json
   WEBRTC_TURN_TTL_SECONDS=600
   VIDEO_WSS_FALLBACK=1
   ```

   Docker 在私有 compose.env 设置 `CF_TURN_KEY_PATH=./.local/cloudflare-turn-key.json`、TTL 和 WSS 开关，再使用 `compose.yaml` + `compose.turn.yaml`，不会挂载或启用自建 TURN。

5. 控制台通过 Cloudflare API 分别创建浏览器/发送端短期凭据，到期前更新，断连时尝试撤销。提供的 ICE URL 被筛选为 `turns:turn.cloudflare.com:443?transport=tcp`，不使用家庭网络入站 443。浏览器只获得短期凭据，不获得长期 key/token。控制台需出站 HTTPS 到 `rtc.live.cloudflare.com`、TURN TLS 到 `turn.cloudflare.com:443`；浏览器同样需能访问 TURN TLS。智能体浏览器支持普通 HTTPS 不保证支持 TURN。
6. 两种中继加 WSS 时，保留 coturn 主服务；原生增加 `WEBRTC_TURN_FALLBACK=cloudflare`，或 Docker 使用 `compose.yaml` + `compose.coturn.yaml` + `compose.fallback.yaml`。此时使用完整优先级。停用 Cloudflare 时，移除备用配置/叠加文件及密钥挂载，重启控制台，可再从 Cloudflare 撤销专用 key。

在账号中自行配置账单预警/配额。应用不强制通用金额上限。并行探测、凭据更新和中继两端可能消耗流量；预警不能保证最终账单不超过指定值。

如果套餐支持，在账号账单/通知页面创建费用或预算通知，选择币种、阈值和接收人，保存后确认已启用。例如 $50 只是预警预算示例，不是服务端硬上限。核对通知覆盖整个账号还是 TURN 产品，试用后查看 TURN 用量页面。付款/订阅确认应与本地密钥配置分别处理。

<a name="10-verify-and-troubleshoot"></a>

## 10. 验证与排障

分层验证，并使用**真实远程浏览器/智能体网络**：

1. `adb devices -l` 显示目标设备，本机原生会话能观察/控制手机。
2. `/health` 健康只证明 HTTP 服务存活。确认未登录请求显示登录页，并不能调用控制操作。
3. 公网 HTTPS Host/origin、可信代理协议正确，登录按预期保持。设置 HTTPS 公网 origin 后，不要用 HTTP 入口诊断 Cookie。
4. 页面资源、事件/控制/视频 WebSocket 可用。仅 WSS 不应尝试 TURN；唤醒已解锁手机后，解码/绘制帧数应增加。WSS 的 ICE 候选列表为空正常。
5. 手动选择每个已启用中继，复制诊断，确认 relay 候选、成功的选中候选对，**以及实际渲染帧**。局域网成功不代表公网成功；访问 TURN 端口的 HTTPS 请求不是 TURN 测试。
6. 在非密码字段尝试无害导航和 Unicode 输入。关注回执验证状态：原始按键已发送，不证明应用接受。界面变化后重新读取目标。
7. 验证第二页面接管、五分钟无操作断连、重连及原始保持亮屏设置恢复。锁屏/密码限制属于预期行为。

| 现象 | 检查与处理 |
| --- | --- |
| `no permissions` 或容器看不到设备 | 实际 udev/USB 组 GID、`/dev/bus/usb` 挂载、cgroup 权限、数据线及虚拟机透传；不要猜厂商 ID/组号。 |
| `unauthorized` | 解锁手机并批准对应 ADB 密钥；未复制密钥时容器可能使用不同密钥。 |
| `HOST_REJECTED` | 公网 Host/origin 不匹配、代理重写 Host，或访问了不同域名/端口。 |
| `HTTPS_REQUIRED` 或登录 Cookie 缺失 | 原始协议、可信连接器来源 IP、Secure Cookie、精确 origin/基础/Cookie 路径及客户端 HTTPS。 |
| 页面正常但 WSS 失败 | WebSocket 升级、路径、Origin、鉴权、连接器可达性、代理读取超时及 Chromium WebCodecs 支持；查看复制的诊断。 |
| TURN 701 或没有 relay 候选 | DNS/TLS/监听可达性、浏览器出站限制、证书名称/链/时间、REST 密钥/key 或凭据过期。只验证 TLS/HTTP 不够。 |
| 有 relay，但 ICE/媒体失败 | 真实公网 relay IP 和 UDP 映射、对端限制/配额、云/主机/路由防火墙、选中候选对、浏览器编码支持和帧。 |
| 黑屏/冻结，但 UI 树更新 | 两者新鲜度独立；检查暂停原因、亮屏/锁屏状态和末帧年龄，再唤醒或重连视频。连接保留不代表画面是最新的。 |
| WSS 自适应不可用或慢 | FFmpeg 程序、CPU、编码支持；关闭自适应或降低采集参数。有丢包时仍可能出现 TCP 队头阻塞延迟。 |
| 节点/文本缺失或被拒绝 | UI Automator/应用无障碍、受保护/自绘 UI、目标歧义/过期或焦点变化；不要代入某机型特有选择器。 |
| 手机仍会熄屏 | 实际充电方式、电源权限/厂商策略、温度/省电状态；保持亮屏是已验证请求，不是绕过系统策略。 |

本地模拟验证：

```sh
npm run build
PYTHON_PATH=.venv/bin/python npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
npm run check:compose # 原生用户可跳过，需要 Docker Compose 插件
npx playwright install chromium
CHROME_PATH="$(node --input-type=module -e 'import {chromium} from "playwright"; process.stdout.write(chromium.executablePath())')" npm run test:ui
```

`check:compose` 只用模拟值解析配置，不创建容器，不读取生产密钥。浏览器/单元测试不代表已认证所有安卓厂商、架构、NAT 或隧道。实机脚本会操作设备，含特定场景断言；使用前审查并适配。不要误对真实生产浏览器会话运行实机测试，同一时间只有一个页面能控制手机。

<a name="11-operate-upgrade-and-recover"></a>

## 11. 运行维护、升级与恢复

- 状态、鉴权/会话、ADB 密钥和电源恢复数据需持久、私有，并由运行用户拥有。原生状态位于 `.local/`，容器状态/home 使用私有绑定挂载。不同手机实例使用独立状态。旧实例改连其他手机前，恢复/审查电源设置。
- 在线页面请求在 USB/交流电供电时保持亮屏。五分钟无显式操作后断开控制/媒体并停止观察；心跳失联另设 45 秒超时。灭屏/锁屏暂停视频帧但保留已建立连接，保活仍耗少量流量。有效登录 Cookie 可允许重连而无需重新登录。
- 持久状态中的 `audit/requests.jsonl` 和 `requests.previous.jsonl` 记录请求审计，按 5 MB 轮转，含 IP、浏览器标识、会话、接口/结果元数据。不记录密码、Cookie、TURN 凭据、输入文字和 JS 正文。共享密码只标识会话，不标识具体人；代理信任决定 IP 归属的准确性。
- 升级前备份私有环境、状态、密钥及旧镜像。构建/验证后，仅修改预期镜像/配置，并使用**相同的所选 Compose 文件**重建控制台。验证真实公网登录、视频、输入；不要意外漏掉叠加文件，或用 `down -v` 升级。
- 回滚恢复旧镜像/私有配置，按原叠加文件和挂载重建。保留 ADB 密钥、会话和电源恢复信息，尽量正常停止。崩溃导致电源未恢复时，重新连接同一手机，让恢复逻辑运行；人工修正前检查私有保存记录及安卓设置。
- 修改固定密码需重启，存储密码哈希不再匹配时清除已有会话。TURN 密钥泄露后，应在供应商处撤销/轮换，并更新私有文件；从 Git 或浏览器删除不是轮换。
- 只开放预期 HTTPS/代理和 TURN 端口。ADB、私有状态/配置和管理服务不可暴露到互联网。暂存新文件后运行 `npm run check:publication`；文档示例应保持示例。
