function createWhatsappInstancesController(dependencies = {}) {
  const service = dependencies.whatsappInstancesService;

  async function list(req, res) {
    try {
      const instances = await service.list();

      return res.status(200).json(instances);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function register(req, res) {
    try {
      const instance = await service.registerInstance(req.body || {});

      return res.status(201).json(instance);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "instance_name is required") {
        return res.status(400).json({ error: message });
      }

      if (message === "Instance already exists") {
        return res.status(409).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function getQrCode(req, res) {
    try {
      const result = await service.generateQrCode(req.params.id);

      return res.status(200).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Instance not found") {
        return res.status(404).json({ error: message });
      }

      if (message === "Evolution API did not return a QR code") {
        return res.status(502).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function getStatus(req, res) {
    try {
      const instance = await service.checkConnectionStatus(req.params.id);

      return res.status(200).json(instance);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Instance not found") {
        return res.status(404).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function remove(req, res) {
    try {
      const result = await service.removeInstance(req.params.id);

      return res.status(200).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Instance not found") {
        return res.status(404).json({ error: message });
      }

      // Sem este log, uma falha aqui chegava na tela apenas como
      // "Internal server error", sem nenhum rastro de qual passo quebrou
      // (delete na Evolution, delete local, limpeza de grupos ou reordenacao).
      console.error(
        JSON.stringify({
          event: "whatsapp_instances.remove.failed",
          instance_id: req.params.id,
          error_message: message,
          error_code: error?.code,
        })
      );

      // 23503 = foreign_key_violation. Acontece quando a migration
      // 202609010001_fix_logs_whatsapp_instance_fk_on_delete.sql ainda nao
      // rodou neste banco: a FK logs.whatsapp_instance_id foi criada sem
      // ON DELETE, entao qualquer numero que ja disparou alguma mensagem fica
      // travado (numeros novos, sem historico, removiam normalmente - o que
      // mascarava a causa). Sem esta ramificacao o erro chegava na tela como um
      // "Internal server error" opaco, sem indicar o que fazer.
      if (error?.code === "23503") {
        return res.status(503).json({
          error:
            "Este numero tem historico de disparos e a FK logs.whatsapp_instance_id ainda bloqueia a remocao. Aplique a migration 202609010001_fix_logs_whatsapp_instance_fk_on_delete.sql para liberar.",
        });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // PATCH .../:id/pause com { paused: true|false }. Nao toca na Evolution API:
  // a instancia continua conectada, so deixa (ou volta) a ser usada nos envios.
  async function setPaused(req, res) {
    try {
      const paused = (req.body || {}).paused;

      if (typeof paused !== "boolean") {
        return res.status(400).json({ error: "paused must be a boolean" });
      }

      const instance = await service.setInstancePaused(req.params.id, paused);

      return res.status(200).json(instance);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Instance not found") {
        return res.status(404).json({ error: message });
      }

      // 42703 = undefined_column no Postgres. Acontece quando a migration
      // 202608310001_add_whatsapp_instances_paused.sql ainda nao rodou neste
      // banco: sem ela a coluna paused_at nao existe e o UPDATE estoura. Sem
      // esta ramificacao o erro chegava na tela como um "Internal server error"
      // opaco, sem indicar o que fazer.
      if (error?.code === "42703" || /paused_at/.test(message)) {
        console.error(
          JSON.stringify({
            event: "whatsapp_instances.set_paused.missing_column",
            error_message: message,
          })
        );

        return res.status(503).json({
          error:
            "A coluna paused_at ainda nao existe neste banco. Aplique a migration 202608310001_add_whatsapp_instances_paused.sql para habilitar a pausa de numeros.",
        });
      }

      console.error(
        JSON.stringify({
          event: "whatsapp_instances.set_paused.failed",
          error_message: message,
        })
      );

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function reorder(req, res) {
    try {
      const result = await service.reorderPriority((req.body || {}).ordered_ids || []);

      return res.status(200).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "orderedIds must be a non-empty array") {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function testConnection(req, res) {
    try {
      const result = await service.testConnection();

      return res.status(200).json(result);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function getRotation(req, res) {
    try {
      const result = await service.getRotationSettings();

      return res.status(200).json(result);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function updateRotation(req, res) {
    try {
      const result = await service.updateRotationSettings(req.body || {});

      return res.status(200).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message.startsWith("whatsapp_rotation_group_count")) {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return {
    getQrCode,
    getRotation,
    getStatus,
    list,
    register,
    remove,
    reorder,
    setPaused,
    testConnection,
    updateRotation,
  };
}

module.exports = createWhatsappInstancesController;
