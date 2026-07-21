# UserAgentMetadata Object

Used by [`ses.setUserAgent(userAgent[, options])`](../session.md#sessetuseragentuseragent-options) and
[`contents.setUserAgent(userAgent[, options])`](../web-contents.md#contentssetuseragentuseragent-options)
to override Client Hints / `navigator.userAgentData` (aligned with CDP
`Emulation.setUserAgentOverride` `userAgentMetadata`).

Missing fields are filled from Electron's default User-Agent metadata.

* `brands` [UserAgentBrandVersion[]](user-agent-brand-version.md) (optional) -
  Brands used in the `Sec-CH-UA` header and `navigator.userAgentData.brands`.
* `fullVersionList` [UserAgentBrandVersion[]](user-agent-brand-version.md) (optional) -
  Brands used in `Sec-CH-UA-Full-Version-List` and
  `navigator.userAgentData.getHighEntropyValues(['fullVersionList'])`.
* `fullVersion` string (optional) - Full browser version
  (`Sec-CH-UA-Full-Version` / `uaFullVersion`).
* `platform` string (optional) - Platform brand used in Client Hints
  (`Sec-CH-UA-Platform`), e.g. `"Windows"`. This is **not** the same as
  `options.platform` (`navigator.platform`).
* `platformVersion` string (optional) - Platform version
  (`Sec-CH-UA-Platform-Version`).
* `architecture` string (optional) - CPU architecture (`Sec-CH-UA-Arch`).
* `model` string (optional) - Device model (`Sec-CH-UA-Model`).
* `mobile` boolean (optional) - Whether the UA is a mobile form factor
  (`Sec-CH-UA-Mobile`).
* `bitness` string (optional) - Platform bitness (`Sec-CH-UA-Bitness`),
  e.g. `"64"`.
* `wow64` boolean (optional) - Whether the binary is running in 32-bit
  compatibility mode on 64-bit Windows (`Sec-CH-UA-Wow64`).
* `formFactors` string[] (optional) - Form factors
  (`Sec-CH-UA-Form-Factors`), e.g. `["Desktop"]`.
