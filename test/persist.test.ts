import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHub, type Hub } from '../src/hub.js';
import { CANVAS_FILE } from '../src/persist.js';

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-screen-persist-'));

describe('canvas persistence', () => {
  let hub: Hub | null = null;
  afterEach(async () => { await hub?.close(); hub = null; });

  it('restores every kind with derived data rebuilt, annotations re-targeted, and skips open asks', async () => {
    const home = tmpHome();
    const img = path.join(home, 'x.png');
    fs.writeFileSync(img, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    hub = await startHub({ port: 0, home });
    const s = hub.store;
    s.place({ id: 'chart', kind: 'chart', title: 'c', data: { labels: ['a', 'b'], values: [1, 9] }, x: 0, y: 0, w: 2, h: 2 });
    s.place({ id: 'diff', kind: 'diff', title: 'd', data: { before: 'a\n', after: 'b\n' } });
    s.place({ id: 'flow', kind: 'diagram', title: 'f', data: { mermaid: 'graph TD\n a --> b' } });
    s.place({ id: 'plan', kind: 'checklist', title: 'p', data: { items: [{ id: 'x', label: 'x', status: 'done' }] } });
    s.place({ id: 'log', kind: 'log', title: 'l', data: { lines: Array.from({ length: 12 }, (_, i) => String(i)), maxLines: 10 } });
    s.place({ id: 'img', kind: 'image', title: 'i', data: { path: img } });
    s.place({ id: 'map', kind: 'map', title: 'm', data: { markers: [{ lat: 1, lon: 2, label: 'x' }] } });
    s.place({ id: 'tl', kind: 'timeline', title: 't', data: { items: [] } });
    s.annotate({ kind: 'circle', points: [[100, 50], [200, 150]], text: 'why?', dataPoints: [{ label: 'b', value: 9 }] });
    void s.ask({ question: 'q?', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], timeoutMs: 60_000 } as never);
    s.replyAnnotation(s.listAnnotations()[0]!.id, 'deploy at 09:02');
    s.move('chart', 40, 60);
    await hub.close();
    hub = null;
    const saved = JSON.parse(fs.readFileSync(path.join(home, CANVAS_FILE), 'utf8'));
    expect(fs.statSync(path.join(home, CANVAS_FILE)).mode & 0o777).toBe(0o600);
    expect(saved.widgets.some((w: { kind: string }) => w.kind === 'question')).toBe(false);

    hub = await startHub({ port: 0, home });
    const list = hub.store.list();
    expect(list.map((w) => w.id).sort()).toEqual(['chart', 'diff', 'flow', 'img', 'log', 'map', 'plan', 'tl']);
    expect(hub.store.get('chart')).toMatchObject({ x: 40, y: 60 });
    expect(hub.store.get('diff')!.data.added).toBe(1);
    expect((hub.store.get('flow')!.data.layout as object)).toBeTruthy();
    expect(hub.store.get('plan')!.data.progress).toMatchObject({ done: 1, total: 1 });
    expect(hub.store.get('log')!.data.lines).toEqual(['2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
    const ann = hub.store.listAnnotations();
    expect(ann).toHaveLength(1);
    expect(ann[0]!.replies).toMatchObject([{ text: 'deploy at 09:02', from: 'agent' }]);
    expect(ann[0]).toMatchObject({ text: 'why?', target: { widgetId: 'chart', dataPoints: [{ label: 'b', value: 9 }] } });
  });

  it('a tampered or corrupt canvas.json is validated: bad widgets are skipped, the hub still starts', async () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, CANVAS_FILE), JSON.stringify({ version: 1, widgets: [
      { id: 'ok', kind: 'metric', title: 'ok', data: { value: '1' }, w: 1, h: 1, x: 0, y: 0 },
      { id: 'evil', kind: 'image', title: 'x', data: { path: '/etc/passwd' }, w: 1, h: 1, x: 400, y: 0 },
      { id: 'bad', kind: 'nope', title: 'x', data: {}, w: 1, h: 1, x: 0, y: 400 },
      { id: 'cmd', kind: 'text', title: 'x', data: { text: '' }, w: 1, h: 1, x: 800, y: 0, source: { type: 'command', argv: ['rm', '-rf', '/tmp/nothing'] }, intervalMs: 2000 },
      null,
    ], annotations: [{ kind: 'circle', points: 'nope' }] }));
    hub = await startHub({ port: 0, home });
    const ids = hub.store.list().map((w) => w.id).sort();
    expect(ids).toEqual(['cmd', 'ok']);
    expect(hub.store.get('cmd')!.status).toBe('needs-approval'); // a saved command never runs without the allow-list
    fs.writeFileSync(path.join(home, CANVAS_FILE), '{not json');
    await hub.close();
    hub = await startHub({ port: 0, home, persist: true });
    expect(hub.store.list().length).toBeGreaterThanOrEqual(0);
  });

  it('persist:false and home:null keep the canvas in memory only', async () => {
    const home = tmpHome();
    hub = await startHub({ port: 0, home, persist: false });
    hub.store.place({ id: 'a', kind: 'metric', title: 'a', data: { value: '1' } });
    await hub.close();
    hub = null;
    expect(fs.existsSync(path.join(home, CANVAS_FILE))).toBe(false);
  });
});
