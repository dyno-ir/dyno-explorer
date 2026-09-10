// Wasm harness for dyno-sv. Exposes a small C ABI to the browser.

#include "DumpDotPass.h"
#include "ParseVerilogPass.h"
#include "aig/AIGContext.h"
#include "aig/PrintParse.h"
#include "dyno/CFG.h"
#include "dyno/Context.h"
#include "dyno/DeepCopy.h"
#include "dyno/DialectInfo.h"
#include "dyno/FatContext.h"
#include "dyno/Parser.h"
#include "dyno/Symbol.h"
#include "dyno/passes/ResolveImports.h"
#include "hw/HWContext.h"
#include "hw/HWPrinter.h"
#include "hw/PrintParse.h"
#include "hw/passes/HWDialectPasses.h"
#include "meta/MetaContext.h"
#include "meta/MetaParser.h"
#include "meta/PassPipelineInterpreter.h"
#include "op/OpContext.h"
#include "support/ArrayRef.h"
#include "support/CmdLineArgs.h"
#include "support/ErrorRecovery.h"
#include "support/SmallVec.h"
#include "support/StringRef.h"
#include "support/TwoLevelSet.h"
#include "test/IDs.h"
#include "test/TestInterpreter.h"
#include "test/passes/AssertExists.h"
#include "type/TypeContext.h"
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
using namespace dyno;

// Parsed explorer "extra args" (CLI-style), applied per run.
struct ExtraArgs {
  bool debug = false;
  bool printAfterAll = false;
  SmallVec<std::string, 4> debugPasses;
  SmallVec<std::string, 4> slangArgs;
  SmallVec<std::string, 4> only;
};

static ExtraArgs parseArgs(const char *args) {
  ExtraArgs out;
  if (!args)
    return out;

  // Tokenize (space-delimited) into an argv-like array.
  SmallVec<std::string, 8> tokens;
  for (auto tok : Tokenizer{args})
    tokens.emplace_back(tok);
  SmallVec<char *, 8> argv;
  argv.reserve(tokens.size() + 2);
  argv.push_back(const_cast<char *>("dyno-sv"));
  for (auto &t : tokens)
    argv.push_back(t.data());
  argv.push_back(nullptr);

  CmdLineArg<bool> argDebug{'d', "debug",
                            "Run passes in debug mode (debug builds only).", 0,
                            false};
  CmdLineArg<Vec<StringRef>> argDebugPasses{
      std::nullopt, "debug-passes",
      "Run named passes in debug mode (repeatable).",
      CmdLineArgFlags::VALUE_REQUIRED | CmdLineArgFlags::MULTIPLE, {}};
  CmdLineArg<Vec<StringRef>> argSlangArgs{
      'X', "Xslang", "Slang arguments (repeatable).",
      CmdLineArgFlags::VALUE_REQUIRED | CmdLineArgFlags::MULTIPLE, {}};
  CmdLineArg<Vec<StringRef>> argOnly{
      std::nullopt, "only", "Only run listed tests (repeatable).",
      CmdLineArgFlags::VALUE_REQUIRED | CmdLineArgFlags::MULTIPLE, {}};
  CmdLineArg<bool> argPrintAfterAll{
      std::nullopt, "print-after-all", "Print IR after all passes.", 0,
      false};

  CmdLineArgHandler handler;
  handler.registerArg(argDebug);
  handler.registerArg(argDebugPasses);
  handler.registerArg(argSlangArgs);
  handler.registerArg(argOnly);
  handler.registerArg(argPrintAfterAll);
  handler.parse(argv.size() - 1, argv.data());

  // Copy into owned storage (parsed StringRefs point into the temp argv).
  out.debug = *argDebug;
  out.printAfterAll = *argPrintAfterAll;
  for (auto &s : *argDebugPasses) out.debugPasses.emplace_back(s);
  for (auto &s : *argSlangArgs) out.slangArgs.emplace_back(s);
  for (auto &s : *argOnly) out.only.emplace_back(s);

  return out;
}

