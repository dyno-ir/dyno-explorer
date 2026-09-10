#pragma once

#include "dyno/Constant.h"
#include "dyno/Context.h"
#include "dyno/HierBlockIterator.h"
#include "dyno/Instr.h"
#include "dyno/Pass.h"
#include "hw/HWContext.h"
#include "hw/IDs.h"
#include "hw/LoadStore.h"
#include "hw/Module.h"
#include "hw/Process.h"
#include "hw/Wire.h"
#include "op/IDs.h"
#include "support/Ranges.h"
#include "support/SmallVec.h"
#include "support/StringRef.h"
#include "support/Tuple.h"
#include <algorithm>
#include <fstream>
#include <iterator>
#include <print>

namespace dyno {

class DumpDotPass : public Pass<DumpDotPass> {
  Context &ctx;

public:
  static constexpr DialectID dialect{DIALECT_HW};
#define CONFIG_STRUCT_LAMBDA(FIELD, ENUM)                                      \
  FIELD(std::string, path, "design.dot")
  CONFIG_STRUCT(CONFIG_STRUCT_LAMBDA)
#undef CONFIG_STRUCT_LAMBDA
  Config config;

private:
  std::ofstream os;

  // color per dialect index (dialect id -> table entry)
  static constexpr StringRef colors[] = {
      "#55555f", // CORE
      "#7a4fc0", // META
      "#2e8f6a", // OP
      "#888888", // DSL
      "#9c8a2e", // TYPE
      "#2e66c4", // HW
      "#c07a2e", // AIG
      "#888888", // unknown dialects
  };
  static constexpr const char *freeColor = "#5a5a66";  // free-in-HW bit ops
  static constexpr const char *constColor = "#8a732e"; // constants

  StringRef opcodeName(InstrRef instr) {
    return ctx.getDialectInfos()
        .opcodeInfoArr[instr.getDialect()][instr.getOpcode()]
        .name;
  }

  StringRef regName(RegisterRef reg) {
    auto names = ctx.getCtx<HWDialectContext>().regNameInfo.getNames(reg);
    return names.empty() ? StringRef{"?"} : *names.begin();
  }

  // write `%name` (or `%r<id>` when unnamed) for LOAD/STORE labels
  void writeRegRef(std::ostream &os, RegisterRef reg) {
    auto names = ctx.getCtx<HWDialectContext>().regNameInfo.getNames(reg);
    if (names.empty())
      os << "%r" << reg.getObjID().num;
    else
      std::print(os, "%{}", *names.begin());
  }

  // replace `__` in a stdcell name with a line break to shorten the node
  void writeCellName(std::ostream &os, std::string_view name) {
    for (size_t i = 0; i < name.size(); i++) {
      if (name[i] == '_' && i + 1 < name.size() && name[i + 1] == '_') {
        os << "<br/>";
        i++;
      } else
        os << name[i];
    }
  }

  // bit-indexing / free-in-HW ops (no real logic, just wiring)
  static bool isFreeOp(DialectOpcode opc) {
    switch (*opc) {
    case *HW_SPLICE:
    case *HW_INSERT:
    case *HW_CONCAT:
    case *HW_REPEAT:
    case *OP_ZEXT:
    case *OP_SEXT:
    case *OP_ANYEXT:
    case *OP_TRUNC:
      return true;
    default:
      return false;
    }
  }

  StringRef colorFor(InstrRef instr) {
    if (isFreeOp(instr.getDialectOpcode()))
      return StringRef{freeColor};
    auto d = instr.getDialect().num;
    return colors[std::min<size_t>(d, std::size(colors) - 1)];
  }

  // named attachment point an operand connects to on a stdcell, else empty
  StringRef stdcellPort(InstrRef inst, OperandRef op) {
    auto wire = op->dyn_as<WireRef>();
    if (!wire)
      return {};
    auto mod = inst.other(0)->as<ModuleRef>();
    OperandRef defIt = *inst.def_begin();
    OperandRef useIt = *(inst.other_begin() + 1);
    for (auto &port : mod->ports) {
      StringRef nm = regName(port.reg);
      if (port.portType == HW_INPUT_REGISTER_DEF) {
        if (auto w = useIt->dyn_as<WireRef>())
          if (w == wire)
            return nm;
        ++useIt;
      } else if (port.portType == HW_OUTPUT_REGISTER_DEF) {
        if (auto w = defIt->dyn_as<WireRef>())
          if (w == wire)
            return nm;
        ++defIt;
      }
    }
    return {};
  }

  // named attachment points for INSERT (out/in/val)
  static StringRef insertPort(OperandRef op) {
    switch (op.getNum()) {
    case 0:
      return StringRef{"out"};
    case 1:
      return StringRef{"in"};
    case 2:
      return StringRef{"val"};
    default:
      return {};
    }
  }

