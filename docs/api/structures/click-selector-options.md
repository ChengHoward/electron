# ClickSelectorOptions Object

* `pierce` boolean (optional) - Search nested open/closed author shadow roots (default: `true`). Applies to selector lookup; an already resolved `target` does not perform a selector search.
* `scrollIntoView` boolean (optional) - Scroll into view before clicking (default: `true`). Also applies when a `target` is supplied.
* `button` string (optional) - `left`, `middle`, `right`, `back`, or `forward` (default: `left`).
* `clickCount` Integer (optional) - Number of complete press/release pairs, from `1` to `3` (default: `1`). Each pair has an increasing event count; `2` sends a double click, including both `click` events and `dblclick`.
* `modifiers` Integer (optional) - Alt=1, Ctrl=2, Meta=4, Shift=8 (default: `0`).
