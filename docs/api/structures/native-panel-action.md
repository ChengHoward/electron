# NativePanelAction Object

* `id` string - Stable ID of the native control that produced the action.
* `type` string - `click`, `change`, or `submit`.
* `value` (string | boolean) (optional) - A toggle's new checked state, an option's
  selected value, or an input's submitted text. Buttons do not supply a value.

`button` emits `click`; `toggle` and `option` emit `change`; `input` emits
`change` while editing and `submit` on Enter. Disabled controls and stale source pages cannot produce
usable actions. The application handles business operations in its `action`
listener; native panels do not implicitly pause or take over an Agent.
