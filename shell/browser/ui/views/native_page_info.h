// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_UI_VIEWS_NATIVE_PAGE_INFO_H_
#define ELECTRON_SHELL_BROWSER_UI_VIEWS_NATIVE_PAGE_INFO_H_

#include <string_view>
#include "base/values.h"

namespace net {
class X509Certificate;
}

namespace electron {
// Read-only presentation data from Chromium's certificate model and resources.
base::DictValue NativePageInfoPresentation(net::X509Certificate* certificate,
                                           std::string_view security);
}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_UI_VIEWS_NATIVE_PAGE_INFO_H_
