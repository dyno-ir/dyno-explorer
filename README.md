# Dyno Explorer

A local-only, compiler-explorer-style web app for inspecting **Dyno-SV**
synthesis output. Dyno runs in the browser as WebAssembly (wasm32); nothing is
sent over the network. The build produces a fully self-contained static site
(`explorer/dist/`).

## Building

```sh
# 1. Check out the submodules
git submodule update --init --recursive

# 2. Build the dyno-sv-wasm module (slang + in-process ABC + dyno-as-library)
source /opt/emsdk/emsdk_env.sh        # or set EMSDK=/path/to/emsdk
make wasm                             # -> wasm-sv/dyno-sv-wasm.{js,wasm,data}

# 3. Bundle the frontend and copy the wasm into dist/
make site                             # -> explorer/dist/ (self-contained)

# 4. Serve dist/ with any static server:
make serve                            # node explorer/serve.js  (http://localhost:8000/)
# or: python3 -m http.server -d explorer/dist 8000
```

Verify the wasm module itself with:

```sh
make test                             # node tools/run-sv.js
```

`make wasm` is a thin wrapper over the CMake build:

```sh
emcmake cmake -B build/wasm -DCMAKE_BUILD_TYPE=Release
cmake --build build/wasm --target dyno-sv-wasm
```
