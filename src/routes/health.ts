/**
 * GET /health - Health check endpoint
 */

import type { Env, HealthResponse } from '../types';
import { VERSION } from '../constants';

export async function handleHealth(
  request: Request,
  env: Env
): Promise<Response> {
  const checks = {
    aws: await checkAWSCredentials(env),
    kv: await checkKVStore(env),
    rateLimit: await checkRateLimiter(env),
  };

  const hasErrors = Object.values(checks).some(check => check.status === 'error');
  const status = hasErrors ? 'unhealthy' : 'healthy';
  const httpStatus = hasErrors ? 503 : 200;

  const response: HealthResponse = {
    status,
    timestamp: new Date().toISOString(),
    version: VERSION,
    checks,
  };
  
  return Response.json(response, { status: httpStatus });
}

async function checkAWSCredentials(env: Env): Promise<{ status: 'ok' | 'error'; message?: string }> {
  try {
    if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.AWS_REGION) {
      return { status: 'error', message: 'Missing AWS credentials' };
    }
    
    if (env.AWS_ACCESS_KEY_ID.length < 16 || env.AWS_SECRET_ACCESS_KEY.length < 20) {
      return { status: 'error', message: 'Invalid AWS credential format' };
    }
    
    return { status: 'ok' };
  } catch (error) {
    return { status: 'error', message: 'AWS credential check failed' };
  }
}

async function checkKVStore(env: Env): Promise<{ status: 'ok' | 'error'; message?: string }> {
  try {
    if (!env.RATE_LIMIT_KV) {
      return { status: 'error', message: 'KV namespace not bound' };
    }
    
    const testKey = '__health_check__';
    const testValue = Date.now().toString();
    await env.RATE_LIMIT_KV.put(testKey, testValue, { expirationTtl: 60 });
    const retrieved = await env.RATE_LIMIT_KV.get(testKey);
    
    if (retrieved !== testValue) {
      return { status: 'error', message: 'KV read/write mismatch' };
    }
    
    return { status: 'ok' };
  } catch (error) {
    return { status: 'error', message: `KV check failed: ${error instanceof Error ? error.message : 'unknown'}` };
  }
}

async function checkRateLimiter(env: Env): Promise<{ status: 'ok' | 'error'; message?: string }> {
  try {
    if (!env.RATE_LIMITER_MINUTE) {
      return { status: 'error', message: 'Rate limiter not bound' };
    }
    
    return { status: 'ok' };
  } catch (error) {
    return { status: 'error', message: 'Rate limiter check failed' };
  }
}
