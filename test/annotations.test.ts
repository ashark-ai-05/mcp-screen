import { afterEach, describe, expect, it } from 'vitest';
import { RemoteApi } from '../src/api.js';
import { startHub, type Hub } from '../src/hub.js';
import { callScreenTool } from '../src/mcp.js';
import { CanvasStore } from '../src/store.js';

function setup() {
  const s = new CanvasStore();
  s.place({ id: 'ci', kind: 'chart', title: 'CI failures', data: { labels: ['10/08', '10/09'], values: [2, 9] }, w: 2, h: 2, x: 0, y: 0 });
  s.place({ id: 'notes', kind: 'markdown', title: 'Notes', data: { markdown: 'x' }, w: 1, h: 1, x: 1000, y: 0 });
  return s;
}

describe('annotations', () => {
  it('a circle over a chart targets it and keeps the data points the browser saw', () => {
    const s = setup();
    const a = s.annotate({ kind: 'circle', points: [[300, 60], [420, 200]], text: 'why?', dataPoints: [{ label: '10/09', value: 9 }] });
    expect(a.target).toEqual({ widgetId: 'ci', title: 'CI failures', kind: 'chart', dataPoints: [{ label: '10/09', value: 9 }] });
    expect(a.text).toBe('why?');
    expect(s.read('ci').annotations).toHaveLength(1);
    expect(s.read('notes').annotations).toHaveLength(0);
  });

  it('arrows target what the head points at; notes target what they sit on; empty space targets nothing', () => {
    const s = setup();
    expect(s.annotate({ kind: 'arrow', points: [[900, 400], [1050, 50]] }).target?.widgetId).toBe('notes');
    expect(s.annotate({ kind: 'note', points: [[100, 100]], text: 'looks wrong' }).target?.widgetId).toBe('ci');
    expect(s.annotate({ kind: 'note', points: [[5000, 5000]], text: 'todo' }).target).toBeUndefined();
  });

  it('a highlight that only partly covers a widget still targets the one it covers most', () => {
    const s = setup();
    const a = s.annotate({ kind: 'highlight', points: [[560, 20], [700, 40], [1020, 60]] });
    expect(a.target?.widgetId).toBe('ci');
  });

  it('moves with its widget, disappears with it, and survives clear + undo', () => {
    const s = setup();
    const a = s.annotate({ kind: 'circle', points: [[10, 10], [50, 50]] });
    s.move('ci', 100, 200);
    expect(s.listAnnotations()[0]!.points).toEqual([[110, 210], [150, 250]]);
    s.clear();
    expect(s.listAnnotations()).toHaveLength(0);
    s.undoClear();
    expect(s.listAnnotations().map((x) => x.id)).toEqual([a.id]);
    s.remove('ci');
    expect(s.listAnnotations()).toHaveLength(0);
  });

  it('rejects junk input and unknown colours', () => {
    const s = setup();
    expect(() => s.annotate({ kind: 'blob' as never, points: [[1, 1]] })).toThrow(/kind/);
    expect(() => s.annotate({ kind: 'note', points: [] })).toThrow(/points/);
    expect(() => s.annotate({ kind: 'note', points: [['a', 1]] as never })).toThrow(/numbers/);
    expect(s.annotate({ kind: 'note', points: [[1, 1]], color: 'url(javascript:x)' }).color).toBe('#ffd166');
    const n = s.annotate({ kind: 'note', points: [[1, 1]], text: 'a' });
    s.updateAnnotation(n.id, { text: '  edited ' });
    expect(s.listAnnotations().find((x) => x.id === n.id)!.text).toBe('edited');
  });

  let hub: Hub | undefined;
  afterEach(async () => hub?.close());
  it('the agent reads them through read_canvas / read_widget (over HTTP, like a second session)', async () => {
    hub = await startHub({ port: 0, home: null });
    hub.store.place({ id: 'ci', kind: 'chart', title: 'CI', data: { labels: ['a'], values: [1] }, x: 0, y: 0, w: 2, h: 2 });
    const res = await fetch(`${hub.url}/api/annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcp-screen-token': hub.token },
      body: JSON.stringify({ kind: 'circle', points: [[20, 20], [80, 80]], text: 'why?', dataPoints: [{ label: 'a', value: 1 }] }),
    });
    expect(res.status).toBe(200);
    const unauth = await fetch(`${hub.url}/api/annotations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauth.status).toBe(401);
    const remote = new RemoteApi(hub.url, hub.token);
    const canvas = JSON.parse(((await callScreenTool(remote, 'read_canvas', {}))!.content[0] as { text: string }).text);
    expect(canvas.annotations[0]).toMatchObject({ kind: 'circle', text: 'why?', target: { widgetId: 'ci', dataPoints: [{ label: 'a', value: 1 }] } });
    const w = JSON.parse(((await callScreenTool(remote, 'read_widget', { id: 'ci' }))!.content[0] as { text: string }).text);
    expect(w.annotations).toHaveLength(1);
    const id = canvas.annotations[0].id;
    const del = await fetch(`${hub.url}/api/annotations/${id}`, { method: 'DELETE', headers: { 'x-mcp-screen-token': hub.token } });
    expect(await del.json()).toEqual({ result: true });
  });
});
