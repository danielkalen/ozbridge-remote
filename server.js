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

const OZ_PATH = process.env.OZ_PATH || "oz";
const OZ_LIST_TIMEOUT_MS = parseInt(process.env.OZ_LIST_TIMEOUT_MS ?? "30000", 10);
const OZ_RECOMMENDED_MODEL = process.env.OZ_RECOMMENDED_MODEL || "kimi-k26-fireworks";
// Base URL of the Warp public API. Used by the in-process follow-up tool/endpoint
// (the oz CLI has no follow-up command, so we call the REST API directly).
const OZ_API_BASE_URL = (process.env.OZ_API_BASE_URL || "https://app.warp.dev/api/v1").replace(/\/+$/, "");

// Run a read-only `oz` CLI subcommand with JSON output and a bounded timeout.
// Inherits process.env (so WARP_API_KEY / `oz login` state reach the CLI) and
// forces WARP_OUTPUT_FORMAT=json so the result is parseable.
function execOz(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(OZ_PATH, args, {
      env: { ...process.env, WARP_OUTPUT_FORMAT: "json" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`oz ${args.join(" ")} timed out after ${OZ_LIST_TIMEOUT_MS}ms`));
    }, OZ_LIST_TIMEOUT_MS);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const msg = (stderr || stdout || `exit code ${code}`).trim();
        reject(new Error(`oz ${args.join(" ")} failed: ${msg.substring(0, 500)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function extractOzItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    for (const key of ["items", "environments", "models", "data", "results"]) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
    return [parsed];
  }
  return [];
}

async function listOzEnvironments() {
  const stdout = await execOz(["environment", "list"]);
  let parsed = null;
  try { parsed = JSON.parse(stdout.trim()); } catch {}
  const environments = extractOzItems(parsed);
  return { count: environments.length, environments };
}

async function listOzModels() {
  const stdout = await execOz(["model", "list"]);
  let parsed = null;
  try { parsed = JSON.parse(stdout.trim()); } catch {}
  const models = [];
  const seen = new Set();
  for (const m of extractOzItems(parsed)) {
    const id = m && typeof m.id === "string" ? m.id : null;
    if (id && !seen.has(id)) { seen.add(id); models.push(id); }
  }
  const current = process.env.OZ_DEFAULT_MODEL || "auto";
  return { count: models.length, current, recommended: OZ_RECOMMENDED_MODEL, models };
}

// Send a follow-up message to an existing Oz run via the Warp public API. The oz
// CLI has no follow-up subcommand, so this calls POST /agent/runs/{runId}/followups
// directly using WARP_API_KEY (already in process.env). Works for queued, running,
// or ended runs; a 2xx means accepted. Poll oz_run_get / GET /agent/runs/{runId}
// for updated state.
async function submitOzRunFollowup(runId, message) {
  const apiKey = process.env.WARP_API_KEY;
  if (!nonEmptyString(apiKey)) {
    throw new Error("WARP_API_KEY is not configured; cannot call the Oz API directly.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OZ_LIST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${OZ_API_BASE_URL}/agent/runs/${encodeURIComponent(runId)}/followups`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });
    const text = await resp.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch {}
    if (!resp.ok) {
      const detail = parsed ? JSON.stringify(parsed) : (text || "").substring(0, 500);
      throw new Error(`Oz API followup failed: HTTP ${resp.status} ${resp.statusText}${detail ? ` — ${detail}` : ""}`);
    }
    return parsed ?? { accepted: true };
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Oz API followup timed out after ${OZ_LIST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function nonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function toolTextResult(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function missingArgResult(missing) {
  return toolTextResult(
    `Missing required argument(s): ${missing.join(", ")}. ` +
      `Call oz_list_environments for environment ids and oz_list_models for model ids, then pass them explicitly.`,
    true,
  );
}

// Tools the proxy owns: injected (oz_list_environments), reimplemented in-process
// (oz_list_models), or re-described with required args + pre-flight validation
// (oz_agent_run, oz_agent_run_cloud). These override the upstream descriptors.
const PROXY_TOOL_DESCRIPTORS = {
  oz_list_environments: {
    name: "oz_list_environments",
    description:
      "List the Warp Oz cloud environments available to the account (from `oz environment list`). Read-only. Pass one of the returned `id` values as `environment` to `oz_agent_run_cloud`.",
    inputSchema: { type: "object", properties: {} },
  },
  oz_list_models: {
    name: "oz_list_models",
    description:
      "List the AI model ids available to the Warp Oz account (from `oz model list`), reporting the current default and the recommended model. Read-only. Pass one of these ids as `model` to `oz_agent_run` / `oz_agent_run_cloud`; `recommended` is the suggested pick.",
    inputSchema: { type: "object", properties: {} },
  },
  oz_agent_run: {
    name: "oz_agent_run",
    description:
      "Run a Warp Oz agent locally and return its output (`oz agent run`). `model` is required - a model id from `oz_list_models` (e.g. `claude-4-8-opus-max` or `auto`).",
    inputSchema: {
      type: "object",
      required: ["prompt", "model"],
      properties: {
        prompt: { type: "string", description: "Natural-language instruction for the agent." },
        model: { type: "string", description: "Required model id from oz_list_models (e.g. `claude-4-8-opus-max`, `auto`)." },
        profile: { type: "string", description: "Optional Oz agent profile name." },
        skill: { type: "string", description: "Optional agent skill id (e.g. `5-test-agent`)." },
      },
    },
  },
  oz_agent_run_cloud: {
    name: "oz_agent_run_cloud",
    description:
      "Launch a cloud Warp Oz agent. CONSUMES WARP CREDITS. Both `environment` (from `oz_list_environments`) and `model` (from `oz_list_models`) are required. Returns the run id immediately; use `oz_run_get` to poll terminal status.",
    inputSchema: {
      type: "object",
      required: ["prompt", "model", "environment"],
      properties: {
        prompt: { type: "string", description: "Natural-language instruction for the cloud agent." },
        model: { type: "string", description: "Required model id from oz_list_models (e.g. `claude-4-8-opus-max`, `auto`)." },
        environment: { type: "string", description: "Required cloud environment id from oz_list_environments (e.g. `MeFGBLVKN3I6Bo6TrvYiCP`)." },
        skill: { type: "string", description: "Optional agent skill id." },
      },
    },
  },
  oz_run_followup: {
    name: "oz_run_followup",
    description:
      "Send a follow-up message to an existing Oz run. Works whether the run is queued, in progress, or ended (terminated); the server routes the message based on current run state. A success means the follow-up was accepted — poll oz_run_get for updated state. Implemented in-process via the Warp public API and requires WARP_API_KEY.",
    inputSchema: {
      type: "object",
      required: ["runId", "message"],
      properties: {
        runId: { type: "string", description: "The run id to append the follow-up to (the id returned by oz_agent_run_cloud or seen in oz_run_list)." },
        message: { type: "string", description: "The follow-up prompt to send to the run." },
      },
    },
  },
};

function createProxyServer(client) {
  const server = new Server(
    { name: "ozbridge-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // tools/list: drop the upstream descriptors we override, then append ours.
  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    const upstream = await client.listTools(req.params);
    const tools = (upstream.tools || []).filter((t) => !PROXY_TOOL_DESCRIPTORS[t.name]);
    tools.push(...Object.values(PROXY_TOOL_DESCRIPTORS));
    return { tools };
  });

  // tools/call: handle proxy-owned tools in-process; pre-flight validate the run
  // tools; forward everything else to the upstream oz-mcp-server verbatim.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params || {};

    if (name === "oz_list_environments") {
      try { return toolTextResult(JSON.stringify(await listOzEnvironments(), null, 2)); }
      catch (err) { return toolTextResult(`Error listing environments: ${err.message}`, true); }
    }

    if (name === "oz_list_models") {
      try { return toolTextResult(JSON.stringify(await listOzModels(), null, 2)); }
      catch (err) { return toolTextResult(`Error listing models: ${err.message}`, true); }
    }

    if (name === "oz_run_followup") {
      const missing = [];
      if (!nonEmptyString(args.runId)) missing.push("runId");
      if (!nonEmptyString(args.message)) missing.push("message");
      if (missing.length) {
        return toolTextResult(`Missing required argument(s): ${missing.join(", ")}.`, true);
      }
      try {
        const result = await submitOzRunFollowup(args.runId, args.message);
        return toolTextResult(JSON.stringify(result, null, 2));
      } catch (err) {
        return toolTextResult(`Error sending follow-up: ${err.message}`, true);
      }
    }

    if (name === "oz_agent_run") {
      const missing = [];
      if (!nonEmptyString(args.model)) missing.push("model");
      if (missing.length) return missingArgResult(missing);
    }

    if (name === "oz_agent_run_cloud") {
      const missing = [];
      if (!nonEmptyString(args.model)) missing.push("model");
      if (!nonEmptyString(args.environment)) missing.push("environment");
      if (missing.length) return missingArgResult(missing);
    }

    return client.callTool(req.params);
  });

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

// ---- REST listing endpoints (Bearer-authed, handled in-process) ----
// Mirror the oz_list_environments / oz_list_models MCP tools as plain JSON
// GETs. Registered before the catch-all proxy so they are served here instead
// of being forwarded to the internal server (which would 404 on them).
app.get("/environments", checkAuth, async (req, res) => {
  try {
    res.json(await listOzEnvironments());
  } catch (err) {
    res.status(502).json({ error: "oz_environment_list_failed", message: err.message });
  }
});

app.get("/models", checkAuth, async (req, res) => {
  try {
    res.json(await listOzModels());
  } catch (err) {
    res.status(502).json({ error: "oz_model_list_failed", message: err.message });
  }
});

// POST /runs/:runId/followups — send a follow-up message to an existing Oz run via
// the Warp public API (in-process, not proxied to the internal oz-mcp-server).
app.post("/runs/:runId/followups", checkAuth, async (req, res) => {
  const { runId } = req.params;
  const message = req.body?.message;
  if (!nonEmptyString(runId) || !nonEmptyString(message)) {
    return res.status(400).json({ error: "invalid_request", message: "Both `runId` (path) and `message` (JSON body) are required." });
  }
  try {
    res.json(await submitOzRunFollowup(runId, message));
  } catch (err) {
    const status = /timed out/.test(err.message) ? 504 : 502;
    res.status(status).json({ error: "oz_run_followup_failed", message: err.message });
  }
});

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
