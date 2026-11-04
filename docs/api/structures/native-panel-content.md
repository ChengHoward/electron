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
* `style` Object (optional) - Per-control appearance. Colors accept `#RRGGBB` or
  `#AARRGGBB`; measurements are DIP. Omitted fields follow the native theme.
  * `background` string (optional) - Normal background.
  * `hoverBackground` string (optional) - Hover background for interactive rows and icon buttons.
  * `pressedBackground` string (optional) - Pressed background.
  * `selectedBackground` string (optional) - Selected row background.
  * `disabledBackground` string (optional) - Disabled background.
  * `color` string (optional) - Text color.
  * `borderColor` string (optional) - Border color.
  * `borderWidth` number (optional) - Border width, from `0` through `1000`.
  * `radius` number (optional) - Control corner radius, from `0` through `1000`.
  * `paddingTop` number (optional) - Top padding, from `0` through `1000`.
  * `paddingRight` number (optional) - Right padding, from `0` through `1000`.
  * `paddingBottom` number (optional) - Bottom padding, from `0` through `1000`.
  * `paddingLeft` number (optional) - Left padding, from `0` through `1000`.
  * `fontWeight` string (optional) - `normal`, `medium`, or `bold`.
  * `align` string (optional) - `start`, `center`, or `end`. Aligns text or the cross axis of a layout container.
  * `borderless` boolean (optional) - Remove the native border and background of an `input` or `textarea`.
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
keeps the editor's size fixed and excess text scrolls inside it. It does not
grow automatically or add a Ctrl+Enter submission shortcut. Use `width`, `height`,
and the common `style` fields to size and decorate it. There is no
`input.multiline` mode; changing an `input` to a `textarea` replaces the control.
The `textarea` node and `submitOnEnter` are unreleased source additions; the
published `45.0.0-cloudbypass.6` package does not provide them.

Trees contain at most 2,000 nodes and have a maximum nesting depth of 32. IDs
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
