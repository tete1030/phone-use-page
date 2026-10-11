#!/usr/bin/env python3
"""Generate an artificial phone screen without any device or account data."""
import os
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

output = Path(sys.argv[1])
font_path = os.environ.get('WSS_DEMO_FONT')
if not font_path:
    font_path = next((str(p) for base in ['/usr/share/fonts', '/System/Library/Fonts', '/Library/Fonts']
                      for p in Path(base).rglob('*') if p.is_file() and
                      ('NotoSansCJK-Regular' in p.name or 'wqy-zenhei' in p.name or 'PingFang' in p.name)), None)
if not font_path:
    raise SystemExit('Set WSS_DEMO_FONT to a CJK TrueType/OpenType font file')
font = lambda size: ImageFont.truetype(font_path, size)
image = Image.new('RGB', (864, 1920), '#f5f6fa')
draw = ImageDraw.Draw(image)
draw.rectangle((0, 0, 864, 88), fill='white')
draw.text((38, 22), '09:41                 5G   Wi-Fi   100%', font=font(25), fill='#222222')
draw.text((40, 105), '设置与设备管理', font=font(42), fill='#222222')
draw.rounded_rectangle((28, 180, 836, 253), radius=16, fill='#e8ebf0')
draw.text((50, 193), '搜索设置 / Search settings', font=font(29), fill='#505b6c')
labels = ['无线网络 WLAN · 已连接', '蓝牙 Bluetooth · 未连接', '通知与控制中心 Notifications',
          '显示与亮度 Display settings', '隐私保护 Privacy controls', '应用管理 App management']
for i in range(18):
    y = 286 + i * 82
    draw.rectangle((24, y, 840, y + 76), fill='white')
    draw.text((45, y + 6), labels[i % len(labels)], font=font(27), fill='#151a26')
    draw.text((45, y + 43), '清晰文字测试 0123456789 / AaBbCc 账号与设备状态', font=font(19), fill='#606a79')
    draw.line((40, y + 76, 824, y + 76), fill='#dfe3e8', width=1)
image.save(output)
