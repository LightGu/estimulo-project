require("dotenv").config({ quiet: true });

const videoCatalogRepository = require("../src/repositories/video-catalog.repository");
const videoTranscriptionService = require("../src/services/video-transcription.service");
const { hasTranscript } = videoTranscriptionService;

function parseArgs(argv) {
  return {
    force: argv.includes("--force"),
  };
}

async function main() {
  const { force } = parseArgs(process.argv.slice(2));
  const videos = await videoCatalogRepository.findAll();
  const pendingVideos = force ? videos : videos.filter((video) => !hasTranscript(video));

  const report = {
    total_no_catalogo: videos.length,
    pendentes_no_inicio: pendingVideos.length,
    transcritos: 0,
    ja_possuiam_transcricao: 0,
    falharam: [],
  };

  console.log(`Iniciando transcricao de ${pendingVideos.length} video(s) de ${videos.length} no catalogo.`);

  for (const [index, video] of pendingVideos.entries()) {
    const label = video.nome_do_arquivo || video.drive_file_id || video.id;
    console.log(`\n[${index + 1}/${pendingVideos.length}] Transcrevendo "${label}"...`);

    try {
      const result = await videoTranscriptionService.transcribeRecord(video, { force });

      if (result.skipped) {
        report.ja_possuiam_transcricao += 1;
        console.log(`  -> Ja possuia transcricao, pulado.`);
        continue;
      }

      report.transcritos += 1;
      console.log(`  -> Transcrito e salvo no banco (${result.transcript.length} caracteres).`);
    } catch (error) {
      report.falharam.push({ id: video.id, drive_file_id: video.drive_file_id, nome: label, erro: error.message });
      console.error(`  -> Falha: ${error.message}`);
    }
  }

  console.log("\n===== Relatorio final de transcricao =====");
  console.log(`Total de videos no catalogo: ${report.total_no_catalogo}`);
  console.log(`Pendentes no inicio da execucao: ${report.pendentes_no_inicio}`);
  console.log(`Transcritos com sucesso nesta execucao: ${report.transcritos}`);
  console.log(`Ja possuiam transcricao (pulados): ${report.ja_possuiam_transcricao}`);
  console.log(`Falharam: ${report.falharam.length}`);

  if (report.falharam.length) {
    console.log("\nDetalhes das falhas:");
    report.falharam.forEach((failure) => {
      console.log(`  - [${failure.id}] ${failure.nome}: ${failure.erro}`);
    });
  }

  const videosAposExecucao = await videoCatalogRepository.findAll();
  const totalComTranscricao = videosAposExecucao.filter(hasTranscript).length;
  console.log(`\nVideos com transcricao apos esta execucao: ${totalComTranscricao} / ${report.total_no_catalogo}`);

  if (report.falharam.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Erro fatal ao executar transcricao em lote:", error);
  process.exitCode = 1;
});
