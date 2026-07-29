/*
  Funções pequenas compartilhadas entre páginas do protótipo (carregar depois de mock-data.js).
*/
function trailByName(nome) {
  return MOCK.trails.find((t) => t.nome === nome) || null;
}

function trilhaShortName(nome) {
  const trail = trailByName(nome);
  if (!trail) return nome;
  const prefix = `${trail.perfil} - `;
  return trail.nome.startsWith(prefix) ? trail.nome.slice(prefix.length) : trail.nome;
}

function perfilForTrilha(nome) {
  const trail = trailByName(nome);
  return trail ? trail.perfil : "";
}

function campaignStatusLabel(status) {
  return status === "concluida" ? "Concluído" : "Programado";
}

function campaignStatusBadgeClass(status) {
  return status === "concluida" ? "badge-success" : "badge-info";
}
