/**
 * MessageCentral OTP Service
 * Enterprise-grade SMS OTP verification service
 * 
 * Features:
 * - Uses long-lived JWT token for authentication
 * - Comprehensive error handling
 * - Type-safe API interactions
 * - Secure credential management
 */

import type {
  Env,
  MessageCentralSendResponse,
  MessageCentralVerifyResponse,
} from '../types';
import { OTPError } from '../types';

const MESSAGECENTRAL_BASE_URL = 'https://cpaas.messagecentral.com';

export class MessageCentralService {
  constructor(private env: Env) {}

  /**
   * Get authentication token
   * Uses the long-lived JWT token from environment variables
   */
  private async getAuthToken(): Promise<string> {
    const { MESSAGECENTRAL_KEY } = this.env;

    if (!MESSAGECENTRAL_KEY) {
      throw new OTPError(
        'MESSAGECENTRAL_KEY not configured',
        'CONFIG_ERROR',
        500
      );
    }

    // The MESSAGECENTRAL_KEY is a long-lived JWT token that can be used directly
    console.log('[MessageCentral] Using configured auth token');
    return MESSAGECENTRAL_KEY;
  }

  /**
   * Send OTP to phone number
   */
  async sendOTP(
    mobileNumber: string,
    countryCode: string = '91',
    flowType: 'SMS' | 'WHATSAPP' | 'RCS' = 'SMS'
  ): Promise<{
    verificationId: string;
    timeout: string;
    mobileNumber: string;
  }> {
    console.log(`[MessageCentral] Sending OTP to +${countryCode}${mobileNumber} via ${flowType}`);

    const authToken = await this.getAuthToken();
    const customerId = this.env.MESSAGECENTRAL_CUSTOMER_ID;

    const url = new URL(`${MESSAGECENTRAL_BASE_URL}/verification/v3/send`);
    url.searchParams.set('countryCode', countryCode);
    url.searchParams.set('customerId', customerId);
    url.searchParams.set('flowType', flowType);
    url.searchParams.set('mobileNumber', mobileNumber);

    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'authToken': authToken,
          'Content-Type': 'application/json',
        },
      });

      const data: MessageCentralSendResponse = await response.json();

      if (data.responseCode === 200 && data.data) {
        console.log(`[MessageCentral] OTP sent - Verification ID: ${data.data.verificationId}`);
        return {
          verificationId: data.data.verificationId,
          timeout: data.data.timeout || '60',
          mobileNumber: data.data.mobileNumber,
        };
      }

      // Handle specific error codes
      const errorMap: Record<number, { message: string; code: string; status: number }> = {
        400: { message: 'Invalid request. Please check the phone number.', code: 'INVALID_REQUEST', status: 400 },
        409: { message: 'OTP already sent. Please wait before requesting again.', code: 'OTP_ALREADY_SENT', status: 409 },
        500: { message: 'Service temporarily unavailable. Please try again later.', code: 'SERVICE_UNAVAILABLE', status: 503 },
        501: { message: 'Invalid customer configuration.', code: 'CONFIG_ERROR', status: 500 },
        511: { message: 'Invalid country code.', code: 'INVALID_COUNTRY_CODE', status: 400 },
        800: { message: 'Maximum OTP limit reached. Please try again later.', code: 'RATE_LIMIT_EXCEEDED', status: 429 },
      };

      const error = errorMap[data.responseCode] || {
        message: data.message || 'Failed to send OTP',
        code: 'SEND_FAILED',
        status: 400,
      };

      console.error(`[MessageCentral] Send failed - Code: ${data.responseCode}, Message: ${error.message}`);
      throw new OTPError(error.message, error.code, error.status);
    } catch (error: any) {
      if (error instanceof OTPError) throw error;

      console.error('[MessageCentral] Send exception:', error.message);
      throw new OTPError(
        'Failed to send OTP. Please try again.',
        'SEND_ERROR',
        500
      );
    }
  }

  /**
   * Verify OTP code
   */
  async verifyOTP(
    mobileNumber: string,
    verificationId: string,
    code: string,
    countryCode: string = '91'
  ): Promise<{
    verified: boolean;
    verificationStatus: string;
  }> {
    console.log(`[MessageCentral] Verifying OTP for +${countryCode}${mobileNumber}`);

    const authToken = await this.getAuthToken();
    const customerId = this.env.MESSAGECENTRAL_CUSTOMER_ID;

    const url = new URL(`${MESSAGECENTRAL_BASE_URL}/verification/v3/validateOtp`);
    url.searchParams.set('countryCode', countryCode);
    url.searchParams.set('mobileNumber', mobileNumber);
    url.searchParams.set('verificationId', verificationId);
    url.searchParams.set('customerId', customerId);
    url.searchParams.set('code', code);

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'authToken': authToken,
          'Content-Type': 'application/json',
        },
      });

      const data: MessageCentralVerifyResponse = await response.json();

      if (data.responseCode === 200 && data.data) {
        const verified = data.data.verificationStatus === 'VERIFICATION_COMPLETED';
        console.log(`[MessageCentral] Verification ${verified ? 'successful' : 'failed'} - Status: ${data.data.verificationStatus}`);
        
        return {
          verified,
          verificationStatus: data.data.verificationStatus,
        };
      }

      // Handle specific error codes
      const errorMap: Record<number, { message: string; code: string; status: number }> = {
        400: { message: 'Invalid request.', code: 'INVALID_REQUEST', status: 400 },
        505: { message: 'Invalid verification ID.', code: 'INVALID_VERIFICATION_ID', status: 400 },
        700: { message: 'Verification failed.', code: 'VERIFICATION_FAILED', status: 400 },
        702: { message: 'Invalid OTP code.', code: 'INVALID_OTP', status: 400 },
        703: { message: 'OTP already verified.', code: 'ALREADY_VERIFIED', status: 400 },
        705: { message: 'OTP expired. Please request a new one.', code: 'OTP_EXPIRED', status: 400 },
      };

      const error = errorMap[data.responseCode] || {
        message: data.message || 'Verification failed',
        code: 'VERIFY_FAILED',
        status: 400,
      };

      console.error(`[MessageCentral] Verify failed - Code: ${data.responseCode}, Message: ${error.message}`);
      throw new OTPError(error.message, error.code, error.status);
    } catch (error: any) {
      if (error instanceof OTPError) throw error;

      console.error('[MessageCentral] Verify exception:', error.message);
      throw new OTPError(
        'Failed to verify OTP. Please try again.',
        'VERIFY_ERROR',
        500
      );
    }
  }

  /**
   * Clear token cache (no longer needed, kept for backward compatibility)
   */
  clearTokenCache(): void {
    console.log('[MessageCentral] Token cache not used (using long-lived token)');
  }
}
