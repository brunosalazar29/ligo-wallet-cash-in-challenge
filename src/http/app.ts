import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from 'pg';
import { CashInService } from '../application/cash-in-service.js';
import { PaymentDispatcher } from '../application/payment-dispatcher.js';
import { WebhookService } from '../application/webhook-service.js';
import { AppError } from '../domain/errors.js';
import type { OperationStatus, PaymentWebhookEvent } from '../domain/types.js';
import { getCashInView } from '../infrastructure/cash-in-repository.js';
import { verifyWebhookSignature } from './webhook-signature.js';

const CashInBodySchema = z.object({
  user_id: z.string().trim().min(1).max(120),
  amount: z.union([
    z.number().finite().positive(),
    z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/, 'amount must have at most two decimal places'),
  ]),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  payment_method: z.string().trim().min(1).max(80),
});

const WebhookBodySchema = z.object({
  event_id: z.string().trim().min(1).max(255),
  operation_id: z.string().uuid(),
  provider_payment_id: z.string().trim().min(1).max(255).nullable().optional(),
  status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']),
  provider_sequence: z.number().int().positive().nullable().optional(),
  occurred_at: z.string().datetime({ offset: true }),
  failure_code: z.string().trim().min(1).max(100).optional(),
  failure_message: z.string().trim().min(1).max(300).optional(),
});

const MAX_BIGINT = 9_223_372_036_854_775_807n;

export interface AppDependencies {
  pool: Pool;
  dispatcher: PaymentDispatcher;
  webhookSecret: string;
  logger?: boolean;
}

function parseMinorUnits(value: number | string): bigint {
  const text = typeof value === 'number' ? value.toString() : value;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new AppError(400, 'INVALID_AMOUNT', 'amount must be a positive decimal with at most two places');
  }
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  const minor = whole * 100n + fraction;
  if (minor <= 0n || minor > MAX_BIGINT) {
    throw new AppError(400, 'INVALID_AMOUNT', 'amount is outside the supported range');
  }
  return minor;
}

function formatMinorUnits(minor: bigint): string {
  const whole = minor / 100n;
  const fraction = (minor % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

function publicStatus(status: OperationStatus): 'pending' | 'completed' | 'failed' {
  if (status === 'SUCCEEDED') return 'completed';
  if (status === 'FAILED') return 'failed';
  return 'pending';
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: dependencies.logger ?? true });
  const cashInService = new CashInService(dependencies.pool, dependencies.dispatcher);
  const webhookService = new WebhookService(dependencies.pool);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body, done) => {
      const rawBody = typeof body === 'string' ? body : body.toString('utf8');
      request.rawBody = rawBody;
      try {
        done(null, JSON.parse(rawBody));
      } catch {
        const error = new Error('Malformed JSON') as Error & { statusCode: number };
        error.statusCode = 400;
        done(error);
      }
    },
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, request_id: request.id },
      });
    }
    const candidateStatus =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
    const statusCode = typeof candidateStatus === 'number' ? candidateStatus : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Request failed');
    }
    return reply.status(statusCode).send({
      error: {
        code: statusCode === 400 ? 'INVALID_JSON' : 'INTERNAL_ERROR',
        message: statusCode === 400 ? 'Request body must be valid JSON' : 'An unexpected error occurred',
        request_id: request.id,
      },
    });
  });

  app.get('/health', async (_request, reply) => {
    await dependencies.pool.query('SELECT 1');
    return reply.send({ status: 'ok' });
  });

  app.post('/cash-in', async (request, reply) => {
    const key = firstHeader(request.headers['idempotency-key']);
    const keyResult = z.string().uuid().safeParse(key);
    if (!keyResult.success) {
      throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be a UUID');
    }

    const bodyResult = CashInBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new AppError(400, 'INVALID_REQUEST', bodyResult.error.issues[0]?.message ?? 'Invalid request body');
    }
    const body = bodyResult.data;
    const view = await cashInService.submit({
      userId: body.user_id,
      idempotencyKey: keyResult.data,
      amountMinor: parseMinorUnits(body.amount),
      currency: body.currency,
      paymentMethod: body.payment_method,
    });

    const operation = view.operation;
    const response = {
      operation_id: operation.id,
      status: publicStatus(operation.status),
      amount: formatMinorUnits(operation.amountMinor),
      currency: operation.currency,
      ...(view.balanceAfterMinor !== null
        ? { new_balance: formatMinorUnits(view.balanceAfterMinor) }
        : {}),
      ...(operation.status === 'FAILED'
        ? {
            error: {
              code: operation.failureCode ?? 'PAYMENT_DECLINED',
              message: operation.failureMessage ?? 'Payment was declined',
            },
          }
        : {}),
    };

    if (operation.status === 'PENDING') {
      reply.header('retry-after', '1');
      return reply.status(202).send(response);
    }
    if (operation.status === 'FAILED') return reply.status(422).send(response);
    return reply.status(200).send(response);
  });

  app.post('/webhooks/payment', async (request, reply) => {
    const signature = firstHeader(request.headers['x-payment-signature']);
    const timestamp = firstHeader(request.headers['x-payment-timestamp']);
    const rawBody = request.rawBody ?? '';
    if (
      !verifyWebhookSignature({
        rawBody,
        timestamp,
        signature,
        secret: dependencies.webhookSecret,
      })
    ) {
      throw new AppError(401, 'INVALID_WEBHOOK_SIGNATURE', 'Webhook signature is invalid or expired');
    }

    const bodyResult = WebhookBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new AppError(400, 'INVALID_WEBHOOK', bodyResult.error.issues[0]?.message ?? 'Invalid webhook body');
    }
    const body = bodyResult.data;
    if (body.status === 'SUCCEEDED' && !body.provider_payment_id) {
      throw new AppError(400, 'INVALID_WEBHOOK', 'Successful webhook must include provider_payment_id');
    }
    const event: PaymentWebhookEvent = {
      eventId: body.event_id,
      operationId: body.operation_id,
      providerPaymentId: body.provider_payment_id ?? null,
      status: body.status,
      providerSequence: body.provider_sequence ?? null,
      occurredAt: new Date(body.occurred_at),
      payload: body as Record<string, unknown>,
      failureCode: body.failure_code ?? null,
      failureMessage: body.failure_message ?? null,
    };
    const result = await webhookService.receive(event);
    const view = await getCashInView(dependencies.pool, event.operationId);
    return reply.status(200).send({
      received: true,
      duplicate_event: result.duplicateEvent,
      disposition: result.disposition,
      operation_id: event.operationId,
      status: publicStatus(view?.operation.status ?? result.currentStatus),
    });
  });

  return app;
}
