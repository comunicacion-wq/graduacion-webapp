import bcrypt from "bcryptjs";
import { q } from "./db.js";

async function main() {
  const username = "admin";
  const password = "Admin1234!";
  const hash = await bcrypt.hash(password, 10);

  const existing = await q(`SELECT id FROM users WHERE username=$1`, [username]);
  if (existing.rows[0]) {
    console.log("Admin ya existe:", username);
    process.exit(0);
  }

  const u = await q(
    `INSERT INTO users(username, password_hash, role) VALUES ($1,$2,'ADMIN') RETURNING id`,
    [username, hash]
  );
  console.log("Admin creado");
  console.log("usuario:", username);
  console.log("contraseña:", password);
  console.log("id:", u.rows[0].id);
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
