import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ScreenApi } from './api.js';
import { KIND_DOCS, WIDGET_KINDS } from './registry.js';
import { VERSION } from './hub.js';

const sourceJson = {
  type: 'object',
  description:
    'Optional live source, re-run server-side every intervalMs with no LLM. ' +
    '{type:"command", argv:[...], cwd?, parse?:"json"|"text"} (no shell) | {type:"url", url, parse?} | ' +
    '{type:"mcp", tool, arguments?} (wrap mode only). NOTHING runs until the human clicks Approve on the canvas; ' +
    'approved sources go on a persistent allow-list. Output must match the widget data shape (or be text for markdown/text/metric).',
  properties: {
    type: { type: 'string', enum: ['command', 'url', 'mcp'] },
    argv: { type: 'array', items: { type: 'string' } },
    cwd: { type: 'string' },
    url: { type: 'string' },
    tool: { type: 'string' },
    arguments: { type: 'object' },
    parse: { type: 'string', enum: ['json', 'text'] },
  },
  required: ['type'],
} as const;

export const SCREEN_TOOLS: Tool[] = [
  {
    name: 'place_widget',
    description: `Show something to the human on their mcp-screen canvas (a browser tab next to the terminal). Returns the widget id.\n${KIND_DOCS}`,
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: WIDGET_KINDS.filter((k) => k !== 'mcp-app') },
        title: { type: 'string' },
        data: { type: 'object', description: 'Payload matching the kind (see description).' },
        id: { type: 'string', description: 'Optional stable id, e.g. "ci-failures".' },
        w: { type: 'number', description: 'Width in grid columns, 1-4.' },
        h: { type: 'number', description: 'Height in grid rows, 1-4.' },
        source: sourceJson,
        intervalMs: { type: 'number', description: 'Refresh interval for a live source, min 2000, default 30000.' },
      },
      required: ['kind', 'title', 'data'],
    },
  },
  {
    name: 'update_widget',
    description: 'Replace (or with merge:true, shallow-merge) the data / title / size of an existing widget.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        data: { type: 'object' },
        merge: { type: 'boolean' },
        title: { type: 'string' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'read_widget',
    description:
      'Read a widget back, including `selection`: what the human clicked (table row, chart bar) or what an MCP App reported. For livemaps, `unmappedFiles` lists edited files no node covers (time to update the map).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'read_canvas',
    description: 'List every widget on the canvas with its id, kind, title, live status and current selection.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'remove_widget',
    description: 'Remove a widget (and stop its live refresh).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'post_report',
    description:
      'Post a standup card when you finish a task: what you changed, test results, a short summary and risks. Cards are grouped by worktree and agent on the Standup board.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Your name/role, e.g. "claude-main" or "test-writer".' },
        worktree: { type: 'string', description: 'Worktree or repo name.' },
        branch: { type: 'string' },
        summary: { type: 'string' },
        filesChanged: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, added: { type: 'number' }, removed: { type: 'number' } },
            required: ['path'],
          },
        },
        tests: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pass', 'fail', 'unknown'] },
            passed: { type: 'number' },
            failed: { type: 'number' },
            command: { type: 'string' },
          },
          required: ['status'],
        },
        risks: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary'],
    },
  },
];

const SourceZ = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), argv: z.array(z.string()).min(1), cwd: z.string().optional(), parse: z.enum(['json', 'text']).optional() }),
  z.object({ type: z.literal('url'), url: z.string().url(), parse: z.enum(['json', 'text']).optional() }),
  z.object({ type: z.literal('mcp'), tool: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }),
]);
const span = z.number().min(1).max(4).optional();
const PlaceZ = z.object({
  kind: z.enum(WIDGET_KINDS.filter((k) => k !== 'mcp-app') as [string, ...string[]]),
  title: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
  id: z.string().regex(/^[\w.-]+$/).optional(),
  w: span,
  h: span,
  source: SourceZ.optional(),
  intervalMs: z.number().optional(),
});
const UpdateZ = z.object({
  id: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
  merge: z.boolean().optional(),
  title: z.string().optional(),
  w: span,
  h: span,
});
const IdZ = z.object({ id: z.string() });
const ReportZ = z.object({
  agent: z.string().default('agent'),
  worktree: z.string().default(process.cwd().split(/[\\/]/).pop() ?? 'default'),
  branch: z.string().optional(),
  summary: z.string(),
  filesChanged: z.array(z.object({ path: z.string(), added: z.number().optional(), removed: z.number().optional() })).optional(),
  tests: z
    .object({ status: z.enum(['pass', 'fail', 'unknown']), passed: z.number().optional(), failed: z.number().optional(), command: z.string().optional() })
    .optional(),
  risks: z.array(z.string()).optional(),
});

const ok = (v: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
const fail = (msg: string): CallToolResult => ({ content: [{ type: 'text', text: msg }], isError: true });

/** Run one screen tool. Returns null if the name isn't a screen tool. */
export async function callScreenTool(api: ScreenApi, name: string, args: unknown): Promise<CallToolResult | null> {
  try {
    switch (name) {
      case 'place_widget': {
        const input = PlaceZ.parse(args);
        const w = await api.place(input as never);
        const note =
          w.status === 'needs-approval'
            ? ' Its source is waiting for the human to click Approve on the canvas; until then it shows the initial data.'
            : '';
        return ok({ id: w.id, status: w.status, url: api.url, note: `Placed on ${api.url}.${note}` });
      }
      case 'update_widget': {
        const { id, ...patch } = UpdateZ.parse(args);
        const w = await api.update(id, patch);
        return ok({ id: w.id, status: w.status, updatedAt: w.updatedAt });
      }
      case 'read_widget': {
        const w = (await api.read(IdZ.parse(args).id)) as Record<string, unknown>;
        if (w.kind === 'mcp-app') w.data = { ...(w.data as object), html: '(omitted)' };
        return ok(w);
      }
      case 'read_canvas':
        return ok(await api.readCanvas());
      case 'remove_widget':
        return ok({ removed: await api.remove(IdZ.parse(args).id) });
      case 'post_report': {
        const r = await api.postReport(ReportZ.parse(args) as never);
        return ok({ id: r.id, posted: true });
      }
      default:
        return null;
    }
  } catch (err) {
    if (err instanceof z.ZodError) return fail(`invalid arguments: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return fail((err as Error).message);
  }
}

export function createScreenServer(api: ScreenApi): Server {
  const server = new Server({ name: 'mcp-screen', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: SCREEN_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const res = await callScreenTool(api, req.params.name, req.params.arguments ?? {});
    return res ?? fail(`unknown tool ${req.params.name}`);
  });
  return server;
}
