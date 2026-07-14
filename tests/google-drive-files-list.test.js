const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");

require("dotenv").config();

const { google } = require("googleapis");

const REQUIRED_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

function resolveServiceAccountCredentials() {
  const credentialsValue = process.env.GOOGLE_DRIVE_CREDENTIALS;

  assert.ok(
    credentialsValue,
    "Defina GOOGLE_DRIVE_CREDENTIALS com o caminho do JSON da conta de servico ou com o JSON completo.",
  );

  const trimmedValue = credentialsValue.trim();

  if (trimmedValue.startsWith("{")) {
    return JSON.parse(trimmedValue);
  }

  const credentialsPath = path.isAbsolute(trimmedValue)
    ? trimmedValue
    : path.resolve(process.cwd(), trimmedValue);

  assert.ok(
    fs.existsSync(credentialsPath),
    `Arquivo de credenciais nao encontrado: ${credentialsPath}`,
  );

  return JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
}

async function main() {
  const folderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

  assert.ok(
    folderId,
    "Defina GOOGLE_DRIVE_ROOT_FOLDER_ID com o ID da pasta compartilhada no Google Drive.",
  );

  const credentials = resolveServiceAccountCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: REQUIRED_SCOPES,
  });

  const drive = google.drive({ version: "v3", auth });
  const response = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: "files(id, name, mimeType), nextPageToken",
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const files = response.data.files ?? [];

  assert.ok(Array.isArray(files), "A resposta de files.list deve conter uma lista de arquivos.");

  console.log(`Autenticacao da conta de servico OK.`);
  console.log(`files.list executado com sucesso para a pasta ${folderId}.`);
  console.log(`Arquivos encontrados nesta pagina: ${files.length}`);

  for (const file of files) {
    console.log(`- ${file.name} (${file.id})`);
  }
}

main().catch((error) => {
  console.error("Falha ao validar Google Drive com conta de servico.");
  console.error(error.message);
  process.exitCode = 1;
});
