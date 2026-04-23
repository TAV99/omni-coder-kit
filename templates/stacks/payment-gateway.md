## PAYMENT GATEWAY EXPERTISE (VNPAY / PAYPAL / STRIPE)
- **Security First:** NEVER log sensitive payment data, tokens, or customer bank details to the console or log files.
- **Transaction Integrity:** Always use database transactions (ACID properties) when updating order statuses after a payment callback.
- **Webhook Validation:** For webhook endpoints, strictly verify the signature (e.g., checksum for VNPay, webhook secret for Stripe) before processing any logic.
- **Idempotency:** Ensure the payment success processing logic is idempotent (processing the same successful callback multiple times must not result in duplicate order fulfillments).