# NativePanelMenuOptions Object

* `id` string (optional) - Visible enabled target. Removing it closes the menu.
* `x` number (optional) - Horizontal screen-DIP position; requires y.
* `y` number (optional) - Vertical screen-DIP position; requires x.
* `sourceType` string (optional) - `mouse` or `keyboard` from the context action.

Position defaults to the target bottom-left, or the cursor when no target is supplied.
NativePanel converts screen coordinates to the owner's menu coordinate system.
