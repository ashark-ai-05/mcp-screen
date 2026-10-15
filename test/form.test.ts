import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteApi } from '../src/api.js';
import { startHub, type Hub } from '../src/hub.js';
import { createScreenServer } from '../src/mcp.js';
import { checkFormValues, CanvasStore } from '../src/store.js';
import type { FormField } from '../src/registry.js';

const fields: FormField[] = [
  { id: 'name', label: 'Service name', type: 'text', required: true },
  { id: 'users', label: 'Virtual users', type: 'slider', min: 1, max: 500, step: 1, default: 50 },
  { id: 'region', label: 'Region', type: 'select', options: ['syd', 'iad', { value: 'fra', label: 'Frankfurt' }] },
  { id: 'budget', label: 'Budget ($)', type: 'number', min: 0 },
  { id: 'dry', label: 'Dry run', type: 'checkbox' },
];

describe('ask_form', () => {
  it('coerces and checks values against the fields', () => {
    expect(checkFormValues(fields, { name: 'api', users: '120', region: 'fra', budget: '', dry: 'on' })).toEqual({ name: 'api', users: 120, region: 'fra', budget: null, dry: true });
    expect(() => checkFormValues(fields, { users: 5 })).toThrow(/Service name.*required/);
    expect(() => checkFormValues(fields, { name: 'a', users: 900 })).toThrow(/at most 500/);
    expect(() => checkFormValues(fields, { name: 'a', region: 'mars' })).toThrow(/one of/);
    expect(() => checkFormValues(fields, { name: 'a', budget: 'lots' })).toThrow(/number/);
  });

  it('blocks until submit; a bad submit keeps it open; second submit is refused', async () => {
    const s = new CanvasStore();
    const { widget, result } = s.askForm({ prompt: 'Configure the load test', fields });
    expect(widget.kind).toBe('form');
    expect(() => s.submitForm(widget.id, { users: 3 })).toThrow(/required/);
    expect(s.get(widget.id)!.data.state).toBe('open');
    s.submitForm(widget.id, { name: 'checkout', users: 200, region: 'syd', dry: false });
    await expect(result).resolves.toEqual({ submitted: true, values: { name: 'checkout', users: 200, region: 'syd', budget: null, dry: false }, widgetId: widget.id });
    expect(() => s.submitForm(widget.id, { name: 'x' })).toThrow(/already submitted/);
  });

  it('times out, cancels, and reports removal in its own result shape', async () => {
    vi.useFakeTimers();
    const s = new CanvasStore();
    const t = s.askForm({ prompt: 'p', fields, timeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(2001);
    await expect(t.result).resolves.toMatchObject({ submitted: false, reason: 'timeout' });
    vi.useRealTimers();
    const r = s.askForm({ prompt: 'p', fields });
    s.remove(r.widget.id);
    await expect(r.result).resolves.toMatchObject({ submitted: false, reason: 'removed' });
    const ctrl = new AbortController();
    const c = s.askForm({ prompt: 'p', fields, signal: ctrl.signal });
    ctrl.abort();
    await expect(c.result).resolves.toMatchObject({ submitted: false, reason: 'cancelled' });
  });

  it('rejects bad field definitions at ask time', () => {
    const s = new CanvasStore();
    expect(() => s.askForm({ prompt: 'p', fields: [{ id: 'x', label: 'X', type: 'select' }] })).toThrow(/options/);
    expect(() => s.askForm({ prompt: 'p', fields: [{ id: 'x', label: 'X', type: 'slider', min: 5, max: 1 }] })).toThrow(/min < max/);
    expect(() => s.askForm({ prompt: 'p', fields: [{ id: 'x', label: 'X', type: 'text' }, { id: 'x', label: 'Y', type: 'text' }] })).toThrow(/unique/);
  });

  let hub: Hub | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    await hub?.close();
  });
  it('end to end: MCP tool over a remote session, answered by an HTTP submit like the browser does', async () => {
    hub = await startHub({ port: 0, home: null });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createScreenServer(new RemoteApi(hub.url, hub.token)).connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    const pending = client.callTool({ name: 'ask_form', arguments: { prompt: 'Configure', fields, timeoutSeconds: 30 } });
    for (let i = 0; i < 100 && !hub.store.list().some((w) => w.kind === 'form'); i++) await new Promise((r) => setTimeout(r, 10));
    const form = hub.store.list().find((w) => w.kind === 'form')!;
    const submit = (values: unknown) =>
      fetch(`${hub!.url}/api/widgets/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcp-screen-token': hub!.token }, body: JSON.stringify({ values }) });
    expect((await submit({})).status).toBe(400);
    expect((await submit({ name: 'api', users: 10, region: 'iad' })).status).toBe(200);
    const res = await pending;
    expect(JSON.parse(res.content[0].text)).toEqual({ submitted: true, values: { name: 'api', users: 10, region: 'iad', budget: null, dry: false } });
    expect((await client.callTool({ name: 'place_widget', arguments: { kind: 'form', title: 'x', data: {} } })).isError).toBe(true);
    await client.close();
  });
});
