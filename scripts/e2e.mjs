#!/usr/bin/env node
// End-to-end: start mcp-screen (wrap mode around the demo MCP App server) as a real stdio MCP
// server, drive every tool with a scripted MCP client, fire real hook payloads through
// `mcp-screen hook`, and take headless screenshots + a demo video/GIF with Playwright.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'screenshots');
const PORT = Number(process.env.E2E_PORT ?? 4791);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-screen-e2e-'));
const GIF = process.argv.includes('--gif'); // the README GIF comes from scripts/record-demo.mjs
fs.mkdirSync(SHOTS, { recursive: true });
const env = { ...process.env, MCP_SCREEN_HOME: HOME, MCP_SCREEN_NO_OPEN: '1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

// ---- 1. start mcp-screen as a stdio MCP server (wrap mode) ----
const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'dist/cli.js'), 'wrap', '--port', String(PORT), '--', process.execPath, path.join(ROOT, 'examples/demo-app-server.mjs')],
    env,
    stderr: 'inherit',
  }),
);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  const t = r.content[0].text;
  try { return JSON.parse(t); } catch { return t; }
};
const tools = (await client.listTools()).tools.map((t) => t.name);
check('tools/list has screen tools + upstream tools', ['place_widget', 'update_widget', 'read_widget', 'read_canvas', 'post_report', 'flaky_tests', 'quarantine_test'].every((t) => tools.includes(t)), tools.join(','));

const URL_ = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  ...(GIF ? { recordVideo: { dir: path.join(HOME, 'video'), size: { width: 1440, height: 900 } } } : {}),
});
const page = await ctx.newPage();
// screenshot one card: centre it at 100% and hide the canvas chrome for the shot
const cardShot = async (sel, file) => {
  const id = await page.locator(sel).first().getAttribute('data-id');
  await page.evaluate((id) => window.__mcpScreen.canvas.focusOn(id, 1), id);
  const st = await page.addStyleTag({ content: '.toolbar,.zoombar,.minimap,.notes-count,.toast{visibility:hidden!important}' });
  await sleep(400);
  await page.locator(sel).first().screenshot({ path: path.join(SHOTS, file) });
  await st.evaluate((n) => n.remove());
};
await page.goto(URL_);
await page.waitForSelector('.conn.on');
await sleep(800);
await page.screenshot({ path: path.join(SHOTS, '0-empty.png') });

// ---- 2. core canvas: widgets placed by the "agent" ----
const days = Array.from({ length: 14 }, (_, i) => `10/${String(i + 1).padStart(2, '0')}`);
const fails = [3, 5, 2, 8, 4, 1, 0, 6, 9, 3, 2, 7, 4, 2];
await call('place_widget', { id: 'ci-chart', kind: 'chart', title: 'CI failures · last 14 days', data: { type: 'bar', labels: days, values: fails, linkTo: 'ci-table' }, w: 2, h: 2 });
await sleep(400);
const rows = [];
const jobs = ['e2e', 'unit', 'lint', 'build'];
days.forEach((d, i) => { for (let k = 0; k < Math.min(fails[i], 2); k++) rows.push([d, jobs[(i + k) % 4], ['checkout.spec.ts', 'auth.test.ts', 'eslint', 'tsc'][(i + k) % 4], k === 0 ? 'flaky' : 'real']); });
await call('place_widget', { id: 'ci-table', kind: 'table', title: 'Failed runs', data: { columns: ['day', 'job', 'where', 'kind'], rows }, w: 2, h: 2 });
await sleep(400);
await call('place_widget', { id: 'fail-rate', kind: 'metric', title: 'Failure rate', data: { value: '6.8%', label: 'of 822 runs', delta: -1.2 }, w: 1, h: 1 });
await call('place_widget', { id: 'notes', kind: 'markdown', title: 'Agent notes', data: { markdown: '## What stands out\n- **e2e** fails cluster on Oct 4 and Oct 9\n- `checkout.spec.ts` is the top flaky test\n- Click a bar to filter the runs table' }, w: 1, h: 1 });
await sleep(400);
const app = await client.callTool({ name: 'flaky_tests', arguments: { days: 30 } });
check('wrap: ui:// tool result rendered as widget', /Rendered ui:\/\/demo-ci\/flaky-tests/.test(JSON.stringify(app.content)));
await sleep(1500);

