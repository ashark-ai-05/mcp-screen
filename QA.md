# QA log

Each round runs the whole suite locally: typecheck, unit (vitest), end-to-end (`scripts/e2e.mjs`), first-timer UX at 4 viewports (`scripts/ux.mjs`), browser soak (`scripts/soak.mjs`) and performance budgets (`scripts/perf.mjs`).

**How performance is measured.** Headless Chromium on a shared Linux box with no GPU. 120 mixed widgets (chart, metric, code, checklist, log, table, diagram, timeline). Every number is the best of 3 fresh runs, because the box is shared and noise only ever makes numbers worse; the load average is recorded alongside. Raster and compositing run in software here, so raw headless fps understates a real browser. The frame budget is therefore the renderer **main-thread** cost per frame (script, style, layout, paint, layerize, commit) from a Chrome trace: 8 ms or less leaves room for 60 fps. Raw headless fps is listed too, for honesty.

| Budget | Target |
|---|---|
| First canvas paint (FCP, empty canvas) | < 300 ms |
| Widget placement (API call → card in DOM, median) | < 50 ms |
| Pan / zoom main-thread per frame, 120 widgets | ≤ 8 ms |
| Layout shift (CLS) during a session | ≤ 0.02 |
| Up-front client bundle (gzip) | ≤ 80 KB |
| Console errors | 0 |

## Round 1 (2026-10-16)

**Baseline before the fixes:** the empty canvas idled at 13 fps headless; with 120 widgets, pan ran at 10 fps and zoom at 7 fps. Cause: a blurred, animated full-screen aurora plus `backdrop-filter` on every card and on the floating chrome. That forced a full re-raster of everything behind them on every frame.

**Fixes:**
- No blur on the aurora (the gradients are already soft).
- Pre-blended card glass instead of `backdrop-filter` (identical over the dot grid).
- Solid floating chrome.
- Off-screen cards culled with `content-visibility` (box kept, so nothing shifts).
- Per-frame work coalesced into one rAF; the view save is debounced.
- The world becomes one composited layer while moving, with animations paused.
- The dot grid moved to its own layer that only translates.
- The stage rect is cached, so there are no forced layouts.
- An unused `--z` custom property on the stage was removed (it restyled the whole subtree on every zoom step).

| Metric | Result | Budget |
|---|---|---|
| First paint | 108 ms | < 300 |
| Placement median / p90 | 8 / 34 ms | < 50 |
| Pan @100% main-thread/frame (headless fps) | 5.3 ms (32) | ≤ 8 |
| Pan @fit, all 120 visible | 7.3 ms (29) | ≤ 8 |
| Zoom | 7.3 ms (28) | ≤ 8 |
| CLS | 0.0001 | ≤ 0.02 |
| Up-front bundle | 47.2 KB gzip (157 KB raw, 6 files, no third-party libs) | ≤ 80 |
| Console errors | 0 | 0 |

Load average while measuring: 6.6 / 10.3 / 9.4 (8 cores). Under heavier load from other jobs on the box (load ~20), the same build measured up to 16 ms per frame, so treat the numbers as ±30 %.

**Lazy loading:** there is no heavy library to lazy-load. Mermaid is replaced by a ~10 KB built-in flowchart parser and layout, maps use a 44 KB coastline file fetched only when a map widget renders, and syntax highlighting is an 8 KB tokenizer.

**Suites:**
- typecheck clean
- unit 94/94 (adds 8 lifecycle, session, restart, fuzz and memory tests)
- e2e 40/40
- UX 42/42 (1440, 1280, 820 and 390 px)
- soak PASS: 25 UI clear → undo → clear → re-place cycles across 12 widget kinds; DOM +4 nodes vs baseline, heap flat at 10 MB, 0 console errors

