/*
  Builds the left sidebar navigation for every page in public/app.
  Set <body data-page="grupos"> to highlight the matching entry.
  Pure DOM injection (no fetch) so pages also work opened directly via file://.
*/
(function () {
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
        { key: "envio-manual", label: "Envio manual", href: "envio-manual.html", icon: "manual" },
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
      <div class="sidebar-env-tag">Protótipo de interface — dados de exemplo, sem integração com a API ainda.</div>
      ${groupsHtml}
      <div class="sidebar-footer">Estímulo &middot; Painel de Conteúdo<br>São Paulo</div>
    `;
  }

  document.addEventListener("DOMContentLoaded", render);
})();
