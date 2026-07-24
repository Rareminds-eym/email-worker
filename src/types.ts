/**
 * Core type definitions for Shared Email API Worker
 */

/// <reference types="@cloudflare/workers-types" />

// ==================== ENVIRONMENT ====================

export interface Env {
  // KV Namespaces
  RATE_LIMIT_KV: KVNamespace;
  
  // Rate Limiters (only minute-level, Cloudflare only supports 10 or 60 second periods)
  RATE_LIMITER_MINUTE: RateLimit;

  // Environment variables
  ENVIRONMENT: 'development' | 'staging' | 'production';
  ALLOWED_ORIGINS?: string;

  // API Key for authentication (shared with sso-worker's EMAIL_API_KEY)
  EMAIL_API_KEY: string;

  // AWS SES credentials (shared across all websites)
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_REGION: string;

  // Default from address
  DEFAULT_FROM_EMAIL: string;
  DEFAULT_FROM_NAME: string;

  // MessageCentral OTP credentials
  MESSAGECENTRAL_CUSTOMER_ID: string;
  MESSAGECENTRAL_KEY: string;
  MESSAGECENTRAL_EMAIL: string;
  MESSAGECENTRAL_COUNTRY_CODE?: string;
}

// ==================== CONFIG ====================

export interface EmailConfig {
  aws: {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    configurationSet?: string;
  };
  defaultFrom: {
    email: string;
    name: string;
  };
  rateLimit: {
    perMinute: number;
    perHour: number;
    perDay: number;
  };
}

// ==================== OTP TYPES ====================

export interface SendOTPRequest {
  mobileNumber: string;
  countryCode?: string;
  flowType?: 'SMS' | 'WHATSAPP' | 'RCS';
}

export interface SendOTPResponse {
  success: boolean;
  verificationId?: string;
  timeout?: string;
  message?: string;
  error?: string;
  retryAfter?: number;
}

export interface VerifyOTPRequest {
  mobileNumber: string;
  verificationId: string;
  code: string;
  countryCode?: string;
}

export interface VerifyOTPResponse {
  success: boolean;
  verified: boolean;
  message?: string;
  error?: string;
  retryAfter?: number;
}

export interface MessageCentralAuthResponse {
  responseCode: number;
  message: string;
  token?: string;
}

export interface MessageCentralSendResponse {
  responseCode: number;
  message: string;
  data?: {
    verificationId: string;
    mobileNumber: string;
    responseCode: string;
    errorMessage: string | null;
    timeout: string;
  };
}

export interface MessageCentralVerifyResponse {
  responseCode: number;
  message: string;
  data?: {
    verificationId: string;
    mobileNumber: string;
    verificationStatus: string;
    responseCode: string;
    errorMessage: string | null;
  };
}

// ==================== REQUEST/RESPONSE ====================

export interface SendEmailRequest {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  fromName?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  metadata?: Record<string, unknown>;
}

export interface SendEmailResponse {
  success: boolean;
  messageId?: string;
  customMessageId?: string;
  recipient?: string | string[];
  timestamp?: string;
  error?: string;
  errorCode?: string;
  errorType?: string;
  shouldRetry?: boolean;
}

export interface HealthResponse {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  version: string;
  checks: {
    aws: { status: 'ok' | 'error'; message?: string };
    kv: { status: 'ok' | 'error'; message?: string };
    rateLimit: { status: 'ok' | 'error'; message?: string };
  };
}

// ==================== INTERNAL TYPES ====================

export interface EmailMessage {
  to: string[];
  from: {
    email: string;
    name: string;
  };
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
  cc?: string[];
  bcc?: string[];
  metadata?: Record<string, unknown>;
  messageId?: string;
}

export interface ProviderResponse {
  success: boolean;
  messageId?: string;
  customMessageId?: string;
  error?: string;
  errorType?: 'permanent' | 'temporary' | 'unknown';
  shouldRetry?: boolean;
}

export interface RateLimitInfo {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: Date;
  retryAfter?: number;
  hourlyRemaining?: number;
  dailyRemaining?: number;
}

// ==================== ERROR TYPES ====================

export class EmailWorkerError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: any
  ) {
    super(message);
    this.name = 'EmailWorkerError';
  }
}

export class AuthenticationError extends EmailWorkerError {
  constructor(message: string = 'Invalid API key') {
    super(message, 'AUTH_ERROR', 401);
    this.name = 'AuthenticationError';
  }
}

export class RateLimitError extends EmailWorkerError {
  constructor(message: string = 'Rate limit exceeded', public retryAfter: number) {
    super(message, 'RATE_LIMIT_ERROR', 429, { retryAfter });
    this.name = 'RateLimitError';
  }
}

export class ValidationError extends EmailWorkerError {
  constructor(message: string, details?: any) {
    super(message, 'VALIDATION_ERROR', 400, details);
    this.name = 'ValidationError';
  }
}

export class ProviderError extends EmailWorkerError {
  constructor(
    message: string,
    public shouldRetry: boolean = false,
    code: string = 'PROVIDER_ERROR',
    statusCode: number = 500,
    details?: any
  ) {
    super(message, code, statusCode, details);
    this.name = 'ProviderError';
  }
}

export class OTPError extends EmailWorkerError {
  constructor(
    message: string,
    code: string = 'OTP_ERROR',
    statusCode: number = 400,
    details?: any
  ) {
    super(message, code, statusCode, details);
    this.name = 'OTPError';
  }
}
