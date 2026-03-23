/**
 * Email service configuration
 */

import type { Env, EmailConfig } from '../types';
import { RATE_LIMITS, EMAIL_REGEX } from '../constants';

export function getEmailConfig(env: Env): EmailConfig {
  // Validate required AWS environment variables — fail fast, fail loud
  const requiredVars = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'] as const;
  for (const varName of requiredVars) {
    if (!env[varName]) {
      throw new Error(`Missing required environment variable: ${varName}`);
    }
  }

  if (!env.DEFAULT_FROM_EMAIL || !env.DEFAULT_FROM_NAME) {
    throw new Error('Missing required: DEFAULT_FROM_EMAIL, DEFAULT_FROM_NAME');
  }

  // Validate DEFAULT_FROM_EMAIL format to guarantee the invariant required by EmailEngine
  // 
  // INVARIANT ENFORCEMENT:
  // EmailEngine.ts line 20 uses: `message.from.email.split('@')[1]`
  // This assumes the email contains exactly one '@' symbol and a non-empty domain.
  // 
  // User-provided emails are validated by validateEmail() in validator.ts, which uses
  // EMAIL_REGEX to guarantee this invariant. However, DEFAULT_FROM_EMAIL comes from
  // environment variables and bypasses that validation.
  // 
  // FAIL-FAST PRINCIPLE:
  // Validating at startup (not runtime) ensures:
  //   1. Application won't start with invalid configuration
  //   2. Clear error message points to the exact problem
  //   3. Prevents runtime errors deep in the call stack
  //   4. Easier debugging - error at source, not symptom
  // 
  // ATTACK SCENARIOS PREVENTED:
  //   - Missing '@': "noreply-domain.com" → split('@')[1] = undefined → wrong domain
  //   - Multiple '@': "user@staging@domain.com" → split('@')[1] = "staging" → invalid domain
  //   - Empty domain: "user@" → split('@')[1] = "" → wrong domain
  // 
  // References:
  //   - Defensive programming: https://typescript.tv/best-practices/avoid-errors-with-defensive-coding-in-typescript/
  //   - Fail-fast validation: https://dev.to/schead/ensuring-environment-variable-integrity-with-zod-in-typescript-3di5
  if (!EMAIL_REGEX.test(env.DEFAULT_FROM_EMAIL)) {
    throw new Error(
      `Invalid DEFAULT_FROM_EMAIL format: "${env.DEFAULT_FROM_EMAIL}". ` +
      `Must be a valid email address with exactly one @ symbol (e.g., noreply@example.com). ` +
      `This ensures the email can be safely split to extract the domain for Message-ID generation.`
    );
  }

  return {
    aws: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.AWS_REGION,
      configurationSet: (env as any).SES_CONFIGURATION_SET,
    },
    defaultFrom: {
      email: env.DEFAULT_FROM_EMAIL || 'noreply@rareminds.in',
      name: env.DEFAULT_FROM_NAME || 'Skill Passport',
    },
    rateLimit: {
      perMinute: 60,
      perHour: 0,  // Not enforced - Cloudflare limitation
      perDay: 0,   // Not enforced - Cloudflare limitation
    },
  };
}
