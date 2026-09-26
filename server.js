/**
 * ValueAccelerate Services Limited — site server + contact form (Resend)
 *
 * Zero-dependency Node server (Node 18+) that:
 *   1. serves index.html and the static logo/favicon assets
 *   2. POSTs validated contact submissions to the Resend API
 *
 * Setup:
 *   cp .env.example .env     then fill in RESEND_API_KEY, CONTACT_TO, CONTACT_FROM
 *   npm start
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

/* ---------- tiny .env loader (no dependencies) ---------- */
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

/* ---------- config ---------- */
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 8787;
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const CONTACT_TO = (process.env.CONTACT_TO || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CONTACT_FROM = process.env.CONTACT_FROM || "";
const CONTACT_BCC = (process.env.CONTACT_BCC || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SITE_NAME = process.env.SITE_NAME || "ValueAccelerate Services Limited";
const RESEND_ENDPOINT = process.env.RESEND_ENDPOINT || "https://api.resend.com/emails";

/* ---------- static file serving ---------- */
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/logo.png": ["logo.png", "image/png"],
  "/favicon-32.png": ["favicon-32.png", "image/png"],
  "/favicon-64.png": ["favicon-64.png", "image/png"],
};

/* ---------- rate limiting (per IP, simple window) ---------- */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const hits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const kept = arr.filter((t) => now - t < WINDOW_MS);
    if (kept.length === 0) hits.delete(ip);
    else hits.set(ip, kept);
  }
}, WINDOW_MS).unref();

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > MAX_PER_WINDOW;
}

/* ---------- helpers ---------- */
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

function readBody(req, limit = 20_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("Payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function buildEmailHtml(fields) {
  const row = (label, value) =>
    `<tr><td style="padding:8px 14px;border-bottom:1px solid #edf2e4;font:600 13px/1.4 -apple-system,Segoe UI,sans-serif;color:#5A8028;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap;vertical-align:top;">${esc(
      label
    )}</td><td style="padding:8px 14px;border-bottom:1px solid #edf2e4;font:400 15px/1.5 -apple-system,Segoe UI,sans-serif;color:#1E2A14;">${esc(
      value
    )}</td></tr>`;
  return `<!doctype html><html><body style="margin:0;background:#F7FAEE;padding:28px;">
  <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e4edd4;border-radius:14px;overflow:hidden;">
    <div style="background:#1E2A14;padding:22px 26px;">
      <div style="font:800 17px/1.3 -apple-system,Segoe UI,sans-serif;color:#A9DF54;">${esc(SITE_NAME)}</div>
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

function buildEmailText(fields) {
  return [
    `New contact form submission — ${SITE_NAME}`,
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

/* ---------- Resend send ---------- */
async function sendViaResend(fields) {
  const payload = {
    from: CONTACT_FROM,
    to: CONTACT_TO,
    subject: `New enquiry: ${fields.service} — ${fields.fullName}`,
    html: buildEmailHtml(fields),
    text: buildEmailText(fields),
    reply_to: fields.email,
  };
  if (CONTACT_BCC.length) payload.bcc = CONTACT_BCC;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = body && body.message ? body.message : `Resend responded with ${res.status}`;
      const err = new Error(message);
      err.status = res.status === 401 || res.status === 403 ? 500 : 502; // don't leak auth details to clients
      err.resendStatus = res.status;
      throw err;
    }
    return body; // { id }
  } catch (e) {
    if (e.name === "AbortError") {
      const err = new Error("Email service timed out");
      err.status = 504;
      throw err;
    }
    if (!e.status) {
      e.status = 502;
      e.message = "Email service unavailable";
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- API: POST /api/contact ---------- */
async function handleContact(req, res, ip) {
  if (rateLimited(ip)) {
    return json(res, 429, { ok: false, error: "Too many requests. Please try again in a minute or reach us on WhatsApp." });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    return json(res, e.status || 400, { ok: false, error: "Invalid request body." });
  }

  let data;
  try {
    data = JSON.parse(raw || "{}");
  } catch {
    return json(res, 400, { ok: false, error: "Invalid JSON." });
  }

  // Honeypot: real users never fill this hidden field
  if (typeof data.website === "string" && data.website.trim() !== "") {
    return json(res, 200, { ok: true }); // silently accept to not tip off bots
  }

  const fields = {
    fullName: String(data.fullName || "").trim(),
    email: String(data.email || "").trim(),
    phone: String(data.phone || "").trim(),
    service: String(data.service || "").trim(),
    message: String(data.message || "").trim(),
  };

  const errors = {};
  if (fields.fullName.length < 2 || fields.fullName.length > 100) errors.fullName = "Please enter your full name.";
  if (!EMAIL_RE.test(fields.email) || fields.email.length > 200) errors.email = "Please enter a valid email address.";
  if (!PHONE_RE.test(fields.phone)) errors.phone = "Please enter a valid phone number.";
  if (!SERVICES.has(fields.service)) errors.service = "Please select a service.";
  if (fields.message.length < 10 || fields.message.length > 5000) errors.message = "Please enter a message (at least 10 characters).";

  if (Object.keys(errors).length) {
    return json(res, 422, { ok: false, error: "Please correct the highlighted fields.", errors });
  }

  if (!RESEND_API_KEY || !CONTACT_TO.length || !CONTACT_FROM) {
    console.error("[contact] Missing configuration — set RESEND_API_KEY, CONTACT_TO and CONTACT_FROM in .env");
    return json(res, 503, {
      ok: false,
      error: "Our email service isn't configured yet. Please reach us on WhatsApp or by phone in the meantime.",
    });
  }

  try {
    const out = await sendViaResend(fields);
    console.log(`[contact] sent id=${out.id} from=${fields.email} service=${fields.service}`);
    return json(res, 200, { ok: true, id: out.id });
  } catch (e) {
    console.error("[contact] send failed:", e.resendStatus || "", e.message);
    return json(res, e.status || 502, {
      ok: false,
      error: "We couldn't send your message just now. Please try again, or reach us on WhatsApp.",
    });
  }
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";

  if (req.method === "POST" && req.url === "/api/contact") {
    return handleContact(req, res, ip);
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const entry = STATIC[req.url === "" ? "/" : req.url];
    if (entry) {
      const [file, type] = entry;
      try {
        const body = fs.readFileSync(path.join(__dirname, file));
        res.writeHead(200, { "Content-Type": type, "Cache-Control": file === "index.html" ? "no-cache" : "public, max-age=604800" });
        return res.end(req.method === "HEAD" ? undefined : body);
      } catch {
        /* fall through to 404 */
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`ValueAccelerate site running at http://localhost:${PORT}`);
  const cfg = [RESEND_API_KEY && "RESEND_API_KEY", CONTACT_TO.length && `CONTACT_TO(${CONTACT_TO.length})`, CONTACT_FROM && "CONTACT_FROM"].filter(Boolean);
  console.log(cfg.length === 3 ? `Resend configured: ${cfg.join(", ")}` : `⚠ Resend not fully configured — missing: ${["RESEND_API_KEY", "CONTACT_TO", "CONTACT_FROM"].filter((k) => !cfg.find((c) => c.startsWith(k))).join(", ")}`);
});
