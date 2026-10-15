import path from 'node:path';
import picomatch from 'picomatch';

export interface LivemapNode {
  id: string;
  label: string;
  globs: string[];
}

/** Make an absolute or relative path relative to the map root, with forward slashes. */
export function toRepoPath(file: string, root: string | undefined, cwd: string | undefined): string {
  const base = root ?? cwd;
  let p = file;
  if (base && path.isAbsolute(file)) p = path.relative(base, file);
  return p.split(path.sep).join('/').replace(/^\.\//, '');
}

/** Return the ids of every node whose globs match the file. */
export function matchNodes(nodes: LivemapNode[], repoPath: string): string[] {
  if (repoPath.startsWith('../')) return [];
  return nodes
    .filter((n) => n.globs.some((g) => picomatch(g, { dot: true })(repoPath)))
    .map((n) => n.id);
}

const PALETTE = ['#7c9cff', '#ff7ab6', '#4fd1a5', '#ffb547', '#b48cff', '#5cc8ff', '#ff6b6b', '#c3e86b'];

/** Stable colour per agent name so the same agent always glows the same colour. */
export function agentColor(agent: string): string {
  let h = 0;
  for (const ch of agent) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length] ?? '#7c9cff';
}

/** Assign layers by longest path from sources when the agent didn't give any. */
export function autoLayers(
  nodes: Array<{ id: string; layer?: number }>,
  edges: Array<{ from: string; to: string }>,
): Map<string, number> {
  const layer = new Map<string, number>();
  for (const n of nodes) layer.set(n.id, n.layer ?? 0);
  const fixed = new Set(nodes.filter((n) => n.layer !== undefined).map((n) => n.id));
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    for (const e of edges) {
      const a = layer.get(e.from);
      const b = layer.get(e.to);
      if (a === undefined || b === undefined || fixed.has(e.to)) continue;
      if (b < a + 1) {
        layer.set(e.to, a + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return layer;
}
