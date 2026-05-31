import express from "express";
import session from "express-session";
import path from "path";
import PDFDocument from "pdfkit";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import dayjs from "dayjs";
import multer from "multer";
import xlsx from "xlsx";
import { fileURLToPath } from "url";

import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";

import { q } from "./db.js";
import { requireAuth, requireRole } from "./security.js";
import { sendWhatsApp } from "./whatsapp.js";
import { getStudentTotals } from "./totals.js";
import { generateLiquidationPDF } from "./pdf.js";

dotenv.config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "comprobantes",
    allowed_formats: ["jpg", "png", "jpeg", "pdf"]
  }
});

const upload = multer({ storage });

const uploadExcel = multer({ storage: multer.memoryStorage() });

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
app.use(session({
  secret: process.env.SESSION_SECRET || "dev_secret",
  resave: false,
  saveUninitialized: false
}));

// flash messages (simple)
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || [];
  req.session.flash = [];
  res.locals.user = req.session.user || null;
  next();
});
function flash(req, type, msg) {
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ type, msg });
}

function render(req, res, view, params) {
  res.render("layout", {
    title: params.title || "Graduación",
    active: params.active || "",
    user: req.session.user,
    flash: res.locals.flash,
    body: params.body
  });
}

// helper: load catalogs
async function catalogs() {
  const [campuses, shifts, periods, years, careers, packages] = await Promise.all([
    q(`SELECT * FROM campuses WHERE active=true ORDER BY name`),
    q(`SELECT * FROM shifts WHERE active=true ORDER BY name`),
    q(`SELECT * FROM graduation_periods WHERE active=true ORDER BY id`),
    q(`SELECT * FROM graduation_years WHERE active=true ORDER BY year`),
    q(`SELECT * FROM careers WHERE active=true ORDER BY name`),
    q(`SELECT * FROM packages WHERE active=true ORDER BY id`)
  ]);
  return {
    campuses: campuses.rows,
    shifts: shifts.rows,
    periods: periods.rows,
    years: years.rows,
    careers: careers.rows,
    packages: packages.rows
  };
}

// helper: apply filters to students query and compute balances inline
function studentQueryWhere(filters, user) {
  const w = [];
  const p = [];
  let i = 1;
  
if (filters.status === "GRADUATED") {
  w.push(`COALESCE(s.status, 'ACTIVE') = 'GRADUATED'`);
} else if (filters.status === "ALL") {
  // no filtrar
} else {
  w.push(`COALESCE(s.status, 'ACTIVE') = 'ACTIVE'`);
}
  
  const add = (cond, val) => { w.push(cond.replace("?", `$${i++}`)); p.push(val); };

  if (filters.campus_id) add("s.campus_id = ?", Number(filters.campus_id));
  if (filters.shift_id) add("s.shift_id = ?", Number(filters.shift_id));
  if (filters.period_id) add("s.period_id = ?", Number(filters.period_id));
  if (filters.year_id) add("s.year_id = ?", Number(filters.year_id));
  
if (filters.q) {
  w.push(`(LOWER(s.full_name) LIKE $${i} OR s.phone_e164 LIKE $${i + 1})`);
  p.push(`%${filters.q.toLowerCase()}%`);
  p.push(`%${filters.q}%`);
  i += 2;
}
  // Restrict cajero to campuses assigned
  if (user.role === "CAJERO") {
    const ids = user.campuses || [];
    if (ids.length) {
      w.push(`s.campus_id = ANY($${i++})`);
      p.push(ids);
    }
  }

  const where = w.length ? "WHERE " + w.join(" AND ") : "";
  return { where, params: p };
}

async function computeMetrics(filters, user) {
  const { where, params } = studentQueryWhere(filters, user);
  const rows = await q(
    `
    SELECT
  COUNT(*)::int as total_students,
  SUM(CASE WHEN (GREATEST(0, p.cost - COALESCE(s.discount_amount,0)) - COALESCE(pay.total_paid,0)) <= 0 THEN 1 ELSE 0 END)::int as paid,
  SUM(CASE WHEN (GREATEST(0, p.cost - COALESCE(s.discount_amount,0)) - COALESCE(pay.total_paid,0)) > 0 THEN 1 ELSE 0 END)::int as arrears,
  SUM(COALESCE(pay.total_paid,0))::numeric as total_collected,
  SUM(GREATEST(0, p.cost - COALESCE(s.discount_amount,0)) - COALESCE(pay.total_paid,0))::numeric as total_balance
    FROM students s
    LEFT JOIN packages p ON p.id = s.package_id
    LEFT JOIN (
      SELECT student_id, COALESCE(SUM(amount),0) as total_paid
      FROM payments
      WHERE status='CONFIRMED'
      GROUP BY student_id
    ) pay ON pay.student_id = s.id
${where}
AND COALESCE(s.billing_active, false) = true
    `,
    params
  );
return rows.rows[0] || { total_students:0, paid:0, arrears:0, total_collected:0, total_balance:0 };
}

async function getTemplate(code) {
  const r = await q(`SELECT * FROM message_templates WHERE code=$1 AND active=true`, [code]);
  return r.rows[0];
}
function applyVars(body, vars) {
  let out = body;
  for (const [k,v] of Object.entries(vars)) {
    out = out.split(k).join(String(v ?? ""));
  }
  return out;
}

async function audit(req, action, entity, entity_id, details) {
  const actor = req.session.user?.id || null;
  await q(
    `INSERT INTO audit_log(actor_user_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5)`,
    [actor, action, entity, entity_id || null, details || {}]
  );
}

// Auth
app.get("/login", (req,res) => {
  res.render("login", {
    error: null,
    next: req.query.next || ""
  });
});
app.post("/login", async (req,res) => {
  const { username, password } = req.body;
  const r = await q(`SELECT * FROM users WHERE username=$1 AND active=true`, [username]);
  const u = r.rows[0];
  if (!u) return res.render("login", { error: "Usuario o contraseña inválidos" });
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return res.render("login", { error: "Usuario o contraseña inválidos" });

  // campuses assigned for cajeros
  let campuses = [];
  if (u.role === "CAJERO") {
    const c = await q(`SELECT campus_id FROM user_campuses WHERE user_id=$1`, [u.id]);
    campuses = c.rows.map(x => x.campus_id);
  }

req.session.user = {
  id: u.id,
  username: u.username,
  role: u.role,
  campuses,
  permissions: u.permissions || {}
};
  await audit(req, "LOGIN", "USER", u.id, {});
  res.redirect(req.body.next || "/");
});
app.get("/logout", requireAuth, async (req,res) => {
  await audit(req, "LOGOUT", "USER", req.session.user.id, {});
  req.session.destroy(() => res.redirect("/login"));
});

// Dashboard
app.get("/", requireAuth, async (req,res) => {
  const filters = {
    campus_id: req.query.campus_id || "",
    period_id: req.query.period_id || "",
    year_id: req.query.year_id || ""
  };
  const cats = await catalogs();
  const metrics = await computeMetrics(filters, req.session.user);

  const body = await new Promise((resolve, reject) => {
    res.render("dashboard", { ...cats, filters, metrics }, (err, html) => err ? reject(err) : resolve(html));
  });
  render(req,res,"layout", { title:"Dashboard", active:"dashboard", body });
});

// Students list
app.get("/students", requireAuth, async (req,res) => {
  const filters = {
    campus_id: req.query.campus_id || "",
    shift_id: req.query.shift_id || "",
    period_id: req.query.period_id || "",
    year_id: req.query.year_id || "",
    status: req.query.status || "",
    q: req.query.q || ""
  };
  const cats = await catalogs();
  const { where, params } = studentQueryWhere(filters, req.session.user);

  const s = await q(
    `
    SELECT s.*,
      c.name as campus_name,
      sh.name as shift_name,
      gp.name as period_name,
      gy.year as grad_year,
      p.name as package_name,
      (GREATEST(0, p.cost - COALESCE(s.discount_amount,0)) - COALESCE(pay.total_paid,0))::numeric as balance
    FROM students s
    LEFT JOIN campuses c ON c.id = s.campus_id
    LEFT JOIN shifts sh ON sh.id = s.shift_id
    LEFT JOIN graduation_periods gp ON gp.id = s.period_id
    LEFT JOIN graduation_years gy ON gy.id = s.year_id
    LEFT JOIN packages p ON p.id = s.package_id
    LEFT JOIN (
      SELECT student_id, COALESCE(SUM(amount),0) as total_paid
      FROM payments WHERE status='CONFIRMED'
      GROUP BY student_id
    ) pay ON pay.student_id = s.id
    ${where}
    ORDER BY s.created_at DESC
    LIMIT 500
    `,
    params
  );

  const body = await new Promise((resolve, reject) => {
    res.render("students_list", { ...cats, filters, students: s.rows }, (err, html) => err ? reject(err) : resolve(html));
  });
  render(req,res,"layout", { title:"Alumnos", active:"students", body });
});
app.get("/test-whatsapp", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    await sendWhatsApp({
      toE164: "+5218995010005",
      body: "Prueba de WhatsApp desde graduacion-webapp. Si te llegó este mensaje, la conexión quedó correcta."
    });

    res.send("WhatsApp enviado correctamente.");
  } catch (err) {
    console.error("Error en prueba WhatsApp:", err);
    res.status(500).send("Error enviando WhatsApp.");
  }
});

app.get("/students/export", requireAuth, async (req,res) => {
 const cats = await catalogs();
  const body = `
    <div class="card">
      <div class="card-body">
        <h3>Generar reporte de alumnos</h3>
        <p>Selecciona las columnas que quieres descargar:</p>
        <br>
        <form method="GET" action="/students/export/download">
        <div class="row mb-3">

  <div class="col-md-4">
    <label>Campus</label>
    <select class="form-control" name="campus_id">
      <option value="">Todos</option>
      ${cats.campuses.map(c => `<option value="${c.id}">${c.name}</option>`).join("")}
    </select>
  </div>

  <div class="col-md-4">
    <label>Turno</label>
    <select class="form-control" name="shift_id">
      <option value="">Todos</option>
      ${cats.shifts.map(s => `<option value="${s.id}">${s.name}</option>`).join("")}
    </select>
  </div>

  <div class="col-md-4">
    <label>Periodo</label>
    <select class="form-control" name="period_id">
      <option value="">Todos</option>
      ${cats.periods.map(p => `<option value="${p.id}">${p.name}</option>`).join("")}
    </select>
  </div>

</div>

<div class="row mb-3">

  <div class="col-md-4">
    <label>Año</label>
    <select class="form-control" name="year_id">
      <option value="">Todos</option>
      ${cats.years.map(y => `<option value="${y.id}">${y.year}</option>`).join("")}
    </select>
  </div>

  <div class="col-md-4">
    <label>Carrera</label>
    <select class="form-control" name="career_id">
      <option value="">Todas</option>
      ${cats.careers.map(c => `<option value="${c.id}">${c.name}</option>`).join("")}
    </select>
  </div>

  <div class="col-md-2">
    <label>Grado</label>
    <input class="form-control" name="grade" placeholder="Ej. 1, 2, 3">
  </div>

  <div class="col-md-2">
    <label>Grupo</label>
    <input class="form-control" name="group" placeholder="Ej. A, B, C">
  </div>

</div>

<div class="col-md-4">
<label>Año</label>
<select class="form-control">
<option>Todos</option>
${cats.years.map(y => `<option>${y.year}</option>`).join("")}
</select>
</div>

</div>

        <form method="GET" action="/students">
          <div class="form-check">
            <input class="form-check-input" type="checkbox" checked>
            <label class="form-check-label">Nombre completo</label>
          </div>
          <div class="form-check">
            <input class="form-check-input" type="checkbox">
            <label class="form-check-label">Teléfono</label>
          </div>
       
      
          </div>
          <div class="form-check">
            <input class="form-check-input" type="checkbox">
            <label class="form-check-label">Paquete</label>
          </div>

          <hr>

          <h5>Formato de descarga</h5>

          <div class="form-check">
            <input class="form-check-input" type="radio" name="format" checked>
            <label class="form-check-label">Excel</label>
          </div>
          <div class="form-check">
            <input class="form-check-input" type="radio" name="format">
            <label class="form-check-label">PDF</label>
          </div>
          <div class="form-check">
            <input class="form-check-input" type="radio" name="format">
            <label class="form-check-label">Imagen</label>
          </div>

          <br>

          <button class="btn btn-primary" type="submit">Generar archivo</button>
        </form>
      </div>
    </div>
  `;

  render(req, res, "layout", {
    title: "Exportar alumnos",
    active: "students",
    body
});
});

