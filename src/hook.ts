import fs from 'node:fs';
import { RemoteApi } from './api.js';
import { readHubInfo } from './hub.js';
import { extractRisks, gitInfo, parseTranscript } from './standup.js';
import type { FileAction, FileEvent, Report } from './types.js';
import type { ReportInput } from './store.js';

/** The subset of Claude Code hook stdin we use. */
export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  agent_transcript_path?: string;
  cwd?: string;
  agent_type?: string;
  agent_id?: string;
  /** Final assistant text on Stop/SubagentStop (preferred: the transcript may lag). */
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string; path?: string };
}

const FILE_TOOLS: Record<string, FileAction> = { Read: 'read', Write: 'create', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit' };

export function agentName(p: HookPayload): string {
  const short = (p.session_id ?? '').slice(0, 6);
  if (p.agent_type) return p.agent_id ? `${p.agent_type}-${p.agent_id.replace(/^agent-/, '').slice(0, 6)}` : p.agent_type;
  if (p.hook_event_name === 'SubagentStop') return `subagent${short ? `-${short}` : ''}`;
  return `claude${short ? `-${short}` : ''}`;
}

/** Turn a hook payload into what we post to the hub. Pure apart from reading git and the transcript. */
export function buildFromHook(p: HookPayload): { report?: ReportInput; fileEvent?: FileEvent } {
  const event = p.hook_event_name;
  const cwd = p.cwd ?? process.cwd();
  if (event === 'PostToolUse') {
    const file = p.tool_input?.file_path ?? p.tool_input?.notebook_path;
    if (!file || (p.tool_name && !(p.tool_name in FILE_TOOLS))) return {};
    const fe: FileEvent = { path: file, cwd, agent: agentName(p) };
    if (p.tool_name) {
      fe.tool = p.tool_name;
      fe.action = FILE_TOOLS[p.tool_name] ?? 'edit';
    }
    return { fileEvent: fe };
  }
  if (event === 'Stop' || event === 'SubagentStop') {
    // Claude Code also fires SubagentStop for its own internal agents (prompt suggestions, /btw);
    // those carry an empty agent_type and did no work worth a card.
    if (event === 'SubagentStop' && p.agent_type === '') return {};
    const transcriptPath = (event === 'SubagentStop' && p.agent_transcript_path) || p.transcript_path;
    let parsed: ReturnType<typeof parseTranscript> = { summary: '', tests: { status: 'unknown' }, risks: [] };
    if (transcriptPath) {
      try {
        parsed = parseTranscript(fs.readFileSync(transcriptPath, 'utf8'));
      } catch {
        /* transcript unreadable: still post files changed */
      }
    }
    const g = gitInfo(cwd);
    const report: ReportInput = {
      agent: agentName(p),
      worktree: g.worktree,
      summary: (p.last_assistant_message?.trim() || parsed.summary || '(no summary)').slice(0, 2000),
      filesChanged: g.files,
      tests: parsed.tests,
      risks: p.last_assistant_message ? extractRisks(p.last_assistant_message) : parsed.risks,
      source: event === 'Stop' ? 'stop-hook' : 'subagent-stop-hook',
    };
    if (g.branch) report.branch = g.branch;
    if (p.session_id) report.sessionId = p.session_id;
    return { report };
  }
  return {};
}

export type PendingQ = { canvas: string; title: string; id: string; kind: string; question: string; target?: { title?: string; widgetId?: string; dataPoints?: unknown[] } };

/** Plain text the agent sees when humans left notes it hasn't answered. */
export function formatPendingContext(qs: PendingQ[]): string {
  if (!qs.length) return '';
  const lines = qs.slice(0, 12).map((q, i) => {
    const where = q.target?.title ? ` on “${q.target.title}”` : '';
    const pts = Array.isArray(q.target?.dataPoints) && q.target!.dataPoints!.length
      ? ` · points at ${JSON.stringify(q.target!.dataPoints!.slice(0, 3))}`
      : '';
    return `${i + 1}. [${q.kind}${where}] “${q.question}” (id: ${q.id}, canvas: ${q.canvas})${pts}`;
  });
  const more = qs.length > 12 ? `
…and ${qs.length - 12} more.` : '';
  return (
    `mcp-screen: you have ${qs.length} note${qs.length === 1 ? '' : 's'} waiting on the canvas. ` +
    `Call read_canvas (see pendingQuestions) then reply_annotation for each before moving on.\n` +
    lines.join('\n') + more
  );
}

/** Claude Code UserPromptSubmit / SessionStart JSON that injects additionalContext. */
export function pendingHookOutput(qs: PendingQ[], event: string): string | null {
  const text = formatPendingContext(qs);
  if (!text) return null;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  });
}

