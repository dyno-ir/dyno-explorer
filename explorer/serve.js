import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listen } from "./scripts/static-server.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "dist");
const port = parseInt(process.argv[2] || process.env.PORT || "8000", 10);
const server = await listen(root, port);

console.log(`Dyno Explorer running at http://localhost:${port}/`);
console.log(`(serving ${root})`);
console.log("(Ctrl-C to stop)");
