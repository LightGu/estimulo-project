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
  });

  return sanitizeUser(user);
}

async function listUsers(deps = {}) {
  const repository = deps.appUsersRepository || appUsersRepositoryDefault;
  return repository.findAll();
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

module.exports = {
  authenticate,
  createUser,
  listUsers,
  setActive,
  setAdmin,
  updatePassword,
};
