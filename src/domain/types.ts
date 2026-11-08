export type OperationStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';
export type ProviderStatus = OperationStatus;
export type EventDisposition =
  | 'APPLIED'
  | 'NO_STATE_CHANGE'
  | 'DUPLICATE_EFFECT'
  | 'RECONCILIATION_REQUIRED';

export interface CashInInput {
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  amountMinor: bigint;
  currency: string;
  paymentMethod: string;
}

export interface CashInOperation {
  id: string;
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  amountMinor: bigint;
  currency: string;
  paymentMethod: string;
  providerIdempotencyKey: string;
  providerPaymentId: string | null;
  status: OperationStatus;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CashInView {
  operation: CashInOperation;
  balanceAfterMinor: bigint | null;
}

export interface ProviderResult {
  status: 'SUCCEEDED' | 'FAILED';
  providerPaymentId: string;
  failureCode: string | null;
  failureMessage: string | null;
  replayed: boolean;
}

export interface PaymentWebhookEvent {
  eventId: string;
  operationId: string;
  providerPaymentId: string | null;
  status: ProviderStatus;
  providerSequence: number | null;
  occurredAt: Date;
  payload: Record<string, unknown>;
  failureCode: string | null;
  failureMessage: string | null;
}
