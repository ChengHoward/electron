# WebContentsView scrollbar corner avoidance

Date: 2026-11-07. Edition: **desktop**. Release target: **45.0.0-desktop.3**. Windows x64 runtime validation passed; installation/publication state is recorded in the matching release manifest. Published desktop.2 and cloudbypass.2 are unchanged.

## Scope

- Windows x64 desktop builds only. `enable_desktop_customizations = false` disables the new default in a foundation build. `--disable-desktop-scrollbar-corner-avoidance` restores the original scrollbar layout at runtime.
- Reuse upstream Fluent scrollbar appearance: width/height, rounded thumbs, arrows, colors, transparency and hover behavior are unchanged.
- `WebContentsView.setBorderRadius(radius)` supplies a nonnegative, view-size-clamped host radius to the renderer. Default main-document scrollbar frames are shortened at both ends, including horizontal bars and the shared corner allowance.
- The scrollbar frame controls rendering, arrow and track hit testing, thumb dragging and compositor geometry. The implementation must not merely shift the painted arrow icon.
- Do not change author `::-webkit-scrollbar` controls, nested overflow boxes, iframe scrollbars, web page styles, or non-Windows UI defaults. CSS scrollbar colors and widths retain the upstream behavior.
- Resetting the radius to zero restores the original frame geometry. Radius changes, view resizing, zoom, navigation and transfer between host windows need runtime regression coverage.
- Tiny viewports may have too little length for buttons or a thumb; retain Chromium's small-scrollbar behavior rather than creating negative rectangles.

## Source and evidence

Electron: `shell/browser/api/electron_api_web_contents_view.*`, `electron_api_web_contents.cc`, and desktop build flags. Chromium: renderer preferences serialization, `WebViewImpl` relayout notification, and `PaintLayerScrollableArea` scrollbar frame geometry. A focused Chromium patch must be registered in `.patches`.

Local build and runtime evidence is collected under `D:/electron/edist-publish/desktop-scrollbars`. The old desktop.2 screenshots prove only the pre-change clipping behavior. They are not acceptance evidence for this feature.


## Local validation (2026-11-07)

- New preview: **18/18** corner-avoidance checks passed. The unchanged desktop.2 baseline passes 8/18 and fails the 10 checks that require the new avoidance behavior.
- Runtime disable switch: **2/2** fallback checks passed. Existing offline Agent style/render-process-exit regression: **4/4** passed.
- Coverage includes both scrollbar orientations, a single scrollbar, arrow-sized scroll steps, unused corner hit areas, thumb dragging, live radius changes, radius zero, view resizing, 125% page zoom, cross-window transfer, author scrollbars, nested overflow, iframe exclusion and a tiny view with an excessive radius.
- Environment: Windows x64, system scale 175%. Screenshots are OS window captures. Other DPI values, mixed-DPI multi-monitor movement, hardware input devices and other operating systems were not validated by this run.
- Executable SHA-256: `2a7142cd5136e257676832f9c4cc08f756b8aaa8c10ca02d804b6e6cbb252b1a`. Full report: `D:/electron/edist-publish/desktop-scrollbars/verification.json`; individual results and screenshots are in `runtime/`, `disabled/` and `baseline/` below that directory.
- This accepted executable is used for desktop.3. desktop.2 and cloudbypass.2 remain unchanged. The separate desktop.3 release manifest records archive/npm checksums, isolated installation, packaged-runtime validation and publication verification.


## Packaged installation validation

The desktop.3 package was installed from an isolated mirror. Executable, archive, npm integrity and public-type hashes matched; packaged-runtime input checks passed 18/18 and the public TypeScript smoke check passed. During release validation, Windows native occlusion classified the test page as hidden even though its host window was visible and focused. This affected the source executable too. The initial package run passed 3/18 (input was ignored). The successful release input checks used the test-only launch argument `--disable-features=CalculateNativeWinOcclusion`; product defaults and executable bytes were unchanged. Reports include the first failed attempt and the launch conditions. Desktop screenshots captured while the window was occluded are excluded from published assets; this release rerun does not claim a new visual screenshot acceptance.
