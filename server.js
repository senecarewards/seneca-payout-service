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
} = process.env;

const CASHFREE_BASE_URL =
  CASHFREE_ENV === "production"
    ? "https://payout-api.cashfree.com"
    : "https://payout-gamma.cashfree.com";

function cashfreeHeaders() {
  return {
    "x-client-id": CASHFREE_CLIENT_ID,
    "x-client-secret": CASHFREE_CLIENT_SECRET,
    "x-api-version": "2024-01-01",
    "Content-Type": "application/json",
  };
}

async function registerBeneficiary({ beneficiaryId, name, phone, vpa }) {
  try {
    await axios.post(
      `${CASHFREE_BASE_URL}/payout/beneficiary`,
      {
        beneficiary_id: beneficiaryId,
        beneficiary_name: name,
        beneficiary_instrument_details: { vpa },
        beneficiary_contact_details: { beneficiary_phone: phone || "9999999999" },
      },
      { headers: cashfreeHeaders(), timeout: 15000 }
    );
  } catch (err) {
    if (err.response && err.response.status === 409) return;
    throw err;
  }
}

async function createPayout({ transferId, beneficiaryId, amount, remarks }) {
  const resp = await axios.post(
    `${CASHFREE_BASE_URL}/payout/transfers`,
    {
      transfer_id: transferId,
      transfer_amount: Number(amount),
      beneficiary_details: { beneficiary_id: beneficiaryId },
      transfer_mode: "upi",
      remarks: (remarks || "Seneca reward").slice(0, 50),
    },
    { headers: cashfreeHeaders(), timeout: 20000 }
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
  if (req.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "invalid secret" });
  }

  const { name, customer_name, mobile, upi_id, amount, status } = req.body || {};

  if (!name || !upi_id || !amount) {
    return res.status(400).json({ error: "missing name, upi_id, or amount" });
  }

  if (status !== "Approved") {
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
      remarks: `Seneca reward ${name}`,
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
