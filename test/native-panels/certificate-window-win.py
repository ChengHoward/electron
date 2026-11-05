"""Read-only, PID-restricted Win32 certificate-window observations."""
import base64
import ctypes
import json
import sys
from ctypes import wintypes


user = ctypes.WinDLL('user32', use_last_error=True)
user.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
HWND = wintypes.HWND
user.IsWindow.argtypes = [HWND]
user.IsWindow.restype = wintypes.BOOL
user.GetWindowThreadProcessId.argtypes = [HWND, ctypes.POINTER(wintypes.DWORD)]
user.GetWindowThreadProcessId.restype = wintypes.DWORD
user.GetParent.argtypes = [HWND]
user.GetParent.restype = HWND
user.GetWindow.argtypes = [HWND, wintypes.UINT]
user.GetWindow.restype = HWND
user.GetAncestor.argtypes = [HWND, wintypes.UINT]
user.GetAncestor.restype = HWND
user.GetDesktopWindow.restype = HWND
user.GetForegroundWindow.restype = HWND
user.GetWindowRect.argtypes = [HWND, ctypes.POINTER(wintypes.RECT)]
user.GetWindowRect.restype = wintypes.BOOL
user.GetClientRect.argtypes = [HWND, ctypes.POINTER(wintypes.RECT)]
user.ClientToScreen.argtypes = [HWND, ctypes.POINTER(wintypes.POINT)]
user.GetWindowLongW.argtypes = [HWND, ctypes.c_int]
user.GetWindowLongW.restype = wintypes.LONG
user.IsWindowEnabled.argtypes = [HWND]
user.IsWindowEnabled.restype = wintypes.BOOL
user.IsWindowVisible.argtypes = [HWND]
user.IsWindowVisible.restype = wintypes.BOOL
user.IsIconic.argtypes = [HWND]
user.IsIconic.restype = wintypes.BOOL
user.GetDpiForWindow.argtypes = [HWND]
user.GetDpiForWindow.restype = wintypes.UINT
user.GetWindowTextW.argtypes = [HWND, wintypes.LPWSTR, ctypes.c_int]
user.GetClassNameW.argtypes = [HWND, wintypes.LPWSTR, ctypes.c_int]
user.SendMessageTimeoutW.argtypes = [HWND, wintypes.UINT, wintypes.WPARAM,
                                   wintypes.LPARAM, wintypes.UINT, wintypes.UINT,
                                   ctypes.POINTER(ctypes.c_size_t)]
user.SendMessageTimeoutW.restype = ctypes.c_ssize_t


def process_of(hwnd):
    pid = wintypes.DWORD()
    user.GetWindowThreadProcessId(HWND(hwnd), ctypes.byref(pid))
    return pid.value


def before_in_z_order(first, second):
    current = HWND(second)
    for _ in range(4096):
        current = user.GetWindow(current, 3)  # GW_HWNDPREV
        if not current:
            return False
        if int(current) == first:
            return True
    raise RuntimeError('Window z-order traversal did not terminate')


def state(hwnd, pid):
    if not user.IsWindow(HWND(hwnd)):
        return {'hwnd': hwnd, 'exists': False}
    if process_of(hwnd) != pid:
        raise RuntimeError('Native target is not owned by the probe PID')
    rect = wintypes.RECT()
    if not user.GetWindowRect(HWND(hwnd), ctypes.byref(rect)):
        raise ctypes.WinError(ctypes.get_last_error())
    title = ctypes.create_unicode_buffer(1024)
    name = ctypes.create_unicode_buffer(256)
    user.GetWindowTextW(HWND(hwnd), title, len(title))
    user.GetClassNameW(HWND(hwnd), name, len(name))
    dpi = user.GetDpiForWindow(HWND(hwnd)) or 96
    caption = None
    caption_candidates = []
    # Read HTCAPTION from the real native hit-test, including Chromium's
    # custom frame and Electron CSS app-region titles. No synthetic move loop.
    for offset_x in (36, 60, 90, 140):
        for offset_y in (12, 18, 24, 30, 36):
            x = rect.left + round(offset_x * dpi / 96)
            y = rect.top + round(offset_y * dpi / 96)
            if x >= rect.right or y >= rect.bottom:
                continue
            result = ctypes.c_size_t()
            packed = (x & 0xffff) | ((y & 0xffff) << 16)
            received = user.SendMessageTimeoutW(
                HWND(hwnd), 0x0084, 0, packed, 0x0003, 250,
                ctypes.byref(result))
            caption_candidates.append({'x': x, 'y': y,
                                       'received': bool(received),
                                       'hitTest': ctypes.c_ssize_t(result.value).value})
            if received and result.value == 2:  # WM_NCHITTEST / HTCAPTION
                caption = {'x': x, 'y': y, 'hitTest': 2}
                break
        if caption:
            break
    owner = int(user.GetWindow(HWND(hwnd), 4) or 0)
    foreground = int(user.GetForegroundWindow() or 0)
    client = wintypes.RECT()
    user.GetClientRect(HWND(hwnd), ctypes.byref(client))
    client_origin = wintypes.POINT()
    user.ClientToScreen(HWND(hwnd), ctypes.byref(client_origin))
    return {
        'hwnd': hwnd, 'exists': True, 'pid': pid, 'title': title.value,
        'class': name.value, 'parent': int(user.GetParent(HWND(hwnd)) or 0),
        'owner': owner, 'ancestorParent': int(user.GetAncestor(HWND(hwnd), 1) or 0),
        'desktop': int(user.GetDesktopWindow() or 0),
        'style': int(user.GetWindowLongW(HWND(hwnd), -16)) & 0xffffffff,
        'exstyle': int(user.GetWindowLongW(HWND(hwnd), -20)) & 0xffffffff,
        'child': bool(user.GetWindowLongW(HWND(hwnd), -16) & 0x40000000),
        'enabled': bool(user.IsWindowEnabled(HWND(hwnd))),
        'visible': bool(user.IsWindowVisible(HWND(hwnd))),
        'minimized': bool(user.IsIconic(HWND(hwnd))), 'dpi': dpi,
        'bounds': {'x': rect.left, 'y': rect.top,
                   'width': rect.right - rect.left, 'height': rect.bottom - rect.top},
        'clientBounds': {'x': client_origin.x, 'y': client_origin.y,
                         'width': client.right - client.left,
                         'height': client.bottom - client.top},
        'captionPoint': caption, 'captionCandidates': caption_candidates,
        'aboveOwner': before_in_z_order(hwnd, owner) if owner else None,
        'foreground': foreground, 'foregroundPid': process_of(foreground),
    }


request = json.loads(base64.b64decode(sys.argv[1]).decode('utf-8'))
if request.get('action') != 'state':
    raise ValueError('Only read-only window state is supported')
print(json.dumps(state(int(request['hwnd']), int(request['pid']))))
