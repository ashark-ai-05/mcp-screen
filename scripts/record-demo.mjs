#!/usr/bin/env node
// Records screenshots/demo.gif + hero.png: a terminal pane on the left (a faithful
// recreation of the Claude Code UI, text typed by this script) and the REAL canvas on the right.
// Every widget on the canvas comes from a real MCP tool call against a real mcp-screen process,
// and the terminal shows the real tool results.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'screenshots');
const PORT = 4747 + 50;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-screen-rec-'));
const W = 1280, H = 720, TERM = 470;
const env = { ...process.env, MCP_SCREEN_HOME: HOME, MCP_SCREEN_NO_OPEN: '1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new Client({ name: 'claude-code', version: '1' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'dist/cli.js'), 'wrap', '--port', String(PORT), '--', process.execPath, path.join(ROOT, 'examples/demo-app-server.mjs')],
  env, stderr: 'ignore',
}));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return r.content.map((c) => c.text).join('\n');
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${PORT}`);
await page.waitForSelector('.conn.on');

// Inject the terminal pane (Claude Code look-alike) and a visible cursor.
await page.addStyleTag({ content: `
  body { margin-left: ${TERM}px !important; }
  .top { padding-left: 18px; }
  main { padding: 14px !important; }
  .grid { grid-auto-rows: 118px !important; gap: 12px !important; grid-template-columns: repeat(4, minmax(0,1fr)) !important; }
  #term { position: fixed; left: 0; top: 0; bottom: 0; width: ${TERM}px; background: #0a0a0a; border-right: 1px solid #262626;
          font: 12.5px/1.55 ui-monospace, 'JetBrains Mono', Menlo, monospace; color: #d4d4d4; padding: 14px 16px; overflow: hidden; z-index: 50; }
  #term .bar { display:flex; gap:6px; margin:-4px 0 12px; } #term .bar i { width:10px; height:10px; border-radius:50%; background:#3a3a3a; display:block }
  #term .box { border: 1px solid #d77757; border-radius: 6px; padding: 6px 10px; margin-bottom: 12px; color: #d77757; }
  #term .box span { color: #8a8a8a; }
  #term .l { white-space: pre-wrap; word-break: break-word; margin: 0 0 6px; }
  #term .p { color: #fff; } #term .p::before { content: '> '; color: #8a8a8a; }
  #term .dot::before { content: '⏺ '; color: #e5e5e5; } #term .tool::before { content: '⏺ '; color: #4ade80; }
  #term .tool b { color: #fff; font-weight: 600; } #term .res { color: #8a8a8a; padding-left: 18px; }
  #term .res::before { content: '⎿  '; }
  #term .input { position: absolute; left: 16px; right: 16px; bottom: 16px; border: 1px solid #3a3a3a; border-radius: 6px; padding: 7px 10px; color: #fff; min-height: 34px; }
  #term .input::before { content: '> '; color: #8a8a8a; } #term .caret { display:inline-block; width:7px; height:14px; background:#d4d4d4; vertical-align:-2px; animation: blink 1s steps(1) infinite; }
  #term .hint { position: absolute; left: 16px; bottom: 56px; color: #6b6b6b; font-size: 11px; }
  @keyframes blink { 50% { opacity: 0; } }
  #cursor { position: fixed; z-index: 99; width: 18px; height: 18px; left: 900px; top: 600px; pointer-events: none; transition: left .7s cubic-bezier(.3,.7,.2,1), top .7s cubic-bezier(.3,.7,.2,1);
            background: no-repeat url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'><path d='M2 1 L2 15 L6 11 L9 17 L11 16 L8 10 L14 10 Z' fill='white' stroke='black' stroke-width='1.2'/></svg>"); }
  #cursor.click::after { content:''; position:absolute; left:-10px; top:-10px; width:22px; height:22px; border-radius:50%; border:2px solid #7c9cff; animation: ping .5s ease-out; }
  @keyframes ping { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }
