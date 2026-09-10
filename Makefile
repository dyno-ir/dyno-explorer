# Dyno Explorer — build orchestration.
# Prereqs: Emscripten SDK (EMSDK, default /opt/emsdk), node, npm.
#
#   make wasm    # build dyno-sv-wasm.{js,wasm,data} into wasm-sv/
#   make site    # bundle the frontend + copy wasm into explorer/dist/
#   make test    # run the dyno-sv wasm test suite (node)
#   make all     # wasm + site
#   make serve   # serve explorer/dist/

.DEFAULT_GOAL := all
SHELL := /bin/bash

EMSDK      ?= /opt/emsdk
BUILD_DIR   := build/wasm
OUT_DIR     := wasm-sv

.PHONY: wasm site test all serve clean

# Build the dyno-sv-wasm module (slang + in-process ABC + dyno-as-library).
# emcmake/em++ must be on PATH; source the Emscripten SDK if not already there.
wasm:
	@if ! command -v emcmake >/dev/null 2>&1; then source "$(EMSDK)/emsdk_env.sh" >/dev/null 2>&1; fi; \
	CCACHE_LAUNCHER="$$(command -v ccache >/dev/null 2>&1 && echo "-DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache" || true)"; \
	emcmake cmake -B $(BUILD_DIR) -DCMAKE_BUILD_TYPE=Release $$CCACHE_LAUNCHER && \
	cmake --build $(BUILD_DIR) --target dyno-sv-wasm -j"$$(nproc)" && \
	mkdir -p $(OUT_DIR) && \
	cp $(BUILD_DIR)/dyno-sv-wasm.js $(BUILD_DIR)/dyno-sv-wasm.wasm \
	   $(BUILD_DIR)/dyno-sv-wasm.data $(BUILD_DIR)/dyno-sv-wasm.wasm.map $(OUT_DIR)/ && \
	echo "Built $(OUT_DIR)/dyno-sv-wasm.{js,wasm,data,wasm.map}"

# Bundle the frontend and copy the wasm module into dist/.
site: wasm
	cd explorer && npm install && npm run build

# Run the dyno-sv wasm test suite under node.
test: wasm
	node tools/run-sv.js

serve:
	cd explorer && npm run serve

all: site
	@echo "Done. Serve explorer/dist/ with:  make serve   (or: python3 -m http.server -d explorer/dist 8000)"

clean:
	rm -rf $(BUILD_DIR) $(OUT_DIR) explorer/dist explorer/node_modules
