import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { randomUUID, createHash } from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  PingRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT ?? "3847", 10);
const INTERNAL_PORT = 3848;
const BASE_URL = process.env.BASE_URL;

// Streamable HTTP -> SSE bridge settings
const MCP_IDLE_TIMEOUT_MS = parseInt(process.env.MCP_IDLE_TIMEOUT_MS ?? String(30 * 60 * 1000), 10);
const MCP_MAX_SESSIONS = parseInt(process.env.MCP_MAX_SESSIONS ?? "100", 10);
// sessionId -> { server, transport, client, timer }
const mcpSessions = new Map();

function jsonRpcError(res, status, code, message, id = null) {
  if (!res.headersSent) {
    res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id });
  }
}

function setMcpCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID");
  res.set("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.set("Access-Control-Max-Age", "86400");
}

async function closeMcpSession(sessionId) {
  const s = mcpSessions.get(sessionId);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  mcpSessions.delete(sessionId);
  try { await s.transport.close(); } catch {}
  try { await s.client.close(); } catch {}
}

function armMcpTimer(sessionId) {
  const s = mcpSessions.get(sessionId);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => { closeMcpSession(sessionId).catch(() => {}); }, MCP_IDLE_TIMEOUT_MS);
}

async function createUpstreamClient() {
  const client = new Client(
    { name: "ozbridge-proxy", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${INTERNAL_PORT}/sse`));
  await client.connect(transport);
  return client;
}

function createProxyServer(client) {
  const server = new Server(
    { name: "ozbridge-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (req) => client.listTools(req.params));
  server.setRequestHandler(CallToolRequestSchema, async (req) => client.callTool(req.params));
  server.setRequestHandler(PingRequestSchema, async () => client.ping());
  return server;
}

const codes = new Map();
const tokens = new Map();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function getBaseUrl(req) {
  if (BASE_URL) return BASE_URL;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.json({
    resource: baseUrl,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
  });
});

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp"],
  });
});

const BEARER_TOKEN = process.env.MCP_BEARER_TOKEN;

app.get("/authorize", (req, res) => {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.query;
  if (response_type !== "code") return res.status(400).json({ error: "unsupported_response_type" });

  const allowed = "https://claude.ai/api/mcp/auth_callback";
  if (redirect_uri !== allowed) {
    return res.status(400).json({ error: "invalid_request", error_description: "Invalid redirect_uri" });
  }

  const code = randomUUID();
  const token = randomUUID();
  codes.set(code, {
    token, client_id: client_id || null, redirect_uri, code_challenge: code_challenge || null, code_challenge_method: code_challenge_method || null,
    expires: Date.now() + 10 * 60 * 1000,
  });

  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.post("/token", (req, res) => {
  const { grant_type, code, redirect_uri, code_verifier, client_id, client_secret } = req.body;

  if (grant_type === "refresh_token") {
    const token = randomUUID();
    tokens.set(token, { expires: Date.now() + 3600 * 1000, scope: "mcp" });
    return res.json({ access_token: token, token_type: "Bearer", expires_in: 3600, refresh_token: randomUUID(), scope: "mcp" });
  }

  if (grant_type !== "authorization_code") return res.status(400).json({ error: "unsupported_grant_type" });

  if (!BEARER_TOKEN || client_secret !== BEARER_TOKEN) {
    return res.status(401).json({ error: "invalid_client", error_description: "Invalid client_secret" });
  }

  const cd = codes.get(code);
  if (!cd || cd.expires < Date.now()) return res.status(400).json({ error: "invalid_grant" });
  codes.delete(code);

  if (cd.redirect_uri && cd.redirect_uri !== redirect_uri) return res.status(400).json({ error: "invalid_grant" });
  if (cd.client_id && cd.client_id !== client_id) return res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });

  if (cd.code_challenge && cd.code_challenge_method === "S256") {
    if (!code_verifier || typeof code_verifier !== "string") {
      return res.status(400).json({ error: "invalid_grant", error_description: "Missing code_verifier" });
    }
    const expected = createHash("sha256").update(code_verifier).digest("base64url");
    if (expected !== cd.code_challenge) return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
  }

  tokens.set(cd.token, { expires: Date.now() + 3600 * 1000, scope: "mcp" });
  res.json({ access_token: cd.token, token_type: "Bearer", expires_in: 3600, refresh_token: randomUUID(), scope: "mcp" });
});

function checkAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    const baseUrl = getBaseUrl(req);
    res.set("WWW-Authenticate", `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
    return res.status(401).json({ error: "invalid_token" });
  }

  const token = auth.slice(7);
  const td = tokens.get(token);
  if (!td || td.expires < Date.now()) {
    const baseUrl = getBaseUrl(req);
    res.set("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
    return res.status(401).json({ error: "invalid_token" });
  }
  next();
}

const proxy = createProxyMiddleware({
  target: `http://127.0.0.1:${INTERNAL_PORT}`,
  changeOrigin: true,
  logLevel: "silent",
  onProxyReq: (proxyReq) => proxyReq.removeHeader("authorization"),
});

// ---- Streamable HTTP /mcp endpoint (for Claude.ai connectors) ----
// Bridges Streamable HTTP on the public side to the legacy SSE transport
// exposed by the internal oz-mcp-server. Registered before the catch-all
// SSE proxy so /mcp is served here and everything else still falls through.
app.options("/mcp", (req, res) => { setMcpCors(res); res.status(204).end(); });

app.post("/mcp", checkAuth, async (req, res) => {
  setMcpCors(res);
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId) {
    const session = mcpSessions.get(sessionId);
    if (!session) {
      // Spec: requests with an invalid/unknown session ID return 404 Not Found.
      return jsonRpcError(res, 404, -32001, "Session not found", req.body?.id ?? null);
    }
    armMcpTimer(sessionId);
    try {
      await session.transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp] session handle error:", err);
      jsonRpcError(res, 500, -32603, "Internal error", req.body?.id ?? null);
    }
    return;
  }

  // No session id: must be an initialize request to start a new session.
  const isInitialize = req.body && req.body.method === "initialize";
  if (!isInitialize) {
    // Spec: non-initialization requests without a session ID return 400 Bad Request.
    return jsonRpcError(res, 400, -32600, "Bad Request: initialize required to start a session", req.body?.id ?? null);
  }
  if (mcpSessions.size >= MCP_MAX_SESSIONS) {
    return jsonRpcError(res, 503, -32603, "Too many concurrent sessions", req.body?.id ?? null);
  }

  let client;
  try {
    client = await createUpstreamClient();
  } catch (err) {
    console.error("[mcp] upstream connect failed:", err);
    return jsonRpcError(res, 502, -32603, "Upstream MCP server unavailable", req.body?.id ?? null);
  }

  const server = createProxyServer(client);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      mcpSessions.set(sid, { server, transport, client, timer: null });
      armMcpTimer(sid);
    },
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] initialize failed:", err);
    const sid = transport.sessionId;
    if (sid) await closeMcpSession(sid);
    else { try { await client.close(); } catch {} }
    jsonRpcError(res, 500, -32603, "Internal error", req.body?.id ?? null);
  }
});

app.get("/mcp", checkAuth, (req, res) => {
  setMcpCors(res);
  res.set("Allow", "POST, DELETE");
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method Not Allowed: server-initiated streams are not supported" }, id: null });
});

app.delete("/mcp", checkAuth, async (req, res) => {
  setMcpCors(res);
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !mcpSessions.has(sessionId)) {
    return res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
  }
  await closeMcpSession(sessionId);
  res.status(200).end();
});
// ---- end /mcp bridge ----

app.use(checkAuth, proxy);

const serverPath = join(__dirname, "node_modules", ".bin", "oz-mcp-server");
const child = spawn("node", [serverPath], {
  env: { ...process.env, OZ_MCP_PORT: String(INTERNAL_PORT), OZ_MCP_BIND: "127.0.0.1" },
  stdio: "inherit",
});

child.on("exit", (code) => {
  console.error("Internal oz-mcp-server exited with code", code);
  process.exit(code ?? 1);
});

setTimeout(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`OAuth proxy listening on http://0.0.0.0:${PORT}`);
    console.log(`Internal oz-mcp-server on http://127.0.0.1:${INTERNAL_PORT}`);
  });
}, 2000);
