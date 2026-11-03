# NativePanelUpdateOptions Object

* `content` [NativePanelContent](native-panel-content.md) (optional) - Replacement
  native control tree. Preserve IDs and types to retain native interaction state.
* `anchorBounds` [Rectangle](rectangle.md) (optional) - Updated anchor in screen
  DIP coordinates. All values must be finite and dimensions non-negative.
* `theme` (string | [NativePanelTheme](native-panel-theme.md)) (optional) -
  `system`, `light`, `dark`, or a native color and font configuration.
* `radius` number (optional) - Corner radius from `0` through `1000` DIP.
* `shadow` boolean (optional) - Whether to display the native shadow.

Only supplied properties change. Validation is atomic: an invalid property
rejects the entire patch, including other otherwise valid properties.
