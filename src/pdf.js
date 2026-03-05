import PDFDocument from "pdfkit";
import dayjs from "dayjs";
import fs from "fs";
import path from "path";

/**
 * Generates a liquidation card PDF and returns the absolute filepath.
 * In production you should store in object storage (S3) or serve from a public URL.
 */
export function generateLiquidationPDF({ student, totals, outDir }) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const filenameSafe = student.full_name.replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
  const fileName = `Tarjeta_Liquidacion_${student.id}_${filenameSafe}.pdf`;
  const filePath = path.join(outDir, fileName);

  fs.mkdirSync(outDir, { recursive: true });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  doc.fontSize(18).text("CONFIRMACIÓN DE GRADUACIÓN", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(12).text(`Fecha: ${dayjs().format("DD/MM/YYYY HH:mm")}`, { align: "center" });
  doc.moveDown(1);

  doc.fontSize(14).text("Datos del alumno", { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(12)
    .text(`Nombre: ${student.full_name}`)
    .text(`Campus: ${student.campus_name || ""}`)
    .text(`Turno: ${student.shift_name || ""}`)
    .text(`Periodo: ${student.period_name || ""}`)
    .text(`Año: ${student.grad_year || ""}`)
    .text(`Carrera: ${student.career_name || ""}`)
    .text(`Grado/Grupo: ${student.grade || ""} ${student.group || ""}`)
    .moveDown(1);

  doc.fontSize(14).text("Estatus de paquete", { underline: true });
  doc.moveDown(0.5);

  doc.fontSize(12)
    .text(`Paquete: ${student.package_name || ""}`)
    .text(`Monto paquete: $${Number(totals.package_cost).toFixed(2)}`)
    .text(`Descuento: $${Number(totals.discount_amount).toFixed(2)}`)
    .text(`Total a pagar: $${Number(totals.total_due).toFixed(2)}`)
    .text(`Total pagado: $${Number(totals.total_paid).toFixed(2)}`)
    .text(`Saldo: $${Number(totals.balance).toFixed(2)}`)
    .moveDown(1);

  doc.fontSize(16).text("PAQUETE LIQUIDADO", { align: "center" });
  doc.moveDown(1);
  doc.fontSize(11).text("Presenta esta tarjeta IMPRESA el día que acudas a recoger tus boletos de graduación.", { align: "center" });

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on("finish", () => resolve({ filePath, fileName }));
    stream.on("error", reject);
  });
}
