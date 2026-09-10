// Copyright (c) 2026 ChengHoward.
// Use of this source code is governed by the MIT license that can be
// found in the LICENSE file.

#ifndef ELECTRON_SHELL_BROWSER_USER_AGENT_OPTIONS_H_
#define ELECTRON_SHELL_BROWSER_USER_AGENT_OPTIONS_H_

#include <optional>
#include <string>

#include "third_party/blink/public/common/user_agent/user_agent_metadata.h"

namespace gin {
class Arguments;
}  // namespace gin

namespace gin_helper {
class Dictionary;
}  // namespace gin_helper

namespace electron {

// How Sec-CH-UA-* / navigator.userAgentData metadata is applied when a custom
// UA string is set.
enum class UserAgentMetadataPolicy {
  // Omit key: use embedder defaults (Electron/Chromium build defaults).
  kDefault,
  // userAgentMetadata: null — strip UA Client Hints (aligned with Chromium
  // behavior when ua_metadata_override is unset).
  kDisabled,
  // userAgentMetadata: { ... } — use the provided metadata.
  kCustom,
};

// Optional overrides aligned with CDP Emulation.setUserAgentOverride.
struct UserAgentOptions {
  // Overrides navigator.platform.
  std::string platform;

  // When true, hide window.chrome in webpage script contexts.
  bool hide_chrome = false;

  // Overrides Accept-Language (renderer prefs + optional NetworkContext).
  std::optional<std::string> accept_language;

  UserAgentMetadataPolicy metadata_policy = UserAgentMetadataPolicy::kDefault;

  // Valid when metadata_policy == kCustom.
  blink::UserAgentMetadata user_agent_metadata;
};

// Parses CDP-style userAgentMetadata object into blink::UserAgentMetadata.
// Missing fields are filled from |defaults|.
bool ParseUserAgentMetadata(const gin_helper::Dictionary& dict,
                            const blink::UserAgentMetadata& defaults,
                            blink::UserAgentMetadata* out,
                            std::string* error);

// Reads optional 2nd argument of setUserAgent:
// - string -> accept_language (legacy session API)
// - object -> platform / hideChrome / acceptLanguage / userAgentMetadata
//   - userAgentMetadata omitted -> kDefault
//   - userAgentMetadata: null -> kDisabled (no Sec-CH-UA-*)
//   - userAgentMetadata: {..} -> kCustom
bool ParseUserAgentOptions(gin::Arguments* args,
                           const blink::UserAgentMetadata& defaults,
                           UserAgentOptions* out,
                           std::string* error);

}  // namespace electron

#endif  // ELECTRON_SHELL_BROWSER_USER_AGENT_OPTIONS_H_
