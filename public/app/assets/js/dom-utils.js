/*
  Utilitarios de DOM compartilhados pelas telas do painel.

  escapeHtml estava duplicado em 10 paginas: sete copias byte-a-byte iguais,
  mais uma variante em relatorios.html (mesma saida, escrita com mapa de regex),
  uma em grupos.html apoiada no helper local `text()` e ainda um clone chamado
  `escapeHtmlNotify` dentro de configuracoes.html, que ja tinha `escapeHtml` no
  mesmo arquivo. Manter uma unica implementacao evita que uma correcao de
  escaping seja aplicada em nove lugares e esquecida no decimo.

  Carregado antes de nav.js em todas as paginas, entao esta disponivel como
  global tanto para o script inline de cada tela quanto para nav.js.
*/
(function () {
  "use strict";

  var HTML_ENTITIES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  // null/undefined viram string vazia (e nao "null"/"undefined"), que e' o que
  // todas as copias anteriores faziam.
  function escapeHtml(value) {
    if (value === null || value === undefined) return "";

    return String(value).replace(/[&<>"']/g, function (char) {
      return HTML_ENTITIES[char];
    });
  }

  window.escapeHtml = escapeHtml;
})();
