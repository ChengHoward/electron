# PageInfoDialogOptions Object

* `anchorBounds` [Rectangle](rectangle.md) - Anchor in screen DIP coordinates.
* `siteUrl` string (optional) - Absolute URL with the same origin as the current
  committed document. Omit this to use the committed document automatically.

The anchor must have finite coordinates and positive dimensions. A URL with an
opaque or different origin is rejected. Pending navigations cannot change the
identity or certificate displayed for the committed document.
