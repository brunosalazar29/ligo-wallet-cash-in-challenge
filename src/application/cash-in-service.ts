import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { AppError } from '../domain/errors.js';
import type { CashInOperation, CashInView } from '../domain/types.js';
import { createOrGetCashIn, getCashInView } from '../infrastructure/cash-in-repository.js';
import { PaymentDispatcher } from './payment-dispatcher.js';

export interface CashInCommand {
  userId: string;
  idempotencyKey: string;
  amountMinor: bigint;
  currency: string;
  paymentMethod: string;
}

export class CashInService {
  constructor(
    private readonly pool: Pool,
    private readonly dispatcher: PaymentDispatcher,
  ) {}

  async submit(command: CashInCommand): Promise<CashInView> {
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          user_id: command.userId,
          amount_minor: command.amountMinor.toString(),
          currency: command.currency,
          payment_method: command.paymentMethod,
        }),
      )
      .digest('hex');

    const { operation } = await createOrGetCashIn(this.pool, {
      ...command,
      requestHash,
    });
    let latest: CashInOperation | null = operation;
    if (latest.status === 'PENDING') {
      latest = await this.dispatcher.dispatchOperation(operation.id);
    }
    if (!latest) throw new AppError(404, 'OPERATION_NOT_FOUND', 'Cash-in operation was not found');

    const view = await getCashInView(this.pool, latest.id);
    if (!view) throw new AppError(404, 'OPERATION_NOT_FOUND', 'Cash-in operation was not found');
    return view;
  }
}
