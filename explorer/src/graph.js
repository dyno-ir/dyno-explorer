// Render a dyno-instr `.dot` graph (each dyno instruction a node, each SSA
// def-use link an edge) as SVG with Graphviz compiled to wasm via @viz-js/viz.
import { instance } from "@viz-js/viz";

// dot layout quality degrades quickly past ~1000 nodes; refuse above this.
const MAX_NODES = 900;

let vizPromise = null;
function getViz() {
  if (!vizPromise) vizPromise = instance();
  return vizPromise;
}

// Count node declarations (`"id" [ ... ]`) for the size cap. Node lines look
// like `"0" [label=...]`; graph/node/edge attribute lines start with a keyword.
function countDotNodes(dot) {
  let count = 0;
  const re = /^\s*"([^\"]+)"\s*\[/gm;
  let m;
  while ((m = re.exec(dot)) && count <= MAX_NODES) count++;
  return count;
}

// Render `dotText` to an SVG string. Returns { ok, svg, dot, nodes, edges } or
// { ok: false, message }.
export async function renderDotGraph(dotText) {
  try {
    const nodeCount = countDotNodes(dotText);
    if (nodeCount > MAX_NODES) {
      return {
        ok: false,
        message: `Graph too large to render: ${nodeCount} nodes (cap is ${MAX_NODES}). ` +
          "Try a smaller module or an earlier pipeline stage.",
      };
    }
    const viz = await getViz();
    const svg = viz.renderString(dotText, { engine: "dot", format: "svg" });
    const edgeCount = (dotText.match(/->/g) || []).length;
    return { ok: true, svg, dot: dotText, module: "dyno instrs", nodes: nodeCount, edges: edgeCount };
  } catch (e) {
    return { ok: false, message: "Graph render failed: " + ((e && e.message) || e) };
  }
}
