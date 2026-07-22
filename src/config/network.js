const LOOPBACK_DISCARD_PROXY_PATTERN = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):9\/?$/i;
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];

function clearLoopbackDiscardProxyEnv(env = process.env, options = {}) {
  const cleared = [];

  for (const key of PROXY_ENV_KEYS) {
    const value = env[key];

    if (typeof value === "string" && LOOPBACK_DISCARD_PROXY_PATTERN.test(value.trim())) {
      delete env[key];
      cleared.push(key);
    }
  }

  if (cleared.length && options.logger && typeof options.logger.warn === "function") {
    options.logger.warn(
      `Proxy local invalido removido do processo Node: ${cleared.join(", ")}`
    );
  }

  return cleared;
}

module.exports = {
  clearLoopbackDiscardProxyEnv,
};
