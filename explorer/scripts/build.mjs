import { build } from "esbuild";
import { access, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
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

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await Promise.all([
  build({
    ...common,
    entryPoints: { app: join(src, "app.js") },
    format: "esm",
  }),
  build({
    ...common,
    entryPoints: { worker: join(src, "worker.js") },
    format: "iife",
  }),
  build({
    ...common,
    entryPoints: { "editor.worker": join(src, "monaco-worker-entry.js") },
    format: "iife",
  }),
]);

await copyFile(join(root, "index.html"), join(dist, "index.html"));

const assets = [
  [
    join(root, "..", "dyno", "tools", "dyno-opt", "dyno-ir", "flow.dyno"),
    join(dist, "flow.dyno"),
  ],
  [
    join(
      root,
      "..",
      "dyno",
      "tools",
      "dyno-sv",
      "dyno-ir",
      "memory-model-flow.dyno",
    ),
    join(dist, "memory-model-flow.dyno"),
  ],
  [
    join(root, "..", "dyno", "tools", "dyno-test", "dyno-ir", "test.dyno"),
    join(dist, "test.dyno"),
  ],
  [join(root, "assets", "memory.sv"), join(dist, "memory.sv")],
  [
    join(
      root,
      "..",
      "third-party",
      "sky130",
      "sky130_fd_sc_hd__tt_025C_1v80.lib",
    ),
    join(dist, "sky130_fd_sc_hd__tt_025C_1v80.lib"),
  ],
];
for (const [from, to] of assets) await copyFile(from, to);

await mkdir(join(dist, "wasm"), { recursive: true });
for (const name of [
  "dyno-sv-wasm.js",
  "dyno-sv-wasm.wasm",
  "dyno-sv-wasm.data",
  "dyno-sv-wasm.wasm.map",
]) {
  const from = join(wasmSrc, name);
  try {
    await access(from);
    await copyFile(from, join(dist, "wasm", name));
  } catch {
    console.warn(`warning: ${from} not found — run \`make wasm\` first`);
  }
}

console.log(`Built static site in ${dist}`);
console.log(
  "Serve it with:  python3 -m http.server -d dist 8000   (or: npm run serve)",
);