using TestParser = Parser<CoreDialectParser, MetaDialectParser,
                          TypeDialectParser, OpDialectParser, HWDialectParser,
                          AIGDialectParser, TestDialectParser>;
using ScriptParser = Parser<CoreDialectParser, MetaDialectParser,
                            OpDialectParser, HWDialectParser, AIGDialectParser>;

class TestPrinter
    : public ContextPrinterWrapper<CoreDialectPrinter, MetaDialectPrinter,
                                   TypeDialectPrinter, OpDialectPrinter,
                                   HWDialectPrinter, AIGDialectPrinter,
                                   TestDialectPrinter> {
public:
  TestPrinter(Context &ctx, std::ostream &os) : ContextPrinterWrapper(ctx, os) {
    this->printers.get<HWDialectPrinter>().regNames =
        &ctx.getCtx<HWDialectContext>().regNameInfo;
  }
};

// ---- shared context setup ---------------------------------------------------

// ---- dyno_compile -----------------------------------------------------------

static void runCompile(const char *flowSrc, size_t flowLen,
                        const char *inputSrc, size_t inputLen,
                        const char *kind, const char *extraArgs) {
  SymbolStore symbols;
  FatContext ctx;
  ctx.add<HWDialectContext>();
  ctx.add<CoreDialectContext>();
  ctx.add<OpDialectContext>();
  ctx.add<AIGDialectContext>();
  ctx.add<TypeDialectContext>();
  ctx.getCtx<TypeDialectContext>().baseTypeNames.registerDialect(
      DIALECT_HW, hw::hwTypeDialectTypeNames);
  ctx.getPassRegistry().registerPass<ParseVerilogPass>();
  ctx.getPassRegistry().registerPass<DumpDotPass>();
  ctx.getCtx<CoreDialectContext>().setSymbols(symbols);
  ctx.add<MetaDialectContext>();

  std::string designKind = kind ? kind : "sv";
  std::ostringstream finalIr;

  ExtraArgs extra = parseArgs(extraArgs);
#ifdef DYNO_ENABLE_DEBUG
  // The extra args fully determine this run's debug state; reset + apply.
  dbg_disable_all();
  if (extra.debug)
    dbg_enable_all();
  dbg_disable_for_id(128); // known bits
  dbg_disable_for_id(129); // hwinterp
  dbg_disable_for_id(130); // loopback
  SmallVec<StringRef, 8> passes;
  for (auto &s : extra.debugPasses)
    passes.emplace_back(s);
  ctx.getPassRegistry().setDebugEnForPasses(passes, true);
#endif

  if (designKind == "sv") {
    ParseVerilogPass parse{ctx};
    parse.config.code = StringRef{inputSrc, inputLen};
    SmallVec<StringRef, 8> slangArgs;
    for (auto &s : extra.slangArgs)
      slangArgs.emplace_back(s);
    auto res = parse.parse(slangArgs);
    if (!res)
      report_fatal_error("{}", res.error());
  } else {
    // dyno-IR input: parse into a design block.
    ScriptParser parser{ctx};
    auto designBlock = ctx.getStore<Block>().create(ctx.getCFG());
    if (inputLen)
      parser.parse(ArrayRef<char>{const_cast<char *>(inputSrc), inputLen},
                   "<input>", designBlock.end());
  }

  // Parse the flow script into its own block.
  auto flowBlock = ctx.getStore<Block>().create(ctx.getCFG());
  {
    ScriptParser parser{ctx};
    if (flowLen)
      parser.parse(ArrayRef<char>{const_cast<char *>(flowSrc), flowLen},
                   "<flow>", flowBlock.end());
  }

  ResolveImportsPass{ctx}.run();

  SmallVec<void *, 1> passCtorArgs{reinterpret_cast<void *>(&ctx)};
  MetaPassPipelineInterpreter interp{ctx, passCtorArgs};
  FatDynObjRef<> arg = nullref;
  SmallVec<void *, 1> passRunArgs{reinterpret_cast<void *>(&arg)};
  interp.interpretPassPipeline(flowBlock, passRunArgs);

  {
    HWPrinter print{finalIr};
    print.printCtx(ctx);
    std::ofstream ofs("out.dyno");
    ofs << finalIr.str();
  }
}

