#!/bin/sh
set -eu
serial=${1:-${ANDROID_SERIAL:-}}
vendor=${2:-${ANDROID_USB_VENDOR_ID:-}}
usb_group=${ANDROID_USB_GROUP:-plugdev}
if [ -z "$serial" ] || [ -z "$vendor" ]; then
  echo 'Usage: sh scripts/install-usb-rule.sh DEVICE_SERIAL USB_VENDOR_ID' >&2
  exit 1
fi
case "$serial" in *[!A-Za-z0-9_.:-]*) echo 'Invalid USB serial' >&2; exit 1;; esac
case "$vendor" in *[!0-9a-fA-F]*) echo 'USB vendor ID must be four hex digits' >&2; exit 1;; esac
[ "${#vendor}" = 4 ] || { echo 'USB vendor ID must be four hex digits' >&2; exit 1; }
case "$usb_group" in *[!A-Za-z0-9_-]*) echo 'Invalid USB group' >&2; exit 1;; esac
command -v udevadm >/dev/null || { echo 'This helper requires Linux udev' >&2; exit 1; }
getent group "$usb_group" >/dev/null || { echo 'Create or select the USB access group first' >&2; exit 1; }
umask 077
rule=$(mktemp)
trap 'rm -f "$rule"' EXIT HUP INT TERM
printf 'SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="%s", ATTR{serial}=="%s", GROUP="%s", MODE="0660", TAG+="uaccess"\n' "$vendor" "$serial" "$usb_group" > "$rule"
target=/etc/udev/rules.d/71-phone-use-page.rules
if [ -f "$target" ]; then
  sudo cp -p "$target" "$target.backup-$(date +%Y%m%d-%H%M%S)"
fi
sudo install -m 0644 "$rule" "$target"
sudo udevadm control --reload-rules
sudo udevadm trigger --action=change --subsystem-match=usb --attr-match="serial=$serial"
echo 'The device-specific USB rule is installed. Reconnect the phone if ADB still reports no permissions.'
