# NativePanelContent Object

A recursive native control description. All measurements are DIP. Every node
must have a `type` and a non-empty, tree-wide unique `id`. IDs identify actions
and preserve interaction state across `update()` calls.

* `type` string - `row`, `column`, `list`, `text`, `icon`, `button`, `toggle`,
  `input`, `option`, `separator`, or `progress`.
* `id` string - Stable unique node identifier.
* `disabled` boolean (optional) - Disable the node's interaction.
* `visible` boolean (optional) - Whether to include the node in the layout.
* `width` number (optional) - Non-negative preferred width.
* `height` number (optional) - Non-negative preferred height.
* `flex` number (optional) - Non-negative layout flex weight.
* `tooltip` string (optional) - Native tooltip text.
* `children` NativePanelContent[] (optional) - Required for `row`, `column`, and
  `list`. Child controls, ordered as displayed. Not accepted on leaf controls.
* `gap` number (optional) - Non-negative space between children of a layout node.
* `padding` number (optional) - Non-negative uniform inset of a layout node.
* `text` string (optional) - Required for `text`, `button`, and `toggle`.
* `muted` boolean (optional) - Use the auxiliary text color on a `text` node.
* `fontSize` number (optional) - Font size from `6` through `96` DIP for a `text`
  node.
* `image` [NativeImage](../native-image.md) (optional) - Required non-empty image
  for `icon`. Image URLs, HTML, and CSS icons are not accepted.
* `checked` boolean (optional) - Required on `toggle`.
* `value` (string | number) (optional) - `input`: initial text; `option`: selected
  item value or ID; `progress`: required number from `0` through `1`, or `-1`
  for indeterminate progress.
* `placeholder` string (optional) - Hint text for `input`.
* `maxLength` Integer (optional) - Maximum text length for `input`, from `0`
  through `65536`. `0` means unlimited. Default is `0`.
* `items` Object[] (optional) - Required choices for `option`. An empty array
  displays a control with no available choices.
  * `id` string - Unique item identifier within this option control.
  * `label` string - Native display label.
  * `value` string (optional) - Application value; defaults to the item ID.
  * `disabled` boolean (optional) - Disable the choice.

The root's preferred width defaults to `320`. A `list` is a scrollable layout
with default height `240`. `separator` has no type-specific properties.
`row` lays out children horizontally and `column` lays them out vertically.
Long lists and constrained panel content use native scrolling.

Trees contain at most 2,000 nodes and have a maximum nesting depth of 32. IDs
contain at most 256 characters. Properties specific to another node type,
unknown fields, invalid numbers, and duplicate IDs are rejected. Trees are data,
not executable markup. A panel does
not evaluate script or create a renderer to display the tree.

When refreshing a tree, keep the IDs and types of live controls stable. The
native panel retains unsubmitted input, focused controls, and list position.
Use a new ID when a control intentionally represents new state.
