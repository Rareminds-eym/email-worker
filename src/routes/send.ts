/**
 * POST /send - Send email
 */

import type { Env, SendEmailResponse } from '../types';
import { validateSendEmailRequest } from '../middleware/validator';
import { EmailEngine } from '../core/EmailEngine';
import { getEmailConfig } from '../config/config';
import { log } from '../middleware/logger';

export async function handleSend(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json();
    const validatedRequest = validateSendEmailRequest(body);
    
    const config = getEmailConfig(env);
    const engine = new EmailEngine(config);
    const result = await engine.send(validatedRequest);
    
    if (!result.success) {
      log('error', 'Email sending failed', {
        error: result.error,
        recipients: validatedRequest.to,
      });
      
      const response: SendEmailResponse = {
        success: false,
        error: result.error || 'Failed to send email',
        errorCode: 'PROVIDER_ERROR',
      };
      
      return Response.json(response, { status: 500 });
    }
    
    log('info', 'Email sent successfully', {
      messageId: result.messageId,
      recipients: validatedRequest.to,
    });
    
    const response: SendEmailResponse = {
      success: true,
      messageId: result.messageId,
      recipient: validatedRequest.to,
      timestamp: new Date().toISOString(),
    };
    
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
