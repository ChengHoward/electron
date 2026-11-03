"""Record foreground activation of the test Electron process, not user activity."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import sys

target_pid = int(sys.argv[1])
destination = Path(sys.argv[2])
events = []
user32 = ctypes.WinDLL('user32', use_last_error=True)
callback_type = ctypes.WINFUNCTYPE(None, wintypes.HANDLE, wintypes.DWORD,
                                 wintypes.HWND, wintypes.LONG, wintypes.LONG,
                                 wintypes.DWORD, wintypes.DWORD)
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.SetWinEventHook.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.HMODULE,
                                callback_type, wintypes.DWORD, wintypes.DWORD,
                                wintypes.DWORD]
user32.SetWinEventHook.restype = wintypes.HANDLE
user32.UnhookWinEvent.argtypes = [wintypes.HANDLE]


def save():
    temporary = destination.with_suffix('.tmp')
    temporary.write_text(json.dumps({'ready': True, 'activations': events}), encoding='utf-8')
    os.replace(temporary, destination)


@callback_type
def on_foreground(hook, event, hwnd, object_id, child_id, thread_id, timestamp):
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if pid.value == target_pid:
        events.append({'window': int(hwnd), 'timestamp': timestamp})
        save()


hook = user32.SetWinEventHook(3, 3, None, on_foreground, 0, 0, 0)
if not hook:
    raise ctypes.WinError(ctypes.get_last_error())
save()
try:
    message = wintypes.MSG()
    while user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
        user32.TranslateMessage(ctypes.byref(message))
        user32.DispatchMessageW(ctypes.byref(message))
finally:
    user32.UnhookWinEvent(hook)
