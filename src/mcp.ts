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

/** Kinds an agent may place directly. mcp-app comes from `wrap`; question/form come from ask_user/ask_form. */
const PLACEABLE = WIDGET_KINDS.filter((k) => k !== 'mcp-app' && k !== 'question' && k !== 'form');

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
        kind: { type: 'string', enum: PLACEABLE },
        title: { type: 'string' },
        data: { type: 'object', description: 'Payload matching the kind (see description).' },
        id: { type: 'string', description: 'Optional stable id, e.g. "ci-failures".' },
        w: { type: 'number', description: 'Width in grid columns (300px each), 1-4.' },
        h: { type: 'number', description: 'Height in grid rows (150px each), 1-4.' },
        x: { type: 'number', description: 'Optional canvas position in pixels (top-left). Omit to use the first free spot.' },
        y: { type: 'number' },
        source: sourceJson,
        intervalMs: { type: 'number', description: 'Refresh interval for a live source, min 2000, default 30000.' },
      },
      required: ['kind', 'title', 'data'],
    },
  },
  {
    name: 'update_widget',
    description:
      'Update an existing widget. `data` is shallow-merged into the current data by default (send only the keys you change, e.g. {edges} on a livemap); pass merge:false to replace it entirely. ' +
      'Shortcuts: log widgets take data.append (lines to add); checklist widgets take data.set ({"<item id or label>": "done"}). x/y move it on the canvas; changing w/h pushes covered widgets down.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        data: { type: 'object' },
        merge: { type: 'boolean' },
        title: { type: 'string' },
        w: { type: 'number' },
        h: { type: 'number' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'read_widget',
    description:
      'Read a widget back, including `selection`: what the human clicked (table row, chart bar) or what an MCP App reported, and `annotations`: arrows, circles, highlights and sticky notes the human drew on it, ' +
      'with `text` (their note) and `target.dataPoints` (e.g. the chart bar they circled). For livemaps, `unmappedFiles` lists edited files no node covers (time to update the map).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'read_canvas',
    description:
      'List every widget on the canvas with its id, kind, title, live status, selection and position/size in pixels, plus every annotation the human drew ' +
      '(kind arrow|circle|highlight|note, text, replies, and target: the widget and data points it points at). pendingQuestions lists marks with a question you have not answered yet: ' +
      'answer each with reply_annotation. Check this when the human says "look at this" or "see my note".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'remove_widget',
    description: 'Remove a widget (and stop its live refresh).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'clear_canvas',
    description: 'Remove every widget from the canvas (standup cards stay). The human can undo it from the canvas, or you can call clear_canvas with undo:true right after.',
    inputSchema: { type: 'object', properties: { undo: { type: 'boolean', description: 'Restore the widgets removed by the last clear.' } } },
  },
  {
    name: 'ask_user',
    description:
      'Ask the human a visual question: places clickable choice cards on the canvas and BLOCKS until they click one (or the timeout passes). ' +
      'Use it for decisions that are easier to make by looking: layouts, copy options, which bug to fix first. Returns {answered, choice:{id,label}} or {answered:false, reason}.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        detail: { type: 'string', description: 'Optional context shown under the question.' },
        choices: {
          type: 'array',
          minItems: 2,
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              description: { type: 'string' },
              preview: { type: 'string', description: 'Optional markdown shown inside the card (a mini mockup, a code snippet, a bullet list).' },
            },
            required: ['id', 'label'],
          },
        },
        timeoutSeconds: { type: 'number', description: 'How long to wait, default 180, max 900.' },
      },
      required: ['question', 'choices'],
    },
  },
  {
    name: 'ask_form',
    description:
      'Ask the human to fill in a small form on the canvas and BLOCK until they press Submit (or the timeout passes). Field types: text, textarea, number, slider (needs min/max), select (needs options), checkbox. ' +
      'Returns {submitted:true, values:{fieldId: value}} or {submitted:false, reason}. Values are checked against the fields (required, min/max, options) before you get them.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What you need, e.g. "Configure the load test".' },
        detail: { type: 'string' },
        fields: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              type: { type: 'string', enum: ['text', 'textarea', 'number', 'slider', 'select', 'checkbox'] },
              help: { type: 'string' },
              placeholder: { type: 'string' },
              required: { type: 'boolean' },
              min: { type: 'number' },
              max: { type: 'number' },
              step: { type: 'number' },
              options: { type: 'array', items: { type: 'string' } },
              default: { type: ['string', 'number', 'boolean'] },
            },
            required: ['id', 'label', 'type'],
          },
        },
        submitLabel: { type: 'string' },
        timeoutSeconds: { type: 'number', description: 'How long to wait, default 180, max 900.' },
      },
      required: ['prompt', 'fields'],
    },
  },
  {
    name: 'tidy_canvas',
    description: 'Re-pack every widget on the canvas into a neat grid (same as the Tidy up button). Returns the new positions.',
    inputSchema: { type: 'object', properties: { columns: { type: 'number', description: 'Grid width in 300px columns, 1–8 (default 4).' } } },
  },
  {
    name: 'reply_annotation',
    description:
      'Answer a question the human left on the canvas (a circle, arrow, highlight or sticky note with text). Your reply appears in a thread bubble next to their mark. ' +
      'read_canvas lists unanswered ones under pendingQuestions, with the widget and data points they point at; answer about exactly that. A human follow-up in the thread makes it pending again.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The annotation id from read_canvas.' }, text: { type: 'string', description: 'Your answer (plain text, short).' } },
      required: ['id', 'text'],
    },
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
  kind: z.enum(PLACEABLE as [string, ...string[]]),
  title: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
  id: z.string().regex(/^[\w.-]+$/).optional(),
  w: span,
  h: span,
  x: z.number().optional(),
  y: z.number().optional(),
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
  x: z.number().optional(),
  y: z.number().optional(),
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

