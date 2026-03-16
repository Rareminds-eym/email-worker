/**
 * Email sending engine
 */

import type { SendEmailRequest, EmailMessage, ProviderResponse, EmailConfig } from '../types';
import { SESProvider } from '../providers/SESProvider';
import { RETRY } from '../constants';

export class EmailEngine {
  private provider: SESProvider;
  private retryTestMode: boolean = false;
  private retryTestSucceedOnAttempt: number = 2; // Succeed on 2nd attempt (0-indexed: attempt 1)
  
  constructor(private config: EmailConfig) {
    this.provider = new SESProvider(config);
  }
  
  /**
   * Enable retry test mode - simulates failures until specified attempt
   * @param succeedOnAttempt - Which attempt should succeed (1-based: 1=first, 2=second, 3=third/last)
   */
  enableRetryTestMode(succeedOnAttempt: number = 2) {
    this.retryTestMode = true;
    this.retryTestSucceedOnAttempt = succeedOnAttempt;
  }
  
  disableRetryTestMode() {
    this.retryTestMode = false;
  }
  
  async send(request: SendEmailRequest): Promise<ProviderResponse> {
    const message = this.buildMessage(request);
    let lastResponse: ProviderResponse | undefined;

    for (let attempt = 0; attempt < RETRY.MAX_ATTEMPTS; attempt++) {
      lastResponse = await this.provider.send(message);

      if (lastResponse.success || !lastResponse.shouldRetry) {
        return lastResponse;
      }

      if (attempt < RETRY.MAX_ATTEMPTS - 1) {
        const delay = Math.min(
          RETRY.INITIAL_DELAY_MS * Math.pow(RETRY.BACKOFF_MULTIPLIER, attempt),
          RETRY.MAX_DELAY_MS
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    return lastResponse!;
  }
  
  private buildMessage(request: SendEmailRequest): EmailMessage {
    const toList = Array.isArray(request.to) ? request.to : [request.to];
    
    return {
      to: toList,
      from: {
        email: request.from || this.config.defaultFrom.email,
        name: request.fromName || this.config.defaultFrom.name,
      },
      replyTo: request.replyTo,
      subject: request.subject,
      html: request.html,
      text: request.text,
      cc: request.cc,
      bcc: request.bcc,
      metadata: request.metadata,
    };
  }
}
