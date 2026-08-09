#!/usr/bin/env node
/**
 * docs-site-builder / src/docs-site-builder.js
 * Turns a /docs folder of Markdown files into a static, searchable HTML site.
 * Zero external dependencies — hand-rolled Markdown-to-HTML and a client-side
 * search index built from headings + plain text.
 *
 * Usage:
 *   node src/docs-site-builder.js --source docs --out site
 *   node src/docs-site-builder.js --source docs --out site --serve
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

function parseArgs(argv) {
  const args = { source: 'docs', out: 'site', serve: false, port: 4321 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--serve') args.serve = true;
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--help') args.help = true;
  }
  return args;
}

function findMarkdownFiles(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findMarkdownFiles(full, base));
    } else if (entry.name.endsWith('.md')) {
      out.push({ full, rel: path.relative(base, full) });
    }
  }
  return out;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Minimal Markdown -> HTML (headings, paragraphs, lists, code, bold/italic, links)
function markdownToHtml(md) {
  const lines = md.split('\n');
  let html = '';
  let inCode = false;
  let inList = false;

  const inline = (text) =>
    escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  for (const raw of lines) {
    const line = raw;
    if (line.trim().startsWith('```')) {
      html += inCode ? '</code></pre>\n' : '<pre><code>';
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html += escapeHtml(line) + '\n';
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      if (inList) { html += '</ul>\n'; inList = false; }
      const level = heading[1].length;
      html += `<h${level}>${inline(heading[2])}</h${level}>\n`;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul>\n'; inList = true; }
      html += `<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>\n`;
      continue;
    }
    if (inList && line.trim() === '') { html += '</ul>\n'; inList = false; continue; }
    if (line.trim() === '') { continue; }
    html += `<p>${inline(line)}</p>\n`;
  }
  if (inList) html += '</ul>\n';
  if (inCode) html += '</code></pre>\n';
  return html;
}

function pageTitle(md, fallback) {
  const m = /^#\s+(.*)$/m.exec(md);
  return m ? m[1] : fallback;
}

function layout({ title, body, nav, searchIndexJson }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --fg:#1a1a1a; --bg:#ffffff; --accent:#3457d5; --muted:#666; --border:#e5e5e5; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, Segoe UI, Roboto, sans-serif; color:var(--fg); background:var(--bg); display:flex; min-height:100vh; }
  nav { width:260px; padding:24px; border-right:1px solid var(--border); flex-shrink:0; }
  nav a { display:block; padding:6px 0; color:var(--fg); text-decoration:none; }
  nav a:hover { color:var(--accent); }
  main { flex:1; padding:32px 48px; max-width:800px; }
  h1,h2,h3 { line-height:1.25; }
  pre { background:#f5f5f7; padding:12px 16px; border-radius:6px; overflow-x:auto; }
  code { background:#f5f5f7; padding:2px 5px; border-radius:4px; }
  pre code { background:none; padding:0; }
  #search { width:100%; padding:8px 10px; margin-bottom:16px; border:1px solid var(--border); border-radius:6px; }
  #results { margin-bottom:16px; }
  #results a { display:block; padding:4px 0; }
  .muted { color:var(--muted); font-size:0.9em; }
</style>
</head>
<body>
<nav>
  <input id="search" placeholder="Search docs...">
  <div id="results"></div>
  ${nav}
</nav>
<main>
${body}
</main>
<script>
const INDEX = ${searchIndexJson};
const input = document.getElementById('search');
const results = document.getElementById('results');
input.addEventListener('input', () => {
  const q = input.value.trim().toLowerCase();
  results.innerHTML = '';
  if (!q) return;
  const matches = INDEX.filter(d => d.title.toLowerCase().includes(q) || d.text.toLowerCase().includes(q)).slice(0, 10);
  matches.forEach(m => {
    const a = document.createElement('a');
    a.href = m.href;
    a.textContent = m.title;
    results.appendChild(a);
  });
});
</script>
</body>
</html>`;
}

function build(sourceDir, outDir) {
  const files = findMarkdownFiles(sourceDir);
  if (files.length === 0) {
    console.error(`✗ No .md files found under ${sourceDir}`);
    process.exit(1);
  }

  const pages = files.map(({ full, rel }) => {
    const md = fs.readFileSync(full, 'utf8');
    const htmlBody = markdownToHtml(md);
    const outRel = rel.replace(/\.md$/, '.html');
    const title = pageTitle(md, path.basename(rel, '.md'));
    return { rel, outRel, title, htmlBody, text: md.replace(/[#*`>_-]/g, ' ') };
  });

  const searchIndex = pages.map((pg) => ({ title: pg.title, href: pg.outRel, text: pg.text.slice(0, 2000) }));
  const searchIndexJson = JSON.stringify(searchIndex);

  const nav = pages
    .map((pg) => `<a href="${pg.outRel}">${escapeHtml(pg.title)}</a>`)
    .join('\n  ');

  fs.mkdirSync(outDir, { recursive: true });

  pages.forEach((pg) => {
    const html = layout({ title: pg.title, body: pg.htmlBody, nav, searchIndexJson });
    const outPath = path.join(outDir, pg.outRel);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html);
  });

  // index.html = first page, or a generated landing page
  const indexPath = path.join(outDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    const landing = layout({
      title: 'Documentation',
      body: `<h1>Documentation</h1><p>Select a page from the sidebar, or use search.</p>`,
      nav,
      searchIndexJson,
    });
    fs.writeFileSync(indexPath, landing);
  }

  console.log(`✓ Built ${pages.length} page(s) into ${outDir}/`);
  return pages;
}

function serve(outDir, port) {
  const server = http.createServer((req, res) => {
    let reqPath = decodeURIComponent(req.url.split('?')[0]);
    if (reqPath === '/') reqPath = '/index.html';
    const filePath = path.join(outDir, reqPath);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
        return;
      }
      const ext = path.extname(filePath);
      const type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : 'text/plain';
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    });
  });
  server.listen(port, () => {
    console.log(`✓ Serving ${outDir}/ at http://localhost:${port}`);
    console.log('  Press Ctrl+C to stop.');
  });
}

function printHelp() {
  console.log(`docs-site-builder — turn /docs into a searchable static site

Usage:
  docs-site-builder --source docs --out site            Build the site
  docs-site-builder --source docs --out site --serve     Build, then serve locally
  docs-site-builder --source docs --out site --serve --port 8080`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const sourceDir = path.resolve(process.cwd(), args.source);
  const outDir = path.resolve(process.cwd(), args.out);
  build(sourceDir, outDir);
  if (args.serve) serve(outDir, args.port);
}

main();
