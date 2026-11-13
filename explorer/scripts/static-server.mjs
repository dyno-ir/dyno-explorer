import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".dyno": "text/plain; charset=utf-8",
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

export function createStaticServer(root) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/") pathname = "/index.html";
      const filePath = normalize(join(root, pathname));
      if (!filePath.startsWith(root)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const info = await stat(filePath).catch(() => null);
      if (!info) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      if (info.isDirectory()) {
        res.writeHead(301, { location: pathname + "/" }).end();
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[extname(filePath)] || "application/octet-stream",
        "cache-control": "no-cache",
      });
      res.end(await readFile(filePath));
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" }).end(String(error));
    }
  });
}

export async function listen(root, port) {
  const server = createStaticServer(root);
  await new Promise((resolve) => server.listen(port, resolve));
  return server;
}
