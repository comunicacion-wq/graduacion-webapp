import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import dayjs from "dayjs";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";

import { q } from "./db.js";
import { requireAuth, requireRole } from "./security.js";
import { sendWhatsApp } from "./whatsapp.js";
import { getStudentTotals } from "./totals.js";
import { generateLiquidationPDF } from "./pdf.js";

dotenv.config();
const app = express();
const upload = multer({ dest: "uploads/" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
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

  const add = (cond, val) => { w.push(cond.replace("?", `$${i++}`)); p.push(val); };

  if (filters.campus_id) add("s.campus_id = ?", Number(filters.campus_id));
  if (filters.shift_id) add("s.shift_id = ?", Number(filters.shift_id));
  if (filters.period_id) add("s.period_id = ?", Number(filters.period_id));
  if (filters.year_id) add("s.year_id = ?", Number(filters.year_id));
  if (filters.q) {
    add("(LOWER(s.full_name) LIKE ? OR s.phone_e164 LIKE ?)", `%${filters.q.toLowerCase()}%`);
    p.push(`%${filters.q}%`); i++;
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
    `,
    params
  );
  return rows.rows[0] || { total_students:0, paid:0, arrears:0, total_balance:0 };
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
app.get("/login", (req,res) => res.render("login", { error: null }));
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

  req.session.user = { id: u.id, username: u.username, role: u.role, campuses };
  await audit(req, "LOGIN", "USER", u.id, {});
  res.redirect("/");
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

app.get("/students/new", requireAuth, requireRole("ADMIN","CAJERO"), async (req,res) => {
  const cats = await catalogs();
  const student = {
    campus_id: cats.campuses[0]?.id,
    shift_id: cats.shifts[0]?.id,
    period_id: cats.periods[0]?.id,
    year_id: cats.years[0]?.id,
    package_id: cats.packages[0]?.id,
    discount_amount: 0
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
  const username = student.phone_e164;
  const temp = randomPassword(10);
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

  const t = await getTemplate("CREDENCIALES");
  const link = `${process.env.APP_BASE_URL || ""}/portal/login`;
  const body = applyVars(t.body, {
    "{NOMBRE}": student.full_name,
    "{USUARIO}": username,
    "{CONTRASENA}": temp,
    "{LINK_PORTAL}": link ? `Entra aquí: ${link}` : ""
  });

  const wa = await sendWhatsApp({ toE164: student.phone_e164, body });
  await q(
    `INSERT INTO message_log(student_id,to_phone_e164,type,body,media_url,status) VALUES ($1,$2,$3,$4,$5,$6)`,
    [studentId, student.phone_e164, "CREDENCIALES", body, null, wa.status || (wa.simulated ? "SIMULATED":"SENT")]
  );
  await audit(req, "SEND_CREDENTIALS", "STUDENT", studentId, { to: student.phone_e164 });
}

app.post("/students/new", requireAuth, requireRole("ADMIN","CAJERO"), async (req,res) => {
  const b = req.body;
  // Cajero restricted campus assignment
  if (req.session.user.role === "CAJERO") {
    const allowed = (req.session.user.campuses || []).includes(Number(b.campus_id));
    if (!allowed) {
      flash(req,"danger","No puedes registrar alumnos en ese campus.");
      return res.redirect("/students");
    }
  }
  const ins = await q(
    `INSERT INTO students(full_name,phone_e164,campus_id,shift_id,period_id,year_id,career_id,grade,"group",package_id,discount_amount,discount_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
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
      b.discount_reason || ""
    ]
  );
  const studentId = ins.rows[0].id;
  await audit(req, "CREATE_STUDENT", "STUDENT", studentId, { full_name: b.full_name });

  // auto send credentials (as requested)
  await createStudentAccountAndSend(req, studentId);
  flash(req,"success","Alumno creado y credenciales enviadas por WhatsApp (o simulado).");
  res.redirect(`/students/${studentId}`);
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
  const existing = await q(`SELECT * FROM students WHERE id=$1`, [studentId]);
  if (!existing.rows[0]) return res.status(404).send("No encontrado");
  if (req.session.user.role === "CAJERO" && !(req.session.user.campuses||[]).includes(existing.rows[0].campus_id)) {
    return res.status(403).send("No autorizado");
  }

  await q(
    `UPDATE students SET full_name=$1, phone_e164=$2, campus_id=$3, shift_id=$4, period_id=$5, year_id=$6,
      career_id=$7, grade=$8, "group"=$9, package_id=$10, discount_amount=$11, discount_reason=$12
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
  await audit(req, "UPDATE_STUDENT", "STUDENT", studentId, { before: existing.rows[0], after: b });
  flash(req,"success","Alumno actualizado.");
  res.redirect(`/students/${studentId}`);
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
  render(req,res,"layout", { title:"Importar Excel", active:"students", body });
});
app.post("/students/import", requireAuth, requireRole("ADMIN"), upload.single("file"), async (req,res) => {
  flash(req,"info","Módulo Excel pendiente: archivo recibido (placeholder).");
  res.redirect("/students");
});

// Finance collect
async function cashboxIsOpen() {
  const r = await q(`SELECT is_open FROM cashbox_state WHERE id=1`);
  return !!r.rows[0]?.is_open;
}

app.get("/finance/collect", requireAuth, requireRole("ADMIN","CAJERO"), async (req,res) => {
  const qtext = req.query.q || "";
  const studentId = req.query.student_id ? Number(req.query.student_id) : null;

  if (!(await cashboxIsOpen()) && req.session.user.role!=="ADMIN") {
    flash(req,"danger","Caja cerrada. No se pueden registrar abonos.");
    return res.redirect("/");
  }

  let results = [];
  let student = null;
  let totals = null;

  if (qtext) {
    // quick search
    const r = await q(
      `
      SELECT s.id, s.full_name, s.phone_e164,
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

app.post("/finance/collect", requireAuth, requireRole("ADMIN","CAJERO"), async (req,res) => {
  if (!(await cashboxIsOpen()) && req.session.user.role!=="ADMIN") {
    flash(req,"danger","Caja cerrada. No se pueden registrar abonos.");
    return res.redirect("/");
  }

  const { student_id, amount, method, note } = req.body;
  const studentId = Number(student_id);

  const info = await getStudentTotals(studentId);
  if (!info) return res.status(404).send("No encontrado");
  if (req.session.user.role === "CAJERO" && !(req.session.user.campuses||[]).includes(info.student.campus_id)) {
    return res.status(403).send("No autorizado");
  }

  await q(
    `INSERT INTO payments(student_id, amount, method, note, created_by) VALUES ($1,$2,$3,$4,$5)`,
    [studentId, Number(amount), method || "Efectivo", note || "", req.session.user.id]
  );
  await audit(req, "CREATE_PAYMENT", "PAYMENT", null, { student_id: studentId, amount: Number(amount) });

  // Recompute totals for message
  const after = await getStudentTotals(studentId);
  const t = await getTemplate("ABONO");
  const now = dayjs();
  const waBody = applyVars(t.body, {
    "{NOMBRE}": after.student.full_name,
    "${MONTO_ABONO}": Number(amount).toFixed(2),
    "{FECHA_PAGO}": now.format("DD/MM/YYYY"),
    "{HORA_PAGO}": now.format("HH:mm"),
    "${TOTAL}": after.totals.total_due.toFixed(2),
    "${ABONADO}": after.totals.total_paid.toFixed(2),
    "${SALDO}": Math.max(0, after.totals.balance).toFixed(2)
  });
  const wa = await sendWhatsApp({ toE164: after.student.phone_e164, body: waBody });
  await q(
    `INSERT INTO message_log(student_id,to_phone_e164,type,body,status) VALUES ($1,$2,$3,$4,$5)`,
    [studentId, after.student.phone_e164, "ABONO", waBody, wa.status || (wa.simulated ? "SIMULATED":"SENT")]
  );

  // Liquidation: if balance <= 0, send PDF
  if (after.totals.balance <= 0) {
    const tpl = await getTemplate("LIQUIDACION");
    const msg = applyVars(tpl.body, { "{NOMBRE}": after.student.full_name });
    // Generate PDF locally
    const outDir = path.join(process.cwd(), "generated_pdfs");
    const pdf = await generateLiquidationPDF({ student: after.student, totals: after.totals, outDir });
    // In this MVP, we cannot provide a public mediaUrl automatically in local. We'll send message without media unless hosted.
    let mediaUrl = null;
    // If APP_BASE_URL is public and we serve /pdf/:file, you can use it:
    mediaUrl = `${process.env.APP_BASE_URL || ""}/pdf/${encodeURIComponent(pdf.fileName)}`;
    const wa2 = await sendWhatsApp({ toE164: after.student.phone_e164, body: msg, mediaUrl });
    await q(
      `INSERT INTO message_log(student_id,to_phone_e164,type,body,media_url,status) VALUES ($1,$2,$3,$4,$5,$6)`,
      [studentId, after.student.phone_e164, "LIQUIDACION", msg, mediaUrl, wa2.status || (wa2.simulated ? "SIMULATED":"SENT")]
    );
    await audit(req, "SEND_LIQUIDATION", "STUDENT", studentId, { pdf: pdf.fileName });
  }

  flash(req,"success","Abono registrado. Mensaje WhatsApp enviado (o simulado).");
  res.redirect(`/students/${studentId}`);
});

// Serve generated PDFs (for mediaUrl). In production, host publicly.
app.get("/pdf/:name", requireAuth, async (req,res) => {
  const fileName = req.params.name;
  const fp = path.join(process.cwd(), "generated_pdfs", fileName);
  return res.sendFile(fp);
});

// Payments list
app.get("/finance/payments", requireAuth, async (req,res) => {
  const user = req.session.user;
  let where = "";
  let params = [];
  if (user.role === "CAJERO" && (user.campuses||[]).length) {
    where = "WHERE s.campus_id = ANY($1)";
    params = [user.campuses];
  }
  const r = await q(
    `
    SELECT p.*, s.full_name, c.name as campus_name, u.username as created_by_username
    FROM payments p
    JOIN students s ON s.id=p.student_id
    LEFT JOIN campuses c ON c.id=s.campus_id
    LEFT JOIN users u ON u.id=p.created_by
    ${where}
    ORDER BY p.created_at DESC
    LIMIT 300
    `,
    params
  );
  const rows = r.rows.map(x => ({ ...x, created_at_fmt: dayjs(x.created_at).format("DD/MM/YYYY HH:mm") }));
  const body = "<h3>Pagos (historial)</h3><p class='text-muted'>En este MVP, revisa pagos desde la ficha del alumno para acciones.</p>"
    + "<div class='table-responsive'><table class='table table-sm table-striped'><thead><tr><th>Fecha</th><th>Alumno</th><th>Campus</th><th>Monto</th><th>Estatus</th><th>Cajero</th></tr></thead><tbody>"
    + rows.map(p => `<tr><td>${p.created_at_fmt}</td><td>${p.full_name}</td><td>${p.campus_name||''}</td><td>$${Number(p.amount).toFixed(2)}</td><td>${p.status}</td><td>${p.created_by_username||''}</td></tr>`).join("")
    + "</tbody></table></div>";
  render(req,res,"layout", { title:"Finanzas", active:"payments", body });
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
    year_id: req.query.year_id || ""
  };
  const cats = await catalogs();
  const metrics = await computeMetrics(filters, req.session.user);
  const { where, params } = studentQueryWhere(filters, req.session.user);

  const r = await q(
    `
    SELECT s.id, s.full_name, s.phone_e164,
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
    ${where}
    AND (GREATEST(0, p.cost - COALESCE(s.discount_amount,0)) - COALESCE(pay.total_paid,0)) > 0
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
    const wa = await sendWhatsApp({ toE164: s.phone_e164, body });
    await q(
      `INSERT INTO message_log(student_id,to_phone_e164,type,body,status) VALUES ($1,$2,$3,$4,$5)`,
      [s.id, s.phone_e164, "ADEUDO", body, wa.status || (wa.simulated ? "SIMULATED":"SENT")]
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
    const wa = await sendWhatsApp({ toE164: info.student.phone_e164, body });
    await q(
      `INSERT INTO message_log(student_id,to_phone_e164,type,body,status) VALUES ($1,$2,$3,$4,$5)`,
      [r.student_id, info.student.phone_e164, "CORRECCION", body, wa.status || (wa.simulated ? "SIMULATED":"SENT")]
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
  const r = await q(
    `SELECT a.*, u.username as actor_username
     FROM audit_log a
     LEFT JOIN users u ON u.id=a.actor_user_id
     ORDER BY a.created_at DESC
     LIMIT 200`
  );
  const rows = r.rows.map(x => ({ ...x, created_at_fmt: dayjs(x.created_at).format("DD/MM/YYYY HH:mm") }));
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

// Reports placeholder
app.get("/reports", requireAuth, async (req,res) => {
  const body = "<h3>Reportes</h3><p class='text-muted'>En este MVP, usa Dashboard/Adeudos para métricas por filtros. Próximo paso: reportes detallados + exportación.</p>";
  render(req,res,"layout", { title:"Reportes", active:"reports", body });
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
