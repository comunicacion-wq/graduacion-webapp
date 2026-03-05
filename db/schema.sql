-- Core catalogs
CREATE TABLE IF NOT EXISTS campuses (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS graduation_periods (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS graduation_years (
  id SERIAL PRIMARY KEY,
  year INT NOT NULL UNIQUE,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS careers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS packages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  cost NUMERIC(10,2) NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','CAJERO','STUDENT')),
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Cajero campus assignment (many-to-many)
CREATE TABLE IF NOT EXISTS user_campuses (
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  campus_id INT REFERENCES campuses(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id, campus_id)
);

-- Students
CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  campus_id INT REFERENCES campuses(id),
  shift_id INT REFERENCES shifts(id),
  period_id INT REFERENCES graduation_periods(id),
  year_id INT REFERENCES graduation_years(id),
  career_id INT REFERENCES careers(id),
  grade TEXT,
  "group" TEXT,
  package_id INT REFERENCES packages(id),
  discount_amount NUMERIC(10,2) DEFAULT 0,
  discount_reason TEXT DEFAULT '',
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Student user (portal)
CREATE TABLE IF NOT EXISTS student_accounts (
  student_id INT UNIQUE REFERENCES students(id) ON DELETE CASCADE,
  user_id INT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Payments
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  student_id INT REFERENCES students(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  method TEXT DEFAULT 'Efectivo',
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED','CANCELED')),
  created_by INT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  canceled_by INT REFERENCES users(id),
  canceled_at TIMESTAMP,
  cancel_reason TEXT DEFAULT ''
);

-- Message templates editable in Settings
CREATE TABLE IF NOT EXISTS message_templates (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE, -- CREDENCIALES, ADEUDO, ABONO, LIQUIDACION, CORRECCION, SOLICITUD_ADMIN
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Message log
CREATE TABLE IF NOT EXISTS message_log (
  id SERIAL PRIMARY KEY,
  student_id INT REFERENCES students(id) ON DELETE SET NULL,
  to_phone_e164 TEXT,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  media_url TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Requests for changes (approval workflow)
CREATE TABLE IF NOT EXISTS change_requests (
  id SERIAL PRIMARY KEY,
  requested_by INT REFERENCES users(id),
  campus_id INT REFERENCES campuses(id),
  student_id INT REFERENCES students(id),
  request_type TEXT NOT NULL CHECK (request_type IN ('CANCEL_PAYMENT','CORRECT_PAYMENT','CHANGE_PACKAGE','APPLY_DISCOUNT')),
  payload JSONB NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  decided_by INT REFERENCES users(id),
  decided_at TIMESTAMP,
  decision_note TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  actor_user_id INT REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INT,
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Cashbox (close/open)
CREATE TABLE IF NOT EXISTS cashbox_state (
  id INT PRIMARY KEY DEFAULT 1,
  is_open BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by INT REFERENCES users(id),
  updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO cashbox_state(id, is_open) VALUES (1, TRUE)
ON CONFLICT (id) DO NOTHING;

-- Seed catalogs
INSERT INTO campuses(name) VALUES
('Campus Campestre'),('Campus Cumbres'),('Campus Doctores'),('Campus 286')
ON CONFLICT (name) DO NOTHING;

INSERT INTO shifts(name) VALUES
('T1'),('T2'),('T3'),('T4'),('T5'),('T7')
ON CONFLICT (name) DO NOTHING;

INSERT INTO graduation_periods(name) VALUES
('Enero-Abril'),('Mayo-Agosto'),('Septiembre-Diciembre')
ON CONFLICT (name) DO NOTHING;

INSERT INTO graduation_years(year) VALUES
(2026),(2027),(2028),(2029),(2030)
ON CONFLICT (year) DO NOTHING;

INSERT INTO packages(name, cost) VALUES
('Paquete 1', 2450.00),
('Paquete 2', 4450.00)
ON CONFLICT (name) DO NOTHING;

-- Default message templates
INSERT INTO message_templates(code, title, body) VALUES
('CREDENCIALES','Credenciales al registrar alumno',
'Hola {NOMBRE}.\nTu acceso al portal de graduación quedó listo.\nUsuario: {USUARIO}\nContraseña: {CONTRASENA}\n{LINK_PORTAL}'),
('ADEUDO','Cobranza por adeudo',
'Hola {NOMBRE}. Presentas un adeudo de ${SALDO}.\nTotal: ${TOTAL} | Abonado: ${ABONADO} | Pendiente: ${SALDO}.\n{INSTRUCCIONES_PAGO}'),
('ABONO','Confirmación de abono',
'Hola {NOMBRE}. Recibimos tu abono de ${MONTO_ABONO} el {FECHA_PAGO} a las {HORA_PAGO}.\nTotal: ${TOTAL} | Abonado: ${ABONADO} | Pendiente: ${SALDO}. Gracias.'),
('LIQUIDACION','Liquidación + tarjeta PDF',
'Hola {NOMBRE}.\nMuchas gracias por haber realizado tu pago de graduación.\nTu paquete ya se encuentra LIQUIDADO y no presentas adeudo.\nTe compartimos tu tarjeta PDF para llevar impresa el día que recojas tus boletos.'),
('CORRECCION','Corrección por error administrativo',
'Hola {NOMBRE}. Te informamos que hubo un ajuste por un error administrativo en tu registro.\nTu saldo pendiente actual es: ${SALDO}.\nTotal: ${TOTAL} | Abonado: ${ABONADO} | Paquete: {PAQUETE}.\nGracias por tu comprensión.'),
('SOLICITUD_ADMIN','Notificación al admin por solicitud',
'Nueva solicitud de ajuste\nUsuario: {CAJERO}\nCampus: {CAMPUS}\nAlumno: {NOMBRE}\nAcción: {ACCION}\nMotivo: {MOTIVO}\nRevisar: {LINK}')
ON CONFLICT (code) DO NOTHING;