app.get("/students/export/download", requireAuth, async (req, res) => {
  try {
    const students = await q(`
  SELECT 
    s.full_name,
    s.phone_e164,
    c.name AS campus,
    sh.name AS turno,
    gp.name AS periodo,
    gy.year AS anio,
    ca.name AS carrera,
    s.grade,
    s."group" AS grupo,
    p.name AS paquete,
COALESCE(p.cost, 0) AS total_paquete,
COALESCE(SUM(CASE WHEN pay.status = 'CONFIRMED' THEN pay.amount ELSE 0 END), 0) AS abonado,
COALESCE(p.cost, 0) - COALESCE(SUM(CASE WHEN pay.status = 'CONFIRMED' THEN pay.amount ELSE 0 END), 0) AS saldo_pendiente
  FROM students s
  LEFT JOIN campuses c ON c.id = s.campus_id
  LEFT JOIN shifts sh ON sh.id = s.shift_id
  LEFT JOIN graduation_periods gp ON gp.id = s.period_id
  LEFT JOIN graduation_years gy ON gy.id = s.year_id
  LEFT JOIN careers ca ON ca.id = s.career_id
  LEFT JOIN packages p ON p.id = s.package_id
  LEFT JOIN payments pay ON pay.student_id = s.id
  GROUP BY
    s.id,
    s.full_name,
    s.phone_e164,
    c.name,
    sh.name,
    gp.name,
    gy.year,
    ca.name,
    s.grade,
    s."group",
    p.name,
    p.cost
  ORDER BY s.full_name ASC
`);

    let csv = "Nombre,Telefono,Campus,Turno,Periodo,Anio,Carrera,Grado,Grupo,Paquete,Abonado,Saldo pendiente\n";

students.rows.forEach((s) => {
  csv += [
    s.full_name || "",
    s.phone_e164 || "",
    s.campus || "",
    s.turno || "",
    s.periodo || "",
    s.anio || "",
    s.carrera || "",
    s.grade || "",
    s.grupo || "",
    s.paquete || "",
    s.abonado || 0,
    s.saldo_pendiente || 0
  ].join(",") + "\n";
});
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=alumnos.csv");
    return res.send(csv);

  } catch (err) {
    console.error(err);
    return res.status(500).send("Error al generar archivo");
  }
});
app.get("/students/check-duplicate", requireAuth, requireRole("ADMIN","CAJERO"), async (req, res) => {
  try {
    const fullName = (req.query.full_name || "").trim();
    const phone = (req.query.phone_e164 || "").trim();

    if (!fullName && !phone) {
      return res.json({ exact: [], similar: [] });
    }

    const exactConditions = [];
    const exactParams = [];
    let i = 1;

    if (phone) {
      exactConditions.push(`phone_e164 = $${i++}`);
      exactParams.push(phone);
    }

    if (fullName) {
      exactConditions.push(`LOWER(full_name) = LOWER($${i++})`);
      exactParams.push(fullName);
    }

    let exact = { rows: [] };

    if (exactConditions.length) {
      exact = await q(
        `
        SELECT id, full_name, phone_e164
        FROM students
        WHERE ${exactConditions.join(" OR ")}
        ORDER BY created_at DESC
        LIMIT 5
        `,
        exactParams
      );
    }

    let similar = { rows: [] };

    if (fullName) {
      similar = await q(
        `
        SELECT id, full_name, phone_e164
        FROM students
        WHERE LOWER(full_name) LIKE LOWER($1)
        ORDER BY created_at DESC
        LIMIT 5
        `,
        [`%${fullName}%`]
      );
    }

    return res.json({
      exact: exact.rows,
      similar: similar.rows.filter(s => !exact.rows.some(e => e.id === s.id))
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ exact: [], similar: [], error: "Error revisando duplicados" });
  }
});
app.get("/students/check-duplicate-name", requireAuth, requireRole("ADMIN","CAJERO"), async (req, res) => {
  try {
    const name = (req.query.name || "").trim().toLowerCase();

    if (name.length < 5) {
      return res.json({ matches: [] });
    }

    const words = name
      .split(/\s+/)
      .filter(Boolean);

    if (words.length < 2) {
      return res.json({ matches: [] });
    }

    const search = `%${words.join("%")}%`;

    const result = await q(
      `SELECT id, full_name, phone_e164
       FROM students
       WHERE LOWER(full_name) LIKE $1
       ORDER BY full_name ASC
       LIMIT 8`,
      [search]
    );

    return res.json({ matches: result.rows });
  } catch (err) {
    console.error("Error buscando duplicados:", err);
    return res.json({ matches: [] });
  }
});
app.get("/students/new", requireAuth, requireRole("ADMIN","CAJERO"), async (req,res) => {
  const cats = await catalogs();
  const student = {
    campus_id: cats.campuses[0]?.id,
    shift_id: cats.shifts[0]?.id,
    period_id: cats.periods[0]?.id,
    year_id: cats.years[0]?.id,
    package_id: cats.packages[0]?.id,
    discount_amount: 0,
billing_active: false
  };
  // For cajeros: default campus to their first allowed
  if (req.session.user.role === "CAJERO" && req.session.user.campuses?.length) {
    student.campus_id = req.session.user.campuses[0];
  }
  const body = await new Promise((resolve, reject) => {
    res.render("student_form", { mode:"new", action:"/students/new", student, ...cats }, (err, html) => err ? reject(err) : resolve(html));
  });
  render(req,res,"layout", { title:"Nuevo alumno", active:"students", body });
});

function randomPassword(len=10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#";
  let out = "";
  for (let i=0;i<len;i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}

async function createStudentAccountAndSend(req, studentId) {
  // create username=phone, random temp password
  const { student, totals } = (await getStudentTotals(studentId));
const parts = (student.full_name || "").toLowerCase().trim().split(/\s+/);
const nombre = parts[0] || "";
const apellido = parts[1] || "";

let baseUsername = (nombre + apellido.substring(0, 2))
  .replace(/[^a-z0-9]/g, "")
  .trim();

if (!baseUsername) {
  baseUsername = `alumno${studentId}`;
}

let username = baseUsername;
let counter = 1;

while (true) {
  const exists = await q(`SELECT id FROM users WHERE username=$1`, [username]);
  if (!exists.rows[0]) break;
  username = `${baseUsername}${counter}`;
  counter++;
}

const temp = "itccteama";
  const hash = await bcrypt.hash(temp, 10);

  // create user if not exists
  let u = await q(`SELECT id FROM users WHERE username=$1`, [username]);
  let userId;
  if (!u.rows[0]) {
    const ins = await q(`INSERT INTO users(username,password_hash,role) VALUES ($1,$2,'STUDENT') RETURNING id`, [username, hash]);
    userId = ins.rows[0].id;
  } else {
    userId = u.rows[0].id;
    await q(`UPDATE users SET password_hash=$1, active=true WHERE id=$2`, [hash, userId]);
  }
  await q(`INSERT INTO student_accounts(student_id, user_id) VALUES ($1,$2)
           ON CONFLICT (student_id) DO UPDATE SET user_id=EXCLUDED.user_id`, [studentId, userId]);
 
const link = `${process.env.APP_BASE_URL}/portal/login`;

const phone = (student.phone_e164 || "").replace("+", "").trim();

const body = `Hola ${student.full_name}

Tu cuenta fue creada correctamente.

Portal:
${link}

Usuario: ${username}
Contraseña: ${temp}

Te recomendamos cambiar tu contraseña al ingresar.`;

const encodedMessage = encodeURIComponent(body);

const whatsappLink = phone
  ? `https://wa.me/${phone}?text=${encodedMessage}`
  : null;
await q(
  `INSERT INTO message_log(student_id,to_phone_e164,type,body,status) VALUES ($1,$2,$3,$4,$5)`,
  [studentId, student.phone_e164, "CREDENCIALES", body, whatsappLink ? "PENDING_MANUAL" : "NO_PHONE"]
);

await audit(req, "SEND_CREDENTIALS", "STUDENT", studentId, { to: student.phone_e164 });
  return { whatsappLink };
}
app.get("/students/import", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const body = await new Promise((resolve, reject) => {
    res.render("import", {}, (err, html) => err ? reject(err) : resolve(html));
  });

  render(req,res,"layout", {
    title:"Importar Excel",
    active:"students",
    body
  });
});
app.post("/students/new", requireAuth, requireRole("ADMIN","CAJERO"), async (req,res) => {
  const b = req.body;
  const billingActive = b.billing_active === "1";

  const duplicate = await q(
    `SELECT id, full_name
     FROM students
     WHERE LOWER(TRIM(full_name)) = LOWER(TRIM($1))
     LIMIT 1`,
    [b.full_name]
  );

  if (duplicate.rows[0]) {
    flash(req, "danger", "Ya existe un alumno registrado con ese nombre completo.");
    return res.redirect("/students/new");
  }

  if (req.session.user.role === "CAJERO") {
    const allowed = (req.session.user.campuses || []).includes(Number(b.campus_id));
    if (!allowed) {
      flash(req,"danger","No puedes registrar alumnos en ese campus.");
      return res.redirect("/students");
    }
  }

const ins = await q(
  `INSERT INTO students(
    full_name,
    phone_e164,
    campus_id,
    shift_id,
    period_id,
    year_id,
    career_id,
    grade,
    "group",
    package_id,
    discount_amount,
    discount_reason,
    status,
    billing_active
  )
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
  RETURNING id`,
  [
    b.full_name,
    b.phone_e164 && b.phone_e164.trim() ? b.phone_e164.trim() : "",
    Number(b.campus_id),
    Number(b.shift_id),
    Number(b.period_id),
    Number(b.year_id),
    b.career_id ? Number(b.career_id) : null,
    b.grade || "",
    b.group || "",
    Number(b.package_id),
    Number(b.discount_amount || 0),
    b.discount_reason || "",
"ACTIVE",
billingActive
  ]
);

  const studentId = ins.rows[0].id;

  await audit(req, "CREATE_STUDENT", "STUDENT", studentId, { full_name: b.full_name });

  const result = await createStudentAccountAndSend(req, studentId);

if (result?.whatsappLink) {
  return res.redirect(result.whatsappLink);
}
flash(req,"success","Alumno creado correctamente.");
return res.redirect(`/students/${studentId}`);
});
app.get("/students/graduation-groups/pdf", requireAuth, async (req,res) => {

  const { campus, turno, periodo, anio, carrera, grado, grupo } = req.query;

  const r = await q(`
    SELECT
      s.full_name,
      s.phone_e164,
      s.grade,
      s."group",
      c.name AS campus,
      sh.name AS turno,
      gp.name AS periodo,
      gy.year AS anio,
      ca.name AS carrera,
      pk.name AS paquete
    FROM students s
    LEFT JOIN campuses c ON c.id = s.campus_id
    LEFT JOIN shifts sh ON sh.id = s.shift_id
    LEFT JOIN graduation_periods gp ON gp.id = s.period_id
    LEFT JOIN graduation_years gy ON gy.id = s.year_id
    LEFT JOIN careers ca ON ca.id = s.career_id
    LEFT JOIN packages pk ON pk.id = s.package_id
    WHERE
      c.name = $1
      AND sh.name = $2
      AND gp.name = $3
      AND gy.year::text = $4
      AND ca.name = $5
      AND s.grade::text = $6
      AND s."group" = $7
    ORDER BY s.full_name ASC
  `, [
    campus,
    turno,
    periodo,
    anio,
    carrera,
    grado,
    grupo
  ]);

  const doc = new PDFDocument({
    margin: 40,
    size: "LETTER"
  });

  res.setHeader("Content-Type", "application/pdf");

  res.setHeader(
    "Content-Disposition",
    `inline; filename="lista-grupo.pdf"`
  );

  doc.pipe(res);

  doc.fontSize(20).text("Lista de grupo", {
    align: "center"
  });

  doc.moveDown();

  doc.fontSize(11);
  doc.text(`Campus: ${campus}`);
  doc.text(`Turno: ${turno}`);
  doc.text(`Periodo: ${periodo}`);
  doc.text(`Año: ${anio}`);
  doc.text(`Carrera: ${carrera}`);
  doc.text(`Grado: ${grado}`);
  doc.text(`Grupo: ${grupo}`);

  doc.moveDown(2);

  let y = doc.y;

  doc.fontSize(10);

  doc.text("#", 40, y);
  doc.text("Alumno", 70, y);
  doc.text("Teléfono", 280, y);
  doc.text("Paquete", 420, y);

  y += 20;

  r.rows.forEach((s, index) => {

    if (y > 720) {
      doc.addPage();
      y = 50;
    }

    doc.text(String(index + 1), 40, y);

    doc.text(s.full_name || "", 70, y, {
      width: 190
    });

    doc.text(s.phone_e164 || "", 280, y, {
      width: 120
    });

    doc.text(s.paquete || "", 420, y, {
      width: 130
    });

    y += 22;
  });

  doc.end();
});
app.get("/students/graduation-groups", requireAuth, async (req,res) => {
 const cats = await catalogs();

const grades = await q(`
  SELECT DISTINCT grade
  FROM students
  WHERE grade IS NOT NULL AND TRIM(grade) <> ''
  ORDER BY grade
`);

const groupsList = await q(`
  SELECT DISTINCT "group"
  FROM students
  WHERE "group" IS NOT NULL AND TRIM("group") <> ''
  ORDER BY "group"
`);

const filters = {
  campus_id: req.query.campus_id || "",
  shift_id: req.query.shift_id || "",
  period_id: req.query.period_id || "",
  year_id: req.query.year_id || "",
  career_id: req.query.career_id || "",
  grade: req.query.grade || "",
  group: req.query.group || "",
  level: req.query.level || ""
};
  const where = [`COALESCE(s.status, 'ACTIVE') = 'ACTIVE'`];
const params = [];
let i = 1;

if (filters.campus_id) {
  where.push(`s.campus_id = $${i++}`);
  params.push(Number(filters.campus_id));
}

if (filters.shift_id) {
  where.push(`s.shift_id = $${i++}`);
  params.push(Number(filters.shift_id));
}

if (filters.period_id) {
  where.push(`s.period_id = $${i++}`);
  params.push(Number(filters.period_id));
}

if (filters.year_id) {
  where.push(`s.year_id = $${i++}`);
  params.push(Number(filters.year_id));
}

if (filters.career_id) {
  where.push(`s.career_id = $${i++}`);
  params.push(Number(filters.career_id));
}

if (filters.grade) {
  where.push(`s.grade = $${i++}`);
  params.push(filters.grade);
}

if (filters.group) {
  where.push(`s."group" = $${i++}`);
  params.push(filters.group);
}

if (filters.level === "bachillerato") {
  where.push(`ca.name IN ('BCU','BGMIX')`);
}

if (filters.level === "universidad") {
  where.push(`ca.name NOT IN ('BCU','BGMIX')`);
}

const whereSql = where.join(" AND ");

const summaryResult = await q(`
  SELECT
    COUNT(*)::int AS total_alumnos,
    COUNT(DISTINCT CONCAT(COALESCE(s.grade,''), '-', COALESCE(s."group",''), '-', COALESCE(ca.name,''), '-', COALESCE(sh.name,'')))::int AS total_grupos,
    SUM(CASE WHEN ca.name IN ('BCU','BGMIX') THEN 1 ELSE 0 END)::int AS bachillerato,
    SUM(CASE WHEN ca.name NOT IN ('BCU','BGMIX') THEN 1 ELSE 0 END)::int AS universidad
  FROM students s
  LEFT JOIN careers ca ON ca.id = s.career_id
  LEFT JOIN shifts sh ON sh.id = s.shift_id
  WHERE ${whereSql}
`, params);

const groupsResult = await q(`
  SELECT
    c.name AS campus,
    sh.name AS turno,
    gp.name AS periodo,
    gy.year AS anio,
    ca.name AS carrera,
    s.grade AS grado,
    s."group" AS grupo,
    COUNT(*)::int AS total
  FROM students s
  LEFT JOIN campuses c ON c.id = s.campus_id
  LEFT JOIN shifts sh ON sh.id = s.shift_id
  LEFT JOIN graduation_periods gp ON gp.id = s.period_id
  LEFT JOIN graduation_years gy ON gy.id = s.year_id
  LEFT JOIN careers ca ON ca.id = s.career_id
  WHERE ${whereSql}
  GROUP BY c.name, sh.name, gp.name, gy.year, ca.name, s.grade, s."group"
  ORDER BY c.name, sh.name, ca.name, s.grade, s."group"
`, params);

const summary = summaryResult.rows[0];
const groups = groupsResult.rows;
const body = await new Promise((resolve, reject) => {
  res.render("graduation_groups", {
    ...cats,
    filters,
    grades: grades.rows,
    groupsList: groupsList.rows,
summary,
groups
  }, (err, html) => err ? reject(err) : resolve(html));
});

render(req,res,"layout", {
  title:"Grupos a egresar",
  active:"students",
  body
});
  });
