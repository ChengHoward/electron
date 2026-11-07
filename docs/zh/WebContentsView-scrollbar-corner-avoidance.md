# WebContentsView scrollbar corner avoidance

Date: 2026-11-07. Edition: **desktop**. Published release: **45.0.0-desktop.3**, Windows x64 only. The compact-clearance runtime is rebuilt and validated; package installation/publication state belongs to the matching release manifest. cloudbypass.2 and desktop.2 remain unchanged.

## Required behavior

Keep the upstream Fluent scrollbar appearance, width/height, rounded thumb, arrows, colors, transparency and hover behavior. Small host radii such as 8, 12 and 16 DIP should keep the arrow and thumb complete with a compact gap resembling the native scrollbar next to a rounded container.

`WebContentsView.setBorderRadius(radius)` supplies a nonnegative radius clamped to half the view size. Host-owned renderer preferences update the main document's default scrollbar frame. Rendering, button/track hit testing, dragging and compositor geometry share that frame. No page CSS or JavaScript is injected.

The compact refinement solves the host circular boundary at the expanded native thumb's outer edge, reserving one DIP for arrow glyph rounding, fallback glyphs and anti-aliasing. This shortens the frame only by the clearance needed for the native ink rather than by the entire corner radius. The track/button background continues to follow the host rounded mask; background clipping at the arc is expected. Other native themes conservatively retain full-radius clearance.

Both orientations, a single scrollbar and the shared scrollbar corner are supported. Author `::-webkit-scrollbar` styles, nested overflow boxes and iframe scrollbars keep their original geometry. CSS scrollbar widths and colors retain upstream behavior. Radius zero restores the original geometry. Tiny viewports retain Chromium's existing behavior when there is too little space for buttons or a thumb.

## Edition and fallback

This is desktop UI customization. `enable_desktop_customizations = false` disables the new default in a foundation build. That build argument gates this addition; it does not isolate all historical desktop patches. Windows desktop enables it by default. Before app ready, `app.commandLine.appendSwitch('disable-desktop-scrollbar-corner-avoidance')` restores the original scrollbar layout.

## Source and patch

Electron: `shell/browser/api/electron_api_web_contents_view.*`, `electron_api_web_contents.cc`, and desktop build flags. Chromium: renderer preferences serialization, `WebViewImpl` relayout notification, and `PaintLayerScrollableArea` scrollbar geometry. The focused Chromium patch is `patches/chromium/feat_desktop_web_contents_scrollbar_corner_avoidance.patch`, registered in `.patches`.

Every new customization and refinement must be classified and recorded in the feature guide, short log, detailed log and development guide as applicable. Keep `main/docs` and `src/electron/docs/zh` synchronized. The edition/developer requirements at the top of `定制开发编译与更新.md` are mandatory reading for new customization developers.

## Validation and evidence

Evidence root: `D:/electron/edist-publish/desktop-scrollbars`. Matching executable/archive/npm hashes, final reports, installation checks and publication status belong to the desktop.3 release manifest.

- The earlier full-radius preview passed 18/18 interaction checks, 2/2 disable checks and 4/4 existing offline Agent regressions. It was not publicly released. The user requested tighter small-radius geometry before publication; the previous staging bundle is marked superseded and cannot be published.
- Before the compact refinement, the six new small-radius interaction checks passed 1/6. This confirms that the old preview leaves too much space for the requested compact arrow positions.
- Native Windows occlusion classified a visible/focused test window as hidden during release testing. Both source and packaged runtimes were affected. Test launchers disable `CalculateNativeWinOcclusion`; product defaults are unchanged. Initial diagnostic failures are retained separately.
- Test scroll resets are instant and allow 350ms settling. A prior 100ms reset sampled an in-flight native scroll animation; its 17/18 result is retained in diagnostics.
- Native-window screenshots are accepted only after verifying the fixture's magenta surrounding margin. Captures use HWND client coordinates and physical DPI. Pixels from other applications are not published. Renderer-only captures demonstrate layout but do not prove the host mask preserves native ink.
- Native mask verification compares scrollbar ink in renderer captures with the fixture screenshot, checking that no ink falls into the host's cutout. Include both small radii and a large-radius regression, both orientations, and top/bottom thumb positions.
- Environment: Windows x64, 175% system scale; interaction checks include 125% page zoom. Other DPI values, mixed-DPI monitor movement, physical input-device matrices and other operating systems are outside this run's validation scope.

## Superseded compact-only preview acceptance

Executable SHA-256: `ed383b6bc913e89110de401c2a3757a7e763ea824bc9e747d45496ec147bbda4`. Interaction checks: **24/24**. Runtime fallback: **2/2**. Existing offline Agent regressions: **4/4**. Native-mask image comparisons: **7/7**, with **0** native ink pixels outside the host mask. Includes radii 8/12/16/48 DIP, vertical and horizontal scrollbars, both bars, and the bottom thumb position. The isolated npm installation must use this exact executable and pass the same 24 interaction checks plus public TypeScript validation before publication.

