# Seneca Payout Service

A tiny standalone Node.js service. It does exactly one job:

1. ERPNext (via Frappe's native Webhook feature) calls `POST /cashfree-payout`
   when a Reward Redeem Request's status becomes "Approved".
2. This service registers the customer as a Cashfree beneficiary (if not
   already), fires the UPI payout, and — on success — calls back to ERPNext
   to set `status = Paid`, `payment_processed = 1`, `transaction_id`.

## Local setup
