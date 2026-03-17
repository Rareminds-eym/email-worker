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
      
      // Build raw email with Message-ID header
      const rawEmail = this.buildRawEmail(message);
      
      // Convert to base64 using native TextEncoder and btoa
      const encoder = new TextEncoder();
      const data = encoder.encode(rawEmail);
      let binary = '';
      for (let i = 0; i < data.length; i++) {
        binary += String.fromCharCode(data[i]);
      }
      const base64 = btoa(binary);
      
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
          Content: {
            Raw: {
              Data: base64,
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

  private buildRawEmail(message: EmailMessage): string {
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    const date = new Date().toUTCString();
    
    // Build headers
    const headers: string[] = [
      `From: ${message.from.name} <${message.from.email}>`,
      `To: ${message.to.join(', ')}`,
      `Subject: ${message.subject}`,
      `Date: ${date}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ];
    
    // Add Message-ID if present
    if (message.messageId) {
      headers.push(`Message-ID: ${message.messageId}`);
    }
    
    // Add optional headers
    if (message.replyTo) {
      headers.push(`Reply-To: ${message.replyTo}`);
    }
    
    if (message.cc && message.cc.length > 0) {
      headers.push(`Cc: ${message.cc.join(', ')}`);
    }
    
    // Build body parts
    const textPart = message.text || message.html.replace(/<[^>]*>/g, '');
    
    const parts: string[] = [
      headers.join('\r\n'),
      '',
      `--${boundary}`,
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: 8bit`,
      '',
      textPart,
      '',
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: 8bit`,
      '',
      message.html,
      '',
      `--${boundary}--`,
    ];
    
    return parts.join('\r\n');
  }
}
