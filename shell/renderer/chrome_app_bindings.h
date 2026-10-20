// Copyright (c) 2026 cloudbypass.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_RENDERER_CHROME_APP_BINDINGS_H_
#define ELECTRON_SHELL_RENDERER_CHROME_APP_BINDINGS_H_

#include "v8/include/v8-forward.h"

namespace electron {

// Installs the ordinary-webpage chrome.app surface onto window.chrome:
// isInstalled is false and ignores assignment, getDetails() is null,
// getIsInstalled() is false, runningState() is "cannot_run", and
// installState(cb) asynchronously calls cb("not_installed").
// Skips the install when chrome.app is already an object.
void InstallChromeApp(v8::Local<v8::Context> context);

}  // namespace electron

#endif  // ELECTRON_SHELL_RENDERER_CHROME_APP_BINDINGS_H_
