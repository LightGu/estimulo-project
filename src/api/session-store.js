const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_STATE_FILE = path.join(process.cwd(), "storage", "sessions.json");
const TOKEN_BYTES = 32; // 256 bits - impraticavel de adivinhar por tentativa e erro

// Sessoes ficam em memoria (Map) e sao persistidas em disco para sobreviver a
// um restart do processo (mesma ideia do antigo access-gate-allowlist.json).
// O token e' opaco e aleatorio: nao precisa ser assinado, ja que so o
// servidor consegue mapear token -> sessao.
function createSessionStore(options = {}) {
  const stateFile =
    options.stateFile === undefined
      ? process.env.ESTIMULO_SESSION_STATE_FILE || DEFAULT_STATE_FILE
      : options.stateFile;
  const sessions = new Map();

  function pruneExpired(now = Date.now()) {
    for (const [token, session] of sessions.entries()) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
  }

  function loadState() {
    if (!stateFile) return;

    try {
      const payload = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const rawSessions = payload && payload.sessions ? payload.sessions : {};
      const now = Date.now();

      Object.entries(rawSessions).forEach(([token, session]) => {
        const expiresAt = Date.parse(session && session.expiresAt);
        if (Number.isFinite(expiresAt) && expiresAt > now) {
          sessions.set(token, {
            userId: session.userId,
            username: session.username,
            expiresAt,
          });
        }
      });
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`Nao foi possivel carregar as sessoes salvas: ${error.message}`);
      }
    }
  }

  function saveState() {
    if (!stateFile) return;

    try {
      pruneExpired();
      const payload = { sessions: {} };

      for (const [token, session] of sessions.entries()) {
        payload.sessions[token] = {
          userId: session.userId,
          username: session.username,
          expiresAt: new Date(session.expiresAt).toISOString(),
        };
      }

      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tempFile = `${stateFile}.tmp`;
      fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`);
      fs.renameSync(tempFile, stateFile);
    } catch (error) {
      console.warn(`Nao foi possivel salvar as sessoes: ${error.message}`);
    }
  }

  function create(user, ttlMs) {
    const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
    const expiresAt = Date.now() + ttlMs;

    sessions.set(token, { userId: user.id, username: user.username, expiresAt });
    saveState();

    return { token, expiresAt };
  }

  function get(token) {
    if (!token) return null;

    pruneExpired();
    return sessions.get(token) || null;
  }

  function destroy(token) {
    if (!token) return;

    sessions.delete(token);
    saveState();
  }

  loadState();

  return { create, get, destroy };
}

module.exports = { createSessionStore };
