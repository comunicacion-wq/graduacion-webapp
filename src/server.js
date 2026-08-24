import express from "express";
import session from "express-session";
import path from "path";
import crypto from "crypto";
import QRCode from "qrcode";
import PDFDocument from "pdfkit";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import dayjs from "dayjs";
import multer from "multer";
import xlsx from "xlsx";
import ExcelJS from "exceljs";
import { fileURLToPath } from "url";

import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";

import { q } from "./db.js";
import { requireAuth, requireRole } from "./security.js";
import { sendWhatsApp } from "./whatsapp.js";
import { getStudentTotals } from "./totals.js";
import { generateLiquidationPDF } from "./pdf.js";

dotenv.config();
// ===============================
// CONFIGURACIÓN DEL SISTEMA
// ===============================

// false = producción
// true = modo desarrollo
const DEVELOPMENT_MODE = true;

// Usuarios que pueden probar funciones nuevas
const DEVELOPMENT_STUDENTS = [ 
  766
  ];
  // Agrega aquí los ID de alumnos autorizados

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
app.use(
  express.static(
    path.join(__dirname, "public")
  )
);
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
app.use(session({
  secret: process.env.SESSION_SECRET || "dev_secret",
  resave: false,
  saveUninitialized: false
}));
// ===================================
// MODO DESARROLLO
// ===================================

function canUseDevelopmentModules(studentId) {
  if (!DEVELOPMENT_MODE) {
    return false;
  }

  return DEVELOPMENT_STUDENTS.includes(studentId);
}


// ==========================================
// INFORMACIÓN DE GRADUACIÓN POR CAMPUS
// ==========================================

function getGraduationEventInfo(campusName = "") {

  const normalizedCampus =
    String(campusName || "")
      .trim()
      .toUpperCase();

  const baseInfo = {
    event_name: "Graduación ITCC 2026",
    event_date_text: "30 de agosto de 2026",
    venue: "Centro de Convenciones Reynosa",
    address_line: "Centro de Convenciones Reynosa, Reynosa, Tamaulipas",
    recommendation:
      "Presenta este boleto en formato digital o impreso al ingresar."
  };


  if (normalizedCampus.includes("DOCTORES")) {
    return {
      ...baseInfo,
      campus_label: "Campus Doctores",
      event_time_text: "9:00 A.M."
    };
  }


  if (normalizedCampus.includes("CUMBRES")) {
    return {
      ...baseInfo,
      campus_label: "Campus Cumbres",
      event_time_text: "9:00 A.M."
    };
  }


  if (normalizedCampus.includes("CAMPESTRE")) {
    return {
      ...baseInfo,
      campus_label: "Campus Campestre",
      event_time_text: "1:00 P.M."
    };
  }


  return {
    ...baseInfo,
    campus_label:
      campusName || "Campus ITCC",

    event_time_text:
      "Por confirmar"
  };
}
  if (!DEVELOPMENT_MODE) {
    return false;
  }

  return DEVELOPMENT_STUDENTS.includes(studentId);

}
// flash messages (simple)
// ===================================
// CONTROL DE ACCESO - OPERADORES
// ===================================

function requireTicketOperator(req, res, next) {

  const operator = req.session.ticketOperator;

  // Si nunca inició sesión con PIN
  if (!operator) {
    return res.redirect("/tickets/access-login");
  }

  const now = Date.now();

  // 5 minutos de inactividad
  const MAX_INACTIVITY = 5 * 60 * 1000;

  const lastActivity = Number(
    operator.last_activity || 0
  );

  // Si pasaron más de 5 minutos sin actividad
  if (
    !lastActivity ||
    (now - lastActivity) > MAX_INACTIVITY
  ) {

    delete req.session.ticketOperator;

    return req.session.save(() => {
      res.redirect("/tickets/access-login?expired=1");
    });
  }

  // Cada acción renueva los 5 minutos
  req.session.ticketOperator.last_activity = now;

  req.session.touch();

  next();
}
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
  if (filters.career_id) add("s.career_id = ?", Number(filters.career_id));

if (filters.grade) add("s.grade = ?", filters.grade);

