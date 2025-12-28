import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ----------------------------------------------------------------------------
// In-memory store for sandbox testing (replace with DB later)
// ----------------------------------------------------------------------------
const mpesaTx = new Map(); // checkoutRequestId -> { status, bookingId, phone, amount, receipt, raw }

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function getTimestamp() {
  // YYYYMMDDHHmmss
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const YYYY = now.getFullYear();
  const MM = pad(now.getMonth() + 1);
  const DD = pad(now.getDate());
  const HH = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  return `${YYYY}${MM}${DD}${HH}${mm}${ss}`;
}

function buildPassword(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
}

async function getAccessToken() {
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;

  if (!key || !secret) {
    throw new Error("Missing MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET");
  }

  const auth = Buffer.from(`${key}:${secret}`).toString("base64");

  // Sandbox OAuth endpoint
  const url = "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";

  const res = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}` },
  });

  return res.data.access_token;
}

function normalizePhone(phone) {
  // Accept: 07XXXXXXXX, 7XXXXXXXX, 2547XXXXXXXX, +2547XXXXXXXX
  let p = String(phone).trim();
  if (p.startsWith("+")) p = p.slice(1);
  if (p.startsWith("0")) p = "254" + p.slice(1);
  if (p.startsWith("7")) p = "254" + p;
  return p;
}

// ----------------------------------------------------------------------------
// Health
// ----------------------------------------------------------------------------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "trackwash-mpesa-api" });
});

// ----------------------------------------------------------------------------
// 1) Send STK Push
// POST /api/payments/mpesa/stkpush
// body: { bookingId, phone, amount, accountReference?, transactionDesc? }
// ----------------------------------------------------------------------------
app.post("/api/payments/mpesa/stkpush", async (req, res) => {
  try {
    const {
      bookingId = "TEST-BOOKING",
      phone,
      amount,
      accountReference = "TrackWash",
      transactionDesc = "TrackWash Booking",
    } = req.body || {};

    if (!phone) return res.status(400).json({ error: "phone is required" });
    if (!amount) return res.status(400).json({ error: "amount is required" });

    const shortcode = process.env.MPESA_SHORTCODE || "174379";
    const passkey = process.env.MPESA_PASSKEY;
    const callbackUrl = process.env.MPESA_CALLBACK_URL;
    const txType = process.env.MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline";

    if (!passkey) return res.status(500).json({ error: "Missing MPESA_PASSKEY" });
    if (!callbackUrl) return res.status(500).json({ error: "Missing MPESA_CALLBACK_URL" });

    const timestamp = getTimestamp();
    const password = buildPassword(shortcode, passkey, timestamp);

    const accessToken = await getAccessToken();

    const stkUrl = "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

    const payload = {
      BusinessShortCode: Number(shortcode),
      Password: password,
      Timestamp: timestamp,
      TransactionType: txType,
      Amount: Number(amount),
      PartyA: Number(normalizePhone(phone)),
      PartyB: Number(shortcode),
      PhoneNumber: Number(normalizePhone(phone)),
      CallBackURL: callbackUrl,
      AccountReference: accountReference,
      TransactionDesc: transactionDesc,
    };

    const stkRes = await axios.post(stkUrl, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    const data = stkRes.data;

    // Store pending tx for status polling
    if (data?.CheckoutRequestID) {
      mpesaTx.set(data.CheckoutRequestID, {
        status: "PENDING",
        bookingId,
        phone: normalizePhone(phone),
        amount: Number(amount),
        receipt: null,
        raw: data,
      });
    }

    res.json({
      ok: true,
      bookingId,
      ...data,
    });
  } catch (err) {
    console.error("STK PUSH ERROR:", err?.response?.data || err.message);
    res.status(500).json({
      ok: false,
      error: "STK push failed",
      details: err?.response?.data || err.message,
    });
  }
});

// ----------------------------------------------------------------------------
// 2) M-Pesa Callback (THIS IS YOUR CALLBACK ENDPOINT)
// POST /api/payments/mpesa/callback
// Safaricom will POST payment results here.
// ----------------------------------------------------------------------------
app.post("/api/payments/mpesa/callback", (req, res) => {
  try {
    const body = req.body;

    console.log("✅ M-PESA CALLBACK RECEIVED:");
    console.log(JSON.stringify(body, null, 2));

    // Extract useful fields safely
    const stkCallback = body?.Body?.stkCallback;
    const checkoutRequestId = stkCallback?.CheckoutRequestID;
    const resultCode = stkCallback?.ResultCode; // 0 success, others fail
    const resultDesc = stkCallback?.ResultDesc;

    // Default fields
    let receipt = null;
    let amount = null;
    let phone = null;

    // On success, CallbackMetadata exists
    const items = stkCallback?.CallbackMetadata?.Item || [];
    for (const it of items) {
      if (it.Name === "MpesaReceiptNumber") receipt = it.Value;
      if (it.Name === "Amount") amount = it.Value;
      if (it.Name === "PhoneNumber") phone = String(it.Value);
    }

    if (checkoutRequestId) {
      const existing = mpesaTx.get(checkoutRequestId) || {};
      const status = resultCode === 0 ? "SUCCESS" : "FAILED";

      mpesaTx.set(checkoutRequestId, {
        ...existing,
        status,
        receipt: receipt || existing.receipt || null,
        amount: amount ?? existing.amount ?? null,
        phone: phone || existing.phone || null,
        resultCode,
        resultDesc,
        rawCallback: body,
      });

      // TODO NEXT MILESTONE:
      // - mark booking as PAID if SUCCESS
      // - trigger WhatsApp/Email notifications
      // - create a DB record instead of in-memory
    }

    // Always respond 200 OK so Safaricom knows you accepted it
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (err) {
    console.error("CALLBACK HANDLER ERROR:", err.message);

    // Still return 200 to avoid repeated retries while debugging
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

// ----------------------------------------------------------------------------
// 3) Optional: Poll status from frontend
// GET /api/payments/mpesa/status/:checkoutRequestId
// ----------------------------------------------------------------------------
app.get("/api/payments/mpesa/status/:checkoutRequestId", (req, res) => {
  const id = req.params.checkoutRequestId;
  const tx = mpesaTx.get(id);
  if (!tx) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, checkoutRequestId: id, ...tx });
});

// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ TrackWash API running on port ${PORT}`));
