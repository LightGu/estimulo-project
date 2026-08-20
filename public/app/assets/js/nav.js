/*
  Builds the left sidebar navigation for every page in public/app.
  Set <body data-page="grupos"> to highlight the matching entry.
  Pure DOM injection (no fetch) so pages also work opened directly via file://.
*/
(function () {
  const LOCAL_API_BASE_URL = "http://127.0.0.1:3000";
  const API_PATH_PREFIXES = [
    "/access",
    "/campaigns",
    "/groups",
    "/health",
    "/notifications",
    "/organizations",
    "/reports",
    "/trilhas",
    "/video-catalog",
  ];

  function isLocalHost(hostname) {
    return ["localhost", "127.0.0.1", "::1"].includes(hostname);
  }

  function isApiPath(pathname) {
    return API_PATH_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    );
  }

  function resolveLocalApiInput(input) {
    if (typeof input !== "string") {
      return input;
    }

    if (!input.startsWith("/")) {
      return input;
    }

    const url = new URL(input, window.location.href);

    if (!isApiPath(url.pathname)) {
      return input;
    }

    const current = window.location;
    const alreadyOnApi = current.protocol.startsWith("http") && isLocalHost(current.hostname) && current.port === "3000";
    const localStaticServer = current.protocol === "file:" || (current.protocol.startsWith("http") && isLocalHost(current.hostname));

    if (alreadyOnApi || !localStaticServer) {
      return input;
    }

    return `${LOCAL_API_BASE_URL}${url.pathname}${url.search}${url.hash}`;
  }

  function installLocalApiFetchFallback() {
    if (window.__estimuloLocalApiFetchFallbackInstalled || typeof window.fetch !== "function") {
      return;
    }

    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const resolvedInput = resolveLocalApiInput(input);
      // Quando a chamada foi redirecionada para a porta da API (dev, painel
      // aberto via file://), o cookie de sessao so viaja se a request pedir
      // credentials explicitamente - sem isso o /access/logout e as chamadas
      // autenticadas nesse modo cairiam sempre como anonimas.
      const crossOrigin = typeof resolvedInput === "string" && resolvedInput !== input;
      const finalOptions = crossOrigin ? { credentials: "include", ...(options || {}) } : options;
      return nativeFetch(resolvedInput, finalOptions);
    };
    window.__estimuloLocalApiFetchFallbackInstalled = true;
  }

  installLocalApiFetchFallback();

  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />',
    groups: '<circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.6" /><path d="M3.5 19c.6-3 3-5 5.5-5s4.9 2 5.5 5" /><path d="M14.7 14.2c2.1.3 3.9 2 4.4 4.6" />',
    orgs: '<path d="M4 21V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v16" /><path d="M14 21v-9a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v9" /><path d="M4 21h16" /><path d="M7 8h1M7 11h1M7 14h1M10 8h1M10 11h1M10 14h1" />',
    trails: '<path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h13" /><circle cx="20" cy="12" r="1.6" /><circle cx="19" cy="18" r="1.6" />',
    campaigns: '<rect x="3" y="5" width="18" height="15" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /><path d="M8 14h3M8 17h6" />',
    auto: '<path d="M5 12 20 4l-3.2 16-5-6-6-2Z" /><circle cx="18.3" cy="5.7" r="3.1" fill="currentColor" stroke="none" />',
    manual: '<path d="M5 12 20 4l-3.2 16-5-6-6-2Z" />',
    monitor: '<path d="M4 19V10M11 19V5M18 19v-6" /><path d="M2 19h20" />',
    settings: '<circle cx="12" cy="12" r="3" /><path d="M19.4 12a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4.9a7.6 7.6 0 0 0-2-1.2L14.5 3h-4l-.4 2.5a7.6 7.6 0 0 0-2 1.2l-2.4-.9-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-.9c.6.5 1.3.9 2 1.2L10.5 21h4l.4-2.5a7.6 7.6 0 0 0 2-1.2l2.4.9 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z" />',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" />',
    megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h2l9 5V5L6 10H4a1 1 0 0 0-1 1Z" /><path d="M15 8.5a4 4 0 0 1 0 7" />',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /><path d="M7.5 14h1M11.5 14h1M15.5 14h1M7.5 17.5h1M11.5 17.5h1" />',
    users: '<circle cx="9" cy="8" r="3" /><path d="M3.5 19c.6-3 3-5 5.5-5s4.9 2 5.5 5" /><path d="M16 4.5a3 3 0 0 1 0 6" /><path d="M15 14.3c2.3.4 4 2.2 4.5 4.7" />',
    audit: '<path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M14 3v5h5" /><path d="M8 12h7M8 15.5h7M8 9h3" />',
    report: '<path d="M5 20V10M11 20V4M17 20v-7" /><path d="M3 20h18" />',
  };

  function icon(name) {
    return `<svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
  }

  const NAV = [
    {
      group: "Visão geral",
      items: [{ key: "dashboard", label: "Painel", href: "index.html", icon: "home" }],
    },
    {
      group: "Cadastros",
      items: [
        { key: "grupos", label: "Grupos", href: "grupos.html", icon: "groups" },
        { key: "organizacoes", label: "Organizações", href: "organizacoes.html", icon: "orgs" },
        { key: "trilhas", label: "Trilhas de conteúdo", href: "trilhas.html", icon: "trails" },
      ],
    },
    {
      group: "Envios",
      items: [
        { key: "envio-automatizado", label: "Envio automatizado", href: "envio-automatizado.html", icon: "auto" },
        { key: "campanhas", label: "Campanhas", href: "campanhas.html", icon: "campaigns" },
        { key: "mensagens", label: "Disparador Pontual", href: "mensagens.html", icon: "megaphone" },
        { key: "calendario", label: "Calendário editorial", href: "calendario.html", icon: "calendar" },
      ],
    },
    {
      group: "Relatórios",
      items: [{ key: "relatorios", label: "Relatório operacional", href: "relatorios.html", icon: "report" }],
    },
    {
      group: "Sistema",
      items: [{ key: "configuracoes", label: "Configurações", href: "configuracoes.html", icon: "settings" }],
    },
  ];

  function render() {
    const activePage = document.body.dataset.page || "";
    const root = document.getElementById("sidebar-root");
    if (!root) return;

    const groupsHtml = NAV.map(
      (group) => `
        <div class="nav-group-label">${group.group}</div>
        <div class="nav-list">
          ${group.items
            .map(
              (item) => `
                <a class="nav-link${item.key === activePage ? " active" : ""}" href="${item.href}">
                  ${icon(item.icon)}
                  <span>${item.label}</span>
                </a>`
            )
            .join("")}
        </div>`
    ).join("");

    root.innerHTML = `
      <a class="sidebar-brand" href="index.html">
        <img src="assets/img/logo-mark.svg" alt="">
        <span>estímulo</span>
      </a>
      ${groupsHtml}
      <div class="sidebar-footer">Estímulo &middot; Painel de Conteúdo<br>São Paulo</div>
    `;
  }

  // ---------- Dark mode toggle ----------
  // Applying data-theme happens as early as possible via the inline snippet in each
  // page's <head> (see THEME_INIT_SNIPPET below) so there's no flash on load; this
  // just injects the button and wires the click once the topbar exists.
  const THEME_KEY = "estimulo-theme";
  const THEME_ICONS = {
    sun: '<circle cx="12" cy="12" r="4.5" /><path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.55 1.55M18.25 18.25l1.55 1.55M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.55-1.55M18.25 5.75l1.55-1.55" />',
    moon: '<path d="M20 14.3A8.1 8.1 0 0 1 9.7 4a6.6 6.6 0 1 0 10.3 10.3Z" />',
  };
  const BELL_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 0 1 12 0c0 4 1.4 5.6 2 6.4a1 1 0 0 1-.8 1.6H4.8a1 1 0 0 1-.8-1.6C4.6 14.6 6 13 6 9Z" /><path d="M9.5 19.5a2.5 2.5 0 0 0 5 0" /></svg>';

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function themeToggleSvg(theme) {
    const iconName = theme === "dark" ? "sun" : "moon";
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${THEME_ICONS[iconName]}</svg>`;
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
      /* localStorage unavailable (e.g. file:// in some browsers) — theme just won't persist */
    }
    const btn = document.getElementById("themeToggleButton");
    if (btn) {
      btn.innerHTML = themeToggleSvg(theme);
      btn.setAttribute("aria-label", theme === "dark" ? "Mudar para tema claro" : "Mudar para tema escuro");
    }
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // Bubble/ripple reveal: expands a circle clip-path from the button outward until it
  // covers the screen, using the View Transitions API (Chrome/Edge). Falls back to the
  // plain CSS color fade (already in base.css) on browsers without support, or when the
  // user prefers reduced motion.
  function toggleThemeWithTransition(event) {
    const newTheme = currentTheme() === "dark" ? "light" : "dark";

    if (!document.startViewTransition || prefersReducedMotion()) {
      applyTheme(newTheme);
      return;
    }

    // Measure the button's live position instead of trusting event.clientX/clientY —
    // synthetic clicks (keyboard activation, some touch/assistive-tech paths) report
    // (0,0) or stale coordinates, which is what made the bubble appear to start from
    // the middle of the screen instead of the button. getBoundingClientRect is always
    // correct for the current viewport, so this also stays right across window/monitor
    // sizes, zoom levels, and the collapsed-sidebar breakpoint.
    const button = event.currentTarget || document.getElementById("themeToggleButton");
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

    const transition = document.startViewTransition(() => applyTheme(newTheme));

    transition.ready
      .then(() => {
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
          { duration: 500, easing: "ease-in-out", pseudoElement: "::view-transition-new(root)" }
        );
      })
      .catch(() => {
        /* transition skipped (e.g. tab hidden mid-click) — theme is already applied above */
      });
  }

  function initThemeToggle() {
    const actions = document.querySelector(".topbar-actions");
    if (!actions || document.getElementById("themeToggleButton")) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "themeToggleButton";
    btn.className = "theme-toggle";
    btn.innerHTML = themeToggleSvg(currentTheme());
    btn.setAttribute("aria-label", currentTheme() === "dark" ? "Mudar para tema claro" : "Mudar para tema escuro");
    btn.addEventListener("click", toggleThemeWithTransition);

    actions.insertBefore(btn, actions.firstChild);
  }

  // ---------- Notification bell (topbar) ----------
  // Shows in-app notifications (e.g. "trilha concluída") next to the user's
  // name. These no longer go to WhatsApp — see src/services/in-app-notifications.service.js.
  const NOTIF_POLL_INTERVAL_MS = 30000;
  let notifPanelEl = null;
  let notifBellButton = null;
  let notifCountEl = null;
  let notifPollTimer = null;

  function formatNotifTime(isoDate) {
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return "";

    return date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function renderNotifList(items) {
    const list = notifPanelEl.querySelector(".notif-panel-list");

    if (!items || !items.length) {
      list.innerHTML = '<div class="notif-panel-empty">Nenhuma notificação por aqui.</div>';
      return;
    }

    list.innerHTML = items
      .map(
        (item) => `
          <div class="notif-item${item.read_at ? "" : " is-unread"}">
            <span class="notif-item-message"></span>
            <span class="notif-item-time"></span>
          </div>`
      )
      .join("");

    list.querySelectorAll(".notif-item").forEach((node, index) => {
      node.querySelector(".notif-item-message").textContent = items[index].message;
      node.querySelector(".notif-item-time").textContent = formatNotifTime(items[index].created_at);
    });
  }

  function setNotifCount(count) {
    const value = Number(count) || 0;
    notifCountEl.textContent = value > 99 ? "99+" : String(value);
    notifCountEl.hidden = value <= 0;
  }

  async function refreshNotifications() {
    try {
      const response = await fetch("/notifications?limit=20");
      const data = await response.json();

      setNotifCount(data && data.unread_count);

      if (notifPanelEl && !notifPanelEl.hidden) {
        renderNotifList(data && data.items);
      }

      return data;
    } catch (error) {
      return null;
    }
  }

  async function openNotifPanel() {
    notifPanelEl.hidden = false;
    const data = await refreshNotifications();
    renderNotifList(data && data.items);

    if (data && data.unread_count > 0) {
      try {
        await fetch("/notifications/read-all", { method: "POST" });
        setNotifCount(0);
      } catch (error) {
        /* mantém o contador atual caso a chamada falhe */
      }
    }
  }

  function closeNotifPanel() {
    if (notifPanelEl) notifPanelEl.hidden = true;
  }

  function toggleNotifPanel() {
    if (!notifPanelEl.hidden) {
      closeNotifPanel();
      return;
    }

    openNotifPanel();
  }

  function ensureNotifPanel(wrap) {
    if (notifPanelEl) return notifPanelEl;

    notifPanelEl = document.createElement("div");
    notifPanelEl.className = "notif-panel";
    notifPanelEl.hidden = true;
    notifPanelEl.innerHTML = `
      <div class="notif-panel-header">
        <h4>Notificações</h4>
        <button type="button" class="notif-panel-mark-all">Marcar todas como lidas</button>
      </div>
      <div class="notif-panel-list"></div>
    `;
    wrap.appendChild(notifPanelEl);

    notifPanelEl.querySelector(".notif-panel-mark-all").addEventListener("click", async () => {
      try {
        await fetch("/notifications/read-all", { method: "POST" });
        setNotifCount(0);
        const data = await refreshNotifications();
        renderNotifList(data && data.items);
      } catch (error) {
        /* ignora falha ao marcar como lida */
      }
    });

    document.addEventListener("click", (event) => {
      if (notifPanelEl.hidden) return;
      if (notifPanelEl.contains(event.target) || notifBellButton.contains(event.target)) return;
      closeNotifPanel();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !notifPanelEl.hidden) closeNotifPanel();
    });

    return notifPanelEl;
  }

  function initNotificationBell() {
    const actions = document.querySelector(".topbar-actions");
    if (!actions || document.getElementById("notifBellButton")) return;

    const wrap = document.createElement("div");
    wrap.className = "notif-bell-wrap";

    notifBellButton = document.createElement("button");
    notifBellButton.type = "button";
    notifBellButton.id = "notifBellButton";
    notifBellButton.className = "notif-bell";
    notifBellButton.setAttribute("aria-label", "Notificações");
    notifBellButton.innerHTML = `${BELL_ICON_SVG}<span class="notif-bell-count" hidden></span>`;
    notifBellButton.addEventListener("click", toggleNotifPanel);

    notifCountEl = notifBellButton.querySelector(".notif-bell-count");

    wrap.appendChild(notifBellButton);
    ensureNotifPanel(wrap);

    const themeButton = document.getElementById("themeToggleButton");
    actions.insertBefore(wrap, themeButton ? themeButton.nextSibling : actions.firstChild);

    refreshNotifications();

    if (notifPollTimer) clearInterval(notifPollTimer);
    notifPollTimer = setInterval(refreshNotifications, NOTIF_POLL_INTERVAL_MS);
  }

  // ---------- Logout button (topbar) ----------
  // Encerra a sessao no servidor (invalida o cookie estimulo_session) e manda
  // o usuario de volta para a tela de login. Fica ao lado do sino/tema em
  // toda pagina que carrega nav.js.
  const LOGOUT_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></svg>';

  async function handleLogoutClick() {
    const button = document.getElementById("logoutButton");
    if (button) button.disabled = true;

    try {
      await fetch("/access/logout", { method: "POST" });
    } catch (error) {
      /* mesmo se a chamada falhar, manda para o login: a sessao pode ja ter expirado */
    }

    window.location.href = "access.html";
  }

  function initLogoutButton() {
    const actions = document.querySelector(".topbar-actions");
    if (!actions || document.getElementById("logoutButton")) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "logoutButton";
    btn.className = "logout-btn";
    btn.setAttribute("aria-label", "Sair");
    btn.title = "Sair";
    btn.innerHTML = LOGOUT_ICON_SVG;
    btn.addEventListener("click", handleLogoutClick);

    actions.appendChild(btn);
  }

  // ---------- User chip (topbar) ----------
  // Loads the current user's display name from /settings/profile and fills
  // in the topbar chip (avatar initials + name) on every page.
  function initialsFor(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);

    if (!parts.length) {
      return "?";
    }

    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }

  function applyUserChipName(name) {
    const chip = document.querySelector(".user-chip");
    if (!chip) return;

    const avatar = chip.querySelector(".avatar");
    if (avatar) avatar.textContent = initialsFor(name);

    chip.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) node.remove();
    });
    chip.appendChild(document.createTextNode(` ${name}`));
  }

  window.estimuloRefreshUserChip = async function estimuloRefreshUserChip() {
    try {
      const response = await fetch("/settings/profile");
      const data = await response.json();
      if (data && data.profile_name) applyUserChipName(data.profile_name);
    } catch (error) {
      /* mantém o nome já exibido no HTML caso a chamada falhe */
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    render();
    initThemeToggle();
    initNotificationBell();
    initLogoutButton();
    window.estimuloRefreshUserChip();
  });

  // ---------- Confirm modal ----------
  // Replaces the native window.confirm() with an in-app modal that matches the
  // rest of the UI (overlay/.modal already styled in components.css), so
  // destructive actions never trigger the browser's own popup.
  let confirmOverlay = null;
  let confirmResolve = null;

  function ensureConfirmModal() {
    if (confirmOverlay) return confirmOverlay;

    confirmOverlay = document.createElement("div");
    confirmOverlay.className = "overlay";
    confirmOverlay.id = "estimuloConfirmOverlay";
    confirmOverlay.hidden = true;
    confirmOverlay.innerHTML = `
      <div class="modal" style="width:min(420px, 100%);" role="alertdialog" aria-modal="true" aria-labelledby="estimuloConfirmTitle">
        <div class="modal-header">
          <h3 id="estimuloConfirmTitle">Confirmar ação</h3>
          <button class="icon-btn-close" type="button" aria-label="Fechar">&times;</button>
        </div>
        <div class="modal-body">
          <p id="estimuloConfirmMessage" style="margin:0;"></p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" type="button" data-action="cancel">Cancelar</button>
          <button class="btn btn-danger" type="button" data-action="confirm">Confirmar</button>
        </div>
      </div>
    `;
    document.body.appendChild(confirmOverlay);

    const settle = (result) => {
      confirmOverlay.hidden = true;
      if (confirmResolve) {
        const resolve = confirmResolve;
        confirmResolve = null;
        resolve(result);
      }
    };

    confirmOverlay.querySelector('[data-action="cancel"]').addEventListener("click", () => settle(false));
    confirmOverlay.querySelector('[data-action="confirm"]').addEventListener("click", () => settle(true));
    confirmOverlay.querySelector(".icon-btn-close").addEventListener("click", () => settle(false));
    confirmOverlay.addEventListener("click", (event) => {
      if (event.target === confirmOverlay) settle(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !confirmOverlay.hidden) settle(false);
    });

    return confirmOverlay;
  }

  // Usage: const ok = await window.estimuloConfirm("Remover este item?");
  window.estimuloConfirm = function estimuloConfirm(message, options) {
    const overlay = ensureConfirmModal();
    const opts = options || {};
    overlay.querySelector("#estimuloConfirmMessage").textContent = message || "Tem certeza?";
    overlay.querySelector("#estimuloConfirmTitle").textContent = opts.title || "Confirmar ação";
    overlay.querySelector('[data-action="confirm"]').textContent = opts.confirmLabel || "Confirmar";
    overlay.querySelector('[data-action="cancel"]').textContent = opts.cancelLabel || "Cancelar";

    return new Promise((resolve) => {
      confirmResolve = resolve;
      overlay.hidden = false;
      overlay.querySelector('[data-action="confirm"]').focus();
    });
  };

  // ---------- Alert modal ----------
  // Replaces window.alert() so informational/error messages also render as an
  // in-app modal instead of the browser's own popup.
  let alertOverlay = null;
  let alertResolve = null;

  function ensureAlertModal() {
    if (alertOverlay) return alertOverlay;

    alertOverlay = document.createElement("div");
    alertOverlay.className = "overlay";
    alertOverlay.id = "estimuloAlertOverlay";
    alertOverlay.hidden = true;
    alertOverlay.innerHTML = `
      <div class="modal" style="width:min(420px, 100%);" role="alertdialog" aria-modal="true" aria-labelledby="estimuloAlertTitle">
        <div class="modal-header">
          <h3 id="estimuloAlertTitle">Aviso</h3>
          <button class="icon-btn-close" type="button" aria-label="Fechar">&times;</button>
        </div>
        <div class="modal-body">
          <p id="estimuloAlertMessage" style="margin:0;"></p>
        </div>
        <div class="modal-footer">
          <button class="btn" type="button" data-action="ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(alertOverlay);

    const settle = () => {
      alertOverlay.hidden = true;
      if (alertResolve) {
        const resolve = alertResolve;
        alertResolve = null;
        resolve();
      }
    };

    alertOverlay.querySelector('[data-action="ok"]').addEventListener("click", settle);
    alertOverlay.querySelector(".icon-btn-close").addEventListener("click", settle);
    alertOverlay.addEventListener("click", (event) => {
      if (event.target === alertOverlay) settle();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !alertOverlay.hidden) settle();
    });

    return alertOverlay;
  }

  // Usage: await window.estimuloAlert("Algo deu errado.");
  window.estimuloAlert = function estimuloAlert(message, options) {
    const overlay = ensureAlertModal();
    const opts = options || {};
    overlay.querySelector("#estimuloAlertMessage").textContent = message || "";
    overlay.querySelector("#estimuloAlertTitle").textContent = opts.title || "Aviso";

    return new Promise((resolve) => {
      alertResolve = resolve;
      overlay.hidden = false;
      overlay.querySelector('[data-action="ok"]').focus();
    });
  };

  // ---------- Prompt modal ----------
  // Replaces window.prompt() with an in-app modal with a text field.
  let promptOverlay = null;
  let promptResolve = null;

  function ensurePromptModal() {
    if (promptOverlay) return promptOverlay;

    promptOverlay = document.createElement("div");
    promptOverlay.className = "overlay";
    promptOverlay.id = "estimuloPromptOverlay";
    promptOverlay.hidden = true;
    promptOverlay.innerHTML = `
      <div class="modal" style="width:min(420px, 100%);" role="dialog" aria-modal="true" aria-labelledby="estimuloPromptTitle">
        <div class="modal-header">
          <h3 id="estimuloPromptTitle">Informe um valor</h3>
          <button class="icon-btn-close" type="button" aria-label="Fechar">&times;</button>
        </div>
        <div class="modal-body">
          <p id="estimuloPromptMessage" style="margin:0;"></p>
          <input id="estimuloPromptInput" type="text">
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" type="button" data-action="cancel">Cancelar</button>
          <button class="btn" type="button" data-action="ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(promptOverlay);

    const input = promptOverlay.querySelector("#estimuloPromptInput");

    const settle = (result) => {
      promptOverlay.hidden = true;
      if (promptResolve) {
        const resolve = promptResolve;
        promptResolve = null;
        resolve(result);
      }
    };

    promptOverlay.querySelector('[data-action="cancel"]').addEventListener("click", () => settle(null));
    promptOverlay.querySelector('[data-action="ok"]').addEventListener("click", () => settle(input.value.trim() || null));
    promptOverlay.querySelector(".icon-btn-close").addEventListener("click", () => settle(null));
    promptOverlay.addEventListener("click", (event) => {
      if (event.target === promptOverlay) settle(null);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") settle(input.value.trim() || null);
      if (event.key === "Escape") settle(null);
    });

    return promptOverlay;
  }

  // Usage: const value = await window.estimuloPrompt("Nome da instância:");
  window.estimuloPrompt = function estimuloPrompt(message, options) {
    const overlay = ensurePromptModal();
    const opts = options || {};
    const input = overlay.querySelector("#estimuloPromptInput");
    overlay.querySelector("#estimuloPromptMessage").textContent = message || "";
    overlay.querySelector("#estimuloPromptTitle").textContent = opts.title || "Informe um valor";
    input.value = opts.defaultValue || "";
    input.placeholder = opts.placeholder || "";

    return new Promise((resolve) => {
      promptResolve = resolve;
      overlay.hidden = false;
      overlay.querySelector('[data-action="ok"]').focus();
      input.focus();
    });
  };
})();