if (filters.group) add('s."group" = ?', filters.group);
  if (filters.package_id) add("s.package_id = ?", Number(filters.package_id));
  if (filters.package_id) add("COALESCE(s.billing_active, false) = ?", true);
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
  if (u.role === "PROVEEDOR") {
  return res.redirect("/provider/verify");
}
return res.redirect(req.body.next || "/");
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
app.get("/reports/packages", requireAuth, async (req, res) => {
  try {

    const filters = {
      campus_id: req.query.campus_id || "",
      period_id: req.query.period_id || "",
      year_id: req.query.year_id || ""
    };

    const params = [];

    const conditions = [
      `COALESCE(s.billing_active, false) = true`
    ];

    if (filters.campus_id) {
      params.push(filters.campus_id);

      conditions.push(
        `s.campus_id = $${params.length}`
      );
    }

    if (filters.period_id) {
      params.push(filters.period_id);

      conditions.push(
        `s.period_id = $${params.length}`
      );
    }

    if (filters.year_id) {
      params.push(filters.year_id);

      conditions.push(
        `s.year_id = $${params.length}`
      );
    }

    const where = `
      WHERE ${conditions.join(" AND ")}
    `;


    // ==========================================
    // RESUMEN POR CAMPUS Y PAQUETE
    // ==========================================

    const detailResult = await q(
      `
      SELECT
        c.id AS campus_id,
        c.name AS campus_name,

        p.id AS package_id,
        p.name AS package_name,

        COUNT(s.id)::int AS total_students,

        SUM(
          GREATEST(
            0,
            COALESCE(p.cost, 0)
            - COALESCE(s.discount_amount, 0)
          )
        )::numeric AS total_contracted,

        SUM(
          COALESCE(pay.total_paid, 0)
        )::numeric AS total_paid,

        SUM(
          GREATEST(
            0,
            COALESCE(p.cost, 0)
            - COALESCE(s.discount_amount, 0)
            - COALESCE(pay.total_paid, 0)
          )
        )::numeric AS total_balance,

        COUNT(*) FILTER (
          WHERE
            GREATEST(
              0,
              COALESCE(p.cost, 0)
              - COALESCE(s.discount_amount, 0)
              - COALESCE(pay.total_paid, 0)
            ) <= 0
        )::int AS paid_students,

        COUNT(*) FILTER (
          WHERE
            GREATEST(
              0,
              COALESCE(p.cost, 0)
              - COALESCE(s.discount_amount, 0)
              - COALESCE(pay.total_paid, 0)
            ) > 0
        )::int AS students_with_balance

      FROM students s

      LEFT JOIN campuses c
        ON c.id = s.campus_id

      LEFT JOIN packages p
        ON p.id = s.package_id

      LEFT JOIN (
        SELECT
          student_id,
          COALESCE(SUM(amount), 0) AS total_paid
        FROM payments
        WHERE status = 'CONFIRMED'
        GROUP BY student_id
      ) pay
        ON pay.student_id = s.id

      ${where}

      GROUP BY
        c.id,
        c.name,
        p.id,
        p.name

      ORDER BY
        c.name ASC,
        p.name ASC
      `,
      params
    );


    // ==========================================
    // DETALLE DE ALUMNOS
    // ==========================================

    const studentsResult = await q(
      `
      SELECT
        s.id,
        s.full_name,
        s.phone_e164,
        s.grade,
        s."group",

        c.name AS campus_name,

        sh.name AS shift_name,

        gp.name AS period_name,

        gy.year AS grad_year,

        p.name AS package_name,

        COALESCE(p.cost, 0)::numeric AS package_cost,

        COALESCE(
          s.discount_amount,
          0
        )::numeric AS discount_amount,

        COALESCE(
          pay.total_paid,
          0
        )::numeric AS total_paid,

        GREATEST(
          0,
          COALESCE(p.cost, 0)
          - COALESCE(s.discount_amount, 0)
          - COALESCE(pay.total_paid, 0)
        )::numeric AS balance

      FROM students s

      LEFT JOIN campuses c
        ON c.id = s.campus_id

      LEFT JOIN shifts sh
        ON sh.id = s.shift_id

      LEFT JOIN graduation_periods gp
        ON gp.id = s.period_id

      LEFT JOIN graduation_years gy
        ON gy.id = s.year_id

      LEFT JOIN packages p
        ON p.id = s.package_id

      LEFT JOIN (
        SELECT
          student_id,
          COALESCE(SUM(amount), 0) AS total_paid
        FROM payments
        WHERE status = 'CONFIRMED'
        GROUP BY student_id
      ) pay
        ON pay.student_id = s.id

      ${where}

      ORDER BY
        c.name ASC,
        p.name ASC,
        s.full_name ASC
      `,
      params
    );


    // ==========================================
    // TOTALES GENERALES
    // ==========================================

    const totalsResult = await q(
      `
      SELECT
        COUNT(*)::int AS total_students,

        SUM(
          GREATEST(
            0,
            COALESCE(p.cost, 0)
            - COALESCE(s.discount_amount, 0)
          )
        )::numeric AS total_contracted,

        SUM(
          COALESCE(pay.total_paid, 0)
        )::numeric AS total_paid,

        SUM(
          GREATEST(
            0,
            COALESCE(p.cost, 0)
            - COALESCE(s.discount_amount, 0)
            - COALESCE(pay.total_paid, 0)
          )
        )::numeric AS total_balance,

        COUNT(*) FILTER (
          WHERE
            GREATEST(
              0,
              COALESCE(p.cost, 0)
              - COALESCE(s.discount_amount, 0)
              - COALESCE(pay.total_paid, 0)
            ) <= 0
        )::int AS paid_students,

        COUNT(*) FILTER (
          WHERE
            GREATEST(
              0,
              COALESCE(p.cost, 0)
              - COALESCE(s.discount_amount, 0)
              - COALESCE(pay.total_paid, 0)
            ) > 0
        )::int AS students_with_balance

      FROM students s

      LEFT JOIN packages p
        ON p.id = s.package_id

      LEFT JOIN (
        SELECT
          student_id,
          COALESCE(SUM(amount), 0) AS total_paid
        FROM payments
        WHERE status = 'CONFIRMED'
        GROUP BY student_id
      ) pay
        ON pay.student_id = s.id

      ${where}
      `,
      params
    );


    // ==========================================
    // CATÁLOGOS
    // ==========================================

    const campusesResult = await q(`
      SELECT
        id,
        name
      FROM campuses
      ORDER BY name ASC
    `);

    const periodsResult = await q(`
      SELECT
        id,
        name
      FROM graduation_periods
      ORDER BY id ASC
    `);

    const yearsResult = await q(`
      SELECT
        id,
        year
      FROM graduation_years
      ORDER BY year DESC
    `);


    // ==========================================
    // PREPARAR DETALLE PARA LA VISTA
    // ==========================================

    const studentsDetail =
      studentsResult.rows.map(student => ({
        ...student,

        package_cost:
          Number(student.package_cost || 0),

        discount_amount:
          Number(student.discount_amount || 0),

        total_paid:
          Number(student.total_paid || 0),

        balance:
          Number(student.balance || 0),

        payment_status:
          Number(student.balance || 0) <= 0
            ? "PAGADO"
            : "CON SALDO"
      }));


    const totals = {
      total_students:
        totalsResult.rows[0]?.total_students || 0,

      total_contracted:
        Number(
          totalsResult.rows[0]?.total_contracted || 0
        ),

      total_paid:
        Number(
          totalsResult.rows[0]?.total_paid || 0
        ),

      total_balance:
        Number(
          totalsResult.rows[0]?.total_balance || 0
        ),

      paid_students:
        totalsResult.rows[0]?.paid_students || 0,

      students_with_balance:
        totalsResult.rows[0]?.students_with_balance || 0
    };


    // ==========================================
    // RENDER
    // ==========================================

    const body = await new Promise(
      (resolve, reject) => {

        res.render(
          "report_packages",
          {
            rows: detailResult.rows,

            studentsDetail,

            totals,

            totalStudents:
              totals.total_students,

            campuses:
              campusesResult.rows,

            periods:
              periodsResult.rows,

            years:
              yearsResult.rows,

            filters
          },

          (err, html) => {

            if (err) {
              return reject(err);
            }

            resolve(html);
          }
        );

      }
    );


    render(
      req,
      res,
      "layout",
      {
        title: "Reporte de paquetes",
       active: "report_packages",
        body
      }
    );

  } catch (err) {

    console.error(
      "Error al generar reporte de paquetes:",
      err
    );

    res.status(500).send(
      "Error al generar reporte de paquetes"
    );
  }
});
// Students list
app.get("/reports/packages.xlsx", requireAuth, async (req, res) => {
  try {

    const filters = {
      campus_id: req.query.campus_id || "",
      period_id: req.query.period_id || "",
      year_id: req.query.year_id || ""
    };

    const params = [];

    const conditions = [
      `COALESCE(s.billing_active, false) = true`
    ];

    if (filters.campus_id) {
      params.push(filters.campus_id);
      conditions.push(
        `s.campus_id = $${params.length}`
      );
    }

    if (filters.period_id) {
      params.push(filters.period_id);
      conditions.push(
        `s.period_id = $${params.length}`
      );
    }

    if (filters.year_id) {
      params.push(filters.year_id);
      conditions.push(
        `s.year_id = $${params.length}`
      );
    }

    const where = `
      WHERE ${conditions.join(" AND ")}
    `;

    const summaryResult = await q(
      `
      SELECT
        c.name AS campus_name,
        p.name AS package_name,
        COUNT(s.id)::int AS total_students,

        COUNT(*) FILTER (
          WHERE
            GREATEST(
              0,
              COALESCE(p.cost, 0)
              - COALESCE(s.discount_amount, 0)
              - COALESCE(pay.total_paid, 0)
            ) <= 0
        )::int AS paid_students,

        COUNT(*) FILTER (
          WHERE
            GREATEST(
              0,
              COALESCE(p.cost, 0)
              - COALESCE(s.discount_amount, 0)
              - COALESCE(pay.total_paid, 0)
            ) > 0
        )::int AS students_with_balance,

        SUM(
          COALESCE(pay.total_paid, 0)
        )::numeric AS total_paid,

        SUM(
          GREATEST(
            0,
            COALESCE(p.cost, 0)
            - COALESCE(s.discount_amount, 0)
            - COALESCE(pay.total_paid, 0)
          )
        )::numeric AS total_balance

      FROM students s

      LEFT JOIN campuses c
        ON c.id = s.campus_id

      LEFT JOIN packages p
        ON p.id = s.package_id

      LEFT JOIN (
        SELECT
          student_id,
          COALESCE(SUM(amount), 0) AS total_paid
        FROM payments
        WHERE status = 'CONFIRMED'
        GROUP BY student_id
      ) pay
        ON pay.student_id = s.id

      ${where}

      GROUP BY
        c.name,
        p.name

      ORDER BY
        c.name ASC,
        p.name ASC
      `,
      params
    );

    const detailResult = await q(
      `
      SELECT
        s.full_name,
        s.phone_e164,
        s.grade,
        s."group",

        c.name AS campus_name,
        sh.name AS shift_name,
        gp.name AS period_name,
        gy.year AS grad_year,
        p.name AS package_name,

        COALESCE(p.cost, 0)::numeric AS package_cost,
        COALESCE(s.discount_amount, 0)::numeric AS discount_amount,
        COALESCE(pay.total_paid, 0)::numeric AS total_paid,

        GREATEST(
          0,
          COALESCE(p.cost, 0)
          - COALESCE(s.discount_amount, 0)
          - COALESCE(pay.total_paid, 0)
        )::numeric AS balance

      FROM students s

      LEFT JOIN campuses c
        ON c.id = s.campus_id

      LEFT JOIN shifts sh
        ON sh.id = s.shift_id

      LEFT JOIN graduation_periods gp
        ON gp.id = s.period_id

      LEFT JOIN graduation_years gy
        ON gy.id = s.year_id

      LEFT JOIN packages p
        ON p.id = s.package_id

      LEFT JOIN (
        SELECT
          student_id,
          COALESCE(SUM(amount), 0) AS total_paid
        FROM payments
        WHERE status = 'CONFIRMED'
        GROUP BY student_id
      ) pay
        ON pay.student_id = s.id

      ${where}

      ORDER BY
        c.name ASC,
        p.name ASC,
        s.full_name ASC
      `,
      params
    );

    const workbook = new ExcelJS.Workbook();

    workbook.creator = "GIA - ITCC";
    workbook.created = new Date();

    const summarySheet =
      workbook.addWorksheet("Resumen");

    summarySheet.columns = [
      { header: "Campus", key: "campus", width: 28 },
      { header: "Paquete", key: "package", width: 24 },
      { header: "Alumnos", key: "students", width: 14 },
      { header: "Pagados", key: "paid", width: 14 },
      { header: "Con saldo", key: "balance_students", width: 14 },
      { header: "Total pagado", key: "total_paid", width: 18 },
      { header: "Saldo pendiente", key: "total_balance", width: 18 }
    ];

    summaryResult.rows.forEach(row => {
      summarySheet.addRow({
        campus: row.campus_name || "Sin campus",
        package: row.package_name || "Sin paquete",
        students: Number(row.total_students || 0),
        paid: Number(row.paid_students || 0),
        balance_students: Number(row.students_with_balance || 0),
        total_paid: Number(row.total_paid || 0),
        total_balance: Number(row.total_balance || 0)
      });
    });

    summarySheet.getRow(1).font = {
      bold: true
    };

    summarySheet.getColumn("total_paid").numFmt =
      '$#,##0.00';

    summarySheet.getColumn("total_balance").numFmt =
      '$#,##0.00';

    const detailSheet =
      workbook.addWorksheet("Detalle de alumnos");

    detailSheet.columns = [
      { header: "Alumno", key: "student", width: 35 },
      { header: "Teléfono", key: "phone", width: 18 },
      { header: "Campus", key: "campus", width: 25 },
      { header: "Turno", key: "shift", width: 18 },
      { header: "Grado", key: "grade", width: 12 },
      { header: "Grupo", key: "group", width: 12 },
      { header: "Periodo", key: "period", width: 22 },
      { header: "Año", key: "year", width: 12 },
      { header: "Paquete", key: "package", width: 22 },
      { header: "Costo", key: "cost", width: 16 },
      { header: "Descuento", key: "discount", width: 16 },
      { header: "Pagado", key: "paid", width: 16 },
      { header: "Saldo", key: "balance", width: 16 },
      { header: "Estado", key: "status", width: 16 }
    ];

    detailResult.rows.forEach(student => {

      const balance =
        Number(student.balance || 0);

      detailSheet.addRow({
        student: student.full_name || "",
        phone: student.phone_e164 || "",
        campus: student.campus_name || "",
        shift: student.shift_name || "",
        grade: student.grade || "",
        group: student.group || "",
        period: student.period_name || "",
        year: student.grad_year || "",
        package: student.package_name || "",
        cost: Number(student.package_cost || 0),
        discount: Number(student.discount_amount || 0),
        paid: Number(student.total_paid || 0),
        balance,
        status:
          balance <= 0
            ? "PAGADO"
            : "CON SALDO"
      });

    });

    detailSheet.getRow(1).font = {
      bold: true
    };

    ["cost", "discount", "paid", "balance"]
      .forEach(column => {

        detailSheet
          .getColumn(column)
          .numFmt = '$#,##0.00';

      });

    const fileName =
      `reporte_paquetes_${dayjs().format("YYYY-MM-DD_HHmm")}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`
    );

    await workbook.xlsx.write(res);

    res.end();

  } catch (err) {

    console.error(
      "Error al generar Excel de paquetes:",
      err
    );

    res.status(500).send(
      "Error al generar Excel del reporte"
    );
  }
});
app.get("/students", requireAuth, async (req,res) => {
const filters = {
  campus_id: req.query.campus_id || "",
  shift_id: req.query.shift_id || "",
  period_id: req.query.period_id || "",
  year_id: req.query.year_id || "",
  career_id: req.query.career_id || "",
  grade: req.query.grade || "",
  group: req.query.group || "",
  package_id: req.query.package_id || "",
  status: req.query.status || "",
  refund_status: req.query.refund_status || "",
  q: req.query.q || ""
};
  const cats = await catalogs();
  const grades = await q(`
  SELECT DISTINCT grade
  FROM students
  WHERE grade IS NOT NULL AND grade <> ''
  ORDER BY grade
`);

const groups = await q(`
  SELECT DISTINCT "group" AS group
  FROM students
  WHERE "group" IS NOT NULL AND "group" <> ''
  ORDER BY "group"
`);
  const { where, params } = studentQueryWhere(filters, req.session.user);
const queryParams = [...params];

let refundCondition = "";

if (filters.refund_status === "WITH_REFUND") {

  refundCondition = `
    AND EXISTS (
      SELECT 1
      FROM graduation_refunds gr
      WHERE gr.student_id = s.id
    )
  `;

}

if (filters.refund_status === "WITHOUT_REFUND") {

  refundCondition = `
    AND NOT EXISTS (
      SELECT 1
      FROM graduation_refunds gr
      WHERE gr.student_id = s.id
    )
  `;

}
  const s = await q(
    `
    SELECT s.*,
  c.name as campus_name,
  sh.name as shift_name,
  gp.name as period_name,
  gy.year as grad_year,
  p.name as package_name,

  COALESCE(refunds.total_refunded, 0)::numeric AS total_refunded,

  CASE
    WHEN COALESCE(refunds.total_refunded, 0) > 0
    THEN true
    ELSE false
  END AS has_refund,
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

LEFT JOIN (
  SELECT
    student_id,
    COALESCE(SUM(amount), 0) AS total_refunded
  FROM graduation_refunds
  GROUP BY student_id
) refunds
  ON refunds.student_id = s.id

${where}
${refundCondition}
ORDER BY s.created_at DESC
LIMIT 500
    `,
    params
  );
const summaryResult = await q(
  `
  SELECT
    COUNT(*)::int AS total_filtered,

    COUNT(*) FILTER (
      WHERE COALESCE(s.billing_active, false) = true
    )::int AS total_billing_active

  FROM students s
  LEFT JOIN campuses c ON c.id = s.campus_id
  LEFT JOIN shifts sh ON sh.id = s.shift_id
  LEFT JOIN graduation_periods gp ON gp.id = s.period_id
  LEFT JOIN graduation_years gy ON gy.id = s.year_id
  LEFT JOIN packages p ON p.id = s.package_id

  ${where}
  ${refundCondition}
  `,
  queryParams
);

const totalFiltered =
  summaryResult.rows[0]?.total_filtered || 0;

const totalBillingActive =
  summaryResult.rows[0]?.total_billing_active || 0;


const packageResult = await q(
  `
  SELECT
    s.package_id,
    COUNT(*)::int AS total

  FROM students s

  LEFT JOIN campuses c ON c.id = s.campus_id
  LEFT JOIN shifts sh ON sh.id = s.shift_id
  LEFT JOIN graduation_periods gp ON gp.id = s.period_id
  LEFT JOIN graduation_years gy ON gy.id = s.year_id
  LEFT JOIN packages p ON p.id = s.package_id

  ${where}
  ${refundCondition}

  AND COALESCE(s.billing_active, false) = true

  GROUP BY s.package_id
  `,
  queryParams
);

const packageSummary = cats.packages.map(pkg => {

  const found = packageResult.rows.find(
    row => Number(row.package_id) === Number(pkg.id)
  );

  return {
    id: pkg.id,
    name: pkg.name,
    total: found ? Number(found.total) : 0
  };

});
  const body = await new Promise((resolve, reject) => {
res.render("students_list", {
  ...cats,
  filters,
  students: s.rows,
  grades: grades.rows,
  groups: groups.rows,
  totalFiltered,
  totalBillingActive,
  packageSummary
}, (err, html) => err ? reject(err) : resolve(html));
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
      s.billing_active,
      c.name AS campus,
      sh.name AS turno,
      gp.name AS periodo,
      gy.year AS anio,
      ca.name AS carrera,
      pk.name AS paquete,
      pk.cost AS paquete_costo,
      COALESCE(pay.total_paid, 0) AS pagado,
      CASE 
        WHEN COALESCE(s.billing_active, false) = true THEN 
          GREATEST(0, COALESCE(pk.cost,0) - COALESCE(s.discount_amount,0) - COALESCE(pay.total_paid,0))
        ELSE 0
      END AS saldo
    FROM students s
    LEFT JOIN campuses c ON c.id = s.campus_id
    LEFT JOIN shifts sh ON sh.id = s.shift_id
    LEFT JOIN graduation_periods gp ON gp.id = s.period_id
    LEFT JOIN graduation_years gy ON gy.id = s.year_id
    LEFT JOIN careers ca ON ca.id = s.career_id
    LEFT JOIN packages pk ON pk.id = s.package_id
LEFT JOIN (
  SELECT
    student_id,
    COALESCE(SUM(amount), 0) AS total_refunded
  FROM graduation_refunds
  GROUP BY student_id
) refunds
  ON refunds.student_id = s.id
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
    margin: 30,
    size: "LETTER",
    layout: "landscape"
  });

  res.setHeader("Content-Type", "application/pdf");

  res.setHeader(
    "Content-Disposition",
    `inline; filename="lista-grupo.pdf"`
  );

  doc.pipe(res);
  
  doc.fontSize(18).text("Lista de grupo", {
    align: "center"
  });

  doc.moveDown();

  doc.fontSize(10);
  doc.text(`Campus: ${campus}     Turno: ${turno}     Periodo: ${periodo}     Año: ${anio}`);
  doc.text(`Carrera: ${carrera}     Grado: ${grado}     Grupo: ${grupo}`);

  doc.moveDown(1.5);

  let y = doc.y;

  doc.fontSize(9).font("Helvetica-Bold");

  doc.text("#", 30, y, { width: 25 });
  doc.text("Alumno", 55, y, { width: 190 });
  doc.text("Teléfono", 250, y, { width: 90 });
  doc.text("Paquete", 345, y, { width: 75 });
  doc.text("Cobranza", 425, y, { width: 70 });
  doc.text("Pagado", 500, y, { width: 70 });
  doc.text("Saldo", 575, y, { width: 70 });
  doc.text("Estatus", 650, y, { width: 100 });

  y += 18;

  doc.font("Helvetica");

  r.rows.forEach((s, index) => {

    if (y > 560) {
      doc.addPage();
      y = 40;

      doc.fontSize(9).font("Helvetica-Bold");
      doc.text("#", 30, y, { width: 25 });
      doc.text("Alumno", 55, y, { width: 190 });
      doc.text("Teléfono", 250, y, { width: 90 });
      doc.text("Paquete", 345, y, { width: 75 });
      doc.text("Cobranza", 425, y, { width: 70 });
      doc.text("Pagado", 500, y, { width: 70 });
      doc.text("Saldo", 575, y, { width: 70 });
      doc.text("Estatus", 650, y, { width: 100 });
      y += 18;
      doc.font("Helvetica");
    }

    const cobranzaActiva = s.billing_active === true;
    const pagado = cobranzaActiva ? Number(s.pagado || 0) : 0;
    const saldo = cobranzaActiva ? Number(s.saldo || 0) : 0;

    let estatus = "Sin apertura";

    if (cobranzaActiva && saldo <= 0) {
      estatus = "Pagado";
    } else if (cobranzaActiva && pagado > 0 && saldo > 0) {
      estatus = "Abonando";
    } else if (cobranzaActiva && pagado <= 0 && saldo > 0) {
      estatus = "Sin pago";
    }

    doc.fontSize(8);

    doc.text(String(index + 1), 30, y, { width: 25 });
    doc.text(s.full_name || "", 55, y, { width: 190 });
    doc.text(s.phone_e164 || "", 250, y, { width: 90 });
    doc.text(s.paquete || "", 345, y, { width: 75 });
    doc.text(cobranzaActiva ? "Activa" : "No activa", 425, y, { width: 70 });
    doc.text(`$${pagado.toFixed(2)}`, 500, y, { width: 70 });
    doc.text(`$${saldo.toFixed(2)}`, 575, y, { width: 70 });
    doc.text(estatus, 650, y, { width: 100 });

    y += 18;
  });

  doc.end();
});
app.get(
  "/students/:id/payment-history.pdf",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {

    const studentId = Number(req.params.id);

    if (!Number.isInteger(studentId) || studentId <= 0) {
      return res.status(400).send("Alumno inválido.");
    }

    return res.redirect(
      `/portal/payment-history.pdf?student_id=${studentId}`
    );

  }
);
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
app.get("/students/:id/refund", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {

    const studentId = Number(req.params.id);

    if (!Number.isInteger(studentId) || studentId <= 0) {
      return res.status(400).send("Alumno no válido");
    }

    const studentResult = await q(
      `
      SELECT
        s.id,
        s.full_name,
        s.phone_e164,
        s.graduation_status,
        c.name AS campus_name,
        p.name AS package_name,
        COALESCE(p.cost, 0)::numeric AS package_cost,
        COALESCE(s.discount_amount, 0)::numeric AS discount_amount,
        COALESCE(pay.total_paid, 0)::numeric AS total_paid

      FROM students s

      LEFT JOIN campuses c
        ON c.id = s.campus_id

      LEFT JOIN packages p
        ON p.id = s.package_id

      LEFT JOIN (
        SELECT
          student_id,
          COALESCE(SUM(amount), 0) AS total_paid
        FROM payments
        WHERE status = 'CONFIRMED'
        GROUP BY student_id
      ) pay
        ON pay.student_id = s.id

      WHERE s.id = $1
      LIMIT 1
      `,
      [studentId]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).send("Alumno no encontrado");
    }

    const student = studentResult.rows[0];

    const refundsResult = await q(
      `
      SELECT
        COALESCE(SUM(amount), 0)::numeric AS total_refunded
      FROM graduation_refunds
      WHERE student_id = $1
      `,
      [studentId]
    );

    const totalRefunded =
      Number(refundsResult.rows[0]?.total_refunded || 0);

    const totalPaid =
      Number(student.total_paid || 0);

    const refundableAmount =
      Math.max(0, totalPaid - totalRefunded);

    const body = await new Promise((resolve, reject) => {

      res.render(
        "student_refund",
        {
          student,
          totalRefunded,
          refundableAmount
        },
        (err, html) => {
          if (err) return reject(err);
          resolve(html);
        }
      );

    });

    render(
      req,
      res,
      "layout",
      {
        title: "Generar devolución",
        active: "students",
        body
      }
    );

  } catch (err) {

    console.error(
      "Error al cargar devolución:",
      err
    );

    res.status(500).send(
      "Error al cargar devolución"
    );
  }
});
app.get("/students/:id/extra-tickets", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {

    const studentId = Number(req.params.id);

    if (!Number.isInteger(studentId) || studentId <= 0) {
      return res.status(400).send("Alumno no válido");
    }

    const studentResult = await q(
      `
      SELECT
        s.id,
        s.full_name,
        s.phone_e164,
        c.name AS campus_name,
        p.name AS package_name
      FROM students s
      LEFT JOIN campuses c
        ON c.id = s.campus_id
      LEFT JOIN packages p
        ON p.id = s.package_id
      WHERE s.id = $1
      LIMIT 1
      `,
      [studentId]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).send("Alumno no encontrado");
    }

    const student = studentResult.rows[0];

    const salesResult = await q(
      `
      SELECT
        ets.*,
        u.username AS created_by_name
      FROM extra_ticket_sales ets
      LEFT JOIN users u
        ON u.id = ets.created_by
      WHERE ets.student_id = $1
      ORDER BY ets.created_at DESC
      `,
      [studentId]
    );

    const totalsResult = await q(
      `
      SELECT
        COALESCE(SUM(quantity), 0)::int AS total_tickets,
        COALESCE(SUM(total_amount), 0)::numeric AS total_amount
      FROM extra_ticket_sales
      WHERE student_id = $1
        AND payment_status = 'PAID'
      `,
      [studentId]
    );

    const totals = {
      total_tickets:
        Number(totalsResult.rows[0]?.total_tickets || 0),

      total_amount:
        Number(totalsResult.rows[0]?.total_amount || 0)
    };

    const body = await new Promise((resolve, reject) => {

     res.render(
  "student_extra_tickets",
  {
    student,
    sales: salesResult.rows,
    totals,
    dayjs
  },
        (err, html) => {
          if (err) return reject(err);
          resolve(html);
        }
      );

    });

    render(
      req,
      res,
      "layout",
      {
        title: "Boletos extra",
        active: "students",
        body
      }
    );

  } catch (err) {

    console.error(
      "Error al cargar boletos extra:",
      err
    );

    res.status(500).send(
      "Error al cargar boletos extra"
    );
  }
});
app.post("/students/:id/extra-tickets", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {

    const studentId = Number(req.params.id);

    const quantity =
      Number(req.body.quantity || 0);

    const unitPrice =
      Number(req.body.unit_price || 0);

    const notes =
      String(req.body.notes || "").trim();

    if (!Number.isInteger(studentId) || studentId <= 0) {
      return res.status(400).send(
        "Alumno no válido"
      );
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).send(
        "La cantidad de boletos no es válida"
      );
    }

    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return res.status(400).send(
        "El precio por boleto no es válido"
      );
    }


    // ==========================================
    // CONFIRMAR QUE EL ALUMNO EXISTE
    // ==========================================

    const studentResult = await q(
      `
      SELECT
        id,
        full_name
      FROM students
      WHERE id = $1
      LIMIT 1
      `,
      [studentId]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).send(
        "Alumno no encontrado"
      );
    }


    // ==========================================
    // CALCULAR TOTAL
    // ==========================================

    const totalAmount =
      quantity * unitPrice;


    // ==========================================
    // REGISTRAR VENTA
    // ==========================================

    const saleResult = await q(
      `
      INSERT INTO extra_ticket_sales (
        student_id,
        quantity,
        unit_price,
        total_amount,
        payment_status,
        notes,
        created_by,
        created_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'PAID',
        $5,
        $6,
        NOW()
      )
      RETURNING id
      `,
      [
        studentId,
        quantity,
        unitPrice,
        totalAmount,
        notes || null,
        req.session.user?.id || null
      ]
    );

