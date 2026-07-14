const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  addGoogleDriveVideoIndexJob,
  googleDriveVideoIndexQueue,
} = require("../src/queues/google-drive-video-index");

function parseArgs(argv) {
  const args = {
    positional: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--root-folder-id") {
      args.root_folder_id = argv[index + 1];
      index += 1;
    } else if (value === "--root-folder-name") {
      args.root_folder_name = argv[index + 1];
      index += 1;
    } else {
      args.positional.push(value);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [rootFolderId] = args.positional;
  const job = await addGoogleDriveVideoIndexJob({
    root_folder_id: args.root_folder_id || rootFolderId,
    root_folder_name: args.root_folder_name,
  });

  console.log(
    JSON.stringify(
      {
        queue: googleDriveVideoIndexQueue.name,
        job_id: job.id,
        name: job.name,
        data: job.data,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await googleDriveVideoIndexQueue.close();
    await closeQueueInfrastructure();
  });
