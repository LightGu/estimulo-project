const assert = require("node:assert/strict");

const { hashPassword, verifyPassword } = require("../src/utils/password");
const authService = require("../src/services/auth.service");

// Ate aqui nenhum teste do projeto exercitava o caminho real de auth: todo
// teste de HTTP (auth-gate.test.js, app-users-*.test.js) injeta um
// fakeAuthService com comparacao de senha em texto plano, entao o
// hash/verify de verdade (scrypt, em src/utils/password.js) e o
// src/services/auth.service.js nunca rodavam. Uma regressao no salt, no
// scrypt ou na logica de authenticate passaria por todo o resto da suite
// sem ser notada.

function createInMemoryAppUsersRepository(seedUsers = []) {
  let nextId = 1;
  const usersById = new Map();

  for (const user of seedUsers) {
    usersById.set(user.id, user);
  }

  return {
    async findByUsername(username) {
      for (const user of usersById.values()) {
        if (user.username === username) return { ...user };
      }
      return null;
    },
    async findById(id) {
      const user = usersById.get(id);
      return user ? { ...user } : null;
    },
    async findAll() {
      return Array.from(usersById.values()).map((user) => ({ ...user }));
    },
    async create(payload) {
      const id = `user-${nextId++}`;
      const now = new Date().toISOString();
      const user = { id, created_at: now, updated_at: now, last_login_at: null, ...payload };
      usersById.set(id, user);
      return { ...user };
    },
    async update(id, payload) {
      const existing = usersById.get(id);
      if (!existing) throw new Error("not found");
      const updated = { ...existing, ...payload, updated_at: new Date().toISOString() };
      usersById.set(id, updated);
      return { ...updated };
    },
    async remove(id) {
      const existing = usersById.get(id) || null;
      usersById.delete(id);
      return existing ? { ...existing } : null;
    },
    async touchLastLogin(id) {
      const existing = usersById.get(id);
      if (!existing) return null;
      existing.last_login_at = new Date().toISOString();
      return { ...existing };
    },
  };
}

