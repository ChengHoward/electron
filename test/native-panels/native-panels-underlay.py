"""A disposable native test window in a separate process; no replayed input."""
import ctypes
import json
import os
import queue
import sys
import threading
from ctypes import wintypes


user = ctypes.WinDLL('user32', use_last_error=True)
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
gdi = ctypes.WinDLL('gdi32', use_last_error=True)
user.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
LRESULT = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)


class WNDCLASS(ctypes.Structure):
    _fields_ = [('style', wintypes.UINT), ('lpfnWndProc', WNDPROC),
                ('cbClsExtra', ctypes.c_int), ('cbWndExtra', ctypes.c_int),
                ('hInstance', wintypes.HINSTANCE), ('hIcon', wintypes.HICON),
                ('hCursor', wintypes.HANDLE), ('hbrBackground', wintypes.HBRUSH),
                ('lpszMenuName', wintypes.LPCWSTR), ('lpszClassName', wintypes.LPCWSTR)]


user.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user.DefWindowProcW.restype = LRESULT
user.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR,
                               wintypes.DWORD, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                               ctypes.c_int, wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE,
                               wintypes.LPVOID]
user.CreateWindowExW.restype = wintypes.HWND
user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                             ctypes.c_int, ctypes.c_int, wintypes.UINT]
user.DestroyWindow.argtypes = [wintypes.HWND]
kernel.GetModuleHandleW.restype = wintypes.HMODULE
gdi.CreateSolidBrush.argtypes = [wintypes.DWORD]
gdi.CreateSolidBrush.restype = wintypes.HBRUSH
gdi.DeleteObject.argtypes = [wintypes.HANDLE]
commands = queue.SimpleQueue()
clicks = 0
click_points = []


def respond(value):
    print(json.dumps(value), flush=True)


@WNDPROC
def procedure(hwnd, message, wparam, lparam):
    global clicks
    if message == 0x0201:
        clicks += 1
        click_points.append({'x': ctypes.c_short(lparam & 0xffff).value,
                             'y': ctypes.c_short((lparam >> 16) & 0xffff).value})
        return 0
    if message == 0x0021:
        return 3  # MA_NOACTIVATE: test clicks never take foreground ownership.
    if message == 0x8001:
        request = commands.get()
        if request['action'] == 'show':
            bounds = request['bounds']
            user.SetWindowPos(hwnd, None, bounds['x'], bounds['y'], bounds['width'], bounds['height'], 0x0050)
        answer = {'id': request['id'], 'pid': os.getpid(), 'hwnd': int(hwnd),
                  'clicks': clicks, 'points': click_points}
        respond(answer)
        if request['action'] == 'stop':
            user.DestroyWindow(hwnd)
        return 0
    if message == 0x0002:
        user.PostQuitMessage(0)
        return 0
    return user.DefWindowProcW(hwnd, message, wparam, lparam)


instance = kernel.GetModuleHandleW(None)
brush = gdi.CreateSolidBrush(40 | (160 << 8) | (80 << 16))
class_name = f'ElectronNativePanelUnderlay{os.getpid()}'
window_class = WNDCLASS(lpfnWndProc=procedure, hInstance=instance,
                        hbrBackground=brush, lpszClassName=class_name)
if not user.RegisterClassW(ctypes.byref(window_class)):
    raise ctypes.WinError(ctypes.get_last_error())
hwnd = user.CreateWindowExW(0x08000080, class_name, 'Native panel cross-process test underlay',
                            0x80000000, 0, 0, 1, 1, None, None, instance, None)
if not hwnd:
    raise ctypes.WinError(ctypes.get_last_error())


def reader():
    for line in sys.stdin:
        commands.put(json.loads(line))
        user.PostMessageW(hwnd, 0x8001, 0, 0)
    user.PostMessageW(hwnd, 0x0010, 0, 0)


threading.Thread(target=reader, daemon=True).start()
respond({'ready': True, 'pid': os.getpid(), 'hwnd': int(hwnd)})
message = wintypes.MSG()
while user.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
    user.TranslateMessage(ctypes.byref(message))
    user.DispatchMessageW(ctypes.byref(message))
gdi.DeleteObject(brush)
