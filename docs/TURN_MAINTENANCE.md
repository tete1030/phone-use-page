# 自建 TURN 的证书与运行维护

本项目提供可选的 [coturn 维护镜像](../infra/coturn-supervisor/Dockerfile)，将证书检查、公网地址检查和临时诊断日志的期限管理放在容器内。它不依赖宿主 cron、Docker socket、NPM API 或特定 NAS。只用 WSS 或 Cloudflare TURN 时不需要部署它。

维护镜像不会申请证书、更新 DNS 或配置防火墙。这些仍由你选择的 CA 工具、DNS 服务和网关负责。标准 TURN 部署方法见[安装手册](SETUP.md#8-optional-self-hosted-coturn)。

## 工作方式

- Python 守护器作为 PID 1，运行前台 turnserver 子进程并处理退出信号。
- 默认每 60 秒检查源证书。核对域名、可信链、剩余有效期和私钥配对后，发布完整的一代材料，向 turnserver 发送 `SIGUSR2` 热更新 TLS。无须重启容器。
- 默认每 300 秒检查可选的公网地址来源。要求 DNS 返回唯一公网 IPv4，变化时重写运行配置并重启 turnserver 子进程。
- 源证书、DNS 或诊断请求无效时保留当前有效材料/地址，不用错误数据覆盖服务。证书过期后健康状态失败，即使进程还在运行。
- 诊断日志默认关闭，人工开启最长 60 分钟，到期恢复基础配置。改变诊断状态会重启 turnserver 子进程。
- 同一状态目录只允许一个守护器；连续五次子进程异常退出会停止自动重试，需要检查原因再重启容器。

证书热更新与公网 IP 变化不同：已验证的 coturn 4.8.0 在证书更新后保持已有 allocation 和子进程 PID；公网地址或诊断配置变化会重启子进程，客户端需要重连。不要把 `SIGHUP` 当作配置重载。

## 通用 Linux Docker 示例

复制 [TURN 基础配置](../examples/coturn/turnserver.conf.example) 到私有路径，配置真实监听地址、realm、共享密钥、配额和对端限制。基础配置无需依赖示例中的 `cert`、`pkey` 和 `pidfile` 路径：守护器会覆盖这三项。保留已有安全选项。

创建仅运行用户可写的状态目录（建议 `0700`），确保配置与证书私钥仅授权用户可读（建议 `0600`）。源证书目录应包含完整的 `fullchain.pem` 和 `privkey.pem`，不要仅绑定两个当前 PEM 文件，以免证书工具替换 inode 后容器仍看到旧文件。

私有 `.local/coturn-supervisor.env` 示例：

```dotenv
TURN_UID=1000
TURN_GID=1000
TURN_CONFIG_PATH=/srv/phone-turn/private/base.conf
TURN_STATE_PATH=/srv/phone-turn/state
TURN_CERT_SOURCE_DIR=/srv/phone-turn/certificate
TURN_CERT_HOSTNAME=turn.example.com
# NAT 后可选：DNS-only/DDNS 名称必须返回唯一真实公网 IPv4。
# 不填这两项时，沿用基础配置中的 external-ip（或公网主机原生地址）。
TURN_PUBLIC_HOSTNAME=wan.example.com
TURN_PRIVATE_IP=192.0.2.10
```

UID/GID、目录、域名与文档地址均需换成自己的配置。公网主机无须照搬 NAT 映射；动态 IP 的 DNS 更新仍由外部 DDNS 工具负责。若 DNS 名称使用 CDN 代理、返回多个地址或仅返回 IPv6，应关闭此地址维护功能并采用适合自己网络的地址配置方式。

```sh
docker compose --env-file .local/coturn-supervisor.env \
  -f examples/coturn/compose.supervised.yaml config --quiet
docker compose --env-file .local/coturn-supervisor.env \
  -f examples/coturn/compose.supervised.yaml up -d --build
```

该独立服务使用 Linux host 网络，不能与另一份监听相同端口的 TURN 实例同时运行。镜像基于固定摘要的 coturn 4.8.0，构建过程运行维护器测试。它不会替代控制台本身的部署，也不会改变控制台的视频优先级。

Unraid 用户可以将同样的镜像、受限 UID/GID、环境变量和挂载填入 DockerMan 模板；应用只需要容器名与镜像配置，不要求 Compose。不要在运行容器中临时安装 daemon，也不要让新旧 cron 和守护器同时维护同一实例。

## 与 NPM / Certbot 配合

NPM 继续负责证书申请和续期，TURN 只读取它管理的这一张证书。网页可以直接走 Cloudflare Tunnel，证书维护与网页是否经过 NPM 是两件事。

Certbot 常用的目录结构为：

```text
live/CERT_NAME/fullchain.pem -> ../../archive/CERT_NAME/fullchainN.pem
live/CERT_NAME/privkey.pem   -> ../../archive/CERT_NAME/privkeyN.pem
```

应仅只读挂载这一张证书的两个目录，并在容器内保留符号链接布局：

| 宿主目录 | 容器目录 | 权限 |
| --- | --- | --- |
| `…/live/CERT_NAME` | `/cert-source/live/CERT_NAME` | 只读 |
| `…/archive/CERT_NAME` | `/cert-source/archive/CERT_NAME` | 只读 |

同时设置 `TURN_CERT_SOURCE=/cert-source/live/CERT_NAME`。使用通用 Compose 示例时，需要在自己的私有 Compose 文件中将单个证书挂载换成这两项，并覆盖 `TURN_CERT_SOURCE`；DockerMan 直接配置两项路径即可。`CERT_NAME` 是证书工具实际使用的目录名，不保证等于域名。

不要挂载整个 NPM appdata、全部证书目录或 `docker.sock`。应让运行 UID/GID 与该证书的读取权限兼容，不要把私钥改成所有人可读。维护器只读源文件，在自己的状态目录内写入缓存；不会修改 NPM 证书、续期任务或权限。

其他 ACME 工具也可导出完整证书对到独立目录。源更新短暂出现不匹配时，本轮检查失败并保留旧有效材料，下一轮会重试。续期完成后核对 `status`、服务实际 TLS 证书和新分配；仅检查文件更新不等于服务已使用新证书。

## 状态与临时诊断

以下命令在 TURN 容器内执行；也可使用 `docker exec YOUR_TURN_CONTAINER …` 或容器管理器终端：

```sh
python3 /opt/coturn-supervisor/supervisor.py status
python3 /opt/coturn-supervisor/supervisor.py diagnostics-on --minutes 20
python3 /opt/coturn-supervisor/supervisor.py diagnostics-off
```

状态包含子进程 PID、健康状态、证书有效期、公网 IP、检查错误和重启计数，不输出共享密钥或私钥。详细 coturn 日志可能包含客户端地址、短期用户名和会话信息；按私有审计材料管理，不提交 Git。

启用/关闭详细日志会中断现有 allocations；安排测试窗口。日志到期由容器内计时器处理，无须宿主任务。旧的过期请求文件可以保留，但状态里的 `diagnosticEnabled` 会变为 `false`。

## 环境变量

| 变量 | 默认值 / 要求 | 用途 |
| --- | --- | --- |
| `TURN_BASE_CONFIG` | `/etc/coturn/base.conf` | 只读基础配置，包括私有共享密钥与安全策略。 |
| `TURN_STATE_DIR` | `/var/lib/coturn-supervisor` | 私有可写状态目录，不能由多个实例共用。 |
| `TURN_CERT_SOURCE` | `/cert-source/live/site` | 源 `fullchain.pem` / `privkey.pem` 所在目录；Compose 示例覆盖为 `/cert-source`。 |
| `TURN_CERT_HOSTNAME` | 必填 | 服务证书校验名称。 |
| `TURN_PUBLIC_HOSTNAME` | 空 | 可选，动态公网 IPv4 的 DNS 来源。 |
| `TURN_PRIVATE_IP` | 空 | 开启公网地址维护时必填，用于 `external-ip=公网IP/本地IP`。 |
| `TURN_CERT_INTERVAL_SECONDS` | `60` | 证书检查间隔，1–86400 秒。 |
| `TURN_IP_INTERVAL_SECONDS` | `300` | 地址检查间隔，1–86400 秒；DNS 最长等待约 5 秒。 |
| `TURN_MIN_CERT_VALIDITY_SECONDS` | `86400` | 接受新证书所需剩余有效期，1–86400 秒。 |
| `TURN_CA_FILE` | 空 | 可选私有 CA 信任文件，默认使用系统信任库。不能用于绕过校验。 |
| `TURN_BINARY` | `/usr/bin/turnserver` | 镜像内程序路径。 |

## 防火墙与回环

公开 TLS 监听端口以及配置的 UDP relay 范围即可；TLS/TCP 并不代表 relay 对端之间只使用 TCP。将 UDP relay 端口一对一转发到相同本地端口，并保留私有对端限制。

端口转发应由网关的一份标准配置管理，避免再用脚本在根链抢先生成重复 DNAT/ACCEPT。LAN 浏览器访问公网 TURN 名称可能需要 TCP NAT reflection；同一 NAT 内两份公网 relay 候选互通时，还可能需要 UDP 反射和公网源地址转换。

OpenWrt fw3 的可选配置是 `reflection=1`、`reflection_src=external`、`reflection_zone=lan`，可参考[脱敏 UCI 示例](../examples/coturn/openwrt-fw3.uci.example)，但应先检查所用版本实际生成的规则，并验证双向传输。其他网关使用各自的 hairpin NAT / NAT loopback 设置，不要求 OpenWrt。透明 UDP 代理可能改变 TURN 出口或端口映射，必要时在代理自身的重建机制中添加最小绕行规则，不要再复制整套端口转发。

至少分开验证：LAN TLS 握手、独立公网 TLS、已鉴权 allocation、外部先发的 UDP relay、同一 Home TURN 的两份 allocation、网关规则重建后行为。NAT 计数只统计新连接首包，零计数不能单独证明规则无效；外部先发测试可避免仅验证到已有出站映射。

## 迁移与回滚

1. 备份原配置、证书、模板、镜像 ID、任务内容、文件权限和数据卷。
2. 在隔离实例验证新证书、热更新、旧会话保留、错误材料回退和日志 TTL。
3. 停用仅属于此实例的旧宿主任务，再按原容器管理方式部署新镜像。保留旧镜像和数据卷，不做全局清理。
4. 验证新实例的受限用户、只读根、证书与公网地址，以及真实双向 relay。不要仅依据健康检查判断公网可用。
5. 成功后归档旧维护脚本；失败恢复原模板/镜像及任务，先停新守护器，避免双重维护。回滚必须恢复旧证书挂载路径；新维护器的证书缓存不是旧实例的默认路径。

维护器单元测试和隔离 Docker 实测分别为：

```sh
python3 -m unittest discover -s infra/coturn-supervisor -p 'test_*.py'
COTURN_SUPERVISOR_IMAGE=YOUR_TEST_IMAGE node tests/coturn-supervisor-live.mjs
```

实测脚本使用本机隔离端口、临时 CA 和合成数据，不读取或操作安卓手机。它需要 Linux Docker 和已安装的项目 Node 依赖，不是完整公网验收。
