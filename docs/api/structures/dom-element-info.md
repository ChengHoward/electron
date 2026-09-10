# DomElementInfo Object

* `backendNodeId` Integer - Same as CDP DOM `backendNodeId` / Blink DomNodeId.
* `tagName` string - Element tag name.
* `bounds` [Rectangle](rectangle.md) - Widget-space bounds from Blink `BoundsInWidget`.
* `x` number - CSS pixels relative to the main frame viewport (`dispatchMouseEvent` space).
* `y` number - CSS pixels relative to the main frame viewport.
* `width` number - CSS pixel width.
* `height` number - CSS pixel height.
