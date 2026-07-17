require("dotenv").config({ quiet: true });

const createApp = require("../src/api/app");

const port = Number(process.env.PORT || 3000);
const app = createApp();

const server = app.listen(port, () => {
  console.log(`API local iniciada em http://127.0.0.1:${port}`);
  console.log(`Tela de grupos: http://127.0.0.1:${port}/groups-unclassified.html`);
});

async function shutdown() {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});
