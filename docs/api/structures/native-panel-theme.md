# NativePanelTheme Object

A native color and font configuration. As a shorthand, `theme` also accepts
`system`, `light`, or `dark` directly.

* `mode` string (optional) - `system`, `light`, or `dark`. Default is `system`.
* `background` string (optional) - Panel background color.
* `materialTint` string (optional) - Foreground tint over active Acrylic, using
  `#RRGGBB` or `#AARRGGBB`. Defaults to `#CCFAFAFA` in light mode and `#B3202020`
  in dark mode. Use `#00000000` for the untinted system backdrop. This changes
  the foreground color layer, independently of system blur/opacity. Ignored for
  solid fallback and forced colors.
* `text` string (optional) - Primary text color.
* `muted` string (optional) - Auxiliary text color.
* `accent` string (optional) - Accent and selection color.
* `border` string (optional) - Control and panel border color.
* `fontFamily` string (optional) - Native font family.
* `fontSize` number (optional) - Native font size from `6` through `96` DIP.

* `tokens` Record\<string, string\> (optional) - Up to 256 named color tokens.
  Hex colors or references to another $token. Cycles are rejected. Built-ins:
  background, text, muted, accent, border, surface, surfaceHover, surfacePressed,
  surfaceSelected, inputSurface, subtleBorder, and danger.
* `styles` Record\<string, NativePanelStyle\> (optional) - Up to 256 shared native styles.

Colors use `#RRGGBB` or `#AARRGGBB`. Named CSS colors, style declarations, CSS
selectors, and arbitrary CSS properties are not supported. Omitted properties
use the selected native theme's defaults. Updating the theme preserves the
panel's native controls and interaction state.
