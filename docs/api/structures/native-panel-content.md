# NativePanelContent Object

A recursive native control description. All measurements are DIP. Every node
must have a `type` and a non-empty, tree-wide unique `id`. IDs identify actions
and preserve interaction state across `update()` calls.

* `type` string - `row`, `column`, `list`, `item`, `iconButton`, `text`, `icon`, `button`, `toggle`,
  `input`, `textarea`, `option`, `separator`, or `progress`.
* `id` string - Stable unique node identifier.
* `disabled` boolean (optional) - Disable the node's interaction.
* `visible` boolean (optional) - Whether to include the node in the layout.
* `width` number (optional) - Non-negative preferred width.
* `height` number (optional) - Non-negative preferred height.
* `scrollbarPlacement` string (optional) - Only accepted on `list` and `textarea`.
  `gutter` reserves a separate 12 DIP strip beside the content viewport when
  scrolling is needed; `overlay` draws over the viewport without reserving
  space and can cover content. Default is `gutter`, independently of the
  panel's outer placement. Both modes stay within the node's allocated bounds
  and visual border. Scrollbar position is independent of text padding;
  provide sufficient right padding to keep overlay text clear if needed.
* `maxWidth` number (optional) - Maximum preferred width. `0` means unconstrained.
  A short label keeps its natural width, while long text can elide before the
  adjacent auxiliary URL. Layout flex can further constrain the available width.
* `flex` number (optional) - Non-negative layout flex weight.
* `tooltip` string (optional) - Native tooltip text.
* `style` [NativePanelStyle](native-panel-style.md) (optional) - Native appearance.
* `styleName` (string | string[]) (optional) - Names from theme.styles, merged before the explicit style.
* `minWidth` number (optional) - Minimum preferred width in DIP.
* `minHeight` number (optional) - Minimum preferred height in DIP.
* `maxHeight` number (optional) - Maximum preferred height in DIP; zero is unconstrained.
* `contextMenu` boolean (optional) - Handle context requests here. Defaults true for item.
  False stops ancestor lookup. Native editors retain their editing menu unless true.
* `accessibleDescription` string (optional) - Supplemental screen-reader description.
* `role` string (optional) - listbox, option, menu, menuitem, group, or status.
* `expanded` boolean (optional) - Accessible expanded or collapsed state.
* `busy` boolean (optional) - Disable interaction while an operation is pending.
* `justify` string (optional) - Container main-axis start, center, or end alignment.
* `wrap` boolean (optional) - Natural-width children wrap inside a row; no flex distribution.
* `virtual` Object (optional) - Fixed-height virtualization on list.
  * `itemHeight` number - Integer row height from 1 through 1000 DIP.
  * `overscan` number (optional) - Extra rows before and after the viewport, 0 through 32; default 3.
* `selectable` boolean (optional) - Enable native text selection and copying; incompatible with links.
* `maxLines` number (optional) - Maximum text lines, 0 through 1000; zero is unlimited.
* `links` Object[] (optional) - Sorted nonoverlapping inline links, at most 256.
  Cannot combine with linkRange, singleLine, highlights, or selectable.
  * `id` string - Unique ID within the text node.
  * `start` number - Inclusive integer UTF-16 offset.
  * `end` number - Exclusive integer UTF-16 offset.
* `readOnly` boolean (optional) - Native input or textarea is read-only.
* `password` boolean (optional) - Obscure input text and redact diagnostic values.
  Editing actions still carry actual text to the host.
* `invalid` boolean (optional) - Native editor validation state; supply an accessible description.
* `autoGrow` boolean (optional) - Textarea grows with text within minHeight and maxHeight.
  Supply width for predictable wrapping.
* `navigationTarget` string (optional) - Input's target list for active-item navigation.
  Up/Down, Home/End, PageUp/PageDown retain input focus; Enter executes the active item.
* `hoverOnly` boolean (optional) - Icon button paints when its row is hovered or contains focus.
  Its layout space stays reserved.
* `iconSize` number (optional) - Icon button image size from 1 through 256 DIP.
* `accessibleName` string (optional) - Accessible name for `item` and required
  nonempty name for `iconButton`.
* `selected` boolean (optional) - Selected appearance of an `item`. Changing it
  does not execute the row. Hosts can drive selection while retaining input focus.
* `variant` string (optional) - `button` appearance: `default`, `plain`, or `outlined`.
* `singleLine` boolean (optional) - Display `text` on one line with tail ellipsis.
* `highlights` Object[] (optional) - Bold spans in `text`, at most 256 entries.
  * `start` Integer - Inclusive UTF-16 offset.
  * `end` Integer - Exclusive UTF-16 offset, within the text.
