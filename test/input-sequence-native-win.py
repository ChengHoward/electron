"""Exercise the normal Windows message entry and sample browser UI pixels."""
import ctypes
import json
import sys
import time
from ctypes import wintypes

user = ctypes.WinDLL('user32', use_last_error=True)
gdi = ctypes.WinDLL('gdi32', use_last_error=True)
user.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user.GetDC.argtypes = [wintypes.HWND]
user.GetDC.restype = wintypes.HDC
user.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
gdi.GetPixel.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
gdi.GetPixel.restype = wintypes.DWORD
hwnd = int(sys.argv[2])
action = sys.argv[1]
scale = user.GetDpiForWindow(wintypes.HWND(hwnd)) / 96
if action in ('mouse', 'pixel'):
    x, y = (round(float(value) * scale) for value in sys.argv[3:5])
    if action == 'mouse':
        point = (y << 16) | (x & 65535)
        for message, key in [(0x200, 0), (0x201, 1), (0x202, 0)]:
            if not user.PostMessageW(hwnd, message, key, point):
                raise ctypes.WinError(ctypes.get_last_error())
    else:
        point = wintypes.POINT(x, y)
        user.ClientToScreen(wintypes.HWND(hwnd), ctypes.byref(point))
        dc = user.GetDC(None)
        try:
            color = gdi.GetPixel(dc, point.x, point.y)
            print(json.dumps({'rgb': [color & 255, (color >> 8) & 255, (color >> 16) & 255],
                              'x': point.x, 'y': point.y, 'scale': scale}))
        finally:
            user.ReleaseDC(None, dc)
elif action == 'key':
    for message, key, detail in [(0x100, 65, 1), (0x102, 97, 1), (0x101, 65, 0xC0000001)]:
        if not user.PostMessageW(hwnd, message, key, detail):
            raise ctypes.WinError(ctypes.get_last_error())
else:
    raise ValueError(action)
time.sleep(0.05)
