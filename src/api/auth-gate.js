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
  // Cookie Secure exige HTTPS - sem isso o navegador nunca guarda o cookie.
  // ESTIMULO_COOKIE_SECURE deixa forcar o valor (ex.: "false" para testar por
  // IP puro em HTTP antes de configurar dominio/TLS); sem essa variavel, cai
  // no padrao de sempre marcar Secure em producao.
  const secureCookie =
    options.secureCookie === undefined
      ? process.env.ESTIMULO_COOKIE_SECURE !== undefined
        ? process.env.ESTIMULO_COOKIE_SECURE === "true"
        : process.env.NODE_ENV === "production"
      : Boolean(options.secureCookie);
  // SameSite so aceita valores validos. "None" e' o unico que expoe o cookie a
  // requests cross-site, e o navegador ja o rejeita sem Secure; aceitar um
  // "None" sem Secure produziria um painel silenciosamente sem login. Qualquer
  // valor invalido cai em Lax, que e' o padrao seguro.
  const requestedSameSite = String(process.env.ESTIMULO_COOKIE_SAME_SITE || "Lax").trim();
  const sameSite = (() => {
    const normalized = requestedSameSite.toLowerCase();

    if (normalized === "strict") return "Strict";
    if (normalized === "none") {
      if (secureCookie) return "None";
      console.warn(
        "ESTIMULO_COOKIE_SAME_SITE=None exige cookie Secure (HTTPS); usando Lax para o cookie nao ser descartado."
      );
      return "Lax";
    }
    if (normalized !== "lax") {
      console.warn(`ESTIMULO_COOKIE_SAME_SITE invalido ("${requestedSameSite}"); usando Lax.`);
    }

    return "Lax";
  })();
  const sessionStore = options.sessionStore || createSessionStore(options.sessionStoreOptions || {});
  const rateLimiter = options.rateLimiter || createLoginRateLimiter(options.rateLimiterOptions || {});
  // Limitador separado do de login: as rotas de senha mestra tem sua propria
  // contagem, para uma tentativa de login errada nao bloquear o cadastro (e
  // vice-versa) e para os testes poderem afinar um sem mexer no outro.
  const masterPasswordLimiter =
    options.masterPasswordRateLimiter ||
    createLoginRateLimiter(options.masterPasswordRateLimiterOptions || {});

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
      (requestPath === "/" ||
        requestPath === "/app" ||
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
      const requestedPath = req.originalUrl || "/app/index.html";
      // "/" nao existe como arquivo estatico (so /app/*) - manda direto para
      // a home do painel em vez de guardar "/" como next e cair num 404 apos
      // o login.
      const nextPath = requestedPath === "/" ? "/app/index.html" : requestedPath;
      res.redirect(302, `/app/access.html?next=${encodeURIComponent(nextPath)}`);
      return;
    }

    res.status(401).json({
      error: "Acesso bloqueado. Faca login para continuar.",
      code: "ACCESS_REQUIRED",
    });
  }

  // POST /access/register e' publico de proposito (auto-cadastro sabendo a senha
  // mestra), mas sem limite de tentativas a senha mestra - um unico segredo
  // compartilhado - podia ser varrida por forca bruta na velocidade da rede, e
  // acertar da acesso total ao painel, inclusive ao disparo para os grupos.
  // Este guard aplica ao endpoint a mesma politica exponencial do login.
  function masterPasswordGuard(req, res, next) {
    if (!enabled) {
      next();
      return;
    }

    const key = `master:${getClientIp(req)}`;
    const status = masterPasswordLimiter.check(key);

    if (status.blocked) {
      const retryAfterSeconds = Math.ceil((status.retryAfterMs || 0) / 1000);
      res.set("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: "Muitas tentativas. Aguarde antes de tentar novamente.",
        code: "TOO_MANY_ATTEMPTS",
        retry_after_seconds: retryAfterSeconds,
      });
      return;
    }

    // O acerto/erro da senha mestra so e' conhecido depois que o controller
    // responde (403 = senha errada), dai a contagem acontecer no finish.
    res.on("finish", () => {
      if (res.statusCode === 403) {
        masterPasswordLimiter.registerFailure(key);
      } else if (res.statusCode >= 200 && res.statusCode < 300) {
        masterPasswordLimiter.registerSuccess(key);
      }
    });

    next();
  }

  return {
    enabled,
    statusHandler,
    loginHandler,
    logoutHandler,
    masterPasswordGuard,
    middleware,
  };
}

module.exports = { createAuthGate };
