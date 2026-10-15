/**
 * Widget registry: one zod schema per widget kind. Same idea as the opencanvas
 * widget registry (kind -> renderer contract), slimmed to typed JSON payloads
 * so any agent can place widgets without knowing about the renderer.
 */
import { z } from 'zod';
import { buildDiff } from './diff.js';
import { layoutDiagram, parseMermaid, type Diagram } from './diagram.js';
import type { WidgetKind } from './types.js';

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const CHECK_STATUSES = ['todo', 'doing', 'done', 'failed', 'skipped'] as const;
export const FIELD_TYPES = ['text', 'textarea', 'number', 'slider', 'select', 'checkbox'] as const;

const formField = z
  .object({
    id: z.string().regex(/^[\w.-]+$/, 'field ids are letters, digits, _ . -'),
    label: z.string().min(1),
    type: z.enum(FIELD_TYPES),
    help: z.string().optional(),
    placeholder: z.string().optional(),
    required: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    options: z.array(z.union([z.string(), z.object({ value: z.string(), label: z.string() })])).min(1).max(50).optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .refine((f) => f.type !== 'select' || !!f.options, 'select fields need options')
  .refine((f) => f.type !== 'slider' || (f.min !== undefined && f.max !== undefined && f.min < f.max), 'slider fields need min < max');
export type FormField = z.infer<typeof formField>;

export const kindSchemas: Record<WidgetKind, z.ZodType<Record<string, unknown>>> = {
  markdown: z.object({ markdown: z.string() }).passthrough(),
  text: z.object({ text: z.string() }).passthrough(),
  table: z
    .object({ columns: z.array(z.string()).min(1), rows: z.array(z.array(cell)) })
    .passthrough(),
  chart: z
    .object({
      type: z.enum(['bar', 'line']).default('bar'),
      labels: z.array(z.string()),
      values: z.array(z.number()),
      unit: z.string().optional(),
      linkTo: z.string().optional(),
    })
    .passthrough()
    .refine((d) => d.labels.length === d.values.length, 'labels and values must be the same length'),
  metric: z
    .object({ value: z.union([z.number(), z.string()]), label: z.string().optional(), delta: z.number().optional() })
    .passthrough(),
  kv: z.object({ items: z.record(z.string(), cell) }).passthrough(),
  'status-list': z
    .object({
      items: z.array(
        z.object({
          label: z.string(),
          status: z.enum(['ok', 'fail', 'pending', 'unknown']),
          detail: z.string().optional(),
        }),
      ),
    })
    .passthrough(),
  'mcp-app': z
    .object({
      html: z.string(),
      resourceUri: z.string(),
      toolName: z.string(),
      toolInput: z.record(z.string(), z.unknown()).optional(),
      toolResult: z.unknown().optional(),
    })
    .passthrough(),
  question: z
    .object({
      question: z.string().min(1),
      detail: z.string().optional(),
      choices: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1),
            description: z.string().optional(),
            /** Optional markdown preview rendered inside the card. */
            preview: z.string().optional(),
          }),
        )
        .min(2)
        .max(8)
        .refine((c) => new Set(c.map((x) => x.id)).size === c.length, 'choice ids must be unique'),
      state: z.enum(['open', 'answered', 'timeout', 'cancelled']).default('open'),
      answer: z.object({ id: z.string(), label: z.string(), at: z.string() }).optional(),
      expiresAt: z.string().optional(),
    })
    .passthrough(),
  diff: z
    .object({
      before: z.string().optional(),
      after: z.string().optional(),
      patch: z.string().optional(),
      path: z.string().optional(),
      language: z.string().optional(),
      mode: z.enum(['split', 'unified']).default('split'),
      context: z.number().int().min(0).max(50).optional(),
    })
    .passthrough()
    .refine((d) => !!d.patch || (d.before !== undefined && d.after !== undefined), 'diff needs {before, after} or {patch}'),
  diagram: z
    .object({
      mermaid: z.string().optional(),
      direction: z.enum(['TD', 'LR']).optional(),
      nodes: z.array(z.object({ id: z.string().min(1), label: z.string(), shape: z.enum(['rect', 'round', 'diamond', 'circle', 'stadium']).optional() })).optional(),
      edges: z
        .array(z.object({ from: z.string(), to: z.string(), label: z.string().optional(), style: z.enum(['solid', 'dotted', 'thick']).optional(), arrow: z.boolean().optional() }))
        .optional(),
    })
    .passthrough()
    .refine((d) => !!d.mermaid || !!d.nodes?.length, 'diagram needs {mermaid} or {nodes, edges}'),
  image: z
    .object({
      path: z.string().optional(),
      url: z.string().optional(),
      alt: z.string().optional(),
      caption: z.string().optional(),
      fit: z.enum(['contain', 'cover']).default('contain'),
    })
    .passthrough()
    .refine((d) => !!d.path !== !!d.url, 'image needs exactly one of {path} (a local file) or {url} (https)')
    .refine((d) => !d.url || /^https:\/\/[^\s]+$/.test(d.url) || /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(d.url), 'image url must be https:// or a data:image/(png|jpeg|gif|webp) URL'),
  log: z
    .object({ lines: z.array(z.string()).default([]), maxLines: z.number().int().min(10).max(5000).default(500), wrap: z.boolean().optional() })
    .passthrough(),
  checklist: z
    .object({
      items: z.array(z.object({ id: z.string().optional(), label: z.string().min(1), status: z.enum(CHECK_STATUSES).default('todo'), detail: z.string().optional() })),
    })
    .passthrough(),
  form: z
    .object({
      prompt: z.string().min(1),
      detail: z.string().optional(),
      fields: z
        .array(formField)
        .min(1)
        .max(20)
        .refine((f) => new Set(f.map((x) => x.id)).size === f.length, 'field ids must be unique'),
      submitLabel: z.string().optional(),
      state: z.enum(['open', 'submitted', 'timeout', 'cancelled']).default('open'),
      values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      expiresAt: z.string().optional(),
    })
    .passthrough(),
  code: z
    .object({
      code: z.string(),
      language: z.string().optional(),
      filename: z.string().optional(),
      startLine: z.number().int().min(1).optional(),
      highlight: z.array(z.number().int()).optional(),
    })
    .passthrough(),
  map: z
    .object({
      markers: z
        .array(
          z.object({
            lat: z.number().min(-90).max(90),
            lon: z.number().min(-180).max(180),
            label: z.string(),
            value: z.union([z.number(), z.string()]).optional(),
            color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
          }),
        )
        .max(2000)
        .default([]),
      bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    })
    .passthrough(),
  timeline: z
    .object({
      items: z
        .array(
          z.object({
            at: z.string().min(1),
            title: z.string().min(1),
            detail: z.string().optional(),
            status: z.enum(['ok', 'fail', 'pending', 'info']).optional(),
          }),
        )
        .min(1),
    })
    .passthrough(),
  livemap: z
    .object({
      root: z.string().optional(),
      nodes: z
        .array(
          z.object({
            id: z.string(),
            label: z.string(),
            globs: z.array(z.string()).min(1),
            layer: z.number().int().min(0).optional(),
            description: z.string().optional(),
          }),
        )
        .min(1),
      edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() })).default([]),
    })
    .passthrough(),
};

