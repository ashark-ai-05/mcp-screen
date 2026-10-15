import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseMermaid, layoutDiagram } from '../src/diagram.js';
import { buildDiff, collapse, diffLines, languageFor, parseUnified } from '../src/diff.js';
import { startHub, type Hub } from '../src/hub.js';
import { sniffImage } from '../src/images.js';
import { coerceRefreshed } from '../src/registry.js';
import { CanvasStore } from '../src/store.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

describe('diff', () => {
  it('Myers diff finds the minimal edit with line numbers', () => {
    const rows = diffLines('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
    expect(rows.map((r) => `${r.t}:${r.text}`)).toEqual(['ctx:a', 'del:b', 'add:B', 'ctx:c', 'ctx:d', 'add:e']);
    expect(rows[1]).toMatchObject({ a: 2 });
    expect(rows[2]).toMatchObject({ b: 2 });
    expect(diffLines('', 'x')).toEqual([{ t: 'add', b: 1, text: 'x' }]);
    expect(diffLines('same', 'same')).toEqual([{ t: 'ctx', a: 1, b: 1, text: 'same' }]);
  });

  it('collapses long unchanged runs into hunk markers', () => {
    const before = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l20', 'L20');
    const rows = collapse(diffLines(before, after));
    expect(rows.filter((r) => r.t === 'hunk')).toHaveLength(2);
    expect(rows.filter((r) => r.t === 'ctx')).toHaveLength(6);
  });

  it('parses multi-file git patches', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@ fn',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      ' export {};',
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -10,0 +11,1 @@',
      '+new line',
    ].join('\n');
    const files = parseUnified(patch);
    expect(files.map((f) => [f.path, f.language, f.added, f.removed])).toEqual([['src/a.ts', 'ts', 1, 1], ['README.md', 'md', 1, 0]]);
    expect(files[0]!.rows[2]).toEqual({ t: 'del', a: 2, text: 'const b = 2;' });
    expect(files[1]!.rows[1]).toEqual({ t: 'add', b: 11, text: 'new line' });
    expect(() => parseUnified('just text')).toThrow(/no hunks/);
  });

  it('is a placeable widget with totals; bad input fails at place time', () => {
    const s = new CanvasStore();
    const w = s.place({ kind: 'diff', title: 'd', data: { before: 'x', after: 'y', path: 'a.py' } });
    expect(w.data).toMatchObject({ added: 1, removed: 1, mode: 'split' });
    expect((w.data.files as Array<{ language: string }>)[0]!.language).toBe('py');
    expect(() => s.place({ kind: 'diff', title: 'd', data: { before: 'x' } })).toThrow(/before, after/);
    expect(languageFor('x.tsx')).toBe('ts');
    expect(buildDiff({ patch: '@@ -1 +1 @@\n-a\n+b' })[0]!.path).toBe('patch');
  });
});

describe('diagram (Mermaid flowchart subset)', () => {
  it('parses shapes, labels, chains, & groups and edge styles', () => {
    const d = parseMermaid(`flowchart LR
      A[Start] --> B{Is it ok?}
      B -->|yes| C([Ship it])
      B -- no --> D((Fix)) --> A
      C & D -.-> E[(DB)]
      %% a comment
      classDef x fill:#f00`.replace('[(DB)]', '[DB]'));
    expect(d.direction).toBe('LR');
    expect(d.nodes.map((n) => [n.id, n.label, n.shape])).toEqual([
      ['A', 'Start', 'rect'],
      ['B', 'Is it ok?', 'diamond'],
      ['C', 'Ship it', 'stadium'],
      ['D', 'Fix', 'circle'],
      ['E', 'DB', 'rect'],
    ]);
    expect(d.edges).toContainEqual({ from: 'B', to: 'C', label: 'yes', arrow: true, style: 'solid' });
    expect(d.edges).toContainEqual({ from: 'B', to: 'D', label: 'no', arrow: true, style: 'solid' });
    expect(d.edges.filter((e) => e.to === 'E').map((e) => [e.from, e.style])).toEqual([['C', 'dotted'], ['D', 'dotted']]);
  });

  it('refuses non-flowcharts with a clear message', () => {
    expect(() => parseMermaid('sequenceDiagram\n A->>B: hi')).toThrow(/only Mermaid flowcharts/);
    expect(() => parseMermaid('graph TD\n A --> ')).toThrow();
  });

  it('lays out in layers and validates explicit graphs', () => {
    const d = parseMermaid('graph TD\n a --> b\n a --> c\n b --> d\n c --> d');
    const l = layoutDiagram(d);
    expect(l.pos.a!.y).toBeLessThan(l.pos.b!.y);
    expect(l.pos.b!.y).toBe(l.pos.c!.y);
    expect(l.pos.d!.y).toBeGreaterThan(l.pos.b!.y);
    const s = new CanvasStore();
    expect(() => s.place({ kind: 'diagram', title: 'g', data: { nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'zz' }] } })).toThrow(/unknown node/);
    expect(s.place({ kind: 'diagram', title: 'g', data: { mermaid: 'graph LR\n x --> y' } }).data.layout).toBeTruthy();
  });
});