// ==========================================
// GENERAR BOLETOS EXTRA REALES
// ==========================================

const currentYear = new Date().getFullYear();

const existingTicketsResult = await q(
  `
  SELECT COUNT(*)::int AS total
  FROM graduation_tickets
  WHERE student_id = $1
  `,
  [studentId]
);

const existingTickets =
  Number(existingTicketsResult.rows[0]?.total || 0);

for (let index = 1; index <= quantity; index += 1) {

  const ticketNumber =
    existingTickets + index;

  const folio =
    `ITCC-${currentYear}-${studentId}-${String(ticketNumber).padStart(3, "0")}`;

  const secureToken =
    crypto.randomUUID();

  await q(
    `
    INSERT INTO graduation_tickets (
      student_id,
      folio,
      secure_token,
      ticket_type,
      status
    )
    VALUES (
      $1,
      $2,
      $3,
      'EXTRA',
      'AVAILABLE'
    )
    `,
    [
      studentId,
      folio,
      secureToken
    ]
  );

}
    // ==========================================
    // AUDITORÍA
    // ==========================================

    await audit(
      req,
      "CREATE_EXTRA_TICKET_SALE",
      "student",
      studentId,
      {
        sale_id:
          saleResult.rows[0]?.id || null,

        quantity,
        unit_price:
          unitPrice,

        total_amount:
          totalAmount,

        notes
      }
    );


    // ==========================================
    // REGRESAR A LA PANTALLA DEL ALUMNO
    // ==========================================

    return res.redirect(
      `/students/${studentId}/extra-tickets?created=1`
    );


  } catch (err) {

    console.error(
      "Error al registrar boletos extra:",
      err
    );

    res.status(500).send(
      "Error al registrar boletos extra"
    );
  }
});

