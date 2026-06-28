/**
 * Shared Email API Worker
 * Shared email sending service via AWS SES
 */

import { Router } from 'itty-router';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env, SendEmailRequest, SendEmailResponse, SendOTPRequest, SendOTPResponse, VerifyOTPRequest, VerifyOTPResponse } from './types';
import { EmailWorkerError, AuthenticationError, RateLimitError, ValidationError, OTPError } from './types';
import { getCorsHeaders, VERSION } from './constants';
import { authenticateRequest } from './middleware/auth';
import { checkRateLimit } from './middleware/rateLimit';
import { log, logRequest, logResponse, logError } from './middleware/logger';
import { handleSend } from './routes/send';
import { handleHealth, handleDetailedHealth } from './routes/health';
import { handleSendOTP, handleVerifyOTP } from './routes/otp';
import { validateSendEmailRequest } from './middleware/validator';
import { getEmailConfig } from './config/config';
import { EmailEngine } from './core/EmailEngine';
import { MessageCentralService } from './services/MessageCentralService';
import { checkOTPRateLimit } from './middleware/otpRateLimit';
import { validatePhoneNumber, validateCountryCode, validateFlowType, validateVerificationId, validateOTPCode } from './middleware/otpValidator';
import { maskPhoneNumber } from './utils/maskPhone';

const router = Router();

// ==================== CORS PREFLIGHT ====================

router.options('*', (request, env: Env) => {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request, env),
  });
});

// ==================== GLOBAL MIDDLEWARE ====================

router.all('*', (request, env: Env) => {
  // Global CORS Early Block (Enforces safe origin restrictions for ALL routes)
  const corsHeaders = getCorsHeaders(request, env);
  if (request.headers.get('Origin') && !corsHeaders['Access-Control-Allow-Origin']) {
    return Response.json({ success: false, error: 'Origin not allowed' }, { status: 403, headers: corsHeaders });
  }
});

// ==================== PUBLIC ROUTES (NO AUTH) ====================

router.get('/health', async (request, env: Env) => {
  const response = await handleHealth(request, env);
  Object.entries(getCorsHeaders(request, env)).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
});

router.get('/', (request, env: Env) => {
  return Response.json({
    service: 'Shared Email & OTP API',
    version: VERSION,
    endpoints: {
      'POST /send': 'Send email with HTML content',
      'POST /otp/send': 'Send OTP to phone number',
      'POST /otp/verify': 'Verify OTP code',
      'GET /health': 'Health check (Public)',
      'GET /internal/health': 'Health check (Detailed)',
    },
    authentication: 'X-Internal-Api-Key header (preferred), X-API-Key header, or Authorization: Bearer token',
  }, { headers: getCorsHeaders(request, env) });
});

// ==================== AUTHENTICATED ROUTES ====================

router.get('/internal/health', async (request, env: Env) => {
  try {
    await authenticateRequest(request, env);
    const response = await handleDetailedHealth(request, env);
    Object.entries(getCorsHeaders(request, env)).forEach(([k, v]) => response.headers.set(k, v));
    return response;
  } catch (error: any) {
    return handleError(error, request, env);
  }
});

router.post('/send', async (request, env: Env) => {
  const startTime = Date.now();
  const requestId = request.headers.get('cf-ray') || crypto.randomUUID();

  try {
    // Authenticate
    await authenticateRequest(request, env);
    logRequest(request, null);
    
    // Rate limit
    await checkRateLimit(request, env);

    // Handle request
    const response = await handleSend(request, env);

    // Add CORS headers
    Object.entries(getCorsHeaders(request, env)).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    logResponse(request, response, { requestId }, Date.now() - startTime);
    return response;
  } catch (error: any) {
    const isClientError = error instanceof AuthenticationError || error instanceof ValidationError || error instanceof RateLimitError;
    const logLevel = isClientError ? 'warn' : 'error';

    if (logLevel === 'error') {
      logError(error, { path: '/send', requestId });
    } else {
      log(logLevel, error.message || 'Client request rejected', {
        error: error.message,
        path: '/send',
        requestId
      });
    }

    return handleError(error, request, env);
  }
});