app.get("/students/:id", requireAuth, async (req,res) => {
  const studentId = Number(req.params.id);
  // Restrict cajero to campuses
  const info = await getStudentTotals(studentId);
  if (!info) return res.status(404).send("No encontrado");
  const { student, totals } = info;
  if (req.session.user.role === "CAJERO" && !(req.session.user.campuses||[]).includes(student.campus_id)) {
    return res.status(403).send("No autorizado");
  }
  const pay = await q(
    `SELECT p.*, u.username as created_by_username
     FROM payments p
     LEFT JOIN users u ON u.id = p.created_by
     WHERE p.student_id=$1
     ORDER BY p.created_at DESC`,
    [studentId]
  );
  const payments = pay.rows.map(r => ({ ...r, created_at_fmt: dayjs(r.created_at).format("DD/MM/YYYY HH:mm") }));

  const body = await new Promise((resolve, reject) => {
    res.render("student_view", { student, totals, payments, user: req.session.user }, (err, html) => err ? reject(err) : resolve(html));
  });
  render(req,res,"layout", { title:"Alumno", active:"students", body });
});
app.post("/students/:id/toggle-billing", requireAuth, async (req, res) => {
  const studentId = Number(req.params.id);

  const student = await q(
    `SELECT billing_active FROM students WHERE id=$1`,
    [studentId]
  );

  if (!student.rows.length) {
    return res.status(404).send("Alumno no encontrado");
  }

  const current = !!student.rows[0].billing_active;

  await q(
    `UPDATE students
     SET billing_active=$1
     WHERE id=$2`,
    [!current, studentId]
  );

  res.redirect("/students");
});
app.get("/students/:id/edit", requireAuth, requireRole("ADMIN","CAJERO"), async (req,res) => {
  const studentId = Number(req.params.id);
  const cats = await catalogs();
  const s = await q(`SELECT * FROM students WHERE id=$1`, [studentId]);
  const student = s.rows[0];
  if (!student) return res.status(404).send("No encontrado");
  if (req.session.user.role === "CAJERO" && !(req.session.user.campuses||[]).includes(student.campus_id)) {
    return res.status(403).send("No autorizado");
  }
  const body = await new Promise((resolve, reject) => {
    res.render("student_form", { mode:"edit", action:`/students/${studentId}/edit`, student, ...cats }, (err, html) => err ? reject(err) : resolve(html));
  });
  render(req,res,"layout", { title:"Editar alumno", active:"students", body });
});

app.post("/students/:id/edit", requireAuth, requireRole("ADMIN","CAJERO"), async (req,res) => {
  const studentId = Number(req.params.id);
  const b = req.body;
  const resend = req.body.resend_credentials;
  const existing = await q(`SELECT * FROM students WHERE id=$1`, [studentId]);

  if (!existing.rows[0]) {
    flash(req, "danger", "Alumno no encontrado.");
    return res.redirect("/students");
  }

  if (req.session.user.role === "CAJERO" && !(req.session.user.campuses||[]).includes(existing.rows[0].campus_id)) {
    return res.status(403).send("No autorizado");
  }

  await q(
    `UPDATE students
     SET full_name=$1,
         phone_e164=$2,
         campus_id=$3,
         shift_id=$4,
         period_id=$5,
         year_id=$6,
         career_id=$7,
         grade=$8,
         "group"=$9,
         package_id=$10,
         discount_amount=$11,
         discount_reason=$12
     WHERE id=$13`,
    [
      b.full_name,
      b.phone_e164,
      Number(b.campus_id),
      Number(b.shift_id),
      Number(b.period_id),
      Number(b.year_id),
      b.career_id ? Number(b.career_id) : null,
      b.grade || "",
      b.group || "",
      Number(b.package_id),
      Number(b.discount_amount || 0),
      b.discount_reason || "",
      studentId
    ]
  );

  await audit(req, "UPDATE_STUDENT", "STUDENT", studentId, {
    before: existing.rows[0],
    after: b
  });

if (resend) {
  const result = await createStudentAccountAndSend(req, studentId);

  flash(req, "success", "Alumno actualizado y tarjeta reenviada.");

  if (result?.whatsappLink) {
    return res.redirect(result.whatsappLink);
  }

  return res.redirect(`/students/${studentId}`);
}

flash(req, "success", "Alumno actualizado.");
res.redirect(`/students/${studentId}`);
});
app.post("/students/:id/graduate", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const studentId = Number(req.params.id);

  await q(
    `UPDATE students
     SET status = 'GRADUATED'
     WHERE id = $1`,
    [studentId]
  );

  await audit(req, "GRADUATE_STUDENT", "STUDENT", studentId, {});

  flash(req, "success", "Alumno marcado como egresado correctamente.");
  res.redirect("/students");
});
app.post("/students/graduate-filtered", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const { campus_id, shift_id, period_id, year_id } = req.body;

  const conditions = [`COALESCE(status, 'ACTIVE') = 'ACTIVE'`];
  const params = [];
  let i = 1;

  if (campus_id) {
    conditions.push(`campus_id = $${i++}`);
    params.push(Number(campus_id));
  }

  if (shift_id) {
    conditions.push(`shift_id = $${i++}`);
    params.push(Number(shift_id));
  }

  if (period_id) {
    conditions.push(`period_id = $${i++}`);
    params.push(Number(period_id));
  }

  if (year_id) {
    conditions.push(`year_id = $${i++}`);
    params.push(Number(year_id));
  }

  if (!period_id || !year_id) {
    flash(req, "danger", "Debes seleccionar periodo y año para egresar alumnos.");
    return res.redirect("/students");
  }

  const where = conditions.join(" AND ");

  const result = await q(
    `UPDATE students
     SET status = 'GRADUATED'
     WHERE ${where}
     RETURNING id`,
    params
  );

  await audit(req, "GRADUATE_FILTERED_STUDENTS", "STUDENT", null, {
    total_graduated: result.rows.length,
    filters: { campus_id, shift_id, period_id, year_id }
  });

  flash(req, "success", `Se marcaron ${result.rows.length} alumnos como egresados.`);
  res.redirect("/students");
});
app.post("/students/:id/delete", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const studentId = Number(req.params.id);

  const existing = await q(`SELECT * FROM students WHERE id = $1`, [studentId]);
  if (!existing.rows[0]) {
    flash(req, "danger", "Alumno no encontrado.");
    return res.redirect("/students");
  }

  const accountResult = await q(
    `SELECT user_id FROM student_accounts WHERE student_id = $1`,
    [studentId]
  );

  const userId = accountResult.rows[0]?.user_id || null;

  await q(`DELETE FROM change_requests WHERE student_id = $1`, [studentId]);
  await q(`DELETE FROM student_accounts WHERE student_id = $1`, [studentId]);

if (userId) {
  await q(
    `UPDATE audit_log
     SET actor_user_id = NULL
     WHERE actor_user_id = $1`,
    [userId]
  );

  await q(
    `DELETE FROM users
     WHERE id = $1
       AND role = 'STUDENT'`,
    [userId]
  );
}

  await q(`DELETE FROM students WHERE id = $1`, [studentId]);

  await audit(req, "DELETE_STUDENT", "STUDENT", studentId, {
    full_name: existing.rows[0].full_name,
    deleted_user_id: userId
  });

  flash(req, "success", "Alumno y usuario vinculados eliminados correctamente.");
  res.redirect("/students");
});
app.post("/students/billing-multiple", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const ids = Array.isArray(req.body.student_ids)
    ? req.body.student_ids
    : req.body.student_ids
      ? [req.body.student_ids]
      : [];

  const action = req.body.billing_action;

  if (!ids.length) {
    flash(req, "danger", "Selecciona al menos un alumno.");
    return res.redirect("/students");
  }

  const active = action === "activate";

  await q(
    `UPDATE students
     SET billing_active = $1
     WHERE id = ANY($2::int[])`,
    [active, ids.map(Number)]
  );

  flash(
    req,
    "success",
    active
      ? `Cobranza activada para ${ids.length} alumno(s).`
      : `Cobranza desactivada para ${ids.length} alumno(s).`
  );

  return res.redirect("/students");
});
app.post("/students/delete-multiple", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    let { student_ids } = req.body;

    if (!student_ids) {
      flash(req, "warning", "No seleccionaste alumnos para eliminar.");
      return res.redirect("/students");
    }

    if (!Array.isArray(student_ids)) {
      student_ids = [student_ids];
    }

    const ids = student_ids
      .map(id => Number(id))
      .filter(id => !Number.isNaN(id));

    if (!ids.length) {
      flash(req, "warning", "No se recibieron alumnos válidos para eliminar.");
      return res.redirect("/students");
    }

    const linkedAccounts = await q(
      `SELECT student_id, user_id
       FROM student_accounts
       WHERE student_id = ANY($1)`,
      [ids]
    );

    const userIds = linkedAccounts.rows
      .map(r => Number(r.user_id))
      .filter(id => !Number.isNaN(id));

    await q(`DELETE FROM change_requests WHERE student_id = ANY($1)`, [ids]);
    await q(`DELETE FROM student_accounts WHERE student_id = ANY($1)`, [ids]);

if (userIds.length) {
  await q(
    `UPDATE audit_log
     SET actor_user_id = NULL
     WHERE actor_user_id = ANY($1)`,
    [userIds]
  );

  await q(
    `DELETE FROM users
     WHERE id = ANY($1)
       AND role = 'STUDENT'`,
    [userIds]
  );
}

    await q(`DELETE FROM students WHERE id = ANY($1)`, [ids]);

    await audit(req, "DELETE_MULTIPLE_STUDENTS", "STUDENT", null, {
      student_ids: ids,
      deleted_user_ids: userIds
    });

    flash(req, "success", `Se eliminaron ${ids.length} alumnos y sus usuarios vinculados correctamente.`);
    return res.redirect("/students");
  } catch (err) {
    console.error("Error eliminando alumnos en bloque:", err);
    flash(req, "danger", "Ocurrió un error al eliminar los alumnos seleccionados.");
    return res.redirect("/students");
  }
});
app.post("/students/:id/resend-credentials", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const studentId = Number(req.params.id);
  await createStudentAccountAndSend(req, studentId);
  flash(req,"success","Credenciales reenviadas (o simulado).");
  res.redirect(`/students/${studentId}`);
});