/**
 * Derived, render-ready fields computed on the server (so the browser stays a dumb renderer and the
 * agent gets errors at place time): diff rows, diagram layout, log trimming.
 */
export function enrich(kind: WidgetKind, data: Record<string, unknown>): Record<string, unknown> {
  switch (kind) {
    case 'diff': {
      const files = buildDiff(data as Parameters<typeof buildDiff>[0]);
      return { ...data, files, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) };
    }
    case 'diagram': {
      const d: Diagram = data.mermaid
        ? parseMermaid(String(data.mermaid))
        : { direction: (data.direction as 'TD' | 'LR') ?? 'TD', nodes: data.nodes as Diagram['nodes'], edges: (data.edges as Diagram['edges']) ?? [] };
      const ids = new Set(d.nodes.map((n) => n.id));
      for (const e of d.edges) if (!ids.has(e.from) || !ids.has(e.to)) throw new Error(`invalid data for diagram widget: edge ${e.from} -> ${e.to} uses an unknown node`);
      return { ...data, graph: d, layout: layoutDiagram(d) };
    }
    case 'log': {
      const lines = data.lines as string[];
      const max = data.maxLines as number;
      return lines.length > max ? { ...data, lines: lines.slice(-max), dropped: ((data.dropped as number) ?? 0) + lines.length - max } : data;
    }
    case 'checklist': {
      const items = data.items as Array<{ status: string }>;
      const done = items.filter((i) => i.status === 'done' || i.status === 'skipped').length;
      return { ...data, progress: { done, total: items.length } };
    }
    default:
      return data;
  }
}

