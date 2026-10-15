import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/bus.js';
import { startHub, type Hub } from '../src/hub.js';
import { createScreenServer } from '../src/mcp.js';
import { CanvasStore } from '../src/store.js';
import type { ScreenEvent } from '../src/types.js';

describe('EventBus', () => {
  it('fans out to every subscriber in order and stops after close', async () => {
    const bus = new EventBus();
    const a = bus.subscribe();
    const b = bus.subscribe();
    bus.push({ type: 'remove', id: '1' });
    bus.push({ type: 'remove', id: '2' });
    const ia = a[Symbol.asyncIterator]();
    expect((await ia.next()).value).toEqual({ type: 'remove', id: '1' });
    expect((await ia.next()).value).toEqual({ type: 'remove', id: '2' });
    a.close();
    expect(bus.subscriberCount()).toBe(1);
    expect((await ia.next()).done).toBe(true);
    b.close();
  });
});

describe('CanvasStore', () => {
  it('validates data per kind', () => {
    const s = new CanvasStore();
    expect(() => s.place({ kind: 'table', title: 't', data: { columns: [] , rows: [] } })).toThrow(/columns/);
    expect(() => s.place({ kind: 'chart', title: 'c', data: { labels: ['a'], values: [1, 2] } })).toThrow(/same length/);
    const w = s.place({ kind: 'chart', title: 'c', data: { labels: ['a'], values: [1] } });
    expect(w.data.type).toBe('bar');
    expect(w.w).toBe(2);
  });

  it('places, merges updates, records selection and emits events', () => {
    const s = new CanvasStore();
    const events: ScreenEvent[] = [];
    s.bus.on((e) => events.push(e));
    const w = s.place({ id: 'kv1', kind: 'kv', title: 'Env', data: { items: { node: '20' } } });
    s.update('kv1', { data: { items: { node: '22' } }, merge: true, title: 'Runtime' });
    s.setSelection('kv1', { row: 1 });
    const read = s.read('kv1');
    expect(read.title).toBe('Runtime');
    expect(read.data.items).toEqual({ node: '22' });
    expect(read.selection).toEqual({ row: 1 });
    expect(() => s.place({ id: w.id, kind: 'text', title: 'dup', data: { text: '' } })).toThrow(/already exists/);
    s.update('kv1', { data: { items: { only: 'this' } }, merge: false });
    expect(s.read('kv1').data.items).toEqual({ only: 'this' });
    expect(s.remove('kv1')).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['widget', 'widget', 'widget', 'widget', 'remove']);
    expect(s.readCanvas().widgets).toHaveLength(0);
  });

  it('marks widgets with a source as needing approval and clamps the interval', () => {
    const s = new CanvasStore();
    const w = s.place({ kind: 'text', title: 'x', data: { text: '' }, source: { type: 'command', argv: ['date'] }, intervalMs: 10 });
    expect(w.status).toBe('needs-approval');
    expect(w.intervalMs).toBe(2000);
  });
});

describe('MCP tools (in-memory client)', () => {
  let hub: Hub | undefined;
  afterEach(async () => hub?.close());

  async function connect() {
    hub = await startHub({ port: 0, home: null });
    const server = createScreenServer(hub.api);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(ct);
    return client;
  }
  const json = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);

  it('lists the screen tools', async () => {
    const c = await connect();
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['place_widget', 'update_widget', 'read_widget', 'read_canvas', 'remove_widget', 'clear_canvas', 'ask_user', 'ask_form', 'tidy_canvas', 'post_report']);
  });

  it('place -> update -> read -> read_canvas round-trip, with selection from the browser', async () => {
    const c = await connect();
    const placed = json(
      await c.callTool({ name: 'place_widget', arguments: { id: 'ci', kind: 'table', title: 'CI', data: { columns: ['job', 'fails'], rows: [['lint', 1]] } } }),
    );
    expect(placed.id).toBe('ci');
    await c.callTool({ name: 'update_widget', arguments: { id: 'ci', data: { rows: [['lint', 1], ['e2e', 7]] }, merge: true } });
    // the human clicks a row in the browser
    await fetch(`${hub!.url}/api/widgets/ci/selection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcp-screen-token': hub!.token },
      body: JSON.stringify({ selection: { rowIndex: 1, row: { job: 'e2e', fails: 7 } } }),
    });
    const read = json(await c.callTool({ name: 'read_widget', arguments: { id: 'ci' } }));
    expect(read.data.rows).toHaveLength(2);
    expect(read.selection.row.job).toBe('e2e');
    const canvas = json(await c.callTool({ name: 'read_canvas', arguments: {} }));
    expect(canvas.widgets[0]).toMatchObject({ id: 'ci', kind: 'table' });
  });

  it('update_widget merges partial data by default (agents send only what changed)', async () => {
    const c = await connect();
    await c.callTool({ name: 'place_widget', arguments: { id: 'm', kind: 'livemap', title: 'A', data: { nodes: [{ id: 'a', label: 'A', globs: ['a/**'] }, { id: 'b', label: 'B', globs: ['b/**'] }] } } });
    const r = await c.callTool({ name: 'update_widget', arguments: { id: 'm', data: { edges: [{ from: 'a', to: 'b' }] } } });
    expect(r.isError).toBeFalsy();
    expect(json(await c.callTool({ name: 'read_widget', arguments: { id: 'm' } })).data.nodes).toHaveLength(2);
  });

  it('returns tool errors instead of throwing', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'place_widget', arguments: { kind: 'nope', title: 'x', data: {} } });
    expect(r.isError).toBe(true);
    const r2 = await c.callTool({ name: 'read_widget', arguments: { id: 'missing' } });
    expect(r2.isError).toBe(true);
  });

  it('agents cannot place raw mcp-app widgets through place_widget', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'place_widget', arguments: { kind: 'mcp-app', title: 'x', data: { html: '<script>', resourceUri: 'ui://x', toolName: 'x' } } });
    expect(r.isError).toBe(true);
  });
});

describe('hub HTTP security', () => {
  let hub: Hub | undefined;
  afterEach(async () => hub?.close());

  it('requires the token, rejects foreign Host headers and serves a CSP', async () => {
    hub = await startHub({ port: 0, home: null });
    expect((await fetch(`${hub.url}/api/canvas`)).status).toBe(401);
    expect((await fetch(`${hub.url}/api/canvas`, { headers: { 'x-mcp-screen-token': hub.token } })).status).toBe(200);
    // fetch() won't let us forge Host, so use node:http like a DNS-rebinding page would look to us
    const rebindStatus = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: hub!.port, path: '/', headers: { host: 'evil.example:4747' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
    });
    expect(rebindStatus).toBe(403);
    const page = await fetch(`${hub.url}/`);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await page.text()).toContain(hub.token);
    const noJson = await fetch(`${hub.url}/api/widgets`, { method: 'POST', headers: { 'x-mcp-screen-token': hub.token }, body: '{}' });
    expect(noJson.status).toBe(415);
  });
});
