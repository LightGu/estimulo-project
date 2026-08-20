// Gerencia contas de login do painel (tabela app_users no Supabase).
//
// Uso:
//   node scripts/manage-app-user.js create <usuario> <senha>
//   node scripts/manage-app-user.js set-password <usuario> <nova-senha>
//   node scripts/manage-app-user.js activate <usuario>
//   node scripts/manage-app-user.js deactivate <usuario>
//   node scripts/manage-app-user.js list
//
// Esta e' a forma "facil de adicionar outro login" pedida: nao existe UI de
// cadastro de usuarios ainda, entao criar/gerenciar contas passa por aqui.
require("dotenv").config({ quiet: true });

const authService = require("../src/services/auth.service");
const appUsersRepository = require("../src/repositories/app-users.repository");

function printUsage() {
  console.log(`Uso:
  node scripts/manage-app-user.js create <usuario> <senha>
  node scripts/manage-app-user.js set-password <usuario> <nova-senha>
  node scripts/manage-app-user.js activate <usuario>
  node scripts/manage-app-user.js deactivate <usuario>
  node scripts/manage-app-user.js list`);
}

async function findUserOrFail(username) {
  const user = await appUsersRepository.findByUsername(String(username || "").trim().toLowerCase());
  if (!user) {
    throw new Error(`Usuario "${username}" nao encontrado.`);
  }
  return user;
}

async function main() {
  const [action, ...args] = process.argv.slice(2);

  if (!action) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (action === "create") {
    const [username, password] = args;
    if (!username || !password) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    const user = await authService.createUser({ username, password });
    console.log(`Usuario criado: ${user.username} (id ${user.id})`);
    return;
  }

  if (action === "set-password") {
    const [username, password] = args;
    if (!username || !password) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    const existing = await findUserOrFail(username);
    await authService.updatePassword(existing.id, password);
    console.log(`Senha atualizada para o usuario "${existing.username}".`);
    return;
  }

  if (action === "activate" || action === "deactivate") {
    const [username] = args;
    if (!username) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    const existing = await findUserOrFail(username);
    await authService.setActive(existing.id, action === "activate");
    console.log(`Usuario "${existing.username}" ${action === "activate" ? "ativado" : "desativado"}.`);
    return;
  }

  if (action === "list") {
    const users = await authService.listUsers();
    if (!users.length) {
      console.log("Nenhum usuario cadastrado ainda.");
      return;
    }

    users.forEach((user) => {
      const status = user.active ? "ativo" : "inativo";
      const lastLogin = user.last_login_at ? new Date(user.last_login_at).toLocaleString("pt-BR") : "nunca";
      console.log(`${user.username}  [${status}]  ultimo login: ${lastLogin}`);
    });
    return;
  }

  printUsage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
