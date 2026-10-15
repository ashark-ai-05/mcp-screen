#!/usr/bin/env node
// First-timer UX pass: a fresh browser at several viewport sizes, no agent. Checks the empty state teaches
// the product, the sample canvas works, shortcuts open, annotation works, nothing overflows, console stays clean.
import { startHub } from '../dist/hub.js';
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots', 'ux');
fs.mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'laptop-1280', width: 1280, height: 720 },
  { name: 'tablet-820', width: 820, height: 1180 },
  { name: 'phone-390', width: 390, height: 844, mobile: true },
];
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };

const browser = await chromium.launch();
for (const vp of VIEWPORTS) {
  const hub = await startHub({ port: 0, home: null });
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.mobile, hasTouch: !!vp.mobile, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(hub.url);
  await page.waitForSelector('.conn.on');
  await page.waitForTimeout(700);
  const t = `[${vp.name}]`;
  check(`${t} empty state explains what to do`, await page.locator('#stage .empty h2').isVisible() && /Ask your agent/.test(await page.locator('#stage .empty').innerText()));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${t} no horizontal overflow`, overflow <= 0, `${overflow}px`);
  const header = await page.evaluate(() => { const r = document.querySelector('header').getBoundingClientRect(); return { h: r.height, w: r.width }; });
  check(`${t} header stays one compact row`, header.h <= 64, `${header.h}px`);
  await page.screenshot({ path: path.join(OUT, `${vp.name}-empty.png`) });
  const sample = page.locator('#sample-btn');
  check(`${t} "Try a sample canvas" is visible`, await sample.isVisible());
  await sample.click();
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 4);
  await page.waitForTimeout(900);
  const offscreen = await page.evaluate(() => {
    const st = document.getElementById('stage').getBoundingClientRect();
    return [...document.querySelectorAll('.card')].filter((c) => { const r = c.getBoundingClientRect(); return r.right < st.left || r.left > st.right || r.bottom < st.top || r.top > st.bottom; }).length;
  });
  check(`${t} sample widgets land in view`, offscreen === 0, `${offscreen} off-screen`);
  const overlap = await page.evaluate(() => {
    const rs = [...document.querySelectorAll('.card')].map((c) => c.getBoundingClientRect());
    return rs.some((a, i) => rs.some((b, j) => j > i && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1));
  });
  check(`${t} auto-placed widgets never overlap`, !overlap);
  await page.screenshot({ path: path.join(OUT, `${vp.name}-sample.png`) });
  if (!vp.mobile) {
    await page.keyboard.press('?');
    check(`${t} ? opens the shortcut sheet`, await page.locator('.modal.sheet').isVisible());
    await page.screenshot({ path: path.join(OUT, `${vp.name}-shortcuts.png`) });
    await page.keyboard.press('Escape');
    check(`${t} Esc closes it`, (await page.locator('.modal.sheet').count()) === 0);
    // circle the tallest bar like a first-timer following the hint
    await page.keyboard.press('o');
    const bar = await page.locator('.card[data-id="sample-chart"] svg.chart .bar').nth(8).boundingBox();
    const cx = bar.x + bar.width / 2, cy = bar.y + bar.height / 2;
    await page.mouse.move(cx - 15, cy - 15); await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(cx - 15 + i * 5, cy - 15 + i * 5);
    await page.mouse.up();
    await page.locator('.note-edit.inline').fill('why?');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    const ann = hub.store.listAnnotations()[0];
    check(`${t} circling the spike creates an annotation on that bar`, ann?.target?.dataPoints?.some((p) => p.label === '10/09'), JSON.stringify(ann?.target?.dataPoints));
  } else {
    await page.locator('#help-btn').tap().catch(() => {});
    check(`${t} shortcut sheet reachable from the ? button`, await page.locator('.modal.sheet').isVisible());
    await page.screenshot({ path: path.join(OUT, `${vp.name}-shortcuts.png`) });
    await page.locator('.modal.sheet .btn.accent').tap({ timeout: 3000 }).catch((e) => errors.push('Got it not tappable'));
  }
  // every interactive control has a tooltip or an accessible name
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('button, [role=button], a')].filter((b) => b.offsetParent && !(b.title || b.getAttribute('aria-label') || b.textContent.trim())).map((b) => b.className));
  check(`${t} every visible button has a label or tooltip`, unnamed.length === 0, unnamed.join(','));
  check(`${t} console is clean`, errors.length === 0, errors.join(' | '));
  await ctx.close();
  await hub.close();
}
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} UX checks passed`);
process.exit(failed ? 1 : 0);
