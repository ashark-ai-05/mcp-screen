# mcp-screen: product notes

A running critique, written as the product owner before each round of work. Short on purpose.

## Round 1 (2026-10-16)

**Who it's for.** People who run a terminal coding agent (Claude Code, Codex, Cursor CLI, Gemini CLI) and keep wanting the agent to *show* them something: a chart of CI failures, a diff, a plan, a flow. Secondary: people running several agents at once who want one place to see what each one did.

**First 60 seconds.** `npx mcp-screen` → a browser tab opens on an empty dark canvas with one hint ("ask your agent to show you something"). Nothing happens until the agent calls a tool, and a first-timer has no idea which keys do what. The new infinite canvas plus annotations is powerful but invisible: there's no hint that you can circle things for the agent, and no shortcut sheet.

**What would make someone star or share it.** The moment the agent puts a real chart on screen, you circle the spike, type "why?", and the agent answers about *that bar*. That loop is unique, and the README should lead with it. A canvas that feels instant (pan and zoom like Figma) is the second thing people notice.

**Weakest part right now.**
1. Performance with many widgets: in headless profiling, the animated blurred aurora and backdrop-filters re-rastered the whole screen every frame (13 fps idle on the empty page).
2. Discoverability: the empty state doesn't teach annotations, there's no `?` shortcut sheet, and nothing has been tested at small viewports.
3. Robustness: clear, undo and re-place over many cycles, several sessions and hub restarts have never been stress-tested, and tool inputs have never been fuzzed.

**This round:** perf budgets plus a measurement script and fixes; onboarding (empty-state coach with a mini demo, a `?` shortcut sheet, tooltips); a lifecycle and fuzz test suite.

## Round 2 (2026-10-16)

**Who it's for:** unchanged. Round 1 made the canvas fast and teachable; now the question is whether it *looks* worth sharing.

**First 60 seconds now.** A three-step explainer, then **Try a sample canvas**, which shows a chart, plan and flow in about a second with a "circle the tallest bar" hint. That's good. But the README still opens with the old demo (an ask_user + theatre clip) that never shows the new hook, the "circle it and the agent reads it" loop.

**What would make someone star or share it.** A 30-second GIF where widgets land, someone circles a spike, and the agent answers about *that* bar. Also, cards that never look broken: a widget that has no data yet currently renders as an empty dark box, which reads as a bug in screenshots.

**Weakest part right now.**
1. Empty and loading states: 13 of 17 kinds render a blank card when their data is empty, a live widget awaiting its first refresh looks dead, and a failed image is a bare red line.
2. Hero media is out of date. `6-ask-user.png` in the README had silently become a 374×128 crop of the header, because element screenshots don't work on a transformed canvas.
3. A newly placed widget could land half off-screen (reveal only checked the top-left corner), which hid the **Approve** button of a live widget.

**This round:** an empty or loading state for every kind; image skeleton and fade-in; a styled error state; an empty map overlay; timelines that may start empty. Plus a new hero GIF and MP4 from real tool calls (scripted agent, labelled), card screenshots centred via a new `focusOn`, a whole-card `reveal`, and a README rewrite of the hook.

## Round 3 (2026-10-16)

**Who it's for:** unchanged. The question this round: would someone *keep* it open all day?

**First 60 seconds:** good now (explainer, sample canvas, `?` sheet, hero GIF that shows the hook). The next 60 *minutes* are the problem.

**What would make someone star or share it.** Trust. The canvas is a working surface you arrange by hand: drag, tidy, circle things, leave notes. Losing all of that whenever the agent session restarts (every `claude` relaunch restarts the stdio server, which restarts the hub) quietly teaches people not to invest in the canvas.

**Weakest part right now.**
1. Everything on the canvas lived in hub memory only. A restart wiped widgets, positions and annotations, and the README admitted it.
2. A markdown or notes card that overflows just clips mid-sentence (see "Agent notes" in `1-canvas.png`), with no hint that it scrolls.

**This round:**
- Persist the canvas to `~/.mcp-screen/canvas.json`: mode 0600, atomic, debounced.
- Restore through the full validation path. Saved commands still need the allow-list; tampered entries are skipped.
- Skip open asks and MCP App frames.
- A "scroll for more" fade on overflowing cards.
- Docs: what is stored on disk, plus honest remaining gaps.

## Round 4 (2026-10-16)

**Who it's for:** unchanged. The unique loop (circle → agent answers about that bar) was silent: the agent could read the mark, but the human never saw the answer on the canvas.

**First 60 seconds:** the hero still sells the hook; what's missing is the answer appearing next to the circle.

**What would make someone star or share it.** Watching the agent reply in a bubble attached to your circle — then typing a follow-up. Closing that loop on the canvas itself.

**Weakest part right now.**
1. Annotation Q&A lived only in the agent's chat; the canvas never showed the answer.
2. Share exported the viewport, so a tidy canvas for a friend was cropped.
3. Circling scrolled table rows / log lines bound the wrong (viewport-top) points.

**This round:** `reply_annotation` + `pendingQuestions`; thread UI; full-canvas Share; scroll-stable marks; hero.gif under 4 MB.

## Round 5 (2026-10-16)

**Who it's for:** people who run agents in more than one repo. One shared canvas mixed projects together.

**First 60 seconds:** fine for one project. Day two, across two repos, is where it falls over.

**What would make someone star or share it.** Opening the tab and seeing *this* project's canvas, with a one-click switch to another.

**Weakest part right now.** A single canvas per machine; agents in different repos wrote on top of each other.

**This round:** named canvases derived from the git root (or `MCP_SCREEN_CANVAS`), persisted under `~/.mcp-screen/canvases/`, `list_canvases` / `open_canvas` / optional `canvas` on tools, header switcher.

## Round 6 (2026-10-16)

**Critique after rounds 4–5.** The product loop is finally visible end-to-end: place → circle → agent replies on the mark → human follows up → switch project. Remaining gaps that would block a public launch:

1. **No mobile annotation story.** Phone viewports get the canvas but drawing a precise circle on a bar is awkward; there's no tap-to-ask on a data point.
2. **Agent discovery of pending questions.** `pendingQuestions` exists, but nothing pokes the agent when a new note arrives (no hook / notification); humans still have to wait for the next turn.
3. **Canvas switcher discoverability.** Pills only appear once a second canvas exists; a first-timer never sees them.

**Done immediately after the critique:** pulsing “N waiting” on the notes pill; the canvas switcher always shows a “+ project” affordance so named canvases are discoverable before a second canvas exists.

**Next highest-impact (for a later night):**
1. An optional Claude Code hook that injects “you have N notes waiting on the canvas” when `pendingQuestions` is non-empty.
2. Tap a chart bar / table row on touch devices to leave a note without drawing.
3. Per-canvas Share filename and a “copy link to this canvas” that is still localhost-only but names the project.
