# NativePanelTheme Object

A native color and font configuration. As a shorthand, `theme` also accepts
`system`, `light`, or `dark` directly.

* `mode` string (optional) - `system`, `light`, or `dark`. Default is `system`.
* `background` string (optional) - Panel background color.
* `text` string (optional) - Primary text color.
* `muted` string (optional) - Auxiliary text color.
* `accent` string (optional) - Accent and selection color.
* `border` string (optional) - Control and panel border color.
* `fontFamily` string (optional) - Native font family.
* `fontSize` number (optional) - Native font size from `6` through `96` DIP.

Colors use `#RRGGBB` or `#AARRGGBB`. Named CSS colors, style declarations, CSS
selectors, and arbitrary CSS properties are not supported. Omitted properties
use the selected native theme's defaults. Updating the theme preserves the
panel's native controls and interaction state.