// Excel import placeholder
    
app.get("/students/import", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const body = await new Promise((resolve, reject) => {
    res.render("import", {}, (err, html) => err ? reject(err) : resolve(html));
  });
  render(req,res,"layout", {
    title:"Importar Excel", 
    active:"students", 
    body });
});
app.post("/students/import", requireAuth, requireRole("ADMIN"), uploadExcel.single("excel"), async (req,res) => {
  try {
    if (!req.file) {
      flash(req, "danger", "Debes seleccionar un archivo Excel.");
      return res.redirect("/students/import");
    }

    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });

    let created = 0;
    let duplicated = 0;
    let errors = 0;

    for (const row of rows) {
      const fullName = String(row.nombre_completo || "").trim();
      const phone = String(row.telefono || "").trim();
      const campusName = String(row.campus || "").trim();
      const shiftName = String(row.turno || "").trim();
      const periodName = String(row.periodo || "").trim();
      const yearValue = String(row.anio || "").trim();
      const careerName = String(row.carrera || "").trim();
      const grade = String(row.grado || "").trim();
      const group = String(row.grupo || "").trim();
      const packageName = String(row.paquete || "").trim();

      if (!fullName || !campusName || !shiftName || !periodName || !yearValue || !packageName) {
        errors++;
        continue;
      }

      const existing = await q(
        `SELECT id FROM students WHERE LOWER(full_name) = LOWER($1) LIMIT 1`,
        [fullName]
      );

      if (existing.rows[0]) {
        duplicated++;
        continue;
      }

      const campus = await q(`SELECT id FROM campuses WHERE LOWER(name) = LOWER($1) LIMIT 1`, [campusName]);
      const shift = await q(`SELECT id FROM shifts WHERE LOWER(name) = LOWER($1) LIMIT 1`, [shiftName]);
      const period = await q(`SELECT id FROM graduation_periods WHERE LOWER(name) = LOWER($1) LIMIT 1`, [periodName]);
      const year = await q(`SELECT id FROM graduation_years WHERE year::text = $1 LIMIT 1`, [yearValue]);
      const pack = await q(`SELECT id FROM packages WHERE LOWER(name) = LOWER($1) LIMIT 1`, [packageName]);

      if (!campus.rows[0] || !shift.rows[0] || !period.rows[0] || !year.rows[0] || !pack.rows[0]) {
        errors++;
        continue;
      }

      let careerId = null;

      if (careerName && careerName.toLowerCase() !== "sin carrera") {
        const career = await q(`SELECT id FROM careers WHERE LOWER(name) = LOWER($1) LIMIT 1`, [careerName]);
        careerId = career.rows[0]?.id || null;
      }

      const ins = await q(
        `INSERT INTO students(
          full_name,
          phone_e164,
          campus_id,
          shift_id,
          period_id,
          year_id,
          career_id,
          grade,
          "group",
          package_id,
          discount_amount,
          discount_reason,
          status
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING id`,
        [
          fullName,
          phone,
          campus.rows[0].id,
          shift.rows[0].id,
          period.rows[0].id,
          year.rows[0].id,
          careerId,
          grade,
          group,
          pack.rows[0].id,
          0,
          "",
          "ACTIVE"
        ]
      );

      await audit(req, "IMPORT_STUDENT", "STUDENT", ins.rows[0].id, { full_name: fullName });
      created++;
    }

    flash(req, "success", `Importación terminada. Registrados: ${created}. Repetidos: ${duplicated}. Errores: ${errors}.`);
    return res.redirect("/students/import");

  } catch (err) {
    console.error("Error importando alumnos:", err);
    flash(req, "danger", "Ocurrió un error al importar el Excel.");
    return res.redirect("/students/import");
  }
});
// Finance collect
async function cashboxIsOpen() {
  const r = await q(`SELECT is_open FROM cashbox_state WHERE id=1`);
  return !!r.rows[0]?.is_open;
}

app.get("/finance/collect", requireAuth, async (req,res) => {
  const permissions = req.session.user?.permissions || {};

  if (req.session.user.role !== "ADMIN" && permissions.create_payments !== true) {
    return res.status(403).send("No autorizado");
  }
let results = [];
let student = null;
let totals = null;

const qtext = req.query.q || "";
const studentId = req.query.student_id ? Number(req.query.student_id) : null;

if (qtext) {
    // quick search
    const r = await q(
      `
      SELECT s.id, s.full_name, s.phone_e164, s.campus_id,
        c.name as campus_name, sh.name as shift_name, gp.name as period_name, gy.year as grad_year
      FROM students s
      LEFT JOIN campuses c ON c.id=s.campus_id
      LEFT JOIN shifts sh ON sh.id=s.shift_id
      LEFT JOIN graduation_periods gp ON gp.id=s.period_id
      LEFT JOIN graduation_years gy ON gy.id=s.year_id
      WHERE (LOWER(s.full_name) LIKE $1 OR s.phone_e164 LIKE $2)
      ORDER BY s.full_name
      LIMIT 20
      `,
      [`%${qtext.toLowerCase()}%`, `%${qtext}%`]
    );
    results = r.rows.filter(r => req.session.user.role==="ADMIN" || (req.session.user.campuses||[]).includes(r.campus_id));
  }

  if (studentId) {
    const info = await getStudentTotals(studentId);
    if (!info) return res.status(404).send("No encontrado");
    student = info.student;
    totals = info.totals;
    if (req.session.user.role === "CAJERO" && !(req.session.user.campuses||[]).includes(student.campus_id)) {
      return res.status(403).send("No autorizado");
    }
  }

  const body = await new Promise((resolve, reject) => {
    res.render("collect", { q: qtext, results, student, totals }, (err, html) => err ? reject(err) : resolve(html));
  });
  render(req,res,"layout", { title:"Registrar abono", active:"payments", body });
});

app.post("/finance/collect", requireAuth, async (req,res) => {
  const permissions = req.session.user?.permissions || {};

  if (req.session.user.role !== "ADMIN" && permissions.create_payments !== true) {
    return res.status(403).send("No autorizado");
  }

  const { student_id, amount, method, note } = req.body;
  const studentId = Number(student_id);

  const info = await getStudentTotals(studentId);
  if (!info) return res.status(404).send("No encontrado");

  if (req.session.user.role === "CAJERO" && !(req.session.user.campuses || []).includes(info.student.campus_id)) {
    return res.status(403).send("No autorizado");
  }

  await q(
    `INSERT INTO payments(student_id, amount, method, note, created_by) VALUES ($1,$2,$3,$4,$5)`,
    [studentId, Number(amount), method || "Efectivo", note || "", req.session.user.id]
  );

  const updated = await getStudentTotals(studentId);
  const student = updated.student;
  const totalPaid = Number(updated.totals?.total_paid || 0).toFixed(2);
  const remaining = Number(updated.totals?.balance || 0).toFixed(2);
  const paidNow = Number(amount || 0).toFixed(2);

  const phone = (student.phone_e164 || "").replace("+", "").trim();

  const message = `Hola ${student.full_name} 👋

Registramos tu abono de $${paidNow} 💵

Total abonado: $${totalPaid}
Saldo pendiente: $${remaining}

Gracias por tu pago 🙌`;

  const encodedMessage = encodeURIComponent(message);
  const whatsappLink = phone
    ? `https://wa.me/${phone}?text=${encodedMessage}`
    : null;

  await audit(req, "CREATE_PAYMENT", "PAYMENT", null, {
    student_id: studentId,
    amount: Number(amount)
  });

  await q(
    `INSERT INTO message_log(student_id,to_phone_e164,type,body,status) VALUES ($1,$2,$3,$4,$5)`,
    [studentId, student.phone_e164, "ABONO", message, whatsappLink ? "PENDING_MANUAL" : "NO_PHONE"]
  );

  if (whatsappLink) {
    return res.redirect(whatsappLink);
  }

  flash(req, "success", "Abono registrado correctamente.");
  return res.redirect(`/students/${studentId}`);
});

// Serve generated PDFs (for mediaUrl). In production, host publicly.
app.get("/pdf/:name", requireAuth, async (req,res) => {
  const fileName = req.params.name;
  const fp = path.join(process.cwd(), "generated_pdfs", fileName);
  return res.sendFile(fp);
});

// Payments list
app.get("/audit", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const r = await q(`
    SELECT 
      a.*,
      u.username AS actor_username
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.actor_user_id
    ORDER BY a.created_at DESC
    LIMIT 200
  `);

  const rows = r.rows.map(x => ({
    ...x,
    created_at_fmt: dayjs(x.created_at).format("DD/MM/YYYY HH:mm")
  }));

  const body = await new Promise((resolve, reject) => {
    res.render("audit", { rows }, (err, html) => err ? reject(err) : resolve(html));
  });

  render(req,res,"layout", { title:"Auditoría", active:"audit", body });
});
// Cancel payment (ADMIN direct; cajeros use requests)
app.post("/payments/:id/cancel", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const paymentId = Number(req.params.id);
  const studentId = Number(req.body.student_id);
  const p = await q(`SELECT * FROM payments WHERE id=$1`, [paymentId]);
  if (!p.rows[0]) return res.status(404).send("Pago no encontrado");
  await q(
    `UPDATE payments SET status='CANCELED', canceled_by=$1, canceled_at=NOW(), cancel_reason=$2 WHERE id=$3`,
    [req.session.user.id, "Cancelado por admin", paymentId]
  );
  await audit(req, "CANCEL_PAYMENT", "PAYMENT", paymentId, { student_id: studentId, amount: p.rows[0].amount });
  flash(req,"success","Pago cancelado.");
  res.redirect(`/students/${studentId}`);
});

// Arrears
app.get("/arrears", requireAuth, async (req,res) => {
 const filters = {
  campus_id: req.query.campus_id || "",
  shift_id: req.query.shift_id || "",
  period_id: req.query.period_id || "",
  year_id: req.query.year_id || "",
  estado: req.query.estado || ""
};

const cats = await catalogs();
const metrics = await computeMetrics(filters, req.session.user);
const { where, params } = studentQueryWhere(filters, req.session.user);

let estadoCondition = "";

if (filters.estado === "adeudo") {
  estadoCondition = `
    AND (GREATEST(0, p.cost - COALESCE(s.discount_amount,0)) - COALESCE(pay.total_paid,0)) > 0
  `;
}

if (filters.estado === "pagado") {
  estadoCondition = `
    AND (GREATEST(0, p.cost - COALESCE(s.discount_amount,0)) - COALESCE(pay.total_paid,0)) = 0
  `;
}

let finalWhere = where;

if (estadoCondition) {
  if (where && where.trim()) {
    finalWhere = `${where} ${estadoCondition}`;
  } else {
    finalWhere = `WHERE ${estadoCondition.replace(/^AND\s+/i, "")}`;
  }
}

const r = await q(
  `
 SELECT s.id, s.full_name, s.phone_e164,
  s.grade,
  s."group" as group_name,
  p.name as package_name,
    c.name as campus_name, sh.name as shift_name, gp.name as period_name, gy.year as grad_year,
    (GREATEST(0, p.cost - COALESCE(s.discount_amount,0)) - COALESCE(pay.total_paid,0))::numeric as balance
  FROM students s
  LEFT JOIN campuses c ON c.id=s.campus_id
  LEFT JOIN shifts sh ON sh.id=s.shift_id
  LEFT JOIN graduation_periods gp ON gp.id=s.period_id
  LEFT JOIN graduation_years gy ON gy.id=s.year_id
  LEFT JOIN packages p ON p.id=s.package_id
  LEFT JOIN (
    SELECT student_id, COALESCE(SUM(amount),0) as total_paid
    FROM payments WHERE status='CONFIRMED'
    GROUP BY student_id
  ) pay ON pay.student_id=s.id
  ${finalWhere}
  ORDER BY balance DESC
  LIMIT 500
  `,
  params
);

  const body = await new Promise((resolve, reject) => {
    res.render("arrears", { ...cats, filters, rows: r.rows, metrics, user: req.session.user }, (err, html) => err ? reject(err) : resolve(html));
  });
  render(req,res,"layout", { title:"Adeudos", active:"arrears", body });
});

