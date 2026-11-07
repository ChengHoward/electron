# WebContentsView

> A View that displays a WebContents.

In this fork's Windows desktop builds, `view.setBorderRadius(radius)` also
insets the main document's default scrollbars using compact curve-aware
clearance so their native arrows and thumb remain inside the rounded host
mask. Track/button backgrounds follow that mask. Native appearance is
unchanged. Setting
the radius to zero restores the original scrollbar layout. Author-styled
scrollbars, nested overflow elements and iframe scrollbars retain their layout.
This addition can be disabled before app ready with
`app.commandLine.appendSwitch('disable-desktop-scrollbar-corner-avoidance')`;
foundation builds must set `enable_desktop_customizations = false` in GN args.
See the [customization development guide](../zh/定制开发编译与更新.md) for edition
classification and required change records.

Process: [Main](../glossary.md#main-process)

This module cannot be used until the `ready` event of the `app`
module is emitted.

```js
const { BaseWindow, WebContentsView } = require('electron')

const win = new BaseWindow({ width: 800, height: 400 })

const view1 = new WebContentsView()
win.contentView.addChildView(view1)
view1.webContents.loadURL('https://electronjs.org')
view1.setBounds({ x: 0, y: 0, width: 400, height: 400 })

const view2 = new WebContentsView()
win.contentView.addChildView(view2)
view2.webContents.loadURL('https://github.com/electron/electron')
view2.setBounds({ x: 400, y: 0, width: 400, height: 400 })
```

## Class: WebContentsView extends `View`

> A View that displays a WebContents.

Process: [Main](../glossary.md#main-process)

`WebContentsView` inherits from [`View`](view.md).

`WebContentsView` is an [EventEmitter][event-emitter].

> [!WARNING]
> Electron's built-in classes cannot be subclassed in user code.
> For more information, see [the FAQ](../faq.md#class-inheritance-does-not-work-with-electron-built-in-modules).

### `new WebContentsView([options])`

* `options` Object (optional)
  * `webPreferences` [WebPreferences](structures/web-preferences.md) (optional) - Settings of web page's features.
  * `webContents` [WebContents](web-contents.md) (optional) - If present, the given WebContents will be adopted by the WebContentsView. A WebContents may only be presented in one WebContentsView at a time.

Creates a WebContentsView.

### Instance Methods

Methods inherited from [View](view.md) are available, with this desktop extension:

#### `view.setBorderRadius(radius[, options])`

* `radius` Integer - Host corner radius in DIP, clamped to the view size.
* `options` Object (optional)
  * `scrollbarInset` Integer | null (optional) - Exact scrollbar clearance at both ends in DIP. Accepts integers from 0 to 1000000; available frame length limits the result. Zero disables avoidance. Omit this property or use `null` for automatic compact clearance.

Updates the rounded host mask and the main document's default scrollbar geometry.
Existing calls with only `radius` remain supported and select automatic clearance.
Each call replaces the previous options. This option is effective only in Windows
**desktop** builds while corner avoidance is enabled; the runtime disable switch
also overrides explicit insets. Manual values replace the automatic ink clearance;
the host rounded mask still applies. The native scrollbar style is unchanged.

```js
view.setBorderRadius(12) // automatic compact clearance
view.setBorderRadius(12, { scrollbarInset: 6 }) // explicit DIP clearance
view.setBorderRadius(12, { scrollbarInset: 0 }) // disable avoidance
view.setBorderRadius(12, { scrollbarInset: null }) // automatic again
```

### Instance Properties

Objects created with `new WebContentsView` have the following properties, in
addition to those inherited from [View](view.md):

#### `view.webContents` _Readonly_

A `WebContents` property containing a reference to the displayed `WebContents`.
Use this to interact with the `WebContents`, for instance to load a URL.

```js
const { WebContentsView } = require('electron')

const view = new WebContentsView()
view.webContents.loadURL('https://electronjs.org/')
```

[event-emitter]: https://nodejs.org/api/events.html#events_class_eventemitter
