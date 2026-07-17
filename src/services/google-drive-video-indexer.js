const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

const DEFAULT_VIDEO_EXTENSIONS = new Set([
  "3g2",
  "3gp",
  "avi",
  "m4v",
  "mkv",
  "mov",
  "mp4",
  "mpeg",
  "mpg",
  "webm",
  "wmv",
]);

const DEFAULT_PERSONA_MAPPINGS = [
  {
    code: "P01",
    hashtag: "#P01",
    persona: "Paulo",
    trilha: "Empreendedores na pre infancia",
    aliases: ["p01", "#p01", "paulo", "pre infancia", "pre-infancia", "preinfancia"],
  },
  {
    code: "M01",
    hashtag: "#M01",
    persona: "Maria",
    trilha: "Empreendedores na infancia",
    aliases: ["m01", "#m01", "maria", "infancia"],
  },
  {
    code: "E01",
    hashtag: "#E01",
    persona: "Eufrasio",
    trilha: "Empreendedores na adolescencia e maturidade",
    aliases: ["e01", "#e01", "eufrasio", "adolescencia", "maturidade"],
  },
];

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isFolder(file) {
  return file && file.mimeType === FOLDER_MIME_TYPE;
}

function getFileExtension(file) {
  const explicitExtension = normalizeText(file && file.fileExtension);

  if (explicitExtension) {
    return explicitExtension;
  }

  const match = String((file && file.name) || "").match(/\.([^.]+)$/);

  return match ? normalizeText(match[1]) : "";
}

function isValidVideoFile(file, videoExtensions = DEFAULT_VIDEO_EXTENSIONS) {
  if (!file || isFolder(file)) {
    return false;
  }

  if (typeof file.mimeType === "string" && file.mimeType.toLowerCase().startsWith("video/")) {
    return true;
  }

  return videoExtensions.has(getFileExtension(file));
}

function extractEtapaFromFolderName(folderName) {
  const normalized = normalizeText(folderName);

  if (!normalized || /#?[pme]01\b/.test(normalized)) {
    return undefined;
  }

  const labelledMatch = normalized.match(/\b(?:etapa|fase|modulo|semana|aula)\s*0*(\d{1,3})\b/);

  if (labelledMatch) {
    return Number(labelledMatch[1]);
  }

  const leadingNumberMatch = normalized.match(/^\s*0*(\d{1,3})(?:\b|[\s._-])/);

  if (leadingNumberMatch) {
    return Number(leadingNumberMatch[1]);
  }

  return undefined;
}

function findEtapa(pathSegments) {
  for (let index = pathSegments.length - 1; index >= 0; index -= 1) {
    const etapa = extractEtapaFromFolderName(pathSegments[index].name);

    if (Number.isInteger(etapa) && etapa >= 1) {
      return etapa;
    }
  }

  return undefined;
}

function matchAliasInText(normalizedText, alias) {
  const normalizedAlias = normalizeText(alias);

  if (!normalizedAlias) {
    return false;
  }

  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedAlias)}([^a-z0-9]|$)`).test(normalizedText);
}

function findPersona(pathSegments, personaMappings = DEFAULT_PERSONA_MAPPINGS) {
  for (let index = pathSegments.length - 1; index >= 0; index -= 1) {
    const normalizedFolderName = normalizeText(pathSegments[index].name);
    const persona = personaMappings.find((mapping) =>
      [mapping.code, mapping.hashtag, mapping.persona, ...(mapping.aliases || [])].some((alias) =>
        matchAliasInText(normalizedFolderName, alias)
      )
    );

    if (persona) {
      return persona;
    }
  }

  return undefined;
}

function buildDriveWebViewLink(fileId) {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

function normalizeDateISOString(value, fieldName) {
  if (!value) {
    return undefined;
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} deve ser uma data valida`);
  }

  return date.toISOString();
}

function buildModifiedTimePredicate(options = {}) {
  const predicates = [];

  if (options.modifiedTimeAfter) {
    predicates.push(`modifiedTime > '${options.modifiedTimeAfter}'`);
  }

  if (options.modifiedTimeBefore) {
    predicates.push(`modifiedTime <= '${options.modifiedTimeBefore}'`);
  }

  return predicates.join(" and ");
}

function buildFolderChildrenQuery(folderId, options = {}) {
  const baseQuery = `'${folderId}' in parents and trashed = false`;
  const modifiedTimePredicate = buildModifiedTimePredicate(options);

  if (!modifiedTimePredicate) {
    return baseQuery;
  }

  return `${baseQuery} and (mimeType = '${FOLDER_MIME_TYPE}' or (${modifiedTimePredicate}))`;
}

