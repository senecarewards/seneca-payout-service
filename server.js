// Seneca Reward Payout Service
//
// Receives a webhook from ERPNext (Frappe's native Webhook feature) when a
// Reward Redeem Request is approved, calls Cashfree Payouts to send the
// money, then calls back to ERPNext to mark the request as Paid.
//
// This is a small, standalone service — NOT part of ERPNext/Frappe. Deploy
// it separately (Render, Railway, etc.) and point Frappe's Webhook at it.

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json({ type: () => true }));

const {
  PORT = 3000,
  WEBHOOK_SECRET,
  CASHFREE_CLIENT_ID,
  CASHFREE_CLIENT_SECRET,
  CASHFREE_ENV = "sandbox",
  FRAPPE_BASE_URL,
  FRAPPE_API_KEY,
  FRAPPE_API_SECRET,
  CASHFREE_PUBLIC_KEY,
} = process.env;

const CASHFREE_BASE_URL =
  CASHFREE_ENV === "production"
    ? "https://payout-api.cashfree.com/payout/v1"
    : "https://payout-gamma.cashfree.com/payout/v1";

function generateCfSignature() {
  const data = `${CASHFREE_CLIENT_ID}.${Math.floor(Date.now() / 1000)}`;
  const encrypted = crypto.publicEncrypt(
    {
      key: CASHFREE_PUBLIC_KEY,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha1",
    },
    Buffer.from(data)
  );
  return encrypted.toString("base64");
}

// Cache the bearer token in memory — it's valid for a while, no need to
// re-authorize on every single request.
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAuthToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) {
    return cachedToken;
  }

  const signature = generateCfSignature();
  const resp = await axios.post(
    `${CASHFREE_BASE_URL}/authorize`,
    {},
    {
      headers: {
        "X-Client-Id": CASHFREE_CLIENT_ID,
        "X-Client-Secret": CASHFREE_CLIENT_SECRET,
        "X-Cf-Signature": signature,
      },
      timeout: 15000,
    }
  );

    const token = resp.data && resp.data.data && resp.data.data.token;
  console.log("DEBUG authorize response:", JSON.stringify(resp.data));
  if (!token) {
    throw new Error("No token in authorize response: " + JSON.stringify(resp.data));
  }
  // Token is valid ~10 minutes — refresh a bit early to be safe
  cachedToken = token;
  cachedTokenExpiry = Date.now() + 8 * 60 * 1000;
  return token;
}

async function registerBeneficiary({ beneficiaryId, name, phone, vpa }) {
  const token = await getAuthToken();
  try {
    await axios.post(
      `${CASHFREE_BASE_URL}/addBeneficiary`,
      {
        beneId: beneficiaryId,
        name,
        email: "customer@seneca.co.in",
        phone: phone || "9999999999",
        vpa,
        address1: "NA",
      },
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        timeout: 15000,
      }
    );
  } catch (err) {
    // Beneficiary already exists — safe to ignore and proceed
    const msg = err.response && err.response.data && err.response.data.message;
    if (msg && msg.toLowerCase().includes("already")) return;
    throw err;
  }
}

async function createPayout({ transferId, beneficiaryId, amount }) {
  const token = await getAuthToken();
  const resp = await axios.post(
    `${CASHFREE_BASE_URL}/requestTransfer`,
    {
      beneId: beneficiaryId,
      amount: String(amount),
      transferId,
    },
    {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      timeout: 20000,
    }
  );
  return resp.data;
}

async function markPaidInFrappe(docName) {
  await axios.put(
    `${FRAPPE_BASE_URL}/api/resource/Reward Redeem Request/${encodeURIComponent(docName)}`,
    {
      transaction_id: docName,
      payment_processed: 1,
      status: "Paid",
    },
    {
      headers: {
        Authorization: `token ${FRAPPE_API_KEY}:${FRAPPE_API_SECRET}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );
}

app.post("/cashfree-payout", async (req, res) => {
  // Reject anything that doesn't carry the shared secret — this endpoint is
  // public (Frappe needs to reach it), so this header is the only gate.
  if (req.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "invalid secret" });
  }

  const { name, customer_name, mobile, upi_id, amount, status } = req.body || {};

  if (!name || !upi_id || !amount) {
    return res.status(400).json({ error: "missing name, upi_id, or amount" });
  }

  if (status !== "Approved") {
    // Webhook may fire on other status changes too — only act on Approved
    return res.status(200).json({ status: "ignored, not Approved" });
  }

  const beneficiaryId = `CUST-${name}`;

  try {
    await registerBeneficiary({
      beneficiaryId,
      name: customer_name || name,
      phone: mobile,
      vpa: upi_id,
    });

    const payoutResult = await createPayout({
      transferId: name,
      beneficiaryId,
      amount,
    });

    await markPaidInFrappe(name);

    return res.status(200).json({ status: "ok", payout: payoutResult });
  } catch (err) {
    const detail = err.response ? err.response.data : err.message;
    console.error("Payout failed for", name, detail);
    return res.status(500).json({ error: "payout failed", detail });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Seneca payout service listening on port ${PORT}`);
});
