/**
 * Widget registry: one zod schema per widget kind. Same idea as the opencanvas
 * widget registry (kind -> renderer contract), slimmed to typed JSON payloads
 * so any agent can place widgets without knowing about the renderer.
 */
import { z } from 'zod';
import type { WidgetKind } from './types.js';

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

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
- livemap {root?, nodes: [{id, label, globs: string[], layer?, description?}], edges: [{from, to, label?}]}
  (architecture diagram; file edits matching a node's globs light it up live)`;
