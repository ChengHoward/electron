"""Read the current Windows input tick and cursor without hooks or input injection."""

import ctypes
import json
import sys
from ctypes import wintypes


class LastInputInfo(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


def snapshot():
    if sys.platform != "win32":
        raise RuntimeError("This read-only input snapshot requires Windows")

    user = ctypes.WinDLL("user32", use_last_error=True)
    user.GetLastInputInfo.argtypes = [ctypes.POINTER(LastInputInfo)]
    user.GetLastInputInfo.restype = wintypes.BOOL
    user.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
    user.GetCursorPos.restype = wintypes.BOOL

    def last_input_tick():
        info = LastInputInfo()
        info.cbSize = ctypes.sizeof(info)
        if not user.GetLastInputInfo(ctypes.byref(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        return info.dwTime

    before = last_input_tick()
    point = wintypes.POINT()
    if not user.GetCursorPos(ctypes.byref(point)):
        raise ctypes.WinError(ctypes.get_last_error())
    after = last_input_tick()
    return {
        "lastInputTick": after,
        "lastInputTickBeforeCursor": before,
        "cursor": {"x": point.x, "y": point.y},
        "coherentSnapshot": before == after,
        "coordinateSpace": "GetCursorPos",
    }


if __name__ == "__main__":
    print(json.dumps(snapshot()))
