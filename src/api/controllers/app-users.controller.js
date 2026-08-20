const crypto = require("node:crypto");

// Comparacao em tempo constante mesmo quando os tamanhos diferem, para nao
// vazar via timing quantos caracteres da senha mestra o chamador acertou.
function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");

  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

function createAppUsersController(dependencies = {}) {
  const authService = dependencies.authService;

  // Segunda camada de protecao alem da sessao de login: mesmo um usuario ja
  // autenticado no painel precisa saber essa senha mestra (env
  // ESTIMULO_ADMIN_MASTER_PASSWORD) para criar ou reativar/desativar outros
  // logins.
  function assertMasterPassword(masterPassword) {
    const expected = process.env.ESTIMULO_ADMIN_MASTER_PASSWORD || "";

    if (!expected) {
      throw new Error("ESTIMULO_ADMIN_MASTER_PASSWORD nao configurada no servidor.");
    }

    if (!timingSafeEqualStrings(masterPassword, expected)) {
      throw new Error("Senha mestra incorreta.");
    }
  }

  async function list(req, res) {
    try {
      const users = await authService.listUsers();

      return res.status(200).json(users);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function create(req, res) {
    try {
      const { username, password, master_password } = req.body || {};
      assertMasterPassword(master_password);

      const user = await authService.createUser({ username, password });

      return res.status(201).json(user);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Senha mestra incorreta.") {
        return res.status(403).json({ error: message });
      }

      if (message === "ESTIMULO_ADMIN_MASTER_PASSWORD nao configurada no servidor.") {
        return res.status(500).json({ error: message });
      }

      if (message === "Informe um nome de usuario." || message.startsWith("A senha deve ter")) {
        return res.status(400).json({ error: message });
      }

      if (error?.code === "23505" || message.includes("duplicate key")) {
        return res.status(409).json({ error: "Ja existe um usuario com esse nome." });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function setActive(req, res) {
    try {
      const { active, master_password } = req.body || {};
      assertMasterPassword(master_password);

      const user = await authService.setActive(req.params.id, Boolean(active));

      return res.status(200).json(user);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Senha mestra incorreta.") {
        return res.status(403).json({ error: message });
      }

      if (message === "ESTIMULO_ADMIN_MASTER_PASSWORD nao configurada no servidor.") {
        return res.status(500).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return { list, create, setActive };
}

module.exports = createAppUsersController;
