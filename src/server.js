<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Portal del estudiante</title>
<style>
:root{--purple:#4400B2;--purple-dark:#17003E;--yellow:#FFC400;}
*{margin:0;padding:0;box-sizing:border-box;font-family:Arial,Helvetica,sans-serif}
body{background:linear-gradient(rgba(23,0,62,.85),rgba(23,0,62,.95)),url('/images/leopardo-login.png') center/cover no-repeat;color:#fff;min-height:100vh}
.portal-app{max-width:760px;margin:auto;padding:30px}
.portal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:40px}
.student-card{margin-top:25px;padding:22px;border-radius:22px;background:rgba(255,255,255,.08)}
.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:30px}
.card{background:rgba(255,255,255,.08);padding:20px;border-radius:18px}
.yellow{background:#FFC400;color:#2A006F}
.btn{display:inline-block;margin-top:30px;padding:14px 22px;background:#4400B2;color:#fff;text-decoration:none;border-radius:14px}
table{width:100%;margin-top:35px;border-collapse:collapse}
th,td{padding:12px;border-bottom:1px solid rgba(255,255,255,.15);text-align:left}
@media(max-width:700px){.summary{grid-template-columns:1fr}}
</style>
</head>
<body>
<main class="portal-app">
<header class="portal-header">
<h2>Portal del estudiante</h2>
<a href="/portal/logout" style="color:white;text-decoration:none;">Salir</a>
</header>

<h1>¡Hola <%= String(student.full_name || "").split(" ")[0] %>! 👋</h1>

<div class="student-card">
<h2><%= student.full_name %></h2>
<p>📞 <%= student.phone_e164 || "" %></p>
<p>🎓 <%= student.package_name || "" %></p>
<p>🏫 <%= student.campus_name || "" %></p>
</div>

<section class="summary">
<div class="card">
<h4>Total del paquete</h4>
<h2>$<%= Number(totals.total_due || 0).toFixed(2) %></h2>
</div>
<div class="card">
<h4>Total abonado</h4>
<h2>$<%= Number(totals.total_paid || 0).toFixed(2) %></h2>
</div>
<div class="card yellow">
<h4>Saldo pendiente</h4>
<h2>$<%= Number(totals.balance || 0).toFixed(2) %></h2>
</div>
</section>

<% if (canDownloadPaymentHistory) { %>
<a class="btn" href="/portal/payment-history/pdf">Descargar historial PDF</a>
<% } %>

<table>
<thead>
<tr><th>Fecha</th><th>Método</th><th>Monto</th><th>Estatus</th></tr>
</thead>
<tbody>
<% payments.forEach(function(payment){ %>
<tr>
<td><%= payment.created_at_fmt %></td>
<td><%= payment.method %></td>
<td>$<%= Number(payment.amount).toFixed(2) %></td>
<td><%= payment.status %></td>
</tr>
<% }) %>
</tbody>
</table>
</main>
</body>
</html>
