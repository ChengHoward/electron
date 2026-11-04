# NativePanelUpdateOptions Object

* `content` [NativePanelContent](native-panel-content.md) (optional) - Replacement
  native control tree. Preserve IDs and types to retain native interaction state.
* `anchorBounds` [Rectangle](rectangle.md) (optional) - Updated anchor in screen
  DIP coordinates. All values must be finite and dimensions non-negative.
* `theme` (string | [NativePanelTheme](native-panel-theme.md)) (optional) -
  `system`, `light`, `dark`, or a native color and font configuration.
* `backgroundMaterial` string (optional) _Windows_ - `none` or `acrylic`.
  Omitted updates retain the current request. `none` restores the normal panel
  background; `acrylic` requests the system material subject to the same system
  restrictions and solid-color fallback as the constructor.
* `scrollbarPlacement` string (optional) - `overlay` or `gutter` for the panel's
  outer overflow area. Omitted updates retain the current placement. `gutter`
  reserves a separate strip beside the viewport; `overlay` draws over it.
  Nested `list` and `textarea` placements remain independent.
* `contentInset` Integer (optional) - Inner surface inset from `0` through `64`
  DIP. Default is `12` on construction; updates retain the previous value when
  omitted. Use a smaller inset for full-width suggestion rows.

* `radius` number (optional) - Corner radius from `0` through `1000` DIP.
* `shadow` boolean (optional) - Whether to display the native shadow.

Only supplied properties change. Validation is atomic: an invalid property
rejects the entire patch, including other otherwise valid properties.
