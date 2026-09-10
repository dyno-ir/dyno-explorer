cmake_minimum_required(VERSION 3.20)

project(dyno-explorer-wasm LANGUAGES C CXX)

# ---------------------------------------------------------------------------
# Dyno Explorer wasm build
#
# Builds the dyno-sv-wasm harness (tools/dyno-sv-wasm.cpp) as a browser-loadable
# wasm32 module. Dyno is consumed as a library from the `dyno/` git submodule;
# slang is built from the dyno submodule; ABC is built from `third-party/abc`.
#
# Configure:  emcmake cmake -B build/wasm -DCMAKE_BUILD_TYPE=Release
#             cmake --build build/wasm --target dyno-sv-wasm
# ---------------------------------------------------------------------------

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_C_STANDARD 11)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# ---- ccache (optional) -----------------------------------------------------
# The main CMake build gets ccache via -DCMAKE_C_COMPILER_LAUNCHER=ccache on the
# configure line (see Makefile), matching plain dyno. Here we only detect ccache
# for the ABC GNU-make build below, which the launcher flag does not reach.
find_program(CCACHE_PROGRAM ccache)

# -O2 is safe for wasm; -gline-tables-only (not full -g) keeps DWARF to line
# tables — enough for the explorer's crash backtrace, far leaner.
set(CMAKE_CXX_FLAGS_RELEASE "-O2 -gline-tables-only -DNDEBUG")
set(CMAKE_C_FLAGS_RELEASE "-O2 -gline-tables-only -DNDEBUG")

add_compile_options(-Wall -Wextra -Wno-unused-variable -Wno-unused-parameter
                    -Wno-unused-function -fno-rtti -fno-exceptions
                    -Wno-invalid-offsetof)
# Dyno/slang/ABC are -fno-exceptions clean; report_fatal_error aborts the module
# and the JS worker owns crash recovery. Debug blocks are always compiled in so
# the explorer's "extra args" (--debug-passes / -d) work in any build type.
add_compile_definitions(DYNO_ENABLE_DEBUG=1)

# ---- Dyno mainline as a library (unmodified submodule) ----------------------
add_subdirectory(dyno/lib)

# ---- slang (SystemVerilog parser) built from the dyno submodule -------------
set(SLANG_USE_MIMALLOC OFF CACHE BOOL "" FORCE)
set(SLANG_USE_THREADS OFF CACHE BOOL "" FORCE)
add_subdirectory(dyno/tools/dyno-sv/slang)

# ---- Berkeley-ABC (in-process synthesis engine) -----------------------------
# ABC ships a GNU-make build (not CMake); build libabc.a directly. Compiled
# into namespace `abc` to avoid symbol clashes with Dyno; pthreads/readline/
# thread-local are disabled for single-threaded wasm.
set(ABC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third-party/abc)
set(ABC_LIB ${CMAKE_CURRENT_BINARY_DIR}/libabc.a)

# ABC's GNU-make build bypasses CMake, and passing CC/CXX explicitly on the
# command line overrides ABC's own auto-ccache block. Prefix ccache ourselves.
if(CCACHE_PROGRAM)
  set(ABC_CC "${CCACHE_PROGRAM} em++")
  set(ABC_CXX "${CCACHE_PROGRAM} em++")
else()
  set(ABC_CC "em++")
  set(ABC_CXX "em++")
endif()

find_program(MAKE_PROGRAM NAMES make gmake REQUIRED)
add_custom_command(
    OUTPUT ${ABC_LIB}
    COMMAND ${MAKE_PROGRAM} -C ${ABC_DIR} libabc.a
            CC=${ABC_CC} CXX=${ABC_CXX} AR=emar
            ABC_USE_NAMESPACE=abc ABC_USE_NO_READLINE=1
            ABC_USE_NO_PTHREADS=1 ABC_USE_NO_THREAD_LOCAL=1
            ABC_USE_STDINT_H=1
    COMMAND ${CMAKE_COMMAND} -E copy ${ABC_DIR}/libabc.a ${ABC_LIB}
    WORKING_DIRECTORY ${ABC_DIR}
    DEPENDS ${ABC_DIR}/Makefile
    COMMENT "Building libabc.a (Berkeley-ABC)"
)
add_custom_target(abc_lib DEPENDS ${ABC_LIB})

