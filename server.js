import { startServer } from "@sena-labs/oz-mcp-server";

const PORT   = parseInt(process.env.PORT ?? "3847", 10);
const HOST   = "0.0.0.0";           // must listen on all interfaces on Sevalla
const TOKEN  = process.env.MCP_BEARER_TOKEN;

if (!TOKEN) {
  console.error("ERROR: MCP_BEARER_TOKEN is required");
  process.exit(1);
}

// Start the OzBridge MCP server.
// Config keys mirror the ozBridge.* VS Code settings documented in docs/MCP.md.
await startServer({
  port:            PORT,
  bindAddress:     HOST,
  bearerToken:     TOKEN,
  ozPath:          process.env.OZ_PATH ?? "oz",
  timeoutMs:       300_000,
  maxOutputChars:  15_000,
});

console.log(`OzBridge MCP server listening on http://${HOST}:${PORT}/sse`);