// human clicks a bar -> agent reads the selection
await page.locator('svg.chart .bar').nth(8).click();
await sleep(600);
const chartRead = await call('read_widget', { id: 'ci-chart' });
check('read_widget sees the bar the human clicked', chartRead.selection?.label === '10/09', JSON.stringify(chartRead.selection));
check('chart click filters the linked table', (await page.locator('.filter').count()) === 1 && (await page.locator('table.t tbody tr').count()) === 2);

// the MCP App calls a server tool through the postMessage bridge
const frame = page.frameLocator('iframe.app-frame');
await frame.locator('text=checkout › applies coupon').waitFor({ timeout: 10000 });
check('MCP App completed ui/initialize and got the tool result', true);
await frame.locator('button').first().click();
await frame.locator('button.done').first().waitFor({ timeout: 10000 });
await sleep(500);
const appId = (await call('read_canvas')).widgets.find((w) => w.kind === 'mcp-app').id;
const appRead = await call('read_widget', { id: appId });
check('MCP App tools/call proxied upstream + update-model-context reached the agent', appRead.selection?.structuredContent?.quarantined === 'checkout › applies coupon', JSON.stringify(appRead.selection));
const origin = await page.evaluate(() => {
  const f = document.querySelector('iframe.app-frame');
  try { return f.contentWindow.document.body ? 'readable' : 'x'; } catch { return 'blocked'; }
});
check('app iframe is cross-origin (null origin sandbox)', origin === 'blocked' && (await page.locator('iframe.app-frame').getAttribute('sandbox')) === 'allow-scripts allow-forms');
await page.screenshot({ path: path.join(SHOTS, '1-canvas.png') });
await cardShot('.card.app', '5-wrap-mcp-app.png');

// a second agent session (another `npx mcp-screen`) attaches to the same canvas
const second = new Client({ name: 'e2e-agent-2', version: '1.0.0' });
await second.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'dist/cli.js'), '--port', String(PORT)], env, stderr: 'ignore' }));
await second.callTool({ name: 'place_widget', arguments: { id: 'from-second', kind: 'text', title: 'second session', data: { text: 'hello' } } });
check('a second MCP session attaches to the running canvas', (await call('read_canvas')).widgets.some((w) => w.id === 'from-second'));
await second.callTool({ name: 'remove_widget', arguments: { id: 'from-second' } });
await second.close();

// ---- 3. live widgets ----
await call('remove_widget', { id: 'notes' });
await call('update_widget', { id: 'fail-rate', title: 'Failure rate (7d)' });
await call('place_widget', {
  id: 'ci-status', kind: 'status-list', title: 'Pipelines (live)', w: 1, h: 2,
  data: { items: [{ label: 'waiting for approval', status: 'unknown' }] },
  source: { type: 'command', argv: [process.execPath, path.join(ROOT, 'scripts/demo-ci-status.mjs')], parse: 'json' }, intervalMs: 2000,
});
await call('place_widget', {
  id: 'load', kind: 'metric', title: 'Box load (live)', w: 1, h: 1, data: { value: '—' },
  source: { type: 'command', argv: [process.execPath, '-e', 'const o=require("os");console.log(JSON.stringify({value:o.loadavg()[0].toFixed(2),label:"1-min load average"}))'], parse: 'json' }, intervalMs: 2000,
});
await sleep(800);
const pending = await call('read_widget', { id: 'ci-status' });
check('live source waits for approval (nothing ran)', pending.status === 'needs-approval' && !pending.lastRefreshedAt);
await page.locator('.card[data-id="ci-status"]').scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(SHOTS, '2a-live-needs-approval.png') });
await page.locator('.card[data-id="ci-status"] .btn.primary').click();
await sleep(300);
await page.locator('.card[data-id="load"] .btn.primary').click();
await sleep(2600);
check('MCP App frame survived canvas re-layout (state kept)', (await frame.locator('button.done').count()) === 1);
const live1 = await call('read_widget', { id: 'ci-status' });
await sleep(4200);
const live2 = await call('read_widget', { id: 'ci-status' });
check('approved source refreshes server-side on its interval', live1.status === 'live' && live2.lastRefreshedAt !== live1.lastRefreshedAt, `${live1.lastRefreshedAt} -> ${live2.lastRefreshedAt}`);
const allow = JSON.parse(fs.readFileSync(path.join(HOME, 'allowlist.json'), 'utf8'));
check('approval persisted to the allow-list', allow.approved.length === 2);
await page.screenshot({ path: path.join(SHOTS, '2-live-widgets.png') });

