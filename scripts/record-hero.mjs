#!/usr/bin/env node
// Records the README hero: screenshots/hero.gif + hero.mp4.
// The "agent" is a scripted MCP client (labelled on screen): every widget comes from a real tool call to a real
// mcp-screen process, the circle is drawn with real mouse input, and the agent's reply quotes what read_canvas returned.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'screenshots');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-screen-hero-'));
const PORT = 4795;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, MCP_SCREEN_HOME: HOME, MCP_SCREEN_NO_OPEN: '1' };
const client = new Client({ name: 'hero', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'dist/cli.js'), '--port', String(PORT)], env, stderr: 'ignore' }));
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); if (r.isError) throw new Error(r.content[0].text); try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; } };

const W = 1280, H = 800;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: path.join(HOME, 'v'), size: { width: W, height: H } } });
const page = await ctx.newPage();
await call('read_canvas'); // make sure the hub is up
await page.goto(`http://127.0.0.1:${PORT}`);
await page.waitForSelector('.conn.on');
// on-screen caption: what the scripted agent just called (recording only, not part of the product UI)
await page.addStyleTag({ content: `#cap{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:99;display:flex;gap:10px;align-items:center;padding:9px 16px;border-radius:12px;background:rgba(14,16,26,.94);border:1px solid rgba(142,166,255,.35);font:500 14px/1.3 ui-monospace,monospace;color:#dfe4f5;box-shadow:0 20px 50px -10px #000;transition:opacity .25s}#cap b{font:600 11px Inter,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#0b0d14;background:#ffd166;border-radius:6px;padding:3px 7px}#cap.you b{background:#8ea6ff}#mouse{position:fixed;z-index:100;width:18px;height:18px;margin:-3px 0 0 -3px;pointer-events:none;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M2 1l11 6-5 1.3L6 14z' fill='white' stroke='black' stroke-width='1'/%3E%3C/svg%3E") no-repeat;}` });
await page.evaluate(() => { const c = document.createElement('div'); c.id = 'cap'; c.style.opacity = '0'; document.body.append(c); const m = document.createElement('div'); m.id = 'mouse'; document.body.append(m); document.addEventListener('mousemove', (e) => { m.style.left = e.clientX + 'px'; m.style.top = e.clientY + 'px'; }); });
const cap = (who, text) => page.evaluate(([who, text]) => { const c = document.getElementById('cap'); c.className = who === 'you' ? 'you' : ''; c.replaceChildren(Object.assign(document.createElement('b'), { textContent: who === 'you' ? 'you' : 'scripted agent' }), document.createTextNode(text)); c.style.opacity = '1'; }, [who, text]);
await sleep(1200);

const days = Array.from({ length: 14 }, (_, i) => `10/${String(i + 1).padStart(2, '0')}`);
await cap('agent', 'place_widget · chart');
await call('place_widget', { id: 'ci', kind: 'chart', title: 'CI failures · last 14 days', w: 2, h: 2, data: { type: 'bar', labels: days, values: [3, 5, 2, 8, 4, 1, 0, 6, 14, 3, 2, 7, 4, 2] } });
await sleep(900);
await cap('agent', 'place_widget · checklist');
await call('place_widget', { id: 'plan', kind: 'checklist', title: 'Fix the flaky checkout test', w: 1, h: 2, data: { items: [{ id: 'repro', label: 'Reproduce locally', status: 'done' }, { id: 'cause', label: 'Find the race', status: 'doing' }, { id: 'fix', label: 'Await the coupon response', status: 'todo' }, { id: 'soak', label: 'Soak test 50×', status: 'todo' }] } });
await sleep(800);
await cap('agent', 'place_widget · diagram (Mermaid)');
await call('place_widget', { id: 'flow', kind: 'diagram', title: 'Checkout flow', w: 1, h: 2, data: { mermaid: 'flowchart TD\n cart[Cart] --> coupon{Coupon?}\n coupon -->|yes| v([Validate])\n coupon -->|no| pay[Pay]\n v --> pay' } });
await sleep(800);
await cap('agent', 'place_widget · diff');
await call('place_widget', { id: 'diff', kind: 'diff', title: 'src/cart/total.ts', w: 2, h: 2, data: { path: 'src/cart/total.ts', before: 'export function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i.price;\n  return sum;\n}\n', after: 'export function total(items, coupon) {\n  const sum = items.reduce((s, i) => s + i.price * i.qty, 0);\n  return Math.max(0, sum - (coupon?.amount ?? 0));\n}\n' } });
await sleep(800);
await cap('agent', 'place_widget · log');
await call('place_widget', { id: 'log', kind: 'log', title: 'e2e · run 37', w: 2, h: 2, data: { lines: ['\x1b[90m[12:03:11]\x1b[0m starting chromium', '\x1b[32m✓\x1b[0m cart › adds item (412ms)', '\x1b[31m✗\x1b[0m checkout › applies coupon (5003ms)', '  Error: Timed out waiting for "$40.00"'] } });
await sleep(800);
await cap('agent', 'place_widget · map');
await call('place_widget', { id: 'map', kind: 'map', title: 'Failed runs by region', w: 2, h: 2, data: { markers: [{ lat: 38.9, lon: -77, label: 'us-east', value: 14, color: '#ff6b81' }, { lat: 50.1, lon: 8.7, label: 'Frankfurt', value: 6 }, { lat: -33.9, lon: 151.2, label: 'Sydney', value: 4 }] } });
await sleep(900);
await page.locator('#fit-btn').click();
await sleep(1300);

