// `infinite-tag mcp-proxy` (hidden from help): the stdio side of the wizard's claim channel
// (§3e.3). An agent spawns `<node> <cli.js> mcp-proxy` with INFINITE_TAG_MCP_URL and
// INFINITE_TAG_MCP_TOKEN in its env, and this process relays stdio JSON-RPC to the wizard's
// loopback MCP bridge.
//
// FOUNDATION STUB (lane F0). Lane O3 fills it. Until then it relays nothing and exits 2, so an agent
// that spawns it sees a dead MCP server (the wizard then reads the run as `toolless`), never a fake
// "connected" one.
import { exitCodeFor } from "../../wizard/contracts/codes.js"

export async function runMcpProxy(): Promise<number> {
  console.error("infinite-tag mcp-proxy is not built yet.")
  return exitCodeFor("INF_WIZ_NOT_BUILT")
}
