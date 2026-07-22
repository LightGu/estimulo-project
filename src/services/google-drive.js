const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");

require("dotenv").config({ quiet: true });

const { clearLoopbackDiscardProxyEnv } = require("../config/network");

clearLoopbackDiscardProxyEnv();

const { google } = require("googleapis");

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
    new google.auth.GoogleAuth({
      credentials,
      scopes: options.scopes || [GOOGLE_DRIVE_READONLY_SCOPE],
    });

  return google.drive({ version: "v3", auth });
}

module.exports = {
  GOOGLE_DRIVE_READONLY_SCOPE,
  createGoogleDriveClient,
  resolveServiceAccountCredentials,
};
