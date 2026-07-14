const assert = require("node:assert/strict");

const {
  downloadFromDrive,
  resolveVideoCatalogRecord,
} = require("../src/services/google-drive-video-download");

function createFakeDrive(response, calls) {
  return {
    files: {
      async get(params, options) {
        calls.push({ params, options });
        return response;
      },
    },
  };
}

async function testDownloadsVideoBytesUsingDriveFileId() {
  const calls = [];
  const videoBytes = Buffer.from("video-bytes");
  const drive = createFakeDrive(
    {
      data: videoBytes,
      headers: {
        "content-type": "video/mp4",
      },
    },
    calls
  );

  const result = await downloadFromDrive({
    drive,
    videoCatalogRecord: {
      id: "video-1",
      drive_file_id: "drive-file-1",
      name: "aula-01.mp4",
      mime_type: "video/mp4",
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, {
    fileId: "drive-file-1",
    alt: "media",
    supportsAllDrives: true,
  });
  assert.equal(calls[0].options.responseType, "arraybuffer");
  assert.equal(Buffer.isBuffer(result.bytes), true);
  assert.equal(result.bytes.toString(), "video-bytes");
  assert.equal(result.video_id, "video-1");
  assert.equal(result.drive_file_id, "drive-file-1");
  assert.equal(result.name, "aula-01.mp4");
  assert.equal(result.mime_type, "video/mp4");
  assert.deepEqual(result.metadata, {
    name: "aula-01.mp4",
    mime_type: "video/mp4",
    size_bytes: videoBytes.length,
  });
}

async function testFetchesVideoCatalogRecordFromRepository() {
  const record = await resolveVideoCatalogRecord({
    videoId: "video-2",
    videoCatalogRepository: {
      async findById(videoId) {
        assert.equal(videoId, "video-2");
        return {
          id: videoId,
          drive_file_id: "drive-file-2",
          name: "aula-02.mov",
          mime_type: "video/quicktime",
        };
      },
    },
  });

  assert.equal(record.drive_file_id, "drive-file-2");
}

async function testUsesResponseHeaderAsMimeTypeFallback() {
  const calls = [];
  const drive = createFakeDrive(
    {
      data: Buffer.from("video"),
      headers: {
        "content-type": "video/webm; charset=binary",
      },
    },
    calls
  );

  const result = await downloadFromDrive({
    drive,
    videoCatalogRecord: {
      id: "video-3",
      drive_file_id: "drive-file-3",
      name: "aula-03.webm",
    },
  });

  assert.equal(result.mime_type, "video/webm");
}

async function testInfersVideoMimeTypeFromFileNameWhenDriveReturnsOctetStream() {
  const calls = [];
  const drive = createFakeDrive(
    {
      data: Buffer.from("video"),
      headers: {
        "content-type": "application/octet-stream",
      },
    },
    calls
  );

  const result = await downloadFromDrive({
    drive,
    videoCatalogRecord: {
      id: "video-4",
      drive_file_id: "drive-file-4",
      name: "aula-04.mp4",
      mime_type: "application/octet-stream",
    },
  });

  assert.equal(result.mime_type, "video/mp4");
}

async function testRejectsEmptyDownload() {
  await assert.rejects(
    () =>
      downloadFromDrive({
        drive: createFakeDrive(
          {
            data: Buffer.alloc(0),
            headers: {
              "content-type": "video/mp4",
            },
          },
          []
        ),
        videoCatalogRecord: {
          id: "video-5",
          drive_file_id: "drive-file-5",
          name: "aula-05.mp4",
          mime_type: "video/mp4",
        },
      }),
    /video vazio/
  );
}

async function testRejectsInvalidMimeType() {
  await assert.rejects(
    () =>
      downloadFromDrive({
        drive: createFakeDrive(
          {
            data: Buffer.from("not-a-video"),
            headers: {
              "content-type": "application/pdf",
            },
          },
          []
        ),
        videoCatalogRecord: {
          id: "video-6",
          drive_file_id: "drive-file-6",
          name: "documento.pdf",
          mime_type: "application/pdf",
        },
      }),
    /Tipo MIME invalido/
  );
}

async function testRequiresDriveFileId() {
  await assert.rejects(
    () =>
      downloadFromDrive({
        drive: createFakeDrive({ data: Buffer.from("") }, []),
        videoCatalogRecord: {
          id: "video-7",
        },
      }),
    /drive_file_id e obrigatorio/
  );
}

async function main() {
  await testDownloadsVideoBytesUsingDriveFileId();
  await testFetchesVideoCatalogRecordFromRepository();
  await testUsesResponseHeaderAsMimeTypeFallback();
  await testInfersVideoMimeTypeFromFileNameWhenDriveReturnsOctetStream();
  await testRejectsEmptyDownload();
  await testRejectsInvalidMimeType();
  await testRequiresDriveFileId();

  console.log("google-drive-video-download tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
