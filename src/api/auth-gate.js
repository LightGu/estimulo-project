const path = require("node:path");

const authServiceDefault = require("../services/auth.service");
const { createSessionStore } = require("./session-store");
const { createLoginRateLimiter } = require("./login-rate-limiter");

const DEFAULT_SESSION_TTL_HOURS = 24 * 7; // 7 dias
const COOKIE_NAME = "estimulo_session";

function parseTtlMs(value, fallbackHours) {
  const hours = Number(value);
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : fallbackHours;
  return safeHours * 60 * 60 * 1000;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;

  header.split(";").forEach((pair) => {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex === -1) return;

    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (!key) return;

    try {
      cookies[key] = decodeURIComponent(value);
    } catch (error) {
      cookies[key] = value;
    }
  });

  return cookies;
}

function buildSetCookie(name, value, { maxAgeSeconds, secure, sameSite = "Lax", clear } = {}) {
  const segments = [`${name}=${clear ? "" : encodeURIComponent(value)}`];
  segments.push("Path=/");
  segments.push("HttpOnly");
  segments.push(`SameSite=${sameSite}`);
  if (secure) segments.push("Secure");
  segments.push(clear ? "Max-Age=0" : `Max-Age=${maxAgeSeconds}`);

  return segments.join("; ");
}

// Substitui o antigo access-gate (senha unica compartilhada + liberacao por
// IP) por login individual: cada usuario tem sua conta na tabela app_users
// (Supabase) e, ao autenticar, recebe um cookie de sessao HttpOnly com um
// token aleatorio de 256 bits. Sem esse cookie valido, nenhuma pagina do
// painel nem endpoint da API responde com dados - so a propria tela de login
// e os assets dela ficam publicos.
function createAuthGate(options = {}) {
  const enabled = options.enabled === undefined ? true : Boolean(options.enabled);
  const authService = options.authService || authServiceDefault;
  const ttlMs =
    options.ttlMs === undefined
      ? parseTtlMs(process.env.ESTIMULO_SESSION_TTL_HOURS, DEFAULT_SESSION_TTL_HOURS)
      : options.ttlMs;
  const cookieName = options.cookieName || COOKIE_NAME;
  const secureCookie =
    options.secureCookie === undefined ? process.env.NODE_ENV === "production" : Boolean(options.secureCookie);
  const sameSite = String(process.env.ESTIMULO_COOKIE_SAME_SITE || "Lax").trim();
  const sessionStore = options.sessionStore || createSessionStore(options.sessionStoreOptions || {});
  const rateLimiter = options.rateLimiter || createLoginRateLimiter(options.rateLimiterOptions || {});

  function getClientIp(req) {
    const forwardedFor = req.headers["x-forwarded-for"];
    const forwardedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    const firstForwardedIp = forwardedIp ? forwardedIp.split(",")[0].trim() : "";
    return req.ip || firstForwardedIp || req.socket.remoteAddress || "unknown";
  }

  function getSession(req) {
    const cookies = parseCookies(req);
    const token = cookies[cookieName];
    if (!token) return null;

    const session = sessionStore.get(token);
    return session ? { ...session, token } : null;
  }

  function isPublicPath(req) {
    const requestPath = req.path || "";

    return (
      requestPath === "/health" ||
      requestPath === "/access/status" ||
      requestPath === "/access/login" ||
      requestPath === "/access/logout" ||
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
    res.set("Cache-Control", "no-store");

    if (!enabled) {
      res.json({ required: false, authorized: true, username: null, expires_at: null });
      return;
    }

    const session = getSession(req);
    res.json({
      required: true,
      authorized: Boolean(session),
      username: session ? session.username : null,
      expires_at: session ? new Date(session.expiresAt).toISOString() : null,
    });
  }

  async function loginHandler(req, res) {
    res.set("Cache-Control", "no-store");

    if (!enabled) {
      res.json({ authorized: true, required: false });
      return;
    }

    const ip = getClientIp(req);
    const username = String((req.body && req.body.username) || "")
      .trim()
      .toLowerCase();
    const password = (req.body && req.body.password) || "";
    const usernameKey = username ? `user:${username}` : null;

    const ipCheck = rateLimiter.check(ip);
    const userCheck = usernameKey ? rateLimiter.check(usernameKey) : { blocked: false };

    if (ipCheck.blocked || userCheck.blocked) {
      const retryAfterMs = Math.max(ipCheck.retryAfterMs || 0, userCheck.retryAfterMs || 0);
      res.set("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
      res.status(429).json({
        error: "Muitas tentativas. Aguarde antes de tentar novamente.",
        code: "TOO_MANY_ATTEMPTS",
        retry_after_seconds: Math.ceil(retryAfterMs / 1000),
      });
      return;
    }

    if (!username || !password) {
      rateLimiter.registerFailure(ip);
      if (usernameKey) rateLimiter.registerFailure(usernameKey);
      res.status(401).json({ error: "Informe usuario e senha." });
      return;
    }

    let user;
    try {
      user = await authService.authenticate({ username, password });
    } catch (error) {
      console.error(`Falha ao validar credenciais de login: ${error.message}`);
      res.status(500).json({ error: "Falha ao validar credenciais." });
      return;
    }

    if (!user) {
      rateLimiter.registerFailure(ip);
      if (usernameKey) rateLimiter.registerFailure(usernameKey);
      res.status(401).json({ error: "Usuario ou senha incorretos." });
      return;
    }

    rateLimiter.registerSuccess(ip);
    if (usernameKey) rateLimiter.registerSuccess(usernameKey);

    const { token, expiresAt } = sessionStore.create(user, ttlMs);
    res.set(
      "Set-Cookie",
      buildSetCookie(cookieName, token, {
        maxAgeSeconds: Math.floor(ttlMs / 1000),
        secure: secureCookie,
        sameSite,
      })
    );
    res.json({
      authorized: true,
      required: true,
      username: user.username,
      expires_at: new Date(expiresAt).toISOString(),
    });
  }

  function logoutHandler(req, res) {
    res.set("Cache-Control", "no-store");

    if (enabled) {
      const cookies = parseCookies(req);
      const token = cookies[cookieName];
      if (token) sessionStore.destroy(token);
    }

    res.set("Set-Cookie", buildSetCookie(cookieName, "", { clear: true, secure: secureCookie, sameSite }));
    res.json({ authorized: false });
  }

  function middleware(req, res, next) {
    if (!enabled || isPublicPath(req)) {
      next();
      return;
    }

    const session = getSession(req);
    if (session) {
      req.user = { id: session.userId, username: session.username };
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
      error: "Acesso bloqueado. Faca login para continuar.",
      code: "ACCESS_REQUIRED",
    });
  }

  return {
    enabled,
    statusHandler,
    loginHandler,
    logoutHandler,
    middleware,
  };
}

module.exports = { createAuthGate };
