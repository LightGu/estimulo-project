const assert = require("node:assert/strict");

const settingsRepository = require("../src/repositories/settings.repository");
const videoCatalogRepository = require("../src/repositories/video-catalog.repository");

function createMockClient(result) {
  const calls = [];
  const createBuilder = () => ({
    select() {
      return this;
    },
    update(payload) {
      calls.push({ type: "update", payload });
      return this;
    },
    eq(column, value) {
      calls.push({ type: "eq", column, value });
      return this;
    },
    not(column, operator, value) {
      calls.push({ type: "not", column, operator, value });
      return Promise.resolve({ data: result, error: null });
    },
    maybeSingle() {
      return Promise.resolve({ data: result, error: null });
    },
    single() {
      return Promise.resolve({ data: result, error: null });
    },
  });

  const client = {
    from(tableName) {
      calls.push({ type: "from", tableName });
      return createBuilder();
    },
    __calls: calls,
  };

  return client;
}

async function main() {
  const settingsClient = createMockClient({
    id: "settings-1",
    key: "global",
    drive_root_folder_id: "folder-1",
    drive_index_cron: "0 3 * * *",
    drive_index_timezone: "America/Bahia",
  });

  const settings = await settingsRepository.getSettings(settingsClient);
  assert.equal(settings.drive_root_folder_id, "folder-1");
  assert.ok(settingsClient.__calls.some((call) => call.type === "from" && call.tableName === "settings"));
  assert.ok(settingsClient.__calls.some((call) => call.type === "eq" && call.column === "key" && call.value === "global"));

  const updatedSettings = await settingsRepository.updateSettings({ drive_root_folder_id: "folder-2" }, settingsClient);
  assert.ok(updatedSettings);
  assert.ok(
    settingsClient.__calls.some(
      (call) => call.type === "update" && call.payload.drive_root_folder_id === "folder-2"
    )
  );

  const videoClient = createMockClient([
    { id: "video-1", drive_file_id: "drive-1" },
    { id: "video-2", drive_file_id: "drive-2" },
  ]);

  const driveFileIds = await videoCatalogRepository.findAllDriveFileIds(videoClient);
  assert.equal(driveFileIds.length, 2);
  assert.ok(videoClient.__calls.some((call) => call.type === "not" && call.column === "drive_file_id"));

  console.log("settings repository tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
