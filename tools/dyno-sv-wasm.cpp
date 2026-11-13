// Wasm harness for dyno-sv. Exposes the real dyno-sv command line over a small
// C ABI; all input/flow files live in the Emscripten MEMFS.
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
#include "hw/HWTypeIDs.h"
#include "hw/PrintParse.h"
#include "hw/passes/DumpVerilog.h"
#include "hw/passes/HWDialectPasses.h"
#include "meta/MetaContext.h"
#include "meta/MetaParser.h"
#include "meta/PassPipelineInterpreter.h"
#include "op/OpContext.h"
#include "support/ArrayRef.h"
#include "support/CmdLineArgs.h"
#include "support/ErrorRecovery.h"
#include "support/MMap.h"
#include "support/SmallVec.h"
#include "support/StringRef.h"
#include "support/SubCommand.h"
#include "support/Tokenizer.h"
#include "support/TwoLevelSet.h"
#include "test/IDs.h"
#include "test/TestInterpreter.h"
#include "test/passes/AssertExists.h"
#include "type/TypeContext.h"
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
using namespace dyno;

using ScriptParser = Parser<CoreDialectParser, MetaDialectParser, OpDialectParser, HWDialectParser, AIGDialectParser>;
using TestParser = Parser<CoreDialectParser, MetaDialectParser, TypeDialectParser, OpDialectParser, HWDialectParser,
                          AIGDialectParser, TestDialectParser>;

class TestPrinter
    : public ContextPrinterWrapper<CoreDialectPrinter, MetaDialectPrinter, TypeDialectPrinter, OpDialectPrinter,
                                   HWDialectPrinter, AIGDialectPrinter, TestDialectPrinter>
{
  public:
    TestPrinter(Context& ctx, std::ostream& os) : ContextPrinterWrapper(ctx, os)
    { this->printers.get<HWDialectPrinter>().regNames = &ctx.getCtx<HWDialectContext>().regNameInfo; }
};

struct Args
{
    CmdLineArg<Vec<StringRef>> inputFiles{
        std::nullopt, "input file", "Input files.",
        CmdLineArgFlags::VALUE_REQUIRED | CmdLineArgFlags::MULTIPLE |
            CmdLineArgFlags::POSITIONAL | CmdLineArgFlags::MANDATORY};

    CmdLineArg<StringRef> libertyFile{
        'l', "liberty", "Liberty (stdcell definitions) file path.",
        CmdLineArgFlags::VALUE_REQUIRED | CmdLineArgFlags::MANDATORY, ""};

    CmdLineArg<StringRef> outFile{'o', "", "Output Verilog netlist file path.", CmdLineArgFlags::VALUE_REQUIRED};

    CmdLineArg<Vec<StringRef>> slangArgs{
        'X', "Xslang", "Slang arguments. Use multiple times for multiple args.",
        CmdLineArgFlags::VALUE_REQUIRED | CmdLineArgFlags::MULTIPLE};

    CmdLineArg<Vec<StringRef>> flowScript{
        's', "script", "Dyno-IR flow script file name.",
        CmdLineArgFlags::VALUE_REQUIRED | CmdLineArgFlags::MULTIPLE | CmdLineArgFlags::MANDATORY};

    CmdLineArg<bool> ignoreSimOnly{
        std::nullopt, "ignore-sim-only",
        "Ignore unsupported simulation only constructs in frontend rather than erroring.",
        0, false};

    CmdLineArg<Vec<StringRef>> scriptFileName{
        std::nullopt, "script file", "Dyno-IR script file name(s).",
        CmdLineArgFlags::VALUE_REQUIRED | CmdLineArgFlags::MANDATORY |
            CmdLineArgFlags::POSITIONAL | CmdLineArgFlags::MULTIPLE};

    CmdLineArg<Vec<StringRef>> testOnly{
        std::nullopt, "only", "Only run listed test, can be specified multiple times.",
        CmdLineArgFlags::VALUE_REQUIRED | CmdLineArgFlags::MULTIPLE};