// ---- 4. standup board: real hook payloads through `mcp-screen hook` ----
const demo = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-screen-demo-'));
const hook = (payload) => spawnSync(process.execPath, [path.join(ROOT, 'dist/cli.js'), 'hook'], { input: JSON.stringify(payload), env, encoding: 'utf8' });
function worktree(name, branch, files) {
  const dir = path.join(demo, name);
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', branch); g('config', 'user.email', 'demo@local'); g('config', 'user.name', 'demo');
  for (const [f] of files) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), 'export {};\n'); }
  g('add', '.'); g('commit', '-qm', 'base');
  for (const [f, lines] of files) fs.writeFileSync(path.join(dir, f), Array.from({ length: lines }, (_, i) => `// line ${i}`).join('\n'));
  return dir;
}
function transcript(dir, summary, testCmd, testOut) {
  const p = path.join(dir, '..', `${path.basename(dir)}-${Math.random().toString(36).slice(2, 6)}.jsonl`);
  const L = (o) => JSON.stringify(o);
  fs.writeFileSync(p, [
    L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: testCmd } }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: testOut }] } }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: summary }] } }),
  ].join('\n'));
  return p;
}
const api = worktree('shop-api', 'feat/coupons', [['src/coupons/validate.ts', 42], ['src/coupons/validate.test.ts', 30], ['src/routes/checkout.ts', 8]]);
const web = worktree('shop-web', 'fix/cart-flicker', [['app/cart/CartDrawer.tsx', 19], ['app/cart/useCart.ts', 6]]);
const pay = worktree('payments-wt', 'chore/stripe-sdk-v15', [['package.json', 3], ['src/stripe/client.ts', 27]]);
const r1 = hook({ hook_event_name: 'Stop', session_id: 'a1b2c3d4e5', cwd: api, transcript_path: transcript(api, 'Added coupon validation (expiry, min basket, single-use) and wired it into checkout.\n- Risk: legacy coupons without an expiry are treated as valid', 'npx vitest run', '      Tests  38 passed (38)') });
await sleep(700);
hook({ hook_event_name: 'SubagentStop', agent_type: 'test-writer', session_id: 'a1b2c3d4e5', cwd: api, transcript_path: transcript(api, 'Wrote 12 edge-case tests for coupon stacking. Two cases are skipped pending a product decision.\n- TODO: decide whether percentage + fixed coupons may stack', 'npx vitest run coupons', '      Tests  1 failed | 11 passed (12)') });
await sleep(700);
hook({ hook_event_name: 'Stop', session_id: 'f9e8d7c6b5', cwd: web, transcript_path: transcript(web, 'Fixed the cart drawer flicker by memoising the line items and moving the fetch into useCart.', 'pnpm test', 'Tests:       24 passed, 24 total') });
await sleep(700);
await call('post_report', { agent: 'codex', worktree: 'payments-wt', branch: 'chore/stripe-sdk-v15', summary: 'Bumped the Stripe SDK to v15 and migrated the two call sites that used the removed `charges` API.', filesChanged: [{ path: 'package.json', added: 1, removed: 1 }, { path: 'src/stripe/client.ts', added: 27, removed: 14 }], tests: { status: 'unknown' }, risks: ['Webhook signature verification not exercised locally'] });
void pay;
await sleep(500);
const state = await (await fetch(`${URL_}/api/state`, { headers: { 'x-mcp-screen-token': JSON.parse(fs.readFileSync(path.join(HOME, 'hub.json'), 'utf8')).token } })).json();
const reps = state.result.reports;
check('Stop + SubagentStop hooks + post_report produced 4 cards', reps.length === 4, reps.map((r) => `${r.worktree}/${r.agent}`).join(', '));
check('Stop hook card has git files, branch and parsed tests', r1.status === 0 && reps[0].filesChanged.length === 3 && reps[0].branch === 'feat/coupons' && reps[0].tests.passed === 38);
await page.locator('.tab[data-tab="standup"]').click();
await sleep(900);
await page.screenshot({ path: path.join(SHOTS, '3-standup.png') });

