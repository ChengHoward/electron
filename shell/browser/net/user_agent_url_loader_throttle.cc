// Copyright (c) 2026 ChengHoward.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#include "shell/browser/net/user_agent_url_loader_throttle.h"

#include "net/http/http_request_headers.h"
#include "services/network/public/cpp/http_request_headers_update_params.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/mojom/url_response_head.mojom.h"

namespace electron {

UserAgentURLLoaderThrottle::UserAgentURLLoaderThrottle(std::string user_agent)
    : user_agent_(std::move(user_agent)) {}

UserAgentURLLoaderThrottle::~UserAgentURLLoaderThrottle() = default;

void UserAgentURLLoaderThrottle::WillStartRequest(
    network::ResourceRequest* request,
    bool* defer) {
  if (user_agent_.empty())
    return;
  request->headers.SetHeader(net::HttpRequestHeaders::kUserAgent, user_agent_);
}

void UserAgentURLLoaderThrottle::WillRedirectRequest(
    net::RedirectInfo* redirect_info,
    const network::mojom::URLResponseHead& response_head,
    bool* defer,
    network::HttpRequestHeadersUpdateParams* headers_update_params) {
  if (user_agent_.empty())
    return;
  headers_update_params->modified_headers.SetHeader(
      net::HttpRequestHeaders::kUserAgent, user_agent_);
}

}  // namespace electron