const AskZ = z.object({
  question: z.string().min(1),
  detail: z.string().optional(),
  choices: z
    .array(z.object({ id: z.string().min(1), label: z.string().min(1), description: z.string().optional(), preview: z.string().optional() }))
    .min(2)
    .max(8),
  timeoutSeconds: z.number().positive().optional(),
});

const FormZ = z.object({
  prompt: z.string().min(1),
  detail: z.string().optional(),
  fields: z.array(z.record(z.string(), z.unknown())).min(1).max(20),
  submitLabel: z.string().optional(),
  timeoutSeconds: z.number().positive().optional(),
});

export interface ToolExtra {
  signal?: AbortSignal;
  /** Called periodically while a blocking tool waits (used for MCP progress notifications). */
  onWaiting?: (elapsedMs: number) => void;
}

const ok = (v: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
const fail = (msg: string): CallToolResult => ({ content: [{ type: 'text', text: msg }], isError: true });

/** Run one screen tool. Returns null if the name isn't a screen tool. */
export async function callScreenTool(api: ScreenApi, name: string, args: unknown, extra: ToolExtra = {}): Promise<CallToolResult | null> {
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
      case 'clear_canvas': {
        const { undo } = z.object({ undo: z.boolean().optional() }).parse(args);
        return ok(undo ? await api.undoClear() : { ...(await api.clear()), note: 'The human can press Undo on the canvas.' });
      }
      case 'ask_user': {
        const a = AskZ.parse(args);
        const started = Date.now();
        const tick = extra.onWaiting ? setInterval(() => extra.onWaiting?.(Date.now() - started), 10_000) : undefined;
        try {
          const input: Parameters<ScreenApi['ask']>[0] = { question: a.question, choices: a.choices };
          if (a.detail) input.detail = a.detail;
          if (a.timeoutSeconds) input.timeoutMs = a.timeoutSeconds * 1000;
          if (extra.signal) input.signal = extra.signal;
          const r = await api.ask(input);
          return ok(r.answered ? { answered: true, choice: r.choice } : { answered: false, reason: r.reason });
        } finally {
          if (tick) clearInterval(tick);
        }
      }
      case 'ask_form': {
        const a = FormZ.parse(args);
        const started = Date.now();
        const tick = extra.onWaiting ? setInterval(() => extra.onWaiting?.(Date.now() - started), 10_000) : undefined;
        try {
          const input: Parameters<ScreenApi['askForm']>[0] = { prompt: a.prompt, fields: a.fields as never };
          if (a.detail) input.detail = a.detail;
          if (a.submitLabel) input.submitLabel = a.submitLabel;
          if (a.timeoutSeconds) input.timeoutMs = a.timeoutSeconds * 1000;
          if (extra.signal) input.signal = extra.signal;
          const r = await api.askForm(input);
          return ok(r.submitted ? { submitted: true, values: r.values } : { submitted: false, reason: r.reason });
        } finally {
          if (tick) clearInterval(tick);
        }
      }
      case 'tidy_canvas':
        return ok({ positions: await api.tidy(z.object({ columns: z.number().int().min(1).max(8).optional() }).parse(args ?? {}).columns) });
      case 'reply_annotation': {
        const a = z.object({ id: z.string().min(1), text: z.string().min(1).max(4000) }).parse(args);
        return ok(await api.replyAnnotation(a.id, a.text));
      }
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

/** Wire abort + MCP progress notifications (keeps clients that reset timeouts on progress happy). */
export function toolExtra(
  progressToken: string | number | undefined,
  extra: { signal: AbortSignal; sendNotification: (n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void> },
): ToolExtra {
  const out: ToolExtra = { signal: extra.signal };
  if (progressToken !== undefined)
    out.onWaiting = (ms) =>
      void extra
        .sendNotification({ method: 'notifications/progress', params: { progressToken, progress: Math.round(ms / 1000), message: 'waiting for the human on mcp-screen' } })
        .catch(() => {});
  return out;
}

export function createScreenServer(api: ScreenApi): Server {
  const server = new Server({ name: 'mcp-screen', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: SCREEN_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const res = await callScreenTool(api, req.params.name, req.params.arguments ?? {}, toolExtra(req.params._meta?.progressToken, extra));
    return res ?? fail(`unknown tool ${req.params.name}`);
  });
  return server;
}
