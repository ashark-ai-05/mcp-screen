#!/usr/bin/env node
// Browser soak: many clear → undo → clear → place-again cycles with every widget kind, through the real UI.
// Checks DOM nodes return to baseline, JS heap stays flat, the console stays clean.
import { startHub } from '../dist/hub.js';
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CYCLES = Number(process.env.SOAK_CYCLES ?? 25);
const hub = await startHub({ port: 0, home: null });
const browser = await chromium.launch({ args: ['--js-flags=--expose-gc'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(hub.url);
await page.waitForSelector('.conn.on');
const png = path.join(os.tmpdir(), 'mcp-screen-soak.png');
fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
const all = (c) => [
  { id: `chart`, kind: 'chart', title: `chart ${c}`, data: { labels: ['a', 'b', 'c'], values: [1, c, 3] }, w: 2, h: 2 },
  { id: 'table', kind: 'table', title: 't', data: { columns: ['a'], rows: [[c]] } },
  { id: 'md', kind: 'markdown', title: 'm', data: { markdown: `# cycle ${c}` } },
  { id: 'metric', kind: 'metric', title: 'm', data: { value: String(c) } },
  { id: 'code', kind: 'code', title: 'c', data: { code: `const c = ${c};`, language: 'ts' }, w: 2 },
  { id: 'diff', kind: 'diff', title: 'd', data: { before: 'a\nb\n', after: `a\n${c}\n` }, w: 2 },
  { id: 'flow', kind: 'diagram', title: 'f', data: { mermaid: 'graph LR\n a --> b' } },
  { id: 'img', kind: 'image', title: 'i', data: { path: png } },
  { id: 'log', kind: 'log', title: 'l', data: { lines: ['x', 'error y'] }, w: 2 },
  { id: 'plan', kind: 'checklist', title: 'p', data: { items: [{ id: 'a', label: 'a', status: 'doing' }] } },
  { id: 'map', kind: 'map', title: 'm', data: { markers: [{ lat: 1, lon: 2, label: 'x' }] }, w: 2 },
  { id: 'tl', kind: 'timeline', title: 't', data: { items: [{ at: '2026-01-01', title: 'x' }] }, w: 2, h: 1 },
];
const stats = () => page.evaluate(() => { window.gc?.(); return { nodes: document.getElementsByTagName('*').length, heapMB: +(performance.memory.usedJSHeapSize / 1e6).toFixed(1), cards: document.querySelectorAll('.card').length }; });
await page.waitForTimeout(500);
const base = await stats();
const samples = [];
let bad = 0;
for (let c = 0; c < CYCLES; c++) {
  for (const w of all(c)) hub.store.place(w);
  await page.waitForFunction((n) => document.querySelectorAll('.card:not(.leaving)').length === n, all(c).length);
  hub.store.annotate({ kind: 'note', points: [[20, 20]], text: `cycle ${c}` });
  // clear through the UI, undo through the toast, clear again
  await page.locator('#clear-btn').click();
  await page.locator('.modal [data-ok]').click();
  await page.waitForFunction(() => document.querySelectorAll('.card:not(.leaving)').length === 0);
  await page.locator('.toast .btn').click();
  await page.waitForFunction((n) => document.querySelectorAll('.card:not(.leaving)').length === n, all(c).length, { timeout: 5000 }).catch(async (e) => { console.log('cards', await page.evaluate(() => [...document.querySelectorAll('.card')].map((x) => x.dataset.id + ':' + x.className).join(' ')), 'store', hub.store.list().length); throw e; });
  if (hub.store.listAnnotations().length !== 1) bad++;
  hub.store.clear();
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 0, null, { timeout: 5000 });
  samples.push(await stats());
}
await page.waitForTimeout(800);
const end = await stats();
const first = samples[Math.min(2, samples.length - 1)];
const report = { cycles: CYCLES, baseline: base, afterCycle3: first, end, heapGrowthMB: +(end.heapMB - first.heapMB).toFixed(1), nodeGrowth: end.nodes - base.nodes, annotationRestoreFailures: bad, consoleErrors: errors };
console.log(JSON.stringify(report, null, 2));
await browser.close();
await hub.close();
const ok = report.nodeGrowth <= 5 && report.heapGrowthMB < 5 && !bad && !errors.length;
console.log(ok ? 'SOAK PASS' : 'SOAK FAIL');
process.exit(ok ? 0 : 1);
