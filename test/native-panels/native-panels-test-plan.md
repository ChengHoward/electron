# Native panels acceptance plan

This suite is scoped to the Electron runtime. It does not launch or modify an
application that consumes the runtime. Run it only after the native-panel build
has completed. `run_native_panels.py --electron <new electron.exe>` records the
exact executable hash, runtime versions, individual assertions, OS windows,
display scales, and coverage limitations in `native-panels-results.json`.
The runner then executes `page-info-snapshot-edges.cjs` against that same binary
and merges its seven isolated snapshot/reentrancy cases into the report. Its raw
report and log retain the `-page-info-edges` suffix for independent inspection.
When Pillow is installed, the suite also saves the visible native panel body in
light, dark, and PageInfo states using Windows desktop composition. Each capture
checks the target HWND and samples all corners to ensure that only this test's
windows are included. Screenshots are optional; core tests use the Python
standard library and Win32. Native panel screenshots cannot use `capturePage()`.

## Automated gates

1. Export and support check; no renderer or WebContents creation by panels.
2. Strict constructor/content/theme/show/update validation and duplicate IDs.
3. Atomic invalid update: no appearance, bounds, content, input, or scroll change.
4. Visible native popup covers a live WebContentsView, extends outside the parent,
   fits the work area, has an owner, and has no taskbar/Alt+Tab entry.
5. Real OS button, toggle, input, option, keyboard, and scroll interaction.
   Action payloads identify the correct stable controls.
6. Unicode Chinese input; probe installed Chinese IMEs separately and report
   whether real composition and candidate-window coverage was available.
7. Stable input, focus, scroll, and native HWND across repeated content/theme
   updates, including ongoing Agent input.
8. Source page requestAnimationFrame, painted pixel changes, and trusted
   dispatchInputSequence continue while the panel is open. Native panel typing
   must not enter the page or lift existing real-input protection.
9. Outside click, Escape, explicit hide/show, parent hide/minimize/movement,
   rounded corner hit testing, large-radius child clipping, and focus return.
   A disposable native underlay window in a second process receives the original
   OS clicks through transparent corners and shadow outside the parent. No click
   is replayed. The independent shadow HWND is checked for layered, transparent,
   and non-activating styles.
10. Main-frame navigation/reload, destruction, renderer loss, and source host
    transfer invalidate old panels and prevent reuse or stale actions.
11. Parent destruction and repeated destroy release native windows and emit one
    closed event. Repeated show/update/hide cycles do not add WebContents.
12. PageInfo validates committed origin and host, reports live native UI, closes
    for navigation/transfer/destruction, and routes its site-settings event.

## Test isolation

The suite uses an isolated temporary profile, temporary local HTTP fixtures, and
its own visible BaseWindow/WebContentsView. The Windows driver only sends input
after verifying that the target foreground HWND and hit target belong to this
probe's PID or its explicitly spawned underlay fixture PID. It never clicks
unrelated applications, restores the prior cursor
and focus at completion, and closes only windows created by this probe.

## Physical boundaries

All detected display work areas and scale factors are recorded. Positioning is
tested on each currently connected display. Mixed-scale monitor transfer is
only verified when such displays are present. Automated Unicode key packets are
not described as real IME composition. Hardware touch/pen, physical trackpad
inertia, screen-reader spoken output, and absent monitor/IME configurations are
reported as coverage limits rather than passed assertions.

The internal `_getState` diagnostic is used to inspect actual native control
state and determine OS input targets; it is not a published interface. Test
actions still enter through Win32 input, and the driver independently checks
HWND ownership, visibility, bounds, styles, hit testing, and pixels.