// ---- 5. livemap: agent draws the architecture, PostToolUse edits glow ----
await page.locator('.tab[data-tab="livemap"]').click();
await call('place_widget', {
  id: 'arch', kind: 'livemap', title: 'mcp-screen architecture',
  data: {
    root: ROOT,
    nodes: [
      { id: 'cli', label: 'CLI', globs: ['src/cli.ts'], description: 'entry: stdio MCP, wrap, hook' },
      { id: 'mcp', label: 'MCP tools', globs: ['src/mcp.ts'] },
      { id: 'wrap', label: 'Wrap proxy', globs: ['src/wrap.ts'] },
      { id: 'hook', label: 'Hooks', globs: ['src/hook.ts', 'src/standup.ts'] },
      { id: 'hub', label: 'Hub (HTTP/SSE)', globs: ['src/hub.ts', 'src/api.ts'] },
      { id: 'store', label: 'Canvas store', globs: ['src/store.ts', 'src/bus.ts', 'src/registry.ts', 'src/types.ts'] },
      { id: 'refresh', label: 'Refresh scheduler', globs: ['src/refresh.ts'] },
      { id: 'livemap', label: 'Livemap', globs: ['src/livemap.ts'] },
      { id: 'ui', label: 'Browser UI', globs: ['public/**'] },
    ],
    edges: [
      { from: 'cli', to: 'mcp' }, { from: 'cli', to: 'wrap' }, { from: 'cli', to: 'hook' },
      { from: 'mcp', to: 'hub' }, { from: 'wrap', to: 'hub' }, { from: 'hook', to: 'hub', label: 'HTTP' },
      { from: 'hub', to: 'store' }, { from: 'hub', to: 'refresh' }, { from: 'store', to: 'livemap' }, { from: 'hub', to: 'ui', label: 'SSE' },
    ],
  },
});
await sleep(900);
// record every node that lights up (glows fade, and hook processes are slow on a busy machine)
await page.evaluate(() => {
  window.__lit = new Set();
  new MutationObserver(() => document.querySelectorAll('.node.edit, .node.read').forEach((n) => window.__lit.add(n.dataset.id || n.textContent))).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
});
const edits = [
  ['claude-a1b2c3', 'src/refresh.ts'], ['test-writer', 'public/app.js'], ['claude-a1b2c3', 'src/store.ts'],
  ['codex', 'src/wrap.ts'], ['test-writer', 'public/app.css'], ['claude-a1b2c3', 'docs/new-plugin.md'],
];
for (const [agent, f] of edits) {
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', session_id: agent, agent_type: agent, cwd: ROOT, tool_input: { file_path: path.join(ROOT, f) } });
  await sleep(450);
}
await sleep(300);
const hot = await page.evaluate(() => window.__lit.size);
check('PostToolUse edits light up livemap nodes', hot >= 4, `${hot} glowing nodes`);
const arch = await call('read_widget', { id: 'arch' });
check('livemap reports unmapped files to the agent', arch.unmappedFiles?.includes('docs/new-plugin.md'));
await page.screenshot({ path: path.join(SHOTS, '4-livemap.png') });

// ---- 5b. theatre: Read shows as a read (blue) glow + orb + caption ----
hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', session_id: 'reader', agent_type: 'reviewer', cwd: ROOT, tool_input: { file_path: path.join(ROOT, 'src/hub.ts') } });
await sleep(1200);
check('theatre: Read hook glows the module as a read, with an agent orb', (await page.locator('.node.read').count()) >= 1 && (await page.locator('.orb[data-name="reviewer"]').count()) === 1);
check('theatre: caption names the file', /src\/hub\.ts/.test(await page.locator('.caption').innerText()));
await page.screenshot({ path: path.join(SHOTS, '4b-theatre.png') });

