const wasmDir = new URL("./wasm/", self.location.href).href;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function isHardCrash(msg) {
  return /assert|abort|Aborted|RuntimeError|out of bounds|memory access|unreachable|trap|stack overflow/i.test(msg);
}

function formatBacktrace(stack, resolveOffset = null) {
  if (!stack) return "";
  return String(stack)
    .split("\n")
    .map((line) => line.trim())
    .filter((text) => text && /\S+\.wasm(\s|:|$)/.test(text) && /wasm-function\[\d+\]/.test(text))
    .map((text) => {
      const match = text.match(/wasm-function\[\d+\]:0x([0-9a-fA-F]+)/);
      const loc = match && resolveOffset ? resolveOffset(parseInt(match[1], 16)) : null;
      const wtok = (text.match(/wasm-function\[\d+\]:0x[0-9a-fA-F]+/) || [""])[0];
      let fn = text.split("@")[0];
      const v8 = text.match(/^at\s+(\S+)\s+\(/);
      if (v8) fn = v8[1];
      fn = fn.replace(/^dyno-sv-wasm\.wasm\./, "");
      return (fn && fn !== wtok ? fn + "  " : "") + wtok + (loc ? "   [" + loc + "]" : "");
    })
    .join("\n");
}

let wasmPromise = null;
let capture = null;
let queue = Promise.resolve();
let wasmMap = null;
let currentId = null;

function decodeSeg(seg) {
  const out = [];
  let i = 0;
  while (i < seg.length) {
    let value = 0;
    let shift = 0;
    let digit;
    do {
      digit = B64.indexOf(seg[i++]);
      if (digit < 0) return null;
      value |= (digit & 31) << shift;
      shift += digit & 32 ? 5 : 0;
    } while (digit & 32);
    out.push((value & 1 ? -1 : 1) * (value >> 1));
  }
  return out;
}

async function loadSourceMap() {
  try {
    const res = await fetch(wasmDir + "dyno-sv-wasm.wasm.map");
    if (!res.ok) throw new Error("map fetch " + res.status);
    const map = await res.json();
    const index = [];
    let src = 0;
    let line = 0;
    for (const lineText of map.mappings.split(";")) {
      let col = 0;
      for (const seg of lineText.split(",")) {
        if (!seg) continue;
        const delta = decodeSeg(seg);
        if (!delta) continue;
        col += delta[0];
        if (delta.length < 4) continue;
        src += delta[1];
        line += delta[2];
        index.push({ offset: col, src, line });
      }
    }
    index.sort((a, b) => a.offset - b.offset);
    wasmMap = { index, sources: map.sources };
  } catch {
    wasmMap = null;
  }
}

function resolveOffset(offset) {
  if (!wasmMap || !wasmMap.index.length) return null;
  const { index, sources } = wasmMap;
  let lo = 0;
  let hi = index.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index[mid].offset <= offset) {
      found = index[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (!found) return null;
  const base = (sources[found.src] || "").split("/").pop();
  return base ? base + ":" + (found.line + 1) : null;
}

function emitLog(stream, line) {
  if (!capture) return;
  capture[stream].push(line);
  const text = String(line);
  capture.lines.push({ stream, text });
  if (currentId) self.postMessage({ id: currentId, type: "log", stream, text });
}

function takeCapture() {
  const out = capture
    ? {
        stdout: capture.stdout.join("\n"),
        stderr: capture.stderr.join("\n"),
        lines: capture.lines,
      }
    : { stdout: "", stderr: "", lines: [] };
  capture = null;
  return out;
}

async function initWasm() {
  const { default: init } = await import(wasmDir + "dyno-sv-wasm.js");
  const wasm = await init({
    locateFile: (path) => wasmDir + path,
    print: (line) => emitLog("stdout", line),
    printErr: (line) => emitLog("stderr", line),
  });
  await loadSourceMap();
  self.postMessage({
    type: "mapReady",
    loaded: !!wasmMap,
    entries: wasmMap ? wasmMap.index.length : 0,
  });
  return wasm;
}

function getWasm() {
  if (wasmPromise === null) {
    wasmPromise = initWasm().catch((error) => {
      wasmPromise = null;
      throw error;
    });
  }
  return wasmPromise;
}

function stageNames(FS) {
  return FS.readdir("/").filter((name) => /\.(dyno|v|dot)$/.test(name));
}

function readStages(FS) {
  return stageNames(FS)
    .sort()
    .map((name) => ({
      name,
      text: FS.readFile("/" + name, { encoding: "utf8" }),
    }));
}

function cleanStages(FS) {
  for (const name of stageNames(FS)) FS.unlink("/" + name);
}

function writeInputFiles(FS, files) {
  try {
    FS.stat("/input");
  } catch {
    FS.mkdir("/input");
  }
  for (const name of FS.readdir("/input")) if (name !== "." && name !== "..") FS.unlink("/input/" + name);
  for (const file of files || []) {
    const name = String(file.name);
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) throw new Error("invalid input file name: " + name);
    FS.writeFile("/input/" + name, String(file.content));
  }
}

async function runMessage(data) {
  const { id } = data;
  const phase = data.phase || { args: data.args, files: data.files };
  currentId = id;
  try {
    const wasm = await getWasm();
    capture = { stdout: [], stderr: [], lines: [] };
    writeInputFiles(wasm.FS, phase.files || []);
    cleanStages(wasm.FS);
    wasm.ccall("dyno_run", "void", ["string"], [phase.args || ""]);
    const result = JSON.stringify({ stages: readStages(wasm.FS) });
    const cap = takeCapture();
    currentId = null;
    self.postMessage({ id, ok: true, result, stdout: cap.stdout, stderr: cap.stderr, lines: cap.lines });
  } catch (error) {
    const msg = String((error && error.message) || error);
    const crashed = isHardCrash(msg);
    const cap = takeCapture();
    currentId = null;
    const stack = error && error.stack ? String(error.stack) : "";
    self.postMessage({
      id,
      ok: false,
      error: msg,
      crashed,
      stack,
      bt: wasmMap ? formatBacktrace(stack, resolveOffset) : "",
      stdout: cap.stdout,
      stderr: cap.stderr,
      lines: cap.lines,
    });
    wasmPromise = null;
    if (crashed) self.close();
  }
}

self.onmessage = (event) => {
  queue = queue
    .then(() => runMessage(event.data))
    .catch((error) => {
      self.postMessage({
        id: (event.data && event.data.id) || "unknown",
        ok: false,
        error: String((error && error.message) || error),
        crashed: true,
        stdout: "",
        stderr: "",
        lines: [],
      });
      wasmPromise = null;
    });
};
