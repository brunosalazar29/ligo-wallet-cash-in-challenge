ALTER TABLE simulated_provider_payments
  ADD COLUMN IF NOT EXISTS payment_method text;

UPDATE simulated_provider_payments
SET payment_method = 'unknown'
WHERE payment_method IS NULL;

ALTER TABLE simulated_provider_payments
  ALTER COLUMN payment_method SET NOT NULL;