// ---- 6. ask_user: blocks until the human clicks a choice card ----
await page.locator('.tab[data-tab="canvas"]').click();
const asked = call('ask_user', { question: 'Which pricing layout should I build?', detail: 'Pick one and I will build it next.', timeoutSeconds: 60, choices: [
  { id: 'tiers', label: 'Three tiers', description: 'Good / better / best', preview: '- Free · Pro · Team\n- annual toggle' },
  { id: 'slider', label: 'Usage slider', description: 'Price scales with seats', preview: '- one card\n- live total' },
  { id: 'table', label: 'Comparison table', description: 'Feature matrix', preview: '- 12 rows\n- sticky header' } ] });
await page.locator('.card.question .choice').first().waitFor();
await sleep(700);
await cardShot('.card.question', '6-ask-user.png');
await page.locator('.choice[data-choice="slider"]').click();
const answer = await asked;
check('ask_user returns the clicked choice', answer.answered === true && answer.choice?.id === 'slider', JSON.stringify(answer));

// ---- 7. share: PNG + self-contained HTML export ----
const [png] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.__mcpScreen.doExport('png'))]);
const pngPath = path.join(HOME, 'export.png'); await png.saveAs(pngPath);
check('Share → PNG export downloads a real PNG', fs.readFileSync(pngPath).subarray(1, 4).toString() === 'PNG');
const [html] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.__mcpScreen.doExport('html'))]);
const htmlPath = path.join(HOME, 'export.html'); await html.saveAs(htmlPath);
const htmlText = fs.readFileSync(htmlPath, 'utf8');
check('Share → HTML export is self-contained (no scripts, CSP default-src none)', !/<script/i.test(htmlText) && /default-src 'none'/.test(htmlText) && /Which pricing layout/.test(htmlText));

// ---- 7b. infinite canvas: Fit, drag to move, Tidy up, minimap ----
const fitView = async () => { await page.locator('#fit-btn').click(); await sleep(500); };
check('canvas chrome: zoom bar, minimap and annotation toolbar are shown', (await page.locator('.zoombar').count()) === 1 && (await page.locator('canvas.minimap').isVisible()) && (await page.locator('.toolbar .tool').count()) === 5);
await fitView();
const beforeMove = (await call('read_canvas')).widgets.find((w) => w.id === 'fail-rate');
const head = page.locator('.card[data-id="fail-rate"] .card-head');
const hb = await head.boundingBox();
await page.mouse.move(hb.x + 30, hb.y + hb.height / 2);
await page.mouse.down();
for (let i = 1; i <= 8; i++) await page.mouse.move(hb.x + 30 + i * 25, hb.y + hb.height / 2 + i * 22);
await page.mouse.up();
await sleep(600);
const afterMove = (await call('read_canvas')).widgets.find((w) => w.id === 'fail-rate');
check('dragging a card moves it and read_canvas reports the new x/y', afterMove.x !== beforeMove.x || afterMove.y !== beforeMove.y, `${beforeMove.x},${beforeMove.y} -> ${afterMove.x},${afterMove.y}`);
await page.reload(); await page.waitForSelector('.conn.on'); await sleep(800);
const reloaded = await page.evaluate(() => { const w = window.__mcpScreen.state.widgets.get('fail-rate'); return [w.x, w.y]; });
check('moved position survives a page reload', reloaded[0] === afterMove.x && reloaded[1] === afterMove.y);
await page.locator('#tidy-btn').click(); await sleep(700);
const tidied = (await call('read_canvas')).widgets;
const overlap = tidied.some((a, i) => tidied.some((b, j) => j > i && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height));
check('Tidy up re-packs widgets with no overlaps', !overlap && tidied.every((w) => w.x >= 0 && w.y >= 0));

