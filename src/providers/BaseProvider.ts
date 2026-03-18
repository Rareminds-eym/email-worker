/**
 * Base email provider interface
 */

import type { EmailMessage, ProviderResponse } from '../types';

export abstract class BaseProvider {
  abstract readonly type: string;

  /**
   * Send an email
   */
  abstract send(message: EmailMessage): Promise<ProviderResponse>;

  /**
   * Test provider connection
   */
  abstract testConnection(): Promise<boolean>;

  /**
   * Classify error type for retry logic
   */
  protected classifyError(error: any): 'permanent' | 'temporary' | 'unknown' {
    if (error && error.name === 'ProviderError' && typeof error.statusCode === 'number') {
      const { statusCode } = error;
      if (statusCode === 400 || statusCode === 401 || statusCode === 403 || statusCode === 404) {
        return 'permanent';
      }
      if (statusCode === 429 || statusCode >= 500) {
        return 'temporary';
      }
    }

    const errorMessage = (error?.message || '').toLowerCase();

    // Permanent failures (don't retry)
    if (
      errorMessage.includes('invalid email') ||
      errorMessage.includes('mailbox not found') ||
      errorMessage.includes('user unknown') ||
      errorMessage.includes('address rejected') ||
      errorMessage.includes('does not exist') ||
      errorMessage.includes('recipient rejected')
    ) {
      return 'permanent';
    }

    // Temporary failures (retry)
    if (
      errorMessage.includes('timeout') ||
      errorMessage.includes('connection') ||
      errorMessage.includes('network') ||
      errorMessage.includes('temporarily') ||
      errorMessage.includes('rate limit') ||
      errorMessage.includes('quota') ||
      errorMessage.includes('try again')
    ) {
      return 'temporary';
    }

    return 'unknown';
  }
}
