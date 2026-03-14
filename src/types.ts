/**
 * Core type definitions for Shared Email API Worker
 */

/// <reference types="@cloudflare/workers-types" />

// ==================== ENVIRONMENT ====================

export interface Env {
  // KV Namespaces
  RATE_LIMIT_KV: KVNamespace;
  RATE_LIMITER_MINUTE: RateLimit;
  
  // Environment variables
  ENVIRONMENT: 'development' | 'staging' | 'production';
  
  // API Key for authentication
  API_KEY: string;
  
  // AWS SES credentials (shared across all websites)
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_REGION: string;
  
  // Default from address
  DEFAULT_FROM_EMAIL: string;
  DEFAULT_FROM_NAME: string;
}

// ==================== CONFIG ====================

export interface EmailConfig {
  aws: {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
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
  metadata?: Record<string, any>;
}

export interface EmailAttachment {
  filename: string;
  content: string; // Base64 encoded
  contentType: string;
}

export interface SendEmailResponse {
  success: boolean;
  messageId?: string;
  recipient?: string | string[];
  timestamp?: string;
  error?: string;
  errorCode?: string;
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
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
  attachments?: EmailAttachment[];
  metadata?: Record<string, any>;
}

export interface ProviderResponse {
  success: boolean;
  messageId?: string;
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
  constructor(message: string, public shouldRetry: boolean = false) {
    super(message, 'PROVIDER_ERROR', 500);
    this.name = 'ProviderError';
  }
}
