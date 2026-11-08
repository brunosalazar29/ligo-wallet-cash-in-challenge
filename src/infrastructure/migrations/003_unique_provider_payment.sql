CREATE UNIQUE INDEX IF NOT EXISTS cash_in_provider_payment_unique_idx
  ON cash_in_operations (provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