app.post("/arrears/send", requireAuth, requireRole("ADMIN"), async (req,res) => {
  // For MVP, use same filters as query string if posted with apply_filters=1
  const filters = {
    campus_id: req.query.campus_id || req.body.campus_id || "",
    shift_id: req.query.shift_id || req.body.shift_id || "",
    period_id: req.query.period_id || req.body.period_id || "",
    year_id: req.query.year_id || req.body.year_id || ""
  };
  const { where, params } = studentQueryWhere(filters, req.session.user);

  const r = await q(
    `
    SELECT s.id, s.full_name, s.phone_e164,
      p.name as package_name, p.cost, COALESCE(s.discount_amount,0) as discount_amount,
      COALESCE(pay.total_paid,0) as total_paid,
      (GREATEST(0, p.cost - COALESCE(s.discount_amount,0)) - COALESCE(pay.total_paid,0))::numeric as balance
    FROM students s
    LEFT JOIN packages p ON p.id=s.package_id
    LEFT JOIN (
      SELECT student_id, COALESCE(SUM(amount),0) as total_paid
      FROM payments WHERE status='CONFIRMED'
      GROUP BY student_id
    ) pay ON pay.student_id=s.id
    ${where}
    AND (GREATEST(0, p.cost - COALESCE(s.discount_amount,0)) - COALESCE(pay.total_paid,0)) > 0
    LIMIT 500
    `,
    params
  );

  const tpl = await getTemplate("ADEUDO");
  const instructions = "Por favor realiza tu pago/abono con administración.";
  let sent = 0;

  for (const s of r.rows) {
    const total_due = Math.max(0, Number(s.cost) - Number(s.discount_amount || 0));
    const body = applyVars(tpl.body, {
      "{NOMBRE}": s.full_name,
      "${SALDO}": Number(s.balance).toFixed(2),
      "${TOTAL}": total_due.toFixed(2),
      "${ABONADO}": Number(s.total_paid).toFixed(2),
      "{PAQUETE}": s.package_name,
      "{INSTRUCCIONES_PAGO}": instructions
    });
    await q(
      `INSERT INTO message_log(student_id,to_phone_e164,type,body,status) VALUES ($1,$2,$3,$4,$5)`,
      [s.id, s.phone_e164, "ADEUDO", body, "MANUAL"]
    );
    sent++;
  }

  await audit(req, "SEND_ARREARS", "BATCH", null, { sent, filters });
  flash(req,"success",`Cobranza enviada a ${sent} alumnos (o simulado).`);
  res.redirect("/arrears");
});

// Requests
app.get("/requests", requireAuth, async (req,res) => {
  const user = req.session.user;
  let where = "";
  let params = [];
  if (user.role !== "ADMIN") {
    where = "WHERE r.requested_by=$1";
    params = [user.id];
  }
  const r = await q(
    `
    SELECT r.*,
      u.username as requested_by_username,
      d.username as decided_by_username,
      s.full_name as student_name,
      c.name as campus_name
    FROM change_requests r
    LEFT JOIN users u ON u.id=r.requested_by
    LEFT JOIN users d ON d.id=r.decided_by
    LEFT JOIN students s ON s.id=r.student_id
    LEFT JOIN campuses c ON c.id=r.campus_id
    ${where}
    ORDER BY r.created_at DESC
    LIMIT 200
    `,
    params
  );
  const requests = r.rows.map(x => ({ ...x, created_at_fmt: dayjs(x.created_at).format("DD/MM/YYYY HH:mm") }));
  const body = await new Promise((resolve, reject) => {
    res.render("requests_list", { requests, user }, (err, html) => err ? reject(err) : resolve(html));
  });
render(req,res,"layout", { title:"Solicitudes", active:"requests", body });
});

app.get("/requests/new", requireAuth, requireRole("CAJERO"), async (req,res) => {
  // list students in cajero campuses
  const ids = req.session.user.campuses || [];
  const s = await q(
    `SELECT s.id, s.full_name, c.name as campus_name FROM students s LEFT JOIN campuses c ON c.id=s.campus_id
     WHERE s.campus_id = ANY($1) ORDER BY s.full_name LIMIT 500`,
    [ids]
  );
  const pref = {
    type: req.query.type || "",
    student_id: req.query.student_id || "",
    payload: req.query.payment_id ? JSON.stringify({ payment_id: Number(req.query.payment_id) }, null, 2) : "{}"
  };
  const body = await new Promise((resolve, reject) => {
    res.render("request_new", { students: s.rows, pref }, (err, html) => err ? reject(err) : resolve(html));
  });
  render(req,res,"layout", { title:"Nueva solicitud", active:"requests", body });
});

app.post("/requests/new", requireAuth, requireRole("CAJERO"), async (req,res) => {
  const { student_id, request_type, payload, reason } = req.body;
  let payloadObj = {};
  try { payloadObj = JSON.parse(payload || "{}"); } catch { payloadObj = {}; }

  const studentId = Number(student_id);
  const info = await getStudentTotals(studentId);
  if (!info) return res.status(404).send("No encontrado");
  if (!(req.session.user.campuses||[]).includes(info.student.campus_id)) return res.status(403).send("No autorizado");

  const ins = await q(
    `INSERT INTO change_requests(requested_by,campus_id,student_id,request_type,payload,reason)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [req.session.user.id, info.student.campus_id, studentId, request_type, payloadObj, reason]
  );
  const requestId = ins.rows[0].id;
  await audit(req, "CREATE_REQUEST", "REQUEST", requestId, { request_type });

  // notify admin (WhatsApp + in-app via notifications screen)
  const adminPhone = process.env.ADMIN_WHATSAPP_E164;
  if (adminPhone) {
    const campusName = info.student.campus_name || "";
    const link = `${process.env.APP_BASE_URL || ""}/requests/${requestId}`;
    const tpl = await getTemplate("SOLICITUD_ADMIN");
    const body = applyVars(tpl.body, {
      "{CAJERO}": req.session.user.username,
      "{CAMPUS}": campusName,
      "{NOMBRE}": info.student.full_name,
      "{ACCION}": request_type,
      "{MOTIVO}": reason,
      "{LINK}": link
    });
    await sendWhatsApp({ toE164: adminPhone, body });
  }

  flash(req,"success","Solicitud enviada. Se notificó al administrador (si está configurado).");
  res.redirect(`/requests/${requestId}`);
});

app.get("/requests/:id", requireAuth, async (req,res) => {
  const id = Number(req.params.id);
  const r = await q(
    `
    SELECT r.*,
      u.username as requested_by_username,
      d.username as decided_by_username,
      s.full_name as student_name,
      c.name as campus_name
    FROM change_requests r
    LEFT JOIN users u ON u.id=r.requested_by
    LEFT JOIN users d ON d.id=r.decided_by
    LEFT JOIN students s ON s.id=r.student_id
    LEFT JOIN campuses c ON c.id=r.campus_id
    WHERE r.id=$1`,
    [id]
  );
  const row = r.rows[0];
  if (!row) return res.status(404).send("No encontrado");
  // Authorization: admin or owner cajero
  if (req.session.user.role !== "ADMIN" && row.requested_by !== req.session.user.id) return res.status(403).send("No autorizado");

  row.decided_at_fmt = row.decided_at ? dayjs(row.decided_at).format("DD/MM/YYYY HH:mm") : "";
  const body = await new Promise((resolve, reject) => {
    res.render("request_view", { r: row, user: req.session.user }, (err, html) => err ? reject(err) : resolve(html));
  });
  render(req,res,"layout", { title:`Solicitud #${id}`, active:"requests", body });
});

async function executeApprovedRequest(req, r) {
  // Execute minimal supported actions for MVP:
  // CANCEL_PAYMENT: payload {payment_id}
  if (r.request_type === "CANCEL_PAYMENT") {
    const paymentId = Number(r.payload.payment_id);
    const p = await q(`SELECT * FROM payments WHERE id=$1 AND student_id=$2`, [paymentId, r.student_id]);
    if (!p.rows[0]) throw new Error("Pago no encontrado para cancelar");
    await q(
      `UPDATE payments SET status='CANCELED', canceled_by=$1, canceled_at=NOW(), cancel_reason=$2 WHERE id=$3`,
      [req.session.user.id, `Aprobado por admin. Solicitud #${r.id}`, paymentId]
    );
    await audit(req, "APPROVE_CANCEL_PAYMENT", "PAYMENT", paymentId, { request_id: r.id, amount: p.rows[0].amount });
    // Send correction to student with current balance
    const info = await getStudentTotals(r.student_id);
    const tpl = await getTemplate("CORRECCION");
    const body = applyVars(tpl.body, {
      "{NOMBRE}": info.student.full_name,
      "{PAQUETE}": info.student.package_name,
      "${TOTAL}": info.totals.total_due.toFixed(2),
      "${ABONADO}": info.totals.total_paid.toFixed(2),
      "${SALDO}": Math.max(0, info.totals.balance).toFixed(2)
    });
    await q(
      `INSERT INTO message_log(student_id,to_phone_e164,type,body,status) VALUES ($1,$2,$3,$4,$5)`,
     [r.student_id, info.student.phone_e164, "CORRECCION", body, "MANUAL"]
    );
  }
}

app.post("/requests/:id/decide", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const id = Number(req.params.id);
  const decision = req.body.decision; // APPROVE/REJECT
  const note = req.body.decision_note || "";
  const rr = await q(`SELECT * FROM change_requests WHERE id=$1`, [id]);
  const r = rr.rows[0];
  if (!r) return res.status(404).send("No encontrado");
  if (r.status !== "PENDING") {
    flash(req,"warning","Esta solicitud ya fue decidida.");
    return res.redirect(`/requests/${id}`);
  }

  if (decision === "APPROVE") {
    await q(
      `UPDATE change_requests SET status='APPROVED', decided_by=$1, decided_at=NOW(), decision_note=$2 WHERE id=$3`,
      [req.session.user.id, note, id]
    );
    await audit(req, "APPROVE_REQUEST", "REQUEST", id, {});
    try {
      await executeApprovedRequest(req, { ...r, id });
    } catch (e) {
      flash(req,"danger",`Solicitud aprobada pero falló la ejecución: ${e.message}`);
      return res.redirect(`/requests/${id}`);
    }
    flash(req,"success","Solicitud aprobada y aplicada.");
  } else {
    await q(
      `UPDATE change_requests SET status='REJECTED', decided_by=$1, decided_at=NOW(), decision_note=$2 WHERE id=$3`,
      [req.session.user.id, note, id]
    );
    await audit(req, "REJECT_REQUEST", "REQUEST", id, {});
    flash(req,"info","Solicitud rechazada.");
  }

  res.redirect(`/requests/${id}`);
});

// Audit
app.get("/audit", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const r = await q(`
    SELECT 
      a.*,
      u.username AS actor_username
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.actor_user_id
    ORDER BY a.created_at DESC
    LIMIT 200
  `);

  const rows = r.rows.map(x => ({
    ...x,
    created_at_fmt: dayjs(x.created_at).format("DD/MM/YYYY HH:mm")
  }));

  const body = await new Promise((resolve, reject) => {
    res.render("audit", { rows }, (err, html) => err ? reject(err) : resolve(html));
  });

  render(req,res,"layout", { title:"Auditoría", active:"audit", body });
});

// Notifications
app.get("/notifications", requireAuth, async (req,res) => {
  const pending = await q(
    `SELECT r.id, r.request_type, r.created_at,
      u.username as requested_by_username,
      s.full_name as student_name,
      c.name as campus_name
     FROM change_requests r
     LEFT JOIN users u ON u.id=r.requested_by
     LEFT JOIN students s ON s.id=r.student_id
     LEFT JOIN campuses c ON c.id=r.campus_id
     WHERE r.status='PENDING'
     ORDER BY r.created_at DESC
     LIMIT 20`
  );
  const recent = await q(
    `SELECT a.*, u.username as actor_username
     FROM audit_log a
     LEFT JOIN users u ON u.id=a.actor_user_id
     ORDER BY a.created_at DESC
     LIMIT 20`
  );
  const p = pending.rows.map(x => ({ ...x, created_at_fmt: dayjs(x.created_at).format("DD/MM/YYYY HH:mm") }));
  const r = recent.rows.map(x => ({ ...x, created_at_fmt: dayjs(x.created_at).format("DD/MM/YYYY HH:mm") }));
  const body = await new Promise((resolve, reject) => {
    res.render("notifications", { pending: p, recent: r }, (err, html) => err ? reject(err) : resolve(html));
  });
  render(req,res,"layout", { title:"Notificaciones", active:"dashboard", body });
});

// Settings (MVP home; detailed CRUD screens can be added next)
app.get("/settings", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const body = await new Promise((resolve, reject) => {
    res.render("settings", {}, (err, html) => err ? reject(err) : resolve(html));
  });
  render(req,res,"layout", { title:"Ajustes", active:"settings", body });
});
// Careers settings
app.get("/settings/careers", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const r = await q(`SELECT * FROM careers ORDER BY active DESC, name ASC`);

  const body = await new Promise((resolve, reject) => {
    res.render("settings_careers", {
      careers: r.rows
    }, (err, html) => err ? reject(err) : resolve(html));
  });

  render(req,res,"layout", { title:"Ajustes - Carreras", active:"settings", body });
});

