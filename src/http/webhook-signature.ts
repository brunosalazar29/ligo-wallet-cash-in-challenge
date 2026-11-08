import { createHmac, timingSafeEqual } from 'node:crypto';

export function createWebhookSignature(
  rawBody: string,
  timestampSeconds: string,
  secret: string,
): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest('hex');
  return `sha256=${digest}`;
}

export function verifyWebhookSignature(input: {
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
  secret: string;
  nowMs?: number;
  toleranceSeconds?: number;
}): boolean {
  const {
    rawBody,
    timestamp,
    signature,
    secret,
    nowMs = Date.now(),
    toleranceSeconds = 300,
  } = input;
  if (!timestamp || !/^\d{10,13}$/.test(timestamp) || !signature) return false;
  const timestampSeconds = Number(timestamp.length === 13 ? Number(timestamp) / 1000 : timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - timestampSeconds) > toleranceSeconds) return false;

  const expected = Buffer.from(createWebhookSignature(rawBody, String(timestamp), secret).slice(7), 'hex');
  const providedHex = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  if (!/^[a-fA-F0-9]{64}$/.test(providedHex)) return false;
  const provided = Buffer.from(providedHex, 'hex');
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
