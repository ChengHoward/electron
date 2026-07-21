# UserAgentOverrideOptions Object

Optional second argument to
[`ses.setUserAgent`](../session.md#sessetuseragentuseragent-options) and
[`contents.setUserAgent`](../web-contents.md#contentssetuseragentuseragent-options).
Aligned with CDP `Emulation.setUserAgentOverride`.

* `platform` string (optional) - Overrides `navigator.platform`
  (e.g. `"Win32"`, `"MacIntel"`, `"Linux x86_64"`). Empty or omitted means
  no override.
* `acceptLanguage` string (optional) - Comma-separated Accept-Language list,
  e.g. `"en-US,fr,de"`. Alias: `acceptLanguages` (legacy session API name).
* `userAgentMetadata` [UserAgentMetadata](user-agent-metadata.md) | null (optional) - Overrides `Sec-CH-UA-*` request headers and `navigator.userAgentData`. When omitted, Electron's default metadata is used. When `null`, UA Client Hints (`Sec-CH-UA-*`) are disabled. When an object is provided, missing fields are filled from defaults.
