/**
 * Flow diagrams: a Mermaid *flowchart* subset (no Mermaid bundle, no eval) or explicit nodes/edges,
 * laid out in layers on the server.
 */
import { autoLayers } from './livemap.js';

export type NodeShape = 'rect' | 'round' | 'diamond' | 'circle' | 'stadium';
export interface DiagramNode {
  id: string;
  label: string;
  shape?: NodeShape;
}
export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  style?: 'solid' | 'dotted' | 'thick';
  arrow?: boolean;
}
export interface Diagram {
  direction: 'TD' | 'LR';
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

const NODE_RE = /^([A-Za-z_][\w-]*)\s*(\(\(([^)]*)\)\)|\(\[([^\]]*)\]\)|\[\[([^\]]*)\]\]|\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?/;
const EDGE_RE = /^\s*(?:(-->|---|-\.->|-\.-|==>|===)\s*(?:\|([^|]*)\|)?|--\s+([^-]+?)\s+-->|==\s+([^=]+?)\s+==>|-\.\s+([^.]+?)\s+\.->)\s*/;

const unquote = (s: string): string => s.trim().replace(/^"(.*)"$/, '$1');

/** Parse `flowchart TD` / `graph LR` text. Throws a readable error for anything else. */
export function parseMermaid(src: string): Diagram {
  const lines = src
    .replace(/%%.*$/gm, '')
    .split(/\n|;/)
    .map((l) => l.trim())
    .filter(Boolean);
  const head = /^(flowchart|graph)\s*(TD|TB|LR|RL|BT)?\s*$/i.exec(lines[0] ?? '');
  if (!head) throw new Error('only Mermaid flowcharts are supported: start with "flowchart TD" or "graph LR"');
  const dir = (head[2] ?? 'TD').toUpperCase();
  const d: Diagram = { direction: dir === 'LR' || dir === 'RL' ? 'LR' : 'TD', nodes: [], edges: [] };
  const byId = new Map<string, DiagramNode>();
  const node = (text: string): { id: string; rest: string } => {
    const m = NODE_RE.exec(text);
    if (!m) throw new Error(`can't parse node at "${text.slice(0, 40)}"`);
    const id = m[1] as string;
    let n = byId.get(id);
    if (!n) {
      n = { id, label: id };
      byId.set(id, n);
      d.nodes.push(n);
    }
    const [circle, stadium, sub, rect, round, diamond] = [m[3], m[4], m[5], m[6], m[7], m[8]];
    const label = circle ?? stadium ?? sub ?? rect ?? round ?? diamond;
    if (label !== undefined) {
      n.label = unquote(label);
      n.shape = circle !== undefined ? 'circle' : stadium !== undefined ? 'stadium' : round !== undefined ? 'round' : diamond !== undefined ? 'diamond' : 'rect';
    }
    return { id, rest: text.slice(m[0].length).trim() };
  };
  const group = (text: string): { ids: string[]; rest: string } => {
    const ids: string[] = [];
    let rest = text;
    for (;;) {
      const r = node(rest);
      ids.push(r.id);
      rest = r.rest;
      if (!rest.startsWith('&')) break;
      rest = rest.slice(1).trim();
    }
    return { ids, rest };
  };
  for (const line of lines.slice(1)) {
    if (/^(subgraph|end$|classDef|class |style |linkStyle|click |direction )/.test(line)) continue;
    let { ids: from, rest } = group(line);
    while (rest) {
      const e = EDGE_RE.exec(rest);
      if (!e) throw new Error(`can't parse "${rest.slice(0, 40)}"`);
      const op = e[1] ?? (e[3] !== undefined ? '-->' : e[4] !== undefined ? '==>' : '-.->');
      const label = e[2] ?? e[3] ?? e[4] ?? e[5];
      const g = group(rest.slice(e[0].length));
      for (const f of from)
        for (const t of g.ids) {
          const edge: DiagramEdge = { from: f, to: t, arrow: op.endsWith('>'), style: op.startsWith('=') ? 'thick' : op.includes('.') ? 'dotted' : 'solid' };
          if (label?.trim()) edge.label = unquote(label);
          d.edges.push(edge);
        }
      from = g.ids;
      rest = g.rest;
    }
  }
  if (!d.nodes.length) throw new Error('the flowchart has no nodes');
  return d;
}

export interface DiagramLayout {
  pos: Record<string, { x: number; y: number; w: number; h: number }>;
  width: number;
  height: number;
}

/** Layered layout with one barycentre pass to reduce crossings. Coordinates are node centres. */
export function layoutDiagram(d: Diagram): DiagramLayout {
  const layers = autoLayers(d.nodes, d.edges.filter((e) => e.from !== e.to));
  const byLayer: string[][] = [];
  for (const n of d.nodes) {
    const l = layers.get(n.id) ?? 0;
    (byLayer[l] ??= []).push(n.id);
  }
  const rows = byLayer.filter(Boolean);
  const index = new Map<string, number>();
  rows.forEach((r) => r.forEach((id, i) => index.set(id, i)));
  for (let li = 1; li < rows.length; li++) {
    const row = rows[li] as string[];
    const bary = (id: string): number => {
      const parents = d.edges.filter((e) => e.to === id).map((e) => index.get(e.from) ?? 0);
      return parents.length ? parents.reduce((s, x) => s + x, 0) / parents.length : (index.get(id) ?? 0);
    };
    row.sort((a, b) => bary(a) - bary(b));
    row.forEach((id, i) => index.set(id, i));
  }
  const size = (n: DiagramNode): { w: number; h: number } => {
    const w = Math.max(90, Math.min(220, n.label.length * 7.4 + 34));
    return n.shape === 'diamond' ? { w: w + 30, h: 64 } : n.shape === 'circle' ? { w: Math.max(70, w * 0.7), h: Math.max(70, w * 0.7) } : { w, h: 44 };
  };
  const nodes = new Map(d.nodes.map((n) => [n.id, n]));
  const pos: DiagramLayout['pos'] = {};
  const lr = d.direction === 'LR';
  const along = lr ? 230 : 110; // distance between layers
  const across = lr ? 90 : 210; // distance between siblings
  const widest = Math.max(...rows.map((r) => r.length));
  rows.forEach((row, li) => {
    row.forEach((id, i) => {
      const s = size(nodes.get(id) as DiagramNode);
      const c = (i + 0.5 + (widest - row.length) / 2) * across;
      const l = li * along + (lr ? 110 : 40);
      pos[id] = lr ? { x: l, y: c, ...s } : { x: c, y: l, ...s };
    });
  });
  const width = lr ? rows.length * along : widest * across;
  const height = lr ? widest * across : rows.length * along - 20;
  return { pos, width: Math.max(width, 200), height: Math.max(height, 90) };
}