// ---- 7c. every new widget kind ----
const before7 = 'export function total(items: Item[]) {\n  let sum = 0;\n  for (const i of items) sum += i.price;\n  return sum;\n}\n';
const after7 = 'export function total(items: Item[], coupon?: Coupon) {\n  const sum = items.reduce((s, i) => s + i.price * i.qty, 0);\n  // coupons never take the total below zero\n  return Math.max(0, sum - (coupon?.amount ?? 0));\n}\n';
await call('place_widget', { id: 'plan', kind: 'checklist', title: 'Fix the flaky checkout test', w: 1, h: 2, data: { items: [{ id: 'repro', label: 'Reproduce locally', status: 'done' }, { id: 'cause', label: 'Find the race', status: 'done', detail: 'coupon fetch resolves after submit' }, { id: 'fix', label: 'Await the coupon response', status: 'doing' }, { id: 'soak', label: 'Soak test 50×', status: 'todo' }, { id: 'pr', label: 'Open PR', status: 'todo' }] } });
await call('place_widget', { id: 'flow', kind: 'diagram', title: 'Checkout flow', w: 1, h: 3, data: { mermaid: 'flowchart TD\n cart[Cart] --> coupon{Coupon?}\n coupon -->|yes| validate([Validate coupon])\n coupon -->|no| pay[Payment]\n validate --> pay\n pay --> done((Done))' } });
await call('place_widget', { id: 'diff', kind: 'diff', title: 'src/cart/total.ts', w: 3, h: 2, data: { before: before7, after: after7, path: 'src/cart/total.ts' } });
await call('place_widget', { id: 'repro', kind: 'code', title: 'Repro script', w: 2, h: 2, data: { filename: 'scripts/repro.sh', code: '#!/usr/bin/env bash\n# run the checkout spec until it fails\nfor i in $(seq 1 50); do\n  npx playwright test checkout.spec.ts --reporter=line || { echo "failed on run $i"; exit 1; }\ndone', highlight: [4] } });
const logFile = path.join(HOME, 'e2e-run.log');
fs.writeFileSync(logFile, ['\x1b[90m[12:03:11]\x1b[0m starting chromium', '\x1b[32m✓\x1b[0m cart › adds item (412ms)', '\x1b[31m✗\x1b[0m checkout › applies coupon (5003ms)', '  Error: Timed out 5000ms waiting for expect(locator).toHaveText("$40.00")'].join('\n') + '\n');
await call('place_widget', { id: 'tail', kind: 'log', title: 'e2e log (live tail)', w: 2, h: 2, data: { lines: [] }, source: { type: 'command', argv: ['tail', '-n', '50', logFile], parse: 'text' }, intervalMs: 1000 });
await call('place_widget', { id: 'where', kind: 'map', title: 'Failed runs by region', w: 2, h: 2, data: { markers: [{ lat: -33.87, lon: 151.21, label: 'Sydney', value: 4 }, { lat: 38.9, lon: -77.0, label: 'us-east', value: 14, color: '#ff6b81' }, { lat: 50.1, lon: 8.7, label: 'Frankfurt', value: 6 }, { lat: 1.35, lon: 103.8, label: 'Singapore', value: 2 }] } });
const shotPng = path.join(SHOTS, '1-canvas.png');
await call('place_widget', { id: 'shot', kind: 'image', title: 'Failure screenshot', w: 1, h: 2, data: { path: shotPng, caption: 'a local PNG, served by the hub behind a nonce' } });
await call('place_widget', { id: 'incident', kind: 'timeline', title: 'Incident', w: 4, h: 1, data: { items: [{ at: '2026-10-09T09:12:00Z', title: 'First failure', status: 'fail' }, { at: '2026-10-09T10:30:00Z', title: 'Retry added', status: 'info' }, { at: '2026-10-09T14:05:00Z', title: 'Root cause found', status: 'pending' }, { at: '2026-10-10T08:00:00Z', title: 'Fix merged', status: 'ok' }, { at: '2026-10-11T08:00:00Z', title: '50/50 green', status: 'ok' }] } });
await sleep(800);
await fitView();
check('diff renders side by side, toggles to unified', (await page.locator('.card[data-id="diff"] .seg button.on').innerText()) === 'Side by side' && (await page.locator('.card[data-id="diff"] .seg button', { hasText: 'Unified' }).click().then(() => sleep(300)).then(() => page.locator('.card[data-id="diff"] .seg button.on').innerText())) === 'Unified');
await page.locator('.card[data-id="diff"] .seg button', { hasText: 'Side by side' }).click();
check('diagram draws every node and edge (incl. the bowed skip edge)', (await page.locator('.card[data-id="flow"] .dnode').count()) === 5 && (await page.locator('.card[data-id="flow"] path.edge').count()) === 5);
check('image is served by the hub and loads', await page.locator('.card[data-id="shot"] img').evaluate((i) => i.complete && i.naturalWidth > 0 && /^\/img\/shot\?n=/.test(new URL(i.src).pathname + new URL(i.src).search)));
check('code is highlighted with a copy button', (await page.locator('.card[data-id="repro"] .tk-kw').count()) > 0 && (await page.locator('.card[data-id="repro"] .copy').count()) === 1);
check('map draws the offline world and every marker', (await page.locator('.card[data-id="where"] path.land').count()) === 1 && (await page.locator('.card[data-id="where"] .mk').count()) === 4);
check('timeline shows every event', (await page.locator('.card[data-id="incident"] .tl button').count()) === 5);
const tailApprove = page.locator('.card[data-id="tail"] .btn.primary');
await tailApprove.click();
await sleep(1600);
fs.appendFileSync(logFile, '\x1b[32m✓\x1b[0m checkout › applies coupon (701ms) [retry]\n');
await sleep(2200);
const tail = await call('read_widget', { id: 'tail' });
check('log live-tails an approved `tail` command (new lines arrive)', tail.status === 'live' && tail.data.lines.length === 5 && /retry/.test(tail.data.lines[4]), `${tail.data.lines.length} lines`);
await call('update_widget', { id: 'plan', data: { set: { fix: 'done', soak: 'doing' } } });
await sleep(400);
const plan = await call('read_widget', { id: 'plan' });
check('checklist set{} updates statuses and progress', plan.data.progress.done === 3 && (await page.locator('.card[data-id="plan"] li.done').count()) === 3);

