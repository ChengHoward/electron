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
CSS or process-wide scrollbar changes. This scrollbar appearance is an
unreleased source change and is not included in `45.0.0-cloudbypass.6`.

`scrollbarPlacement: 'gutter'` is the default and reserves a separate 12 DIP
strip beside the viewport while scrolling is needed. `'overlay'` draws over
the viewport without reserving that space. The panel option controls only
outer overflow; each `list` or `textarea` node has its own independent option
and defaults to `gutter`. Neither mode places the scrollbar outside its
allocated bounds or visual border. Text padding does not move the scrollbar
away from the border; hosts can reserve right padding to keep overlay text clear.

On supported Windows versions, `backgroundMaterial: 'acrylic'` requests a
system-drawn panel backdrop. The default is `none`. Windows controls the
material's opacity and may use a solid fallback based on system settings,
power state, or activation. `theme.background` supplies the fallback color;
opaque child backgrounds cover the material. This source-preview option does
not change `Menu` and is not included in `45.0.0-cloudbypass.6`.

A `textarea` node provides a native multiline editor with automatic wrapping
and internal scrolling when its fixed height is exceeded. Enter submits its
current text by default and Shift+Enter inserts a line break; set
`submitOnEnter: false` to make Enter insert a line break too. Track `change`
values in the host when a separate Save button uses the draft. The existing `input` node remains single-line
and submits on Enter. See [NativePanelContent](structures/native-panel-content.md)
for editor fields and sizing.

The `textarea` control and its `submitOnEnter` option are source-preview
additions and are not included in the published `45.0.0-cloudbypass.6` package.

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

Updates only the supplied fields. Content replaces the control description;
stable control IDs of the same type retain native focus, unsubmitted input, and
scroll position. Update existing IDs instead of assigning new IDs on each
refresh. Changing a node's type replaces that control.

The complete patch is validated before any changes are applied. An invalid
field throws and leaves the previous content, theme, anchor, and appearance
unchanged. Content and theme updates do not recreate the whole panel. Calling
this method after destruction or page invalidation throws.

#### `panel.hide()`

Hides the panel and ends its current interaction. The instance remains available
for a later `show()`. Focus returns to the appropriate live parent or source
control. This does not disable the source page's real-input protection or
request an Agent takeover. Programmatic hiding does not emit `dismissed`.

#### `panel.destroy()`

Destroys the native window, controls, and listeners. Repeated calls are safe.
The `closed` event is emitted once. `show()` and `update()` cannot reuse a
destroyed instance.

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