// ---- dyno_run (test mode) ---------------------------------------------------

static void runTests(const char *flowSrc, size_t flowLen,
                      const char *testSrc, size_t testLen,
                      const char *extraArgs) {
  SymbolStore symbols;
  FatContext ctx;

  ctx.add<HWDialectContext>();
  ctx.add<CoreDialectContext>();
  ctx.add<OpDialectContext>();
  ctx.add<AIGDialectContext>();
  ctx.add<TypeDialectContext>();
  ctx.getCtx<TypeDialectContext>().baseTypeNames.registerDialect(
      DIALECT_HW, hw::hwTypeDialectTypeNames);
  ctx.getPassRegistry().registerPass<ParseVerilogPass>();
  ctx.getPassRegistry().registerPass<DumpDotPass>();
  ctx.getCtx<CoreDialectContext>().setSymbols(symbols);
  ctx.add<TestDialectContext>();
  ctx.getPassRegistry().registerPass<AssertExistsPass<TestPrinter>>();
  ctx.add<MetaDialectContext>();

  TestPrinter print{ctx, std::cout};
  TestParser parser{ctx};
  auto block = ctx.getStore<Block>().create(ctx.getCFG());

  ExtraArgs extra = parseArgs(extraArgs);
#ifdef DYNO_ENABLE_DEBUG
  // The extra args fully determine this run's debug state; reset + apply.
  dbg_disable_all();
  if (extra.debug)
    dbg_enable_all();
  dbg_disable_for_id(128); // known bits
  dbg_disable_for_id(129); // hwinterp
  dbg_disable_for_id(130); // loopback
  SmallVec<StringRef, 8> passes;
  for (auto &s : extra.debugPasses)
    passes.emplace_back(s);
  ctx.getPassRegistry().setDebugEnForPasses(passes, true);
#endif
  if (flowLen)
    parser.parse(ArrayRef<char>{const_cast<char *>(flowSrc), flowLen},
                 "<flow>", block.end());
  if (testLen)
    parser.parse(ArrayRef<char>{const_cast<char *>(testSrc), testLen},
                 "<input>", block.end());

  ResolveImportsPass{ctx}.run();
  auto sandbox = ctx.create();
  sandbox.getCtx<CoreDialectContext>().setSymbols(
      *ctx.getCtx<CoreDialectContext>().symbols);
  sandbox.getCtx<TypeDialectContext>().baseTypeNames.registerDialect(
      DIALECT_HW, hw::hwTypeDialectTypeNames);
  sandbox.getPassRegistry().registerPass<ParseVerilogPass>();
  sandbox.getPassRegistry().registerPass<DumpDotPass>();
  sandbox.getPassRegistry().registerPass<AssertExistsPass<TestPrinter>>();
  sandbox.getCtx<MetaDialectContext>().reRegister(sandbox);

  TestInterpreter interp{sandbox, print};
  TwoLevelSet<StringRef> only{};
  for (auto &s : extra.only)
    only.insert(s);
  bool pass = interp.execBlock(block, sandbox, only, extra.printAfterAll);

  std::cout << (pass ? "ALL TESTS PASSED" : "TESTS FAILED") << "\n";
  std::cout.flush();
}

// ---- extra args -------------------------------------------------------------

extern "C" {

__attribute__((export_name("dyno_run")))
void dyno_run(const char *flow, const char *test, const char *extraArgs) {
  runTests(flow, strlen(flow), test, strlen(test), extraArgs);
}

__attribute__((export_name("dyno_compile")))
void dyno_compile(const char *flow, const char *input, const char *kind,
                  const char *extraArgs) {
  runCompile(flow, strlen(flow), input, strlen(input), kind, extraArgs);
}
}
