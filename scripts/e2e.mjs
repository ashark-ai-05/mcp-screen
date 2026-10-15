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
await page.locator('.card.app').screenshot({ path: path.join(SHOTS, '5-wrap-mcp-app.png') });

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
const edits = [
  ['claude-a1b2c3', 'src/refresh.ts'], ['test-writer', 'public/app.js'], ['claude-a1b2c3', 'src/store.ts'],
  ['codex', 'src/wrap.ts'], ['test-writer', 'public/app.css'], ['claude-a1b2c3', 'docs/new-plugin.md'],
];
for (const [agent, f] of edits) {
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', session_id: agent, agent_type: agent, cwd: ROOT, tool_input: { file_path: path.join(ROOT, f) } });
  await sleep(450);
}
await sleep(300);
const hot = await page.locator('.node.edit, .node.read').count();
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
await page.locator('.card.question').screenshot({ path: path.join(SHOTS, '6-ask-user.png') });
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
