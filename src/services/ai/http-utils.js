function assertFetch(fetchImplementation, providerName) {
  if (typeof fetchImplementation !== "function") {
    throw new Error(`fetch e obrigatorio para gerar legenda com ${providerName}`);
  }
}

async function readResponseJson(response, context) {
  const text = await response.text();
  let parsed = {};

  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      parsed = {};
    }
  }

  if (!response.ok) {
    const apiMessage = parsed?.error?.message || text;
    throw new Error(`${context}: ${apiMessage || response.statusText}`);
  }

  return parsed;
}

module.exports = {
  assertFetch,
  readResponseJson,
};
