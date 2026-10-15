// mcp-screen share/export: a self-contained HTML snapshot and a 2x PNG of the current view.
// Pure helpers live on McpScreenExport so they can be unit-tested outside the browser.
(function (root) {
  'use strict';

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /** Build a standalone HTML document: inlined CSS (+ font as a data URL), no scripts, no network. */
  function buildStaticHtml({ css, fontDataUrl, title, bodyHtml, when }) {
    let style = String(css);
    if (fontDataUrl) style = style.replace(/url\(['"]?\/fonts\/inter-var-latin\.woff2['"]?\)/g, `url('${fontDataUrl}')`);
    else style = style.replace(/@font-face\s*{[^}]*}/g, '');
    // Belt and braces: a snapshot must never run code.
    const safeBody = String(bodyHtml)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<iframe[\s\S]*?(<\/iframe>|\/>)/gi, '')
      .replace(/\son\w+="[^"]*"/gi, '');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<title>${escapeHtml(title)}</title>
<style>${style}
.card, .rep, .col, .node, .choice, table.t tbody tr, svg.chart .bar, .view.active { animation: none !important; }
.snapshot-note { color: var(--muted); font-size: 12px; margin: 0 22px 18px; }
</style></head>
<body class="exported">${safeBody}
<p class="snapshot-note">Snapshot from mcp-screen · ${escapeHtml(when)}</p>
</body></html>`;
  }

  function slug(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `mcp-screen-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  // ---------- browser-only below ----------
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function fontAsDataUrl() {
    try {
      const buf = await (await fetch('/fonts/inter-var-latin.woff2')).blob();
      return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(buf); });
    } catch { return null; }
  }

  /** Clone the header + active view, freezing live state into static markup. */
  function snapshotDom() {
    const header = document.querySelector('header.top').cloneNode(true);
    const view = document.querySelector('.view.active');
    const clone = view.cloneNode(true);
    // MCP Apps run in a null-origin sandbox we can't read; leave an honest placeholder.
    const liveFrames = view.querySelectorAll('iframe');
    clone.querySelectorAll('iframe').forEach((f, i) => {
      const ph = document.createElement('div');
      ph.className = 'app-placeholder';
      ph.textContent = `Interactive MCP App “${liveFrames[i]?.title || 'app'}” (not included in snapshots)`;
      f.replaceWith(ph);
    });
    clone.querySelectorAll('.caption, .flyer, .ripple').forEach((n) => n.remove());
    const main = document.createElement('main');
    main.append(clone);
    return { header, main, width: Math.ceil(document.documentElement.clientWidth), height: Math.ceil(Math.max(document.documentElement.scrollHeight, window.innerHeight)) };
  }

  async function exportHtml() {
    const css = await (await fetch('/app.css')).text();
    const { header, main } = snapshotDom();
    const html = buildStaticHtml({ css, fontDataUrl: await fontAsDataUrl(), title: `mcp-screen · ${new Date().toLocaleString()}`, bodyHtml: header.outerHTML + main.outerHTML, when: new Date().toLocaleString() });
    const blob = new Blob([html], { type: 'text/html' });
    download(blob, `${slug()}.html`);
    return blob;
  }

  /** Render the static snapshot through SVG <foreignObject> into a 2x canvas. */
  async function exportPng(scale = 2) {
    const css = await (await fetch('/app.css')).text();
    const font = await fontAsDataUrl();
    const { header, main, width, height } = snapshotDom();
    const style = css.replace(/url\(['"]?\/fonts\/inter-var-latin\.woff2['"]?\)/g, `url('${font}')`)
      // backdrop blur doesn't survive foreignObject; give glass a solid-ish base instead
      + `\n.card,.rep,.panel,.map-wrap,.node{backdrop-filter:none!important;background-color:rgba(20,24,36,.92)}
         .card,.rep,.col,.node,.choice,table.t tbody tr,svg.chart .bar,.view.active{animation:none!important}
         .actions{display:none!important}`;
    const wrap = document.createElement('div');
    wrap.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    wrap.style.cssText = `width:${width}px;min-height:${height}px;background:#07080d;color:#eef1f8;font-family:'Inter var',sans-serif`;
    wrap.className = 'exported';
    const st = document.createElement('style');
    st.textContent = style;
    wrap.append(st, header, main);
    const xhtml = new XMLSerializer().serializeToString(wrap);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
    const img = new Image();
    img.decoding = 'sync';
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('could not rasterise the snapshot')); img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#07080d';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    download(blob, `${slug()}.png`);
    return blob;
  }

  root.McpScreenExport = { buildStaticHtml, slug, escapeHtml, exportHtml, exportPng };
})(typeof window !== 'undefined' ? window : globalThis);
