function createGroupProfilesController(dependencies = {}) {
  const groupProfilesService = dependencies.groupProfilesService;

  // Erros nao mapeados (ex.: RLS bloqueando um UPDATE) chegavam ao cliente como um
  // "Internal server error" opaco, sem rastro no log — o que torna o diagnostico cego.
  function logUnexpected(event, error) {
    console.error(
      JSON.stringify({
        event,
        error_message: error?.message || "Unknown error",
        error_code: error?.code,
        error_details: error?.details,
        error_hint: error?.hint,
      })
    );
  }

  async function list(req, res) {
    try {
      const profiles = await groupProfilesService.list();

      return res.status(200).json(profiles);
    } catch (error) {
      logUnexpected("group_profiles.list.failed", error);

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function create(req, res) {
    try {
      const profile = await groupProfilesService.create(req.body || {});

      return res.status(201).json(profile);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (["Nome is required", "Profile already exists"].includes(message)) {
        return res.status(400).json({ error: message });
      }

      logUnexpected("group_profiles.create.failed", error);

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function remove(req, res) {
    try {
      const profile = await groupProfilesService.remove(req.params.id);

      return res.status(200).json(profile);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Profile not found") {
        return res.status(404).json({ error: message });
      }

      if (message === "Profile is in use and cannot be removed") {
        return res.status(409).json({ error: message });
      }

      if (message === "Profile id is required") {
        return res.status(400).json({ error: message });
      }

      logUnexpected("group_profiles.remove.failed", error);

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function update(req, res) {
    try {
      const profile = await groupProfilesService.rename(req.params.id, req.body?.nome);

      return res.status(200).json(profile);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Profile not found") {
        return res.status(404).json({ error: message });
      }

      if (["Nome is required", "Profile already exists", "Profile id is required"].includes(message)) {
        return res.status(400).json({ error: message });
      }

      logUnexpected("group_profiles.rename.failed", error);

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function merge(req, res) {
    try {
      const profile = await groupProfilesService.merge(req.body || {});

      return res.status(200).json(profile);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Profile not found") {
        return res.status(404).json({ error: message });
      }

      if (["Nome is required", "Profile already exists", "Exactly two profileIds are required"].includes(message)) {
        return res.status(400).json({ error: message });
      }

      logUnexpected("group_profiles.merge.failed", error);

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function listMerges(req, res) {
    try {
      const merges = await groupProfilesService.listMergeRecords();

      return res.status(200).json(merges);
    } catch (error) {
      logUnexpected("group_profiles.list_merges.failed", error);

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function unmerge(req, res) {
    try {
      const result = await groupProfilesService.unmerge(req.params.id);

      return res.status(200).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (["Profile not found", "Profile was not created from a merge"].includes(message)) {
        return res.status(404).json({ error: message });
      }

      if (["Profile id is required", "Profile already exists"].includes(message)) {
        return res.status(400).json({ error: message });
      }

      logUnexpected("group_profiles.unmerge.failed", error);

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function reorder(req, res) {
    try {
      const profiles = await groupProfilesService.reorder(req.body?.ordered_ids);

      return res.status(200).json(profiles);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Profile not found") {
        return res.status(404).json({ error: message });
      }

      logUnexpected("group_profiles.reorder.failed", error);

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return {
    create,
    list,
    listMerges,
    merge,
    remove,
    reorder,
    unmerge,
    update,
  };
}

module.exports = createGroupProfilesController;
