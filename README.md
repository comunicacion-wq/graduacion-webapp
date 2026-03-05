# Sistema Web - Control de Graduación (MVP funcional)

Este proyecto es una **aplicación web** (PC + celular) para:
- Control escolar de alumnos (campus, turno, periodo, año, carrera, grado, grupo, paquete, descuento)
- Registro de abonos/pagos (con saldo en tiempo real)
- Cobranza por WhatsApp a morosos (por filtros)
- Mensajes automáticos por WhatsApp:
  1) Credenciales al alta
  2) Adeudo
  3) Confirmación de abono
  4) Liquidación + PDF (tarjeta)
  5) Corrección / aclaración
- Usuarios por rol:
  - ADMIN (control total)
  - CAJERO (por campus, sin totales globales)
- **Solicitudes**: los cajeros piden ajustes y el admin aprueba/rechaza
- Auditoría completa
- Corte de caja con **cierre de ingresos** (bloquea nuevos abonos mientras haces el corte)
- Plus: Importación Excel (placeholder)

> WhatsApp se integra con Twilio. Si no configuras Twilio, el sistema trabaja en modo **SIMULADO**.

---

## Requisitos
- Node.js 18+
- PostgreSQL 14+

---

## 1) Instalar
```bash
npm install
cp .env.example .env
```

## 2) Crear BD y tablas
1) Crea la base:
```sql
CREATE DATABASE graduacion;
```

2) Ejecuta el SQL:
```bash
psql "$DATABASE_URL" -f db/schema.sql
```

## 3) Crear usuario admin
```bash
npm run seed
```
Esto crea:
- usuario: **admin**
- contraseña: **Admin1234!** (cámbiala en cuanto entres)

## 4) Ejecutar
```bash
npm run dev
```
Abre:
- http://localhost:3000

---

## WhatsApp (opcional)
Configura en `.env`:
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`
- `ADMIN_WHATSAPP_E164` (tu número admin)

Notas:
- Para envío de PDFs por WhatsApp, Twilio requiere un `mediaUrl` público.
- En local puedes probar en SIMULADO.
- En producción, sirve el PDF desde un URL público y usa ese URL como `mediaUrl`.

---

## Datos iniciales incluidos
- Campus: Campestre, Cumbres, Doctores, 286
- Turnos: T1, T2, T3, T4, T5, T7
- Periodos: Enero-Abril, Mayo-Agosto, Septiembre-Diciembre
- Años: 2026-2030
- Paquetes: Paquete 1 ($2450), Paquete 2 ($4450)

Todos editables en **Ajustes**.

---

## Seguridad
- Pagos NO se eliminan: se **cancelan** (status=CANCELED).
- Los cortes y reportes suman solo pagos CONFIRMED.
- Auditoría registra cambios y aprobaciones.

