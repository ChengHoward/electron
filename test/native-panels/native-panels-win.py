"""PID-restricted native panel input and independent Win32 observations."""
import base64
import ctypes
import json
import sys
import time
from ctypes import wintypes


user = ctypes.WinDLL('user32', use_last_error=True)
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
gdi = ctypes.WinDLL('gdi32', use_last_error=True)
imm = ctypes.WinDLL('imm32', use_last_error=True)
dwm = ctypes.WinDLL('dwmapi', use_last_error=True)
user.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
HWND = wintypes.HWND
user.GetWindowThreadProcessId.argtypes = [HWND, ctypes.POINTER(wintypes.DWORD)]
user.GetWindowThreadProcessId.restype = wintypes.DWORD
user.GetWindow.argtypes = [HWND, wintypes.UINT]
user.GetWindow.restype = HWND
user.GetWindowRect.argtypes = [HWND, ctypes.POINTER(wintypes.RECT)]
user.GetWindowTextW.argtypes = [HWND, wintypes.LPWSTR, ctypes.c_int]
user.GetClassNameW.argtypes = [HWND, wintypes.LPWSTR, ctypes.c_int]
user.GetDlgCtrlID.argtypes = [HWND]
user.SendMessageW.argtypes = [HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user.SendMessageW.restype = ctypes.c_ssize_t
user.GetForegroundWindow.restype = HWND
user.GetWindowLongW.argtypes = [HWND, ctypes.c_int]
user.SetForegroundWindow.argtypes = [HWND]
user.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
kernel.GetCurrentThreadId.restype = wintypes.DWORD
user.IsWindowVisible.argtypes = [HWND]
user.IsIconic.argtypes = [HWND]
user.WindowFromPoint.argtypes = [wintypes.POINT]
user.WindowFromPoint.restype = HWND
user.GetAncestor.argtypes = [HWND, wintypes.UINT]
user.GetAncestor.restype = HWND
user.GetDC.argtypes = [HWND]
user.GetDC.restype = wintypes.HDC
user.ReleaseDC.argtypes = [HWND, wintypes.HDC]
user.GetKeyboardLayoutList.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)]
user.GetKeyboardLayout.argtypes = [wintypes.DWORD]
user.GetKeyboardLayout.restype = ctypes.c_void_p
user.GetAsyncKeyState.argtypes = [ctypes.c_int]
user.GetAsyncKeyState.restype = wintypes.SHORT
user.MapVirtualKeyW.argtypes = [wintypes.UINT, wintypes.UINT]
user.MapVirtualKeyW.restype = wintypes.UINT
user.PostMessageW.argtypes = [HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
gdi.GetPixel.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
gdi.GetPixel.restype = wintypes.DWORD
imm.ImmGetContext.argtypes = [HWND]
imm.ImmGetContext.restype = wintypes.HANDLE
imm.ImmGetOpenStatus.argtypes = [wintypes.HANDLE]
imm.ImmSetOpenStatus.argtypes = [wintypes.HANDLE, wintypes.BOOL]
imm.ImmGetConversionStatus.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD)]
imm.ImmSetConversionStatus.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD]
imm.ImmReleaseContext.argtypes = [HWND, wintypes.HANDLE]
dwm.DwmGetWindowAttribute.argtypes = [HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
dwm.DwmGetWindowAttribute.restype = ctypes.c_long
dwm.DwmIsCompositionEnabled.argtypes = [ctypes.POINTER(wintypes.BOOL)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [('dx', wintypes.LONG), ('dy', wintypes.LONG),
                ('mouseData', wintypes.DWORD), ('dwFlags', wintypes.DWORD),
                ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.c_size_t)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [('wVk', wintypes.WORD), ('wScan', wintypes.WORD),
                ('dwFlags', wintypes.DWORD), ('time', wintypes.DWORD),
                ('dwExtraInfo', ctypes.c_size_t)]


class INPUTUNION(ctypes.Union):
    _fields_ = [('mi', MOUSEINPUT), ('ki', KEYBDINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ('data',)
    _fields_ = [('type', wintypes.DWORD), ('data', INPUTUNION)]


user.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]


def process_of(hwnd):
    found = wintypes.DWORD()
    user.GetWindowThreadProcessId(HWND(hwnd), ctypes.byref(found))
    return found.value


def allowed(hwnd, pid):
    if not hwnd or process_of(hwnd) not in allowed_pids:
        raise RuntimeError('Native target is not owned by the probe PID')


def activate(hwnd, pid):
    allowed(hwnd, pid)
    if (request['action'] in ('click', 'key', 'text', 'ime', 'layout', 'move')
            and not request.get('forceActivation', False)
            and process_of(user.GetForegroundWindow()) in allowed_pids):
        # Keep an already focused control or related native menu in this probe.
        # Re-activating the owner would cancel a transient combobox menu.
        return
    user.SetForegroundWindow(HWND(hwnd))
    time.sleep(0.045)
    if process_of(user.GetForegroundWindow()) not in allowed_pids:
        current_thread = kernel.GetCurrentThreadId()
        foreground_thread = user.GetWindowThreadProcessId(user.GetForegroundWindow(), None)
        target_thread = user.GetWindowThreadProcessId(HWND(hwnd), None)
        attached = []
        try:
            for thread in {foreground_thread, target_thread} - {0, current_thread}:
                if user.AttachThreadInput(current_thread, thread, True):
                    attached.append(thread)
            user.SetForegroundWindow(HWND(hwnd))
        finally:
            for thread in reversed(attached):
                user.AttachThreadInput(current_thread, thread, False)
        time.sleep(0.065)
    if process_of(user.GetForegroundWindow()) not in allowed_pids and request.get('activationPoint'):
        # A real click in this test panel's empty padding follows Windows'
        # foreground policy. It is not a replay of the requested control click.
        point = request['activationPoint']
        x, y = int(point['x']), int(point['y'])
        target = user.WindowFromPoint(wintypes.POINT(x, y))
        allowed(target, pid)
        if int(user.GetAncestor(target, 2) or 0) != hwnd:
            raise RuntimeError('Activation padding is not in the test panel')
        cursor = wintypes.POINT()
        user.GetCursorPos(ctypes.byref(cursor))
        user.SetCursorPos(x, y)
        packets = (INPUT * 2)(INPUT(type=0, mi=MOUSEINPUT(dwFlags=2)),
                              INPUT(type=0, mi=MOUSEINPUT(dwFlags=4)))
        if user.SendInput(2, packets, ctypes.sizeof(INPUT)) != 2:
            raise ctypes.WinError(ctypes.get_last_error())
        user.SetCursorPos(cursor.x, cursor.y)
        time.sleep(0.08)
    allowed(user.GetForegroundWindow(), pid)


def send(packet, pid):
    allowed(user.GetForegroundWindow(), pid)
    if user.SendInput(1, ctypes.byref(packet), ctypes.sizeof(INPUT)) != 1:
        raise ctypes.WinError(ctypes.get_last_error())


def key(vk, pid, up=False):
    # Navigation-cluster keys carry E0 on a physical keyboard. Without it,
    # Windows treats Shift+arrows as shifted keypad navigation and clears Shift.
    extended = vk in {0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28,
                      0x2d, 0x2e, 0x6f, 0x90, 0xa3, 0xa5}
    flags = (2 if up else 0) | (1 if extended else 0)
    send(INPUT(type=1, ki=KEYBDINPUT(wVk=vk, wScan=user.MapVirtualKeyW(vk, 0), dwFlags=flags)), pid)


def press(vk, pid):
    key(vk, pid)
    key(vk, pid, True)


def windows(pid):
    found = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, HWND, wintypes.LPARAM)

    @callback_type
    def callback(hwnd, _):
        if process_of(hwnd) in allowed_pids:
            rect = wintypes.RECT()
            user.GetWindowRect(hwnd, ctypes.byref(rect))
            title, name = ctypes.create_unicode_buffer(1024), ctypes.create_unicode_buffer(256)
            user.GetWindowTextW(hwnd, title, len(title))
            user.GetClassNameW(hwnd, name, len(name))
            found.append({'hwnd': int(hwnd), 'owner': int(user.GetWindow(hwnd, 4) or 0),
                          'title': title.value, 'class': name.value,
                          'visible': bool(user.IsWindowVisible(hwnd)),
                          'minimized': bool(user.IsIconic(hwnd)),
                          'style': int(user.GetWindowLongW(hwnd, -16)) & 0xffffffff,
                          'exstyle': int(user.GetWindowLongW(hwnd, -20)) & 0xffffffff,
                          'bounds': {'x': rect.left, 'y': rect.top,
                                     'width': rect.right - rect.left,
                                     'height': rect.bottom - rect.top}})
        return True

    user.EnumWindows(callback, 0)
    return found


def controls(hwnd, pid):
    allowed(hwnd, pid)
    found = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, HWND, wintypes.LPARAM)

    @callback_type
    def callback(child, _):
        allowed(child, pid)
        rect = wintypes.RECT()
        user.GetWindowRect(child, ctypes.byref(rect))
        title, name = ctypes.create_unicode_buffer(1024), ctypes.create_unicode_buffer(256)
        user.GetWindowTextW(child, title, len(title))
        user.GetClassNameW(child, name, len(name))
        entry = {'hwnd': int(child), 'id': user.GetDlgCtrlID(child),
                 'class': name.value, 'text': title.value,
                 'visible': bool(user.IsWindowVisible(child)),
                 'bounds': {'x': rect.left, 'y': rect.top,
                            'width': rect.right - rect.left,
                            'height': rect.bottom - rect.top}}
        if name.value == 'ComboBox':
            entry['selectedIndex'] = user.SendMessageW(child, 0x0147, 0, 0)
            count = user.SendMessageW(child, 0x0146, 0, 0)
            entry['items'] = []
            for index in range(min(max(count, 0), 100)):
                length = user.SendMessageW(child, 0x0149, index, 0)
                if 0 <= length <= 4096:
                    value = ctypes.create_unicode_buffer(length + 1)
                    user.SendMessageW(child, 0x0148, index, ctypes.addressof(value))
                    entry['items'].append(value.value)
        elif name.value == 'Edit':
            # GetWindowText cannot read another process's Edit contents. This
            # child has already passed the same PID guard as its dialog.
            value = ctypes.create_unicode_buffer(32769)
            user.SendMessageW(child, 0x000D, len(value), ctypes.addressof(value))
            entry['text'] = value.value
        found.append(entry)
        return True

    user.EnumChildWindows(HWND(hwnd), callback, 0)
    return found


request = json.loads(base64.b64decode(sys.argv[1]).decode('utf-8'))
text_interval_ms = request.get('textIntervalMs', 0)
if (not isinstance(text_interval_ms, int) or isinstance(text_interval_ms, bool)
        or not 0 <= text_interval_ms <= 50):
    raise ValueError('textIntervalMs must be an integer from 0 to 50')
if 'textIntervalMs' in request and request.get('action') != 'text':
    raise ValueError('textIntervalMs is only valid for text input')
pid = int(request['pid'])
allowed_pids = {pid, *map(int, request.get('allowedPids', []))}
action = request['action']
answer = {}
if action == 'windows':
    cursor = wintypes.POINT()
    user.GetCursorPos(ctypes.byref(cursor))
    answer = {'windows': windows(pid), 'foreground': int(user.GetForegroundWindow() or 0),
              'cursor': {'x': cursor.x, 'y': cursor.y},
              'imeLayouts': []}
    count = user.GetKeyboardLayoutList(0, None)
    layouts = (ctypes.c_void_p * count)()
    user.GetKeyboardLayoutList(count, layouts)
    answer['imeLayouts'] = [int(layout or 0) for layout in layouts]
elif action == 'controls':
    answer = {'controls': controls(int(request['hwnd']), pid)}
elif action == 'material':
    # Observe documented DWM state and accessibility/power policy. Never change
    # the user's transparency, contrast or power settings to manufacture a pass.
    import winreg

    hwnd = int(request['hwnd'])
    allowed(hwnd, pid)
    backdrop = ctypes.c_int(-1)
    hr = dwm.DwmGetWindowAttribute(HWND(hwnd), 38, ctypes.byref(backdrop), ctypes.sizeof(backdrop))
    composition = wintypes.BOOL()
    dwm.DwmIsCompositionEnabled(ctypes.byref(composition))

    class HIGHCONTRAST(ctypes.Structure):
        _fields_ = [('cbSize', wintypes.UINT), ('dwFlags', wintypes.DWORD), ('lpszDefaultScheme', wintypes.LPWSTR)]

    class SYSTEM_POWER_STATUS(ctypes.Structure):
        _fields_ = [('ACLineStatus', wintypes.BYTE), ('BatteryFlag', wintypes.BYTE),
                    ('BatteryLifePercent', wintypes.BYTE), ('SystemStatusFlag', wintypes.BYTE),
                    ('BatteryLifeTime', wintypes.DWORD), ('BatteryFullLifeTime', wintypes.DWORD)]

    contrast = HIGHCONTRAST(cbSize=ctypes.sizeof(HIGHCONTRAST))
    contrast_ok = bool(user.SystemParametersInfoW(0x0042, contrast.cbSize, ctypes.byref(contrast), 0))
    power = SYSTEM_POWER_STATUS()
    power_ok = bool(kernel.GetSystemPowerStatus(ctypes.byref(power)))
    transparency = True
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r'Software\Microsoft\Windows\CurrentVersion\Themes\Personalize') as settings:
            transparency = bool(winreg.QueryValueEx(settings, 'EnableTransparency')[0])
    except FileNotFoundError:
        pass
    answer = {'attribute': 38, 'hresult': hr, 'backdrop': backdrop.value,
              'composition': bool(composition), 'windowsBuild': sys.getwindowsversion().build,
              'transparencyEnabled': transparency,
              'highContrast': bool(contrast.dwFlags & 1) if contrast_ok else None,
              'energySaver': bool(power.SystemStatusFlag) if power_ok else None}
