/**
 * GET /health - Health check endpoint
 */

import type { Env, HealthResponse } from '../types';
import { VERSION } from '../constants';

export async function handleHealth(
  request: Request,
  env: Env
): Promise<Response> {
  const response: HealthResponse = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: VERSION,
  };
  
  return Response.json(response, { status: 200 });
}