`});
await page.evaluate(() => {
  const t = document.createElement('div');
  t.id = 'term';
  t.innerHTML = `<div class="bar"><i></i><i></i><i></i></div><div class="box">✻ Claude Code<br><span>~/shop · screen MCP connected</span></div><div id="lines"></div><div class="hint">? for shortcuts</div><div class="input"><span id="typed"></span><span class="caret"></span></div>`;
  document.body.append(t);
  const c = document.createElement('div'); c.id = 'cursor'; document.body.append(c);
});
const line = (cls, html) => page.evaluate(([c, h]) => {
  const d = document.createElement('div'); d.className = `l ${c}`; d.innerHTML = h; document.getElementById('lines').append(d);
}, [cls, html]);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
async function type(text) {
  for (const ch of text) { await page.evaluate((c) => { document.getElementById('typed').textContent += c; }, ch); await sleep(28); }
  await sleep(250);
  await page.evaluate(() => { document.getElementById('typed').textContent = ''; });
  await line('p', esc(text));
}
async function cursorTo(sel, nth = 0) {
  const box = await page.locator(sel).nth(nth).boundingBox();
  await page.evaluate(([x, y]) => { const c = document.getElementById('cursor'); c.style.left = `${x}px`; c.style.top = `${y}px`; }, [box.x + box.width / 2, box.y + box.height / 2]);
  await sleep(750);
  return box;
}

// Frame grabber: Playwright's video recorder drops late frames, so we screenshot at ~12 fps
// with timestamps and let ffmpeg assemble a variable-frame-rate clip.
const FR = path.join(HOME, 'frames');
fs.mkdirSync(FR);
const frames = [];
let recording = true;
const grabber = (async () => {
  while (recording) {
    const t = Date.now();
    const file = path.join(FR, `${String(frames.length).padStart(5, '0')}.png`);
    await page.screenshot({ path: file, scale: 'css' });
    frames.push({ file, t });
    const wait = 80 - (Date.now() - t);
    if (wait > 0) await sleep(wait);
  }
})();
await sleep(500);
// --- scene 1: prompt -> chart + table land
await type('compare our last 30 days of CI failures');
await line('dot', 'Pulling CI history and putting it on your screen.');
await sleep(300);
const labels = Array.from({ length: 30 }, (_, i) => { const d = new Date(2026, 8, 16 + i); return `${d.getMonth() + 1}/${d.getDate()}`; });
const values = [2,3,1,4,2,0,1,3,5,2,1,6,3,2,0,1,2,8,4,3,1,0,2,9,3,2,4,1,2,3];
await line('tool', '<b>screen - place_widget</b> (MCP)(kind: "chart", title: "CI failures · 30 days")');
const r1 = await call('place_widget', { id: 'ci', kind: 'chart', title: 'CI failures · last 30 days', data: { type: 'bar', labels, values, linkTo: 'runs' }, w: 4, h: 2 });
await line('res', esc(`Placed ${JSON.parse(r1).id} on ${JSON.parse(r1).url}`));
await sleep(500);
const jobs = ['e2e · checkout.spec.ts', 'unit · auth.test.ts', 'e2e · search.spec.ts', 'lint', 'build · tsc'];
const rows = [];
labels.forEach((d, i) => { for (let k = 0; k < Math.min(values[i], 3); k++) rows.push([d, jobs[(i * 3 + k) % 5], k ? 'real' : 'flaky', `${2 + ((i + k) % 7)}m`]); });
await line('tool', '<b>screen - place_widget</b> (MCP)(kind: "table", title: "Failed runs")');
await call('place_widget', { id: 'runs', kind: 'table', title: 'Failed runs (click a bar to filter)', data: { columns: ['day', 'job', 'kind', 'duration'], rows }, w: 3, h: 2 });
await call('place_widget', { id: 'rate', kind: 'metric', title: 'Failure rate', data: { value: '6.8%', label: 'of 1,204 runs', delta: -1.2 }, w: 1, h: 2 });
await line('res', 'Placed runs, rate');
await sleep(700);

// --- scene 2: human clicks the tallest bar, agent reads it
const bar = await cursorTo('svg.chart .bar', 23);
await page.evaluate(() => { const c = document.getElementById('cursor'); c.classList.remove('click'); void c.offsetWidth; c.classList.add('click'); });
await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
await sleep(900);
await type('which day did I click? why?');
await line('tool', '<b>screen - read_widget</b> (MCP)(id: "ci")');
const sel = JSON.parse(await call('read_widget', { id: 'ci' })).selection;
await line('res', esc(`selection: { label: "${sel.label}", value: ${sel.value} }`));
await line('dot', esc(`You picked ${sel.label}: ${sel.value} failures, mostly e2e checkout.spec.ts (flaky).`));
await sleep(1100);
await page.screenshot({ path: path.join(SHOTS, 'hero.png'), scale: 'device' });

// --- scene 3 (end card): an MCP App that the terminal can only show as JSON
await type('show the flaky tests app');
await line('tool', '<b>flaky - flaky_tests</b> (MCP)(days: 30)');
await call('remove_widget', { id: 'rate' });
await call('update_widget', { id: 'ci', h: 1 });
await call('update_widget', { id: 'runs', w: 2 });
await page.evaluate(() => { document.getElementById('cursor').style.display = 'none'; });
const r3 = await call('flaky_tests', { days: 30 });
await line('res', esc('{"days":30,"flaky":[{"test":"checkout › applies coupon","fails":9,…'));
await line('res', esc(r3.split('\n').pop().replace(/ on http\S+/, ' on the screen')));
await page.frameLocator('iframe.app-frame').locator('text=checkout › applies coupon').waitFor();
await sleep(2200);

recording = false;
await grabber;
await ctx.close();
await browser.close();
const list = frames.map((f, i) => `file '${f.file}'\nduration ${(((frames[i + 1]?.t ?? f.t + 1500) - f.t) / 1000).toFixed(3)}`).join('\n');
fs.writeFileSync(path.join(HOME, 'list.txt'), `${list}\nfile '${frames.at(-1).file}'\n`);
const video = path.join(HOME, 'demo.mp4');
spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(HOME, 'list.txt'), '-vf', 'fps=25,format=yuv420p', '-c:v', 'libx264', '-crf', '18', video]);
await client.close();

const gif = path.join(SHOTS, 'demo.gif');
const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-vf',
  'fps=10,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', gif]);
fs.copyFileSync(video, path.join(SHOTS, 'demo.mp4'));
const dur = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], { encoding: 'utf8' }).stdout.trim();
console.log(`gif ${r.status === 0 ? 'ok' : 'FAILED'}: ${gif} ${(fs.statSync(gif).size / 1e6).toFixed(2)} MB, video ${dur}s`);