// ask_form: blocks until the human fills it in on the canvas
const formAsk = call('ask_form', { prompt: 'Configure the soak test', detail: 'I will run it before opening the PR.', timeoutSeconds: 60, fields: [
  { id: 'runs', label: 'Runs', type: 'slider', min: 10, max: 200, step: 10, default: 50 },
  { id: 'browser', label: 'Browser', type: 'select', options: ['chromium', 'firefox', 'webkit'], required: true },
  { id: 'region', label: 'Region', type: 'text', placeholder: 'us-east', required: true },
  { id: 'trace', label: 'Record traces', type: 'checkbox', default: true } ] });
const form = page.locator('.card[data-kind="form"] form.form');
await form.waitFor();
await sleep(600);
await fitView();
await page.screenshot({ path: path.join(SHOTS, '8-new-kinds.png') });
await form.locator('[name="browser"]').selectOption('firefox');
await form.locator('button[type="submit"]').click();
await sleep(300);
check('ask_form shows required-field errors inline (does not submit)', /Region/.test(await form.locator('.form-err').innerText()));
await form.locator('[name="region"]').fill('ap-southeast-2');
await form.locator('button[type="submit"]').click();
const formAnswer = await formAsk;
check('ask_form returns the values the human submitted', formAnswer.submitted === true && formAnswer.values.region === 'ap-southeast-2' && formAnswer.values.browser === 'firefox' && formAnswer.values.runs === 50 && formAnswer.values.trace === true, JSON.stringify(formAnswer));

