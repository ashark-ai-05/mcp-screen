import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Tok = [string | null, string];
type HL = {
  line(t: string, lang: string, state?: unknown): { tokens: Tok[]; state: unknown };
  block(code: string, lang: string): Tok[][];
  guess(f: string): string | null;
};
const sandbox: Record<string, unknown> = {};
vm.runInNewContext(fs.readFileSync('public/highlight.js', 'utf8'), { globalThis: sandbox });
const hl = sandbox.McpScreenHighlight as HL;
const classes = (toks: Tok[]) => toks.filter(([c]) => c).map(([c, t]) => `${c}:${t.trim()}`);

describe('syntax highlighter', () => {
  it('tokenizes TypeScript without losing a character', () => {
    const src = "export async function load(id: string) { return fetch(`/api/${id}`) // go";
    const toks = hl.line(src, 'ts').tokens;
    expect(toks.map((t) => t[1]).join('')).toBe(src);
    expect(classes(toks)).toEqual(expect.arrayContaining(['kw:export', 'kw:async', 'kw:function', 'fn:load', 'kw:return', 'fn:fetch', 'str:`/api/${id}`', 'com:// go']));
  });

  it('carries block comments and triple-quoted strings across lines', () => {
    const ts = hl.block('a /* start\nstill comment\nend */ b', 'ts');
    expect(ts[1]).toEqual([['com', 'still comment']]);
    expect(ts[2]![0]).toEqual(['com', 'end */']);
    const py = hl.block('x = """doc\nmore"""\ndef f(): pass', 'python');
    expect(py[1]![0]![0]).toBe('str');
    expect(classes(py[2]!)).toEqual(expect.arrayContaining(['kw:def', 'fn:f', 'kw:pass']));
  });

  it('knows JSON keys, numbers, SQL keywords case-insensitively and HTML tags', () => {
    expect(classes(hl.line('{"a": 1.5, "b": true}', 'json').tokens)).toEqual(['pun:{', 'prop:"a"', 'op::', 'num:1.5', 'pun:,', 'prop:"b"', 'op::', 'lit:true', 'pun:}']);
    expect(classes(hl.line('SELECT id FROM users', 'sql').tokens)).toEqual(['kw:SELECT', 'kw:FROM']);
    expect(classes(hl.line('<a href="x">', 'html').tokens)).toEqual(['pun:<', 'kw:a', 'prop:href', 'op:=', 'str:"x"', 'pun:>']);
  });

  it('falls back to plain text for unknown languages and guesses from file names', () => {
    expect(hl.line('<script>x</script>', 'klingon').tokens).toEqual([[null, '<script>x</script>']]);
    expect(hl.guess('src/app.tsx')).toBe('ts');
    expect(hl.guess('Makefile')).toBeNull();
  });
});