elif action == 'image-contrast':
    # Analyze only screenshots that the PID-restricted screenshot action saved.
    from PIL import Image, ImageStat

    answer = {'images': {}}
    for name, filename in request['images'].items():
        with Image.open(filename) as source:
            gray = source.convert('L')
            high = request['regions']['high']
            low = request['regions']['low']
            high_image = gray.crop((high['x'], high['y'], high['x'] + high['width'], high['y'] + high['height']))
            inset = max(2, low['width'] // 8)
            middle = low['x'] + low['width'] // 2
            left = gray.crop((low['x'] + inset, low['y'] + inset, middle - inset, low['y'] + low['height'] - inset))
            right = gray.crop((middle + inset, low['y'] + inset, low['x'] + low['width'] - inset, low['y'] + low['height'] - inset))
            answer['images'][name] = {'highDeviation': ImageStat.Stat(high_image).stddev[0],
                                      'lowContrast': abs(ImageStat.Stat(left).mean[0] - ImageStat.Stat(right).mean[0])}
elif action == 'restore':
    cursor = request.get('cursor')
    if cursor:
        user.SetCursorPos(int(cursor['x']), int(cursor['y']))
    if request.get('foreground'):
        user.SetForegroundWindow(HWND(int(request['foreground'])))
elif action == 'screenshot':
    bounds = request['bounds']
    x, y = int(bounds['x']), int(bounds['y'])
    width, height = int(bounds['width']), int(bounds['height'])
    points = [(x, y), (x + width - 1, y), (x, y + height - 1),
              (x + width - 1, y + height - 1), (x + width // 2, y + height // 2)]
    for px, py in points:
        allowed(user.WindowFromPoint(wintypes.POINT(px, py)), pid)
    center = user.WindowFromPoint(wintypes.POINT(*points[-1]))
    if int(user.GetAncestor(center, 2) or 0) != int(request['hwnd']):
        raise RuntimeError('The native panel is not the visible top-level capture target')
    from PIL import ImageGrab
    captured = ImageGrab.grab(bbox=(x, y, x + width, y + height),
                              include_layered_windows=True, all_screens=True)
    captured.save(request['path'])
    answer = {'path': request['path'], 'width': captured.width, 'height': captured.height}
elif action == 'pixels':
    points = request['points']
    if not isinstance(points, list) or not 1 <= len(points) <= 256:
        raise ValueError('Pixel observations require between 1 and 256 points')
    expected_root = int(request['hwnd'])
    dc = user.GetDC(None)
    try:
        values = []
        for point in points:
            x, y = int(point['x']), int(point['y'])
            hit = user.WindowFromPoint(wintypes.POINT(x, y))
            allowed(hit, pid)
            if int(user.GetAncestor(hit, 2) or 0) != expected_root:
                raise RuntimeError('Pixel sample is not inside the expected test window')
            color = gdi.GetPixel(dc, x, y)
            values.append({'x': x, 'y': y,
                           'rgb': [color & 255, (color >> 8) & 255, (color >> 16) & 255]})
        answer = {'pixels': values}
    finally:
        user.ReleaseDC(None, dc)
elif action in ('hit', 'pixel'):
    x, y = int(request['x']), int(request['y'])
    if action == 'hit':
        hwnd = user.WindowFromPoint(wintypes.POINT(x, y))
        answer = {'hwnd': int(hwnd or 0), 'root': int(user.GetAncestor(hwnd, 2) or 0),
                  'pid': process_of(hwnd)}
    else:
        allowed(user.WindowFromPoint(wintypes.POINT(x, y)), pid)
        dc = user.GetDC(None)
        try:
            color = gdi.GetPixel(dc, x, y)
            answer = {'rgb': [color & 255, (color >> 8) & 255, (color >> 16) & 255]}
        finally:
            user.ReleaseDC(None, dc)
else:
    hwnd = int(request['hwnd'])
    activate(hwnd, pid)
    if action in ('click', 'wheel', 'drag', 'move'):
        x, y = int(request['x']), int(request['y'])
        hit = user.WindowFromPoint(wintypes.POINT(x, y))
        allowed(hit, pid)
        cursor = wintypes.POINT()
        user.GetCursorPos(ctypes.byref(cursor))
        user.SetCursorPos(x, y)
        if action == 'click':
            send(INPUT(type=0, mi=MOUSEINPUT(dwFlags=2)), pid)
            send(INPUT(type=0, mi=MOUSEINPUT(dwFlags=4)), pid)
            # Let the target dispatch both events before moving the cursor away;
            # native menus also consult the current pointer during activation.
            time.sleep(0.06)
        elif action == 'wheel':
            send(INPUT(type=0, mi=MOUSEINPUT(mouseData=int(request.get('delta', -480)) & 0xffffffff,
                                            dwFlags=0x0800)), pid)
        elif action == 'drag':
            end = request['end']
            send(INPUT(type=0, mi=MOUSEINPUT(dwFlags=2)), pid)
            try:
                for step in range(1, 21):
                    px = round(x + (int(end['x']) - x) * step / 20)
                    py = round(y + (int(end['y']) - y) * step / 20)
                    allowed(user.WindowFromPoint(wintypes.POINT(px, py)), pid)
                    allowed(user.GetForegroundWindow(), pid)
                    user.SetCursorPos(px, py)
                    time.sleep(0.015)
            finally:
                send(INPUT(type=0, mi=MOUSEINPUT(dwFlags=4)), pid)
        if not request.get('keepCursor', False):
            user.SetCursorPos(cursor.x, cursor.y)
    elif action == 'text':
        text = request['text'].encode('utf-16-le')
        for offset in range(0, len(text), 2):
            code = int.from_bytes(text[offset:offset + 2], 'little')
            send(INPUT(type=1, ki=KEYBDINPUT(wScan=code, dwFlags=4)), pid)
            send(INPUT(type=1, ki=KEYBDINPUT(wScan=code, dwFlags=6)), pid)
            if text_interval_ms:
                time.sleep(text_interval_ms / 1000)
    elif action == 'key':
        modifiers = request.get('modifiers', [])
        answer['before'] = {name: bool(user.GetAsyncKeyState(vk) & 0x8000)
                            for name, vk in [('shift', 0x10), ('control', 0x11), ('alt', 0x12)]}
        repeat = request.get('repeat', 1)
        if not isinstance(repeat, int) or isinstance(repeat, bool) or not 1 <= repeat <= 200:
            raise ValueError('Key repeat must be an integer between 1 and 200')
        held = []
        try:
            for modifier in modifiers:
                key(int(modifier), pid)
                held.append(int(modifier))
            if modifiers:
                time.sleep(0.025)
            answer['held'] = {name: bool(user.GetAsyncKeyState(vk) & 0x8000)
                              for name, vk in [('shift', 0x10), ('control', 0x11), ('alt', 0x12)]}
            for index in range(repeat):
                press(int(request['vk']), pid)
                if index + 1 < repeat:
                    time.sleep(0.015)
        finally:
            for modifier in reversed(held):
                key(modifier, pid, True)
        answer.update({'vk': int(request['vk']), 'modifiers': modifiers, 'repeat': repeat,
                       'after': {name: bool(user.GetAsyncKeyState(vk) & 0x8000)
                                 for name, vk in [('shift', 0x10), ('control', 0x11), ('alt', 0x12)]}})
    elif action == 'ime':
        layout = int(request['layout'])
        thread = user.GetWindowThreadProcessId(HWND(hwnd), None)
        old_layout = user.GetKeyboardLayout(thread)
        user.PostMessageW(HWND(hwnd), 0x0050, 0, layout)
        time.sleep(0.3)
        context = imm.ImmGetContext(HWND(hwnd))
        if context:
            conversion, sentence = wintypes.DWORD(), wintypes.DWORD()
            imm.ImmGetConversionStatus(context, ctypes.byref(conversion), ctypes.byref(sentence))
            imm.ImmSetOpenStatus(context, True)
            imm.ImmSetConversionStatus(context, conversion.value | 1, sentence.value)
            answer['imeOpen'] = bool(imm.ImmGetOpenStatus(context))
            answer['conversion'] = conversion.value
            imm.ImmReleaseContext(HWND(hwnd), context)
        for character in request.get('keys', ''):
            press(ord(character.upper()), pid)
            time.sleep(0.08)
        answer.update({'oldLayout': int(old_layout or 0),
                       'activeLayout': int(user.GetKeyboardLayout(thread) or 0),
                       'hasImmContext': bool(context), 'foreground': int(user.GetForegroundWindow() or 0),
                       'keys': request.get('keys', '')})
    elif action == 'layout':
        user.PostMessageW(HWND(hwnd), 0x0050, 0, int(request['layout']))
    else:
        raise ValueError(action)
time.sleep(0.04)
print(json.dumps(answer, ensure_ascii=False))