  // write ":port" for an operand's attachment point on stdcell/insert/concat
  void writePort(InstrRef inst, OperandRef op) {
    switch (*inst.getDialectOpcode()) {
    case *HW_STDCELL_INSTANCE:
      if (auto p = stdcellPort(inst, op); !p.empty())
        std::print(os, ":{}", p);
      break;
    case *HW_INSERT:
      if (auto p = insertPort(op); !p.empty())
        std::print(os, ":{}", p);
      break;
    case *HW_CONCAT:
      // others() are MSB..LSB; port 0 = least significant
      if (op.getNum() >= inst.getNumDefs())
        os << ":" << (inst.getNumOthers() - 1 - (op.getNum() - inst.getNumDefs()));
      break;
    default:
      break;
    }
  }

  // skip the address-term constants of splice/insert (offset is in the label)
  static bool isAddrOp(InstrRef inst, OperandRef op) {
    switch (*inst.getDialectOpcode()) {
    case *HW_SPLICE:
      return op.getNum() >= 2;
    case *HW_INSERT:
      return op.getNum() >= 3;
    default:
      return false;
    }
  }

  // port must be OUTSIDE the node-id quotes (`"5935":Y`), or graphviz reads
  // `"5935:Y"` as a node literally named "5935:Y" and draws a stand-in.
  void emitEdge(InstrRef prod, OperandRef prodOp, InstrRef cons,
                OperandRef consOp, uint32_t width) {
    os << "  \"" << prod.getObjID().num << "\"";
    writePort(prod, prodOp);
    os << " -> \"" << cons.getObjID().num << "\"";
    writePort(cons, consOp);
    os << " [label=\"" << width << "\"];\n";
  }

  void dumpPlainNode(InstrRef instr, StringRef color) {
    auto id = instr.getObjID().num;
    switch (*instr.getDialectOpcode()) {
    case *HW_LOAD:
      os << "  \"" << id << "\" [label=\"LOAD ";
      writeRegRef(os, instr.as<LoadIRef>().reg());
      std::print(os, "\", fillcolor=\"{}\"];\n", color);
      break;
    case *HW_STORE:
      os << "  \"" << id << "\" [label=\"STORE ";
      writeRegRef(os, instr.as<StoreIRef>().reg());
      std::print(os, "\", fillcolor=\"{}\"];\n", color);
      break;
    case *HW_SPLICE: {
      auto s = instr.as<SpliceIRef>();
      std::print(os, "  \"{}\" [label=\"SPLICE [{}+:{}]\", "
                 "fillcolor=\"{}\"];\n",
                 id, s.getBase(), s.getLen(), color);
      break;
    }
    default:
      std::print(os, "  \"{}\" [label=\"{}\", fillcolor=\"{}\"];\n", id,
                 opcodeName(instr), color);
      break;
    }
  }

  void dumpStdCellNode(InstrRef inst, StringRef color) {
    auto mod = inst.other(0)->as<ModuleRef>();
    SmallVec<StringRef, 8> ins, outs;
    for (auto &port : mod->ports) {
      if (port.portType == HW_INPUT_REGISTER_DEF)
        ins.emplace_back(regName(port.reg));
      else if (port.portType == HW_OUTPUT_REGISTER_DEF)
        outs.emplace_back(regName(port.reg));
    }
    auto n = std::max(ins.size(), outs.size());
    std::print(os, "  \"{}\" [label=<", inst.getObjID().num);
    std::print(os, "<TABLE BORDER=\"1\" CELLBORDER=\"1\" CELLSPACING=\"0\" "
                   "CELLPADDING=\"2\" BGCOLOR=\"{}\" COLOR=\"#ffffff\">",
               color);
    for (size_t i = 0; i < n; i++) {
      os << "<TR>";
      auto spanCell = [&](const StringRef &nm, bool last, size_t sz) {
        unsigned span = (last && sz < n) ? n - sz + 1 : 1;
        if (span > 1)
          std::print(os, "<TD PORT=\"{}\" ROWSPAN=\"{}\">{}</TD>", nm, span,
                     nm);
        else
          std::print(os, "<TD PORT=\"{}\">{}</TD>", nm, nm);
      };
      if (i < ins.size())
        spanCell(ins[i], i == ins.size() - 1, ins.size());
      if (i == 0) {
        os << "<TD ROWSPAN=\"" << n << "\">";
        writeCellName(os, mod->name);
        os << "</TD>";
      }
      if (i < outs.size())
        spanCell(outs[i], i == outs.size() - 1, outs.size());
      os << "</TR>";
    }
    os << "</TABLE>>, shape=plaintext, style=\"\"];\n";
  }

