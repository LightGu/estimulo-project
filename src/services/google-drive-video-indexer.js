const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";

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

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function isFolder(file) {
  return file && file.mimeType === FOLDER_MIME_TYPE;
}

function isShortcut(file) {
  return file && file.mimeType === SHORTCUT_MIME_TYPE;
}

function resolveShortcutTarget(file) {
  const targetId = file.shortcutDetails && file.shortcutDetails.targetId;

  if (!targetId) {
    return undefined;
  }

  return {
    id: targetId,
    name: file.name,
    mimeType: file.shortcutDetails.targetMimeType,
    parents: file.parents,
  };
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
  const parentFolder = pathSegments[pathSegments.length - 1];

  return {
    skipped: false,
    video: {
      drive_file_id: file.id,
      drive_parent_id: file.parents && file.parents[0],
      name: file.name,
      nome_do_arquivo: file.name,
      pasta_atual: parentFolder && parentFolder.name,
      mime_type: file.mimeType,
      file_extension: getFileExtension(file) || undefined,
      modified_time: file.modifiedTime,
      web_view_link: file.webViewLink || buildDriveWebViewLink(file.id),
      google_drive_created_at: file.createdTime,
      drive_path: pathSegments.map((segment) => segment.name),
      status: options.defaultStatus === undefined ? true : options.defaultStatus,
    },
  };
}

async function fetchShortcutTargetFile(drive, targetId, shortcutName) {
  const response = await drive.files.get({
    fileId: targetId,
    fields: "id, name, mimeType, fileExtension, modifiedTime, createdTime, webViewLink, parents, size, videoMediaMetadata",
    supportsAllDrives: true,
  });

  return { ...response.data, name: response.data.name || shortcutName };
}

async function listFolderChildren(drive, folderId, options = {}) {
  const files = [];
  let pageToken;

  do {
    const response = await drive.files.list({
      q: buildFolderChildrenQuery(folderId, options),
      fields:
        "nextPageToken, files(id, name, mimeType, fileExtension, modifiedTime, createdTime, webViewLink, parents, size, videoMediaMetadata, shortcutDetails)",
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
    transcribeVideo,
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

  function startTranscriptionForNewVideo(upsertResult, mappedVideo) {
    if (!transcribeVideo || !upsertResult || upsertResult.created !== true) {
      return;
    }

    const videoCatalogRecord = upsertResult.video || upsertResult.record || mappedVideo;
    const transcriptionPromise = Promise.resolve()
      .then(() => transcribeVideo(videoCatalogRecord))
      .then(() => {
        logger.info &&
          logger.info(
            JSON.stringify({
              event: "google_drive_video_index.transcription_completed",
              video_id: videoCatalogRecord && videoCatalogRecord.id,
              drive_file_id: videoCatalogRecord && videoCatalogRecord.drive_file_id,
            })
          );
      })
      .catch((error) => {
        logger.warn &&
          logger.warn(
            JSON.stringify({
              event: "google_drive_video_index.transcription_failed",
              video_id: videoCatalogRecord && videoCatalogRecord.id,
              drive_file_id: videoCatalogRecord && videoCatalogRecord.drive_file_id,
              error_message: error.message,
            })
          );
      });

    if (typeof transcriptionPromise.unref === "function") {
      transcriptionPromise.unref();
    }
  }

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

    for (const rawChild of children) {
      let child = rawChild;

      try {
        if (isShortcut(rawChild)) {
          const target = resolveShortcutTarget(rawChild);

          if (!target) {
            skipped.push({
              reason: "shortcut_without_target",
              file_id: rawChild.id,
              name: rawChild.name,
              mime_type: rawChild.mimeType,
              path: pathSegments.map((segment) => segment.name),
            });
            continue;
          }

          if (isFolder(target)) {
            await walk(target.id, [...pathSegments, { id: target.id, name: rawChild.name }], depth + 1);
            continue;
          }

          child = await fetchShortcutTargetFile(drive, target.id, rawChild.name);
        }

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
          const upsertResult = await upsertVideo(mapped.video);
          startTranscriptionForNewVideo(upsertResult, mapped.video);
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
  DEFAULT_VIDEO_EXTENSIONS,
  FOLDER_MIME_TYPE,
  SHORTCUT_MIME_TYPE,
  buildFolderChildrenQuery,
  indexGoogleDriveVideos,
  isValidVideoFile,
  mapVideoFile,
  normalizeText,
  resolveShortcutTarget,
};
