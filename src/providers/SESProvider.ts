/**
 * AWS SES email provider
 */

import { Buffer } from 'node:buffer';
import { AwsClient } from 'aws4fetch';
import { EmailMessage, ProviderResponse, ProviderError, EmailConfig } from '../types';
import { BaseProvider } from './BaseProvider';
import { TIMEOUTS } from '../constants';

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
      
      // Convert to base64 properly for UTF-8 content
      // Using the MDN-recommended approach for handling Unicode in base64 encoding
      // Reference: https://developer.mozilla.org/en-US/docs/Glossary/Base64#the_unicode_problem
      const base64 = this.base64EncodeUTF8(rawEmail);
      
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
          FromEmailAddress: message.from.email,
          ...(this.config.aws.configurationSet ? { ConfigurationSetName: this.config.aws.configurationSet } : {}),
          Content: {
            Raw: {
              Data: base64,
            },
          },
        }),
        signal: AbortSignal.timeout(TIMEOUTS.EMAIL_SEND),
      });

      if (!response.ok) {
        const errorText = await response.text();
        // ProviderError signature: (message, shouldRetry, code, statusCode, details)
        const isTemporary = response.status === 429 || response.status >= 500;
        throw new ProviderError(`SES API error: ${response.statusText} - ${errorText}`, isTemporary, 'PROVIDER_API_ERROR', response.status);
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
    try {
      const response = await this.aws.fetch(`https://email.${this.config.aws.region}.amazonaws.com/v2/email/account`, {
        method: 'GET',
        signal: (globalThis as any).AbortSignal.timeout(TIMEOUTS.SMTP_CONNECTION),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Encodes a UTF-8 string to base64, properly handling multi-byte characters.
   * 
   * CRITICAL: JavaScript's btoa() only works with Latin-1 (single-byte) characters.
   * For UTF-8 content (which can have multi-byte characters), we must:
   * 1. Encode the string to UTF-8 bytes using TextEncoder
   * 2. Convert each byte to a character code (0-255 range)
   * 3. Pass the resulting binary string to btoa()
   * 
   * STACK OVERFLOW PROTECTION:
   * The spread operator (...array) with String.fromCharCode/fromCodePoint has a
   * maximum argument limit in JavaScript engines:
   *   - V8 (Chrome, Node, Cloudflare Workers): ~65,536 arguments
   *   - WebKit (Safari): 65,536 arguments (hard limit)
   *   - SpiderMonkey (Firefox): ~500,000 arguments
   * 
   * For emails > 65KB, spreading the entire byte array would cause:
   *   RangeError: Maximum call stack size exceeded
   * 
   * SOLUTION: Process bytes in 32KB chunks (32,768 bytes per chunk).
   * This ensures we stay well within the 65,536 argument limit across all engines.
   * 
   * PERFORMANCE OPTIMIZATION:
   * - Uses subarray() instead of slice() to avoid memory copying
   * - subarray() creates a view over the original buffer (zero-copy)
   * - slice() would create a new copy of the data (expensive for large emails)
   * 
   * WHY String.fromCharCode vs String.fromCodePoint?
   * - fromCharCode: Treats each argument as a 16-bit code unit (0-65535)
   * - fromCodePoint: Treats each argument as a Unicode code point (0-1114111)
   * 
   * For binary data (bytes 0-255), both work identically, but fromCharCode is
   * slightly faster because it doesn't need to handle surrogate pairs.
   * 
   * References:
   * - MDN Base64 Unicode Problem: https://developer.mozilla.org/en-US/docs/Glossary/Base64#the_unicode_problem
   * - WebKit Bug 80797: https://webkit.org/b/80797 (65536 argument limit)
   * - Stack Overflow: https://stackoverflow.com/q/38432611 (real-world example)
   * 
   * @param str - UTF-8 string to encode (can contain emojis, Chinese characters, etc.)
   * @returns Base64-encoded string safe for AWS SES Raw email API
   */
  private base64EncodeUTF8(str: string): string {
    const encoder = new TextEncoder();
    const utf8Bytes = encoder.encode(str);
    
    // CRITICAL: Process in chunks to avoid stack overflow
    // 32KB chunks = 32,768 bytes, well under the 65,536 argument limit
    const CHUNK_SIZE = 32768;
    
    let binaryString = '';
    for (let i = 0; i < utf8Bytes.length; i += CHUNK_SIZE) {
      // Use subarray (not slice) to avoid copying - creates a view over original buffer
      const chunk = utf8Bytes.subarray(i, i + CHUNK_SIZE);
      // Use fromCharCode for binary data (bytes 0-255) - faster than fromCodePoint
      binaryString += String.fromCharCode(...chunk);
    }
    return btoa(binaryString);
  }

  private sanitizeHeader(value: string): string {
    return value.replace(/[\r\n,<>]/g, '');
  }

  /**
   * Validates and formats a Message-ID according to RFC 5322 §3.6.4.
   * 
   * RFC 5322 §3.6.4 defines Message-ID syntax as:
   *   msg-id = [CFWS] "<" id-left "@" id-right ">" [CFWS]
   *   id-left = dot-atom-text
   *   id-right = dot-atom-text / no-fold-literal
   *   dot-atom-text = 1*atext *("." 1*atext)
   * 
   * SECURITY VALIDATION (Defense in Depth):
   * This method implements multiple layers of validation to prevent:
   *   1. CRLF Injection attacks
   *   2. Header injection via angle brackets
   *   3. Email routing confusion via multiple @ symbols
   *   4. RFC 5322 syntax violations
   * 
   * VALIDATION STEPS:
   * 
   * Step 1: CRLF Injection Prevention
   *   - Strips \r and \n characters
   *   - Prevents: "id@domain\r\nBcc: attacker@evil.com"
   *   - Impact: Would add unauthorized recipients to email
   * 
   * Step 2: Angle Bracket Handling
   *   - If input has angle brackets, extract the content inside
   *   - If no angle brackets, use the raw value
   *   - Prevents: "id@domain>Bcc: attacker@evil.com<fake"
   * 
   * Step 3: Whitespace Validation
   *   - RFC 5322 msg-id MUST NOT contain spaces or tabs
   *   - Spaces break email threading and parsing
   *   - Rejects: "id @domain" or "id@ domain"
   * 
   * Step 4: @ Symbol Validation
   *   - Must contain exactly one @ symbol
   *   - Separates id-left from id-right per RFC 5322
   *   - Rejects: "iddomain" (no @) or "id@domain@example" (multiple @)
   * 
   * Step 5: Angle Bracket Injection Prevention
   *   - The ID itself (without wrapping brackets) must not contain < or >
   *   - Prevents: "id<injection>@domain" or "id@domain>injection"
   *   - These would break RFC 5322 parsing
   * 
   * Step 6: Quote and Backslash Validation
   *   - Message-IDs must not contain quotes or backslashes
   *   - These characters have special meaning in RFC 5322
   *   - Rejects: 'id"quote"@domain' or 'id\\backslash@domain'
   * 
   * Step 7: RFC 5322 Character Set Validation
   *   - id-left and id-right must use only allowed characters
   *   - Allowed: A-Z, a-z, 0-9, and ! # $ % & ' * + - / = ? ^ _ ` { | } ~ .
   *   - Rejects: "id with spaces@domain" or "id[brackets]@domain"
   * 
   * GMAIL REQUIREMENT:
   * Gmail specifically requires angle brackets around Message-ID values.
   * Messages without angle brackets may be rejected or have the header rewritten.
   * Reference: https://www.spamresource.com/2025/06/gmail-says-yes-to-angle-brackets-in.html
   * 
   * EXAMPLES:
   *   Input: "550e8400-e29b-41d4-a716-446655440000@email.rareminds.in"
   *   Output: "<550e8400-e29b-41d4-a716-446655440000@email.rareminds.in>"
   * 
   *   Input: "<abc123@example.com>"
   *   Output: "<abc123@example.com>"
   * 
   *   Input: "id@domain\r\nBcc: attacker@evil.com"
   *   Throws: Error (CRLF injection attempt)
   * 
   *   Input: "id with spaces@domain"
   *   Throws: Error (whitespace not allowed)
   * 
   *   Input: "id@domain@example.com"
   *   Throws: Error (multiple @ symbols)
   * 
   * @param messageId - Raw Message-ID value (with or without angle brackets)
   * @returns RFC 5322 compliant Message-ID with angle brackets
   * @throws Error if Message-ID violates RFC 5322 or contains injection attempts
   */
  private validateMessageId(messageId: string): string {
    // Step 1: Strip CRLF characters (security - prevent header injection)
    const sanitized = messageId.replace(/[\r\n]/g, '');
    
    // Step 2: Extract content from angle brackets if present
    // If input is "<id@domain>", extract "id@domain"
    // If input is "id@domain", use as-is
    let idContent: string;
    if (sanitized.startsWith('<') && sanitized.endsWith('>')) {
      idContent = sanitized.slice(1, -1);
    } else if (sanitized.startsWith('<') || sanitized.endsWith('>')) {
      // Mismatched angle brackets - invalid format
      throw new Error(
        `Invalid Message-ID format: mismatched angle brackets. ` +
        `Must be either "<id@domain>" or "id@domain", got: "${sanitized}"`
      );
    } else {
      idContent = sanitized;
    }
    
    // Step 3: Validate no whitespace (spaces, tabs, etc.)
    // RFC 5322 msg-id syntax does not allow whitespace
    if (/\s/.test(idContent)) {
      throw new Error(
        `Invalid Message-ID format: must not contain whitespace. ` +
        `Got: "${idContent}"`
      );
    }
    
    // Step 4: Validate exactly one @ symbol
    // RFC 5322 requires: id-left "@" id-right
    const atCount = (idContent.match(/@/g) || []).length;
    if (atCount === 0) {
      throw new Error(
        `Invalid Message-ID format: must contain @ symbol (format: id@domain). ` +
        `Got: "${idContent}"`
      );
    }
    if (atCount > 1) {
      throw new Error(
        `Invalid Message-ID format: must contain exactly one @ symbol. ` +
        `Got ${atCount} @ symbols in: "${idContent}"`
      );
    }
    
    // Step 5: Validate no angle brackets in the ID content
    // Angle brackets are only allowed as outer delimiters, not inside the ID
    if (idContent.includes('<') || idContent.includes('>')) {
      throw new Error(
        `Invalid Message-ID format: angle brackets not allowed inside Message-ID. ` +
        `Got: "${idContent}"`
      );
    }
    
    // Step 6: Validate no quotes or backslashes
    // These have special meaning in RFC 5322 and are not allowed in msg-id
    if (idContent.includes('"') || idContent.includes('\\')) {
      throw new Error(
        `Invalid Message-ID format: quotes and backslashes not allowed. ` +
        `Got: "${idContent}"`
      );
    }
    
    // Step 7: Validate RFC 5322 character set
    // id-left and id-right must use only: A-Z a-z 0-9 ! # $ % & ' * + - / = ? ^ _ ` { | } ~ .
    // This regex matches the dot-atom-text production from RFC 5322
    const [idLeft, idRight] = idContent.split('@');
    const validCharPattern = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+$/;
    
    if (!validCharPattern.test(idLeft)) {
      throw new Error(
        `Invalid Message-ID format: id-left contains invalid characters. ` +
        `Allowed: A-Z a-z 0-9 ! # $ % & ' * + - / = ? ^ _ \` { | } ~ . ` +
        `Got: "${idLeft}"`
      );
    }
    
    if (!validCharPattern.test(idRight)) {
      throw new Error(
        `Invalid Message-ID format: id-right contains invalid characters. ` +
        `Allowed: A-Z a-z 0-9 ! # $ % & ' * + - / = ? ^ _ \` { | } ~ . ` +
        `Got: "${idRight}"`
      );
    }
    
    // Step 8: Additional validation - id-left and id-right must not be empty
    if (idLeft.length === 0 || idRight.length === 0) {
      throw new Error(
        `Invalid Message-ID format: both id-left and id-right must be non-empty. ` +
        `Got: "${idContent}"`
      );
    }
    
    // Step 9: Additional validation - must not start or end with a dot
    // RFC 5322 dot-atom-text: 1*atext *("." 1*atext)
    // This means dots can only appear between atext characters, not at edges
    if (idLeft.startsWith('.') || idLeft.endsWith('.')) {
      throw new Error(
        `Invalid Message-ID format: id-left must not start or end with a dot. ` +
        `Got: "${idLeft}"`
      );
    }
    
    if (idRight.startsWith('.') || idRight.endsWith('.')) {
      throw new Error(
        `Invalid Message-ID format: id-right must not start or end with a dot. ` +
        `Got: "${idRight}"`
      );
    }
    
    // Step 10: Additional validation - must not have consecutive dots
    // RFC 5322 dot-atom-text requires at least one atext between dots
    if (idLeft.includes('..') || idRight.includes('..')) {
      throw new Error(
        `Invalid Message-ID format: consecutive dots not allowed. ` +
        `Got: "${idContent}"`
      );
    }
    
    // All validations passed - return with angle brackets per RFC 5322
    return `<${idContent}>`;
  }

  /**
   * Encodes a string using RFC 2047 base64 encoding for email headers.
   * 
   * RFC 2047 is used for encoding non-ASCII text in email headers (Subject, From, etc.)
   * Format: =?charset?encoding?encoded-text?=
   * Example: =?UTF-8?B?SGVsbG8gV29ybGQ=?= (encodes "Hello World")
   * 
   * WHEN TO USE:
   * - Subject lines with emojis, accented characters, or non-Latin scripts
   * - Display names in From/To headers (e.g., "José García" <jose@example.com>)
   * - Any header value containing characters outside printable ASCII (0x20-0x7E)
   * 
   * STACK OVERFLOW PROTECTION:
   * While RFC 2047 is typically used for short strings (subject lines, names),
   * a malicious actor could send a very long subject line (up to 998 chars per RFC 5322).
   * After UTF-8 encoding, this could exceed 65,536 bytes, causing a stack overflow
   * with String.fromCharCode(...array).
   * 
   * SOLUTION: Use a simple loop instead of spread operator for safety.
   * The performance difference is negligible for typical header sizes (<1KB).
   * 
   * References:
   * - RFC 2047: https://www.ietf.org/rfc/rfc2047.txt
   * - RFC 5322 §2.1.1: Header lines should be <998 characters
   * 
   * @param value - Header value to encode (e.g., subject line, display name)
   * @returns RFC 2047 encoded string or original if all ASCII
   */
  private encodeRFC2047(value: string): string {
    const sanitized = this.sanitizeHeader(value);
    
    // If all characters are printable ASCII (0x20-0x7E), no encoding needed
    if (!/[^\x20-\x7E]/.test(sanitized)) {
      return sanitized;
    }
    
    // Encode non-ASCII characters using RFC 2047 base64 encoding
    const encoder = new TextEncoder();
    const utf8Bytes = encoder.encode(sanitized);
    
    // SAFE: Use loop instead of spread operator to avoid stack overflow
    // Even though headers are typically small, we protect against malicious input
    let binaryString = '';
    for (let i = 0; i < utf8Bytes.length; i++) {
      binaryString += String.fromCharCode(utf8Bytes[i]);
    }
    
    return `=?UTF-8?B?${btoa(binaryString)}?=`;
  }

  private formatDisplayName(name: string): string {
    const encoded = this.encodeRFC2047(name);
    if (encoded.startsWith('=?')) {
      return encoded;
    }
    const escaped = encoded.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }

  private buildRawEmail(message: EmailMessage): string {
    const boundary = `----=_Part_${crypto.randomUUID()}`;
    const date = new Date().toUTCString();

    const fromName = this.formatDisplayName(message.from.name);
    const fromEmail = this.sanitizeHeader(message.from.email);
    const subject = this.encodeRFC2047(message.subject);
    const toAddresses = message.to.map(addr => this.sanitizeHeader(addr));

    // Build headers
    const headers: string[] = [
      `From: ${fromName} <${fromEmail}>`,
      `To: ${toAddresses.join(', ')}`,
      `Subject: ${subject}`,
      `Date: ${date}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ];

    // Add Message-ID if present
    // 
    // RFC 5322 §3.6.4 Message-ID Specification:
    //   msg-id = [CFWS] "<" id-left "@" id-right ">" [CFWS]
    //   id-left = dot-atom-text / obs-id-left
    //   id-right = dot-atom-text / no-fold-literal / obs-id-right
    //   dot-atom-text = 1*atext *("." 1*atext)
    //   atext = ALPHA / DIGIT / "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+" / 
    //           "-" / "/" / "=" / "?" / "^" / "_" / "`" / "{" / "|" / "}" / "~"
    // 
    // CRITICAL SECURITY & DELIVERABILITY:
    //   1. Angle brackets < > are MANDATORY per RFC 5322 syntax definition
    //   2. Gmail specifically REJECTS messages without angle brackets
    //      Reference: https://www.spamresource.com/2025/06/gmail-says-yes-to-angle-brackets-in.html
    //   3. Missing angle brackets breaks email threading (In-Reply-To/References)
    //   4. Format MUST be: <local-part@domain> (e.g., <uuid@email.rareminds.in>)
    // 
    // SECURITY THREATS PREVENTED:
    //   1. CRLF Injection: Strip \r\n to prevent header injection
    //      Attack: "Message-ID: <id>\r\nBcc: attacker@evil.com"
    //      Result: Would add unauthorized recipients
    //   
    //   2. Angle Bracket Injection: Validate no < > inside the ID
    //      Attack: "id@domain>Bcc: attacker@evil.com<fake@domain"
    //      Result: After wrapping: "<id@domain>Bcc: attacker@evil.com<fake@domain>"
    //      This would break parsing and potentially inject headers
    //   
    //   3. Multiple @ symbols: Ensure exactly one @ for proper parsing
    //      Attack: "id@domain@attacker.com"
    //      Result: Ambiguous parsing, potential routing issues
    //   
    //   4. Whitespace injection: Spaces break RFC 5322 msg-id syntax
    //      Attack: "id @domain" or "id@ domain"
    //      Result: Invalid Message-ID, delivery failures
    // 
    // VALIDATION RULES (RFC 5322 §3.6.4):
    //   ✓ Must contain exactly one @ symbol (id-left@id-right)
    //   ✓ Must not contain spaces, tabs, or control characters
    //   ✓ Must not contain angle brackets < > in the ID itself
    //   ✓ Must not contain quotes " or backslashes \
    //   ✓ id-left: alphanumeric + allowed special chars (! # $ % & ' * + - / = ? ^ _ ` { | } ~)
    //   ✓ id-right: domain name or IP address in brackets
    // 
    // EXAMPLES:
    //   Valid:   <550e8400-e29b-41d4-a716-446655440000@email.rareminds.in>
    //   Valid:   <abc123.def456@mail.example.com>
    //   Invalid: id@domain (missing angle brackets)
    //   Invalid: <id domain@example.com> (space in id-left)
    //   Invalid: <id@domain@example.com> (multiple @ symbols)
    //   Invalid: <id>@example.com> (angle bracket in id-left)
    // 
    // References:
    //   - RFC 5322 §3.6.4: https://www.ietf.org/rfc/rfc5322.txt
    //   - Gmail requirement: https://www.spamresource.com/2025/06/gmail-says-yes-to-angle-brackets-in.html
    if (message.messageId) {
      const validatedMessageId = this.validateMessageId(message.messageId);
      headers.push(`Message-ID: ${validatedMessageId}`);
    }

    // Add optional headers
    // 
    // Reply-To header format per RFC 5322 §3.6.2:
    //   Reply-To: address-list
    //   address = mailbox / group
    //   mailbox = [display-name] addr-spec
    // 
    // CRITICAL: RFC 2047 encoding is ONLY for display names, NEVER for email addresses
    // 
    // SECURITY & COMPLIANCE:
    //   1. Email addresses (local-part@domain) MUST remain plain ASCII
    //   2. RFC 2047 encoding the address breaks RFC 5322 compliance
    //   3. Gmail and other providers REJECT emails with encoded addresses
    //   4. For non-ASCII addresses, use EAI (RFC 6530), not RFC 2047
    // 
    // CORRECT FORMATS:
    //   ✓ Reply-To: user@example.com (plain address)
    //   ✓ Reply-To: "John Doe" <user@example.com> (with display name)
    //   ✗ Reply-To: =?UTF-8?B?dXNlckBleGFtcGxlLmNvbQ==?= (WRONG - encoded address)
    // 
    // CURRENT IMPLEMENTATION:
    //   - replyTo field contains a plain email address (validated by validator.ts)
    //   - No display name is supported in the current API
    //   - Therefore, we output the plain address with CRLF sanitization only
    // 
    // FUTURE ENHANCEMENT:
    //   If display names are needed, parse "Display Name <email@domain>" format
    //   and apply RFC 2047 encoding ONLY to the display name portion
    // 
    // References:
    //   - RFC 5322 §3.6.2: https://www.ietf.org/rfc/rfc5322.txt
    //   - RFC 2047 usage: https://www.suped.com/knowledge/email-deliverability/technical/when-can-you-encode-email-addresses-using-rfc-2047
    if (message.replyTo) {
      // Sanitize to prevent CRLF injection, but do NOT RFC 2047 encode
      // The email address must remain in plain ASCII per RFC 5322
      headers.push(`Reply-To: ${this.sanitizeHeader(message.replyTo)}`);
    }

    if (message.cc && message.cc.length > 0) {
      const ccAddresses = message.cc.map(addr => this.sanitizeHeader(addr));
      headers.push(`Cc: ${ccAddresses.join(', ')}`);
    }

    // Build body parts
    // Note: This naive regex fallback is fragile against deeply nested HTML.
    // Callers should strongly supplement complex marketing emails with the explicit `text` field.
    const textPart = message.text || message.html.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, '').trim();

    const parts: string[] = [
      headers.join('\r\n'),
      '',
      `--${boundary}`,
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      '',
      Buffer.from(textPart).toString('base64'),
      '',
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      '',
      Buffer.from(message.html).toString('base64'),
      '',
      `--${boundary}--`,
    ];

    return parts.join('\r\n');
  }
}
