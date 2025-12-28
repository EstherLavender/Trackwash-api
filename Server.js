import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// In-memory store (good enough for sandbox testing)
const mpesaTx = new Map();

// Helpers
function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function normalizePhone(phone) {
  let p = String(phone || "").trim();
  if (p.startsWith("+")) p = p.slice(1);
  if (p.startsWith("0")) p = "254" + p.slice(1);
  if (p.startsWith("7")) p = "254" + p;
  return p;
}

function buildPassword(shortcode, passkey, ts) {
  return Buffer.from(`${shortcode}${passkey}${ts}`).toString("base64");
}

async function getAccessToken() {
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  if (!key || !secret) throw new Error("Missing MPESA_CONSUMER_KEY/SECRET");

  const auth = Buffer.from(`${key}:${secret}`).toString("base64");
  const url =
    "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";

  const res = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}` },
  });

  return res.data.access_token;
}

// Health
app.get("/", (req, res) => res.json({ ok: true, service: "trackwash-api" }));

// 1) STK PUSH
app.post("/api/payments/mpesa/stkpush", async (req, res) => {
  try {
    const { bookingId = "TEST", phone, amountKes } = req.body || {};
    if (!phone) return res.status(400).json({ ok: false, error: "phone required" });
    if (!amountKes) return res.status(400).json({ ok: false, error: "amountKes required" });

    const shortcode = process.env.MPESA_SHORTCODE || "174379";
    const passkey = process.env.MPESA_PASSKEY;
    const callbackUrl = process.env.MPESA_CALLBACK_URL;

    if (!passkey) return res.status(500).json({ ok: false, error: "Missing MPESA_PASSKEY" });
    if (!callbackUrl) return res.status(500).json({ ok: false, error: "Missing MPESA_CALLBACK_URL" });

    const ts = timestamp();
    const password = buildPassword(shortcode, passkey, ts);
    const token = await getAccessToken();

    const stkUrl = "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

    const payload = {
      BusinessShortCode: Number(shortcode),
      Password: password,
      Timestamp: ts,
      TransactionType: "CustomerPayBillOnline",
      Amount: Number(amountKes),
      PartyA: Number(normalizePhone(phone)),
      PartyB: Number(shortcode),
      PhoneNumber: Number(normalizePhone(phone)),
      CallBackURL: callbackUrl,
      AccountReference: bookingId,
      TransactionDesc: "TrackWash Booking"
    };

    const stkRes = await axios.post(stkUrl, payload, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = stkRes.data;

    if (data?.CheckoutRequestID) {
      mpesaTx.set(data.CheckoutRequestID, {
        status: "PENDING",
        bookingId,
        phone: normalizePhone(phone),
        amountKes: Number(amountKes),
        createdAt: new Date().toISOString(),
        raw: data
      });
    }

    return res.json({ ok: true, ...data });
  } catch (err) {
    console.error("STK PUSH ERROR:", err?.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      error: "STK push failed",
      details: err?.response?.data || err.message
    });
  }
});

// 2) CALLBACK (MUST HAVE)
app.post("/api/payments/mpesa/callback", (req, res) => {
  try {
    console.log("✅ M-PESA CALLBACK RECEIVED:");
    console.log(JSON.stringify(req.body, null, 2));

    const stk = req.body?.Body?.stkCallback;
    const checkoutRequestId = stk?.CheckoutRequestID;
    const resultCode = stk?.ResultCode;
    const resultDesc = stk?.ResultDesc;

    let receipt = null;
    let paidAmount = null;
    let paidPhone = null;

    const items = stk?.CallbackMetadata?.Item || [];
    for (const it of items) {
      if (it.Name === "MpesaReceiptNumber") receipt = it.Value;
      if (it.Name === "Amount") paidAmount = it.Value;
      if (it.Name === "PhoneNumber") paidPhone = String(it.Value);
    }

    if (checkoutRequestId) {
      const existing = mpesaTx.get(checkoutRequestId) || {};
      const status = resultCode === 0 ? "SUCCESS" : "FAILED";

      mpesaTx.set(checkoutRequestId, {
        ...existing,
        status,
        resultCode,
        resultDesc,
        receipt: receipt || null,
        paidAmount: paidAmount ?? null,
        paidPhone: paidPhone || null,
        callbackAt: new Date().toISOString(),
        rawCallback: req.body
      });

      // NEXT STEP: trigger WhatsApp/Email + mark booking as PAID in DB
    }

    return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (e) {
    console.error("CALLBACK ERROR:", e.message);
    return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

// 3) STATUS POLL
app.get("/api/payments/mpesa/status/:checkoutRequestId", (req, res) => {
  const id = req.params.checkoutRequestId;
  const tx = mpesaTx.get(id);
  if (!tx) return res.status(404).json({ ok: false, error: "Not found" });
  return res.json({ ok: true, checkoutRequestId: id, ...tx });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Trackwash API running on :${PORT}`));
