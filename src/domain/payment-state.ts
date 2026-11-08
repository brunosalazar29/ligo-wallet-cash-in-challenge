import type { OperationStatus } from './types.js';

export type TransitionDecision =
  | { kind: 'APPLY'; nextStatus: 'SUCCEEDED' | 'FAILED' }
  | { kind: 'NO_STATE_CHANGE' }
  | { kind: 'DUPLICATE_EFFECT' }
  | { kind: 'RECONCILIATION_REQUIRED'; reason: string };

/**
 * The local state is monotonic. A pending event can never undo a terminal
 * result, and contradictory terminal results require provider reconciliation.
 */
export function decidePaymentTransition(
  current: OperationStatus,
  incoming: OperationStatus,
): TransitionDecision {
  if (current === 'PENDING' && incoming === 'SUCCEEDED') {
    return { kind: 'APPLY', nextStatus: 'SUCCEEDED' };
  }
  if (current === 'PENDING' && incoming === 'FAILED') {
    return { kind: 'APPLY', nextStatus: 'FAILED' };
  }
  if (incoming === 'PENDING') return { kind: 'NO_STATE_CHANGE' };
  if (current === incoming) return { kind: 'DUPLICATE_EFFECT' };
  return {
    kind: 'RECONCILIATION_REQUIRED',
    reason: `Conflicting terminal payment states: ${current} then ${incoming}`,
  };
}