    CmdLineArg<bool> debug{
        'd', "debug", "Run in debug mode (only has effect for debug builds).", 0, false};

    CmdLineArg<Vec<StringRef>> debugPasses{
        std::nullopt, "debug-passes",
        "Run passes in debug mode (only has effect for debug builds), can be specified multiple times.",
        CmdLineArgFlags::VALUE_REQUIRED | CmdLineArgFlags::MULTIPLE, {}};

    CmdLineArg<bool> printAfterAll{
        std::nullopt, "print-after-all", "Print IR after all passes.", 0, false};
};

static void setupContext(FatContext& ctx, SymbolStore& symbols, bool test)
{
    ctx.add<HWDialectContext>();
    ctx.add<CoreDialectContext>();
    ctx.add<OpDialectContext>();
    ctx.add<AIGDialectContext>();
    ctx.add<TypeDialectContext>();
    ctx.getCtx<TypeDialectContext>().baseTypeNames.registerDialect(DIALECT_HW, hw::hwTypeDialectTypeNames);
    ctx.getPassRegistry().registerPass<ParseVerilogPass>();
    ctx.getPassRegistry().registerPass<DumpDotPass>();
    ctx.getCtx<CoreDialectContext>().setSymbols(symbols);
    if (test)
    {
        ctx.add<TestDialectContext>();
        ctx.getPassRegistry().registerPass<AssertExistsPass<TestPrinter>>();
    }
    ctx.add<MetaDialectContext>();
}

static void applyDebugArgs(FatContext& ctx, Args& args)
{
#ifdef DYNO_ENABLE_DEBUG
    dbg_disable_all();
    if (*args.debug)
        dbg_enable_all();
    dbg_disable_for_id(128);
    dbg_disable_for_id(129);
    dbg_disable_for_id(130);
    SmallVec<StringRef, 8> passes;
    for (auto& s : *args.debugPasses)
        passes.emplace_back(s);
    ctx.getPassRegistry().setDebugEnForPasses(passes, true);
#endif
}

static void runScript(Context& ctx, ArrayRef<StringRef> fileNames)
{
    ScriptParser parser{ctx};
    auto flowBlock = ctx.getStore<Block>().create(ctx.getCFG());
    for (auto file : fileNames)
    {
        std::string fileName{file.begin(), file.end()};
        MMap mmap{fileName};
        if (!mmap)
            report_fatal_error("failed to open file: {}", fileName);
        parser.parse(mmap, fileName, flowBlock.end());
    }

    ResolveImportsPass{ctx}.run();

    SmallVec<void*, 1> passCtorArgs{reinterpret_cast<void*>(&ctx)};
    MetaPassPipelineInterpreter interp{ctx, passCtorArgs};

    FatDynObjRef<> arg = nullref;
    SmallVec<void*, 1> passRunArgs{reinterpret_cast<void*>(&arg)};
    interp.interpretPassPipeline(flowBlock, passRunArgs);
}

static void synth(Context& ctx, Args& args)
{
    ParseVerilogPass parse{ctx};
    parse.config.ignoreSimOnly = *args.ignoreSimOnly;
    SmallVec<StringRef, 8> parseArgs;
    for (auto& s : *args.slangArgs)
        parseArgs.emplace_back(s);
    for (auto& s : *args.inputFiles)
        parseArgs.emplace_back(s);
    auto res = parse.parse(parseArgs);
    if (!res)
        report_fatal_error("{}", res.error());

    runScript(ctx, *args.flowScript);
    if (!args.outFile->empty())
    {
        DumpVerilogPass dumpVlog{ctx};
        dumpVlog.config.fileName = *args.outFile;
        dumpVlog.run();
    }
}

