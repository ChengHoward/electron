# MenuControl Object

A native inline button or label inside a Windows popup menu item. This is a
finite native control description; it does not accept HTML or NativePanel nodes.

* `id` string - Nonempty identifier, unique within the row, at most 256 characters.
* `type` string - `button` or `label`.
* `label` string (optional) - Display text, at most 1024 UTF-16 code units.
* `icon` [NativeImage](../native-image.md) (optional) - Button image.
* `accessibleName` string (optional) - Accessible name and tooltip. Required for
  buttons with an icon and no text.
* `enabled` boolean (optional) - Default is `true`.
* `closeOnClick` boolean (optional) - Close before dispatching the action.
  Default is `false`, allowing repeated zoom changes while the menu stays open.
* `group` Integer (optional) - From `0` through `8`. Contiguous controls with
  the same nonzero group share a rounded segmented background. Default is `0`.

Use `MenuItem.controls` with one through eight controls on a `normal` item
with a nonempty `id`. The containing item's label appears on the left. Buttons
emit `control-action` on the popup's root Menu, with item and control IDs. They
do not invoke the containing item's `click` callback. The host supplies values
and handles the action. To update an open row, replace its controls and call
`menu.refresh()`. IDs, types, groups and row membership remain stable until it
closes. Up/Down and Tab/Shift+Tab traverse native controls in a customized menu,
skipping labels and disabled buttons. Enter or Space activates a button; Escape
closes the current native menu level. Left/Right retain native submenu behavior.

Control order, labels, images, grouping, enabled state and close behavior are
configurable. Individual control geometry is built in: buttons are 24 by 24 DIP,
labels are 44 by 24 DIP, button images are resized to 18 by 18 DIP, segment
corners are 8 DIP, and the gap from a grouped control to an ungrouped control is
4 DIP. Inline labels use a font one DIP smaller than the surrounding menu, with
a minimum size of 6 DIP. `MenuAppearance` controls the surrounding menu's font,
row height and spacing; it does not provide arbitrary inline CSS layout.