* `linkRange` Object (optional) - One inline native hyperlink within multiline
  `text`. The range uses UTF-16 offsets, cannot be empty, and cannot be combined
  with `singleLine` or `highlights`. Activating the link emits `click` with the
  text node ID; surrounding text does not activate it.
  * `start` Integer - Inclusive offset.
  * `end` Integer - Exclusive offset, within the text.
* `children` NativePanelContent[] (optional) - Required for `row`, `column`, and
  `list`, and `item`. Child controls, ordered as displayed. Not accepted on leaf controls.
* `gap` number (optional) - Non-negative space between children of a layout node.
* `padding` number (optional) - Non-negative uniform inset of a layout node.
* `text` string (optional) - Required for `text`, `button`, and `toggle`.
* `muted` boolean (optional) - Use the auxiliary text color on a `text` node.
* `fontSize` number (optional) - Font size from `6` through `96` DIP for a `text`
  node.
* `image` [NativeImage](../native-image.md) (optional) - Required non-empty image
  for `icon` and `iconButton`; optional leading image for `button`.
  Image URLs, HTML, and CSS icons are not accepted.
* `checked` boolean (optional) - Required on `toggle`.
* `value` (string | number) (optional) - `input` and `textarea`: initial text;
  `option`: selected item value or ID; `progress`: required number from `0` through `1`, or `-1`
  for indeterminate progress.
* `placeholder` string (optional) - Hint text for `input` or `textarea`.
* `maxLength` Integer (optional) - Maximum text length in UTF-16 code units for
  `input` or `textarea`, from `0`
  through `65536`. `0` means unlimited. Default is `0`.
* `submitOnEnter` boolean (optional) - Only accepted on `textarea`. Emit `submit`
  on unmodified Enter when not composing with an input method. Default is `true`.
  Shift+Enter always inserts a line break. If `false`, Enter also inserts a line
  break instead of submitting.
* `items` Object[] (optional) - Required choices for `option`. An empty array
  displays a control with no available choices.
  * `id` string - Unique item identifier within this option control.
  * `label` string - Native display label.
  * `value` string (optional) - Application value; defaults to the item ID.
  * `disabled` boolean (optional) - Disable the choice.

The root's preferred width defaults to `320`. A `list` is a scrollable layout
with default height `240`. `separator` has no type-specific properties.
`row` lays out children horizontally and `column` lays them out vertically.
`item` is a horizontal clickable container. Nested buttons have independent
actions; activating them does not activate the row. Selection is presentation
state and can be updated through content without opening a result. In a focused
panel, Up/Down move between rows and Enter executes the focused row.
Long lists and constrained panel content use native scrolling.

`input` is single-line and submits on Enter. `textarea` is a separate native
multiline editor: by default Enter emits `submit` with its current text and
Shift+Enter inserts a line break. Set `submitOnEnter: false` to make Enter insert
a line break too. Editing emits `change`. Text wraps to the available width; a constrained `height`
keeps the editor's size fixed and excess text scrolls inside it. Set autoGrow for automatic growth with a bounded maximum. Ctrl+Enter does not
submit automatically. Use `width`, `height`,
and the common `style` fields to size and decorate it. There is no
`input.multiline` mode; changing an `input` to a `textarea` replaces the control.
The `textarea` node and `submitOnEnter` are unreleased source additions; the
published `45.0.0-cloudbypass.6` package does not provide them.

Ordinary trees contain at most 2,000 nodes. Virtual lists allow 100,000 total data
nodes and 50,000 rows per list. Maximum depth is 32. Virtual lists require direct
item children, fixed row heights, and zero list padding/gap. Space belongs inside
the row. Virtual rows may contain item, row, column, text, icon, button,
iconButton, and separator controls. Use ordinary lists for stateful form controls.
Only viewport rows plus overscan create native controls. IDs beginning with
`__native_panel_virtual__:` are reserved. IDs
contain at most 256 characters. Properties specific to another node type,
unknown fields, invalid numbers, and duplicate IDs are rejected. Trees are data,
not executable markup. A panel does
not evaluate script or create a renderer to display the tree.

When refreshing a tree, keep the IDs and types of live controls stable. The
native panel retains unsubmitted input, focused controls, and list position.
Use a new ID when a control intentionally represents new state.

Background and border styles apply to layout, text, icon, and action controls.
State backgrounds apply to interactive rows, icon buttons, and plain buttons.
Text color, weight, and horizontal alignment apply to text and button labels.
Native form-control colors follow the panel theme; `borderless` and padding
customize the `input` or `textarea` frame. Custom text is never automatically translated.
