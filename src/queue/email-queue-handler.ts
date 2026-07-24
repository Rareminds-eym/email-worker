/**
 * Email Queue Handler for Email Worker
 * 
 * Generic email queue consumer - sends emails with provided templates.
 * No project-specific logic or URLs.
 * 
 * Retry/DLQ handling: Cloudflare manages retries (max_retries=3) and DLQ routing
 * automatically via wrangler.toml config. On transient failures, call message.retry()
 * and Cloudflare counts attempts and moves to email-dlq after 3 retries.
 * 
 * Validation failures are acked immediately to avoid wasting retries on permanently
 * broken messages.
 */

import type { Env, SendEmailRequest } from '../types';
import { getEmailConfig } from '../config/config';
import { EmailEngine } from '../core/EmailEngine';

export interface EmailMessage extends SendEmailRequest {
  type: 'send-email';
}

type ValidationResult =
  | { valid: true; data: EmailMessage }
  | { valid: false; reason: string };

/**
 * Pure decision function: Validates incoming queue payload without side effects.
 * Supports string or array recipients and optional fields (from, replyTo, cc, bcc, metadata).
 * Applied Senior Pattern #4 (Discriminated Unions) & Pattern #5 (Decision vs Action Separation).
 */
export function validateEmailMessage(body: unknown): ValidationResult {
  if (!body || typeof body !== 'object') {
    return { valid: false, reason: 'Message body must be a non-null object' };
  }

  const msg = body as Record<string, unknown>;

  const isToString = typeof msg.to === 'string' && msg.to.trim().length > 0;
  const isToArray =
    Array.isArray(msg.to) &&
    msg.to.length > 0 &&
    msg.to.every((item) => typeof item === 'string' && item.trim().length > 0);

  if (!isToString && !isToArray) {
    return { valid: false, reason: 'Field "to" must be a non-empty string or array of strings' };
  }

  if (typeof msg.subject !== 'string' || !msg.subject.trim()) {
    return { valid: false, reason: 'Field "subject" must be a non-empty string' };
  }

  if (typeof msg.html !== 'string' || !msg.html.trim()) {
    return { valid: false, reason: 'Field "html" must be a non-empty string' };
  }

  const recipient = typeof msg.to === 'string'
    ? msg.to.trim()
    : (msg.to as string[]).map((s) => s.trim());

  return {
    valid: true,
    data: {
      type: 'send-email',
      to: recipient,
      subject: msg.subject.trim(),
      html: msg.html,
      text: typeof msg.text === 'string' ? msg.text : undefined,
      from: typeof msg.from === 'string' ? msg.from : undefined,
      fromName: typeof msg.fromName === 'string' ? msg.fromName : undefined,
      replyTo: typeof msg.replyTo === 'string' ? msg.replyTo : undefined,
      cc: Array.isArray(msg.cc) ? (msg.cc as string[]) : undefined,
      bcc: Array.isArray(msg.bcc) ? (msg.bcc as string[]) : undefined,
      metadata: msg.metadata && typeof msg.metadata === 'object' ? (msg.metadata as Record<string, any>) : undefined,
    },
  };
}

/**
 * Main Queue Consumer entrypoint for email batch processing.
 * Reads incident-order with guard clauses (Senior Pattern #1).
 */
export async function handleEmailQueue(env: Env, batch: MessageBatch): Promise<void> {
  for (const message of batch.messages) {
    await processSingleMessage(env, message);
  }
}

/**
 * Orchestrates processing for a single queue message.
 * Ensures strict single-ownership of message lifecycle (ack vs retry).
 */
async function processSingleMessage(env: Env, message: Message<unknown>): Promise<void> {
  // Guard 1: Malformed body check
  if (!message.body || typeof message.body !== 'object') {
    console.error('[email-worker] [Queue] ❌ MALFORMED MESSAGE: body is not an object. Acking.', {
      received: message.body,
    });
    message.ack();
    return;
  }

  const rawBody = message.body as Record<string, unknown>;

  // Guard 2: Legacy message type deprecation
  if (rawBody.type === 'learner-invitation') {
    console.error(
      '[email-worker] [Queue] ❌ LEGACY MESSAGE TYPE "learner-invitation" is deprecated. Acking message to remove from queue.',
      { payload: rawBody }
    );
    message.ack();
    return;
  }

  // Guard 3: Unknown message type
  if (rawBody.type !== 'send-email') {
    console.error(
      `[email-worker] [Queue] ❌ UNKNOWN MESSAGE TYPE: "${String(rawBody.type)}". Expected "send-email". Acking.`,
      { payload: rawBody }
    );
    message.ack();
    return;
  }

  // Pure validation step
  const validation = validateEmailMessage(rawBody);

  if (!validation.valid) {
    console.error(`[email-worker] [Queue] ❌ VALIDATION FAILURE: ${validation.reason}. Acking message.`, {
      payload: rawBody,
    });
    message.ack();
    return;
  }

  // Action: Send email via engine
  try {
    const payload = validation.data;
    const recipientStr = Array.isArray(payload.to) ? payload.to.join(', ') : payload.to;
    console.log(`[email-worker] [Queue] 📧 Sending email to ${recipientStr}`);

    const config = getEmailConfig(env);
    const engine = new EmailEngine(config);

    const result = await engine.send(payload);

    if (!result.success) {
      throw new Error(result.error || 'Provider returned unsuccessful response');
    }

    console.log(`[email-worker] [Queue] ✅ Email sent successfully to ${recipientStr}`);
    message.ack();
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[email-worker] [Queue] ❌ Transient error sending email: ${errorMsg}`);
    console.log('[email-worker] [Queue] 🔄 Triggering Cloudflare queue retry (max_retries=3 -> DLQ)');
    message.retry();
  }
}
