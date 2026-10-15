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