// ---- 7d. annotations: the human circles the spike and writes "why?" ----
await call('remove_widget', { id: (await call('read_canvas')).widgets.find((w) => w.kind === 'form').id });
await fitView();
await page.keyboard.press('o');
const spike = await page.locator('.card[data-id="ci-chart"] svg.chart .bar').nth(8).boundingBox();
const cx = spike.x + spike.width / 2, cy = spike.y + spike.height * 0.3;
await page.mouse.move(cx - 18, cy - 22); await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(cx - 18 + i * 3.6, cy - 22 + i * 4.4);
await page.mouse.up();
const noteIn = page.locator('.note-edit.inline');
await noteIn.waitFor();
await noteIn.fill('why?');
await noteIn.press('Enter');
await sleep(500);
const annChart = await call('read_widget', { id: 'ci-chart' });
const ann = annChart.annotations?.[0];
check('a circle drawn in the UI reaches read_widget with its target data point', ann?.kind === 'circle' && ann.text === 'why?' && ann.target?.widgetId === 'ci-chart' && ann.target.dataPoints?.some((p) => p.label === '10/09'), JSON.stringify(ann?.target));
// sticky note on the diff
await page.keyboard.press('n');
const db = await page.locator('.card[data-id="diff"] .card-body').boundingBox();
await page.mouse.click(db.x + db.width * 0.62, db.y + db.height * 0.55);
const ta = page.locator('textarea.note-edit');
await ta.waitFor();
await ta.fill('Is qty always set? Old carts had no qty.');
await ta.press('Enter');
await sleep(500);
await page.keyboard.press('v');
const canvasNow = await call('read_canvas');
check('read_canvas lists both annotations with their targets', canvasNow.annotations.length === 2 && canvasNow.annotations.some((a) => a.kind === 'note' && a.target?.widgetId === 'diff'), canvasNow.annotations.map((a) => `${a.kind}->${a.target?.widgetId}`).join(', '));
// the agent answers in a thread next to the circle; the human follows up; it is pending again
check('read_canvas lists both notes as pending questions', canvasNow.pendingQuestions.length === 2);
await call('reply_annotation', { id: ann.id, text: '10/09: the coupon service deploy at 09:02 pushed p95 to 4.8 s, past the test’s 5 s wait.' });
await page.locator(`.ann-label[data-ann="${ann.id}"] .reply.agent`).waitFor({ timeout: 5000 });
check('the agent reply appears as a bubble next to the circle', /coupon service deploy/.test(await page.locator(`.ann-label[data-ann="${ann.id}"] .reply.agent`).innerText()));
const follow = page.locator(`.ann-label[data-ann="${ann.id}"] .reply-in`);
await follow.fill('is it fixed?');
await follow.press('Enter');
await sleep(500);
const pend = (await call('read_canvas')).pendingQuestions;
check('a human follow-up in the thread makes it pending again', pend.some((p) => p.id === ann.id && p.question === 'is it fixed?'));
await call('reply_annotation', { id: ann.id, text: 'Yes: awaiting the coupon response; 50/50 runs green.' });
await sleep(400);

// showcase: keep the new kinds + the annotated chart, tidy, fit
const keep = new Set(['ci-chart', 'plan', 'flow', 'diff', 'repro', 'tail', 'where', 'shot', 'incident']);
for (const w of (await call('read_canvas')).widgets) if (!keep.has(w.id)) await call('remove_widget', { id: w.id });
await call('tidy_canvas');
await sleep(600);
const afterTidy = await call('read_canvas');
check('tidy_canvas keeps annotations attached to their widgets', afterTidy.annotations.length === 2 && afterTidy.annotations.every((a) => a.target && keep.has(a.target.widgetId)));
await fitView();
await sleep(3000);
await sleep(700);
await page.screenshot({ path: path.join(SHOTS, '7-showcase.png') });

// ---- 8. clear_canvas + undo ----
const before = (await call('read_canvas')).widgets.length;
const cleared = await call('clear_canvas', {});
check('clear_canvas empties the canvas', (await call('read_canvas')).widgets.length === 0, JSON.stringify(cleared));
await sleep(500);
await page.locator('.toast .btn').click();
await sleep(800);
check('UI Undo restores the cleared widgets', (await call('read_canvas')).widgets.length === before);

// ---- 9. back to canvas for the end of the video ----
await page.locator('.tab[data-tab="canvas"]').click();
await sleep(2500);

await page.close();
const video = GIF ? await page.video()?.path() : null;
await ctx.close();
await browser.close();
await client.close();

if (video && fs.existsSync(video)) {
  const gif = path.join(SHOTS, 'e2e-run.gif');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-vf', 'fps=6,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', gif]);
  fs.copyFileSync(video, path.join(HOME, 'e2e-run.webm'));
  check('demo GIF rendered', r.status === 0 && fs.existsSync(gif), gif);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} end-to-end checks passed`);
process.exit(failed.length ? 1 : 0);
