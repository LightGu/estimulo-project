require("dotenv").config({ quiet: true });

const { deleteGeminiFile, listGeminiFiles } = require("../src/services/ai/gemini-adapter");

function parseArgs(argv) {
  return {
    apply: argv.includes("--delete"),
  };
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);

  if (!value) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);

  return `${(value / 1024 ** exponent).toFixed(2)} ${units[exponent]}`;
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const files = await listGeminiFiles();
  const totalBytes = files.reduce((sum, file) => sum + Number(file.sizeBytes || 0), 0);

  console.log(`Encontrados ${files.length} arquivo(s) na Files API do Gemini, totalizando ${formatBytes(totalBytes)}.`);

  if (!files.length) {
    return;
  }

  files.forEach((file, index) => {
    console.log(
      `  [${index + 1}/${files.length}] ${file.name} - ${file.displayName || "sem nome"} - ${formatBytes(
        file.sizeBytes
      )} - state=${file.state} - expira em ${file.expirationTime || "?"}`
    );
  });

  if (!apply) {
    console.log("\nModo somente leitura (dry-run). Rode com --delete para excluir esses arquivos.");
    return;
  }

  console.log("\nExcluindo arquivos...");

  const report = { excluidos: 0, falharam: [] };

  for (const [index, file] of files.entries()) {
    try {
      await deleteGeminiFile(file, { throwOnError: true });
      report.excluidos += 1;
      console.log(`  [${index + 1}/${files.length}] Excluido: ${file.name}`);
    } catch (error) {
      report.falharam.push({ name: file.name, erro: error.message });
      console.error(`  [${index + 1}/${files.length}] Falha ao excluir ${file.name}: ${error.message}`);
    }
  }

  console.log(`\nExcluidos: ${report.excluidos}/${files.length}`);

  if (report.falharam.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Erro fatal ao limpar arquivos do Gemini:", error);
  process.exitCode = 1;
});