app.post("/settings/careers/new", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const { name } = req.body;

  if (!name || !name.trim()) {
    flash(req,"danger","Debes escribir el nombre de la carrera.");
    return res.redirect("/settings/careers");
  }

  await q(
    `INSERT INTO careers(name, active) VALUES ($1, true)
     ON CONFLICT (name) DO NOTHING`,
    [name.trim()]
  );

  await audit(req, "CREATE_CAREER", "CAREER", null, { name: name.trim() });
  flash(req,"success","Carrera agregada correctamente.");
  res.redirect("/settings/careers");
});
// Campuses settings
app.get("/settings/campuses", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const r = await q(`SELECT * FROM campuses ORDER BY active DESC, name ASC`);

  const body = await new Promise((resolve, reject) => {
    res.render("settings_campuses", {
      campuses: r.rows
    }, (err, html) => err ? reject(err) : resolve(html));
  });

  render(req,res,"layout", { title:"Ajustes - Campus", active:"settings", body });
});

app.post("/settings/campuses/new", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const { name } = req.body;

  if (!name || !name.trim()) {
    flash(req,"danger","Debes escribir el nombre del campus.");
    return res.redirect("/settings/campuses");
  }

  await q(
    `INSERT INTO campuses(name, active) VALUES ($1, true)
     ON CONFLICT (name) DO NOTHING`,
    [name.trim()]
  );

  await audit(req, "CREATE_CAMPUS", "CAMPUS", null, { name: name.trim() });
  flash(req,"success","Campus agregado correctamente.");
  res.redirect("/settings/campuses");
});

app.post("/settings/campuses/:id/toggle", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const id = Number(req.params.id);

  await q(
    `UPDATE campuses
     SET active = NOT active
     WHERE id = $1`,
    [id]
  );

  await audit(req, "TOGGLE_CAMPUS", "CAMPUS", id, {});
  flash(req,"success","Estatus de campus actualizado.");
  res.redirect("/settings/campuses");
});
app.post("/settings/careers/:id/toggle", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const id = Number(req.params.id);

  await q(
    `UPDATE careers
     SET active = NOT active
     WHERE id = $1`,
    [id]
  );

  await audit(req, "TOGGLE_CAREER", "CAREER", id, {});
  flash(req,"success","Estatus de carrera actualizado.");
  res.redirect("/settings/careers");
});
// Shifts settings
app.get("/settings/shifts", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const r = await q(`SELECT * FROM shifts ORDER BY active DESC, name ASC`);

  const body = await new Promise((resolve, reject) => {
    res.render("settings_shifts", {
      shifts: r.rows
    }, (err, html) => err ? reject(err) : resolve(html));
  });

  render(req,res,"layout", { title:"Ajustes - Turnos", active:"settings", body });
});

app.post("/settings/shifts/new", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const { name } = req.body;

  if (!name || !name.trim()) {
    flash(req,"danger","Debes escribir el nombre del turno.");
    return res.redirect("/settings/shifts");
  }

  await q(
    `INSERT INTO shifts(name, active) VALUES ($1, true)
     ON CONFLICT (name) DO NOTHING`,
    [name.trim()]
  );

  await audit(req, "CREATE_SHIFT", "SHIFT", null, { name: name.trim() });
  flash(req,"success","Turno agregado correctamente.");
  res.redirect("/settings/shifts");
});

app.post("/settings/shifts/:id/toggle", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const id = Number(req.params.id);

  await q(
    `UPDATE shifts
     SET active = NOT active
     WHERE id = $1`,
    [id]
  );

  await audit(req, "TOGGLE_SHIFT", "SHIFT", id, {});
  flash(req,"success","Estatus de turno actualizado.");
  res.redirect("/settings/shifts");
});
// Periods settings
app.get("/settings/periods", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const r = await q(`SELECT * FROM graduation_periods ORDER BY active DESC, id ASC`);

  const body = await new Promise((resolve, reject) => {
    res.render("settings_periods", {
      periods: r.rows
    }, (err, html) => err ? reject(err) : resolve(html));
  });

  render(req,res,"layout", { title:"Ajustes - Periodos", active:"settings", body });
});

