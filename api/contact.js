/**
 * Vercel serverless function: POST /api/contact
 * Mirrors the validation + Resend logic in server.js (used for local/non-Vercel deploys).
 * Environment variables (set in Vercel dashboard → Settings → Environment Variables):
 *   RESEND_API_KEY, CONTACT_TO, CONTACT_FROM, optional CONTACT_BCC, SITE_NAME
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9\s\-()]{6,19}$/;
const SERVICES = new Set([
  "CAC Business Registration",
  "Company Incorporation",
  "TIN & Tax Registration Support",
  "Corporate Documentation",
  "Compliance Support",
  "Business Advisory",
  "Other / Not Sure Yet",
]);

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- in-memory rate limit (per lambda instance; best-effort) ---------- */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear(); // keep memory bounded
  return arr.length > MAX_PER_WINDOW;
}

function buildEmailHtml(fields, siteName) {
  const row = (label, value) =>
    `<tr><td style="padding:8px 14px;border-bottom:1px solid #edf2e4;font:600 13px/1.4 -apple-system,Segoe UI,sans-serif;color:#5A8028;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap;vertical-align:top;">${esc(
      label
    )}</td><td style="padding:8px 14px;border-bottom:1px solid #edf2e4;font:400 15px/1.5 -apple-system,Segoe UI,sans-serif;color:#1E2A14;">${esc(
      value
    )}</td></tr>`;
  return `<!doctype html><html><body style="margin:0;background:#F7FAEE;padding:28px;">
  <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e4edd4;border-radius:14px;overflow:hidden;">
    <div style="background:#1E2A14;padding:22px 26px;">
      <div style="font:800 17px/1.3 -apple-system,Segoe UI,sans-serif;color:#A9DF54;">${esc(siteName)}</div>
      <div style="font:600 14px/1.4 -apple-system,Segoe UI,sans-serif;color:#ffffff;">New contact form submission</div>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      ${row("Full name", fields.fullName)}
      ${row("Email", fields.email)}
      ${row("Phone", fields.phone)}
      ${row("Service", fields.service)}
      ${row("Message", fields.message.replace(/\n/g, "<br />"))}
    </table>
    <div style="padding:14px 26px;font:400 12px/1.5 -apple-system,Segoe UI,sans-serif;color:#93A487;">
      Sent from the website contact form &middot; ${new Date().toISOString()}
    </div>
  </div></body></html>`;
}

function buildEmailText(fields, siteName) {
  return [
    `New contact form submission — ${siteName}`,
    "",
    `Full name: ${fields.fullName}`,
    `Email: ${fields.email}`,
    `Phone: ${fields.phone}`,
    `Service: ${fields.service}`,
    "",
    "Message:",
    fields.message,
  ].join("\n");
}

module.exports = async function handler(req, res) {
  // CORS + method guard (same-origin use, but be permissive for previews)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  if (rateLimited(ip)) {
    return res.status(429).json({
      ok: false,
      error: "Too many requests. Please try again in a minute or reach us on WhatsApp.",
    });
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  function safeParse(s) {
    try { return JSON.parse(s); } catch { return null; }
  }
  if (body === null) return res.status(400).json({ ok: false, error: "Invalid JSON." });

  // Honeypot
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return res.status(200).json({ ok: true });
  }

  const fields = {
    fullName: String(body.fullName || "").trim(),
    email: String(body.email || "").trim(),
    phone: String(body.phone || "").trim(),
    service: String(body.service || "").trim(),
    message: String(body.message || "").trim(),
  };

  const errors = {};
  if (fields.fullName.length < 2 || fields.fullName.length > 100) errors.fullName = "Please enter your full name.";
  if (!EMAIL_RE.test(fields.email) || fields.email.length > 200) errors.email = "Please enter a valid email address.";
  if (!PHONE_RE.test(fields.phone)) errors.phone = "Please enter a valid phone number.";
  if (!SERVICES.has(fields.service)) errors.service = "Please select a service.";
  if (fields.message.length < 10 || fields.message.length > 5000) errors.message = "Please enter a message (at least 10 characters).";
  if (Object.keys(errors).length) {
    return res.status(422).json({ ok: false, error: "Please correct the highlighted fields.", errors });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const CONTACT_TO = (process.env.CONTACT_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
  const CONTACT_FROM = process.env.CONTACT_FROM;
  const CONTACT_BCC = (process.env.CONTACT_BCC || "").split(",").map((s) => s.trim()).filter(Boolean);
  const SITE_NAME = process.env.SITE_NAME || "ValueAccelerate Services Limited";

  if (!RESEND_API_KEY || !CONTACT_TO.length || !CONTACT_FROM) {
    console.error("[contact] Missing env config on Vercel");
    return res.status(503).json({
      ok: false,
      error: "Our email service isn't configured yet. Please reach us on WhatsApp or by phone in the meantime.",
    });
  }

  const payload = {
    from: CONTACT_FROM,
    to: CONTACT_TO,
    subject: `New enquiry: ${fields.service} — ${fields.fullName}`,
    html: buildEmailHtml(fields, SITE_NAME),
    text: buildEmailText(fields, SITE_NAME),
    reply_to: fields.email,
  };
  if (CONTACT_BCC.length) payload.bcc = CONTACT_BCC;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const out = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await out.json().catch(() => ({}));
    if (!out.ok) {
      console.error("[contact] resend error", out.status, data?.message);
      return res.status(502).json({
        ok: false,
        error: "We couldn't send your message just now. Please try again, or reach us on WhatsApp.",
      });
    }
    console.log(`[contact] sent id=${data.id} from=${fields.email} service=${fields.service}`);
    return res.status(200).json({ ok: true, id: data.id });
  } catch (e) {
    console.error("[contact] send failed:", e.message);
    const timedOut = e.name === "AbortError";
    return res.status(timedOut ? 504 : 502).json({
      ok: false,
      error: "We couldn't send your message just now. Please try again, or reach us on WhatsApp.",
    });
  } finally {
    clearTimeout(timer);
  }
}
