// Copyright (c) 2026 CloudBypass.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/net/navigation_response_override_registry.h"

#include "base/no_destructor.h"
#include "content/public/browser/web_contents.h"

namespace electron {

NavigationResponseOverrideRegistry::NavigationResponseOverrideRegistry() =
    default;

NavigationResponseOverrideRegistry::~NavigationResponseOverrideRegistry() =
    default;

// static
NavigationResponseOverrideRegistry*
NavigationResponseOverrideRegistry::Get() {
  static base::NoDestructor<NavigationResponseOverrideRegistry> instance;
  return instance.get();
}

// static
GURL NavigationResponseOverrideRegistry::StripRef(const GURL& url) {
  if (!url.has_ref())
    return url;
  GURL::Replacements replacements;
  replacements.ClearRef();
  return url.ReplaceComponents(replacements);
}

void NavigationResponseOverrideRegistry::Register(
    content::WebContents* web_contents,
    NavigationResponseOverride override_data) {
  DCHECK(web_contents);
  override_data.url = StripRef(override_data.url);
  base::AutoLock lock(lock_);
  pending_[web_contents] = std::move(override_data);
}

void NavigationResponseOverrideRegistry::Unregister(
    content::WebContents* web_contents) {
  if (!web_contents)
    return;
  base::AutoLock lock(lock_);
  pending_.erase(web_contents);
}

std::optional<NavigationResponseOverride>
NavigationResponseOverrideRegistry::TryTake(
    content::WebContents* web_contents,
    const GURL& request_url) {
  if (!web_contents)
    return std::nullopt;

  const GURL stripped = StripRef(request_url);
  base::AutoLock lock(lock_);
  auto it = pending_.find(web_contents);
  if (it == pending_.end())
    return std::nullopt;
  if (it->second.url != stripped)
    return std::nullopt;

  NavigationResponseOverride result = std::move(it->second);
  pending_.erase(it);
  return result;
}

}  // namespace electron
