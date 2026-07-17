const { createGoogleDriveClient } = require("../src/services/google-drive");
const supabase = require("../src/database/client");

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePath(value) {
  return String(value || "")
    .split("/")
    .map(normalizeText)
    .filter(Boolean)
    .join("/");
}

function normalizeLooseName(value) {
  return normalizeText(value)
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b0+(\d+)\b/g, "$1")
    .trim();
}

function buildFileLink(file) {
  return file.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`;
}

async function listFolderChildren(drive, folderId) {
  const files = [];
  let pageToken;

  do {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields:
        "nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, webViewLink, parents)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    files.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function indexDriveFiles(drive, rootFolderId) {
  const filesByPathAndName = new Map();
  const filesByName = new Map();
  const filesByLooseName = new Map();

  async function walk(folderId, pathSegments) {
    const children = await listFolderChildren(drive, folderId);

    for (const child of children) {
      if (child.mimeType === FOLDER_MIME_TYPE) {
        await walk(child.id, [...pathSegments, child.name]);
        continue;
      }

      const key = `${normalizePath(pathSegments.join("/"))}/${normalizeText(child.name)}`;
      filesByPathAndName.set(key, {
        ...child,
        path: pathSegments.join("/"),
        link_video: buildFileLink(child),
      });
      const nameKey = normalizeText(child.name);
      const filesWithSameName = filesByName.get(nameKey) || [];
      filesWithSameName.push({
        ...child,
        path: pathSegments.join("/"),
        link_video: buildFileLink(child),
      });
      filesByName.set(nameKey, filesWithSameName);

      const looseNameKey = normalizeLooseName(child.name);
      const filesWithSameLooseName = filesByLooseName.get(looseNameKey) || [];
      filesWithSameLooseName.push({
        ...child,
        path: pathSegments.join("/"),
        link_video: buildFileLink(child),
      });
      filesByLooseName.set(looseNameKey, filesWithSameLooseName);
    }
  }

  await walk(rootFolderId, []);
  return { filesByPathAndName, filesByName, filesByLooseName };
}

async function fetchAllRows() {
  const rows = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("video_catalog")
      .select("*")
      .range(from, to)
      .order("created_at", { ascending: true });

    if (error) {
      throw error;
    }

    rows.push(...(data || []));

    if (!data || data.length < pageSize) {
      return rows;
    }
  }
}

function resolveColumn(columns, candidates) {
  return candidates.find((column) => columns.has(column));
}

async function main() {
  const shouldPrintDriveSamples = process.argv.includes("--print-drive-samples");
  const isDryRun = process.argv.includes("--dry-run");
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

  if (!rootFolderId) {
    throw new Error("GOOGLE_DRIVE_ROOT_FOLDER_ID nao definido");
  }

  const rows = await fetchAllRows();
  const columns = new Set(rows[0] ? Object.keys(rows[0]) : []);
  const linkColumn = resolveColumn(columns, ["link_video", "video_link", "web_view_link"]);
  const driveCreatedColumn = resolveColumn(columns, [
    "google_drive_created_at",
    "drive_created_at",
    "drive_added_at",
    "created_time",
  ]);

  const drive = createGoogleDriveClient();
  const { filesByPathAndName, filesByName, filesByLooseName } = await indexDriveFiles(drive, rootFolderId);

  if (shouldPrintDriveSamples) {
    console.log(
      [...filesByPathAndName.values()]
        .slice(0, 100)
        .map((file) => `${file.path}/${file.name}`)
        .join("\n")
    );
    return;
  }
  const missing = [];
  const ambiguous = [];
  let updated = 0;

  for (const row of rows) {
    const key = `${normalizePath(row.pasta_atual)}/${normalizeText(row.nome_do_arquivo)}`;
    let file = filesByPathAndName.get(key);

    if (!file) {
      const candidates = filesByName.get(normalizeText(row.nome_do_arquivo)) || [];

      if (candidates.length === 1) {
        file = candidates[0];
      } else if (candidates.length > 1) {
        ambiguous.push({
          id: row.id,
          pasta_atual: row.pasta_atual,
          nome_do_arquivo: row.nome_do_arquivo,
          candidates: candidates.map((candidate) => ({
            id: candidate.id,
            path: candidate.path,
            name: candidate.name,
          })),
        });
      }
    }

    if (!file) {
      const candidates = filesByLooseName.get(normalizeLooseName(row.nome_do_arquivo)) || [];

      if (candidates.length === 1) {
        file = candidates[0];
      } else if (candidates.length > 1) {
        ambiguous.push({
          id: row.id,
          pasta_atual: row.pasta_atual,
          nome_do_arquivo: row.nome_do_arquivo,
          candidates: candidates.map((candidate) => ({
            id: candidate.id,
            path: candidate.path,
            name: candidate.name,
          })),
        });
      }
    }

    if (!file) {
      missing.push({
        id: row.id,
        pasta_atual: row.pasta_atual,
        nome_do_arquivo: row.nome_do_arquivo,
      });
      continue;
    }

    const payload = {
      drive_file_id: file.id,
    };

    if (linkColumn) {
      payload[linkColumn] = file.link_video;
    }

    if (driveCreatedColumn) {
      payload[driveCreatedColumn] = file.createdTime;
    }

    if (columns.has("status") && typeof row.status === "boolean") {
      payload.status = true;
    }

    if (isDryRun) {
      updated += 1;
      continue;
    }

    const { error } = await supabase.from("video_catalog").update(payload).eq("id", row.id);

    if (error) {
      throw error;
    }

    updated += 1;
  }

  console.log(
    JSON.stringify(
      {
        rows: rows.length,
        drive_files_indexed: filesByPathAndName.size,
        updated,
        missing_count: missing.length,
        ambiguous_count: ambiguous.length,
        has_link_column: Boolean(linkColumn),
        link_column: linkColumn || null,
        has_drive_created_column: Boolean(driveCreatedColumn),
        drive_created_column: driveCreatedColumn || null,
        status_column_type: rows[0] ? typeof rows[0].status : "unknown",
        missing: missing.slice(0, 20),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
