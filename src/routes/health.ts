/**
 * GET /health - Health check endpoint
 */

import type { Env, HealthResponse } from '../types';
import { VERSION } from '../constants';

export async function handleHealth(request: Request, env: Env): Promise<Response> {
  return Response.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: VERSION,
  }, { status: 200 });
}

export async function handleInternalHealth(
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
      return { status: 'error' };
    }
    return { status: 'ok' };
  } catch (error) {
    return { status: 'error' };
  }
}

async function checkKVStore(env: Env): Promise<{ status: 'ok' | 'error'; message?: string }> {
  try {
    if (!env.RATE_LIMIT_KV) {
      return { status: 'error' };
    }
    return { status: 'ok' };
  } catch (error) {
    return { status: 'error' };
  }
}

async function checkRateLimiter(env: Env): Promise<{ status: 'ok' | 'error'; message?: string }> {
  try {
    if (!env.RATE_LIMITER_MINUTE) {
      return { status: 'error' };
    }
    return { status: 'ok' };
  } catch (error) {
    return { status: 'error' };
  }
}
