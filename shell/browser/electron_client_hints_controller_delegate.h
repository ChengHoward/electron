// Copyright (c) 2026 ChengHoward.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_ELECTRON_CLIENT_HINTS_CONTROLLER_DELEGATE_H_
#define ELECTRON_SHELL_BROWSER_ELECTRON_CLIENT_HINTS_CONTROLLER_DELEGATE_H_

#include <map>
#include <vector>

#include "content/public/browser/client_hints_controller_delegate.h"
#include "services/network/public/mojom/web_client_hints_types.mojom.h"
#include "third_party/blink/public/common/client_hints/enabled_client_hints.h"
#include "third_party/blink/public/common/user_agent/user_agent_metadata.h"
#include "ui/gfx/geometry/size.h"
#include "url/origin.h"

class GURL;

namespace network {
class NetworkQualityTracker;
}  // namespace network

namespace electron {

// Minimal ClientHintsControllerDelegate so navigations attach low-entropy
// Sec-CH-UA* headers. Without this, BrowserContext returns nullptr and
// Chromium skips AddNavigationRequestClientHintsHeaders entirely.
//
// High-entropy hints persist in-memory per origin for the lifetime of the
// BrowserContext (Accept-CH / Critical-CH). UA brand values for overridden
// navigations come from WebContents::GetUserAgentOverride().ua_metadata_override
// (set via setUserAgent({ userAgentMetadata })).
class ElectronClientHintsControllerDelegate
    : public content::ClientHintsControllerDelegate {
 public:
  ElectronClientHintsControllerDelegate();
  ~ElectronClientHintsControllerDelegate() override;

  ElectronClientHintsControllerDelegate(
      const ElectronClientHintsControllerDelegate&) = delete;
  ElectronClientHintsControllerDelegate& operator=(
      const ElectronClientHintsControllerDelegate&) = delete;

  network::NetworkQualityTracker* GetNetworkQualityTracker() override;

  void GetAllowedClientHintsFromSource(
      const url::Origin& origin,
      blink::EnabledClientHints* client_hints) override;

  bool IsJavaScriptAllowed(const GURL& url,
                           content::RenderFrameHost* parent_rfh) override;

  blink::UserAgentMetadata GetUserAgentMetadata() override;

  void PersistClientHints(
      const url::Origin& primary_origin,
      content::RenderFrameHost* parent_rfh,
      const std::vector<network::mojom::WebClientHintsType>& client_hints)
      override;

  void SetAdditionalClientHints(
      const std::vector<network::mojom::WebClientHintsType>& hints) override;

  void ClearAdditionalClientHints() override;

  void SetMostRecentMainFrameViewportSize(
      const gfx::Size& viewport_size) override;

  gfx::Size GetMostRecentMainFrameViewportSize() override;

 private:
  std::map<url::Origin, blink::EnabledClientHints> client_hints_map_;
  std::vector<network::mojom::WebClientHintsType> additional_hints_;
  gfx::Size viewport_size_;
};

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_ELECTRON_CLIENT_HINTS_CONTROLLER_DELEGATE_H_
