# NativePanelConstructorOptions Object

* `parent` [BaseWindow](../base-window.md) - Required live owner. `BrowserWindow`
  is also accepted.
* `parentPanel` [NativePanel](../native-panel.md) (optional) - Parent panel with the
  same owner window. Show the parent first. Related panels form one outside-click
  group; hiding or destroying an ancestor hides or destroys its children.
* `sourceWebContents` [WebContents](../web-contents.md) (optional) - Source page
  attached to `parent`. A new main-frame document, destruction, or host transfer
  invalidates the panel and prevents stale actions.
* `content` [NativePanelContent](native-panel-content.md) - Required native
  control tree. Every node has a unique, stable `id`.
* `theme` (string | [NativePanelTheme](native-panel-theme.md)) (optional) -
  `system`, `light`, `dark`, or a native color and font configuration. Default is
  `system`.
* `backgroundMaterial` string (optional) _Windows_ - `none` or `acrylic`.
  Default is `none`, which uses the normal panel background. `acrylic` requests
  the system material on Windows 11 version 22H2 or later. Availability depends
  on transparency preferences, high contrast, and system policy; the panel can
  fall back to the solid `theme.background` color. Material opacity is managed
  by Windows and is not an arbitrary alpha setting. Opaque child backgrounds
  cover the material beneath them.
* `scrollbarPlacement` string (optional) - `overlay` or `gutter` for the panel's
  outer overflow area. Default is `gutter`, which reserves a separate 12 DIP
  strip beside the content viewport when scrolling is needed. `overlay` draws
  the scrollbar over the viewport without reserving that strip. Both stay
  within the allocated panel bounds. This option does not set the placement
  of nested `list` or `textarea` controls; configure those nodes separately.
* `contentInset` Integer (optional) - Inner surface inset from `0` through `64`
  DIP. Default is `12` on construction; updates retain the previous value when
  omitted. Use a smaller inset for full-width suggestion rows.

* `radius` number (optional) - Corner radius from `0` through `1000` DIP. Default
  is `12`.
* `shadow` boolean (optional) - Whether to display the native shadow. Default is
  `true`.
* `focusMode` string (optional) - `none`, `menu`, or `input`. Default is `menu`.
* `dismissOnOutsideClick` boolean (optional) - Dismiss on outside pointer input.
  Default is `true`.
* `dismissOnEscape` boolean (optional) - Dismiss on Escape after input-method
  composition has handled it. Default is `true`.

The constructor rejects missing or destroyed owners, a source page attached to
another window, malformed trees, duplicate IDs, and invalid appearance values.
No DOM element, HTML string, web URL, Vue component, or CSS is accepted as
`content`.