app.post("/students/:id/refund", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {

    const studentId = Number(req.params.id);

    const amount =
      Number(req.body.amount || 0);

    const reason =
      String(req.body.reason || "").trim();

    const notes =
      String(req.body.notes || "").trim();

    const cancelGraduation =
      req.body.cancel_graduation === "1";


    // ==========================================
    // VALIDACIONES BÁSICAS
    // ==========================================

    if (!Number.isInteger(studentId) || studentId <= 0) {
      return res.status(400).send(
        "Alumno no válido"
      );
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).send(
        "El monto de devolución no es válido"
      );
    }

    if (!reason) {
      return res.status(400).send(
        "Debes indicar el motivo de la devolución"
      );
    }


    // ==========================================
    // VERIFICAR ALUMNO
    // ==========================================

    const studentResult = await q(
      `
      SELECT
        id,
        full_name,
        graduation_status
      FROM students
      WHERE id = $1
      LIMIT 1
      `,
      [studentId]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).send(
        "Alumno no encontrado"
      );
    }


    // ==========================================
    // TOTAL PAGADO
    // ==========================================

    const paymentsResult = await q(
      `
      SELECT
        COALESCE(SUM(amount), 0)::numeric
          AS total_paid
      FROM payments
      WHERE student_id = $1
        AND status = 'CONFIRMED'
      `,
      [studentId]
    );

    const totalPaid =
      Number(
        paymentsResult.rows[0]?.total_paid || 0
      );


    // ==========================================
    // DEVOLUCIONES ANTERIORES
    // ==========================================

    const refundsResult = await q(
      `
      SELECT
        COALESCE(SUM(amount), 0)::numeric
          AS total_refunded
      FROM graduation_refunds
      WHERE student_id = $1
      `,
      [studentId]
    );

    const totalRefunded =
      Number(
        refundsResult.rows[0]?.total_refunded || 0
      );

    const refundableAmount =
      Math.max(
        0,
        totalPaid - totalRefunded
      );


    // ==========================================
    // EVITAR DEVOLVER MÁS DE LO PAGADO
    // ==========================================

    if (amount > refundableAmount) {

      return res.status(400).send(`
        No es posible realizar esta devolución.
        <br><br>
        Total pagado: $${totalPaid.toFixed(2)}
        <br>
        Ya devuelto: $${totalRefunded.toFixed(2)}
        <br>
        Disponible para devolver:
        $${refundableAmount.toFixed(2)}
      `);

    }


    // ==========================================
    // REGISTRAR DEVOLUCIÓN
    // ==========================================

    await q(
      `
      INSERT INTO graduation_refunds
      (
        student_id,
        amount,
        reason,
        notes,
        refund_date,
        created_by
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        CURRENT_DATE,
        $5
      )
      `,
      [
        studentId,
        amount,
        reason,
        notes || null,
        req.session.user?.id || null
      ]
    );


    // ==========================================
    // SI CANCELA GRADUACIÓN
    // ==========================================

    if (cancelGraduation) {

      await q(
        `
        UPDATE students
        SET
          graduation_status = 'REFUNDED',
          billing_active = false
        WHERE id = $1
        `,
        [studentId]
      );

    }


    // ==========================================
    // AUDITORÍA
    // ==========================================

    await audit(
      req,
      "CREATE_REFUND",
      "student",
      studentId,
      {
        amount,
        reason,
        notes,
        cancel_graduation:
          cancelGraduation
      }
    );


    // ==========================================
    // REGRESAR A CONTROL ESCOLAR
    // ==========================================

    return res.redirect(
      `/students?refund_success=1`
    );


  } catch (err) {

    console.error(
      "Error al registrar devolución:",
      err
    );

    res.status(500).send(
      "Error al registrar la devolución"
    );
  }
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
app.post("/students/activate-billing-with-payments", requireAuth, requireRole("ADMIN", "CAJERO"), async (req, res) => {
  try {

    const result = await q(`
      UPDATE students s
      SET billing_active = TRUE
      WHERE COALESCE(s.billing_active, FALSE) = FALSE
        AND EXISTS (
          SELECT 1
          FROM payments p
          WHERE p.student_id = s.id
        )
      RETURNING
        s.id,
        s.full_name
    `);

    const updatedStudents = result.rows;

    console.log(
      `Cobranza activada automáticamente para ${updatedStudents.length} alumnos con pagos registrados`
    );

    res.redirect(
      `/students?billingActivated=${updatedStudents.length}`
    );

  } catch (err) {

    console.error(
      "Error al activar cobranza de alumnos con pagos:",
      err
    );

    res.status(500).send(
      "Error al activar cobranza de alumnos con pagos registrados"
    );
  }
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
app.get("/setup-extra-ticket-sales", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {

    await q(`
      CREATE TABLE IF NOT EXISTS extra_ticket_sales (
        id SERIAL PRIMARY KEY,

        student_id INTEGER NOT NULL REFERENCES students(id),

        quantity INTEGER NOT NULL DEFAULT 1,

        unit_price NUMERIC(12,2) NOT NULL DEFAULT 200,

        total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,

        payment_status VARCHAR(30) NOT NULL DEFAULT 'PAID',

        notes TEXT,

        created_by INTEGER REFERENCES users(id),

        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    res.send(`
      Tabla de ventas de boletos extra creada correctamente
    `);

  } catch (err) {

    console.error(
      "Error al crear tabla de boletos extra:",
      err
    );

    res.status(500).send(
      "Error al crear tabla de boletos extra"
    );
  }
});
app.get("/setup-refunds", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {

    await q(`
      CREATE TABLE IF NOT EXISTS graduation_refunds (
        id SERIAL PRIMARY KEY,

        student_id INTEGER NOT NULL REFERENCES students(id),

        amount NUMERIC(12,2) NOT NULL DEFAULT 0,

        reason TEXT NOT NULL,

        notes TEXT,

        refund_date DATE NOT NULL DEFAULT CURRENT_DATE,

        created_by INTEGER REFERENCES users(id),

        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await q(`
      ALTER TABLE students
      ADD COLUMN IF NOT EXISTS graduation_status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE';
    `);

    res.send(`
      Tabla de devoluciones creada correctamente
      <br>
      Campo graduation_status agregado correctamente
    `);

  } catch (err) {

    console.error(
      "Error al crear estructura de devoluciones:",
      err
    );

    res.status(500).send(
      "Error al crear estructura de devoluciones"
    );
  }
});
app.get("/setup-tickets", requireAuth, async (req, res) => {
  try {

    await q(`
      CREATE TABLE IF NOT EXISTS graduation_tickets (
        id SERIAL PRIMARY KEY,

        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,

        folio VARCHAR(100) NOT NULL UNIQUE,
        secure_token VARCHAR(180) NOT NULL UNIQUE,

        ticket_type VARCHAR(30) NOT NULL DEFAULT 'INCLUDED',
        status VARCHAR(30) NOT NULL DEFAULT 'AVAILABLE',

        used_at TIMESTAMP,
        used_by INTEGER REFERENCES users(id),

        notes TEXT,

        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await q(`
      CREATE INDEX IF NOT EXISTS idx_graduation_tickets_student_id
      ON graduation_tickets(student_id);
    `);

    await q(`
      CREATE INDEX IF NOT EXISTS idx_graduation_tickets_status
      ON graduation_tickets(status);
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS graduation_ticket_logs (
        id SERIAL PRIMARY KEY,

        ticket_id INTEGER REFERENCES graduation_tickets(id) ON DELETE CASCADE,

        action VARCHAR(50) NOT NULL,

        previous_status VARCHAR(30),
        new_status VARCHAR(30),

        scanned_token VARCHAR(180),

        performed_by INTEGER REFERENCES users(id),

        ip_address VARCHAR(100),
        user_agent TEXT,

        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    res.send("Tablas de boletos creadas correctamente");

  } catch (err) {
    console.error(err);
    res.status(500).send("Error al crear tablas de boletos");
  }
});
app.get("/setup-ticket-operators", requireAuth, async (req, res) => {
  try {

    await q(`
      CREATE TABLE IF NOT EXISTS ticket_operators (
        id SERIAL PRIMARY KEY,

        full_name VARCHAR(150) NOT NULL,

        pin_hash TEXT NOT NULL,

        active BOOLEAN NOT NULL DEFAULT TRUE,

        failed_attempts INTEGER NOT NULL DEFAULT 0,

        locked_until TIMESTAMP,

        created_by INTEGER REFERENCES users(id),

        created_at TIMESTAMP DEFAULT NOW(),

        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await q(`
      CREATE INDEX IF NOT EXISTS idx_ticket_operators_active
      ON ticket_operators(active);
    `);
await q(`
  ALTER TABLE graduation_tickets
  ADD COLUMN IF NOT EXISTS used_by_operator
  INTEGER REFERENCES ticket_operators(id);
`);

await q(`
  ALTER TABLE graduation_ticket_logs
  ADD COLUMN IF NOT EXISTS performed_by_operator
  INTEGER REFERENCES ticket_operators(id);
`);
    res.send("Tabla de operadores de acceso creada correctamente");

  } catch (err) {

    console.error(
      "Error al crear tabla de operadores:",
      err
    );

    res.status(500).send(
      "Error al crear tabla de operadores"
    );
  }
});
app.get("/admin/ticket-operators", requireAuth, async (req, res) => {
  try {

    const operatorsResult = await q(`
      SELECT
        id,
        full_name,
        active,
        failed_attempts,
        locked_until,
        created_at,
        updated_at
      FROM ticket_operators
      ORDER BY full_name ASC
    `);

    const operators = operatorsResult.rows.map(operator => ({
      ...operator,

      created_at_fmt: operator.created_at
        ? dayjs(operator.created_at).format("DD/MM/YYYY HH:mm")
        : "",

      updated_at_fmt: operator.updated_at
        ? dayjs(operator.updated_at).format("DD/MM/YYYY HH:mm")
        : "",

      locked_until_fmt: operator.locked_until
        ? dayjs(operator.locked_until).format("DD/MM/YYYY HH:mm")
        : ""
    }));

res.render("ticket_operators_admin", {
  operators,
  queryCreated: req.query.created || ""
});
  } catch (err) {

    console.error(
      "Error al cargar operadores de acceso:",
      err
    );

    res.status(500).send(
      "Error al cargar operadores de acceso"
    );
  }
});
app.post("/admin/ticket-operators/create", requireAuth, async (req, res) => {
  try {

    const fullName = String(
      req.body.full_name || ""
    ).trim();

    const pin = String(
      req.body.pin || ""
    ).trim();

    // Validar nombre
    if (!fullName) {
      return res.status(400).send(
        "El nombre del operador es obligatorio"
      );
    }

    // El PIN debe tener exactamente 4 números
    if (!/^[0-9]{4}$/.test(pin)) {
      return res.status(400).send(
        "El PIN debe contener exactamente 4 números"
      );
    }

    // Revisar operadores activos
    const operatorsResult = await q(`
      SELECT
        id,
        full_name,
        pin_hash
      FROM ticket_operators
      WHERE active = TRUE
    `);

    // Evitar que dos operadores tengan el mismo PIN
    for (const operator of operatorsResult.rows) {

      const samePin = await bcrypt.compare(
        pin,
        operator.pin_hash
      );

      if (samePin) {
        return res.status(400).send(
          "Ese PIN ya pertenece a otro operador. Utiliza uno diferente."
        );
      }
    }

    // Proteger PIN
    const pinHash = await bcrypt.hash(
      pin,
      10
    );

    // Crear operador
    await q(
      `
      INSERT INTO ticket_operators (
        full_name,
        pin_hash,
        active,
        failed_attempts,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        TRUE,
        0,
        NOW(),
        NOW()
      )
      `,
      [
        fullName,
        pinHash
      ]
    );

    // Regresar al panel
    res.redirect(
      "/admin/ticket-operators?created=1"
    );

  } catch (err) {

    console.error(
      "Error al crear operador de acceso:",
      err
    );

    res.status(500).send(
      "Error al crear operador de acceso"
    );
  }
});
app.post("/admin/ticket-operators/:id/toggle", requireAuth, async (req, res) => {
  try {

    const operatorId = Number(req.params.id);

    if (!Number.isInteger(operatorId) || operatorId <= 0) {
      return res.status(400).send(
        "Operador no válido"
      );
    }

    const operatorResult = await q(
      `
      SELECT
        id,
        full_name,
        active
      FROM ticket_operators
      WHERE id = $1
      LIMIT 1
      `,
      [operatorId]
    );

    if (operatorResult.rows.length === 0) {
      return res.status(404).send(
        "Operador no encontrado"
      );
    }

    const operator = operatorResult.rows[0];

    const newStatus = !operator.active;

    await q(
      `
      UPDATE ticket_operators
      SET
        active = $1,
        failed_attempts = 0,
        locked_until = NULL,
        updated_at = NOW()
      WHERE id = $2
      `,
      [
        newStatus,
        operatorId
      ]
    );

    res.redirect(
      "/admin/ticket-operators"
    );

  } catch (err) {

    console.error(
      "Error al cambiar estado del operador:",
      err
    );

    res.status(500).send(
      "Error al cambiar estado del operador"
    );
  }
});
app.post("/admin/ticket-operators/:id/change-pin", requireAuth, async (req, res) => {
  try {

    const operatorId = Number(req.params.id);
    const newPin = String(req.body.pin || "").trim();

    if (!Number.isInteger(operatorId) || operatorId <= 0) {
      return res.status(400).send("Operador no válido");
    }

    if (!/^[0-9]{4}$/.test(newPin)) {
      return res.status(400).send(
        "El PIN debe contener exactamente 4 números"
      );
    }

    const operatorResult = await q(
      `
      SELECT
        id,
        full_name
      FROM ticket_operators
      WHERE id = $1
      LIMIT 1
      `,
      [operatorId]
    );

    if (operatorResult.rows.length === 0) {
      return res.status(404).send(
        "Operador no encontrado"
      );
    }

    // Evitar PIN duplicado entre operadores activos
    const activeOperators = await q(
      `
      SELECT
        id,
        pin_hash
      FROM ticket_operators
      WHERE active = TRUE
        AND id <> $1
      `,
      [operatorId]
    );

    for (const operator of activeOperators.rows) {

      const samePin = await bcrypt.compare(
        newPin,
        operator.pin_hash
      );

      if (samePin) {
        return res.status(400).send(
          "Ese PIN ya pertenece a otro operador activo"
        );
      }
    }

    const newPinHash = await bcrypt.hash(
      newPin,
      10
    );

    await q(
      `
      UPDATE ticket_operators
      SET
        pin_hash = $1,
        failed_attempts = 0,
        locked_until = NULL,
        updated_at = NOW()
      WHERE id = $2
      `,
      [
        newPinHash,
        operatorId
      ]
    );

    res.redirect(
      "/admin/ticket-operators?pinChanged=1"
    );

  } catch (err) {

    console.error(
      "Error al cambiar PIN del operador:",
      err
    );

    res.status(500).send(
      "Error al cambiar PIN del operador"
    );
  }
});
app.get("/setup-first-ticket-operator", requireAuth, async (req, res) => {
  try {

    const fullName = "Operador Acceso 1";

    // PIN temporal para pruebas
    const pin = "4821";

    const existingOperator = await q(
      `
      SELECT id
      FROM ticket_operators
      WHERE full_name = $1
      LIMIT 1
      `,
      [fullName]
    );

    if (existingOperator.rows.length > 0) {
      return res.send(`
        <h2>Operador ya existente</h2>
        <p>${fullName} ya está registrado.</p>
      `);
    }

    const pinHash = await bcrypt.hash(pin, 10);

    await q(
      `
      INSERT INTO ticket_operators (
        full_name,
        pin_hash,
        active
      )
      VALUES ($1, $2, TRUE)
      `,
      [
        fullName,
        pinHash
      ]
    );

    res.send(`
      <h2>Operador creado correctamente</h2>

      <p>
        <strong>Nombre:</strong>
        ${fullName}
      </p>

      <p>
        <strong>PIN temporal:</strong>
        ${pin}
      </p>

      <p>
        El PIN fue almacenado de forma protegida.
      </p>
    `);

  } catch (err) {

    console.error(
      "Error al crear operador de acceso:",
      err
    );

    res.status(500).send(
      "Error al crear operador de acceso"
    );
  }
});
app.get("/tickets/access-login", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta
        name="viewport"
        content="width=device-width, initial-scale=1, viewport-fit=cover"
      >

      <title>Acceso por PIN | ITCC</title>

      <style>
        *{
          box-sizing:border-box;
        }

        body{
          margin:0;
          min-height:100vh;
          padding:24px;

          display:flex;
          align-items:center;
          justify-content:center;

          font-family:Arial,Helvetica,sans-serif;

          background:#17003E;
          color:#ffffff;
        }

        .login-card{
          width:100%;
          max-width:420px;

          padding:28px;

          text-align:center;

          background:rgba(255,255,255,.08);
          border:1px solid rgba(255,255,255,.12);
          border-radius:24px;
        }

        .badge{
          display:inline-block;

          padding:8px 12px;

          color:#17003E;
          background:#FFC400;

          border-radius:999px;

          font-size:12px;
          font-weight:800;
        }

        h1{
          margin:20px 0 8px;

          font-size:30px;
        }

        p{
          margin:0 0 24px;

          color:rgba(255,255,255,.70);

          font-size:14px;
          line-height:1.5;
        }

        input{
          width:100%;

          padding:18px;

          text-align:center;

          color:#ffffff;
          background:rgba(255,255,255,.08);

          border:1px solid rgba(255,255,255,.16);
          border-radius:16px;

          font-size:28px;
          font-weight:800;
          letter-spacing:12px;

          outline:none;
        }

        input::placeholder{
          color:rgba(255,255,255,.35);
        }

        button{
          width:100%;

          margin-top:16px;
          padding:17px;

          border:0;
          border-radius:16px;

          background:#FFC400;
          color:#17003E;

          font-size:17px;
          font-weight:800;

          cursor:pointer;
        }
      </style>
    </head>

    <body>

      <main class="login-card">

        <span class="badge">
          CONTROL DE ACCESO
        </span>

        <h1>
          Ingresa tu PIN
        </h1>

        <p>
          Acceso exclusivo para personal autorizado de boletos.
        </p>

        <form
          method="POST"
          action="/tickets/access-login"
        >

          <input
            name="pin"
            type="password"
            inputmode="numeric"
            maxlength="4"
            pattern="[0-9]{4}"
            placeholder="••••"
            autocomplete="off"
            required
          >

          <button type="submit">
            INGRESAR
          </button>

        </form>

      </main>

    </body>
    </html>
  `);
});
app.post("/tickets/access-login", async (req, res) => {
  try {
    const pin = String(req.body.pin || "").trim();

    if (!/^[0-9]{4}$/.test(pin)) {
      return res.status(400).send("PIN no válido");
    }

    const operatorsResult = await q(
      `
      SELECT
        id,
        full_name,
        pin_hash,
        active,
        failed_attempts,
        locked_until
      FROM ticket_operators
      WHERE active = TRUE
      `
    );

    let matchedOperator = null;

    for (const operator of operatorsResult.rows) {

      if (
        operator.locked_until &&
        dayjs(operator.locked_until).isAfter(dayjs())
      ) {
        continue;
      }

      const matches = await bcrypt.compare(
        pin,
        operator.pin_hash
      );

      if (matches) {
        matchedOperator = operator;
        break;
      }
    }

    if (!matchedOperator) {
      return res.status(401).send(`
        <h2>PIN incorrecto</h2>
        <p>El PIN ingresado no corresponde a un operador autorizado.</p>
        <p>
          <a href="/tickets/access-login">
            Intentar nuevamente
          </a>
        </p>
      `);
    }

    req.session.ticketOperator = {
      id: matchedOperator.id,
      full_name: matchedOperator.full_name,
      last_activity: Date.now()
    };

    await q(
      `
      UPDATE ticket_operators
      SET
        failed_attempts = 0,
        locked_until = NULL,
        updated_at = NOW()
      WHERE id = $1
      `,
      [matchedOperator.id]
    );

    res.redirect("/tickets/access-control");

  } catch (err) {

    console.error(
      "Error en login de operador:",
      err
    );

    res.status(500).send(
      "Error al iniciar sesión de operador"
    );
  }
});
app.get("/setup-demo-tickets", requireAuth, async (req, res) => {
  try {
    const studentId = 766;

    // Queremos 15 boletos incluidos en total:
    // 5 originales + 10 nuevos de prueba
    const includedTickets = 15;

    const studentResult = await q(
      `
      SELECT id, full_name
      FROM students
      WHERE id = $1
      LIMIT 1
      `,
      [studentId]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).send("Alumno de prueba no encontrado");
    }

    const existingResult = await q(
      `
      SELECT COUNT(*)::int AS total
      FROM graduation_tickets
      WHERE student_id = $1
        AND ticket_type = 'INCLUDED'
      `,
      [studentId]
    );

    const existingTickets = Number(
      existingResult.rows[0]?.total || 0
    );

    const currentYear = new Date().getFullYear();

    const missingTickets =
      Math.max(0, includedTickets - existingTickets);

    for (
      let index = 1;
      index <= missingTickets;
      index += 1
    ) {
      const ticketNumber =
        existingTickets + index;

      const folio =
        `ITCC-${currentYear}-${studentId}-${String(
          ticketNumber
        ).padStart(3, "0")}`;

      const secureToken =
        crypto.randomUUID();

      await q(
        `
        INSERT INTO graduation_tickets (
          student_id,
          folio,
          secure_token,
          ticket_type,
          status
        )
        VALUES ($1, $2, $3, 'INCLUDED', 'AVAILABLE')
        ON CONFLICT (folio) DO NOTHING
        `,
        [
          studentId,
          folio,
          secureToken
        ]
      );
    }

    const finalResult = await q(
      `
      SELECT
        folio,
        status,
        ticket_type,
        secure_token
      FROM graduation_tickets
      WHERE student_id = $1
      ORDER BY id ASC
      `,
      [studentId]
    );

    const folios = finalResult.rows
      .map(ticket => `
        <strong>${ticket.folio}</strong><br>
        Estado: ${ticket.status}<br>
        Token: ${ticket.secure_token}<br><br>
      `)
      .join("");

    res.send(`
      <h2>Boletos de prueba listos</h2>

      <p>
        Alumno:
        ${studentResult.rows[0].full_name}
      </p>

      <p>
        Total de boletos:
        ${finalResult.rows.length}
      </p>

      <p>
        Nuevos boletos creados:
        ${missingTickets}
      </p>

      <hr>

      ${folios}
    `);

  } catch (err) {

    console.error(
      "Error al generar boletos de prueba:",
      err
    );

    res
      .status(500)
      .send(
        "Error al generar boletos de prueba"
      );
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
app.get("/setup-payment-history-folios",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    try {
      await q(`
        ALTER TABLE students
        ADD COLUMN IF NOT EXISTS payment_history_folio TEXT
      `);

      await q(`
        ALTER TABLE students
        ADD COLUMN IF NOT EXISTS payment_history_folio_created_at TIMESTAMP
      `);

      await q(`
        ALTER TABLE students
        ADD COLUMN IF NOT EXISTS payment_history_status TEXT
        NOT NULL DEFAULT 'ACTIVE'
      `);

      await q(`
        UPDATE students s
        SET
          payment_history_folio =
            'HP-' ||
            COALESCE(
              (
                SELECT gy.year::text
                FROM graduation_years gy
                WHERE gy.id = s.year_id
              ),
              EXTRACT(YEAR FROM NOW())::int::text
            ) ||
            '-' ||
            LPAD(s.id::text, 6, '0'),

          payment_history_folio_created_at =
            COALESCE(s.payment_history_folio_created_at, NOW()),

       payment_history_status = 'ACTIVE'

        WHERE
          s.payment_history_folio IS NULL
          OR TRIM(s.payment_history_folio) = ''
      `);

      await q(`
        CREATE UNIQUE INDEX IF NOT EXISTS
        students_payment_history_folio_unique
        ON students(payment_history_folio)
      `);

      const result = await q(`
        SELECT COUNT(*)::int AS total
        FROM students
        WHERE payment_history_folio IS NOT NULL
      `);

      return res.send(
        `Folios creados correctamente. Alumnos con folio: ${result.rows[0].total}`
      );
    } catch (error) {
      console.error("Error creando folios permanentes:", error);

      return res
        .status(500)
        .send("No fue posible crear los folios permanentes.");
    }
  }
);
app.get("/setup-provider-role",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    try {
      await q(`
        ALTER TABLE users
        DROP CONSTRAINT IF EXISTS users_role_check
      `);

      await q(`
        ALTER TABLE users
        ADD CONSTRAINT users_role_check
        CHECK (
          role IN ('ADMIN','CAJERO','STUDENT','PROVEEDOR')
        )
      `);

      return res.send(
        "Rol PROVEEDOR habilitado correctamente."
      );
    } catch (error) {
      console.error("Error habilitando rol PROVEEDOR:", error);

      return res
        .status(500)
        .send(
          "No fue posible habilitar el rol PROVEEDOR: " +
          error.message
        );
    }
  }
);
app.get(
  "/setup-create-provider",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    try {
      const username = "fotoestudio";
      const password = "Foto2026";

      const hash = await bcrypt.hash(password, 10);

      const existing = await q(
        "SELECT id FROM users WHERE username=$1",
        [username]
      );

      if (existing.rows.length === 0) {
        await q(
          `
          INSERT INTO users
          (username,password_hash,role)
          VALUES ($1,$2,'PROVEEDOR')
          `,
          [username, hash]
        );
      }

      res.send(`
        <h2>Usuario creado correctamente</h2>
        <p><b>Usuario:</b> fotoestudio</p>
        <p><b>Contraseña:</b> Foto2026</p>
      `);

    } catch(err) {
      console.error(err);
      res.status(500).send(err.message);
    }
  }
);
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
app.get(
  "/admin/backfill-extra-tickets",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    try {

      // ==========================================
      // VENTAS PAGADAS DE BOLETOS EXTRA
      // ==========================================

      const salesResult = await q(`
        SELECT
          student_id,
          COALESCE(SUM(quantity), 0)::int AS paid_extra_tickets
        FROM extra_ticket_sales
        WHERE payment_status = 'PAID'
        GROUP BY student_id
        ORDER BY student_id ASC
      `);

      let totalCreated = 0;
      const details = [];


      // ==========================================
      // REVISAR ALUMNO POR ALUMNO
      // ==========================================

      for (const sale of salesResult.rows) {

        const studentId =
          Number(sale.student_id);

        const paidExtraTickets =
          Number(sale.paid_extra_tickets || 0);


        // Cuántos EXTRA ya tiene realmente

        const existingResult = await q(
          `
          SELECT COUNT(*)::int AS total
          FROM graduation_tickets
          WHERE student_id = $1
            AND ticket_type = 'EXTRA'
          `,
          [studentId]
        );

        const existingExtraTickets =
          Number(existingResult.rows[0]?.total || 0);

        const missingTickets =
          Math.max(
            0,
            paidExtraTickets - existingExtraTickets
          );


        // ==========================================
        // SI YA LOS TIENE, NO CREAR NADA
        // ==========================================

        if (missingTickets <= 0) {

          details.push({
            studentId,
            paid: paidExtraTickets,
            existing: existingExtraTickets,
            created: 0
          });

          continue;
        }


        // ==========================================
        // OBTENER ÚLTIMO NÚMERO DE FOLIO
        // ==========================================

        const lastNumberResult = await q(
          `
          SELECT
            COALESCE(
              MAX(
                CASE
                  WHEN folio ~ '[0-9]{3}$'
                  THEN RIGHT(folio, 3)::int
                  ELSE 0
                END
              ),
              0
            )::int AS last_number
          FROM graduation_tickets
          WHERE student_id = $1
          `,
          [studentId]
        );

        let lastNumber =
          Number(
            lastNumberResult.rows[0]?.last_number || 0
          );

        const currentYear =
          new Date().getFullYear();


        // ==========================================
        // CREAR SOLO LOS QUE FALTAN
        // ==========================================

        for (
          let index = 1;
          index <= missingTickets;
          index += 1
        ) {

          lastNumber += 1;

          const folio =
            `ITCC-${currentYear}-${studentId}-${String(lastNumber).padStart(3, "0")}`;

          const secureToken =
            crypto.randomUUID();

          await q(
            `
            INSERT INTO graduation_tickets (
              student_id,
              folio,
              secure_token,
              ticket_type,
              status
            )
            VALUES (
              $1,
              $2,
              $3,
              'EXTRA',
              'AVAILABLE'
            )
            `,
            [
              studentId,
              folio,
              secureToken
            ]
          );

          totalCreated += 1;
        }


        details.push({
          studentId,
          paid: paidExtraTickets,
          existing: existingExtraTickets,
          created: missingTickets
        });
      }


      // ==========================================
      // RESULTADO
      // ==========================================

      const rowsHtml = details
        .map(item => `
          <tr>
            <td>${item.studentId}</td>
            <td>${item.paid}</td>
            <td>${item.existing}</td>
            <td>${item.created}</td>
          </tr>
        `)
        .join("");

      res.send(`
        <!doctype html>
        <html lang="es">
        <head>
          <meta charset="utf-8">

          <meta
            name="viewport"
            content="width=device-width, initial-scale=1"
          >

          <title>Corrección boletos extra</title>

          <style>
            body{
              font-family:Arial,sans-serif;
              padding:30px;
              background:#f6f6f8;
            }

            .card{
              max-width:800px;
              margin:auto;
              padding:25px;
              background:#fff;
              border-radius:18px;
              box-shadow:0 4px 20px rgba(0,0,0,.08);
            }

            table{
              width:100%;
              border-collapse:collapse;
              margin-top:20px;
            }

            th,td{
              padding:10px;
              border-bottom:1px solid #ddd;
              text-align:left;
            }

            .ok{
              color:#198754;
              font-weight:700;
            }
          </style>
        </head>

        <body>

          <div class="card">

            <h2>
              Corrección de boletos extra
            </h2>

            <p class="ok">
              Boletos EXTRA creados: ${totalCreated}
            </p>

            <table>

              <thead>
                <tr>
                  <th>Alumno ID</th>
                  <th>Pagados</th>
                  <th>Ya existentes</th>
                  <th>Creados ahora</th>
                </tr>
              </thead>

              <tbody>
                ${rowsHtml}
              </tbody>

            </table>

          </div>

        </body>
        </html>
      `);

    } catch (err) {

      console.error(
        "Error corrigiendo boletos extra:",
        err
      );

      res.status(500).send(
        "Error al corregir boletos extra"
      );
    }
  }
);
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
function requireStudentPortalOrAdmin(req, res, next) {
  const isStudent = Boolean(
    req.session &&
    req.session.studentUser &&
    req.session.studentUser.student_id
  );

  const isAdmin = Boolean(
    req.session &&
    req.session.user &&
    req.session.user.role === "ADMIN"
  );

  if (isStudent || isAdmin) {
    return next();
  }

  return res.status(401).send("No tienes autorización para consultar este historial.");
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
  payments,
  canDownloadPaymentHistory: info.student.billing_active === true,
  developmentMode: canUseDevelopmentModules(studentId)
});
});
app.get("/portal/payments", requireStudentPortal, async (req, res) => {
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

  res.render("portal_payments", {
    student: info.student,
    totals: info.totals,
    payments,
    canDownloadPaymentHistory: info.student.billing_active === true
  });
});
app.get("/portal/tickets", requireStudentPortal, async (req, res) => {

  const studentId = req.session.studentUser.student_id;

  if (!canUseDevelopmentModules(studentId)) {
    return res.status(403).send("Módulo de boletos no disponible.");
  }

  const info = await getStudentTotals(studentId);

  if (!info) {
    return res.status(404).send("Alumno no encontrado");
  }

  const ticketResult = await q(
    `
    SELECT
      id,
      folio,
      secure_token,
      ticket_type,
      status,
      used_at,
      created_at
    FROM graduation_tickets
    WHERE student_id = $1
    ORDER BY id ASC
    `,
    [studentId]
  );

const tickets = await Promise.all(
  ticketResult.rows.map(async (ticket) => {

    const verifyUrl =
      `${req.protocol}://${req.get("host")}/tickets/verify/${ticket.secure_token}`;

    const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      width: 320,
      margin: 2
    });

    return {
      ...ticket,
      verify_url: verifyUrl,
      qr_data_url: qrDataUrl
    };

  })
);

  res.render("portal_tickets", {
    student: info.student,
    totals: info.totals,
    tickets,
    developmentMode: canUseDevelopmentModules(studentId)
  });

});

