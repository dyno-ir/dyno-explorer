// Build the self-contained static site in dist/ (bundled UI + Monaco + wasm),
// servable by any static file server. Usage: node scripts/build.mjs
import { build } from "esbuild";
import { copyFile, mkdir, access, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(root, "dist");
const src = join(root, "src");
const wasmSrc = join(root, "..", "wasm-sv");

const common = {
  bundle: true,
  outdir: dist,
  sourcemap: true,
  loader: { ".ttf": "file", ".woff": "file" },
  logLevel: "info",
};

// Clean dist so stale artifacts (e.g. an old dyno-sv-wasm.*) don't linger.
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await Promise.all([
  // Main app (ESM): dist/app.js + dist/app.css (Monaco + styles).
  build({ ...common, entryPoints: { app: join(src, "app.js") }, format: "esm" }),
  // Dyno worker (IIFE).
  build({ ...common, entryPoints: { worker: join(src, "worker.js") }, format: "iife" }),
  // Monaco editor worker (IIFE).
  build({
    ...common,
    entryPoints: { "editor.worker": join(src, "monaco-worker-entry.js") },
    format: "iife",
  }),
]);

await copyFile(join(root, "index.html"), join(dist, "index.html"));

// Copy the wasm module (self-contained) into dist/wasm/.
await mkdir(join(dist, "wasm"), { recursive: true });
const wasmFiles = [
  "dyno-sv-wasm.js",
  "dyno-sv-wasm.wasm",
  "dyno-sv-wasm.data",
  "dyno-sv-wasm.wasm.map", // decoded by the worker for crash backtrace lines
];
for (const f of wasmFiles) {
  const srcPath = join(wasmSrc, f);
  try {
    await access(srcPath);
    await copyFile(srcPath, join(dist, "wasm", f));
  } catch {
    console.warn(`warning: ${srcPath} not found — run \`make wasm\` first`);
  }
}

console.log(`Built static site in ${dist}`);
console.log("Serve it with:  python3 -m http.server -d dist 8000   (or: npm run serve)");
