# MenuAppearance Object

Windows popup appearance, scoped to this menu and its submenus. Omitted values
use the defaults below. Unsupported platforms reject `appearance`.

* `theme` string (optional) - `system`, `light`, or `dark`. Default is `system`.
* `width` Integer (optional) - Minimum main menu width in DIP, from `120` through `1600`. Default is `240`.
* `submenuWidth` Integer (optional) - Minimum submenu width, from `80` through `1600`. Default is `180`.
* `fontFamily` string (optional) - Font family. Default is `Segoe UI`.
* `fontSize` Integer (optional) - Font size from `6` through `48`. Default is `14`.
* `rowHeight` Integer (optional) - Minimum row height from `20` through `100`. Default is `30`.
* `radius` Integer (optional) - Outer radius from `0` through `64`. Default is `16`.
* `itemRadius` Integer (optional) - Hover radius from `0` through `50`. Default is `12`.
* `padding` Integer (optional) - Outer content padding from `1` through `32`. Default is `4`.
* `itemPadding` Integer (optional) - Total horizontal padding inside a row, excluding the outer `padding`, from `0` through `64`. Default is `12`. System menu component padding is not added to this value.
* `separatorInset` Integer (optional) - Separator horizontal inset from `0` through `100`. Default is `12`.
* `separatorSpacing` Integer (optional) - Separator row height from `1` through `64`. Default is `14`.
* `background` string (optional) - Background color.
* `foreground` string (optional) - Foreground color.
* `hover` string (optional) - Hover color and base color for segment backgrounds.
* `border` string (optional) - Base color for the default border painting path, separators and segment outlines. Separators and segment borders also use `background` to derive their colors.

Colors accept `#RRGGBB` or `#AARRGGBB`. Labels come from the host; setting the
application language does not translate custom menu labels. Theme is resolved
when the popup opens. The configuration does not change other menus or the
process-wide Chromium MenuConfig.

For a text-only menu, the text inset from the content edge is `itemPadding`;
the outer `padding` is applied separately. Customized rows do not add Chromium's
system component spacing of 8 DIP. Menus with icons reserve a shared icon column
before their labels.

Separator color is a 50/50 blend of `border` and `background`. Segment borders,
backgrounds and hover states use separate blends of the existing theme colors;
they are not guaranteed to match the separator or outer border exactly.
The Windows bubble menu's outer hairline is drawn by Chromium's BubbleBorder
theme; `border` does not precisely override that hairline in every border path.
