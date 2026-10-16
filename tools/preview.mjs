// Serves the test copy on http://localhost:8787 and rebuilds it whenever a source file changes.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { buildStaging } from './build-staging.mjs';
import { TARGETS, BUILD_DIR, at, say, main, fail, Stop } from './lib.mjs';

const PORT = Number(process.env.PORT) || 8787;
const WEB = path.join(BUILD_DIR, 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const SOURCES = [...TARGETS.web.map((w) => w.source), ...TARGETS.workflows.map((w) => w.source), 'tools/config.local.json'];

let builtFor = '';
let buildError = null;
/* the build tools themselves count as sources too, and each rebuild runs as a fresh process,
   so a change to the build (not only to the pages) shows up without restarting the preview */
const TOOL_SOURCES = ['tools/build-staging.mjs', 'tools/lib.mjs', 'tools/targets.json', 'staging/db/branding.json', 'staging/db/bot-config-shakti.json', 'staging/db/stg-sim.sql', 'staging/db/schema-files.txt'];
function rebuildIfChanged() {
  const stamp = [...SOURCES, ...TOOL_SOURCES].map((f) => { try { return statSync(at(f)).mtimeMs; } catch { return 0; } }).join('|');
  if (stamp === builtFor) return;
  const first = builtFor === '';
  builtFor = stamp;
  if (first) {
    try {
      buildStaging();
      buildError = null;
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
      buildError = err.message;
      console.error(`\n  STOPPED: ${err.message}\n`);
    }
    return;
  }
  const r = spawnSync(process.execPath, [at('tools', 'build-staging.mjs')], { encoding: 'utf8' });
  if (r.status === 0) {
    buildError = null;
    say(`rebuilt test copy at ${new Date().toLocaleTimeString()}`);
  } else {
    buildError = (r.stderr || r.stdout || 'the build failed').trim();
    console.error(`\n  STOPPED: ${buildError}\n`);
  }
}

/* the port must be free BEFORE the first build: a second preview would otherwise rebuild, then crash */
const portFree = () => new Promise((resolve, reject) => {
  const probe = http.createServer();
  probe.once('error', (e) => (e.code === 'EADDRINUSE' ? resolve(false) : reject(e)));
  probe.listen(PORT, '127.0.0.1', () => probe.close(() => resolve(true)));
});
const portInUse = () => `Port ${PORT} is in use: a preview is probably already running. Open http://localhost:${PORT}/admin/, or stop the other one, or start this one on another port (PowerShell: $env:PORT=8788; npm run staging:preview).`;

main(async () => {
  if (!(await portFree())) fail(portInUse());
  rebuildIfChanged();
  if (buildError) process.exit(1);
  http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (urlPath === '/') { res.writeHead(302, { Location: '/admin/' }); return res.end(); }
    if (urlPath.endsWith('/') || urlPath.endsWith('.html')) rebuildIfChanged();
    if (buildError) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`The test copy could not be built:\n\n${buildError}`);
    }
    const file = path.join(WEB, path.normalize(urlPath).replace(/^[/\\]+/, ''));
    if (!file.startsWith(WEB)) { res.writeHead(403); return res.end(); }
    try {
      let target = file;
      if ((await stat(target)).isDirectory()) {
        if (!urlPath.endsWith('/')) { res.writeHead(301, { Location: `${urlPath}/` }); return res.end(); }
        target = path.join(target, 'index.html');
      }
      const body = await readFile(target);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  }).on('error', (e) => {
    if (e.code === 'EADDRINUSE') { console.error(`\n  STOPPED: ${portInUse()}\n`); process.exit(1); }
    throw e;
  }).listen(PORT, '127.0.0.1', () => {
    say('Test copy running (connected to the STAGING database, not live):');
    for (const w of TARGETS.web.filter((x) => x.staging !== false)) say(`  ${w.name.padEnd(12)} http://localhost:${PORT}${w.url}`);
    say('Edit the source files and refresh the page. Press Ctrl+C to stop.');
  });
});
