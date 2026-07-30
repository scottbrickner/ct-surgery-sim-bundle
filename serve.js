// Minimal zero-dependency static file server for local dev/testing.
//
// Why this exists: from Phase 2 onward, the device HTML files import the
// shared engine as real ES modules (`<script type="module">` + `import`).
// Browsers block ES module imports (and fetch()) when a page is opened via
// file:// - each local file is treated as its own opaque origin. Opening a
// device HTML file by double-clicking it, which worked fine through Phase 1,
// no longer loads the shared engine as of Phase 2. Serve the repo root with
// this script instead: `node serve.js` (Node built-ins only, no npm install).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.join(ROOT, path.normalize(urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.stat(filePath, (err, stat) => {
    const target = !err && stat.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    fs.readFile(target, (err2, data) => {
      if (err2) { res.writeHead(404); res.end('Not found: ' + urlPath); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' });
      res.end(data);
    });
  });
}).listen(PORT, () => {
  console.log(`Serving ${ROOT} at http://localhost:${PORT}/`);
  console.log(`Devices: http://localhost:${PORT}/devices/intellivue/IntelliVue_Sim_Monitor.html`);
  console.log(`         http://localhost:${PORT}/devices/hemosphere-alta/HemoSphere_Alta_Sim.html`);
});
