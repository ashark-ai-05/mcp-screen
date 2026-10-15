import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHub, type Hub } from '../src/hub.js';
import { runHook } from '../src/hook.js';

describe('runHook pending context', () => {
  let hub: Hub | undefined;
  let home: string | undefined;
  const prevHome = process.env.MCP_SCREEN_HOME;
  afterEach(async () => {
    await hub?.close();
    if (home) fs.rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.MCP_SCREEN_HOME;
    else process.env.MCP_SCREEN_HOME = prevHome;
  });

  it('UserPromptSubmit stdout injects pending notes; quiet when none', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ph-'));
    process.env.MCP_SCREEN_HOME = home;
    hub = await startHub({ port: 0, home, canvas: 'demo' });
    // hub.json is written by startHub into home — readHubInfo uses MCP_SCREEN_HOME
    expect((await runHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit' }))).posted).toBe('nothing');

    hub.store.place({ id: 'c', kind: 'chart', title: 'CI', data: { labels: ['a'], values: [1] }, x: 0, y: 0, w: 2, h: 2 });
    hub.store.annotate({ kind: 'circle', points: [[10, 10], [40, 40]], text: 'why this spike?', dataPoints: [{ label: 'a', value: 1 }] });

    const r = await runHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit' }));
    expect(r.posted).toBe('pending-context');
    const j = JSON.parse(r.stdout!);
    expect(j.hookSpecificOutput.additionalContext).toMatch(/why this spike/);
    expect(j.hookSpecificOutput.additionalContext).toMatch(/reply_annotation/);

    const s = await runHook(JSON.stringify({ hook_event_name: 'SessionStart' }));
    expect(s.posted).toBe('pending-context');
  });
});
