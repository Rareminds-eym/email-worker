/**
 * POST /send - Send email
 */

import type { Env, SendEmailResponse } from '../types';
import { ValidationError } from '../types';
import { validateSendEmailRequest } from '../middleware/validator';
import { validateAndReadBody } from '../middleware/bodySize';
import { EmailEngine } from '../core/EmailEngine';
import { getEmailConfig } from '../config/config';
import { log } from '../middleware/logger';

let cachedEngine: EmailEngine | null = null;
let cachedRegion: string | null = null;
let cachedAccessKey: string | null = null;

export async function handleSend(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    // Validate actual body size (not Content-Length header)
    const bodyText = await validateAndReadBody(request);
    
    // Parse JSON with proper error handling
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch (jsonError: any) {
      throw new ValidationError(`Invalid JSON: ${jsonError.message}`);
    }
    
    const validatedRequest = validateSendEmailRequest(body);
    
    // Extract idempotency key from headers if provided
    const idempotencyKey = request.headers.get('Idempotency-Key') || request.headers.get('X-Idempotency-Key');

    const config = getEmailConfig(env);

    if (!cachedEngine || cachedRegion !== env.AWS_REGION || cachedAccessKey !== env.AWS_ACCESS_KEY_ID) {
      cachedEngine = new EmailEngine(config);
      cachedRegion = env.AWS_REGION;
      cachedAccessKey = env.AWS_ACCESS_KEY_ID;
    }

    const result = await cachedEngine.send(validatedRequest);

    if (!result.success) {
      log('error', 'Email sending failed', {
        error: result.error,
        recipients: validatedRequest.to,
      });

      const response: SendEmailResponse = {
        success: false,
        error: result.error || 'Failed to send email',
        errorCode: 'PROVIDER_ERROR',
        errorType: result.errorType,
        shouldRetry: result.shouldRetry,
      };

      const statusCode = result.shouldRetry ? 503 : 500;
      const headers: Record<string, string> = {};
      if (result.shouldRetry) {
        headers['Retry-After'] = '30';
      }

      return Response.json(response, { status: statusCode, headers });
    }

    log('info', 'Email sent successfully', {
      messageId: result.messageId,
      recipients: validatedRequest.to,
    });

    const response: SendEmailResponse = {
      success: true,
      messageId: result.messageId,
      customMessageId: result.customMessageId,
      recipient: validatedRequest.to,
      timestamp: new Date().toISOString(),
    };

    if (idempotencyKey) {
      // Store success result for 24 hours
      await env.RATE_LIMIT_KV.put(`idem:${idempotencyKey}`, JSON.stringify(response), { expirationTtl: 86400 });
    }

    return Response.json(response, { status: 200 });
  } catch (error: any) {
    log('error', 'Failed to send email', {
      error: error.message,
    });

    const response: SendEmailResponse = {
      success: false,
      error: error.message,
      errorCode: error.code || 'SEND_ERROR',
    };

    return Response.json(response, { status: error.statusCode || 500 });
  }
}
