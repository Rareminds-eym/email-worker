/**
 * Email sending engine
 */

import type { SendEmailRequest, EmailMessage, ProviderResponse, EmailConfig } from '../types';
import { SESProvider } from '../providers/SESProvider';
import { RETRY } from '../constants';

export class EmailEngine {
  private provider: SESProvider;

  constructor(private config: EmailConfig) {
    this.provider = new SESProvider(config);
  }

  async send(request: SendEmailRequest): Promise<ProviderResponse> {
    const message = this.buildMessage(request);

    // Generate globally unique Message-ID aligned with the sending domain (RFC 5322 section 3.6.4)
    const fromDomain = message.from.email.split('@')[1] || 'email.rareminds.in';
    message.messageId = `<${crypto.randomUUID()}@${fromDomain}>`;

    let lastResponse: ProviderResponse | undefined;

    for (let attempt = 0; attempt < RETRY.MAX_ATTEMPTS; attempt++) {
      lastResponse = await this.provider.send(message);
      lastResponse.customMessageId = message.messageId;

      if (lastResponse.success || !lastResponse.shouldRetry) {
        return lastResponse;
      }

      if (attempt < RETRY.MAX_ATTEMPTS - 1) {
        const baseDelay = Math.min(
          RETRY.INITIAL_DELAY_MS * Math.pow(RETRY.BACKOFF_MULTIPLIER, attempt),
          RETRY.MAX_DELAY_MS
        );
        const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
        const jitteredDelay = Math.max(0, baseDelay + jitter);
        await new Promise(resolve => setTimeout(resolve, jitteredDelay));
      }
    }

    if (!lastResponse) {
      return { success: false, error: 'No send attempts made', errorType: 'unknown', shouldRetry: false };
    }

    return lastResponse;
  }

  private buildMessage(request: SendEmailRequest): EmailMessage {
    return {
      to: Array.isArray(request.to) ? request.to : [request.to],
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
