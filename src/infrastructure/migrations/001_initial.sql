CREATE TABLE IF NOT EXISTS wallets (
  user_id text PRIMARY KEY,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance_minor bigint NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cash_in_operations (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES wallets(user_id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 255),
  request_hash char(64) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  payment_method text NOT NULL CHECK (length(payment_method) BETWEEN 1 AND 80),
  provider_idempotency_key text NOT NULL UNIQUE,
  provider_payment_id text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_in_user_idempotency_unique UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS cash_in_operations_status_created_idx
  ON cash_in_operations (status, created_at);

CREATE TABLE IF NOT EXISTS payment_outbox (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE REFERENCES cash_in_operations(id),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_outbox_ready_idx
  ON payment_outbox (available_at, created_at)
  WHERE completed_at IS NULL;

CREATE TABLE IF NOT EXISTS ledger_entries (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES wallets(user_id),
  operation_id uuid NOT NULL UNIQUE REFERENCES cash_in_operations(id),
  entry_type text NOT NULL CHECK (entry_type = 'CASH_IN'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  balance_after_minor bigint NOT NULL CHECK (balance_after_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_entries_user_created_idx
  ON ledger_entries (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_webhook_events (
  event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 255),
  operation_id uuid NOT NULL REFERENCES cash_in_operations(id),
  provider_payment_id text,
  event_status text NOT NULL CHECK (event_status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  provider_sequence bigint,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  disposition text NOT NULL CHECK (
    disposition IN ('APPLIED', 'NO_STATE_CHANGE', 'DUPLICATE_EFFECT', 'RECONCILIATION_REQUIRED')
  ),
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reconciliation_cases (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES cash_in_operations(id),
  source text NOT NULL CHECK (source IN ('WEBHOOK', 'PROVIDER_RESPONSE')),
  reason text NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS reconciliation_cases_open_idx
  ON reconciliation_cases (created_at)
  WHERE resolved_at IS NULL;

-- This table belongs to the local provider simulator. It persists provider-side
-- idempotency so a simulated charge survives an application process restart.
CREATE TABLE IF NOT EXISTS simulated_provider_payments (
  idempotency_key text PRIMARY KEY,
  provider_payment_id text NOT NULL UNIQUE,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  payment_method text NOT NULL,
  status text NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED')),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
