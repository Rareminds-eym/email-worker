/**
 * Email sending engine
 */

import type { SendEmailRequest, EmailMessage, ProviderResponse, EmailConfig } from '../types';
import { SESProvider } from '../providers/SESProvider';

export class EmailEngine {
  private provider: SESProvider;
  
  constructor(private config: EmailConfig) {
    this.provider = new SESProvider(config);
  }
  
  async send(request: SendEmailRequest): Promise<ProviderResponse> {
    const message = this.buildMessage(request);
    return await this.provider.send(message);
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