static void runTest(FatContext& ctx, Args& args)
{
    TestParser parser{ctx};
    TwoLevelSet<StringRef> only{Range(*args.testOnly)};
    auto block = ctx.getStore<Block>().create(ctx.getCFG());

    for (auto file : *args.scriptFileName)
    {
        std::string fileName{file.begin(), file.end()};
        MMap mmap{fileName};
        if (!mmap)
            report_fatal_error("failed to open file: {}", fileName);
        parser.parse(mmap, fileName, block.end());
    }

    ResolveImportsPass{ctx}.run();
    auto sandbox = ctx.create();
    sandbox.getCtx<CoreDialectContext>().setSymbols(*ctx.getCtx<CoreDialectContext>().symbols);
    sandbox.getCtx<TypeDialectContext>().baseTypeNames.registerDialect(DIALECT_HW, hw::hwTypeDialectTypeNames);
    sandbox.getPassRegistry().registerPass<ParseVerilogPass>();
    sandbox.getPassRegistry().registerPass<DumpDotPass>();
    sandbox.getPassRegistry().registerPass<AssertExistsPass<TestPrinter>>();
    sandbox.getCtx<MetaDialectContext>().reRegister(sandbox);

    TestPrinter print{sandbox, std::cout};
    TestInterpreter interp{ctx, print};
    bool pass = interp.execBlock(block, sandbox, only, *args.printAfterAll);
    std::cout << (pass ? "ALL TESTS PASSED" : "TESTS FAILED") << "\n";
    std::cout.flush();
}

static void runMain(const char* argLine)
{
    SmallVec<std::string, 16> tokens;
    for (auto tok : Tokenizer{argLine})
        tokens.emplace_back(tok);
    SmallVec<char*, 16> argv;
    argv.reserve(tokens.size() + 2);
    argv.push_back(const_cast<char*>("dyno-sv"));
    for (auto& t : tokens)
        argv.push_back(t.data());
    argv.push_back(nullptr);

    Args args;
    enum { SC_SYNTH, SC_SCRIPT, SC_TEST };
    unsigned sc;
    {
        SubCommand synthCmd("synth", SC_SYNTH);
        SubCommand scriptCmd("script", SC_SCRIPT);
        SubCommand testCmd("test", SC_TEST);

        synthCmd.registerArg(args.inputFiles);
        synthCmd.registerArg(args.libertyFile);
        synthCmd.registerArg(args.outFile);
        synthCmd.registerArg(args.slangArgs);
        synthCmd.registerArg(args.flowScript);
        synthCmd.registerArg(args.debug);
        synthCmd.registerArg(args.debugPasses);
        synthCmd.registerArg(args.printAfterAll);

        scriptCmd.registerArg(args.scriptFileName);
        scriptCmd.registerArg(args.debug);
        scriptCmd.registerArg(args.debugPasses);
        scriptCmd.registerArg(args.printAfterAll);

        testCmd.registerArg(args.scriptFileName);
        testCmd.registerArg(args.testOnly);
        testCmd.registerArg(args.debug);
        testCmd.registerArg(args.debugPasses);
        testCmd.registerArg(args.printAfterAll);

        SubCommandHandler handler(&synthCmd);
        handler.registerSubCmd(synthCmd);
        handler.registerSubCmd(scriptCmd);
        handler.registerSubCmd(testCmd);
        sc = handler.parse(argv.size() - 1, argv.data());
    }

    SymbolStore symbols;
    FatContext ctx;
    setupContext(ctx, symbols, sc == SC_TEST);
    applyDebugArgs(ctx, args);

    switch (sc)
    {
    case SC_SYNTH:
        synth(ctx, args);
        break;
    case SC_SCRIPT:
        runScript(ctx, *args.scriptFileName);
        break;
    case SC_TEST:
        runTest(ctx, args);
        break;
    }
}

extern "C"
{
    __attribute__((export_name("dyno_run"))) void dyno_run(const char* args) { runMain(args); }
}