function mapVideoFile(file, pathSegments, options = {}) {
  const etapa = findEtapa(pathSegments);
  const persona = findPersona(pathSegments, options.personaMappings);

  if (!Number.isInteger(etapa)) {
    return {
      skipped: true,
      reason: "etapa_not_found",
      file,
      path: pathSegments.map((segment) => segment.name),
    };
  }

  if (!persona) {
    return {
      skipped: true,
      reason: "trilha_not_found",
      file,
      path: pathSegments.map((segment) => segment.name),
    };
  }

  return {
    skipped: false,
    video: {
      drive_file_id: file.id,
      drive_parent_id: file.parents && file.parents[0],
      name: file.name,
      mime_type: file.mimeType,
      file_extension: getFileExtension(file) || undefined,
      modified_time: file.modifiedTime,
      web_view_link: file.webViewLink || buildDriveWebViewLink(file.id),
      etapa,
      trilha_segmento: persona.trilha,
      persona_code: persona.code,
      persona_hashtag: persona.hashtag,
      persona_name: persona.persona,
      drive_path: pathSegments.map((segment) => segment.name),
      status: options.defaultStatus === undefined ? false : options.defaultStatus,
    },
  };
}

async function listFolderChildren(drive, folderId, options = {}) {
  const files = [];
  let pageToken;

  do {
    const response = await drive.files.list({
      q: buildFolderChildrenQuery(folderId, options),
      fields:
        "nextPageToken, files(id, name, mimeType, fileExtension, modifiedTime, webViewLink, parents, size, videoMediaMetadata)",
      pageSize: options.pageSize || 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    files.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function indexGoogleDriveVideos(params) {
  const {
    drive,
    rootFolderId,
    rootFolderName = "root",
    upsertVideo,
    logger = console,
    maxDepth = 50,
  } = params || {};
  const modifiedTimeAfter = normalizeDateISOString(params && params.modifiedTimeAfter, "modifiedTimeAfter");
  const modifiedTimeBefore = normalizeDateISOString(params && params.modifiedTimeBefore, "modifiedTimeBefore");

  if (!drive || !drive.files || typeof drive.files.list !== "function") {
    throw new Error("drive.files.list e obrigatorio para indexar videos do Google Drive");
  }

  if (!rootFolderId) {
    throw new Error("rootFolderId e obrigatorio para indexar videos do Google Drive");
  }

  const videos = [];
  const skipped = [];
  const errors = [];
  const visitedFolderIds = new Set();
  let processedCount = 0;

  async function walk(folderId, pathSegments, depth) {
    if (depth > maxDepth) {
      errors.push({
        folder_id: folderId,
        path: pathSegments.map((segment) => segment.name),
        message: `Profundidade maxima excedida: ${maxDepth}`,
      });
      return;
    }

    if (visitedFolderIds.has(folderId)) {
      return;
    }

    visitedFolderIds.add(folderId);

    let children;

    try {
      children = await listFolderChildren(drive, folderId, params);
    } catch (error) {
      errors.push({
        folder_id: folderId,
        path: pathSegments.map((segment) => segment.name),
        message: error.message,
      });
      logger.warn &&
        logger.warn(
          JSON.stringify({
            event: "google_drive_video_index.folder_failed",
            folder_id: folderId,
            error_message: error.message,
          })
        );
      return;
    }

    for (const child of children) {
      try {
        if (isFolder(child)) {
          await walk(child.id, [...pathSegments, { id: child.id, name: child.name }], depth + 1);
          continue;
        }

        processedCount += 1;

        if (!isValidVideoFile(child, params.videoExtensions || DEFAULT_VIDEO_EXTENSIONS)) {
          skipped.push({
            reason: "not_video",
            file_id: child.id,
            name: child.name,
            mime_type: child.mimeType,
            path: pathSegments.map((segment) => segment.name),
          });
          continue;
        }

        const mapped = mapVideoFile(child, pathSegments, params);

        if (mapped.skipped) {
          skipped.push({
            reason: mapped.reason,
            file_id: child.id,
            name: child.name,
            mime_type: child.mimeType,
            path: mapped.path,
          });
          continue;
        }

        if (upsertVideo) {
          await upsertVideo(mapped.video);
        }

        videos.push(mapped.video);
      } catch (error) {
        errors.push({
          file_id: child.id,
          name: child.name,
          path: pathSegments.map((segment) => segment.name),
          message: error.message,
        });
        logger.warn &&
          logger.warn(
            JSON.stringify({
              event: "google_drive_video_index.file_failed",
              file_id: child.id,
              error_message: error.message,
            })
          );
      }
    }
  }

  await walk(rootFolderId, [{ id: rootFolderId, name: rootFolderName }], 0);

  return {
    root_folder_id: rootFolderId,
    modified_time_after: modifiedTimeAfter,
    modified_time_before: modifiedTimeBefore,
    processed_count: processedCount,
    indexed_count: videos.length,
    skipped_count: skipped.length,
    error_count: errors.length,
    videos,
    skipped,
    errors,
  };
}

module.exports = {
  DEFAULT_PERSONA_MAPPINGS,
  DEFAULT_VIDEO_EXTENSIONS,
  FOLDER_MIME_TYPE,
  buildFolderChildrenQuery,
  extractEtapaFromFolderName,
  findEtapa,
  findPersona,
  indexGoogleDriveVideos,
  isValidVideoFile,
  mapVideoFile,
  normalizeText,
};
