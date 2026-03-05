import pg from "pg";

const { Pool } = pg;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("❌ DATABASE_URL no está definida en variables de entorno.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
  });

  try {
    console.log("🔌 Conectando a la base de datos...");
    const client = await pool.connect();

    console.log("🧱 Creando tabla users si no existe...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    client.release();
    console.log("✅ Listo: tabla users verificada/creada.");
  } catch (err) {
    console.error("❌ Error creando tablas:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
