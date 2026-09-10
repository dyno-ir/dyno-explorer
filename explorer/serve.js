// Tiny local static server for the self-contained dist/ build.
// Usage: npm run serve [port]   (default 8000)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".map": "application/json",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const PORT = parseInt(process.argv[2] || process.env.PORT || "8000", 10);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";

    const filePath = normalize(join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    const st = await stat(filePath).catch(() => null);
    if (!st) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    if (st.isDirectory()) {
      res.writeHead(301, { location: pathname + "/" }).end();
      return;
    }

    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" }).end(String(e));
  }
});

server.listen(PORT, () => {
  console.log(`Dyno Explorer running at http://localhost:${PORT}/`);
  console.log(`(serving ${ROOT})`);
  console.log("(Ctrl-C to stop)");
});