app.get("/portal/tickets/:ticketId/download", requireStudentPortal, async (req, res) => {
  try {
    const studentId = req.session.studentUser.student_id;

    if (!canUseDevelopmentModules(studentId)) {
      return res.status(403).send("Módulo de boletos no disponible.");
    }

    const ticketId = Number(req.params.ticketId);

    if (!Number.isInteger(ticketId) || ticketId <= 0) {
      return res.status(400).send("Boleto no válido");
    }

    const ticketResult = await q(
      `
      SELECT
        gt.id,
        gt.folio,
        gt.secure_token,
        gt.ticket_type,
        gt.status,
        gt.used_at,
        gt.created_at,
        s.full_name AS student_name,
        s.phone_e164,
        c.name AS campus_name,
        p.name AS package_name
      FROM graduation_tickets gt
      LEFT JOIN students s ON s.id = gt.student_id
      LEFT JOIN campuses c ON c.id = s.campus_id
      LEFT JOIN packages p ON p.id = s.package_id
      WHERE gt.id = $1
        AND gt.student_id = $2
      LIMIT 1
      `,
      [ticketId, studentId]
    );

    if (ticketResult.rows.length === 0) {
      return res.status(404).send("Boleto no encontrado");
    }

    const ticket = ticketResult.rows[0];

    const verifyUrl =
      `${req.protocol}://${req.get("host")}/tickets/verify/${ticket.secure_token}`;

    const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      width: 500,
      margin: 1
    });

    const qrImageBuffer = Buffer.from(
      qrDataUrl.replace(/^data:image\/png;base64,/, ""),
      "base64"
    );

    const eventInfo =
      getGraduationEventInfo(ticket.campus_name);

    const safeFileName =
      `boleto-${ticket.folio}`
        .replace(/[^a-zA-Z0-9-_]/g, "-");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFileName}.pdf"`
    );

    const doc = new PDFDocument({
      size: "A4",
      margin: 0
    });

    doc.pipe(res);

    // Fondo general
    doc.rect(0, 0, 595, 842).fill("#17003E");

    // Tarjeta principal
    doc.roundedRect(28, 28, 539, 786, 24).fill("#FFFFFF");

    // Encabezado
    doc.roundedRect(28, 28, 539, 130, 24).fill("#4400B2");

    doc
      .fillColor("#FFFFFF")
      .font("Helvetica-Bold")
      .fontSize(26)
      .text("BOLETO DE GRADUACIÓN", 48, 60, {
        width: 320
      });

    doc
      .font("Helvetica")
      .fontSize(14)
      .text("Universidad y Preparatoria ITCC", 48, 98, {
        width: 280
      });

    doc
      .roundedRect(410, 56, 125, 42, 14)
      .fill("#FFC400");

    doc
      .fillColor("#17003E")
      .font("Helvetica-Bold")
      .fontSize(16)
      .text(
        ticket.ticket_type === "EXTRA"
          ? "EXTRA"
          : "INCLUIDO",
        410,
        69,
        {
          width: 125,
          align: "center"
        }
      );

    // Título de sección
    doc
      .fillColor("#17003E")
      .font("Helvetica-Bold")
      .fontSize(18)
      .text("Información del evento", 48, 188);

    // Datos evento izquierda
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor("#4400B2")
      .text("CEREMONIA", 48, 220);

    doc
      .font("Helvetica")
      .fontSize(14)
      .fillColor("#17003E")
      .text(eventInfo.event_name, 48, 236);

    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor("#4400B2")
      .text("CAMPUS", 48, 272);

    doc
      .font("Helvetica")
      .fontSize(14)
      .fillColor("#17003E")
      .text(eventInfo.campus_label, 48, 288);

    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor("#4400B2")
      .text("FECHA", 48, 324);

    doc
      .font("Helvetica")
      .fontSize(14)
      .fillColor("#17003E")
      .text(eventInfo.event_date_text, 48, 340);

    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor("#4400B2")
      .text("HORA", 48, 376);

    doc
      .font("Helvetica")
      .fontSize(14)
      .fillColor("#17003E")
      .text(eventInfo.event_time_text, 48, 392);

    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor("#4400B2")
      .text("SEDE", 48, 428);

    doc
      .font("Helvetica")
      .fontSize(14)
      .fillColor("#17003E")
      .text(eventInfo.venue, 48, 444, {
        width: 220
      });

    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor("#4400B2")
      .text("DIRECCIÓN", 48, 492);

    doc
      .font("Helvetica")
      .fontSize(13)
      .fillColor("#17003E")
      .text(eventInfo.address_line, 48, 508, {
        width: 220
      });

    // QR box
    doc
      .roundedRect(320, 210, 200, 220, 18)
      .fill("#F5F1FF");

    doc
      .fillColor("#4400B2")
      .font("Helvetica-Bold")
      .fontSize(11)
      .text("ACCESO / CÓDIGO QR", 348, 228);

    doc.image(qrImageBuffer, 350, 252, {
      fit: [140, 140],
      align: "center",
      valign: "center"
    });

    doc
      .fillColor("#17003E")
      .font("Helvetica")
      .fontSize(10)
      .text("Presenta este código al ingresar", 338, 402, {
        width: 164,
        align: "center"
      });

    // Información alumno
    doc
      .fillColor("#17003E")
      .font("Helvetica-Bold")
      .fontSize(18)
      .text("Datos del boleto", 48, 580);

    doc
      .roundedRect(48, 614, 470, 142, 18)
      .fill("#F8F7FC");

    doc
      .fillColor("#4400B2")
      .font("Helvetica-Bold")
      .fontSize(11)
      .text("ALUMNO", 66, 635);

    doc
      .fillColor("#17003E")
      .font("Helvetica")
      .fontSize(15)
      .text(ticket.student_name || "", 66, 651, {
        width: 420
      });

    doc
      .fillColor("#4400B2")
      .font("Helvetica-Bold")
      .fontSize(11)
      .text("FOLIO", 66, 690);

    doc
      .fillColor("#17003E")
      .font("Helvetica")
      .fontSize(14)
      .text(ticket.folio || "", 66, 706);

    doc
      .fillColor("#4400B2")
      .font("Helvetica-Bold")
      .fontSize(11)
      .text("PAQUETE", 250, 690);

    doc
      .fillColor("#17003E")
      .font("Helvetica")
      .fontSize(14)
      .text(ticket.package_name || "", 250, 706, {
        width: 180
      });

    doc
      .fillColor("#4400B2")
      .font("Helvetica-Bold")
      .fontSize(11)
      .text("TIPO DE BOLETO", 66, 730);

    doc
      .fillColor("#17003E")
      .font("Helvetica")
      .fontSize(14)
      .text(
        ticket.ticket_type === "EXTRA"
          ? "Boleto adicional"
          : "Boleto incluido",
        66,
        746
      );

    doc
      .fillColor("#4400B2")
      .font("Helvetica-Bold")
      .fontSize(11)
      .text("ESTATUS", 250, 730);

    doc
      .fillColor("#17003E")
      .font("Helvetica")
      .fontSize(14)
      .text(
        ticket.status === "AVAILABLE"
          ? "Disponible"
          : ticket.status === "USED"
          ? "Utilizado"
          : ticket.status,
        250,
        746
      );

    // Pie
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#5C5470")
      .text(
        eventInfo.recommendation,
        48,
        778,
        {
          width: 470
        }
      );

    doc.end();

  } catch (err) {
    console.error("Error al descargar boleto:", err);
    res.status(500).send("Error al descargar boleto");
  }
});
app.get("/tickets/verify/:token", requireTicketOperator, async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();

    if (!token) {
      return res.status(400).send("Código QR no válido");
    }

    const result = await q(
      `
      SELECT
        gt.id,
        gt.folio,
        gt.secure_token,
        gt.ticket_type,
        gt.status,
        gt.used_at,
        gt.created_at,
        s.full_name AS student_name,
        s.phone_e164,
        c.name AS campus_name,
        p.name AS package_name
      FROM graduation_tickets gt
      LEFT JOIN students s ON s.id = gt.student_id
      LEFT JOIN campuses c ON c.id = s.campus_id
      LEFT JOIN packages p ON p.id = s.package_id
      WHERE gt.secure_token = $1
      LIMIT 1
      `,
      [token]
    );

    // ============================================
    // CÓDIGO / QR NO VÁLIDO
    // ============================================

    if (result.rows.length === 0) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="UTF-8">

          <meta
            name="viewport"
            content="width=device-width, initial-scale=1, viewport-fit=cover"
          >

          <title>Boleto no válido</title>

          <style>
            *{
              box-sizing:border-box;
            }

            body{
              margin:0;
              min-height:100vh;
              padding:24px;

              display:flex;
              align-items:center;
              justify-content:center;

              font-family:Arial,Helvetica,sans-serif;

              background:#17003E;
              color:#ffffff;
            }

            .result-card{
              width:100%;
              max-width:520px;
              padding:28px;

              text-align:center;

              background:rgba(255,255,255,.08);
              border:1px solid rgba(255,255,255,.12);
              border-radius:24px;
            }

            .result-icon{
              width:82px;
              height:82px;

              margin:0 auto 20px;

              display:flex;
              align-items:center;
              justify-content:center;

              border-radius:50%;

              background:#FF6B6B;
              color:#4A0C0C;

              font-size:42px;
              font-weight:800;
            }

            h1{
              margin:0;
              font-size:30px;
              line-height:1.1;
            }

            .message{
              margin:14px auto 0;
              max-width:390px;

              color:rgba(255,255,255,.72);

              font-size:14px;
              line-height:1.5;
            }

            .warning{
              margin-top:22px;
              padding:15px;

              color:#ffffff;
              background:rgba(255,107,107,.12);

              border:1px solid rgba(255,107,107,.25);
              border-radius:15px;

              font-size:13px;
              line-height:1.45;
            }

            .next-button{
              width:100%;

              margin-top:28px;
              padding:18px 20px;

              display:block;

              color:#17003E;
              background:#FFC400;

              border-radius:17px;

              text-decoration:none;

              font-size:17px;
              font-weight:800;
            }

            .panel-button{
              width:100%;

              margin-top:12px;
              padding:15px 20px;

              display:block;

              color:#ffffff;
              background:rgba(255,255,255,.07);

              border:1px solid rgba(255,255,255,.11);
              border-radius:17px;

              text-decoration:none;

              font-size:14px;
              font-weight:700;
            }
          </style>
        </head>

        <body>

          <main class="result-card">

            <div class="result-icon">
              ✕
            </div>

            <h1>
              BOLETO NO VÁLIDO
            </h1>

            <div class="message">
              El código presentado no corresponde a ningún boleto registrado en el sistema.
            </div>

            <div class="warning">
              ⚠️ No permitas el ingreso con este código.
            </div>

            <a
              class="next-button"
              href="/tickets/scan"
            >
              📷 ESCANEAR SIGUIENTE BOLETO
            </a>

            <a
              class="panel-button"
              href="/tickets/access-control"
            >
              Volver al Control de acceso
            </a>

          </main>

        </body>
        </html>
      `);
    }

    const ticket = result.rows[0];

    // ============================================
    // BOLETO YA UTILIZADO
    // ============================================

    if (ticket.status === "USED") {
      return res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="UTF-8">

          <meta
            name="viewport"
            content="width=device-width, initial-scale=1, viewport-fit=cover"
          >

          <title>Ingreso ya registrado</title>

          <style>
            *{
              box-sizing:border-box;
            }

            body{
              margin:0;
              min-height:100vh;
              padding:24px;

              display:flex;
              align-items:center;
              justify-content:center;

              font-family:Arial,Helvetica,sans-serif;

              background:#17003E;
              color:#ffffff;
            }

            .result-card{
              width:100%;
              max-width:520px;
              padding:28px;

              text-align:center;

              background:rgba(255,255,255,.08);
              border:1px solid rgba(255,255,255,.12);
              border-radius:24px;
            }

            .result-icon{
              width:82px;
              height:82px;

              margin:0 auto 20px;

              display:flex;
              align-items:center;
              justify-content:center;

              border-radius:50%;

              background:#FF6B6B;
              color:#4A0C0C;

              font-size:42px;
              font-weight:800;
            }

            h1{
              margin:0;
              font-size:30px;
              line-height:1.1;
            }

            .message{
              margin-top:12px;

              color:rgba(255,255,255,.72);

              font-size:14px;
              line-height:1.45;
            }

            .data{
              margin-top:22px;
              text-align:left;
            }

            .data-row{
              margin-top:11px;

              color:rgba(255,255,255,.76);

              font-size:15px;
              line-height:1.4;
            }

            .data-row strong{
              color:#ffffff;
            }

            .next-button{
              width:100%;

              margin-top:28px;
              padding:18px 20px;

              display:block;

              color:#17003E;
              background:#FFC400;

              border-radius:17px;

              text-decoration:none;

              font-size:17px;
              font-weight:800;
            }

            .panel-button{
              width:100%;

              margin-top:12px;
              padding:15px 20px;

              display:block;

              color:#ffffff;
              background:rgba(255,255,255,.07);

              border:1px solid rgba(255,255,255,.11);
              border-radius:17px;

              text-decoration:none;

              font-size:14px;
              font-weight:700;
            }
          </style>
        </head>

        <body>

          <main class="result-card">

            <div class="result-icon">
              ✕
            </div>

            <h1>
              INGRESO YA REGISTRADO
            </h1>

            <div class="message">
              Este boleto ya fue utilizado anteriormente y no puede acreditarse nuevamente.
            </div>

            <div class="data">

              <div class="data-row">
                <strong>Folio:</strong>
                ${ticket.folio}
              </div>

              <div class="data-row">
                <strong>Alumno:</strong>
                ${ticket.student_name || ""}
              </div>

              <div class="data-row">
                <strong>Campus:</strong>
                ${ticket.campus_name || ""}
              </div>

              <div class="data-row">
                <strong>Registrado:</strong>
                ${
                  ticket.used_at
                    ? dayjs(ticket.used_at).format("DD/MM/YYYY HH:mm")
                    : "Fecha no disponible"
                }
              </div>

            </div>

            <a
              class="next-button"
              href="/tickets/scan"
            >
              📷 ESCANEAR SIGUIENTE BOLETO
            </a>

            <a
              class="panel-button"
              href="/tickets/access-control"
            >
              Volver al Control de acceso
            </a>

          </main>

        </body>
        </html>
      `);
    }

    // ============================================
    // BOLETO CANCELADO
    // ============================================

    if (ticket.status === "CANCELED") {
      return res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="UTF-8">

          <meta
            name="viewport"
            content="width=device-width, initial-scale=1, viewport-fit=cover"
          >

          <title>Boleto cancelado</title>

          <style>
            *{
              box-sizing:border-box;
            }

            body{
              margin:0;
              min-height:100vh;
              padding:24px;

              display:flex;
              align-items:center;
              justify-content:center;

              font-family:Arial,Helvetica,sans-serif;

              background:#17003E;
              color:#ffffff;
            }

            .result-card{
              width:100%;
              max-width:520px;
              padding:28px;

              text-align:center;

              background:rgba(255,255,255,.08);
              border:1px solid rgba(255,255,255,.12);
              border-radius:24px;
            }

            .result-icon{
              width:82px;
              height:82px;

              margin:0 auto 20px;

              display:flex;
              align-items:center;
              justify-content:center;

              border-radius:50%;

              background:#FF6B6B;
              color:#4A0C0C;

              font-size:42px;
              font-weight:800;
            }

            h1{
              margin:0;
              font-size:30px;
            }

            .message{
              margin-top:14px;

              color:rgba(255,255,255,.72);

              font-size:14px;
              line-height:1.5;
            }

            .data{
              margin-top:22px;
              text-align:left;
            }

            .data-row{
              margin-top:11px;
              color:rgba(255,255,255,.76);
            }

            .data-row strong{
              color:#ffffff;
            }

            .next-button{
              width:100%;

              margin-top:28px;
              padding:18px 20px;

              display:block;

              color:#17003E;
              background:#FFC400;

              border-radius:17px;

              text-decoration:none;

              font-size:17px;
              font-weight:800;
            }
          </style>
        </head>

        <body>

          <main class="result-card">

            <div class="result-icon">
              ✕
            </div>

            <h1>
              BOLETO CANCELADO
            </h1>

            <div class="message">
              Este boleto fue cancelado y no puede utilizarse para ingresar.
            </div>

            <div class="data">

              <div class="data-row">
                <strong>Folio:</strong>
                ${ticket.folio}
              </div>

              <div class="data-row">
                <strong>Alumno:</strong>
                ${ticket.student_name || ""}
              </div>

            </div>

            <a
              class="next-button"
              href="/tickets/scan"
            >
              📷 ESCANEAR SIGUIENTE BOLETO
            </a>

          </main>

        </body>
        </html>
      `);
    }

    // ============================================
    // OTRO ESTADO NO DISPONIBLE
    // ============================================

    if (ticket.status !== "AVAILABLE") {
      return res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="UTF-8">

          <meta
            name="viewport"
            content="width=device-width, initial-scale=1, viewport-fit=cover"
          >

          <title>Boleto no disponible</title>

          <style>
            *{
              box-sizing:border-box;
            }

            body{
              margin:0;
              min-height:100vh;
              padding:24px;

              display:flex;
              align-items:center;
              justify-content:center;

              font-family:Arial,Helvetica,sans-serif;

              background:#17003E;
              color:#ffffff;
            }

            .result-card{
              width:100%;
              max-width:520px;
              padding:28px;

              text-align:center;

              background:rgba(255,255,255,.08);
              border:1px solid rgba(255,255,255,.12);
              border-radius:24px;
            }

            .result-icon{
              width:82px;
              height:82px;

              margin:0 auto 20px;

              display:flex;
              align-items:center;
              justify-content:center;

              border-radius:50%;

              background:#FFC400;
              color:#17003E;

              font-size:42px;
              font-weight:800;
            }

            h1{
              margin:0;
              font-size:30px;
            }

            .message{
              margin-top:14px;

              color:rgba(255,255,255,.72);

              font-size:14px;
              line-height:1.5;
            }

            .next-button{
              width:100%;

              margin-top:28px;
              padding:18px 20px;

              display:block;

              color:#17003E;
              background:#FFC400;

              border-radius:17px;

              text-decoration:none;

              font-size:17px;
              font-weight:800;
            }
          </style>
        </head>

        <body>

          <main class="result-card">

            <div class="result-icon">
              !
            </div>

            <h1>
              BOLETO NO DISPONIBLE
            </h1>

            <div class="message">
              Estado actual: ${ticket.status}
            </div>

            <a
              class="next-button"
              href="/tickets/scan"
            >
              📷 ESCANEAR SIGUIENTE BOLETO
            </a>

          </main>

        </body>
        </html>
      `);
    }

    // ============================================
    // BOLETO VÁLIDO / DISPONIBLE
    // ============================================

    return res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">

        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        >

        <title>Verificación de boleto</title>

        <style>
          *{
            box-sizing:border-box;
          }

          body{
            margin:0;
            min-height:100vh;
            padding:24px;

            display:flex;
            align-items:center;
            justify-content:center;

            font-family:Arial,Helvetica,sans-serif;

            background:#17003E;
            color:#ffffff;
          }

          .verify-card{
            width:100%;
            max-width:520px;
            padding:28px;

            background:rgba(255,255,255,.08);
            border:1px solid rgba(255,255,255,.12);
            border-radius:24px;
          }

          .valid-badge{
            display:inline-block;

            padding:8px 12px;

            color:#07381F;
            background:#50E391;

            border-radius:999px;

            font-size:13px;
            font-weight:800;
          }

          h1{
            margin:20px 0 22px;
            font-size:30px;
          }

          .ticket-row{
            margin-top:13px;

            color:rgba(255,255,255,.78);

            font-size:16px;
            line-height:1.4;
          }

          .ticket-row strong{
            color:#ffffff;
          }

          .accredit-form{
            margin-top:28px;
          }

          .accredit-button{
            width:100%;
            padding:17px 20px;

            border:0;
            border-radius:16px;

            background:#FFC400;
            color:#17003E;

            font-size:17px;
            font-weight:800;

            cursor:pointer;
          }

          .warning{
            margin-top:15px;

            color:rgba(255,255,255,.62);

            text-align:center;

            font-size:12px;
            line-height:1.4;
          }

          .scan-button{
            width:100%;

            margin-top:12px;
            padding:15px 20px;

            display:block;

            color:#ffffff;
            background:rgba(255,255,255,.07);

            border:1px solid rgba(255,255,255,.11);
            border-radius:16px;

            text-align:center;
            text-decoration:none;

            font-size:14px;
            font-weight:700;
          }
        </style>
      </head>

      <body>

        <main class="verify-card">

          <span class="valid-badge">
            ✓ BOLETO VÁLIDO
          </span>

          <h1>
            Verificación de acceso
          </h1>

          <div class="ticket-row">
            <strong>Folio:</strong>
            ${ticket.folio}
          </div>

          <div class="ticket-row">
            <strong>Alumno:</strong>
            ${ticket.student_name || ""}
          </div>

          <div class="ticket-row">
            <strong>Campus:</strong>
            ${ticket.campus_name || ""}
          </div>

          <div class="ticket-row">
            <strong>Paquete:</strong>
            ${ticket.package_name || ""}
          </div>

          <div class="ticket-row">
            <strong>Tipo:</strong>
            ${
              ticket.ticket_type === "EXTRA"
                ? "Boleto extra"
                : "Boleto incluido"
            }
          </div>

          <div class="ticket-row">
            <strong>Estado:</strong>
            Disponible
          </div>

          <form
            class="accredit-form"
            method="POST"
            action="/tickets/accredit/${encodeURIComponent(token)}"
          >

            <button
              class="accredit-button"
              type="submit"
            >
              ACREDITAR INGRESO
            </button>

          </form>

          <a
            class="scan-button"
            href="/tickets/scan"
          >
            Volver al escáner
          </a>

          <div class="warning">
            Una vez acreditado, este boleto no podrá volver a utilizarse.
          </div>

        </main>

      </body>
      </html>
    `);

  } catch (err) {
    console.error("Error al verificar boleto:", err);
    res.status(500).send("Error al verificar boleto");
  }
});
app.get("/tickets/access-control", requireTicketOperator, async (req, res) => {
  try {

    // Total de boletos registrados
    const totalResult = await q(`
      SELECT COUNT(*)::int AS total
      FROM graduation_tickets
    `);

    // Boletos todavía disponibles
    const availableResult = await q(`
      SELECT COUNT(*)::int AS total
      FROM graduation_tickets
      WHERE status = 'AVAILABLE'
    `);

    // Boletos ya acreditados
    const usedResult = await q(`
      SELECT COUNT(*)::int AS total
      FROM graduation_tickets
      WHERE status = 'USED'
    `);

    // Últimos accesos registrados
    const recentResult = await q(`
      SELECT
        gt.folio,
        gt.ticket_type,
        gt.used_at,
        s.full_name AS student_name
      FROM graduation_tickets gt
      LEFT JOIN students s
        ON s.id = gt.student_id
      WHERE gt.status = 'USED'
      ORDER BY gt.used_at DESC NULLS LAST
      LIMIT 10
    `);

    const stats = {
      total: totalResult.rows[0]?.total || 0,
      available: availableResult.rows[0]?.total || 0,
      used: usedResult.rows[0]?.total || 0
    };

    const recentAccess = recentResult.rows.map(row => ({
      ...row,
      used_at_fmt: row.used_at
        ? dayjs(row.used_at).format("DD/MM/YYYY HH:mm")
        : "-"
    }));

    res.render("ticket_access_control", {
      stats,
      recentAccess
    });

  } catch (err) {

    console.error(
      "Error al cargar control de acceso:",
      err
    );

    res.status(500).send(
      "Error al cargar el control de acceso"
    );

  }
});
app.get("/tickets/scan", requireTicketOperator, async (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">

      <meta
        name="viewport"
        content="width=device-width, initial-scale=1, viewport-fit=cover"
      >

      <title>Escáner de boletos ITCC</title>

      <style>
        *{
          box-sizing:border-box;
        }

        body{
          margin:0;
          min-height:100vh;
          padding:
            max(24px, env(safe-area-inset-top))
            20px
            max(30px, env(safe-area-inset-bottom));

          font-family:Arial,Helvetica,sans-serif;

          background:#17003E;
          color:#ffffff;
        }

        .scan-app{
          width:100%;
          max-width:560px;
          margin:0 auto;
        }

        .scan-badge{
          display:inline-block;

          padding:8px 13px;

          color:#17003E;
          background:#FFC400;

          border-radius:999px;

          font-size:12px;
          font-weight:800;
        }

        h1{
          margin:20px 0 8px;

          font-size:32px;
          line-height:1.1;
        }

        .intro{
          margin:0;

          color:rgba(255,255,255,.70);

          font-size:14px;
          line-height:1.5;
        }

        .camera-card,
        .manual-card{
          margin-top:24px;
          padding:20px;

          background:rgba(255,255,255,.08);

          border:1px solid rgba(255,255,255,.12);
          border-radius:24px;
        }

        .camera-card h2,
        .manual-card h2{
          margin:0 0 14px;

          font-size:20px;
        }

        #reader{
          width:100%;

          overflow:hidden;

          background:#ffffff;

          border-radius:18px;
        }

        #reader video{
          border-radius:18px;
        }

        .camera-button{
          width:100%;

          margin-top:16px;
          padding:16px;

          border:0;
          border-radius:16px;

          background:#FFC400;
          color:#17003E;

          font-size:16px;
          font-weight:800;

          cursor:pointer;
        }

        .camera-button.stop{
          color:#ffffff;
          background:#8E2A2A;
        }

        .camera-status{
          margin-top:14px;

          color:rgba(255,255,255,.68);

          text-align:center;
          font-size:13px;
          line-height:1.4;
        }

        .divider{
          margin:26px 0 0;

          display:flex;
          align-items:center;
          gap:12px;

          color:rgba(255,255,255,.45);

          font-size:12px;
          font-weight:700;
        }

        .divider::before,
        .divider::after{
          content:"";

          height:1px;
          flex:1;

          background:rgba(255,255,255,.15);
        }

        label{
          display:block;

          margin-bottom:8px;

          font-size:14px;
          font-weight:700;
        }

        input{
          width:100%;

          padding:16px;

          color:#ffffff;
          background:rgba(255,255,255,.08);

          border:1px solid rgba(255,255,255,.16);
          border-radius:15px;

          font-size:16px;
          outline:none;
        }

        input::placeholder{
          color:rgba(255,255,255,.42);
        }

        .verify-button{
          width:100%;

          margin-top:14px;
          padding:17px 20px;

          border:0;
          border-radius:16px;

          background:#ffffff;
          color:#17003E;

          font-size:16px;
          font-weight:800;

          cursor:pointer;
        }

        .security-note{
          margin-top:22px;
          padding:14px 16px;

          color:rgba(255,255,255,.65);

          background:rgba(255,255,255,.04);

          border:1px solid rgba(255,255,255,.08);
          border-radius:16px;

          font-size:12px;
          line-height:1.45;
        }

        @media(max-width:480px){

          h1{
            font-size:28px;
          }

          .camera-card,
          .manual-card{
            padding:17px;
          }

        }
      </style>

      <script
        src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js">
      </script>

    </head>

    <body>

      <main class="scan-app">

        <span class="scan-badge">
          CONTROL DE ACCESO
        </span>

        <h1>
          Escáner de boletos
        </h1>

        <p class="intro">
          Escanea el código QR presentado por el invitado.
        </p>

        <section class="camera-card">

          <h2>
            📷 Escanear código QR
          </h2>

          <div id="reader"></div>

          <button
            id="cameraButton"
            class="camera-button"
            type="button"
          >
            INICIAR CÁMARA
          </button>

          <div
            id="cameraStatus"
            class="camera-status"
          >
            La cámara está desactivada.
          </div>

        </section>

        <div class="divider">
          O VERIFICAR MANUALMENTE
        </div>

        <section class="manual-card">

          <h2>
            Ingresar folio
          </h2>

          <form
            method="GET"
            action="/tickets/scan/verify"
          >

            <label for="code">
              Folio o token
            </label>

            <input
              id="code"
              name="code"
              type="text"
              placeholder="Ej. ITCC-2026-766-003"
              autocomplete="off"
              required
            >

            <button
              class="verify-button"
              type="submit"
            >
              VERIFICAR BOLETO
            </button>

          </form>

        </section>

        <div class="security-note">
          Cada boleto puede acreditarse una sola vez. Si un QR ya fue utilizado,
          el sistema mostrará automáticamente la fecha y hora del primer ingreso.
        </div>

      </main>

      <script>

        let scanner = null;
        let cameraActive = false;
        let processingCode = false;

        const cameraButton =
          document.getElementById("cameraButton");

        const cameraStatus =
          document.getElementById("cameraStatus");


        function extractTicketCode(decodedText){

          const value = String(decodedText || "").trim();

          try{

            const url = new URL(value);

            const marker = "/tickets/verify/";

            if(url.pathname.includes(marker)){

              const token =
                url.pathname.split(marker)[1];

              return decodeURIComponent(token || "");

            }

          }catch(error){

            // Si no es una URL, puede ser folio o token directo.

          }

          return value;

        }


        async function handleQrSuccess(
          decodedText,
          decodedResult
        ){

          if(processingCode){
            return;
          }

          processingCode = true;

          const code =
            extractTicketCode(decodedText);

          if(!code){

            processingCode = false;
            return;

          }

          cameraStatus.textContent =
            "Código detectado. Verificando boleto...";

          try{

            if(scanner && cameraActive){

              await scanner.stop();

              cameraActive = false;

            }

          }catch(error){

            console.log(
              "No fue necesario detener la cámara.",
              error
            );

          }

          window.location.href =
            "/tickets/scan/verify?code=" +
            encodeURIComponent(code);

        }


        async function startCamera(){

          if(cameraActive){
            return;
          }

          cameraStatus.textContent =
            "Solicitando acceso a la cámara...";

          scanner =
            new Html5Qrcode("reader");

          try{

            await scanner.start(
              {
                facingMode:"environment"
              },
              {
                fps:10,
                qrbox:{
                  width:250,
                  height:250
                }
              },
              handleQrSuccess,
              function(errorMessage){
                // Los intentos normales de lectura no se muestran.
              }
            );

            cameraActive = true;

            cameraButton.textContent =
              "DETENER CÁMARA";

            cameraButton.classList.add("stop");

            cameraStatus.textContent =
              "Cámara activa. Coloca el QR dentro del recuadro.";

          }catch(error){

            console.error(
              "Error al iniciar cámara:",
              error
            );

            cameraStatus.textContent =
              "No fue posible abrir la cámara. Revisa los permisos del navegador.";

          }

        }


        async function stopCamera(){

          if(!scanner || !cameraActive){
            return;
          }

          try{

            await scanner.stop();

            cameraActive = false;

            cameraButton.textContent =
              "INICIAR CÁMARA";

            cameraButton.classList.remove("stop");

            cameraStatus.textContent =
              "La cámara está desactivada.";

          }catch(error){

            console.error(
              "Error al detener cámara:",
              error
            );

          }

        }


        cameraButton.addEventListener(
          "click",
          async function(){

            if(cameraActive){

              await stopCamera();

            }else{

              processingCode = false;

              await startCamera();

            }

          }
        );

      </script>

    </body>
    </html>
  `);
});
app.get("/tickets/scan/verify", requireTicketOperator, async (req, res) => {
  try {
    const code = String(req.query.code || "").trim();

    if (!code) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="UTF-8">
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1, viewport-fit=cover"
          >

          <title>Boleto no válido</title>

          <style>
            *{
              box-sizing:border-box;
            }

            body{
              margin:0;
              min-height:100vh;
              padding:24px;

              display:flex;
              align-items:center;
              justify-content:center;

              font-family:Arial,Helvetica,sans-serif;

              background:#17003E;
              color:#ffffff;
            }

            .result-card{
              width:100%;
              max-width:520px;
              padding:28px;

              text-align:center;

              background:rgba(255,255,255,.08);
              border:1px solid rgba(255,255,255,.12);
              border-radius:24px;
            }

            .result-icon{
              width:82px;
              height:82px;

              margin:0 auto 20px;

              display:flex;
              align-items:center;
              justify-content:center;

              border-radius:50%;

              background:#FF6B6B;
              color:#4A0C0C;

              font-size:42px;
              font-weight:800;
            }

            h1{
              margin:0;
              font-size:30px;
              line-height:1.1;
            }

            .message{
              margin:14px auto 0;
              max-width:390px;

              color:rgba(255,255,255,.72);

              font-size:14px;
              line-height:1.5;
            }

            .warning{
              margin-top:22px;
              padding:15px;

              color:#ffffff;
              background:rgba(255,107,107,.12);

              border:1px solid rgba(255,107,107,.25);
              border-radius:15px;

              font-size:13px;
              line-height:1.45;
            }

            .next-button{
              width:100%;

              margin-top:28px;
              padding:18px 20px;

              display:block;

              color:#17003E;
              background:#FFC400;

              border-radius:17px;

              text-decoration:none;

              font-size:17px;
              font-weight:800;
            }

            .panel-button{
              width:100%;

              margin-top:12px;
              padding:15px 20px;

              display:block;

              color:#ffffff;
              background:rgba(255,255,255,.07);

              border:1px solid rgba(255,255,255,.11);
              border-radius:17px;

              text-decoration:none;

              font-size:14px;
              font-weight:700;
            }
          </style>
        </head>

        <body>

          <main class="result-card">

            <div class="result-icon">
              ✕
            </div>

            <h1>
              BOLETO NO VÁLIDO
            </h1>

            <div class="message">
              No se recibió un código o folio válido.
            </div>

            <div class="warning">
              ⚠️ No permitas el ingreso con este código.
            </div>

            <a
              class="next-button"
              href="/tickets/scan"
            >
              📷 ESCANEAR SIGUIENTE BOLETO
            </a>

            <a
              class="panel-button"
              href="/tickets/access-control"
            >
              Volver al Control de acceso
            </a>

          </main>

        </body>
        </html>
      `);
    }

    const result = await q(
      `
      SELECT
        gt.id,
        gt.folio,
        gt.secure_token,
        gt.ticket_type,
        gt.status,
        gt.used_at,
        s.full_name AS student_name,
        c.name AS campus_name,
        p.name AS package_name
      FROM graduation_tickets gt
      LEFT JOIN students s
        ON s.id = gt.student_id
      LEFT JOIN campuses c
        ON c.id = s.campus_id
      LEFT JOIN packages p
        ON p.id = s.package_id
      WHERE gt.secure_token = $1
         OR gt.folio = $1
      LIMIT 1
      `,
      [code]
    );

    if (result.rows.length === 0) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="UTF-8">

          <meta
            name="viewport"
            content="width=device-width, initial-scale=1, viewport-fit=cover"
          >

          <title>Boleto no válido</title>

          <style>
            *{
              box-sizing:border-box;
            }

            body{
              margin:0;
              min-height:100vh;
              padding:24px;

              display:flex;
              align-items:center;
              justify-content:center;

              font-family:Arial,Helvetica,sans-serif;

              background:#17003E;
              color:#ffffff;
            }

            .result-card{
              width:100%;
              max-width:520px;
              padding:28px;

              text-align:center;

              background:rgba(255,255,255,.08);
              border:1px solid rgba(255,255,255,.12);
              border-radius:24px;
            }

            .result-icon{
              width:82px;
              height:82px;

              margin:0 auto 20px;

              display:flex;
              align-items:center;
              justify-content:center;

              border-radius:50%;

              background:#FF6B6B;
              color:#4A0C0C;

              font-size:42px;
              font-weight:800;
            }

            h1{
              margin:0;
              font-size:30px;
              line-height:1.1;
            }

            .message{
              margin:14px auto 0;
              max-width:390px;

              color:rgba(255,255,255,.72);

              font-size:14px;
              line-height:1.5;
            }

            .warning{
              margin-top:22px;
              padding:15px;

              color:#ffffff;
              background:rgba(255,107,107,.12);

              border:1px solid rgba(255,107,107,.25);
              border-radius:15px;

              font-size:13px;
              line-height:1.45;
            }

            .next-button{
              width:100%;

              margin-top:28px;
              padding:18px 20px;

              display:block;

              color:#17003E;
              background:#FFC400;

              border-radius:17px;

              text-decoration:none;

              font-size:17px;
              font-weight:800;
            }

            .panel-button{
              width:100%;

              margin-top:12px;
              padding:15px 20px;

              display:block;

              color:#ffffff;
              background:rgba(255,255,255,.07);

              border:1px solid rgba(255,255,255,.11);
              border-radius:17px;

              text-decoration:none;

              font-size:14px;
              font-weight:700;
            }
          </style>
        </head>

        <body>

          <main class="result-card">

            <div class="result-icon">
              ✕
            </div>

            <h1>
              BOLETO NO VÁLIDO
            </h1>

            <div class="message">
              El código presentado no corresponde a ningún boleto registrado en el sistema.
            </div>

            <div class="warning">
              ⚠️ No permitas el ingreso con este código.
            </div>

            <a
              class="next-button"
              href="/tickets/scan"
            >
              📷 ESCANEAR SIGUIENTE BOLETO
            </a>

            <a
              class="panel-button"
              href="/tickets/access-control"
            >
              Volver al Control de acceso
            </a>

          </main>

        </body>
        </html>
      `);
    }

    const ticket = result.rows[0];

    return res.redirect(
      `/tickets/verify/${encodeURIComponent(ticket.secure_token)}`
    );

  } catch (err) {
    console.error(
      "Error al verificar desde escáner:",
      err
    );

    res.status(500).send(
      "Error al verificar boleto"
    );
  }
});
app.post("/tickets/accredit/:token", requireTicketOperator, async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();

    if (!token) {
      return res.status(400).send("Token no válido");
    }

    const operatorId = Number(
      req.session.ticketOperator?.id || 0
    );

    if (!operatorId) {
      return res.status(401).send(
        "Operador de acceso no válido"
      );
    }

    const result = await q(
      `
      UPDATE graduation_tickets
      SET
        status = 'USED',
        used_at = NOW(),
        used_by_operator = $2,
        updated_at = NOW()
      WHERE secure_token = $1
        AND status = 'AVAILABLE'
      RETURNING id, folio, student_id, status, used_at
      `,
      [token, operatorId]
    );

    if (result.rows.length === 0) {
      const check = await q(
        `
        SELECT folio, status, used_at
        FROM graduation_tickets
        WHERE secure_token = $1
        LIMIT 1
        `,
        [token]
      );

      if (check.rows.length === 0) {
        return res.status(404).send("Código QR no válido");
      }

      const ticket = check.rows[0];

      if (ticket.status === "USED") {
        return res.send(`
          <h2>❌ BOLETO YA UTILIZADO</h2>
          <p><strong>Folio:</strong> ${ticket.folio}</p>
          <p><strong>Utilizado:</strong> ${
            ticket.used_at
              ? dayjs(ticket.used_at).format("DD/MM/YYYY HH:mm")
              : "Fecha no disponible"
          }</p>
        `);
      }

      return res.send(`
        <h2>⚠️ BOLETO NO DISPONIBLE</h2>
        <p><strong>Folio:</strong> ${ticket.folio}</p>
        <p><strong>Estado:</strong> ${ticket.status}</p>
      `);
    }

    const ticket = result.rows[0];

    await q(
      `
      INSERT INTO graduation_ticket_logs (
        ticket_id,
        action,
        previous_status,
        new_status,
        scanned_token,
        performed_by_operator,
        ip_address,
        user_agent
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        ticket.id,
        "ACCREDIT",
        "AVAILABLE",
        "USED",
        token,
        operatorId,
        req.ip || null,
        req.get("user-agent") || null
      ]
    );

    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">

        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        >

        <title>Ingreso acreditado</title>

        <style>
          *{
            box-sizing:border-box;
          }

          body{
            margin:0;
            min-height:100vh;
            padding:24px;

            display:flex;
            align-items:center;
            justify-content:center;

            font-family:Arial,Helvetica,sans-serif;

            background:#17003E;
            color:#ffffff;
          }

          .result-card{
            width:100%;
            max-width:520px;

            padding:28px;

            text-align:center;

            background:rgba(255,255,255,.08);
            border:1px solid rgba(255,255,255,.12);
            border-radius:24px;
          }

          .result-icon{
            width:82px;
            height:82px;

            margin:0 auto 20px;

            display:flex;
            align-items:center;
            justify-content:center;

            border-radius:50%;

            background:#2CCB71;
            color:#07381F;

            font-size:44px;
            font-weight:800;
          }

          h1{
            margin:0;

            font-size:30px;
            line-height:1.1;
          }

          .folio{
            margin-top:20px;

            color:rgba(255,255,255,.80);

            font-size:16px;
          }

          .folio strong{
            color:#ffffff;
          }

          .date{
            margin-top:10px;

            color:rgba(255,255,255,.68);

            font-size:14px;
          }

          .next-button{
            width:100%;

            margin-top:28px;
            padding:18px 20px;

            display:block;

            color:#17003E;
            background:#FFC400;

            border-radius:17px;

            text-decoration:none;

            font-size:17px;
            font-weight:800;
          }

          .panel-button{
            width:100%;

            margin-top:12px;
            padding:15px 20px;

            display:block;

            color:#ffffff;
            background:rgba(255,255,255,.07);

            border:1px solid rgba(255,255,255,.11);
            border-radius:17px;

            text-decoration:none;

            font-size:14px;
            font-weight:700;
          }
        </style>
      </head>

      <body>

        <main class="result-card">

          <div class="result-icon">
            ✓
          </div>

          <h1>
            INGRESO ACREDITADO
          </h1>

          <div class="folio">
            <strong>Folio:</strong>
            ${ticket.folio}
          </div>

          <div class="date">
            ${dayjs(ticket.used_at).format("DD/MM/YYYY HH:mm")}
          </div>

          <a
            class="next-button"
            href="/tickets/scan"
          >
            📷 ESCANEAR SIGUIENTE BOLETO
          </a>

          <a
            class="panel-button"
            href="/tickets/access-control"
          >
            Volver al Control de acceso
          </a>

        </main>

      </body>
      </html>
    `);

  } catch (err) {
    console.error("Error al acreditar boleto:", err);
    res.status(500).send("Error al acreditar boleto");
  }
});
// PDF del historial de pagos del alumno
app.get("/portal/payment-history.pdf", requireStudentPortalOrAdmin, async (req, res) => {
  const isAdmin =
    req.session.user &&
    req.session.user.role === "ADMIN";

const portalStudentId = Number(
  req.session &&
  req.session.studentUser &&
  req.session.studentUser.student_id
);

const requestedStudentId = Number(req.query.student_id);

/*
  Si el administrador envía un alumno válido, usa ese ID.
  Si no hay un ID enviado, utiliza automáticamente el alumno
  que inició sesión en el portal.
*/
const studentId =
  isAdmin &&
  Number.isInteger(requestedStudentId) &&
  requestedStudentId > 0
    ? requestedStudentId
    : portalStudentId;

if (!Number.isInteger(studentId) || studentId <= 0) {
  return res
    .status(400)
    .send("El alumno seleccionado no es válido.");
}

  const info = await getStudentTotals(studentId);

  if (!info) {
    return res.status(404).send("Alumno no encontrado");
  }

  const student = info.student;
  const totals = info.totals;

  // El historial solo puede generarse si la cobranza está activa
  if (student.billing_active !== true) {
    return res
      .status(403)
      .send("El historial de pagos no está disponible porque la cobranza no está activa.");
  }

  const pay = await q(
    `
    SELECT
      id,
      amount,
      method,
      status,
      note,
      created_at
    FROM payments
    WHERE student_id = $1
      AND status = 'CONFIRMED'
    ORDER BY created_at ASC
    `,
    [studentId]
  );

  const payments = pay.rows;

const folio = student.payment_history_folio;

if (!folio) {
  return res
    .status(500)
    .send("El alumno no tiene un folio asignado.");
}
const doc = new PDFDocument({

  size: "LETTER",

  layout: "portrait",

  margin: 0

});

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="historial-pagos-${folio}.pdf"`
  );

  doc.pipe(res);

  const PURPLE = "#4400B2";
  const DARK_PURPLE = "#2A006F";
  const YELLOW = "#FFC400";
  const GREEN = "#148A2A";
  const RED = "#D71920";
  const LIGHT_PURPLE = "#F5F1FC";
  const GRAY = "#555555";
  const BORDER = "#D7CCE9";

  const money = value =>
    `$${Number(value || 0).toLocaleString("es-MX", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;

  const totalDue = Number(totals.total_due || 0);
  const totalPaid = Number(totals.total_paid || 0);
  const balance = Number(totals.balance || 0);
  const discount = Number(student.discount_amount || 0);

  // Fondo general
  doc.rect(0, 0, 612, 792).fill("#FFFFFF");

  // Encabezado morado
  doc
    .save()
    .moveTo(0, 0)
    .lineTo(355, 0)
    .lineTo(305, 118)
    .lineTo(0, 118)
    .closePath()
    .fill(DARK_PURPLE)
    .restore();

  // Franja amarilla decorativa
  doc
    .save()
    .moveTo(320, 0)
    .lineTo(338, 0)
    .lineTo(290, 118)
    .lineTo(278, 118)
    .closePath()
    .fill(YELLOW)
    .restore();

// Logotipo oficial ITCC
const paymentHistoryLogoPath =
  process.cwd() + "/src/public/images/logo-itcc.png";

doc.image(paymentHistoryLogoPath, 30, 13, {
  fit: [250, 93],
  align: "center",
  valign: "center"
});

  // Datos superiores
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(PURPLE)
    .text("FOLIO:", 395, 22);

  doc
    .fontSize(11)
    .text(folio, 395, 35);

  doc
    .fontSize(9)
    .text("FECHA DE EMISIÓN:", 395, 58);

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#222222")
    .text(dayjs().format("DD [de] MMMM [de] YYYY"), 395, 72);

  doc
    .font("Helvetica-Bold")
    .fillColor(PURPLE)
    .text("FECHA DE GENERACIÓN:", 395, 91);

  doc
    .font("Helvetica")
    .fillColor("#222222")
    .text(dayjs().format("DD/MM/YYYY HH:mm"), 395, 104);

  // Título
  doc
    .font("Helvetica-Bold")
    .fontSize(27)
    .fillColor(PURPLE)
    .text("HISTORIAL DE PAGOS", 40, 135, {
      width: 532,
      align: "center"
    });

  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor(GRAY)
    .text(
      "Este documento refleja el historial de pagos y el estado actual del paquete contratado.",
      40,
      168,
      {
        width: 532,
        align: "center"
      }
    );

  // Función para dibujar encabezado de sección
  const sectionLabel = (text, x, y, width) => {
    doc
      .roundedRect(x, y, width, 20, 6)
      .fill(PURPLE);

    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#FFFFFF")
      .text(text, x, y + 6, {
        width,
        align: "center"
      });
  };

  // Recuadro datos alumno
  doc
    .roundedRect(30, 200, 270, 292, 9)
    .lineWidth(1)
    .strokeColor(PURPLE)
    .stroke();

  sectionLabel("DATOS DEL ALUMNO", 72, 191, 185);

  const studentRows = [
    ["NOMBRE COMPLETO:", student.full_name || ""],
    ["TELÉFONO (WHATSAPP):", student.phone_e164 || "No registrado"],
    ["CAMPUS:", student.campus_name || ""],
    ["TURNO:", student.shift_name || ""],
    ["PERIODO:", student.period_name || ""],
    ["AÑO:", student.grad_year || ""],
    ["CARRERA:", student.career_name || "Sin carrera registrada"],
    ["GRADO:", student.grade || ""],
    ["GRUPO:", student.group || ""],
    ["PAQUETE:", student.package_name || ""],
    ["ESTADO DE COBRANZA:", "Cobranza activa"]
  ];

  let infoY = 222;

  studentRows.forEach((row, index) => {
    doc
      .font("Helvetica-Bold")
      .fontSize(7.6)
      .fillColor(PURPLE)
      .text(row[0], 48, infoY, {
        width: 110
      });

    doc
      .font("Helvetica")
      .fontSize(7.6)
      .fillColor(
        index === studentRows.length - 1 ? GREEN : "#222222"
      )
      .text(row[1], 160, infoY, {
        width: 122
      });

    if (index < studentRows.length - 1) {
      doc
        .moveTo(47, infoY + 17)
        .lineTo(284, infoY + 17)
        .lineWidth(0.4)
        .strokeColor(BORDER)
        .stroke();
    }

    infoY += 24;
  });

  // Recuadro resumen
  doc
    .roundedRect(312, 200, 270, 292, 9)
    .lineWidth(1)
    .strokeColor(PURPLE)
    .stroke();

  sectionLabel("RESUMEN DEL PAQUETE", 357, 191, 180);

  const summaryRows = [
    ["PAQUETE:", student.package_name || ""],
    ["TOTAL DEL PAQUETE:", money(totalDue)],
    ["DESCUENTO:", money(discount)],
    ["TOTAL PAGADO:", money(totalPaid)],
    ["SALDO PENDIENTE:", money(balance)]
  ];

  let summaryY = 232;

  summaryRows.forEach((row, index) => {
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(PURPLE)
      .text(row[0], 335, summaryY, {
        width: 120
      });

    let valueColor = "#222222";

    if (index === 2 && discount > 0) valueColor = GREEN;
    if (index === 4 && balance > 0) valueColor = RED;
    if (index === 4 && balance <= 0) valueColor = GREEN;

    doc
      .font(index === 0 ? "Helvetica" : "Helvetica-Bold")
      .fontSize(index === 0 ? 7.5 : 10)
      .fillColor(valueColor)
      .text(row[1], 450, summaryY, {
        width: 110,
        align: "right"
      });

    if (index < summaryRows.length - 1) {
      doc
        .moveTo(333, summaryY + 29)
        .lineTo(560, summaryY + 29)
        .lineWidth(0.4)
        .strokeColor(BORDER)
        .stroke();
    }

    summaryY += index === 0 ? 55 : 49;
  });

  // Pagos realizados
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .fillColor(PURPLE)
    .text("PAGOS REALIZADOS", 48, 513);

  doc
    .moveTo(195, 523)
    .lineTo(285, 523)
    .lineWidth(2)
    .strokeColor(YELLOW)
    .stroke();

  let tableY = 542;

  // Encabezado tabla
  doc
    .roundedRect(30, tableY, 552, 22, 5)
    .fill(PURPLE);

  doc
    .font("Helvetica-Bold")
    .fontSize(7.5)
    .fillColor("#FFFFFF")
    .text("FECHA", 42, tableY + 7, {
      width: 110,
      align: "center"
    });

  doc.text("MONTO", 160, tableY + 7, {
    width: 90,
    align: "center"
  });

  doc.text("MÉTODO", 260, tableY + 7, {
    width: 145,
    align: "center"
  });

  doc.text("ESTATUS", 420, tableY + 7, {
    width: 145,
    align: "center"
  });

  tableY += 22;

  const maxPaymentsFirstPage = 6;
  const visiblePayments = payments.slice(0, maxPaymentsFirstPage);

  if (visiblePayments.length === 0) {
    doc
      .rect(30, tableY, 552, 24)
      .fill(LIGHT_PURPLE);

    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(GRAY)
      .text(
        "No existen pagos confirmados registrados.",
        42,
        tableY + 8,
        {
          width: 520,
          align: "center"
        }
      );

    tableY += 24;
  } else {
    visiblePayments.forEach((payment, index) => {
      const rowColor = index % 2 === 0 ? "#FFFFFF" : LIGHT_PURPLE;

      doc.rect(30, tableY, 552, 22).fill(rowColor);

      doc
        .font("Helvetica")
        .fontSize(7.4)
        .fillColor("#222222")
        .text(
          dayjs(payment.created_at).format("DD/MM/YYYY"),
          42,
          tableY + 7,
          {
            width: 110,
            align: "center"
          }
        );

      doc.text(
        money(payment.amount),
        160,
        tableY + 7,
        {
          width: 90,
          align: "center"
        }
      );

      doc.text(
        payment.method || "No especificado",
        260,
        tableY + 7,
        {
          width: 145,
          align: "center"
        }
      );

      doc
        .font("Helvetica-Bold")
        .fillColor(GREEN)
        .text("✓ Pagado", 420, tableY + 7, {
          width: 145,
          align: "center"
        });

      tableY += 22;
    });
  }

  // Total pagado
  doc
    .rect(30, tableY, 552, 24)
    .fill("#EEE6FA");

  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(PURPLE)
    .text(
      `TOTAL PAGADO: ${money(totalPaid)}`,
      42,
      tableY + 7,
      {
        width: 520,
        align: "center"
      }
    );

  tableY += 36;

  // Nota aclaratoria
  doc
    .roundedRect(30, tableY, 552, 26, 5)
    .lineWidth(0.8)
    .strokeColor(YELLOW)
    .stroke();

  doc
    .font("Helvetica")
    .fontSize(7.5)
    .fillColor(PURPLE)
    .text(
      "En caso de alguna aclaración, favor de acudir al Departamento de Egresos de la Universidad ITCC.",
      47,
      tableY + 9,
      {
        width: 518,
        align: "center"
      }
    );

  // Firma
  const signatureY = tableY + 46;

  doc
    .moveTo(170, signatureY)
    .lineTo(350, signatureY)
    .lineWidth(0.8)
    .strokeColor(PURPLE)
    .stroke();

  doc
    .font("Helvetica-Bold")
    .fontSize(7.5)
    .fillColor(PURPLE)
    .text("FIRMA", 170, signatureY + 7, {
      width: 180,
      align: "center"
    });

  doc.text("LIC. ANDRÉS SILVA FERNÁNDEZ", 150, signatureY + 19, {
    width: 220,
    align: "center"
  });

  doc.text("COORDINACIÓN DE GRADUACIONES", 150, signatureY + 30, {
    width: 220,
    align: "center"
  });

  doc.text("UNIVERSIDAD ITCC", 150, signatureY + 41, {
    width: 220,
    align: "center"
  });

  // Sello provisional
  doc
    .circle(455, signatureY + 29, 39)
    .lineWidth(1.5)
    .strokeColor(PURPLE)
    .stroke();

  doc
    .font("Helvetica-Bold")
    .fontSize(17)
    .fillColor(PURPLE)
    .text("ITCC", 419, signatureY + 19, {
      width: 72,
      align: "center"
    });

  doc
    .fontSize(5.5)
    .text("Universidad y Preparatoria", 415, signatureY + 39, {
      width: 80,
      align: "center"
    });

// Pie de página dentro del área imprimible
doc
  .rect(0, 730, 612, 32)
  .fill(DARK_PURPLE);

doc
  .font("Helvetica")
  .fontSize(7)
  .fillColor("#FFFFFF")
  .text("ITCC Universidad y Preparatoria", 40, 742, {
    width: 180,
    lineBreak: false
  });

doc.text("www.itcc.edu.mx", 230, 742, {
  width: 150,
  align: "center",
  lineBreak: false
});

doc
  .font("Helvetica-Bold")
  .fillColor(YELLOW)
  .text("#yosoyitcc", 420, 742, {
    width: 150,
    align: "right",
    lineBreak: false
  });
  // Si hay más pagos, generar páginas adicionales
  if (payments.length > maxPaymentsFirstPage) {
    const remainingPayments = payments.slice(maxPaymentsFirstPage);

    let pageRows = [];

    remainingPayments.forEach((payment, index) => {
      pageRows.push(payment);

      const isLast = index === remainingPayments.length - 1;

      if (pageRows.length === 24 || isLast) {
        doc.addPage({
          size: "LETTER",
          layout: "portrait",
          margin: 36
        });

        doc
          .font("Helvetica-Bold")
          .fontSize(17)
          .fillColor(PURPLE)
          .text("HISTORIAL DE PAGOS — CONTINUACIÓN", {
            align: "center"
          });

        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor(GRAY)
          .text(student.full_name || "", {
            align: "center"
          });

        let extraY = 90;

        doc
          .rect(36, extraY, 540, 22)
          .fill(PURPLE);

        doc
          .font("Helvetica-Bold")
          .fontSize(8)
          .fillColor("#FFFFFF")
          .text("FECHA", 45, extraY + 7, {
            width: 105,
            align: "center"
          });

        doc.text("MONTO", 160, extraY + 7, {
          width: 90,
          align: "center"
        });

        doc.text("MÉTODO", 260, extraY + 7, {
          width: 130,
          align: "center"
        });

        doc.text("ESTATUS", 405, extraY + 7, {
          width: 120,
          align: "center"
        });

        extraY += 22;

        pageRows.forEach((p, rowIndex) => {
          doc
            .rect(36, extraY, 540, 22)
            .fill(rowIndex % 2 === 0 ? "#FFFFFF" : LIGHT_PURPLE);

          doc
            .font("Helvetica")
            .fontSize(8)
            .fillColor("#222222")
            .text(
              dayjs(p.created_at).format("DD/MM/YYYY"),
              45,
              extraY + 7,
              {
                width: 105,
                align: "center"
              }
            );

          doc.text(money(p.amount), 160, extraY + 7, {
            width: 90,
            align: "center"
          });

          doc.text(
            p.method || "No especificado",
            260,
            extraY + 7,
            {
              width: 130,
              align: "center"
            }
          );

          doc
            .font("Helvetica-Bold")
            .fillColor(GREEN)
            .text("✓ Pagado", 405, extraY + 7, {
              width: 120,
              align: "center"
            });

          extraY += 22;
        });

        pageRows = [];
      }
    });
  }
  doc.end();
});
app.get(
  "/students/:id/payment-history.pdf",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    const studentId = Number(req.params.id);

    if (!Number.isInteger(studentId) || studentId <= 0) {
      return res.status(400).send("Alumno inválido.");
    }

    return res.redirect(
      `/portal/payment-history.pdf?student_id=${studentId}`
    );
  }
);
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
app.get("/provider/verify",
  requireAuth,
  requireRole("PROVEEDOR"),
  (req, res) => {

    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <title>Verificador de Folios</title>

        <style>

        body{
          font-family:Arial;
          background:#f5f5f5;
          display:flex;
          justify-content:center;
          align-items:center;
          height:100vh;
        }

        .card{
          width:500px;
          background:white;
          padding:40px;
          border-radius:12px;
          box-shadow:0 5px 20px rgba(0,0,0,.15);
        }

        h2{
          color:#4400B2;
          text-align:center;
        }

        input{
          width:100%;
          padding:12px;
          font-size:18px;
          margin-top:20px;
          margin-bottom:20px;
        }

        button{
          width:100%;
          padding:14px;
          border:none;
          background:#4400B2;
          color:white;
          font-size:18px;
          border-radius:8px;
          cursor:pointer;
        }

        </style>

      </head>

      <body>

        <div class="card">

          <h2>VERIFICADOR DE FOLIOS ITCC</h2>

          <form action="/provider/verify" method="POST">

            <input
              name="folio"
              placeholder="HP-2026-000001"
              required>

            <button>
              Verificar folio
            </button>

          </form>

        </div>

      </body>

      </html>
    `);

  }
);
app.post(
  "/provider/verify",
  requireAuth,
  requireRole("PROVEEDOR"),
  async (req, res) => {
    try {
      const folio = String(req.body.folio || "")
        .trim()
        .toUpperCase();

      if (!folio) {
        return res.status(400).send("Debes ingresar un folio.");
      }

      const result = await q(
        `
        SELECT
          s.id,
          s.full_name,
          s.payment_history_folio,
          s.payment_history_status,
          s.billing_active,
          s.discount_amount,

          c.name AS campus_name,
          sh.name AS shift_name,
          gp.name AS period_name,
          gy.year AS grad_year,
          ca.name AS career_name,
          pk.name AS package_name,
          pk.cost AS package_cost,

          COALESCE(pay.total_paid, 0)::numeric AS total_paid,

          GREATEST(
            0,
            COALESCE(pk.cost, 0)
            - COALESCE(s.discount_amount, 0)
            - COALESCE(pay.total_paid, 0)
          )::numeric AS balance

        FROM students s

        LEFT JOIN campuses c
          ON c.id = s.campus_id

        LEFT JOIN shifts sh
          ON sh.id = s.shift_id

        LEFT JOIN graduation_periods gp
          ON gp.id = s.period_id

        LEFT JOIN graduation_years gy
          ON gy.id = s.year_id

        LEFT JOIN careers ca
          ON ca.id = s.career_id

        LEFT JOIN packages pk
          ON pk.id = s.package_id

        LEFT JOIN (
          SELECT
            student_id,
            SUM(amount) AS total_paid
          FROM payments
          WHERE status = 'CONFIRMED'
          GROUP BY student_id
        ) pay
          ON pay.student_id = s.id

        WHERE UPPER(s.payment_history_folio) = $1
        LIMIT 1
        `,
        [folio]
      );

      const student = result.rows[0];

      if (!student) {
        return res.send(`
          <!DOCTYPE html>
          <html lang="es">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Folio no encontrado</title>

            <style>
              body {
                margin: 0;
                font-family: Arial, Helvetica, sans-serif;
                background: #f3f3f3;
                min-height: 100vh;
                display: flex;
                justify-content: center;
                align-items: center;
              }

              .card {
                width: min(520px, 88%);
                background: #ffffff;
                padding: 38px;
                border-radius: 16px;
                box-shadow: 0 8px 30px rgba(0,0,0,.15);
                text-align: center;
              }

              .status {
                font-size: 22px;
                font-weight: bold;
                color: #d71920;
                margin-bottom: 15px;
              }

              .folio {
                background: #f5f1fc;
                padding: 14px;
                border-radius: 8px;
                color: #4400b2;
                font-weight: bold;
                margin: 20px 0;
              }

              a {
                display: inline-block;
                background: #4400b2;
                color: #ffffff;
                padding: 12px 22px;
                border-radius: 8px;
                text-decoration: none;
              }
            </style>
          </head>

          <body>
            <div class="card">
              <div class="status">❌ FOLIO NO ENCONTRADO</div>

              <p>
                El documento no pudo validarse. Revisa que el folio esté escrito correctamente.
              </p>

              <div class="folio">${folio}</div>

              <a href="/provider/verify">
                Consultar otro folio
              </a>
            </div>
          </body>
          </html>
        `);
      }

      const documentValid =
        student.payment_history_status === "ACTIVE" &&
        student.billing_active === true;

      const totalPaid = Number(student.total_paid || 0);
      const balance = Number(student.balance || 0);

      const money = value =>
        Number(value || 0).toLocaleString("es-MX", {
          style: "currency",
          currency: "MXN"
        });

      return res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Resultado de verificación</title>

          <style>
            body {
              margin: 0;
              font-family: Arial, Helvetica, sans-serif;
              background: #f3f3f3;
              min-height: 100vh;
              display: flex;
              justify-content: center;
              align-items: center;
            }

            .card {
              width: min(650px, 90%);
              background: #ffffff;
              padding: 35px;
              border-radius: 16px;
              box-shadow: 0 8px 30px rgba(0,0,0,.15);
            }

            h1 {
              color: #4400b2;
              text-align: center;
              margin-top: 0;
            }

            .status {
              padding: 16px;
              border-radius: 10px;
              margin: 20px 0;
              text-align: center;
              font-size: 21px;
              font-weight: bold;
              color: #ffffff;
              background: ${documentValid ? "#148a2a" : "#d71920"};
            }

            .row {
              display: grid;
              grid-template-columns: 190px 1fr;
              gap: 12px;
              padding: 11px 0;
              border-bottom: 1px solid #e3e3e3;
            }

            .label {
              color: #4400b2;
              font-weight: bold;
            }

            .balance {
              color: ${balance > 0 ? "#d71920" : "#148a2a"};
              font-weight: bold;
            }

            .button {
              display: block;
              margin-top: 25px;
              background: #4400b2;
              color: #ffffff;
              padding: 13px;
              border-radius: 8px;
              text-align: center;
              text-decoration: none;
            }

            @media (max-width: 600px) {
              .row {
                grid-template-columns: 1fr;
                gap: 4px;
              }
            }
          </style>
        </head>

        <body>
          <div class="card">
            <h1>VERIFICACIÓN ITCC</h1>

            <div class="status">
              ${
                documentValid
                  ? "✓ DOCUMENTO AUTÉNTICO"
                  : "✕ DOCUMENTO NO VÁLIDO"
              }
            </div>

            <div class="row">
              <div class="label">Folio:</div>
              <div>${student.payment_history_folio}</div>
            </div>

            <div class="row">
              <div class="label">Alumno:</div>
              <div>${student.full_name}</div>
            </div>

            <div class="row">
              <div class="label">Campus:</div>
              <div>${student.campus_name || ""}</div>
            </div>

            <div class="row">
              <div class="label">Turno:</div>
              <div>${student.shift_name || ""}</div>
            </div>

            <div class="row">
              <div class="label">Periodo:</div>
              <div>
                ${student.period_name || ""}
                ${student.grad_year ? " / " + student.grad_year : ""}
              </div>
            </div>

            <div class="row">
              <div class="label">Carrera:</div>
              <div>${student.career_name || ""}</div>
            </div>

            <div class="row">
              <div class="label">Paquete:</div>
              <div>${student.package_name || ""}</div>
            </div>

            <div class="row">
              <div class="label">Total pagado:</div>
              <div>${money(totalPaid)}</div>
            </div>

            <div class="row">
              <div class="label">Saldo pendiente:</div>
              <div class="balance">${money(balance)}</div>
            </div>

            <div class="row">
              <div class="label">Cobranza:</div>
              <div>
                ${student.billing_active ? "Activa" : "No activa"}
              </div>
            </div>

            <div class="row">
              <div class="label">Estado del folio:</div>
              <div>${student.payment_history_status || "ACTIVE"}</div>
            </div>

            <a class="button" href="/provider/verify">
              Verificar otro folio
            </a>
          </div>
        </body>
        </html>
      `);
    } catch (error) {
      console.error("Error verificando folio:", error);

      return res
        .status(500)
        .send("No fue posible verificar el folio: " + error.message);
    }
  }
);
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
