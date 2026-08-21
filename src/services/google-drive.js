const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");

require("dotenv").config({ quiet: true });

const { clearLoopbackDiscardProxyEnv } = require("../config/network");

clearLoopbackDiscardProxyEnv();

const { GoogleAuth } = require("google-auth-library");
const { drive } = require("googleapis/build/src/apis/drive");

const GOOGLE_DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

function resolveServiceAccountCredentials(credentialsValue = process.env.GOOGLE_DRIVE_CREDENTIALS) {
  if (!credentialsValue) {
    throw new Error(
      "Defina GOOGLE_DRIVE_CREDENTIALS com o caminho do JSON da conta de servico ou com o JSON completo."
    );
  }

  const trimmedValue = credentialsValue.trim();

  if (trimmedValue.startsWith("{")) {
    return JSON.parse(trimmedValue);
  }

  const credentialsPath = path.isAbsolute(trimmedValue)
    ? trimmedValue
    : path.resolve(process.cwd(), trimmedValue);

  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`Arquivo de credenciais nao encontrado: ${credentialsPath}`);
  }

  return JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
}

function createGoogleDriveClient(options = {}) {
  const credentials = options.credentials || resolveServiceAccountCredentials(options.credentialsValue);
  const auth =
    options.auth ||
    new GoogleAuth({
      credentials,
      scopes: options.scopes || [GOOGLE_DRIVE_READONLY_SCOPE],
    });

  return drive({ version: "v3", auth });
}

const DRIVE_FOLDER_URL_PATTERN = /drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders|folderview)\/([a-zA-Z0-9_-]+)/;

function extractDriveFolderId(input) {
  const trimmedValue = String(input || "").trim();

  if (!trimmedValue) {
    throw new Error("Pasta raiz do Drive e obrigatoria");
  }

  const urlMatch = trimmedValue.match(DRIVE_FOLDER_URL_PATTERN);

  if (urlMatch) {
    return urlMatch[1];
  }

  if (/^https?:\/\//i.test(trimmedValue)) {
    throw new Error("Nao foi possivel extrair o ID da pasta a partir do link informado");
  }

  return trimmedValue;
}

function buildDriveFolderUrl(folderId) {
  if (!folderId) {
    return null;
  }

  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
}

module.exports = {
  GOOGLE_DRIVE_READONLY_SCOPE,
  buildDriveFolderUrl,
  createGoogleDriveClient,
  extractDriveFolderId,
  resolveServiceAccountCredentials,
};