# ---- dyno-sv-wasm -----------------------------------------------------------
add_executable(dyno-sv-wasm tools/dyno-sv-wasm.cpp)

target_include_directories(dyno-sv-wasm PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/dyno/tools/dyno-sv/include
    ${CMAKE_CURRENT_SOURCE_DIR}/dyno/include
    ${CMAKE_CURRENT_SOURCE_DIR}/tools
    ${CMAKE_CURRENT_SOURCE_DIR}/third-party/abc/src
)

target_compile_definitions(dyno-sv-wasm PRIVATE
    DYNO_USE_ABC ABC_NAMESPACE=abc ABC_USE_STDINT_H=1
    SLANG_BOOST_SINGLE_HEADER
)

target_link_libraries(dyno-sv-wasm PRIVATE
    core
    slang_slang
    ${ABC_LIB}
    m dl pthread
)
add_dependencies(dyno-sv-wasm abc_lib)

# ---- Emscripten link options ------------------------------------------------
# Stack must be large: Dyno's FatContext (~40KB) plus deep parser/pass recursion
# overflows the default 64KB wasm stack and silently corrupts memory.
target_link_options(dyno-sv-wasm PRIVATE
    --profiling-funcs
    # -gsource-map emits dyno-sv-wasm.wasm.map (from the line tables above); the
    # worker decodes it to turn trap offsets into file:line backtrace entries.
    -gsource-map
    -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB
    -sSTACK_SIZE=67108864 -sINITIAL_MEMORY=134217728
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sASSERTIONS=1
    -sFORCE_FILESYSTEM=1
    -sEXPORTED_FUNCTIONS=_dyno_run,_dyno_compile,_malloc,_free
    -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8,FS
)

# DWARF is only needed at link time to generate the source map; it would bloat
# the shipped module to ~140MB. Strip it back out after linking (code layout is
# unchanged, so trap offsets in the .wasm.map still resolve).
find_program(LLVM_OBJCOPY llvm-objcopy
    PATHS "$ENV{EMSDK}/upstream/bin" "/opt/emsdk/upstream/bin")
if(LLVM_OBJCOPY)
  set(_wasm_file ${CMAKE_CURRENT_BINARY_DIR}/dyno-sv-wasm.wasm)
  add_custom_command(TARGET dyno-sv-wasm POST_BUILD
      COMMAND ${LLVM_OBJCOPY} --strip-debug ${_wasm_file}
      COMMENT "Stripping DWARF from wasm (keeping .wasm.map for backtraces)")
endif()

# Preload the stdcell files into the virtual FS (MMap needs them on disk).
# Passed via CMAKE_EXE_LINKER_FLAGS (a single string) because CMake would
# otherwise deduplicate the repeated identical `--preload-file` flags.
set(_dyno_dir ${CMAKE_CURRENT_SOURCE_DIR}/dyno/tools/dyno-opt/dyno-ir)
string(CONCAT CMAKE_EXE_LINKER_FLAGS
  "${CMAKE_EXE_LINKER_FLAGS} "
  "--preload-file ${_dyno_dir}/sky130_fd_sc_hd.dyno@/tools/dyno-opt/dyno-ir/sky130_fd_sc_hd.dyno "
  "--preload-file ${_dyno_dir}/example_memories.dyno@/tools/dyno-opt/dyno-ir/example_memories.dyno "
  "--preload-file ${CMAKE_CURRENT_SOURCE_DIR}/third-party/sky130/sky130_fd_sc_hd__tt_025C_1v80.lib@/sky130_fd_sc_hd__tt_025C_1v80.lib")
