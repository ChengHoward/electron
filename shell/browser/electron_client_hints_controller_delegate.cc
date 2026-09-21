// Copyright (c) 2026 ChengHoward.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/electron_client_hints_controller_delegate.h"

#include "components/embedder_support/user_agent_utils.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "services/network/public/cpp/is_potentially_trustworthy.h"
#include "third_party/blink/public/common/web_preferences/web_preferences.h"
#include "url/gurl.h"

namespace electron {

ElectronClientHintsControllerDelegate::ElectronClientHintsControllerDelegate() =
    default;

ElectronClientHintsControllerDelegate::
    ~ElectronClientHintsControllerDelegate() = default;

network::NetworkQualityTracker*
ElectronClientHintsControllerDelegate::GetNetworkQualityTracker() {
  return nullptr;
}

void ElectronClientHintsControllerDelegate::GetAllowedClientHintsFromSource(
    const url::Origin& origin,
    blink::EnabledClientHints* client_hints) {
  const GURL url = origin.GetURL();
  if (!url.is_valid() || !network::IsUrlPotentiallyTrustworthy(url))
    return;

  auto it = client_hints_map_.find(origin);
  if (it != client_hints_map_.end()) {
    for (const auto& type : it->second.GetEnabledHints())
      client_hints->SetIsEnabled(type, true);
  }

  for (auto hint : additional_hints_)
    client_hints->SetIsEnabled(hint, true);
}

bool ElectronClientHintsControllerDelegate::IsJavaScriptAllowed(
    const GURL& url,
    content::RenderFrameHost* parent_rfh) {
  if (!parent_rfh)
    return true;

  content::WebContents* web_contents =
      content::WebContents::FromRenderFrameHost(
          parent_rfh->GetOutermostMainFrame());
  if (!web_contents)
    return true;

  return web_contents->GetOrCreateWebPreferences().javascript_enabled;
}

blink::UserAgentMetadata
ElectronClientHintsControllerDelegate::GetUserAgentMetadata() {
  return embedder_support::GetUserAgentMetadata();
}

void ElectronClientHintsControllerDelegate::PersistClientHints(
    const url::Origin& primary_origin,
    content::RenderFrameHost* parent_rfh,
    const std::vector<network::mojom::WebClientHintsType>& client_hints) {
  const GURL primary_url = primary_origin.GetURL();
  if (!primary_url.is_valid() ||
      !network::IsUrlPotentiallyTrustworthy(primary_url)) {
    return;
  }
  if (!IsJavaScriptAllowed(primary_url, parent_rfh))
    return;
  if (client_hints.size() >
      (static_cast<size_t>(network::mojom::WebClientHintsType::kMaxValue) +
       1)) {
    return;
  }

  blink::EnabledClientHints enabled;
  for (const auto& type : client_hints)
    enabled.SetIsEnabled(type, true);
  client_hints_map_[primary_origin] = std::move(enabled);
}

void ElectronClientHintsControllerDelegate::SetAdditionalClientHints(
    const std::vector<network::mojom::WebClientHintsType>& hints) {
  additional_hints_ = hints;
}

void ElectronClientHintsControllerDelegate::ClearAdditionalClientHints() {
  additional_hints_.clear();
}

void ElectronClientHintsControllerDelegate::SetMostRecentMainFrameViewportSize(
    const gfx::Size& viewport_size) {
  viewport_size_ = viewport_size;
}

gfx::Size
ElectronClientHintsControllerDelegate::GetMostRecentMainFrameViewportSize() {
  return viewport_size_;
}

}  // namespace electron