// the human circles the spike and asks why
await cap('you', 'circle the spike, type “why?”');
await page.keyboard.press('o');
const bar = await page.locator('.card[data-id="ci"] svg.chart .bar').nth(8).boundingBox();
const cx = bar.x + bar.width / 2, cy = bar.y + bar.height * 0.35;
await page.mouse.move(cx + 150, cy + 120, { steps: 12 });
await sleep(200);
await page.mouse.move(cx - 22, cy - 30, { steps: 14 });
await page.mouse.down();
for (let i = 0; i <= 16; i++) await page.mouse.move(cx - 22 + (44 * i) / 16, cy - 30 + (60 * i) / 16, { steps: 2 });
await page.mouse.up();
const input = page.locator('.note-edit.inline');
await input.waitFor();
await input.pressSequentially('why?', { delay: 140 });
await sleep(300);
await input.press('Enter');
await sleep(1400);

const canvas = await call('read_canvas');
const a = canvas.annotations[0];
const pt = a.target.dataPoints?.[0];
await cap('agent', `read_canvas → ${a.kind} “${a.text}” on ${a.target.widgetId}, bar ${pt.label} = ${pt.value}`);
await sleep(2600);
await cap('agent', 'update_widget · log append + checklist set');
await call('update_widget', { id: 'log', data: { append: ['\x1b[33mwarning:\x1b[0m 10/09: coupon service deployed 09:02, p95 4.8s', '\x1b[32m✓\x1b[0m checkout › applies coupon (701ms) [after fix]'] } });
await call('update_widget', { id: 'plan', data: { set: { cause: 'done', fix: 'doing' } } });
await sleep(1200);
await call('place_widget', { id: 'answer', kind: 'markdown', title: 'Re: why? (10/09)', w: 2, h: 1, data: { markdown: '**14 failures on 10/09**: the coupon service deploy at 09:02 pushed p95 to 4.8 s, past the test\'s 5 s wait. Fix: await the coupon response.' } });
await sleep(900);
await page.locator('#fit-btn').click();
await sleep(2800);
await page.evaluate(() => { document.getElementById('cap').style.opacity = '0'; });
await page.screenshot({ path: path.join(SHOTS, 'hero.png') });
await sleep(600);

const video = await page.video().path();
await page.close();
await ctx.close();
await browser.close();
await client.close();
const mp4 = path.join(SHOTS, 'hero.mp4'), gif = path.join(SHOTS, 'hero.gif');
spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-vf', 'fps=25,format=yuv420p', '-c:v', 'libx264', '-crf', '22', '-movflags', '+faststart', mp4]);
const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-vf', 'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif]);
console.log(r.status === 0 ? `wrote ${gif} (${(fs.statSync(gif).size / 1e6).toFixed(1)} MB), ${mp4}` : r.stderr.toString());
