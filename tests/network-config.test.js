const assert = require("node:assert/strict");

const { clearLoopbackDiscardProxyEnv } = require("../src/config/network");

function testClearsLoopbackDiscardProxy() {
  const env = {
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://localhost:9/",
    http_proxy: "http://[::1]:9",
    https_proxy: "http://proxy.example:8080",
  };

  const cleared = clearLoopbackDiscardProxyEnv(env);

  assert.deepEqual(cleared, ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy"]);
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.http_proxy, undefined);
  assert.equal(env.https_proxy, "http://proxy.example:8080");
}

function main() {
  testClearsLoopbackDiscardProxy();

  console.log("network-config tests OK");
}

main();
