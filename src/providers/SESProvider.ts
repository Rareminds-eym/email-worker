/**
 * AWS SES email provider
 */

import { AwsClient } from 'aws4fetch';
import type { EmailMessage, ProviderResponse, EmailConfig } from '../types';
import { BaseProvider } from './BaseProvider';

export class SESProvider extends BaseProvider {
  readonly type = 'ses';
  private aws: AwsClient;
  
  constructor(private config: EmailConfig) {
    super();
    // 'service' must be set explicitly — aws4fetch infers 'email' from the
    // hostname (email.{region}.amazonaws.com) but AWS SES signing requires 'ses'.
    this.aws = new AwsClient({
      accessKeyId: this.config.aws.accessKeyId,
      secretAccessKey: this.config.aws.secretAccessKey,
      region: this.config.aws.region,
      service: 'ses',
    });
  }
  
  async send(message: EmailMessage): Promise<ProviderResponse> {
    try {
      const sesEndpoint = `https://email.${this.config.aws.region}.amazonaws.com/v2/email/outbound-emails`;
      
      const response = await this.aws.fetch(sesEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          Destination: {
            ToAddresses: message.to,
            CcAddresses: message.cc || [],
            BccAddresses: message.bcc || [],
          },
          FromEmailAddress: `${message.from.name} <${message.from.email}>`,
          ReplyToAddresses: message.replyTo ? [message.replyTo] : [],
          Content: {
            Simple: {
              Subject: {
                Data: message.subject,
              },
              Body: {
                Html: {
                  Data: message.html,
                },
                Text: {
                  Data: message.text || message.html.replace(/<[^>]*>/g, ''),
                },
              },
            },
          },
        }),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`SES API error: ${response.status} ${response.statusText} - ${errorText}`);
      }
      
      const result = await response.json() as { MessageId: string };
      
      return {
        success: true,
        messageId: result.MessageId,
      };
    } catch (error: any) {
      const errorType = this.classifyError(error);
      
      return {
        success: false,
        error: error.message,
        errorType,
        shouldRetry: errorType !== 'permanent',
      };
    }
  }
  
  async testConnection(): Promise<boolean> {
    return true;
  }
}
