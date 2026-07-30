const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TTL_HOURS = 24 * 30;
const DEFAULT_STATE_FILE = path.join(process.cwd(), "storage", "access-gate-allowlist.json");

function normalizeIp(value) {
  const ip = String(value || "").trim();

  if (!ip) return "";
  if (ip.startsWith("::ffff:")) return ip.slice("::ffff:".length);
  if (ip === "::1") return "127.0.0.1";

  return ip;
}

function parseTtlMs(value) {
  const ttlHours = Number(value);
  const safeTtlHours = Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : DEFAULT_TTL_HOURS;
  return safeTtlHours * 60 * 60 * 1000;
}

function passwordMatches(expectedPassword, candidatePassword) {
  const expectedHash = crypto.createHash("sha256").update(String(expectedPassword)).digest();
  const candidateHash = crypto.createHash("sha256").update(String(candidatePassword || "")).digest();
  return crypto.timingSafeEqual(expectedHash, candidateHash);
}

function createAccessGate(options = {}) {
  const password =
    options.password === undefined ? process.env.ESTIMULO_ACCESS_PASSWORD : options.password;
  const enabled = Boolean(password);
  const ttlMs =
    options.ttlMs === undefined ? parseTtlMs(process.env.ESTIMULO_ACCESS_TTL_HOURS) : options.ttlMs;
  const stateFile =
    options.stateFile === undefined
      ? process.env.ESTIMULO_ACCESS_STATE_FILE || DEFAULT_STATE_FILE
      : options.stateFile;
  const allowedIps = new Map();

  function pruneExpired(now = Date.now()) {
    for (const [ip, expiresAt] of allowedIps.entries()) {
      if (expiresAt <= now) allowedIps.delete(ip);
    }
  }

  function loadState() {
    if (!stateFile) return;

    try {
      const payload = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const ips = payload && payload.ips ? payload.ips : {};
      const now = Date.now();

      Object.entries(ips).forEach(([ip, expiresAt]) => {
        const timestamp = Date.parse(expiresAt);
        if (Number.isFinite(timestamp) && timestamp > now) {
          allowedIps.set(normalizeIp(ip), timestamp);
        }
      });
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`Nao foi possivel carregar a lista de IPs liberados: ${error.message}`);
      }
    }
  }

  function saveState() {
    if (!stateFile) return;

    try {
      pruneExpired();
      const ips = {};

      for (const [ip, expiresAt] of allowedIps.entries()) {
        ips[ip] = new Date(expiresAt).toISOString();
      }

      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tempFile = `${stateFile}.tmp`;
      fs.writeFileSync(tempFile, `${JSON.stringify({ ips }, null, 2)}\n`);
      fs.renameSync(tempFile, stateFile);
    } catch (error) {
      console.warn(`Nao foi possivel salvar a lista de IPs liberados: ${error.message}`);
    }
  }

  function getClientIp(req) {
    const forwardedFor = req.headers["x-forwarded-for"];
    const forwardedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    const firstForwardedIp = forwardedIp ? forwardedIp.split(",")[0] : "";
    return normalizeIp(req.ip || firstForwardedIp || req.socket.remoteAddress);
  }

  function getAuthorization(req) {
    if (!enabled) {
      return { authorized: true, ip: getClientIp(req), expiresAt: null };
    }

    pruneExpired();
    const ip = getClientIp(req);
    const expiresAt = allowedIps.get(ip) || null;

    return { authorized: Boolean(expiresAt), ip, expiresAt };
  }

  function allowClient(req) {
    const ip = getClientIp(req);
    const expiresAt = Date.now() + ttlMs;
    allowedIps.set(ip, expiresAt);
    saveState();
    return { ip, expiresAt };
  }

  function isPublicPath(req) {
    const requestPath = req.path || "";

    return (
      requestPath === "/health" ||
      requestPath === "/access/status" ||
      requestPath === "/access/login" ||
      requestPath === "/app/access.html" ||
      requestPath.startsWith("/app/assets/") ||
      requestPath === "/favicon.ico"
    );
  }

  function isAppPageRequest(req) {
    const requestPath = req.path || "";

    return (
      req.method === "GET" &&
      (requestPath === "/app" ||
        requestPath === "/app/" ||
        (requestPath.startsWith("/app/") && (requestPath.endsWith(".html") || !path.extname(requestPath))))
    );
  }

  function statusHandler(req, res) {
    const authorization = getAuthorization(req);

    res.set("Cache-Control", "no-store");
    res.json({
      required: enabled,
      authorized: authorization.authorized,
      ip: authorization.ip,
      expires_at: authorization.expiresAt ? new Date(authorization.expiresAt).toISOString() : null,
    });
  }

  function loginHandler(req, res) {
    res.set("Cache-Control", "no-store");

    if (!enabled) {
      res.json({ authorized: true, required: false });
      return;
    }

    if (!passwordMatches(password, req.body && req.body.password)) {
      res.status(401).json({ error: "Senha incorreta" });
      return;
    }

    const authorization = allowClient(req);
    res.json({
      authorized: true,
      required: true,
      ip: authorization.ip,
      expires_at: new Date(authorization.expiresAt).toISOString(),
    });
  }

  function middleware(req, res, next) {
    if (isPublicPath(req)) {
      next();
      return;
    }

    const authorization = getAuthorization(req);
    if (authorization.authorized) {
      next();
      return;
    }

    res.set("Cache-Control", "no-store");

    if (isAppPageRequest(req)) {
      const nextPath = req.originalUrl || "/app/index.html";
      res.redirect(302, `/app/access.html?next=${encodeURIComponent(nextPath)}`);
      return;
    }

    res.status(401).json({
      error: "Acesso bloqueado. Informe a senha para liberar este IP.",
      code: "ACCESS_REQUIRED",
    });
  }

  loadState();

  return {
    enabled,
    statusHandler,
    loginHandler,
    middleware,
    getClientIp,
  };
}

module.exports = {
  createAccessGate,
  normalizeIp,
};