// ==================== OTP ROUTES ====================

router.post('/otp/send', async (request, env: Env) => {
  const startTime = Date.now();
  const requestId = request.headers.get('cf-ray') || crypto.randomUUID();

  try {
    await authenticateRequest(request, env);
    logRequest(request, { requestId });

    const response = await handleSendOTP(request, env);

    Object.entries(getCorsHeaders(request, env)).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    logResponse(request, response, { requestId }, Date.now() - startTime);
    return response;
  } catch (error: any) {
    const isClientError = error instanceof AuthenticationError || error instanceof ValidationError || error instanceof RateLimitError;
    const logLevel = isClientError ? 'warn' : 'error';

    if (logLevel === 'error') {
      logError(error, { path: '/otp/send', requestId });
    } else {
      log(logLevel, error.message || 'Client request rejected', {
        error: error.message,
        path: '/otp/send',
        requestId
      });
    }

    return handleError(error, request, env);
  }
});

router.post('/otp/verify', async (request, env: Env) => {
  const startTime = Date.now();
  const requestId = request.headers.get('cf-ray') || crypto.randomUUID();

  try {
    await authenticateRequest(request, env);
    logRequest(request, { requestId });

    const response = await handleVerifyOTP(request, env);

    Object.entries(getCorsHeaders(request, env)).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    logResponse(request, response, { requestId }, Date.now() - startTime);
    return response;
  } catch (error: any) {
    const isClientError = error instanceof AuthenticationError || error instanceof ValidationError || error instanceof RateLimitError;
    const logLevel = isClientError ? 'warn' : 'error';

    if (logLevel === 'error') {
      logError(error, { path: '/otp/verify', requestId });
    } else {
      log(logLevel, error.message || 'Client request rejected', {
        error: error.message,
        path: '/otp/verify',
        requestId
      });
    }

    return handleError(error, request, env);
  }
});

// ==================== 404 HANDLER ====================

router.all('*', (request, env: Env) => {
  return Response.json({
    success: false,
    error: 'Route not found',
    errorCode: 'NOT_FOUND',
  }, { status: 404, headers: getCorsHeaders(request, env) });
});

// ==================== ERROR HANDLER ====================

function handleError(error: any, request: Request, env?: Env): Response {
  const corsHeaders = getCorsHeaders(request, env);

  if (error instanceof AuthenticationError) {
    return Response.json({
      success: false,
      error: error.message,
      errorCode: error.code,
    }, { status: error.statusCode, headers: corsHeaders });
  }

  if (error instanceof RateLimitError) {
    return Response.json({
      success: false,
      error: error.message,
      errorCode: error.code,
      retryAfter: error.retryAfter,
    }, {
      status: error.statusCode,
      headers: {
        ...corsHeaders,
        'Retry-After': error.retryAfter.toString(),
      },
    });
  }

  if (error instanceof ValidationError) {
    return Response.json({
      success: false,
      error: error.message,
      errorCode: error.code,
      details: error.details,
    }, { status: error.statusCode, headers: corsHeaders });
  }

  if (error instanceof OTPError) {
    return Response.json({
      success: false,
      error: error.message,
      errorCode: error.code,
      details: error.details,
    }, { status: error.statusCode, headers: corsHeaders });
  }

  if (error instanceof EmailWorkerError) {
    return Response.json({
      success: false,
      error: error.message,
      errorCode: error.code,
      details: error.details,
    }, { status: error.statusCode, headers: corsHeaders });
  }

  // Unknown error
  console.error('Unhandled error:', error);
  return Response.json({
    success: false,
    error: 'Internal server error',
    errorCode: 'INTERNAL_ERROR',
  }, { status: 500, headers: corsHeaders });
}

