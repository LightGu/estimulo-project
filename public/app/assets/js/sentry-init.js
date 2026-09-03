/*
  Liga o Sentry no navegador: captura erro de JS nao tratado e, quando ocorre
  um erro, grava um Session Replay (DOM da tela, sem audio/video) dos passos
  que levaram ate ele - e' o que resolve o operador "nao saber descrever o que
  fez" antes do bug aparecer. Sem SENTRY_DSN configurado no backend
  (GET /config/sentry devolve enabled:false), este arquivo nao faz nada.

  Carregado o mais cedo possivel no <head> de toda pagina (antes de nav.js),
  entao os helpers abaixo ja existem quando o resto do app roda - mesmo antes
  do SDK terminar de carregar (fetch da config + bundle da CDN sao
  assincronos), erro reportado nesse meio-tempo fica na fila e e' enviado
  assim que o Sentry.init terminar.
*/
(function () {
  const SENTRY_BUNDLE_URL = "https://browser.sentry-cdn.com/10.73.0/bundle.tracing.replay.min.js";

  const pendingExceptions = [];
  const pendingUser = { value: undefined, set: false };
  let sentryReady = false;

  // Usage: window.estimuloCaptureError(error, { tags: {...}, extra: {...} });
  window.estimuloCaptureError = function estimuloCaptureError(error, context) {
    if (sentryReady && window.Sentry) {
      window.Sentry.captureException(error, context);
      return;
    }

    pendingExceptions.push({ error, context });
  };

  // Usage: window.estimuloSentrySetUser({ username: "..." });
  window.estimuloSentrySetUser = function estimuloSentrySetUser(user) {
    if (sentryReady && window.Sentry) {
      window.Sentry.setUser(user);
      return;
    }

    pendingUser.value = user;
    pendingUser.set = true;
  };

  function flushPending() {
    pendingExceptions.splice(0).forEach(({ error, context }) => {
      window.Sentry.captureException(error, context);
    });

    if (pendingUser.set) {
      window.Sentry.setUser(pendingUser.value);
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.crossOrigin = "anonymous";
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Falha ao carregar ${src}`));
      document.head.appendChild(script);
    });
  }

  fetch("/config/sentry", { cache: "no-store" })
    .then((response) => response.json())
    .then((config) => {
      if (!config || !config.enabled || !config.dsn) return null;

      return loadScript(SENTRY_BUNDLE_URL).then(() => {
        window.Sentry.init({
          dsn: config.dsn,
          environment: config.environment,
          tracesSampleRate: config.tracesSampleRate,
          replaysSessionSampleRate: config.replaysSessionSampleRate,
          replaysOnErrorSampleRate: config.replaysOnErrorSampleRate,
          integrations: [window.Sentry.browserTracingIntegration(), window.Sentry.replayIntegration()],
        });

        sentryReady = true;
        flushPending();
      });
    })
    .catch(() => {
      /* painel segue funcionando normalmente sem Sentry (config indisponivel, CDN bloqueada etc) */
    });
})();
