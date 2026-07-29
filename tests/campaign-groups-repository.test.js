const assert = require("node:assert/strict");

const { isCampaignFullyTerminal } = require("../src/repositories/campaign-groups.repository");

function createGroupsClient(groupRows) {
  const createBuilder = () => ({
    select() {
      return this;
    },
    eq() {
      return this;
    },
    order() {
      return Promise.resolve({ data: groupRows, error: null });
    },
  });

  return {
    from() {
      return createBuilder();
    },
  };
}

async function main() {
  // ---------- all groups terminal -> true ----------
  {
    const client = createGroupsClient([{ group_id: "group-1" }, { group_id: "group-2" }]);
    const dispatchLogsRepository = {
      listByCampaign: async () => [
        { group_id: "group-1", status: "enviado" },
        { group_id: "group-2", status: "falhou" },
      ],
    };

    const result = await isCampaignFullyTerminal("campaign-1", { client, dispatchLogsRepository });
    assert.equal(result, true);
  }

  // ---------- some group without terminal log -> false ----------
  {
    const client = createGroupsClient([{ group_id: "group-1" }, { group_id: "group-2" }]);
    const dispatchLogsRepository = {
      listByCampaign: async () => [{ group_id: "group-1", status: "enviado" }],
    };

    const result = await isCampaignFullyTerminal("campaign-1", { client, dispatchLogsRepository });
    assert.equal(result, false);
  }

  // ---------- some group with pending status -> false ----------
  {
    const client = createGroupsClient([{ group_id: "group-1" }, { group_id: "group-2" }]);
    const dispatchLogsRepository = {
      listByCampaign: async () => [
        { group_id: "group-1", status: "enviado" },
        { group_id: "group-2", status: "pendente" },
      ],
    };

    const result = await isCampaignFullyTerminal("campaign-1", { client, dispatchLogsRepository });
    assert.equal(result, false);
  }

  // ---------- campaign without groups -> false ----------
  {
    const client = createGroupsClient([]);
    const dispatchLogsRepository = { listByCampaign: async () => [] };

    const result = await isCampaignFullyTerminal("campaign-1", { client, dispatchLogsRepository });
    assert.equal(result, false);
  }

  console.log("campaign groups repository tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
