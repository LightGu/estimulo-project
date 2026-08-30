const appUsersRepositoryDefault = require("../repositories/app-users.repository");
const { hashPassword, verifyPassword } = require("../utils/password");

const MIN_PASSWORD_LENGTH = 8;

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function sanitizeUser(user) {
  if (!user) return null;

  const { password_hash, ...rest } = user;
  return rest;
}

function assertValidPassword(password) {
  if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
    throw new Error(`A senha deve ter ao menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }
}

// Verifica usuario/senha contra a tabela app_users (Supabase). Devolve o
// usuario (sem o hash) em caso de sucesso, ou null para qualquer falha -
// usuario inexistente, inativo ou senha incorreta sempre retornam o mesmo
// null, para nao revelar ao chamador qual dessas causas ocorreu.
async function authenticate({ username, password }, deps = {}) {
  const repository = deps.appUsersRepository || appUsersRepositoryDefault;
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername || !password) {
    return null;
  }

  const user = await repository.findByUsername(normalizedUsername);
  if (!user || !user.active) {
    return null;
  }

  if (!verifyPassword(password, user.password_hash)) {
    return null;
  }

  await repository.touchLastLogin(user.id).catch(() => {
    // Nao bloqueia o login se so a atualizacao do last_login_at falhar.
  });

  return sanitizeUser(user);
}

async function createUser({ username, password, active = true, is_admin = false }, deps = {}) {
  const repository = deps.appUsersRepository || appUsersRepositoryDefault;
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername) {
    throw new Error("Informe um nome de usuario.");
  }

  assertValidPassword(password);

  const user = await repository.create({
    username: normalizedUsername,
    password_hash: hashPassword(password),
    active,
    is_admin: Boolean(is_admin),
    display_name: normalizedUsername,
  });

  return sanitizeUser(user);
}

async function listUsers(deps = {}) {
  const repository = deps.appUsersRepository || appUsersRepositoryDefault;
  return repository.findAll();
}

// Usado pelo /access/status para ler o display_name sempre atualizado - a
// sessao (ate 7 dias de validade) so guarda userId/username/isAdmin, entao
// sem esse lookup ao vivo o chip continuaria com o nome antigo ate a pessoa
// deslogar e logar de novo, mesmo depois de editar o proprio nome.
async function getUserById(id, deps = {}) {
  const repository = deps.appUsersRepository || appUsersRepositoryDefault;
  if (!id) return null;

  const user = await repository.findById(id);
  return sanitizeUser(user);
}

async function updatePassword(id, password, deps = {}) {
  const repository = deps.appUsersRepository || appUsersRepositoryDefault;
  assertValidPassword(password);

  const user = await repository.update(id, { password_hash: hashPassword(password) });
  return sanitizeUser(user);
}

async function setActive(id, active, deps = {}) {
  const repository = deps.appUsersRepository || appUsersRepositoryDefault;
  const user = await repository.update(id, { active: Boolean(active) });
  return sanitizeUser(user);
}

async function setAdmin(id, isAdmin, deps = {}) {
  const repository = deps.appUsersRepository || appUsersRepositoryDefault;
  const user = await repository.update(id, { is_admin: Boolean(isAdmin) });
  return sanitizeUser(user);
}

// Nome exibido no user-chip (canto superior direito) - propriedade da PROPRIA
// conta, ao contrario do antigo settings.profile_name (uma linha global unica
// que todo mundo compartilhava e via mudar quando qualquer pessoa editava).
async function updateDisplayName(id, displayName, deps = {}) {
  const repository = deps.appUsersRepository || appUsersRepositoryDefault;
  const trimmed = String(displayName || "").trim();

  if (!trimmed) {
    throw new Error("Informe um nome de exibicao.");
  }

  const user = await repository.update(id, { display_name: trimmed });
  return sanitizeUser(user);
}

// currentUserId: quem esta fazendo a chamada (req.user.id, injetado pelo
// authGate a partir da sessao) - nunca o proprio alvo da exclusao, senao um
// admin se auto-remove sem querer e fica sem conseguir desfazer.
async function removeUser(id, { currentUserId } = {}, deps = {}) {
  const repository = deps.appUsersRepository || appUsersRepositoryDefault;

  if (!id) {
    throw new Error("Id do usuario e obrigatorio.");
  }

  if (currentUserId && String(currentUserId) === String(id)) {
    throw new Error("Voce nao pode apagar o proprio login.");
  }

  const target = await repository.findById(id);

  if (!target) {
    throw new Error("Usuario nao encontrado.");
  }

  // Sem isso, apagar o ultimo admin trava o painel: ninguem mais teria acesso
  // a aba de Usuarios para criar/reativar outro admin.
  if (target.is_admin) {
    const allUsers = await repository.findAll();
    const remainingAdmins = allUsers.filter((user) => user.is_admin && user.id !== id);

    if (remainingAdmins.length === 0) {
      throw new Error("Nao e possivel apagar o unico administrador do painel.");
    }
  }

  const removed = await repository.remove(id);
  return sanitizeUser(removed);
}

module.exports = {
  authenticate,
  createUser,
  getUserById,
  listUsers,
  removeUser,
  setActive,
  setAdmin,
  updateDisplayName,
  updatePassword,
};
