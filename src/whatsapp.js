import dotenv from "dotenv";
import twilio from "twilio";
dotenv.config();

const hasTwilio = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM);

const client = hasTwilio
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

export async function sendWhatsApp({ toE164, body, mediaUrl=null }) {
  if (!hasTwilio) {
    console.log("[WHATSAPP SIMULADO]", { toE164, body, mediaUrl });
    return { simulated: true, status: "SIMULATED" };
  }
  const msg = await client.messages.create({
from: process.env.TWILIO_WHATSAPP_FROM,
    to: `whatsapp:${toE164}`,
    body,
    ...(mediaUrl ? { mediaUrl: [mediaUrl] } : {})
  });
  return { simulated: false, sid: msg.sid, status: msg.status };
}
