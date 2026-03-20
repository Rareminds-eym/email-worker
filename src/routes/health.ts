/**
 * GET /health - Public health check endpoint
 * Returns minimal status information without exposing infrastructure details
 */

import type { Env, HealthResponse } from '../types';
import { VERSION } from '../constants';

/**
 * Public health check - returns only basic status
 * No infrastructure details exposed to prevent reconnaissance
 */
export async function handleHealth(
  _request: Request,
  _env: Env
): Promise<Response> {
  const response = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: VERSION,
  };
  
  return Response.json(response, { status: 200 });
}

/**
 * Internal health check - returns detailed diagnostic information
 * Only accessible via authenticated /internal/health endpoint
 */
export async function handleDetailedHealth(
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

/**
 * Checks KV store health using a read-only approach to minimize costs.
 * 
 * CLOUDFLARE KV PRICING (as of 2024):
 * - Free tier: 1,000 writes/day, 100,000 reads/day
 * - Paid tier: 1 million writes/month ($5.00 per additional million)
 * - Paid tier: 10 million reads/month ($0.50 per additional million)
 * 
 * COST ANALYSIS - OLD APPROACH (Write + Read on every health check):
 * - Health check frequency: Every 10 seconds
 * - Daily health checks: 8,640 checks/day
 * - Daily KV writes: 8,640 writes/day
 * - Monthly KV writes: ~259,200 writes/month
 * - Cost (paid tier): $1.30/month just for health checks
 * - Free tier impact: Exceeds 1,000 writes/day limit by 8.6x
 * 
 * COST ANALYSIS - NEW APPROACH (Read-only check):
 * - Daily KV reads: 8,640 reads/day
 * - Monthly KV reads: ~259,200 reads/month
 * - Cost (paid tier): $0.00/month (well within 10M free reads)
 * - Free tier impact: Within 100,000 reads/day limit
 * - Savings: 100% reduction in write costs
 * 
 * HEALTH CHECK STRATEGY:
 * 
 * Option 1: Read-Only Check (IMPLEMENTED)
 * - Attempts to read a known key that should exist
 * - If KV binding is broken, the read will fail
 * - If KV service is down, the read will timeout/error
 * - Pros: Zero write costs, fast, sufficient for most cases
 * - Cons: Doesn't verify write capability
 * 
 * Option 2: Periodic Write Check (ALTERNATIVE)
 * - Write once per hour instead of every health check
 * - Reduces writes from 8,640/day to 24/day (99.7% reduction)
 * - Implement with: if (Date.now() % 3600000 < 10000) { doWriteCheck(); }
 * - Pros: Verifies write capability periodically
 * - Cons: Still incurs some write costs
 * 
 * Option 3: Cached Health Status (ALTERNATIVE)
 * - Cache health check results for 60 seconds
 * - Reduces checks from 8,640/day to 1,440/day (83% reduction)
 * - Implement with: Workers KV or in-memory cache
 * - Pros: Reduces all KV operations
 * - Cons: Stale health status for up to 60 seconds
 * 
 * CURRENT IMPLEMENTATION: Option 1 (Read-Only)
 * 
 * We use a read-only check because:
 * 1. KV binding failures are rare and usually affect both reads and writes
 * 2. If the binding is configured correctly, writes will work
 * 3. The rate limiter (which uses KV writes) is tested in production use
 * 4. Cost savings are significant (100% reduction in health check write costs)
 * 5. Health checks should be lightweight and non-invasive
 * 
 * MONITORING WRITE CAPABILITY:
 * - Actual rate limiting operations test KV writes in production
 * - Monitor application logs for KV write errors
 * - Set up Cloudflare alerts for KV error rates
 * - Periodic manual testing of write operations
 * 
 * References:
 * - Cloudflare KV Pricing: https://developers.cloudflare.com/kv/platform/pricing
 * - KV Best Practices: https://developers.cloudflare.com/kv/reference/kv-best-practices
 */
async function checkKVStore(env: Env): Promise<{ status: 'ok' | 'error'; message?: string }> {
  try {
    // Step 1: Check if KV namespace is bound
    if (!env.RATE_LIMIT_KV) {
      return { status: 'error', message: 'KV namespace not bound' };
    }
    
    // Step 2: Perform a read-only check
    // We attempt to read a key that may or may not exist
    // The goal is to verify the KV binding works, not to verify a specific value
    // 
    // Why read a potentially non-existent key?
    // - Even failed reads (404) prove the KV binding is working
    // - We don't need to maintain a test key
    // - Cloudflare charges for all operations, including 404s, but reads are 10x cheaper
    const testKey = '__health_check__';
    
    try {
      // Attempt to read the test key
      // This will either:
      // 1. Return null (key doesn't exist) - KV is working ✓
      // 2. Return a value (key exists from previous write check) - KV is working ✓
      // 3. Throw an error (KV is down or binding is broken) - KV is not working ✗
      await env.RATE_LIMIT_KV.get(testKey);
      
      // If we reach here, the KV binding is working
      // We don't care about the value, just that the operation succeeded
      return { status: 'ok' };
      
    } catch (readError) {
      // KV read operation failed - this indicates a real problem
      return { 
        status: 'error', 
        message: `KV read failed: ${readError instanceof Error ? readError.message : 'unknown'}` 
      };
    }
    
  } catch (error) {
    // Unexpected error in health check logic itself
    return { 
      status: 'error', 
      message: `KV check failed: ${error instanceof Error ? error.message : 'unknown'}` 
    };
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