/**
 * `mcp-screen hook`: read stdin, post to the running hub when appropriate, and for
 * UserPromptSubmit / SessionStart print additionalContext when notes are waiting.
 * Never blocks or fails the agent (empty stdout + exit 0 on errors).
 */
export async function runHook(stdin: string): Promise<{
  posted: 'report' | 'file-event' | 'pending-context' | 'nothing';
  result?: Report | unknown;
  /** Write this to stdout for Claude Code to inject (UserPromptSubmit / SessionStart). */
  stdout?: string;
}> {
  let payload: HookPayload;
  try {
    payload = JSON.parse(stdin) as HookPayload;
  } catch {
    return { posted: 'nothing' };
  }
  const info = readHubInfo();
  if (!info) return { posted: 'nothing' };
  const api = new RemoteApi(`http://127.0.0.1:${info.port}`, info.token);
  const event = payload.hook_event_name ?? '';

  if (event === 'UserPromptSubmit' || event === 'SessionStart') {
    try {
      const qs = (await api.pendingQuestions()) as PendingQ[];
      const out = pendingHookOutput(Array.isArray(qs) ? qs : [], event);
      if (out) return { posted: 'pending-context', stdout: out };
    } catch {
      /* hub gone */
    }
    return { posted: 'nothing' };
  }

  const built = buildFromHook(payload);
  try {
    if (built.report) return { posted: 'report', result: await api.postReport(built.report) };
    if (built.fileEvent) return { posted: 'file-event', result: await api.fileEvent(built.fileEvent) };
  } catch {
    /* hub gone: stay silent */
  }
  return { posted: 'nothing' };
}

export function hooksSnippet(command = 'npx -y mcp-screen hook') {
  return {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command, timeout: 15 }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command, timeout: 15 }] }],
      PostToolUse: [{ matcher: 'Read|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command, timeout: 5 }] }],
      // Inject “N notes waiting on the canvas” when the human left questions the agent hasn't answered.
      UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
      SessionStart: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
    },
  };
}

export const HOOKS_SNIPPET = hooksSnippet();

/** Merge our hooks into an existing settings object without duplicating them. */
export function mergeHooks(settings: Record<string, unknown>, snippet = HOOKS_SNIPPET): Record<string, unknown> {
  const out = { ...settings };
  const hooks = { ...((out.hooks as Record<string, unknown[]>) ?? {}) };
  for (const [event, entries] of Object.entries(snippet.hooks)) {
    const existing = (hooks[event] ?? []) as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
    const ours = (e: { hooks?: Array<{ command?: string }> }) => e.hooks?.some((h) => h.command?.includes('mcp-screen hook'));
    const has = existing.some(ours);
    // Upgrade older installs in place (e.g. PostToolUse gaining Read for the livemap theatre).
    const wanted = (entries[0] as { matcher?: string } | undefined)?.matcher;
    hooks[event] = has ? existing.map((e) => (ours(e) && wanted ? { ...e, matcher: wanted } : e)) : [...existing, ...entries];
  }
  out.hooks = hooks;
  return out;
}
