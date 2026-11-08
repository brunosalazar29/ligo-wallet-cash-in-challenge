import type { Pool } from 'pg';
import type { PaymentWebhookEvent } from '../domain/types.js';
import { applyWebhookEvent } from '../infrastructure/cash-in-repository.js';

export class WebhookService {
  constructor(private readonly pool: Pool) {}

  receive(event: PaymentWebhookEvent) {
    return applyWebhookEvent(this.pool, event);
  }
}
