function createAppUsersController(dependencies = {}) {
  const authService = dependencies.authService;

  async function list(req, res) {
    try {
      const users = await authService.listUsers();

      return res.status(200).json(users);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // Protegido por authGate.requireAdmin (ver app.js): so chega aqui quem ja
  // esta logado com is_admin=true na propria conta.
  async function create(req, res) {
    try {
      const { username, password, is_admin } = req.body || {};
      const user = await authService.createUser({ username, password, is_admin: Boolean(is_admin) });

      return res.status(201).json(user);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Informe um nome de usuario." || message.startsWith("A senha deve ter")) {
        return res.status(400).json({ error: message });
      }

      if (error?.code === "23505" || message.includes("duplicate key")) {
        return res.status(409).json({ error: "Ja existe um usuario com esse nome." });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // Tambem protegido por authGate.requireAdmin.
  async function setActive(req, res) {
    try {
      const { active } = req.body || {};
      const user = await authService.setActive(req.params.id, Boolean(active));

      return res.status(200).json(user);
    } catch (error) {
      return res.status(500).json({ error: error?.message || "Internal server error" });
    }
  }

  // Tambem protegido por authGate.requireAdmin.
  async function remove(req, res) {
    try {
      const user = await authService.removeUser(req.params.id, { currentUserId: req.user?.id });

      return res.status(200).json(user);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        [
          "Voce nao pode apagar o proprio login.",
          "Nao e possivel apagar o unico administrador do painel.",
        ].includes(message)
      ) {
        return res.status(400).json({ error: message });
      }

      if (message === "Usuario nao encontrado.") {
        return res.status(404).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return { list, create, setActive, remove };
}

module.exports = createAppUsersController;