  void dumpConcatNode(InstrRef inst, StringRef color) {
    auto n = inst.getNumOthers();
    std::print(os, "  \"{}\" [label=<", inst.getObjID().num);
    std::print(os, "<TABLE BORDER=\"1\" CELLBORDER=\"1\" CELLSPACING=\"0\" "
                   "CELLPADDING=\"2\" BGCOLOR=\"{}\" COLOR=\"#ffffff\">",
               color);
    for (unsigned i = 0; i < n; i++) {
      os << "<TR>";
      std::print(os, "<TD PORT=\"{}\">{}</TD>", i, i); // MSB..LSB
      // center + output span all rows (vertically centered); later rows omit
      // the spanned cells entirely so no empty bordered cells appear
      if (i == 0) {
        std::print(os, "<TD ROWSPAN=\"{}\">CONCAT</TD>", n);
        std::print(os, "<TD ROWSPAN=\"{}\" PORT=\"out\">out</TD>", n);
      }
      os << "</TR>";
    }
    os << "</TABLE>>, shape=plaintext, style=\"\"];\n";
  }

  void dumpInsertNode(InstrRef inst, StringRef color) {
    std::print(os, "  \"{}\" [label=<", inst.getObjID().num);
    std::print(os, "<TABLE BORDER=\"1\" CELLBORDER=\"1\" CELLSPACING=\"0\" "
                   "CELLPADDING=\"2\" BGCOLOR=\"{}\" COLOR=\"#ffffff\">",
               color);
    os << "<TR><TD PORT=\"in\">in</TD><TD ROWSPAN=\"2\">INSERT ["
       << inst.as<InsertIRef>().getBase() << " +: "
       << inst.as<InsertIRef>().getLen() << "]</TD><TD PORT=\"out\">out</TD></TR>";
    os << "<TR><TD PORT=\"val\">val</TD><TD></TD></TR>";
    os << "</TABLE>>, shape=plaintext, style=\"\"];\n";
  }

  void dumpInstr(InstrRef instr) {
    switch (*instr.getDialectOpcode()) {
    case *HW_STDCELL_INSTANCE:
      dumpStdCellNode(instr, colorFor(instr));
      break;
    case *HW_INSERT:
      dumpInsertNode(instr, colorFor(instr));
      break;
    case *HW_CONCAT:
      dumpConcatNode(instr, colorFor(instr));
      break;
    default:
      dumpPlainNode(instr, colorFor(instr));
      break;
    }
  }

  void dumpModule(ModuleIRef mod) {
    SmallVec<InstrRef, 64> instrs;
    for (auto proc : mod.procs())
      for (auto instr : HierBlockRange{proc.block()})
        instrs.emplace_back(instr);
    // declare every node up front so graphviz never sees an edge to an
    // undeclared node (forward refs break HTML-label / port nodes)
    for (auto instr : instrs)
      dumpInstr(instr);
    for (auto instr : instrs)
      for (auto use : instr.others()) {
        if (auto c = use->dyn_as<ConstantRef>()) {
          if (isAddrOp(instr, use))
            continue;
          os << "  \"#" << c << "\" [label=\"#" << c
             << "\", fillcolor=\"" << constColor << "\"];\n";
          os << "  \"#" << c << "\" -> \"" << instr.getObjID().num << "\"";
          writePort(instr, use); // e.g. concat input position
          os << ";\n";
          continue;
        }
        if (!Operand::isDefUseOperand(*use))
          continue;
        auto def = use->as<FatDynObjRef<InstrDefUse>>()->getSingleDef();
        if (!def)
          continue;
        if (auto wire = def->dyn_as<WireRef>())
          emitEdge(def->instr(), *def, instr, use, *wire.getNumBits());
      }
  }

public:
  void runWrapper(auto &&runFunc) {
    os = std::ofstream{config.path};
    os << "digraph design {\n";
    os << "  graph [rankdir=LR, bgcolor=\"transparent\", nodesep=\"0.35\", "
          "ranksep=\"0.4\"];\n";
    os << "  node [shape=box, style=\"filled,rounded\", fontsize=10, "
          "fontcolor=\"#ffffff\", fontname=\"helvetica\"];\n";
    os << "  edge [color=\"#5a5a5a\", fontcolor=\"#d8d8d8\", fontsize=8, "
          "fontname=\"helvetica\", arrowsize=0.6];\n";
    runFunc();
    os << "}\n";
  }
  void runModule(ModuleIRef mod) { runWrapper([&] { dumpModule(mod); }); }
  void run() {
    runWrapper([&] {
      for (auto mod : ctx.getCtx<HWDialectContext>().activeModules())
        dumpModule(mod.iref());
    });
  }

  static constexpr auto runFuncs =
      mk_tuple(&DumpDotPass::run, &DumpDotPass::runModule);
  explicit DumpDotPass(Context &ctx) : ctx(ctx) {}
  auto make(Context &ctx) { return DumpDotPass{ctx}; }
};

} // namespace dyno
