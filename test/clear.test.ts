import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHub, type Hub } from '../src/hub.js';
import { createScreenServer } from '../src/mcp.js';
import { CanvasStore } from '../src/store.js';
import type { ScreenEvent } from '../src/types.js';

describe('clear_canvas', () => {
  it('removes everything, keeps reports, and undo restores the exact widgets', () => {
    const s = new CanvasStore();
    const events: ScreenEvent[] = [];
    s.bus.on((e) => events.push(e));
    s.place({ id: 'a', kind: 'text', title: 'A', data: { text: '1' } });
    s.place({ id: 'b', kind: 'metric', title: 'B', data: { value: 2 } });
    s.postReport({ agent: 'x', worktree: 'w', summary: 'kept' });
    s.setSelection('a', { picked: true });
    expect(s.clear()).toEqual({ removed: 2 });
    expect(s.list()).toHaveLength(0);
    expect(s.listReports()).toHaveLength(1);
    expect(events.filter((e) => e.type === 'remove')).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'cleared', count: 2, undoable: true });
    expect(s.canUndoClear()).toBe(true);
    const back = s.undoClear();
    expect(back.map((w) => w.id)).toEqual(['a', 'b']);
    expect(s.read('a').selection).toEqual({ picked: true });
    expect(s.canUndoClear()).toBe(false);
    expect(s.undoClear()).toEqual([]);
  });

  it('clearing an empty canvas is a no-op and does not lose a pending undo', () => {
    const s = new CanvasStore();
    s.place({ id: 'a', kind: 'text', title: 'A', data: { text: '1' } });
    s.clear();
    expect(s.clear()).toEqual({ removed: 0 });
    expect(s.undoClear()).toHaveLength(1);
  });

  it('does not restore over an id that was reused, and never restores an open question', async () => {
    const s = new CanvasStore();
    s.place({ id: 'a', kind: 'text', title: 'old', data: { text: '1' } });
    const q = s.ask({ question: 'q', choices: [{ id: '1', label: 'one' }, { id: '2', label: 'two' }] });
    s.clear();
    await expect(q.result).resolves.toMatchObject({ reason: 'removed' });
    s.place({ id: 'a', kind: 'text', title: 'new', data: { text: '2' } });
    expect(s.undoClear()).toEqual([]);
    expect(s.read('a').title).toBe('new');
  });
});

describe('clear_canvas over MCP + HTTP', () => {
  let hub: Hub | undefined;
  afterEach(async () => hub?.close());

  it('tool clears and undoes; live sources restart after undo', async () => {
    const command = vi.fn(async () => 'tick');
    hub = await startHub({ port: 0, home: null, runners: { command } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createScreenServer(hub.api).connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    const w = await hub.api.place({ kind: 'text', title: 'live', data: { text: '' }, source: { type: 'command', argv: ['date'] } });
    hub.scheduler.approve(w.id);
    expect(hub.scheduler.isScheduled(w.id)).toBe(true);
    const cleared = JSON.parse(((await client.callTool({ name: 'clear_canvas', arguments: {} })).content as Array<{ text: string }>)[0]!.text);
    expect(cleared.removed).toBe(1);
    expect(hub.scheduler.isScheduled(w.id)).toBe(false);
    const undone = JSON.parse(((await client.callTool({ name: 'clear_canvas', arguments: { undo: true } })).content as Array<{ text: string }>)[0]!.text);
    expect(undone).toEqual({ restored: 1 });
    expect(hub.scheduler.isScheduled(w.id)).toBe(true);
  });

  it('HTTP clear/undo endpoints need the token', async () => {
    hub = await startHub({ port: 0, home: null });
    await hub.api.place({ kind: 'text', title: 'x', data: { text: '' } });
    expect((await fetch(`${hub.url}/api/canvas/clear`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    const h = { 'content-type': 'application/json', 'x-mcp-screen-token': hub.token };
    expect((await (await fetch(`${hub.url}/api/canvas/clear`, { method: 'POST', headers: h, body: '{}' })).json()).result).toEqual({ removed: 1 });
    const state = (await (await fetch(`${hub.url}/api/state`, { headers: h })).json()).result;
    expect(state.canUndoClear).toBe(true);
    expect((await (await fetch(`${hub.url}/api/canvas/undo`, { method: 'POST', headers: h, body: '{}' })).json()).result).toEqual({ restored: 1 });
  });
});