// ==================== WORKER EXPORT (default) ====================

class EmailService extends WorkerEntrypoint<Env> {
  // ── RPC Methods ──────────────────────────────────────────────────────

  async sendEmail(request: SendEmailRequest): Promise<SendEmailResponse> {
    try {
      const validatedRequest = validateSendEmailRequest(request);
      const config = getEmailConfig(this.env);
      const engine = new EmailEngine(config);
      const result = await engine.send(validatedRequest);

      return {
        success: result.success,
        messageId: result.messageId,
        customMessageId: result.customMessageId,
        recipient: validatedRequest.to,
        timestamp: new Date().toISOString(),
        error: result.error,
        errorCode: result.success ? undefined : 'PROVIDER_ERROR',
        errorType: result.errorType,
        shouldRetry: result.shouldRetry,
      };
    } catch (error: any) {
      log('error', 'RPC sendEmail failed', { error: error.message });
      return {
        success: false,
        error: error.message,
        errorCode: error.code || 'RPC_ERROR',
      };
    }
  }

  async sendOTP(request: SendOTPRequest): Promise<SendOTPResponse> {
    try {
      const { mobileNumber, countryCode, flowType } = request;

      const validatedCountryCode = validateCountryCode(countryCode);
      const validatedPhoneNumber = validatePhoneNumber(mobileNumber, validatedCountryCode);
      const validatedFlowType = validateFlowType(flowType);

      checkOTPRateLimit(validatedPhoneNumber, 'SEND_OTP');

      const service = new MessageCentralService(this.env);
      const result = await service.sendOTP(validatedPhoneNumber, validatedCountryCode, validatedFlowType);

      log('info', 'RPC OTP sent successfully', { phone: maskPhoneNumber(validatedPhoneNumber, validatedCountryCode) });

      return {
        success: true,
        verificationId: result.verificationId,
        timeout: result.timeout,
        message: 'OTP sent successfully',
      };
    } catch (error: any) {
      log('error', 'RPC sendOTP failed', { error: error.message });
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async verifyOTP(request: VerifyOTPRequest): Promise<VerifyOTPResponse> {
    try {
      const { mobileNumber, verificationId, code, countryCode } = request;

      const validatedCountryCode = validateCountryCode(countryCode);
      const validatedPhoneNumber = validatePhoneNumber(mobileNumber, validatedCountryCode);
      validateVerificationId(verificationId);
      validateOTPCode(code);

      checkOTPRateLimit(`${validatedPhoneNumber}_${verificationId}`, 'VERIFY_OTP');

      const service = new MessageCentralService(this.env);
      const result = await service.verifyOTP(validatedPhoneNumber, verificationId, code, validatedCountryCode);

      log('info', result.verified ? 'RPC OTP verified successfully' : 'RPC OTP verification failed', { phone: maskPhoneNumber(validatedPhoneNumber, validatedCountryCode) });

      return {
        success: true,
        verified: result.verified,
        message: result.verified ? 'Phone number verified successfully' : 'Invalid OTP code',
      };
    } catch (error: any) {
      log('error', 'RPC verifyOTP failed', { error: error.message });
      return {
        success: false,
        verified: false,
        error: error.message,
      };
    }
  }

  // ── HTTP Handler ─────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const env = this.env;
    const ctx = this.ctx;
    const requestId = request.headers.get('cf-ray') || crypto.randomUUID();

    try {
      const response = await router.handle(request, env, ctx);
      const newResponse = new Response(response.body, response);
      newResponse.headers.set('X-Request-Id', requestId);
      return newResponse;
    } catch (error: any) {
      logError(error, { path: 'router' });
      return Response.json(
        {
          success: false,
          error: 'Critical internal error',
          errorCode: 'FATAL_ERROR',
        },
        {
          status: 500,
          headers: { ...getCorsHeaders(request, env), 'X-Request-Id': requestId }
        }
      );
    }
  }
}

export { EmailService };
export default EmailService;