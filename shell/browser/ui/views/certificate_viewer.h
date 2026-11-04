// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.
#ifndef ELECTRON_SHELL_BROWSER_UI_VIEWS_CERTIFICATE_VIEWER_H_
#define ELECTRON_SHELL_BROWSER_UI_VIEWS_CERTIFICATE_VIEWER_H_

#include <memory>
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"

namespace content {
class WebContents;
class WebUI;
class WebUIController;
}  // namespace content
namespace net {
class X509Certificate;
}
namespace views {
class Widget;
}
namespace electron {
struct CertificateViewerHandle {
  base::WeakPtr<views::Widget> widget;
  base::WeakPtr<content::WebContents> contents;
};
CertificateViewerHandle ShowCertificateViewer(content::WebContents* source,
                                              views::Widget* parent,
                                              net::X509Certificate* certificate,
                                              base::OnceClosure closed);
void InspectCertificateViewer(const CertificateViewerHandle& handle,
                              base::OnceCallback<void(base::Value)> callback);
std::unique_ptr<content::WebUIController> CreateCertificateViewerUI(
    content::WebUI* web_ui);
bool IsCertificateViewer(content::WebContents* contents);
}  // namespace electron
#endif  // ELECTRON_SHELL_BROWSER_UI_VIEWS_CERTIFICATE_VIEWER_H_
