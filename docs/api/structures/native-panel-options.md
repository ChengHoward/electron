# NativePanelConstructorOptions Object

* `parent` [BaseWindow](../base-window.md) - Required live owner. `BrowserWindow`
  is also accepted.
* `sourceWebContents` [WebContents](../web-contents.md) (optional) - Source page
  attached to `parent`. A new main-frame document, destruction, or host transfer
  invalidates the panel and prevents stale actions.
* `content` [NativePanelContent](native-panel-content.md) - Required native
  control tree. Every node has a unique, stable `id`.
* `theme` (string | [NativePanelTheme](native-panel-theme.md)) (optional) -
  `system`, `light`, `dark`, or a native color and font configuration. Default is
  `system`.
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
