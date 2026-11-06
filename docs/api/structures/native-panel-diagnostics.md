# NativePanelDiagnostics Object

* `visible` boolean - Native panel visibility.
* `bounds` [Rectangle](rectangle.md) - Actual screen-DIP bounds.
* `revision` number - Current content revision.
* `activeId` string - Active item, or an empty string.
* `focusedId` string (optional) - Focused native node.
* `menuOpen` boolean - Associated menu state.
* `windowHandle` string - Decimal native HWND.
* `backgroundMaterialApplied` string - `acrylic` or `none`, after system policy checks.
* `materialFallbackReason` string - Empty when no fallback is needed.
* `materialBackend` string - `composition-host-backdrop` or `none`.
* `backdropWindowHandle` string (optional) - Input-transparent native material HWND.
* `controls` Object[] - Materialized controls; offscreen virtual data rows are omitted.
  * `id` string - Node ID.
  * `type` string - Node type.
  * `parentId` string - Parent node ID.
  * `bounds` [Rectangle](rectangle.md) - Control screen-DIP bounds.
  * `visible` boolean - Drawn state.
  * `enabled` boolean - Enabled state including ancestors.
  * `hovered` boolean - Pointer is inside clipped visible bounds.
  * `pressed` boolean - Native button press state.
  * `focused` boolean - Focus is within this subtree.
  * `active` boolean - Active item state.
  * `selected` boolean (optional) - Item selection presentation.
  * `fontSize` number (optional) - Actual native label font size.
  * `fontWeight` number (optional) - Actual native font weight.
  * `style` [NativePanelStyle](native-panel-style.md) - Resolved appearance.
  * `role` string - Explicit accessibility role, or empty.
  * `accessibleDescription` string - Explicit accessibility description.
  * `busy` boolean - Host-controlled busy state.
  * `text` string (optional) - Label text.
  * `value` (string | number) (optional) - Current value; password text is redacted.
  * `readOnly` boolean (optional) - Editor read-only state.
  * `invalid` boolean (optional) - Editor validation state.
  * `scrollOffset` number (optional) - List vertical scroll offset in DIP.
  * `virtualStart` number (optional) - First materialized row index.
  * `virtualEnd` number (optional) - Exclusive last materialized row index.

Read-only snapshot. Additional diagnostic fields and internal virtual spacer nodes may
be present. Reading does not focus, reveal, or execute a control.
