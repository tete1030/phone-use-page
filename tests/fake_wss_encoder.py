#!/usr/bin/env python3
"""Emit local RTP, including one lost packet, without FFmpeg or a device."""
import socket
import struct
import sys
import time
from urllib.parse import urlparse

target = ('127.0.0.1', urlparse(sys.argv[-1]).port)
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
    for sequence, nal, marker in [(65533, 7, False), (65534, 8, False), (65535, 5, True),
                                  (0, 1, True), (2, 1, True), (3, 1, True), (4, 5, True), (5, 1, True)]:
        header = struct.pack('!BBHII', 0x80, 96 | (128 if marker else 0), sequence, 0, 123)
        udp.sendto(header + bytes([0x60 | nal, 0x11]), target)
        time.sleep(0.015)
    sys.stdin.buffer.read()
