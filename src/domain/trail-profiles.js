const TRAIL_PROFILES = ["Pré-infância", "Infância", "Adolescência", "Maturidade"];

function normalizePerfis(rawPerfis, { required = true } = {}) {
  const perfis = Array.isArray(rawPerfis)
    ? Array.from(new Set(rawPerfis.map((perfil) => String(perfil || "").trim()).filter(Boolean)))
    : [];

  if (required && !perfis.length) {
    throw new Error("At least one perfil is required");
  }

  const invalid = perfis.find((perfil) => !TRAIL_PROFILES.includes(perfil));

  if (invalid) {
    throw new Error(`Invalid perfil: ${invalid}`);
  }

  return perfis;
}

module.exports = { TRAIL_PROFILES, normalizePerfis };
