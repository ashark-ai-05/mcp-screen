// mcp-screen syntax highlighter: a small, dependency-free tokenizer for the code and diff widgets.
// It returns [className|null, text] pairs; the caller builds spans with textContent (never innerHTML).
(function (root) {
  'use strict';
  const words = (s) => new Set(s.split(' '));
  const C_LIKE = words('break case catch class const continue default do else enum export extends finally for function if implements import in instanceof interface let new of package private protected public return static super switch this throw try type typeof var void while with yield async await from as satisfies readonly declare namespace abstract keyof infer is');
  const LANG = {
    js: { kw: C_LIKE, lit: words('true false null undefined NaN Infinity'), com: ['//', '/*'], str: ['"', "'", '`'] },
    go: { kw: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'), lit: words('true false nil iota'), com: ['//', '/*'], str: ['"', '`', "'"] },
    rs: { kw: words('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while'), lit: words('true false None Some Ok Err'), com: ['//', '/*'], str: ['"'] },
    py: { kw: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'), lit: words('True False None self'), com: ['#'], str: ['"""', "'''", '"', "'"] },
    rb: { kw: words('alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require attr_reader attr_accessor'), lit: words('true false nil'), com: ['#'], str: ['"', "'"] },
    sh: { kw: words('if then else elif fi for while until do done case esac in function return local export set unset echo exit source cd'), lit: words('true false'), com: ['#'], str: ['"', "'"] },
    sql: { kw: words('select from where and or not insert into values update set delete create table index view drop alter add join left right inner outer on group by order having limit offset as distinct union all case when then else end is null primary key references foreign default returning with'), lit: words('true false null'), com: ['--', '/*'], str: ["'"], ci: true },
    css: { kw: words('@media @import @keyframes @font-face @supports !important'), lit: words(''), com: ['/*'], str: ['"', "'"] },
    yaml: { kw: words(''), lit: words('true false null yes no on off ~'), com: ['#'], str: ['"', "'"] },
    json: { kw: words(''), lit: words('true false null'), com: [], str: ['"'] },
    md: { kw: words(''), lit: words(''), com: [], str: ['`'] },
  };
  const ALIAS = { ts: 'js', tsx: 'js', jsx: 'js', javascript: 'js', typescript: 'js', mjs: 'js', java: 'js', kt: 'js', kotlin: 'js', swift: 'js', c: 'js', cpp: 'js', 'c++': 'js', cs: 'js', csharp: 'js', php: 'js', dart: 'js', scala: 'js', golang: 'go', rust: 'rs', python: 'py', ruby: 'rb', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', toml: 'yaml', yml: 'yaml', scss: 'css', postgres: 'sql', markdown: 'md' };
  const langOf = (l) => { const k = String(l || '').toLowerCase(); return LANG[k] ? k : ALIAS[k] || null; };

  /**
   * Tokenize one line. `state` carries an open block comment / multi-line string between lines.
   * Returns { tokens: [[cls|null, text]], state }.
   */
  function line(text, lang, state) {
    const name = langOf(lang);
    const out = [];
    const push = (cls, t) => { if (!t) return; const last = out[out.length - 1]; if (last && last[0] === cls) last[1] += t; else out.push([cls, t]); };
    if (/^(html|xml|svg|vue)$/i.test(String(lang || ''))) return { tokens: markup(text), state: null };
    if (!name) { push(null, text); return { tokens: out, state: null }; }
    const L = LANG[name];
    let i = 0;
    let st = state || null;
    const n = text.length;
    while (i < n) {
      if (st) { // inside a block comment or a multi-line string
        const end = text.indexOf(st.close, i);
        if (end < 0) { push(st.cls, text.slice(i)); return { tokens: out, state: st }; }
        push(st.cls, text.slice(i, end + st.close.length)); i = end + st.close.length; st = null; continue;
      }
      const rest = text.slice(i);
      const lc = L.com.find((c) => rest.startsWith(c));
      if (lc === '/*') { st = { close: '*/', cls: 'com' }; push('com', '/*'); i += 2; continue; }
      if (lc) { push('com', rest); break; }
      const q = L.str.find((s) => rest.startsWith(s));
      if (q) {
        if (q.length === 3 || (q === '`' && name !== 'md' && !rest.slice(1).includes('`'))) {
          const end = rest.indexOf(q, q.length);
          if (end < 0) { push('str', rest); return { tokens: out, state: { close: q, cls: 'str' } }; }
          push('str', rest.slice(0, end + q.length)); i += end + q.length; continue;
        }
        let j = q.length;
        while (j < rest.length && rest[j] !== q) j += rest[j] === '\\' ? 2 : 1;
        push('str', rest.slice(0, j + 1)); i += j + 1; continue;
      }
      const num = /^(0x[\da-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?n?)/.exec(rest);
      if (num && !/[\w$]/.test(text[i - 1] || '')) { push('num', num[0]); i += num[0].length; continue; }
      const word = /^[@$A-Za-z_][\w$-]*/.exec(rest);
      if (word) {
        let w = word[0];
        if (name !== 'css' && name !== 'yaml') w = /^[@$A-Za-z_][\w$]*/.exec(rest)[0];
        const key = L.ci ? w.toLowerCase() : w;
        if (name === 'yaml' && /^\s*:/.test(text.slice(i + w.length)) && !out.some((t) => t[1].trim())) push('prop', w);
        else if (L.kw.has(key)) push('kw', w);
        else if (L.lit.has(key)) push('lit', w);
        else if (/^\s*\(/.test(text.slice(i + w.length))) push('fn', w);
        else if (/^[A-Z][a-z]\w*$/.test(w) && name !== 'sql') push('ty', w);
        else push(null, w);
        i += w.length; continue;
      }
      push(/[{}()[\];,.]/.test(text[i]) ? 'pun' : /[=+\-*/%<>!&|^~?:]/.test(text[i]) ? 'op' : null, text[i]); i++;
    }
    if (name === 'json') for (let k = 0; k < out.length; k++) if (out[k][0] === 'str' && out[k + 1] && /^\s*:/.test(out[k + 1][1])) out[k][0] = 'prop';
    return { tokens: out, state: st };
  }

  function markup(text) {
    const out = [];
    const re = /(<!--.*?-->)|(<\/?)([\w:-]+)|([\w:-]+)(=)("[^"]*"|'[^']*')|(\/?>)/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) out.push([null, text.slice(last, m.index)]);
      if (m[1]) out.push(['com', m[1]]);
      else if (m[2]) { out.push(['pun', m[2]]); out.push(['kw', m[3]]); }
      else if (m[4]) { out.push(['prop', m[4]]); out.push(['op', m[5]]); out.push(['str', m[6]]); }
      else out.push(['pun', m[7]]);
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push([null, text.slice(last)]);
    return out;
  }

  /** Tokenize a whole block, line by line, carrying state. */
  function block(code, lang) {
    let state = null;
    return String(code).replace(/\r\n/g, '\n').split('\n').map((t) => { const r = line(t, lang, state); state = r.state; return r.tokens; });
  }

  const EXT = { ts: 'ts', tsx: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', json: 'json', py: 'py', rb: 'rb', go: 'go', rs: 'rs', java: 'java', kt: 'kt', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cs: 'cs', php: 'php', sh: 'sh', bash: 'sh', yml: 'yaml', yaml: 'yaml', toml: 'toml', css: 'css', scss: 'css', html: 'html', xml: 'html', svg: 'html', sql: 'sql', md: 'md', vue: 'html' };
  const guess = (filename) => { const m = /\.(\w+)$/.exec(filename || ''); return m ? EXT[m[1].toLowerCase()] || null : null; };

  root.McpScreenHighlight = { line, block, langOf, guess };
})(typeof window !== 'undefined' ? window : globalThis);
