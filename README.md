# Seneca Payout Service

A tiny standalone Node.js service. It does exactly one job:

1. ERPNext (via Frappe's native Webhook feature) calls POST /cashfree-payout
   when a Reward Redeem Request's status becomes "Approved".
2. This service registers the customer as a Cashfree beneficiary (if not
   already), fires the UPI payout, and — on success — calls back to ERPNext
   to set status = Paid, payment_processed = 1, transaction_id.

## Local setup

npm install
cp .env.example .env
npm start

## Deploy (Render, free tier)

1. Push this folder to a new GitHub repo (e.g. seneca-payout-service).
2. Go to render.com > New > Web Service > connect that GitHub repo.
3. Build command: npm install  |  Start command: npm start
4. Under Environment, add all the variables from .env.example with real
   values (Cashfree test keys, your Frappe site URL, Frappe API key/secret,
   and a WEBHOOK_SECRET you make up).
5. Deploy. Render gives you a URL like https://seneca-payout-service.onrender.com

## ERPNext side: create the Webhook

In ERPNext desk, search "Webhook" (this is a built-in Frappe doctype, not the
Server Script we tried earlier) and create a new one:

- Doc Type: Reward Redeem Request
- Doc Event: on_update
- Request URL: https://<your-render-url>/cashfree-payout
- Request Method: POST
- Condition (optional but recommended): doc.status == "Approved" and not doc.payment_processed
- Webhook Headers: add one — key x-webhook-secret, value = the same
  WEBHOOK_SECRET you set on Render
- Webhook Data: add these fields so the payload matches what server.js
  expects — name, customer_name, mobile, upi_id, amount, status
  (use the exact same key on both sides)

## ERPNext side: create an API user for the callback

Don't use your own personal login's API key for this. Create a dedicated
user (e.g. payout-bot@seneca.co.in) with just enough permissions to write
to Reward Redeem Request, then:

User list > that user > API Access section > Generate Keys. Put the
resulting API Key and API Secret into the Render environment variables
(FRAPPE_API_KEY, FRAPPE_API_SECRET).

## Testing

Create a Reward Redeem Request with your own real UPI ID and ₹1, set Status
to Approved, Save. Within a few seconds it should flip to Paid. Check
Render's logs (Render dashboard > your service > Logs) if it doesn't —
that's where any Cashfree or ERPNext error will show up.
