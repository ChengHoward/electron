# NativePanel

> Create native control panels above a window's web contents.

Process: [Main](../glossary.md#main-process)

`NativePanel` is an [EventEmitter](https://nodejs.org/api/events.html#class-eventemitter).
This module can only be used after `app` is ready. The initial implementation
supports Windows x64. Call `NativePanel.isSupported()` to check the runtime.

Panels use native controls in the browser process. They do not create a
`WebContents`, renderer process, DOM, or CSS document. A panel can overlap a
`WebContentsView` and extend outside its parent window. Opening a panel does not
hide, reload, or capture the source page and does not change Agent input policy.

```js
const { app, BaseWindow, NativePanel } = require('electron')

app.whenReady().then(() => {
  const parent = new BaseWindow({ width: 800, height: 600 })
  if (!NativePanel.isSupported()) return
  const panel = new NativePanel({
    parent,
    content: {
      type: 'column',
      id: 'root',
      width: 320,
      padding: 12,
      gap: 8,
      children: [
        { type: 'text', id: 'status', text: 'Agent is running' },
        { type: 'button', id: 'pause', text: 'Pause' }
      ]
    }
  })
  panel.on('action', (action) => {
    if (action.id === 'pause' && action.type === 'click') {
      console.log('Pause requested')
    }
  })
  panel.show({ anchorBounds: { x: 300, y: 100, width: 24, height: 24 } })
})
```

Overflow areas, `list` controls, and multiline editors use a native vertical
scrollbar with a 12 DIP gutter and no arrow buttons. Its gray rounded thumb is
4 DIP wide normally and 6 DIP wide when hovered or pressed; the track is
transparent normally and lightly tinted during interaction. It follows the
panel's light or dark theme, supports native dragging and scrolling, and
disappears when all content fits. Its geometry is built in, with no per-panel
CSS or process-wide scrollbar changes. This appearance is included in
`45.0.0-cloudbypass.11`.

`scrollbarPlacement: 'gutter'` is the default and reserves a separate 12 DIP
strip beside the viewport while scrolling is needed. `'overlay'` draws over
the viewport without reserving that space. The panel option controls only
outer overflow; each `list` or `textarea` node has its own independent option
and defaults to `gutter`. Neither mode places the scrollbar outside its
allocated bounds or visual border. Text padding does not move the scrollbar
away from the border; hosts can reserve right padding to keep overlay text clear.

On supported Windows versions, `backgroundMaterial: 'acrylic'` requests a
native blurred panel backdrop. The default is `none`. Windows controls backdrop
availability based on system transparency, contrast and power policy.
`theme.background` supplies the opaque fallback; `theme.materialTint` controls
the foreground tint over the blur. The default tint is neutral and follows
the panel theme. Opaque child backgrounds cover the material. The material
uses a rounded geometric clip, with the shadow outside that clip in its own
input-transparent native window. This option is included in
`45.0.0-cloudbypass.11` and does not change `Menu`.

A `textarea` node provides a native multiline editor with automatic wrapping
and internal scrolling when its fixed height is exceeded. Enter submits its
current text by default and Shift+Enter inserts a line break; set
`submitOnEnter: false` to make Enter insert a line break too. Track `change`
values in the host when a separate Save button uses the draft. The existing `input` node remains single-line
and submits on Enter. See [NativePanelContent](structures/native-panel-content.md)
for editor fields and sizing.

The `textarea` control and its `submitOnEnter` option are included in
`45.0.0-cloudbypass.11`.

## Class: NativePanel

> Create native controls in an owned popup window.

Process: [Main](../glossary.md#main-process)

`NativePanel` is an [EventEmitter](https://nodejs.org/api/events.html#class-eventemitter).

### `new NativePanel(options)`

* `options` [NativePanelConstructorOptions](structures/native-panel-options.md)

Creates a hidden panel associated with a live `BaseWindow` or `BrowserWindow`.
Invalid options throw before a native window is created. A panel belongs to its
parent for its entire lifetime; destroy it and create another panel to change
parents. The parent automatically destroys its panels when it is destroyed.

If `sourceWebContents` is supplied, a main-frame navigation, including reloading
the same URL or navigating within the same document, destruction, renderer
loss, or transfer to another host invalidates the panel. Create a new panel for
the current page after navigation.

### Static Methods

#### `NativePanel.isSupported()`

Returns `boolean` - Whether this platform and runtime implement native panels.
The initial supported target is Windows x64; other targets return `false`.
Use this check instead of inferring support from the Electron version.

#### `NativePanel.getCapabilities()`

Returns [`NativePanelCapabilities`](structures/native-panel-capabilities.md) - Runtime
features and limits. Does not create a native window.

#### `NativePanel.createElement(type, properties, ...children)`

* `type` string - Native node type.
* `properties` Record\<string, any\> - Properties including a stable ID.
* `...children` [NativePanelContent[]](structures/native-panel-content.md) - Container children.

Returns [`NativePanelContent`](structures/native-panel-content.md) - Validated native
description. Use as a JSX factory or in reusable component functions. This helper
creates data, without a DOM or a React/Vue runtime.

### Instance Methods

#### `panel.show(options)`

* `options` [NativePanelShowOptions](structures/native-panel-show-options.md)

Displays the panel or reuses its existing native window. Anchor bounds are
screen coordinates in device-independent pixels (DIP), not pixels relative to
the parent. The panel flips its placement and stays within the display's work
area when there is insufficient space. Oversized content is constrained and can
be scrolled. The anchor follows parent movement; submit a new `anchorBounds`
when the anchor itself changes inside the parent's interface.

Calling this method after destruction or page invalidation throws.

#### `panel.update(patch)`

* `patch` [NativePanelUpdateOptions](structures/native-panel-update-options.md)

Returns `boolean` - True when applied; false when a revision guard is stale.

Updates only the supplied fields. Content replaces the control description;
stable control IDs of the same type retain native focus, unsubmitted input, and
scroll position. Update existing IDs instead of assigning new IDs on each
refresh. Changing a node's type replaces that control.

The complete patch is validated before any changes are applied. An invalid
field throws and leaves the previous content, theme, anchor, and appearance
unchanged. Content and theme updates do not recreate the whole panel. Calling
this method after destruction or page invalidation throws.

#### `panel.applyPatch(operations[, options])`

* `operations` [NativePanelNodePatch[]](structures/native-panel-node-patch.md) - Ordered transactions.
* `options` [NativePanelTransactionOptions](structures/native-panel-transaction-options.md) (optional)

Returns `boolean` - Whether the complete transaction was applied. Validates the
candidate tree atomically. Stable native controls retain their drafts and state.

#### `panel.focus(id)`

* `id` string - Node to reveal and focus.

Returns `boolean` - Whether native focus reached this node. False for a missing,
hidden, disabled or nonfocusable node, and for focusMode none.

#### `panel.setActiveItem(id)`

* `id` string | null - Item to reveal and highlight; null clears it.

Returns `boolean` - Whether the active item was set. Retains editor focus and does
not select or execute the item.

#### `panel.scrollTo(id)`

* `id` string - Node to reveal, including an offscreen virtual row.

Returns `boolean` - Whether an enabled visible node could be revealed.

#### `panel.scrollListTo(id, offset)`

* `id` string - Scrollable list ID.
* `offset` number - Non-negative vertical position in DIP, clamped to the list range.

Returns `boolean` - Whether the list was found and scrolled.

#### `panel.getBounds([id])`

* `id` string (optional) - Materialized node ID; omit for panel bounds.

Returns `Rectangle | null` - Actual screen-DIP [Rectangle](structures/rectangle.md) bounds.
An offscreen virtual data node returns null; reading does not reveal it.

#### `panel.getDiagnostics()`

Returns [`NativePanelDiagnostics`](structures/native-panel-diagnostics.md) - Read-only
native state snapshot. Password values are redacted.

#### `panel.popupMenu(menu[, options])`

* `menu` [Menu](menu.md) - Native menu.
* `options` [NativePanelMenuOptions](structures/native-panel-menu-options.md) (optional)

Displays a menu associated with this panel. The panel stays open during menu
interaction. Removing the menu target, hiding or destroying the panel closes
the menu. Escape closes the menu first. Use this method to coordinate native
menu lifetime and screen-DIP positioning.

#### `panel.announce(text[, assertive])`

* `text` string - Screen-reader announcement.
* `assertive` boolean (optional) - Alert priority. Default is false (polite).

Announces through native accessibility. Spoken output requires active assistive technology.

#### `panel.hide()`

Hides the panel and ends its current interaction. The instance remains available
for a later `show()`. Focus returns to the appropriate live parent or source
control. This does not disable the source page's real-input protection or
request an Agent takeover. Programmatic hiding does not emit `dismissed`.

#### `panel.destroy()`

Destroys the native window, controls, and listeners. Repeated calls are safe.
The `closed` event is emitted once. `show()` and `update()` cannot reuse a
destroyed instance.

### Instance Properties

#### `panel.revision` _Readonly_

A `number` containing the content revision. Initially zero. Successful content
updates increment it unless a newer explicit revision was supplied.

### Instance Events

#### Event: 'action'

Returns:

* `action` [NativePanelAction](structures/native-panel-action.md)

Emitted for a native control action. A button, clickable row, icon button or
inline text link emits `click`; a toggle or option
emits `change`, and a single-line input emits `change` while editing and `submit`
when committed with Enter. A multiline `textarea` emits `change`; by default,
Enter emits `submit` with its current text and Shift+Enter inserts a line break.
With `submitOnEnter: false`, Enter inserts a line break instead of submitting.
The application performs the requested operation. Opening, focusing, hovering,
or dismissing a panel does not implicitly perform a business action.

#### Event: 'context-menu'

Returns:

* `action` [NativePanelAction](structures/native-panel-action.md)

Emitted for right-click, the menu key or Shift+F10. The nearest opted-in node
handles it; false contextMenu stops ancestor lookup. The same request is also
an action with type context-menu. Handle one event form to avoid opening two
menus. Native editors keep their editing menus unless explicitly opted in.

#### Event: 'dismissed'

Returns:

* `details` Object
  * `reason` string - `outside-click`, `escape`, `blur`, or `parent-hidden`.

Emitted when a user dismisses the visible panel, for example by clicking outside,
pressing Escape, or moving focus away. IME composition handles Escape before
panel dismissal. The instance remains available for reuse unless it is closed.

#### Event: 'closed'

Emitted once when the instance is destroyed, including destruction caused by
its parent or invalidation of its source page. Release application references
in this handler.

## Interaction and lifetime

`focusMode: 'none'` displays a non-activating informational panel. `'menu'` enables
keyboard navigation and `'input'` enables native text editing and input methods.
Tab, arrow keys, Enter, Escape, pointer input, and scrolling use native controls.
The rounded visible region determines pointer hit testing; transparent rounded
corners and shadow do not block the underlying page.

Panels follow their parent window's position, visibility, and display scale.
They do not receive a separate taskbar or Alt+Tab entry. Hiding or minimizing the
parent hides its panels. Destroy panels when they are no longer needed; hiding
retains native resources for reuse.