Superseded compact-only npm installation passed: package version 45.0.0-desktop.3, executable/types/embedded checksum hashes matched, **24/24** packaged-runtime interaction checks passed, and public TypeScript smoke validation passed. ZIP SHA-256: `f1e7aa70eea8f23a616f006053c902751d7aeff477e76f80423756f1f7fea520`. Matching package/publication manifest: `D:/electron/edist-publish/desktop-release-45.0.0-desktop.3-compact/desktop-build-manifest.json`.


## setBorderRadius scrollbarInset option

Edition: **desktop**, Windows x64. The pending desktop.3 API is `view.setBorderRadius(radius, { scrollbarInset: pixels })`; no separate setter is added. The second argument is optional. A nonnegative integer from 0 to 1000000 specifies exact clearance in DIP at both ends of each default main-document scrollbar. Zero restores the original scrollbar geometry. Omission, an omitted property, `undefined`, or a property value of `null` selects automatic compact clearance. Each invocation replaces prior options; calling `setBorderRadius(radius)` also returns to automatic clearance.

An explicit inset applies even when the host radius is zero. The host rounded mask remains active; manual values override automatic ink clearance. The runtime disable switch has priority over manual insets. Invalid values or a non-object options argument throw TypeError before changing the radius or current inset. Updates at the same radius still relayout, and navigation, resizing, attachment and transfer preserve the setting. Excessive valid values are limited by the available frame length. Author scrollbars, nested overflow and iframes remain excluded.

This refinement requires a new binary, generated public types and matching runtime/package verification. The earlier full-radius and compact-only desktop.3 staging bundles were superseded before public release. Final option-aware evidence will be recorded under `D:/electron/edist-publish/desktop-scrollbars-options`, with package/publication state in `D:/electron/edist-publish/desktop-release-45.0.0-desktop.3-options/desktop-build-manifest.json`. The initial manual-option baseline passed 5/14; nine checks failed because the earlier binary ignored the second argument. Final guards additionally verify arrow-sized deltas and the maximum inset on a tiny view.

## Final option-aware runtime acceptance

Executable SHA-256: `5808bd088b261cc0ad0506848a594a76b19a091aa3cac868c85b53db09e3d7ba`. Final interaction checks **39/39**, runtime fallback (including explicit override priority) **3/3**, existing offline Agent regressions **4/4**, native-window ink/mask comparisons **12/12** with zero clipped ink pixels in the fixture checks. Native checks include automatic 8/12/16/48-DIP radii and explicit 4/6/32-DIP insets. The native theme source is text-identical to the pre-change snapshots; only LF/CRLF line endings differ. Public type generation and the source TypeScript smoke suite passed. Runtime, pixel and launch-condition reports are in `D:/electron/edist-publish/desktop-scrollbars-options`. The tracked visual fixture is `test/web-contents-view-scrollbar-corners-visual.cjs` with `test/capture-scrollbar-corners.py` (Python/Pillow required). Package installation/publication status belongs to the final option-aware release manifest and receipts.

Final package verification: the isolated mirror installation matched version 45.0.0-desktop.3 and all executable/types/checksum hashes. Packaged runtime **39/39** and public TypeScript smoke (including `scrollbarInset`) passed. The first package run was 38/39, missing the iframe arrow interaction. The test now waits for two child animation frames and a compositor copy before input; arrow-step assertions are unchanged. Both source and packaged executables then passed 39/39 with the exact same executable bytes. The initial report and readiness diagnostic are retained in release evidence. ZIP SHA-256: `0cee4ec2a89ef18e2f075a63970e1a321f83fdfb8bb11f6a789c751587d86bbc`.

## Published desktop.3

[desktop 45.0.0-desktop.3](https://github.com/ChengHoward/edist/releases/tag/v45.0.0-desktop.3) is published for Windows x64. **Only WebContentsView** implements this scrollbar corner avoidance and its `setBorderRadius(radius, { scrollbarInset })` extension; ordinary View and BrowserWindow do not automatically enable it. Default behavior is automatic compact clearance. Explicit nonnegative integer DIP values override it; zero disables avoidance, and omission/null restores automatic calculation.

[Publication verification receipt](https://github.com/ChengHoward/edist/releases/download/v45.0.0-desktop.3/publication-verification.json) confirms GitHub asset digests, public ZIP/npm downloads and hashes, local mirror tags/files, packaged 39/39 runtime checks, public types and the native-mask evidence. The code revision is `40161a3436c928195592371b881cb85c757eb076`; subsequent publication-only documentation updates do not change the released binary. cloudbypass remains 45.0.0-cloudbypass.2 and historical desktop.2 downloads are preserved.