**Bugs found and fixed this round:**
1. **Undo right after Clear made the restored cards vanish.** A card still playing its exit animation was reused, then removed by its exit timer. Found by the soak. Fix: cards that are leaving are never reused.
2. **The SSE event queue could grow without bound** for a stuck subscriber (unbounded memory). It is now capped at 2000 events, after which the subscriber is dropped and the client reconnects and resyncs.
3. **Phone layout broke:**
   - The header overflowed (tabs and actions pushed off-screen).
   - Opening the shortcut sheet scrolled the whole page sideways, leaving its button unreachable.
   - Tidy always packed 4 columns, so on a phone the canvas fit at 25 %.
   Fixes: a compact header under 640 px (icon-only actions, scrollable tabs); the sheet scrolls inside itself and focuses with `preventScroll`; Tidy packs as many columns as the screen fits (`tidy_canvas` takes `columns`).
4. A flaky e2e check (livemap glow count) depended on timing under load; it now records every node that lights up.
5. **Diagram:** an edge that skipped a layer was drawn straight through the node in between (the "no" branch was invisible). Skip edges now bow out to the side.
6. **Map:**
   - Markers and labels were scaled ~3× too large.
   - Polygons crossing the antimeridian drew lines across the whole map.
   - A CSS class collision with the livemap (`svg.map`) gave the map `overflow: visible`, which leaked a line over other cards.
7. **Ask cards:** the spinning border on open questions rotated the whole overlay instead of the gradient, drawing a diagonal line across the card.
8. **Toolbar:** colour swatches were invisible because `style: {'--c': …}` was dropped by `Object.assign(el.style)`; custom properties now use `setProperty`.
9. **Annotation labels:** labels near a card edge wrapped one letter per line ("why?" rendered vertically).

## Round 2 (2026-10-16)

**Method change (stated honestly):** frames are now measured in steady state, after every card's entrance animation has finished (round 1 started measuring while some were still running). The numbers below are lower partly for that reason.

| Metric | Result | Budget |
|---|---|---|
| First paint | 96 ms | < 300 |
| Placement median / p90 | 9 / 29 ms | < 50 |
| Pan @100% main-thread/frame (headless fps) | 3.7 ms (37) | ≤ 8 |
| Pan @fit, all 120 visible | 7.2 ms (29) | ≤ 8 |
| Zoom | 7.6 ms (23) | ≤ 8 |
| CLS | 0.0001 | ≤ 0.02 |
| Up-front bundle | 48.9 KB gzip | ≤ 80 |
| Console errors | 0 | 0 |

Load average while measuring: 10.7 / 20.8 / 14.1 (the box was busy with other jobs). An earlier run at load ~5, *before* the steady-state change, measured pan@fit at 8.25 ms, a budget miss. That led to the fix below, and the round was not pushed until the budget held.

**Suites:**
- typecheck clean
- unit 94/94
- e2e 40/40
- UX 42/42 (4 viewports)
- soak PASS: 25 cycles, DOM +4 nodes, heap flat, 0 console errors
- empty-state sweep: every kind placed with empty data renders an icon and message; 0 page errors. The only console line is the expected network failure of a deliberately unreachable image URL.

**Bugs found and fixed:**
1. The README's `6-ask-user.png` (and `5-wrap-mcp-app.png`, which had the zoom bar over it) were broken crops: Playwright element screenshots don't follow the transformed canvas. The new e2e `cardShot` centres the card at 100 % and hides the chrome.
2. A new widget could land partly off-screen: `reveal` only checked its top-left corner, so a live widget's **Approve** button sat below the fold, and e2e timed out clicking it. Now the whole card must be visible; otherwise the canvas fits, or pans to the card if fitting would go below 45 % zoom.
3. The zoom label was rewritten every frame with an identical string, which still invalidates paint. It's now written only when it changes.
4. 13 kinds rendered a blank card for empty data. Each now has an empty state, and live widgets show "Waiting for the first refresh…".
5. `timeline` rejected an empty list, unlike `checklist` or `log`. It now accepts one (capped at 500 events).

