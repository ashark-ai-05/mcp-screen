import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteApi } from '../src/api.js';
import { startHub, type Hub } from '../src/hub.js';
import { createScreenServer } from '../src/mcp.js';
import { CanvasStore } from '../src/store.js';

const choices = [
  { id: 'a', label: 'Cards', description: 'grid of cards' },
  { id: 'b', label: 'Table', preview: '- dense\n- sortable' },
  { id: 'c', label: 'Kanban' },
];
const post = (hub: Hub, path: string, body: unknown) =>
  fetch(`${hub.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcp-screen-token': hub.token }, body: JSON.stringify(body) });
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe('ask_user: store', () => {
  it('places an open question card and resolves with the clicked choice', async () => {
    const s = new CanvasStore();
    const { widget, result } = s.ask({ question: 'Which layout?', choices });
    expect(widget.kind).toBe('question');
    expect(widget.data.state).toBe('open');
    expect(widget.w).toBe(3);
    expect(widget.h).toBe(2);
    s.answer(widget.id, 'b');
    await expect(result).resolves.toEqual({ answered: true, choice: { id: 'b', label: 'Table' }, widgetId: widget.id });
    expect(s.read(widget.id).data).toMatchObject({ state: 'answered', answer: { id: 'b', label: 'Table' } });
    expect(s.read(widget.id).selection).toEqual({ id: 'b', label: 'Table' });
    expect(() => s.answer(widget.id, 'a')).toThrow(/already answered/);
  });

  it('times out, honours abort, and resolves when the card is removed', async () => {
    vi.useFakeTimers();
    const s = new CanvasStore();
    const t = s.ask({ question: 'q', choices, timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(5001);
    await expect(t.result).resolves.toMatchObject({ answered: false, reason: 'timeout' });
    expect(s.read(t.widget.id).data.state).toBe('timeout');
    vi.useRealTimers();

    const ctrl = new AbortController();
    const c = s.ask({ question: 'q', choices, signal: ctrl.signal });
    ctrl.abort();
    await expect(c.result).resolves.toMatchObject({ reason: 'cancelled' });
    expect(s.read(c.widget.id).data.state).toBe('cancelled');

    const r = s.ask({ question: 'q', choices });
    s.remove(r.widget.id);
    await expect(r.result).resolves.toMatchObject({ reason: 'removed' });
  });

  it('validates questions and choices', () => {
    const s = new CanvasStore();
    expect(() => s.ask({ question: 'q', choices: [choices[0]!] })).toThrow(/choices/);
    expect(() => s.ask({ question: 'q', choices: [choices[0]!, choices[0]!] })).toThrow(/unique/);
    const { widget } = s.ask({ question: 'q', choices });
    expect(() => s.answer(widget.id, 'zzz')).toThrow(/no choice/);
  });
});

describe('ask_user: over MCP and HTTP', () => {
  let hub: Hub | undefined;
  afterEach(async () => hub?.close());

  it('blocks the tool call until the human clicks in the browser', async () => {
    hub = await startHub({ port: 0, home: null });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createScreenServer(hub.api).connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    let done = false;
    const pending = client.callTool({ name: 'ask_user', arguments: { question: 'Ship it?', choices: [{ id: 'yes', label: 'Ship' }, { id: 'no', label: 'Wait' }] } }).finally(() => (done = true));
    await until(() => hub!.store.list().length === 1);
    expect(done).toBe(false);
    const q = hub.store.list()[0]!;
    expect((await post(hub, `/api/widgets/${q.id}/answer`, { choice: 'yes' })).status).toBe(200);
    const res = await pending;
    expect(JSON.parse((res.content as Array<{ text: string }>)[0]!.text)).toEqual({ answered: true, choice: { id: 'yes', label: 'Ship' } });
    expect((await post(hub, `/api/widgets/${q.id}/answer`, { choice: 'no' })).status).toBe(400);
  });

  it('works from a second session through the hub (RemoteApi long request)', async () => {
    hub = await startHub({ port: 0, home: null });
    const remote = new RemoteApi(hub.url, hub.token);
    const pending = remote.ask({ question: 'Pick', choices, timeoutMs: 10_000 });
    await until(() => hub!.store.list().length === 1);
    hub.store.answer(hub.store.list()[0]!.id, 'c');
    await expect(pending).resolves.toMatchObject({ answered: true, choice: { id: 'c' } });
  });

  it('cancels the card when the remote caller goes away', async () => {
    hub = await startHub({ port: 0, home: null });
    const remote = new RemoteApi(hub.url, hub.token);
    const ctrl = new AbortController();
    const pending = remote.ask({ question: 'Pick', choices, signal: ctrl.signal });
    await until(() => hub!.store.list().length === 1);
    ctrl.abort();
    await expect(pending).resolves.toMatchObject({ answered: false, reason: 'cancelled' });
    await until(() => hub!.store.list()[0]!.data.state === 'cancelled');
    expect(hub.store.list()[0]!.data.state).toBe('cancelled');
  });

  it('agents cannot place question widgets directly', async () => {
    hub = await startHub({ port: 0, home: null });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createScreenServer(hub.api).connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    const r = await client.callTool({ name: 'place_widget', arguments: { kind: 'question', title: 'x', data: { question: 'q', choices } } });
    expect(r.isError).toBe(true);
  });
});
