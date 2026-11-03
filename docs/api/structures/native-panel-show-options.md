# NativePanelShowOptions Object

* `anchorBounds` [Rectangle](rectangle.md) - Required screen DIP anchor. `x` and
  `y` may be negative on displays left of or above the primary display. Width
  and height must be non-negative. Every coordinate must be finite.
* `placement` string (optional) - `auto`, `bottom-start`, `bottom-end`,
  `top-start`, or `top-end`. Default is `auto`. This is the preferred placement;
  the panel may flip, shift, or reduce its height to fit the display work area.