export const WIDGET_KINDS = Object.keys(kindSchemas) as WidgetKind[];

export function validateData(kind: WidgetKind, data: unknown): Record<string, unknown> {
  const schema = kindSchemas[kind];
  if (!schema) throw new Error(`unknown widget kind: ${String(kind)}`);
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`invalid data for ${kind} widget: ${msg}`);
  }
  return parsed.data;
}

/** Coerce raw refresh output into the widget's data shape where it's obvious. */
export function coerceRefreshed(kind: WidgetKind, raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === 'string') {
    if (kind === 'markdown') return { markdown: value };
    if (kind === 'text') return { text: value };
    if (kind === 'metric') return { value: value.trim() };
    if (kind === 'log') return validateData(kind, { lines: value.replace(/\n$/, '').split('\n') });
    if (kind === 'code') return validateData(kind, { code: value });
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error(`a ${kind} widget needs JSON output from its source`);
    }
  }
  return validateData(kind, value);
}

export const KIND_DOCS = `Widget kinds and their data:
- markdown {markdown}
- text {text}  (monospace log/output)
- table {columns: string[], rows: cell[][]}  (sortable; row clicks become the widget selection)
- chart {type: "bar"|"line", labels: string[], values: number[], unit?, linkTo?: tableId}  (bar clicks become the selection and filter the linked table)
- metric {value, label?, delta?}
- kv {items: {key: value}}
- status-list {items: [{label, status: "ok"|"fail"|"pending"|"unknown", detail?}]}
- diff {before, after, path?, language?} or {patch: "unified diff / git diff text"}, mode?: "split"|"unified"  (syntax highlighted)
- diagram {mermaid: "flowchart TD\n A[Start] --> B{Ok?}\n B -->|yes| C"} (Mermaid flowchart subset) or {direction?: "TD"|"LR", nodes: [{id, label, shape?}], edges: [{from, to, label?}]}
- image {path: "/abs/file.png"} (local png/jpg/gif/webp/svg, served safely) or {url: "https://..."}; alt?, caption?
- log {lines: string[], maxLines?}  (terminal tail; update_widget {data:{append:["more lines"]}} appends; a live command/url source with parse:"text" tails it)
- checklist {items: [{id?, label, status: "todo"|"doing"|"done"|"failed"|"skipped", detail?}]}  (progress bar; update_widget {data:{set:{"<id or label>": "done"}}} changes single items)
- code {code, language?, filename?, startLine?, highlight?: lineNumbers[]}  (syntax highlighted, copy button)
- map {markers: [{lat, lon, label, value?, color?}], bounds?: [west, south, east, north]}  (offline world map, no tiles)
- timeline {items: [{at: ISO date or label, title, detail?, status?: "ok"|"fail"|"pending"|"info"}]}
- livemap {root?, nodes: [{id, label, globs: string[], layer?, description?}], edges: [{from, to, label?}]}
  (architecture diagram; file edits matching a node's globs light it up live)`;