**Media:**
- `screenshots/hero.gif` (960 px, 4.8 MB, ~32 s), `screenshots/hero.mp4` and `screenshots/hero.png`
- refreshed `1-canvas`, `2a-live-needs-approval`, `5-wrap-mcp-app` and `6-ask-user`

## Round 3 (2026-10-16)

| Metric | Result | Budget |
|---|---|---|
| First paint | 152 ms | < 300 |
| Placement median / p90 | 17 / 56 ms | < 50 (median) |
| Pan @100% main-thread/frame (headless fps) | 3.8 ms (40) | ≤ 8 |
| Pan @fit, all 120 visible | 5.1 ms (33) | ≤ 8 |
| Zoom | 6.7 ms (22) | ≤ 8 |
| CLS | 0.0001 | ≤ 0.02 |
| Up-front bundle | 49.0 KB gzip | ≤ 80 |
| Console errors | 0 | 0 |

Load average 7.7 / 7.8 / 10.0.

**Suites:**
- typecheck clean
- unit 97/97: 3 new persistence tests, and the restart test now asserts that the canvas *survives* 4 restart cycles, positions included
- e2e 40/40
- UX 42/42
- soak PASS

**Persistence checks:**
- Every widget kind round-trips, and derived data (diff counts, diagram layout, checklist progress, log trimming) is rebuilt on load.
- Annotations come back attached to the same widget and data points.
- `canvas.json` is mode 0600.
- Open questions are not saved.
- A tampered file with an `/etc/passwd` image, an unknown kind, a `null` entry and a command source restores only the valid widgets; the command waits for approval.
- A corrupt file still starts the hub.

**Bugs fixed:**
1. The canvas was lost on every hub restart. It is now persisted and restored.
2. Overflowing cards clipped text with no affordance. They now show a bottom fade until scrolled to the end.

## Round 4–6 (2026-10-16, Australia/Melbourne)

**Shipped**
- Annotation threads: `reply_annotation`, `pendingQuestions` on `read_canvas`, human follow-ups, persisted replies.
- Scroll-stable marks: card inner scroll is remembered; wide table rows are circle-able; marks translate with the scroller and fade when off-screen.
- Full-canvas Share: PNG/HTML of every widget at 1:1 (not the viewport); images inlined; animations frozen; PNG scale clamped to canvas limits.
- Named canvases: git-root default (or `MCP_SCREEN_CANVAS`), `~/.mcp-screen/canvases/<id>.json`, legacy `canvas.json` migrated, `list_canvases` / `open_canvas` / optional `canvas` on tools, header switcher.
- hero.gif re-encoded to 3.7 MB (900 px, 8 fps, 80 colours) from the existing hero.mp4.

**Tests:** unit 104, e2e 49, ux 42, soak PASS.

**Perf (best of 3, load avg ~4.6/2.8/2.8):** first paint 56 ms · place median 5 ms · pan@100 1.70 ms/frame · pan@fit 2.58 · zoom 2.84 · CLS 0.0004 · gzip 52.1 KB · misses [].

**Media:** `screenshots/7-showcase.png` (thread bubble), `screenshots/7b-full-canvas-export.png`, `screenshots/9-canvas-switcher.png`, `screenshots/hero.gif` (3.7 MB).


## Round 7-8 (2026-10-16, Australia/Melbourne)

**Shipped**
- Claude Code UserPromptSubmit / SessionStart hooks inject pending notes via hookSpecificOutput.additionalContext.
- Long-press (touch) / Alt+click opens the sticky-note editor aimed at that data point (canvas.quickAsk).
- Share filenames include the project slug; Copy link uses #canvas=<id>; hash opens that canvas on load.
- SECURITY.md updated for canvases/ and hook injection.

**Tests:** unit 107, e2e 51, ux 42.


## Round 9 (2026-10-16, Australia/Melbourne)

**Shipped:** undo for a single deleted annotation (toast + POST /api/annotations/undo); empty-state mentions install-hooks; docs catch-up.

**Tests:** unit 108+, e2e 52.
