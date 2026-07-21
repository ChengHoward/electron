// Copyright (c) 2026 ChengHoward.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_NET_USER_AGENT_URL_LOADER_THROTTLE_H_
#define ELECTRON_SHELL_BROWSER_NET_USER_AGENT_URL_LOADER_THROTTLE_H_

#include <string>

#include "third_party/blink/public/common/loader/url_loader_throttle.h"

namespace electron {

// Forces the User-Agent request header to |user_agent|, matching the browser
// side of CDP Emulation.setUserAgentOverride (EmulationHandler::ApplyOverrides)
// without requiring an attached DevTools session.
class UserAgentURLLoaderThrottle : public blink::URLLoaderThrottle {
 public:
  explicit UserAgentURLLoaderThrottle(std::string user_agent);
  ~UserAgentURLLoaderThrottle() override;

  UserAgentURLLoaderThrottle(const UserAgentURLLoaderThrottle&) = delete;
  UserAgentURLLoaderThrottle& operator=(const UserAgentURLLoaderThrottle&) =
      delete;

  // blink::URLLoaderThrottle:
  void WillStartRequest(network::ResourceRequest* request,
                        bool* defer) override;
  void WillRedirectRequest(
      net::RedirectInfo* redirect_info,
      const network::mojom::URLResponseHead& response_head,
      bool* defer,
      network::HttpRequestHeadersUpdateParams* headers_update_params) override;

 private:
  const std::string user_agent_;
};

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_NET_USER_AGENT_URL_LOADER_THROTTLE_H_
