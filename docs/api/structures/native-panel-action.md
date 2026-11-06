# NativePanelAction Object

* `id` string - Stable ID of the native control that produced the action.
* `type` string - click, change, submit, or context-menu.
* `revision` number - Content revision when delivered.
* `anchor` [Rectangle](rectangle.md) (optional) - Screen-DIP anchor for row, icon, or context actions.
* `sourceType` string (optional) - mouse or keyboard for a context action.
* `linkId` string (optional) - Activated entry in the text node's links array.
* `value` (string | boolean) (optional) - A toggle's new checked state, an option's
  selected value, or an `input` or `textarea` control's current text. Buttons do
  not supply a value.

`button` emits `click`; `toggle` and `option` emit `change`; `input` emits
`change` while editing and `submit` on Enter. `textarea` emits `change` while
editing and, by default, `submit` on Enter with its current text; Shift+Enter
inserts a line break. With `submitOnEnter: false`, Enter also inserts a line break.
Track the editor's `change` value in the host to save a draft from an independent
button action. Disabled controls and stale source pages cannot produce
usable actions. The application handles business operations in its `action`
listener; native panels do not implicitly pause or take over an Agent.
