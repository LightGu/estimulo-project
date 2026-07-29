function normalizePerfis(rawPerfis, { required = true, validPerfis } = {}) {
  const perfis = Array.isArray(rawPerfis)
    ? Array.from(new Set(rawPerfis.map((perfil) => String(perfil || "").trim()).filter(Boolean)))
    : [];

  if (required && !perfis.length) {
    throw new Error("At least one perfil is required");
  }

  if (Array.isArray(validPerfis)) {
    const invalid = perfis.find((perfil) => !validPerfis.includes(perfil));

    if (invalid) {
      throw new Error(`Invalid perfil: ${invalid}`);
    }
  }

  return perfis;
}

module.exports = { normalizePerfis };
