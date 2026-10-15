# Security

mcp-screen runs on your machine and shows things an AI agent decided to show you. Two parts deserve a clear explanation: the **MCP Apps sandbox** and **live refresh**.

## The local server

- It binds to `127.0.0.1` only (port 4747 by default).
- Every `/api/*` call needs a random per-run token. The token is embedded in the canvas page and stored in `~/.mcp-screen/hub.json` (mode `0600`) so hooks and other agent sessions can attach. There are no CORS headers, so other websites can't read the page or the token.
- Requests whose `Host` header isn't `127.0.0.1`, `localhost` or `[::1]` are rejected, which blocks DNS-rebinding attacks.
- The canvas page is served with a strict CSP (`script-src 'self'`, `frame-ancestors 'none'`). Widget data is always rendered as text nodes and never as HTML.

## MCP Apps (`wrap` mode) sandbox

`ui://` resources are HTML from a third-party MCP server, so mcp-screen treats them as hostile:

- They render in an `<iframe sandbox="allow-scripts allow-forms">` **without** `allow-same-origin`, which gives the frame an opaque (`null`) origin. It can't read the canvas DOM, the API token, cookies or storage.
- The HTML is served from `/frame/<id>?n=<nonce>` with a per-widget nonce (never the API token). The response has its own CSP: `default-src 'none'`, inline script/style only, and network access (`connect-src`, images, fonts) limited to the domains the resource declares in `_meta.ui.csp`. Anything that isn't a plain `http(s)://host` is dropped.
- The only channel out is the MCP Apps postMessage JSON-RPC bridge. The host accepts messages only from that exact frame's `contentWindow`. Only these calls are proxied:
  - `tools/call` and `resources/read`, back to the **same** wrapped server, which could already do anything it likes;
  - `ui/open-link`, for `http(s)` links only, opened with `noopener`;
  - `ui/message` and `ui/update-model-context`, stored as the widget's selection for the agent to read.
- Agents can't use `place_widget` to inject raw HTML. The `mcp-app` kind is only created by the wrap proxy from a real `ui://` resource.

## Live refresh (sources)

A widget can carry a `source` (a command, URL or MCP tool) that the server re-runs on an interval with no LLM in the loop. That is code execution, so:

- **Nothing runs until you click Approve** in the browser. There is no MCP tool for approving, so an agent can't approve its own source through MCP.
- An approval covers the **exact** source: argv array plus cwd, the exact URL, or the exact tool plus arguments. It is saved in `~/.mcp-screen/allowlist.json` (`0600`). A widget with a different argv needs approval again. **Stop** on a live widget revokes it.
- Commands run through `execFile` with **no shell**, so `;`, `$( )` and pipes are passed as literal arguments. Each run has a 10 s timeout and a 256 KB output cap, and the minimum interval is 2 s.
- URL sources must be `http(s)`, may not follow redirects, and have the same timeout and size limits.
- Commands run as you, with your environment. Approve them the way you'd approve a command in your agent's permission prompt.

### Known limits

- An agent that already has shell access on your machine can read `hub.json` and call the approve endpoint directly. The approval step protects against prompt-injected *MCP* usage, not against an agent that can already run arbitrary commands.
- Refreshed commands inherit your full environment, including any secrets in env vars.

## Questions, clearing and exports

- `ask_user` only collects a click. Choice labels and previews are rendered as text. There is no MCP tool to answer a question, so an agent can't answer its own question through MCP. Every wait has a hard limit of 15 minutes.
- `clear_canvas` keeps one undo snapshot in memory only. Open questions and forms are never put into the snapshot.
- Exports happen entirely in your browser; nothing is uploaded. The HTML export removes all scripts, iframes and `on*` attributes and carries a `default-src 'none'` CSP, so the file can't run code or make requests. MCP App frames are replaced with a placeholder. **An export contains whatever is on the canvas.** Check it before you share it.

## Images, maps and annotations

- **Local images** (`image` with `path`): the path must be absolute, end in png/jpg/jpeg/gif/webp/svg, resolve (after symlinks) to a regular file of at most 20 MB, and its magic bytes must match an image type. It is served only at `/img/<id>?n=<nonce>`, with the type taken from the sniffed bytes (never the extension) and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, so an SVG cannot run script. An agent can still show you any image file your user account can read. Treat an image widget like any other output from the agent.
- **URL images** (`image` with `url`): only `https:` and `data:image/` URLs are accepted. The page CSP allows `img-src https:` for this, so **your browser fetches the URL directly and that host sees your IP address and the request time**. Nothing else on the page loads from the network.
- **Maps** are fully offline: the coastlines are a bundled 44 KB Natural Earth 1:110m file (`public/world-110m.json`, public domain; see `public/LICENSE-world-atlas.txt`). There are no tiles, API keys or network requests.
- **Diagrams** use a built-in parser for a subset of Mermaid flowcharts. Mermaid itself (which needs `eval`) is not bundled. Labels render as SVG text, never as HTML.
- **Annotations** (your arrows, circles, highlights and notes) are stored only in the hub's memory and are readable by any agent connected to the canvas. Don't write secrets in notes. Text is rendered with `textContent`.
- **Forms** (`ask_form`): values are checked against the field definitions on the server before the agent sees them. There is no MCP tool that submits a form.

## What is stored on disk

`~/.mcp-screen/` (or `MCP_SCREEN_HOME`) holds:
- `hub.json`: port and token, mode 0600, removed on exit.
- `allowlist.json`: approved live sources.
- `canvas.json`: the canvas, mode 0600, written atomically. It contains your widgets' data and your annotations, so anything an agent put on the canvas is now on disk too. Set `MCP_SCREEN_NO_PERSIST=1` to keep the canvas in memory only.

On start, every saved widget goes back through the same validation as `place_widget`: image paths are re-checked, and a saved command source still needs the allow-list before it runs. A hand-edited file can't add anything the tools would reject. Open questions, open forms and MCP App frames are never saved.

## Reporting

Please report vulnerabilities privately through GitHub Security Advisories on the repository rather than in a public issue.
