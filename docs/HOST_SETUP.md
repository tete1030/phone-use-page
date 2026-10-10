# 主机与 ADB 配置

控制台主机必须实际连接到手机。浏览器、反向代理或 TURN 主机不必与它同机，但在远程服务器上启动程序，不会自动获得另一台电脑的 USB 设备。网络方案另见[部署场景与配置示例](DEPLOYMENT_SCENARIOS.md)。

## 工具和运行方式

| 运行方式 | 主机需要准备 | 说明 |
| --- | --- | --- |
| Linux/macOS 原生 | Git、Node.js 22.12+、Python 3.11+、venv/pip、ADB；可选 FFmpeg/uv | Node/Python 在主机运行；macOS 通常无需 udev |
| Linux USB Docker | Git、Python 3、Docker Engine/Compose 插件、USB 权限；建议先用主机 ADB 授权 | Node/Python/FFmpeg 在镜像中；主机网络和 `/dev/bus/usb` 不能照搬到 Docker Desktop |
| Windows/虚拟机 | 能访问真实设备的受支持环境 | 当前没有原生 Windows 安装脚本；Linux VM 必须确认 USB 透传后再使用对应方案 |

ADB 可以从 [Google Platform Tools](https://developer.android.com/tools/releases/platform-tools)获取，或按自己的发行版安装。以下只是包管理器示例，不要求使用这些工具：

```sh
# Debian/Ubuntu 类发行版；Node 和 Python 版本仍需分别核对
sudo apt install adb git python3 python3-venv python3-pip ffmpeg

# macOS，已选择 Homebrew 时
brew install --cask android-platform-tools
brew install ffmpeg
```

发行版包可能低于项目要求，不能只因安装命令成功就认定版本合适。原生启动前核对：

```sh
node --version
python3 --version
adb version
```

Node/Python 可用自己选择的安装或版本管理方式；安装脚本支持可选 `uv`，没有它时使用 venv/pip。路径不是默认值时设置 `ADB_PATH`、`PYTHON_PATH`、`SETUP_PYTHON` 或 `FFMPEG_PATH`，区别见[配置参考](CONFIGURATION.md)。

## 手机授权与设备选择

1. 按手机厂商说明打开开发者选项及 USB 调试；使用数据线连接，解锁后确认电脑 RSA 指纹。
2. 在预期运行用户下检查设备：

   ```sh
   adb start-server
   adb devices -l
   ```

3. 目标必须为 `device`。`unauthorized` 要在手机确认授权；`offline` 检查连接/设备状态；`no permissions` 检查系统权限。
4. 多台已授权设备时，设置自己的 `ANDROID_SERIAL`；不要复制别人配置中的序列号。也可显式设置以便设备暂未连接时启动。
5. 先确认可以读取手机状态，再测试控制。部分厂商/企业设备会限制事件注入、截屏、UI Automator 或电源设置；没有一个跨所有厂商的统一安全设置路径。

应用本身不要求 root/解锁 Bootloader，也不校验 SIM 或厂商账号。厂商可能对额外调试权限设置账号等前置条件，应按该设备政策处理，不能承诺所有机型的赋权流程相同。本应用不会绕过密码锁或企业管控。

## Linux USB 权限与容器用户

先检查已有发行版安卓规则。需要自行添加时，确认 **USB 厂商 ID、USB 序列号及实际访问组**，不要假定厂商 ID、`plugdev`、GID 46 或 UID 1000。

```sh
lsusb
# 将 BUS/DEVICE 换成 lsusb 对应总线和设备编号
udevadm info --attribute-walk --name=/dev/bus/usb/BUS/DEVICE
ls -ln /dev/bus/usb/BUS/DEVICE
id -u
id -g
id -gn
```

确认值后，可让当前主组访问指定手机：

```sh
ANDROID_USB_GROUP="$(id -gn)" sh scripts/install-usb-rule.sh DEVICE_SERIAL USB_VENDOR_ID
```

这里 `DEVICE_SERIAL` 是该 USB 设备的序列号，`USB_VENDOR_ID` 是四位十六进制值；无线 ADB 标识不适用于 USB 规则。脚本会备份同名旧规则、安装窄范围规则并重载 udev。若使用其他组，显式替换组名；改变组成员关系后可能要重新登录。无 sudo/udev 的系统应按其权限机制配置，而不是盲目运行脚本。

Docker 需要额外核对：

- `CONSOLE_UID/GID` 为实际运行用户；新建 compose.env 时准备脚本会按调用用户填写。
- `ANDROID_USB_GID` 为规则实际授予访问的组 ID。总线编号、设备编号和 USB 次设备号都不是 GID。
- `/dev/bus/usb` 挂载及 USB 设备 cgroup 规则可用；不要用 `privileged: true` 代替正确权限。
- 私有密码、状态及 home 挂载归属正确；密钥权限 `0600` 仍需允许运行用户读取。
- SELinux/AppArmor 等额外访问控制可能影响挂载；按主机策略处理，不能仅凭传统文件权限判断。

## ADB 密钥与服务归属

主机 ADB 的私钥一般位于运行用户 `.android/adbkey`，应保持私有。容器 home 使用单独私有目录；准备脚本仅在目标密钥不存在时复制源密钥。没有源密钥时，容器会使用自己的密钥，此时需重新确认手机上的授权。

Node 视频客户端、ADB 命令和 Python 桥接当前共用控制台主机上的回环 TCP 5037 ADB 服务。不要将它公开到互联网。主机网络容器可能与已运行的主机 ADB 服务共用该端口；确认实际服务用户和手机批准的是哪把密钥，避免同时启动不同用户的竞争服务。

虚拟机需要先把手机交给虚拟机；宿主机看到设备，不代表来宾或容器也看到设备。重启后应确认密钥和状态挂载仍在，避免反复产生新授权。

## 可选无线 ADB

源代码接受本地 ADB 服务中的无线设备标识，但公开验证记录未覆盖所有无线设备/安卓版本。Android 11+ 如支持原生无线调试，可按手机显示的地址/端口操作：

```sh
adb pair PHONE_IP:PAIR_PORT
adb connect PHONE_IP:DEBUG_PORT
adb devices -l
```

配对码交互输入，配对端口与调试端口可能不同。选择 `adb devices` 实际显示的标识，不假定固定 5555。只在可信网络中使用，连接成功后再验证视频、UI 树和控制；USB Compose 示例仍包含 USB 挂载，不是独立的无线 Docker 配方。

## 从操作系统到应用的验收顺序

1. 工具版本符合要求，运行用户和 USB/网络设备访问正确。
2. `adb devices -l` 显示目标为 `device`；密钥已授权，设备可读取。
3. localhost 登录后出现真实视频帧和可用 UI 树。自绘/受保护应用可能只提供部分能力。
4. 无害点击/导航可用；普通非密码字段用真实 HTML 输入框或 `setText` 验证 Unicode 回读。原始硬件按键仍可能经过 IME，不承诺按字面上屏。
5. 验证保持亮屏及恢复原设置。该能力依赖设备策略和 USB/交流电供电。
6. 最后配置公网入口和所选视频中继，并从实际客户端网络重新验证。

低配主机可先关闭 WSS FFmpeg 二次编码、降低采集 FPS，观察 CPU/帧新鲜度和文字可读性。Compose 的内存限制不是性能保证，ARM/其他平台的镜像和依赖也需单独确认。