describe('image', () => {
  let hub: Hub | undefined;
  afterEach(async () => hub?.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-img-'));
  const png = path.join(dir, 'shot.png');
  fs.writeFileSync(png, PNG);
  const fake = path.join(dir, 'secret.png');
  fs.writeFileSync(fake, 'API_KEY=hunter2');
  const txt = path.join(dir, 'notes.txt');
  fs.writeFileSync(txt, 'hi');

  it('sniffs real image bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from('<?xml version="1.0"?><svg xmlns="x"></svg>'))).toBe('image/svg+xml');
    expect(sniffImage(Buffer.from('API_KEY=1'))).toBeNull();
  });

  it('only accepts absolute image paths that exist, and https/data URLs', () => {
    const s = new CanvasStore();
    expect(s.place({ kind: 'image', title: 'i', data: { path: png } }).data.path).toBe(png);
    expect(() => s.place({ kind: 'image', title: 'i', data: { path: 'shot.png' } })).toThrow(/absolute/);
    expect(() => s.place({ kind: 'image', title: 'i', data: { path: txt } })).toThrow(/must end in/);
    expect(() => s.place({ kind: 'image', title: 'i', data: { path: path.join(dir, 'missing.png') } })).toThrow(/not found/);
    expect(() => s.place({ kind: 'image', title: 'i', data: { url: 'http://x/a.png' } })).toThrow(/https/);
    expect(() => s.place({ kind: 'image', title: 'i', data: { url: 'javascript:alert(1)' } })).toThrow(/https/);
    expect(() => s.place({ kind: 'image', title: 'i', data: { path: png, url: 'https://x/a.png' } })).toThrow(/exactly one/);
  });

  it('serves the file only with the widget nonce, sniffed, sandboxed; never serves non-images', async () => {
    hub = await startHub({ port: 0, home: null });
    hub.store.place({ id: 'img', kind: 'image', title: 'i', data: { path: png } });
    hub.store.place({ id: 'fake', kind: 'image', title: 'f', data: { path: fake } });
    const state = await (await fetch(`${hub.url}/api/state`, { headers: { 'x-mcp-screen-token': hub.token } })).json();
    const src = state.result.widgets.find((w: { id: string }) => w.id === 'img').imageSrc as string;
    expect(src).toMatch(/^\/img\/img\?n=[0-9a-f]{32}/);
    const ok = await fetch(`${hub.url}${src}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(ok.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await ok.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await fetch(`${hub.url}/img/img?n=wrong`)).status).toBe(404);
    const fsrc = state.result.widgets.find((w: { id: string }) => w.id === 'fake').imageSrc as string;
    const leak = await fetch(`${hub.url}${fsrc}`);
    expect(leak.status).toBe(404);
    expect(await leak.text()).not.toContain('hunter2');
  });
});

describe('log, checklist, code, map, timeline', () => {
  it('log: append via update_widget, trims to maxLines, tails command output', () => {
    const s = new CanvasStore();
    s.place({ id: 'log', kind: 'log', title: 'build', data: { lines: ['a'], maxLines: 10 } });
    s.update('log', { data: { append: ['b', 'c'] } });
    s.update('log', { data: { append: 'd\ne\n' } });
    expect(s.get('log')!.data.lines).toEqual(['a', 'b', 'c', 'd', 'e']);
    s.update('log', { data: { append: Array.from({ length: 12 }, (_, i) => `x${i}`) } });
    expect(s.get('log')!.data.lines).toHaveLength(10);
    expect(s.get('log')!.data.dropped).toBe(7);
    expect(coerceRefreshed('log', 'one\ntwo\n')).toMatchObject({ lines: ['one', 'two'] });
    expect(() => s.update('log', { data: { set: { a: 'done' } } })).toThrow(/checklist/);
  });

  it('checklist: set single items by id or label, progress is computed', () => {
    const s = new CanvasStore();
    s.place({ id: 'cl', kind: 'checklist', title: 'Plan', data: { items: [{ id: 'tests', label: 'Write tests' }, { label: 'Ship' }] } });
    expect(s.get('cl')!.data.progress).toEqual({ done: 0, total: 2 });
    s.update('cl', { data: { set: { tests: 'done', Ship: 'doing' } } });
    expect((s.get('cl')!.data.items as Array<{ status: string }>).map((i) => i.status)).toEqual(['done', 'doing']);
    expect(s.get('cl')!.data.progress).toEqual({ done: 1, total: 2 });
    expect(() => s.update('cl', { data: { set: { nope: 'done' } } })).toThrow(/no checklist item/);
    expect(() => s.update('cl', { data: { set: { tests: 'finished' } } })).toThrow(/invalid data/);
  });

  it('code, map and timeline validate their data', () => {
    const s = new CanvasStore();
    expect(s.place({ kind: 'code', title: 'c', data: { code: 'const a = 1;', language: 'ts', highlight: [1] } }).w).toBe(2);
    expect(() => s.place({ kind: 'code', title: 'c', data: {} })).toThrow(/code/);
    expect(s.place({ kind: 'map', title: 'm', data: { markers: [{ lat: -37.8, lon: 144.9, label: 'Melbourne', value: 3 }] } }).data.markers).toHaveLength(1);
    expect(() => s.place({ kind: 'map', title: 'm', data: { markers: [{ lat: 95, lon: 0, label: 'x' }] } })).toThrow();
    expect(() => s.place({ kind: 'map', title: 'm', data: { markers: [{ lat: 0, lon: 0, label: 'x', color: 'red;}' }] } })).toThrow();
    expect(s.place({ kind: 'timeline', title: 't', data: { items: [{ at: '2026-10-01', title: 'Kick-off', status: 'ok' }] } }).w).toBe(4);
    expect(s.place({ kind: 'timeline', title: 't', data: { items: [] } }).data.items).toEqual([]); // empty state, filled in later
  });
});
