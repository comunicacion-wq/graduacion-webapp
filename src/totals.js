import { q } from "./db.js";

export async function getStudentTotals(studentId) {
  const s = await q(
    `SELECT s.*,
      c.name as campus_name,
      sh.name as shift_name,
      gp.name as period_name,
      gy.year as grad_year,
      ca.name as career_name,
      p.name as package_name,
      p.cost as package_cost
    FROM students s
    LEFT JOIN campuses c ON c.id = s.campus_id
    LEFT JOIN shifts sh ON sh.id = s.shift_id
    LEFT JOIN graduation_periods gp ON gp.id = s.period_id
    LEFT JOIN graduation_years gy ON gy.id = s.year_id
    LEFT JOIN careers ca ON ca.id = s.career_id
    LEFT JOIN packages p ON p.id = s.package_id
    WHERE s.id = $1`,
    [studentId]
  );
  if (!s.rows[0]) return null;

  const paid = await q(
    `SELECT COALESCE(SUM(amount),0) as total_paid
     FROM payments
     WHERE student_id = $1 AND status='CONFIRMED'`,
    [studentId]
  );

  const student = s.rows[0];
  const package_cost = Number(student.package_cost || 0);
  const discount_amount = Number(student.discount_amount || 0);
  const total_due = Math.max(0, package_cost - discount_amount);
  const total_paid = Number(paid.rows[0].total_paid || 0);
  const balance = Number((total_due - total_paid).toFixed(2));

  return {
    student,
    totals: { package_cost, discount_amount, total_due, total_paid, balance }
  };
}
