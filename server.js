import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TOKEN = process.env.MCP_BEARER_TOKEN;
if (!TOKEN) {
  console.error("ERROR: MCP_BEARER_TOKEN is required");
  process.exit(1);
}

// Map our env vars to what the oz-mcp-server CLI expects.
process.env.OZ_MCP_TOKEN = TOKEN;
process.env.OZ_MCP_PORT = process.env.PORT ?? "3847";
process.env.OZ_MCP_BIND = "0.0.0.0";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "node_modules", ".bin", "oz-mcp-server");

const child = spawn("node", [serverPath], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => process.exit(code ?? 0));
