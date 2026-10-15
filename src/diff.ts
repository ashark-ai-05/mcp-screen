/**
 * Line diffs for the `diff` widget. Computed on the server so the browser only renders rows.
 * Myers O(ND) diff, unified-patch parsing, and collapsing of long unchanged runs.
 */
export type DiffRowType = 'ctx' | 'add' | 'del' | 'hunk';
export interface DiffRow {
  t: DiffRowType;
  /** Old / new line numbers (1-based). */
  a?: number;
  b?: number;
  text: string;
}
export interface DiffFile {
  path: string;
  language?: string;
  rows: DiffRow[];
  added: number;
  removed: number;
}

const MAX_LINES = 5000;
const splitLines = (s: string): string[] => {
  if (s === '') return [];
  const l = s.replace(/\r\n/g, '\n').split('\n');
  if (l.length > 1 && l[l.length - 1] === '') l.pop();
  return l;
};

/** Myers diff on line arrays → edit script of ctx/add/del rows with line numbers. */
export function diffLines(before: string, after: string): DiffRow[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_LINES || b.length > MAX_LINES) throw new Error(`diff too large (max ${MAX_LINES} lines per side)`);
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v[off + k - 1] as number) < (v[off + k + 1] as number)) ? (v[off + k + 1] as number) : (v[off + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Backtrack.
  const rows: DiffRow[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d] as Int32Array;
    const k = x - y;
    const prevK = k === -d || (k !== d && (vv[off + k - 1] as number) < (vv[off + k + 1] as number)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : (vv[off + prevK] as number);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      rows.push({ t: 'ctx', a: x, b: y, text: a[x - 1] as string });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) rows.push({ t: 'add', b: y, text: b[y - 1] as string });
      else rows.push({ t: 'del', a: x, text: a[x - 1] as string });
    }
    x = prevX;
    y = prevY;
  }
  return rows.reverse();
}

/** Replace unchanged runs longer than 2*context with a hunk marker, like `git diff`. */
export function collapse(rows: DiffRow[], context = 3): DiffRow[] {
  const out: DiffRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if ((rows[i] as DiffRow).t !== 'ctx') {
      out.push(rows[i] as DiffRow);
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && (rows[j] as DiffRow).t === 'ctx') j++;
    const run = rows.slice(i, j);
    const lead = i === 0 ? 0 : context;
    const trail = j === rows.length ? 0 : context;
    if (run.length > lead + trail + 1) {
      out.push(...run.slice(0, lead));
      const next = run[run.length - trail] ?? (rows[j] as DiffRow | undefined);
      out.push({ t: 'hunk', text: `@@ ${run.length - lead - trail} unchanged lines${next?.a ? ` · next at line ${next.b ?? next.a}` : ''} @@` });
      out.push(...run.slice(run.length - trail));
    } else out.push(...run);
    i = j;
  }
  return out;
}

/** Parse `git diff` / unified-diff text into files. */
export function parseUnified(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let a = 0;
  let b = 0;
  const start = (path: string): DiffFile => {
    const f: DiffFile = { path, rows: [], added: 0, removed: 0 };
    const lang = languageFor(path);
    if (lang) f.language = lang;
    files.push(f);
    return f;
  };
  for (const line of splitLines(patch)) {
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (git) {
      cur = start(git[2] as string);
      continue;
    }
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '').trim();
      if (!cur || (cur.rows.length && p !== cur.path)) cur = start(p);
      else if (cur.path !== p && p !== '/dev/null') cur.path = p;
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      cur ??= start('patch');
      a = Number(h[1]);
      b = Number(h[2]);
      cur.rows.push({ t: 'hunk', text: line });
      continue;
    }
    if (!cur || /^(index |new file|deleted file|similarity|rename |old mode|new mode|\\ No newline)/.test(line)) continue;
    if (line.startsWith('+')) {
      cur.rows.push({ t: 'add', b: b++, text: line.slice(1) });
      cur.added++;
    } else if (line.startsWith('-')) {
      cur.rows.push({ t: 'del', a: a++, text: line.slice(1) });
      cur.removed++;
    } else cur.rows.push({ t: 'ctx', a: a++, b: b++, text: line.startsWith(' ') ? line.slice(1) : line });
  }
  if (!files.length) throw new Error('no hunks found in patch');
  return files;
}

const EXT: Record<string, string> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', json: 'json', py: 'py', rb: 'rb', go: 'go', rs: 'rs',
  java: 'java', kt: 'kt', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'cs', php: 'php', sh: 'sh', bash: 'sh', zsh: 'sh',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', md: 'md', css: 'css', scss: 'css', html: 'html', xml: 'html', svg: 'html', sql: 'sql', vue: 'html',
};
export function languageFor(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const m = /\.([\w]+)$/.exec(path);
  return m ? EXT[(m[1] as string).toLowerCase()] : undefined;
}

/** Normalise diff widget input into files[] with rows. */
export function buildDiff(data: { before?: string; after?: string; patch?: string; path?: string; language?: string; context?: number }): DiffFile[] {
  if (data.patch) return parseUnified(data.patch);
  if (data.before === undefined || data.after === undefined) throw new Error('diff needs {before, after} or {patch}');
  const rows = collapse(diffLines(data.before, data.after), data.context ?? 3);
  const f: DiffFile = {
    path: data.path ?? 'file',
    rows,
    added: rows.filter((r) => r.t === 'add').length,
    removed: rows.filter((r) => r.t === 'del').length,
  };
  const lang = data.language ?? languageFor(data.path);
  if (lang) f.language = lang;
  return [f];
}
