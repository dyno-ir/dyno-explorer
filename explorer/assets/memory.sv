module mem_32x32 (
  input logic clk,
  input logic[4:0] IN_waddr,
  input logic[31:0] IN_wdata,
  input logic[0:0] IN_wmask,
  input logic[4:0] IN_raddr,
  output logic[31:0] OUT_rdata
);
  logic[31:0] mem[31:0];
  always_ff@(posedge clk)
    if (IN_wmask[0])
      mem[IN_waddr] <= IN_wdata;
  always_comb
    OUT_rdata = mem[IN_raddr];
endmodule
