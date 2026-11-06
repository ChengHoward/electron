# NativePanelStyle Object

* `background` string (optional) - Base background, hex color or $token.
* `color` string (optional) - Inherited foreground color.
* `linkColor` string (optional) - Native inline-link color.
* `textDecoration` string (optional) - Inherited none, line-through, or underline decoration.
* `borderColor` string (optional) - Border color.
* `radius` number (optional) - Corner radius, 0 through 1000 DIP.
* `borderWidth` number (optional) - Border width, 0 through 1000 DIP.
* `paddingTop` number (optional) - Top padding in DIP.
* `paddingRight` number (optional) - Right padding in DIP.
* `paddingBottom` number (optional) - Bottom padding in DIP.
* `paddingLeft` number (optional) - Left padding in DIP.
* `fontFamily` string (optional) - Inherited native font family.
* `fontSize` number (optional) - Inherited font size, 6 through 96 DIP.
* `fontWeight` string (optional) - Inherited normal, medium, or bold weight.
* `align` string (optional) - Text or container cross-axis alignment: start, center, end, or stretch.
* `verticalAlign` string (optional) - Text alignment: top, middle, or bottom.
* `lineHeight` number (optional) - Text line height, 0 through 256 DIP; zero uses the font default.
* `borderless` boolean (optional) - Transparent editor frame.
* `selected` [NativePanelStateStyle](native-panel-state-style.md) (optional) - Paint overrides.
* `selectedBackground` string (optional) - Shorthand state color.
* `selectedColor` string (optional) - Shorthand state color.
* `selectedBorderColor` string (optional) - Shorthand state color.
* `active` [NativePanelStateStyle](native-panel-state-style.md) (optional) - Paint overrides.
* `activeBackground` string (optional) - Shorthand state color.
* `activeColor` string (optional) - Shorthand state color.
* `activeBorderColor` string (optional) - Shorthand state color.
* `hover` [NativePanelStateStyle](native-panel-state-style.md) (optional) - Paint overrides.
* `hoverBackground` string (optional) - Shorthand state color.
* `hoverColor` string (optional) - Shorthand state color.
* `hoverBorderColor` string (optional) - Shorthand state color.
* `pressed` [NativePanelStateStyle](native-panel-state-style.md) (optional) - Paint overrides.
* `pressedBackground` string (optional) - Shorthand state color.
* `pressedColor` string (optional) - Shorthand state color.
* `pressedBorderColor` string (optional) - Shorthand state color.
* `focused` [NativePanelStateStyle](native-panel-state-style.md) (optional) - Paint overrides.
* `focusedBackground` string (optional) - Shorthand state color.
* `focusedColor` string (optional) - Shorthand state color.
* `focusedBorderColor` string (optional) - Shorthand state color.
* `invalid` [NativePanelStateStyle](native-panel-state-style.md) (optional) - Paint overrides.
* `invalidBackground` string (optional) - Shorthand state color.
* `invalidColor` string (optional) - Shorthand state color.
* `invalidBorderColor` string (optional) - Shorthand state color.
* `busy` [NativePanelStateStyle](native-panel-state-style.md) (optional) - Paint overrides.
* `busyBackground` string (optional) - Shorthand state color.
* `busyColor` string (optional) - Shorthand state color.
* `busyBorderColor` string (optional) - Shorthand state color.
* `disabled` [NativePanelStateStyle](native-panel-state-style.md) (optional) - Paint overrides.
* `disabledBackground` string (optional) - Shorthand state color.
* `disabledColor` string (optional) - Shorthand state color.
* `disabledBorderColor` string (optional) - Shorthand state color.

States apply in order: selected, active, hover, pressed, focused, invalid, busy,
disabled. Shorthand colors win over nested state colors. Parent foreground and
font changes inherit unless the child overrides them. System forced colors take
precedence. Focus, active navigation and selected presentation are independent.
