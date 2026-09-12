// Copyright (c) 2026 CloudBypass.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_NET_NAVIGATION_RESPONSE_OVERRIDE_REGISTRY_H_
#define ELECTRON_SHELL_BROWSER_NET_NAVIGATION_RESPONSE_OVERRIDE_REGISTRY_H_

#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "base/synchronization/lock.h"
#include "url/gurl.h"

namespace content {
class WebContents;
}

namespace electron {

// One-shot main-document response override for a specific WebContents.
// Lookups are keyed by WebContents* so concurrent navigations in other
// WebContents (even in the same Session) are unaffected.
struct NavigationResponseOverride {
  GURL url;
  int status_code = 200;
  std::vector<std::pair<std::string, std::string>> headers;
  std::string body;
};

class NavigationResponseOverrideRegistry {
 public:
  static NavigationResponseOverrideRegistry* Get();

  NavigationResponseOverrideRegistry(const NavigationResponseOverrideRegistry&) =
      delete;
  NavigationResponseOverrideRegistry& operator=(
      const NavigationResponseOverrideRegistry&) = delete;

  // Replaces any existing pending override for |web_contents|.
  void Register(content::WebContents* web_contents,
                NavigationResponseOverride override_data);

  void Unregister(content::WebContents* web_contents);

  // If |web_contents| has a pending override whose URL matches |request_url|
  // (fragment ignored), remove and return it. Otherwise nullopt.
  std::optional<NavigationResponseOverride> TryTake(
      content::WebContents* web_contents,
      const GURL& request_url);

 private:
  friend class base::NoDestructor<NavigationResponseOverrideRegistry>;
  NavigationResponseOverrideRegistry();
  ~NavigationResponseOverrideRegistry();

  static GURL StripRef(const GURL& url);

  base::Lock lock_;
  std::map<raw_ptr<content::WebContents>, NavigationResponseOverride> pending_
      GUARDED_BY(lock_);
};

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_NET_NAVIGATION_RESPONSE_OVERRIDE_REGISTRY_H_
