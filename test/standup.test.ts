import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentName, buildFromHook, mergeHooks } from '../src/hook.js';
import { extractRisks, gitInfo, parseTestOutput, parseTranscript } from '../src/standup.js';
import { CanvasStore } from '../src/store.js';

const line = (o: unknown) => JSON.stringify(o);
const transcript = [
  line({ type: 'user', message: { content: 'add coupon validation' } }),
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at it.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npx vitest run' } }] } }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: ' Test Files  2 passed (2)\n      Tests  1 failed | 14 passed (15)' }] } }),
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: '      Tests  15 passed (15)' }] }] } }),
  'not json',
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Added coupon validation in checkout.\n- Risk: expired coupons from the old API are not tested\n- Done.' }] } }),
].join('\n');

describe('standup: transcript parsing', () => {
  it('takes the last assistant text as summary and the last test run', () => {
    const r = parseTranscript(transcript);
    expect(r.summary).toMatch(/^Added coupon validation/);
    expect(r.tests).toEqual({ status: 'pass', passed: 15, failed: 0, command: 'npm test' });
    expect(r.risks).toEqual(['Risk: expired coupons from the old API are not tested']);
  });

  it('parses common test runners', () => {
    expect(parseTestOutput('      Tests  2 failed | 10 passed (12)')).toMatchObject({ status: 'fail', passed: 10, failed: 2 });
    expect(parseTestOutput('Tests:       1 failed, 30 passed, 31 total')).toMatchObject({ status: 'fail', failed: 1, passed: 30 });
    expect(parseTestOutput('===== 3 failed, 41 passed in 2.1s =====')).toMatchObject({ status: 'fail', failed: 3, passed: 41 });
    expect(parseTestOutput('ok  \tgithub.com/x/y\t0.2s')).toEqual({ status: 'pass' });
    expect(parseTestOutput('--- FAIL: TestX')).toEqual({ status: 'fail' });
    expect(parseTestOutput('\x1b[32m 5 passed\x1b[0m')).toMatchObject({ status: 'pass', passed: 5 });
    expect(parseTestOutput('nothing here')).toEqual({ status: 'unknown' });
  });

  it('extracts risk-like lines only', () => {
    expect(extractRisks('All good\n* TODO: wire retries\nnormal line\n> Breaking: renamed export')).toEqual(['TODO: wire retries', 'Breaking: renamed export']);
  });
});

describe('standup: hooks', () => {
  function repo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-feature-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('init', '-q', '-b', 'feat/coupons');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'one\n');
    g('add', '.');
    g('commit', '-qm', 'init');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(dir, 'new.ts'), 'x\ny\n');
    return dir;
  }

  it('reads worktree, branch and changed files from git', () => {
    const dir = repo();
    const g = gitInfo(dir);
    expect(g.worktree).toBe(path.basename(dir));
    expect(g.branch).toBe('feat/coupons');
    expect(g.files).toEqual([
      { path: 'a.ts', added: 2, removed: 0 },
      { path: 'new.ts', added: 3, removed: 0 },
    ]);
  });

  it('turns a Stop hook payload into a full report card', () => {
    const dir = repo();
    const tp = path.join(dir, '..', `${path.basename(dir)}.jsonl`);
    fs.writeFileSync(tp, transcript);
    const { report } = buildFromHook({ hook_event_name: 'Stop', session_id: 'abc123456', cwd: dir, transcript_path: tp });
    expect(report).toMatchObject({ agent: 'claude-abc123', branch: 'feat/coupons', source: 'stop-hook', tests: { status: 'pass' } });
    expect(report?.filesChanged).toHaveLength(2);
    const store = new CanvasStore();
    const posted = store.postReport(report!);
    expect(store.listReports()[0]).toEqual(posted);
  });

  it('uses last_assistant_message and skips internal SubagentStop events (real Claude Code fields)', () => {
    const dir = repo();
    const { report } = buildFromHook({
      hook_event_name: 'SubagentStop', session_id: 'abc123', cwd: dir, stop_hook_active: false,
      agent_id: 'agent-def456', agent_type: 'Explore', agent_transcript_path: '/nope.jsonl',
      last_assistant_message: 'Found 3 issues.\n- Risk: auth module untested',
    });
    expect(report).toMatchObject({ agent: 'Explore-def456', summary: 'Found 3 issues.\n- Risk: auth module untested', risks: ['Risk: auth module untested'], source: 'subagent-stop-hook' });
    expect(buildFromHook({ hook_event_name: 'SubagentStop', agent_type: '', cwd: dir })).toEqual({});
  });

  it('names subagents and maps PostToolUse edits to file events', () => {
    expect(agentName({ hook_event_name: 'SubagentStop', session_id: 'ffeedd00' })).toBe('subagent-ffeedd');
    expect(agentName({ hook_event_name: 'SubagentStop', agent_type: 'test-writer' })).toBe('test-writer');
    expect(buildFromHook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', cwd: '/r', session_id: 's1', tool_input: { file_path: '/r/src/a.ts' } }).fileEvent)
      .toEqual({ path: '/r/src/a.ts', cwd: '/r', agent: 'claude-s1', tool: 'Edit' });
    expect(buildFromHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} })).toEqual({});
  });

  it('merges hook config idempotently and keeps existing hooks', () => {
    const existing = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
    const once = mergeHooks(existing);
    const twice = mergeHooks(once);
    expect(twice).toEqual(once);
    const stop = (once.hooks as Record<string, unknown[]>).Stop!;
    expect(stop).toHaveLength(2);
    expect(once.model).toBe('x');
  });
});