async function main() {
  // ---------- src/utils/password.js: hash/verify real (scrypt) ----------
  {
    const hash = hashPassword("senha-correta-123");

    assert.match(hash, /^scrypt:[0-9a-f]+:[0-9a-f]+$/, "formato scrypt:<salt>:<hash>");
    assert.equal(verifyPassword("senha-correta-123", hash), true);
    assert.equal(verifyPassword("senha-errada-123", hash), false);

    // Duas senhas iguais nunca geram o mesmo hash (salt aleatorio por chamada).
    const hashAgain = hashPassword("senha-correta-123");
    assert.notEqual(hash, hashAgain);
    assert.equal(verifyPassword("senha-correta-123", hashAgain), true);

    // Hash malformado/corrompido nunca deve lancar - so falhar a verificacao.
    assert.equal(verifyPassword("qualquer", null), false);
    assert.equal(verifyPassword("qualquer", ""), false);
    assert.equal(verifyPassword("qualquer", "nao-e-um-hash-scrypt"), false);
    assert.equal(verifyPassword("qualquer", "md5:abc:def"), false);
    assert.equal(verifyPassword("qualquer", "scrypt:salt-invalido-nao-hex:aabbcc"), false);
    assert.equal(verifyPassword(undefined, hash), false);
  }

  // ---------- auth.service.js: createUser realmente hasheia (nunca grava texto puro) ----------
  {
    const repository = createInMemoryAppUsersRepository();
    const created = await authService.createUser(
      { username: "Admin.Teste", password: "senhaForte123" },
      { appUsersRepository: repository }
    );

    assert.equal(created.username, "admin.teste", "username e normalizado para minusculo");
    assert.equal(created.password_hash, undefined, "sanitizeUser nunca deve devolver o hash ao chamador");

    const stored = await repository.findByUsername("admin.teste");
    assert.notEqual(stored.password_hash, "senhaForte123", "a senha nunca fica em texto puro no repositorio");
    assert.match(stored.password_hash, /^scrypt:/);

    await assert.rejects(
      () => authService.createUser({ username: "outro", password: "curta" }, { appUsersRepository: repository }),
      /ao menos 8 caracteres/
    );
  }

  // ---------- auth.service.js: authenticate exercitando o scrypt de verdade ----------
  {
    const repository = createInMemoryAppUsersRepository();
    await authService.createUser(
      { username: "operador", password: "senhaForte123", active: true },
      { appUsersRepository: repository }
    );

    const ok = await authService.authenticate(
      { username: "operador", password: "senhaForte123" },
      { appUsersRepository: repository }
    );
    assert.ok(ok, "credenciais corretas devem autenticar");
    assert.equal(ok.username, "operador");
    assert.equal(ok.password_hash, undefined);

    const wrongPassword = await authService.authenticate(
      { username: "operador", password: "senha-errada" },
      { appUsersRepository: repository }
    );
    assert.equal(wrongPassword, null);

    const unknownUser = await authService.authenticate(
      { username: "nao-existe", password: "senhaForte123" },
      { appUsersRepository: repository }
    );
    assert.equal(unknownUser, null);

    // Usuario inativo: mesma senha certa, mesmo retorno null que usuario
    // inexistente/senha errada - authenticate nunca revela qual foi a causa.
    await authService.createUser(
      { username: "desativado", password: "senhaForte123", active: false },
      { appUsersRepository: repository }
    );
    const inactiveUser = await authService.authenticate(
      { username: "desativado", password: "senhaForte123" },
      { appUsersRepository: repository }
    );
    assert.equal(inactiveUser, null);

    // touchLastLogin e chamado no sucesso (usado para auditoria de acesso).
    const stored = await repository.findByUsername("operador");
    assert.ok(stored.last_login_at, "login bem sucedido registra last_login_at");
  }

  // ---------- auth.service.js: updatePassword rehasheia ----------
  {
    const repository = createInMemoryAppUsersRepository();
    const created = await authService.createUser(
      { username: "trocar-senha", password: "senhaAntiga1" },
      { appUsersRepository: repository }
    );

    await authService.updatePassword(created.id, "senhaNova123", { appUsersRepository: repository });

    const failsWithOldPassword = await authService.authenticate(
      { username: "trocar-senha", password: "senhaAntiga1" },
      { appUsersRepository: repository }
    );
    assert.equal(failsWithOldPassword, null, "senha antiga deixa de funcionar apos a troca");

    const worksWithNewPassword = await authService.authenticate(
      { username: "trocar-senha", password: "senhaNova123" },
      { appUsersRepository: repository }
    );
    assert.ok(worksWithNewPassword, "senha nova passa a funcionar");
  }

  // ---------- auth.service.js: removeUser - protecoes de admin ----------
  {
    const repository = createInMemoryAppUsersRepository();
    const admin = await authService.createUser(
      { username: "unico-admin", password: "senhaForte123", is_admin: true },
      { appUsersRepository: repository }
    );

    await assert.rejects(
      () => authService.removeUser(admin.id, { currentUserId: admin.id }, { appUsersRepository: repository }),
      /nao pode apagar o proprio login/
    );

    await assert.rejects(
      () => authService.removeUser(admin.id, { currentUserId: "outro-id" }, { appUsersRepository: repository }),
      /unico administrador/
    );

    const secondAdmin = await authService.createUser(
      { username: "segundo-admin", password: "senhaForte123", is_admin: true },
      { appUsersRepository: repository }
    );

    // Com dois admins, remover um deles (por outra pessoa) e permitido.
    const removed = await authService.removeUser(
      admin.id,
      { currentUserId: secondAdmin.id },
      { appUsersRepository: repository }
    );
    assert.equal(removed.username, "unico-admin");
  }

  console.log("auth service password tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
