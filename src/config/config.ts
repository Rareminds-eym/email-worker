/**
 * Email service configuration
 */

import type { Env, EmailConfig } from '../types';
import { RATE_LIMITS } from '../constants';

export function getEmailConfig(env: Env): EmailConfig {
  // Validate required AWS environment variables — fail fast, fail loud
  const requiredVars = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'] as const;
  for (const varName of requiredVars) {
    if (!env[varName]) {
      throw new Error(`Missing required environment variable: ${varName}`);
    }
  }

  return {
    aws: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.AWS_REGION,
    },
    defaultFrom: {
      email: env.DEFAULT_FROM_EMAIL || 'noreply@rareminds.in',
      name: env.DEFAULT_FROM_NAME || 'Skill Passport',
    },
    rateLimit: {
      perMinute: 60,
      perHour: 1000,
      perDay: 10000,
    },
  };
}
