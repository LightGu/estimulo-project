const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 minutos para acumular tentativas
const DEFAULT_BASE_LOCK_MS = 30 * 1000; // primeiro bloqueio: 30s
const DEFAULT_MAX_LOCK_MS = 30 * 60 * 1000; // bloqueio maximo: 30min

// Protege /access/login contra forca bruta sem depender de biblioteca externa.
// Cada "chave" (tipicamente o IP do cliente, e tambem o username tentado)
// acumula falhas dentro de uma janela; ao atingir o limite, a chave fica
// bloqueada por um tempo que dobra a cada novo bloqueio (ate um teto), o que
// torna varrer senhas por tentativa e erro impraticavel mesmo sabendo um
// usuario valido.
function createLoginRateLimiter(options = {}) {
  const maxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const windowMs = options.windowMs || DEFAULT_WINDOW_MS;
  const baseLockMs = options.baseLockMs || DEFAULT_BASE_LOCK_MS;
  const maxLockMs = options.maxLockMs || DEFAULT_MAX_LOCK_MS;
  const buckets = new Map();

  function prune(now = Date.now()) {
    for (const [key, bucket] of buckets.entries()) {
      const stillLocked = bucket.lockedUntil && bucket.lockedUntil > now;
      const withinWindow = now - bucket.firstFailureAt <= windowMs;

      if (!stillLocked && !withinWindow) {
        buckets.delete(key);
      }
    }
  }

  function check(key) {
    prune();
    const bucket = buckets.get(key);
    if (!bucket) return { blocked: false };

    const now = Date.now();
    if (bucket.lockedUntil && bucket.lockedUntil > now) {
      return { blocked: true, retryAfterMs: bucket.lockedUntil - now };
    }

    return { blocked: false };
  }

  function registerFailure(key) {
    if (!key) return;

    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || now - bucket.firstFailureAt > windowMs) {
      bucket = { failures: 0, firstFailureAt: now, lockedUntil: 0, lockCount: 0 };
    }

    bucket.failures += 1;

    if (bucket.failures >= maxAttempts) {
      const lockMs = Math.min(baseLockMs * 2 ** bucket.lockCount, maxLockMs);
      bucket.lockedUntil = now + lockMs;
      bucket.lockCount += 1;
      bucket.failures = 0;
      bucket.firstFailureAt = now;
    }

    buckets.set(key, bucket);
  }

  function registerSuccess(key) {
    if (!key) return;
    buckets.delete(key);
  }

  return { check, registerFailure, registerSuccess };
}

module.exports = { createLoginRateLimiter };
