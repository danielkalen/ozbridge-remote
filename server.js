import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { randomUUID, createHash } from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT ?? "3847", 10);
const INTERNAL_PORT = 3848;
const BASE_URL = process.env.BASE_URL;

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
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp"],
    client_id_metadata_document_supported: true,
  });
});

app.get("/authorize", (req, res) => {
  const { response_type, redirect_uri, code_challenge, code_challenge_method, state } = req.query;
  if (response_type !== "code") return res.status(400).json({ error: "unsupported_response_type" });

  const allowed = "https://claude.ai/api/mcp/auth_callback";
  if (redirect_uri !== allowed) {
    return res.status(400).json({ error: "invalid_request", error_description: "Invalid redirect_uri" });
  }

  const code = randomUUID();
  const token = randomUUID();
  codes.set(code, {
    token, redirect_uri, code_challenge: code_challenge || null, code_challenge_method: code_challenge_method || null,
    expires: Date.now() + 10 * 60 * 1000,
  });

  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.post("/token", (req, res) => {
  const { grant_type, code, redirect_uri, code_verifier } = req.body;

  if (grant_type === "refresh_token") {
    const token = randomUUID();
    tokens.set(token, { expires: Date.now() + 3600 * 1000, scope: "mcp" });
    return res.json({ access_token: token, token_type: "Bearer", expires_in: 3600, refresh_token: randomUUID(), scope: "mcp" });
  }

  if (grant_type !== "authorization_code") return res.status(400).json({ error: "unsupported_grant_type" });

  const cd = codes.get(code);
  if (!cd || cd.expires < Date.now()) return res.status(400).json({ error: "invalid_grant" });
  codes.delete(code);

  if (cd.redirect_uri && cd.redirect_uri !== redirect_uri) return res.status(400).json({ error: "invalid_grant" });

  if (cd.code_challenge && cd.code_challenge_method === "S256") {
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
