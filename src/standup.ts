import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FileChange, TestResult } from './types.js';

const TEST_CMD = /\b(vitest|jest|pytest|mocha|go test|cargo test|npm (run )?test|pnpm (run )?test|yarn test|bun test|rspec|phpunit)\b/;

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: { command?: string };
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

/** Parse a Claude Code transcript (JSONL) into summary, last test run and risks. */
export function parseTranscript(jsonl: string): { summary: string; tests: TestResult; risks: string[] } {
  let summary = '';
  let tests: TestResult = { status: 'unknown' };
  const testCalls = new Map<string, string>();
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { content?: string | Block[] } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry.message?.content;
    if (entry.type === 'assistant' && Array.isArray(content)) {
      const text = content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n').trim();
      if (text) summary = text;
      for (const b of content) {
        if (b.type === 'tool_use' && b.name === 'Bash' && b.id && b.input?.command && TEST_CMD.test(b.input.command))
          testCalls.set(b.id, b.input.command);
      }
    } else if (entry.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type !== 'tool_result' || !b.tool_use_id || !testCalls.has(b.tool_use_id)) continue;
        const out = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => c.text ?? '').join('\n');
        tests = { ...parseTestOutput(out, b.is_error === true), command: testCalls.get(b.tool_use_id) as string };
      }
    }
  }
  return { summary: summary.slice(0, 2000), tests, risks: extractRisks(summary) };
}

/** Understands vitest/jest ("Tests  3 failed | 12 passed"), pytest ("2 failed, 10 passed") and go/cargo. */
export function parseTestOutput(out: string, isError = false): TestResult {
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  const num = (re: RegExp): number | undefined => {
    const all = [...plain.matchAll(re)];
    const m = all[all.length - 1];
    return m ? Number(m[1]) : undefined;
  };
  const testsLine = plain.split('\n').reverse().find((l) => /^\s*Tests:?\s/.test(l)) ?? '';
  let passed: number | undefined;
  let failed: number | undefined;
  if (testsLine) {
    passed = Number(/(\d+) passed/.exec(testsLine)?.[1] ?? NaN);
    failed = Number(/(\d+) failed/.exec(testsLine)?.[1] ?? 0);
    if (Number.isNaN(passed)) passed = undefined;
  } else {
    passed = num(/(\d+) passed/g);
    failed = num(/(\d+) failed/g);
  }
  if (passed === undefined && failed === undefined) {
    if (/^(ok|PASS)\b/m.test(plain) && !/^(FAIL|---\s*FAIL)/m.test(plain)) return { status: 'pass' };
    if (/^(FAIL|---\s*FAIL)/m.test(plain) || isError) return { status: 'fail' };
    return { status: 'unknown' };
  }
  const res: TestResult = { status: (failed ?? 0) > 0 || (isError && !passed) ? 'fail' : 'pass' };
  if (passed !== undefined) res.passed = passed;
  if (failed !== undefined) res.failed = failed;
  return res;
}

/** Lines from the agent's own summary that read as risks / caveats. */
export function extractRisks(summary: string): string[] {
  return summary
    .split('\n')
    .map((l) => l.replace(/^[\s>*\-•]+/, '').trim())
    .filter((l) => /\b(risk|caveat|todo|not (yet )?tested|untested|breaking|careful|warning|follow[- ]up|hack)\b/i.test(l))
    .slice(0, 6)
    .map((l) => l.slice(0, 240));
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch {
    return '';
  }
}

/** Worktree name, branch and changed files (vs HEAD, plus untracked) for a directory. */
export function gitInfo(cwd: string): { worktree: string; branch?: string; files: FileChange[] } {
  const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  if (!top) return { worktree: path.basename(cwd), files: [] };
  const branch = git(top, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || undefined;
  const files: FileChange[] = [];
  for (const line of git(top, ['diff', '--numstat', 'HEAD']).split('\n')) {
    const [a, r, p] = line.split('\t');
    if (!p) continue;
    files.push({ path: p, added: a === '-' ? 0 : Number(a), removed: r === '-' ? 0 : Number(r) });
  }
  for (const p of git(top, ['ls-files', '--others', '--exclude-standard']).split('\n')) {
    if (!p) continue;
    let added = 0;
    try {
      const full = path.join(top, p);
      if (fs.statSync(full).size < 1_000_000) added = fs.readFileSync(full, 'utf8').split('\n').length;
    } catch {
      /* ignore */
    }
    files.push({ path: p, added, removed: 0 });
  }
  const res: { worktree: string; branch?: string; files: FileChange[] } = { worktree: path.basename(top), files };
  if (branch) res.branch = branch;
  return res;
}