app.post("/settings/periods/new", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const { name } = req.body;

  if (!name || !name.trim()) {
    flash(req,"danger","Debes escribir el nombre del periodo.");
    return res.redirect("/settings/periods");
  }

  await q(
    `INSERT INTO graduation_periods(name, active) VALUES ($1, true)
     ON CONFLICT (name) DO NOTHING`,
    [name.trim()]
  );

  await audit(req, "CREATE_PERIOD", "PERIOD", null, { name: name.trim() });
  flash(req,"success","Periodo agregado correctamente.");
  res.redirect("/settings/periods");
});
app.get("/settings/expense-contacts", requireAuth, requireRole("ADMIN"), async (req, res) => {
const contacts = await q(`SELECT * FROM expense_contacts ORDER BY id DESC`);

  const rows = contacts.rows.map(c => `
  <tr>
    <td>${c.id}</td>
    <td>${c.full_name}</td>
    <td>${c.phone || ""}</td>
    <td>${c.notes || ""}</td>
    <td>
      <a class="btn btn-sm btn-outline-primary" href="/settings/expense-contacts/${c.id}/edit">Editar</a>
    </td>
  </tr>
`).join("");
  
  const body = `
    <h3>Proveedores</h3>

    <a class="btn btn-primary mb-3" href="/expenses/contacts/new">
      Nuevo proveedor
    </a>

    <table class="table">
      <thead>
      <tr>
    <th>ID</th>
    <th>Nombre</th>
    <th>Teléfono</th>
    <th>Notas</th>
    <th>Acciones</th>
  </tr>
</thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;

  render(req, res, "layout", {
    title: "Proveedores",
    active: "settings",
    body
  });
});
app.get("/settings/expense-contacts/:id/edit", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const { id } = req.params;
  
  const result = await q(
  `SELECT * FROM expense_contacts WHERE id = $1`,
  [id]
  );

  if (!result.rows.length) {
    return res.status(404).send("Proveedor no encontrado");
  }

  const c = result.rows[0];

  const body = `
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h3 class="mb-0">Editar proveedor</h3>
      <a class="btn btn-outline-secondary" href="/settings/expense-contacts">Volver</a>
    </div>

    <div class="card">
      <div class="card-body">
        <form method="POST" action="/settings/expense-contacts/${c.id}/edit">
          <div class="row g-3">
            <div class="col-md-6">
              <label class="form-label">Nombre completo</label>
              <input class="form-control" name="full_name" value="${c.full_name || ""}" required>
            </div>

            <div class="col-md-6">
              <label class="form-label">Teléfono</label>
              <input class="form-control" name="phone" value="${c.phone || ""}">
            </div>

            <div class="col-md-6">
              <label class="form-label">Tipo</label>
              <select class="form-select" name="contact_type">
                <option value="PROVEEDOR" ${c.contact_type === "PROVEEDOR" ? "selected" : ""}>Proveedor</option>
                <option value="APOYO" ${c.contact_type === "APOYO" ? "selected" : ""}>Apoyo</option>
                <option value="COLABORADOR" ${c.contact_type === "COLABORADOR" ? "selected" : ""}>Colaborador</option>
                <option value="OTRO" ${c.contact_type === "OTRO" ? "selected" : ""}>Otro</option>
              </select>
            </div>

            <div class="col-12">
              <label class="form-label">Observaciones</label>
              <textarea class="form-control" name="notes" rows="3">${c.notes || ""}</textarea>
            </div>
          </div>

          <div class="mt-3 d-flex gap-2">
            <button class="btn btn-primary" type="submit">Guardar cambios</button>
            <a class="btn btn-outline-secondary" href="/settings/expense-contacts">Cancelar</a>
          </div>
        </form>
      </div>
    </div>
  `;

  render(req, res, "layout", {
    title: "Editar proveedor",
    active: "settings",
    body
  });
});

app.post("/settings/expense-contacts/:id/edit", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const { id } = req.params;
  const { full_name, phone, contact_type, notes } = req.body;

  await q(
    `UPDATE expense_contacts
     SET full_name = $1,
         phone = $2,
         contact_type = $3,
         notes = $4
     WHERE id = $5`,
    [full_name, phone || "", contact_type || "PROVEEDOR", notes || "", id]
  );

  res.redirect("/settings/expense-contacts");
});
app.post("/settings/periods/:id/toggle", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const id = Number(req.params.id);

  await q(
    `UPDATE graduation_periods
     SET active = NOT active
     WHERE id = $1`,
    [id]
  );

  await audit(req, "TOGGLE_PERIOD", "PERIOD", id, {});
  flash(req,"success","Estatus de periodo actualizado.");
  res.redirect("/settings/periods");
}); 

// Users settings
app.get("/settings/users", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const r = await q(`
    SELECT id, username, role, active, created_at
    FROM users
    ORDER BY active DESC, id ASC
  `);

  const body = await new Promise((resolve, reject) => {
    res.render("settings_users", {
      users: r.rows
    }, (err, html) => err ? reject(err) : resolve(html));
  });

  render(req,res,"layout", { title:"Ajustes - Usuarios", active:"settings", body });
});
app.post("/settings/users/cleanup-students", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const orphanUsers = await q(`
      SELECT u.id, u.username
      FROM users u
      WHERE u.role = 'STUDENT'
        AND NOT EXISTS (
          SELECT 1
          FROM student_accounts sa
          WHERE sa.user_id = u.id
        )
    `);

    if (!orphanUsers.rows.length) {
      flash(req, "info", "No se encontraron usuarios STUDENT sobrantes.");
      return res.redirect("/settings/users");
    }

    const orphanIds = orphanUsers.rows
      .map(u => Number(u.id))
      .filter(id => !Number.isNaN(id));

    // 1) Quitar referencia en auditoría
    await q(
      `UPDATE audit_log
       SET actor_user_id = NULL
       WHERE actor_user_id = ANY($1)`,
      [orphanIds]
    );

    // 2) Ahora sí borrar usuarios STUDENT sobrantes
    await q(
      `DELETE FROM users
       WHERE id = ANY($1)
         AND role = 'STUDENT'`,
      [orphanIds]
    );

    await audit(req, "CLEANUP_STUDENT_USERS", "USER", null, {
      deleted_user_ids: orphanIds,
      total_deleted: orphanIds.length
    });

    flash(req, "success", `Se eliminaron ${orphanIds.length} usuarios STUDENT sobrantes.`);
    return res.redirect("/settings/users");
  } catch (err) {
    console.error("Error limpiando usuarios STUDENT sobrantes:", err);
    flash(req, "danger", `Error al limpiar usuarios sobrantes: ${err.message}`);
    return res.redirect("/settings/users");
  }
});
app.post("/settings/users/new", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const { username, password, role } = req.body;

  if (!username || !username.trim() || !password || !password.trim() || !role || !role.trim()) {
    flash(req,"danger","Debes llenar usuario, contraseña y rol.");
    return res.redirect("/settings/users");
  }

  const hash = await bcrypt.hash(password.trim(), 10);

  await q(
    `INSERT INTO users(username, password_hash, role, active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (username) DO NOTHING`,
    [username.trim(), hash, role.trim()]
  );

  await audit(req, "CREATE_USER", "USER", null, { username: username.trim(), role: role.trim() });
  flash(req,"success","Usuario agregado correctamente.");
  res.redirect("/settings/users");
});

app.post("/settings/users/:id/toggle", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const id = Number(req.params.id);

  await q(
    `UPDATE users
     SET active = NOT active
     WHERE id = $1`,
    [id]
  );

  await audit(req, "TOGGLE_USER", "USER", id, {});
  flash(req,"success","Estatus de usuario actualizado.");
  res.redirect("/settings/users");
});
app.get("/settings/users/:id/edit", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const id = Number(req.params.id);

  const r = await q(
    `SELECT id, username, role, active, permissions
     FROM users
     WHERE id = $1`,
    [id]
  );

  const userEdit = r.rows[0];
  const campusResult = await q(`SELECT id, name, active FROM campuses ORDER BY name ASC`);

const assignedCampusResult = await q(
  `SELECT campus_id FROM user_campuses WHERE user_id = $1`,
  [id]
);
  
const assignedCampusIds = assignedCampusResult.rows.map(x => x.campus_id);
  if (!userEdit) {
    flash(req,"danger","Usuario no encontrado.");
    return res.redirect("/settings/users");
  }

  const body = await new Promise((resolve, reject) => {
    res.render("settings_users_edit", {
  userEdit,
  campuses: campusResult.rows,
  assignedCampusIds
}, (err, html) => err ? reject(err) : resolve(html));
  });

  render(req,res,"layout", { title:"Editar usuario", active:"settings", body });
});

app.post("/settings/users/:id/edit", requireAuth, requireRole("ADMIN"), async (req,res) => {
  const id = Number(req.params.id);

  const {
    username,
    password,
    role,
    active,
    campus_ids,
    view_students,
    create_students,
    view_arrears,
    create_payments,
    send_collection,
    cancel_payments,
    view_reports,
    manage_users,
    view_settings,
    view_audit
  } = req.body;

  if (!username || !username.trim() || !role || !role.trim()) {
    flash(req, "danger", "Usuario y rol son obligatorios.");
    return res.redirect(`/settings/users/${id}/edit`);
  }

  const permissions = {
    view_students: !!view_students,
    create_students: !!create_students,
    view_arrears: !!view_arrears,
    create_payments: !!create_payments,
    send_collection: !!send_collection,
    cancel_payments: !!cancel_payments,
    view_reports: !!view_reports,
    manage_users: !!manage_users,
    view_settings: !!view_settings,
    view_audit: !!view_audit
  };

  const selectedCampusIds = Array.isArray(campus_ids)
    ? campus_ids.map(x => Number(x))
    : campus_ids
      ? [Number(campus_ids)]
      : [];

  if (password && password.trim()) {
    const hash = await bcrypt.hash(password.trim(), 10);

    await q(
      `UPDATE users
       SET username = $1,
           password_hash = $2,
           role = $3,
           active = $4,
           permissions = $5
       WHERE id = $6`,
      [
        username.trim(),
        hash,
        role.trim(),
        active === "true",
        permissions,
        id
      ]
    );
  } else {
    await q(
      `UPDATE users
       SET username = $1,
           role = $2,
           active = $3,
           permissions = $4
       WHERE id = $5`,
      [
        username.trim(),
        role.trim(),
        active === "true",
        permissions,
        id
      ]
    );
  }

  await q(`DELETE FROM user_campuses WHERE user_id = $1`, [id]);

  for (const campusId of selectedCampusIds) {
    await q(
      `INSERT INTO user_campuses(user_id, campus_id)
       VALUES ($1, $2)`,
      [id, campusId]
    );
  }

  await audit(req, "UPDATE_USER", "USER", id, {
    username: username.trim(),
    role: role.trim(),
    active: active === "true",
    permissions,
    campus_ids: selectedCampusIds
  });

  flash(req, "success", "Usuario actualizado correctamente.");
  res.redirect("/settings/users");
  });

// Reports placeholder
app.get("/reports", requireAuth, async (req,res) => {

  const body = "<h3>Reportes</h3><p class='text-muted'>En este MVP, usa Dashboard/Adeudos para métricas por filtros. Próximo paso: reportes detallados + exportación.</p>";
  render(req,res,"layout", { title:"Reportes", active:"reports", body });
});
app.get("/expenses", requireAuth, async (req, res) => {
  const expenses = await q(`
    SELECT
      e.id,
      e.expense_date,
      e.concept,
      e.amount,
      e.notes,
      c.full_name AS contact_name,
      p.name AS period_name,
      y.year AS year_name
    FROM expenses e
    LEFT JOIN expense_contacts c ON c.id = e.contact_id
    LEFT JOIN graduation_periods p ON p.id = e.period_id
    LEFT JOIN graduation_years y ON y.id = e.year_id
    ORDER BY e.id DESC
  `);

 const rows = expenses.rows.map(g => `
  <tr>
    <td>${g.id}</td>
    <td>${g.expense_date ? dayjs(g.expense_date).format("DD/MM/YYYY") : ""}</td>
    <td><a href="/expenses/${g.id}">${g.contact_name || ""}</a></td>
  <td><a href="/expenses/${g.id}">${g.concept || ""}</a></td>
    <td>${g.period_name || ""}</td>
    <td>${g.year_name || ""}</td>
    <td>$${g.amount || 0}</td>
    <td>${g.notes || ""}</td>
    <td>
      <form method="POST" action="/expenses/${g.id}/delete" onsubmit="return confirm('¿Eliminar este gasto?')">
        <button class="btn btn-sm btn-outline-danger" type="submit">Eliminar</button>
      </form>
    </td>
  </tr>
`).join("");
 const tableRows = rows || '<tr><td colspan="9" class="text-center text-muted">No hay gastos registrados</td></tr>';

  const body = `
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h3 class="mb-0">Gastos</h3>
      <div class="d-flex gap-2">
        <a class="btn btn-outline-secondary" href="/expenses/export">Extraer reporte</a>
        <a class="btn btn-primary" href="/expenses/new">Nuevo gasto</a>
      </div>
    </div>

    <div class="card">
      <div class="card-body">
        <div class="table-responsive">
          <table class="table table-bordered table-sm align-middle">
            <thead>
              <tr>
                <th>ID</th>
                <th>Fecha</th>
                <th>Proveedor / Persona</th>
                <th>Concepto</th>
                <th>Periodo</th>
                <th>Año</th>
                <th>Monto</th>
                <th>Observaciones</th>
              </tr>
            </thead>
           <tbody>
  ${tableRows}
</tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  render(req, res, "layout", {
    title: "Gastos",
    active: "expenses",
    body
  });
});

app.get("/expenses/new", requireAuth, async (req, res) => {
const contacts = await q(`SELECT id, full_name FROM expense_contacts ORDER BY full_name ASC`);
  const periods = await q(`SELECT id, name FROM graduation_periods WHERE active = true ORDER BY id ASC`);
  const years = await q(`SELECT id, year FROM graduation_years WHERE active = true ORDER BY id ASC`);

  const contactOptions = contacts.rows.map(c => `<option value="${c.id}">${c.full_name}</option>`).join("");
  const periodOptions = periods.rows.map(p => `<option value="${p.id}">${p.name}</option>`).join("");
  const yearOptions = years.rows.map(y => `<option value="${y.id}">${y.year}</option>`).join("");

  const body = `
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h3 class="mb-0">Nuevo gasto</h3>
      <a class="btn btn-outline-secondary" href="/expenses">Volver</a>
    </div>

    <div class="card">
      <div class="card-body">
        <form method="POST" action="/expenses/new" enctype="multipart/form-data">
          <div class="row g-3">
            <div class="col-12">
              <label class="form-label">Comprobante</label>
              <input type="file" name="comprobante" class="form-control" accept="image/*,.pdf">
            </div>

            <div class="col-md-4">
              <label class="form-label">Fecha</label>
              <input type="date" class="form-control" name="expense_date" required>
            </div>

            <div class="col-md-4">
              <label class="form-label">Periodo</label>
              <select class="form-select" name="period_id" required>
                <option value="">Selecciona</option>
                ${periodOptions}
              </select>
            </div>

            <div class="col-md-4">
              <label class="form-label">Año</label>
              <select class="form-select" name="year_id" required>
                <option value="">Selecciona</option>
                ${yearOptions}
              </select>
            </div>

            <div class="col-md-6">
              <label class="form-label">Proveedor / Persona</label>
              <select class="form-select" name="contact_id" required>
                <option value="">Selecciona</option>
                ${contactOptions}
              </select>
            </div>

            <div class="col-md-6">
              <label class="form-label">Monto</label>
              <input type="number" step="0.01" class="form-control" name="amount" required>
            </div>

            <div class="col-12">
              <label class="form-label">Concepto</label>
              <input class="form-control" name="concept" required>
            </div>

            <div class="col-12">
              <label class="form-label">Observaciones</label>
              <textarea class="form-control" name="notes" rows="3"></textarea>
            </div>
          </div>

          <div class="mt-3 d-flex gap-2">
            <button class="btn btn-primary" type="submit">Guardar gasto</button>
            <a class="btn btn-outline-secondary" href="/expenses">Cancelar</a>
          </div>
        </form>
      </div>
    </div>
  `;

  render(req, res, "layout", {
    title: "Nuevo gasto",
    active: "expenses",
    body
  });
});

app.get("/expenses/export", requireAuth, async (req, res) => {
  const contacts = await q(`SELECT id, full_name FROM expense_contacts ORDER BY full_name ASC`);
  const periods = await q(`SELECT id, name FROM graduation_periods WHERE active = true ORDER BY id ASC`);
  const years = await q(`SELECT id, year FROM graduation_years ORDER BY id ASC`);

  const contactOptions = contacts.rows.map(c => `<option value="${c.id}">${c.full_name}</option>`).join("");
  const periodOptions = periods.rows.map(p => `<option value="${p.id}">${p.name}</option>`).join("");
  const yearOptions = years.rows.map(y => `<option value="${y.id}">${y.year}</option>`).join("");

  const body = `
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h3 class="mb-0">Extraer reporte de gastos</h3>
      <a class="btn btn-outline-secondary" href="/expenses">Volver</a>
    </div>

    <div class="card">
      <div class="card-body">
        <form method="GET" action="/expenses/export/download">
          <div class="row g-3">
            <div class="col-md-4">
              <label class="form-label">Proveedor / Persona</label>
              <select class="form-select" name="contact_id">
                <option value="">Todos</option>
                ${contactOptions}
              </select>
            </div>

            <div class="col-md-4">
              <label class="form-label">Periodo</label>
              <select class="form-select" name="period_id">
                <option value="">Todos</option>
                ${periodOptions}
              </select>
            </div>

            <div class="col-md-4">
              <label class="form-label">Año</label>
              <select class="form-select" name="year_id">
                <option value="">Todos</option>
                ${yearOptions}
              </select>
            </div>

            <div class="col-md-6">
              <label class="form-label">Fecha inicial</label>
              <input type="date" class="form-control" name="date_from">
            </div>

            <div class="col-md-6">
              <label class="form-label">Fecha final</label>
              <input type="date" class="form-control" name="date_to">
            </div>
          </div>

          <div class="mt-3 d-flex gap-2">
            <button class="btn btn-primary" type="submit">Descargar CSV</button>
            <a class="btn btn-outline-secondary" href="/expenses">Cancelar</a>
          </div>
        </form>
      </div>
    </div>
  `;

  render(req, res, "layout", {
    title: "Extraer reporte de gastos",
    active: "expenses",
    body
  });
});

app.get("/expenses/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);

  if (!id || Number.isNaN(id)) {
    return res.redirect("/expenses"); // evita crash
  }

  const result = await q(
    `SELECT
      e.*,
      c.full_name AS contact_name,
      p.name AS period_name,
      y.year AS year_name
     FROM expenses e
     LEFT JOIN expense_contacts c ON c.id = e.contact_id
     LEFT JOIN graduation_periods p ON p.id = e.period_id
     LEFT JOIN graduation_years y ON y.id = e.year_id
     WHERE e.id = $1`,
    [id]
  );

  if (!result.rows.length) {
    return res.status(404).send("Gasto no encontrado");
  }

  const g = result.rows[0];

  const evidenceHtml = g.evidence_path
    ? `
      <div class="mt-3">
        <label class="form-label fw-bold">Comprobante</label>
        <div class="border rounded p-3">
          <p>
  <a href="${g.evidence_path}" target="_blank" class="btn btn-outline-primary btn-sm">
    Abrir comprobante
  </a>
</p>

<img src="${g.evidence_path}" alt="Comprobante" class="img-fluid rounded border">
        </div>
      </div>
    `
    : `
      <div class="mt-3">
        <label class="form-label fw-bold">Comprobante</label>
        <p class="text-muted">Este gasto no tiene archivo adjunto.</p>
      </div>
    `;

  const body = `
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h3 class="mb-0">Detalle de gasto</h3>
      <a class="btn btn-outline-secondary" href="/expenses">Volver</a>
    </div>

    <div class="card">
      <div class="card-body">
        <div class="row g-3">
          <div class="col-md-3">
            <label class="form-label fw-bold">ID</label>
            <div>${g.id}</div>
          </div>

          <div class="col-md-3">
            <label class="form-label fw-bold">Fecha</label>
            <div>${g.expense_date ? dayjs(g.expense_date).format("DD/MM/YYYY") : ""}</div>
          </div>

          <div class="col-md-3">
            <label class="form-label fw-bold">Periodo</label>
            <div>${g.period_name || ""}</div>
          </div>

          <div class="col-md-3">
            <label class="form-label fw-bold">Año</label>
            <div>${g.year_name || ""}</div>
          </div>

          <div class="col-md-6">
            <label class="form-label fw-bold">Proveedor / Persona</label>
            <div>${g.contact_name || ""}</div>
          </div>

          <div class="col-md-6">
            <label class="form-label fw-bold">Monto</label>
            <div>$${g.amount || 0}</div>
          </div>

          <div class="col-12">
            <label class="form-label fw-bold">Concepto</label>
            <div>${g.concept || ""}</div>
          </div>

          <div class="col-12">
            <label class="form-label fw-bold">Observaciones</label>
            <div>${g.notes || ""}</div>
          </div>
        </div>

        ${evidenceHtml}
      </div>
    </div>
  `;

  render(req, res, "layout", {
    title: "Detalle de gasto",
    active: "expenses",
    body
  });
});
  app.post("/expenses/new", requireAuth, upload.single("comprobante"), async (req, res) => {
  const { expense_date, period_id, year_id, contact_id, concept, amount, notes } = req.body;
 const evidence_path = req.file ? req.file.path : null;

  await q(
    `INSERT INTO expenses (
      expense_date,
      period_id,
      year_id,
      contact_id,
      concept,
      amount,
      notes,
      evidence_path,
      created_by
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      expense_date,
      period_id,
      year_id,
      contact_id,
      concept,
      amount,
      notes || "",
      evidence_path,
      req.session.user.id
    ]
  );

  res.redirect("/expenses");
});
app.post("/expenses/:id/delete", requireAuth, async (req, res) => {
  const id = Number(req.params.id);

  await q(`DELETE 
FROM expenses WHERE id = $1`, [id]);

  flash(req, "success", "Gasto eliminado correctamente.");
  res.redirect("/expenses");
});


app.get("/expenses/export/download", requireAuth, async (req, res) => {
  const { contact_id, period_id, year_id, date_from, date_to } = req.query;

  const conditions = [];
  const params = [];
  let i = 1;

  if (contact_id) {
    conditions.push(`e.contact_id = $${i++}`);
    params.push(Number(contact_id));
  }

  if (period_id) {
    conditions.push(`e.period_id = $${i++}`);
    params.push(Number(period_id));
  }

  if (year_id) {
    conditions.push(`e.year_id = $${i++}`);
    params.push(Number(year_id));
  }

  if (date_from) {
    conditions.push(`e.expense_date >= $${i++}`);
    params.push(date_from);
  }

  if (date_to) {
    conditions.push(`e.expense_date <= $${i++}`);
    params.push(date_to);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await q(
    `SELECT
      e.id,
      e.expense_date,
      c.full_name AS contact_name,
      p.name AS period_name,
      y.year AS year_name,
      e.concept,
      e.amount,
      e.notes
     FROM expenses e
     LEFT JOIN expense_contacts c ON c.id = e.contact_id
     LEFT JOIN graduation_periods p ON p.id = e.period_id
     LEFT JOIN graduation_years y ON y.id = e.year_id
     ${where}
     ORDER BY e.id DESC`,
    params
  );

  let csv = "ID,Fecha,Proveedor o Persona,Periodo,Año,Concepto,Monto,Observaciones\n";

  result.rows.forEach(g => {
    csv += [
      g.id ?? "",
      g.expense_date ? dayjs(g.expense_date).format("DD/MM/YYYY") : "",
      `"${(g.contact_name || "").replace(/"/g, '""')}"`,
      `"${(g.period_name || "").replace(/"/g, '""')}"`,
      g.year_name ?? "",
      `"${(g.concept || "").replace(/"/g, '""')}"`,
      g.amount ?? 0,
      `"${(g.notes || "").replace(/"/g, '""')}"`
    ].join(",") + "\n";
  });

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=reporte_gastos.csv");
  return res.send(csv);
});
app.get("/setup-expenses", requireAuth, async (req, res) => {
  try {
    await q(`
      CREATE TABLE IF NOT EXISTS expense_contacts (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(150) NOT NULL,
        phone VARCHAR(30),
        contact_type VARCHAR(50) DEFAULT 'PROVEEDOR',
        notes TEXT,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        expense_date DATE NOT NULL,
        period_id INTEGER REFERENCES graduation_periods(id),
        year_id INTEGER REFERENCES graduation_years(id),
        contact_id INTEGER REFERENCES expense_contacts(id),
        concept TEXT NOT NULL,
        amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        notes TEXT,
        evidence_path TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    res.send("Tablas de gastos creadas correctamente");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error al crear tablas de gastos");
  }
});
app.get("/setup-student-status", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    await q(`
      ALTER TABLE students
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    `);

    await q(`
      UPDATE students
      SET status = 'ACTIVE'
      WHERE status IS NULL OR status = ''
    `);

    res.send("Columna status agregada correctamente en students");
  } catch (err) {
    console.error("Error agregando status a students:", err);
    res.status(500).send("Error al agregar columna status en students");
  }
});
app.get("/setup-student-billing", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    await q(`
      ALTER TABLE students
      ADD COLUMN IF NOT EXISTS billing_active BOOLEAN NOT NULL DEFAULT false
    `);

    await q(`
      UPDATE students
      SET billing_active = false
      WHERE billing_active IS NULL
    `);

    res.send("Columna billing_active agregada correctamente en students");
  } catch (err) {
    console.error("Error agregando billing_active a students:", err);
    res.status(500).send("Error al agregar columna billing_active en students");
  }
});
app.get("/expenses/contacts/new", requireAuth, async (req, res) => {
  const body = `
    <div class="d-flex justify-content-between align-items-center mb-3">
      <h3 class="mb-0">Nuevo proveedor</h3>
      <a class="btn btn-outline-secondary" href="/expenses">Volver</a>
    </div>

    <div class="card">
      <div class="card-body">
        <form method="POST" action="/expenses/contacts/new">
          <div class="row g-3">
            <div class="col-md-6">
              <label class="form-label">Nombre completo</label>
              <input class="form-control" name="full_name" required>
            </div>

            <div class="col-md-6">
              <label class="form-label">Teléfono</label>
              <input class="form-control" name="phone">
            </div>

            <div class="col-md-6">
              <label class="form-label">Tipo</label>
              <select class="form-select" name="contact_type">
                <option value="PROVEEDOR">Proveedor</option>
                <option value="APOYO">Apoyo</option>
                <option value="COLABORADOR">Colaborador</option>
                <option value="OTRO">Otro</option>
              </select>
            </div>

            <div class="col-12">
              <label class="form-label">Observaciones</label>
              <textarea class="form-control" name="notes" rows="3"></textarea>
            </div>
          </div>

          <div class="mt-3 d-flex gap-2">
            <button class="btn btn-primary" type="submit">Guardar proveedor</button>
            <a class="btn btn-outline-secondary" href="/expenses">Cancelar</a>
          </div>
        </form>
      </div>
    </div>
  `;

  render(req, res, "layout", {
    title: "Nuevo proveedor",
    active: "expenses",
    body
  });
});

app.post("/expenses/contacts/new", requireAuth, async (req, res) => {
  const { full_name, phone, contact_type, notes } = req.body;

  await q(
    `INSERT INTO expense_contacts (full_name, phone, contact_type, notes)
     VALUES ($1, $2, $3, $4)`,
    [full_name, phone || "", contact_type || "PROVEEDOR", notes || ""]
  );

  res.redirect("/expenses");
});
// Cashbox endpoints (admin)
app.post("/cashbox/close", requireAuth, requireRole("ADMIN"), async (req,res) => {
  await q(`UPDATE cashbox_state SET is_open=false, updated_by=$1, updated_at=NOW() WHERE id=1`, [req.session.user.id]);
  await audit(req, "CLOSE_CASHBOX", "CASHBOX", 1, {});
  flash(req,"success","Ingresos cerrados.");
  res.redirect("/");
});
app.post("/cashbox/open", requireAuth, requireRole("ADMIN"), async (req,res) => {
  await q(`UPDATE cashbox_state SET is_open=true, updated_by=$1, updated_at=NOW() WHERE id=1`, [req.session.user.id]);
  await audit(req, "OPEN_CASHBOX", "CASHBOX", 1, {});
  flash(req,"success","Ingresos reabiertos.");
  res.redirect("/");
});
// =========================
// Portal del estudiante
// =========================

app.get("/portal/login", (req,res) => {
  res.render("portal_login", { error: null });
});

app.post("/portal/login", async (req,res) => {
  const { username, password } = req.body;

  const r = await q(
    `SELECT * FROM users WHERE username=$1 AND active=true AND role='STUDENT'`,
    [username]
  );

  const u = r.rows[0];
  if (!u) return res.render("portal_login", { error: "Usuario o contraseña inválidos" });

  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return res.render("portal_login", { error: "Usuario o contraseña inválidos" });

  const sa = await q(
    `SELECT * FROM student_accounts WHERE user_id=$1`,
    [u.id]
  );

  const link = sa.rows[0];
  if (!link) return res.render("portal_login", { error: "Esta cuenta no está vinculada a un alumno" });

  req.session.studentUser = {
    id: u.id,
    username: u.username,
    student_id: link.student_id
  };

  res.redirect("/portal");
});

function requireStudentPortal(req, res, next) {
  if (!req.session.studentUser) return res.redirect("/portal/login");
  next();
}

app.get("/portal/logout", requireStudentPortal, (req,res) => {
  req.session.studentUser = null;
  res.redirect("/portal/login");
});

app.get("/portal", requireStudentPortal, async (req,res) => {
  const studentId = req.session.studentUser.student_id;

  const info = await getStudentTotals(studentId);
  if (!info) return res.status(404).send("Alumno no encontrado");

  const pay = await q(
    `SELECT id, amount, method, status, note, created_at
     FROM payments
     WHERE student_id=$1
     ORDER BY created_at DESC`,
    [studentId]
  );

  const payments = pay.rows.map(p => ({
    ...p,
    created_at_fmt: dayjs(p.created_at).format("DD/MM/YYYY HH:mm")
  }));

  res.render("portal_dashboard", {
    student: info.student,
    totals: info.totals,
    payments
  });
});
app.get("/cobranza/preview", requireAuth, async (req, res) => {
  try {
    const filters = {
      campus_id: req.query.campus_id || "",
      shift_id: req.query.shift_id || "",
      period_id: req.query.period_id || "",
      year_id: req.query.year_id || "",
      estado: req.query.estado || ""
    };

    const { where, params } = studentQueryWhere(filters, req.session.user);

    const conditions = [];
if (filters.estado === "adeudo") {
  conditions.push(`
    (GREATEST(0, p.cost - COALESCE(s.discount_amount, 0)) - COALESCE(pay.total_paid, 0)) > 0
  `);
}

if (filters.estado === "pagado") {
  conditions.push(`
    (GREATEST(0, p.cost - COALESCE(s.discount_amount, 0)) - COALESCE(pay.total_paid, 0)) = 0
  `);
}
    if (where) {
      conditions.push(where.replace(/^WHERE\s+/i, ""));
    }

    const finalWhere = `WHERE ${conditions.join(" AND ")}`;

const result = await q(
  `
  SELECT 
    s.id,
    s.full_name AS nombre,
    s.phone_e164 AS telefono,
    p.cost AS total_paquete,
    COALESCE(pay.total_paid, 0) AS abonado,
    (GREATEST(0, p.cost - COALESCE(s.discount_amount, 0)) - COALESCE(pay.total_paid, 0))::numeric AS saldo_pendiente,
    last_pay.ultimo_pago,
    last_msg.ultima_cobranza_enviada,
    last_msg.fecha_ultima_cobranza
  FROM students s
  LEFT JOIN packages p ON p.id = s.package_id
  LEFT JOIN (
    SELECT student_id, COALESCE(SUM(amount), 0) AS total_paid
    FROM payments
    WHERE status = 'CONFIRMED'
    GROUP BY student_id
  ) pay ON pay.student_id = s.id
  LEFT JOIN (
    SELECT student_id, MAX(created_at) AS ultimo_pago
    FROM payments
    WHERE status = 'CONFIRMED'
    GROUP BY student_id
  ) last_pay ON last_pay.student_id = s.id
  LEFT JOIN (
    SELECT 
      student_id,
      'Sí' AS ultima_cobranza_enviada,
      MAX(created_at) AS fecha_ultima_cobranza
    FROM message_log
    WHERE type = 'ADEUDO'
    GROUP BY student_id
  ) last_msg ON last_msg.student_id = s.id
  ${finalWhere}
  ORDER BY saldo_pendiente DESC
  `,
  params
);

    const alumnos = result.rows.map((a) => {
      const hoy = new Date();
      const ultimoPago = a.ultimo_pago ? new Date(a.ultimo_pago) : null;

      let diasSinAbono = 999;

      if (ultimoPago) {
        const diff = hoy - ultimoPago;
        diasSinAbono = Math.floor(diff / (1000 * 60 * 60 * 24));
      }

      let nivel = "Suave";

      if (diasSinAbono >= 13) {
        nivel = "Urgente";
      } else if (diasSinAbono >= 7) {
        nivel = "Medio";
      }

      const mensaje = `Hola ${a.nombre} 👋

Te recordamos que actualmente presentas un saldo pendiente de $${Number(a.saldo_pendiente || 0).toFixed(2)} en tu pago de graduación.

Total del paquete: $${Number(a.total_paquete || 0).toFixed(2)}
Abonado: $${Number(a.abonado || 0).toFixed(2)}
Saldo pendiente: $${Number(a.saldo_pendiente || 0).toFixed(2)}

Han pasado ${diasSinAbono} días desde tu último abono.

Te pedimos realizar tu pago a la brevedad para evitar contratiempos en tu proceso de graduación.`;

      return {
        nombre: a.nombre,
        telefono: a.telefono,
        total_paquete: a.total_paquete,
        abonado: a.abonado,
        saldo_pendiente: a.saldo_pendiente,
        dias_sin_abonar: diasSinAbono,
        nivel_cobranza: nivel,
        mensaje_cobranza: mensaje
      };
    });

    res.render("cobranza_preview", { alumnos });
  } catch (error) {
    console.error(error);
    res.send("Error al cargar cobranza: " + error.message);
  }
});
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
