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
import { maskPhoneNumber } from '../utils/maskPhone';
import { log } from '../middleware/logger';

const MESSAGECENTRAL_BASE_URL = 'https://cpaas.messagecentral.com';

export class MessageCentralService {
  // Validation constants
  private static readonly VALIDATION_RULES = {
    PHONE: {
      MIN_LENGTH: 7,
      MAX_LENGTH: 15,
    },
    COUNTRY_CODE: {
      MIN_LENGTH: 1,
      MAX_LENGTH: 3,
    },
    OTP: {
      MIN_LENGTH: 4,
      MAX_LENGTH: 8,
    },
  } as const;

  // API timeout in milliseconds
  private static readonly API_TIMEOUT_MS = 10000; // 10 seconds

  // Error code mappings
  private static readonly SEND_ERROR_MAP: Record<number, { message: string; code: string; status: number }> = {
    400: { message: 'Invalid request. Please check the phone number.', code: 'INVALID_REQUEST', status: 400 },
    409: { message: 'OTP already sent. Please wait before requesting again.', code: 'OTP_ALREADY_SENT', status: 409 },
    500: { message: 'Service temporarily unavailable. Please try again later.', code: 'SERVICE_UNAVAILABLE', status: 503 },
    501: { message: 'Invalid customer configuration.', code: 'CONFIG_ERROR', status: 500 },
    511: { message: 'Invalid country code.', code: 'INVALID_COUNTRY_CODE', status: 400 },
    800: { message: 'Maximum OTP limit reached. Please try again later.', code: 'RATE_LIMIT_EXCEEDED', status: 429 },
  };

  private static readonly VERIFY_ERROR_MAP: Record<number, { message: string; code: string; status: number }> = {
    400: { message: 'Invalid request.', code: 'INVALID_REQUEST', status: 400 },
    505: { message: 'Invalid verification ID.', code: 'INVALID_VERIFICATION_ID', status: 400 },
    700: { message: 'Verification failed.', code: 'VERIFICATION_FAILED', status: 400 },
    702: { message: 'Invalid OTP code.', code: 'INVALID_OTP', status: 400 },
    703: { message: 'OTP already verified.', code: 'ALREADY_VERIFIED', status: 400 },
    705: { message: 'OTP expired. Please request a new one.', code: 'OTP_EXPIRED', status: 400 },
  };

  constructor(private env: Env) {}

  /**
   * Fetch with timeout to prevent hanging requests
   */
  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MessageCentralService.API_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new OTPError(
          'Request timeout. Please try again.',
          'TIMEOUT_ERROR',
          504
        );
      }
      throw error;
    }
  }

  /**
   * Validate mobile number format
   */
  private validateMobileNumber(mobileNumber: string): void {
    if (!mobileNumber || typeof mobileNumber !== 'string') {
      throw new OTPError('Mobile number is required', 'INVALID_MOBILE_NUMBER', 400);
    }

    const trimmedNumber = mobileNumber.trim();
    if (trimmedNumber.length === 0) {
      throw new OTPError('Mobile number cannot be empty', 'INVALID_MOBILE_NUMBER', 400);
    }

    // Check if mobile number contains only digits
    if (!/^\d+$/.test(trimmedNumber)) {
      throw new OTPError('Mobile number must contain only digits', 'INVALID_MOBILE_NUMBER', 400);
    }

    // Validate length
    const { MIN_LENGTH, MAX_LENGTH } = MessageCentralService.VALIDATION_RULES.PHONE;
    if (trimmedNumber.length < MIN_LENGTH || trimmedNumber.length > MAX_LENGTH) {
      throw new OTPError(
        `Mobile number must be between ${MIN_LENGTH} and ${MAX_LENGTH} digits`,
        'INVALID_MOBILE_NUMBER',
        400
      );
    }
  }

  /**
   * Validate country code format
   */
  private validateCountryCode(countryCode: string): void {
    if (!countryCode || typeof countryCode !== 'string') {
      throw new OTPError('Country code is required', 'INVALID_COUNTRY_CODE', 400);
    }

    const trimmedCode = countryCode.trim();
    if (trimmedCode.length === 0) {
      throw new OTPError('Country code cannot be empty', 'INVALID_COUNTRY_CODE', 400);
    }

    // Country code validation
    const { MIN_LENGTH, MAX_LENGTH } = MessageCentralService.VALIDATION_RULES.COUNTRY_CODE;
    if (!/^\d+$/.test(trimmedCode) || trimmedCode.length < MIN_LENGTH || trimmedCode.length > MAX_LENGTH) {
      throw new OTPError(`Country code must be ${MIN_LENGTH}-${MAX_LENGTH} digits`, 'INVALID_COUNTRY_CODE', 400);
    }
  }

  /**
   * Validate OTP code format
   */
  private validateOTPCode(code: string): void {
    if (!code || typeof code !== 'string') {
      throw new OTPError('OTP code is required', 'INVALID_OTP', 400);
    }

    const trimmedCode = code.trim();
    if (trimmedCode.length === 0) {
      throw new OTPError('OTP code cannot be empty', 'INVALID_OTP', 400);
    }

    // OTP validation
    const { MIN_LENGTH, MAX_LENGTH } = MessageCentralService.VALIDATION_RULES.OTP;
    if (!/^\d+$/.test(trimmedCode) || trimmedCode.length < MIN_LENGTH || trimmedCode.length > MAX_LENGTH) {
      throw new OTPError(`OTP code must be ${MIN_LENGTH}-${MAX_LENGTH} digits`, 'INVALID_OTP', 400);
    }
  }

  /**
   * Validate verification ID format
   */
  private validateVerificationId(verificationId: string): void {
    if (!verificationId || typeof verificationId !== 'string') {
      throw new OTPError('Verification ID is required', 'INVALID_VERIFICATION_ID', 400);
    }

    const trimmedId = verificationId.trim();
    if (trimmedId.length === 0) {
      throw new OTPError('Verification ID cannot be empty', 'INVALID_VERIFICATION_ID', 400);
    }
  }

  /**
   * Get authentication token
   * Uses the long-lived JWT token from environment variables
   */
  private get authToken(): string {
    const { MESSAGECENTRAL_KEY } = this.env;

    if (!MESSAGECENTRAL_KEY) {
      throw new OTPError(
        'MESSAGECENTRAL_KEY not configured',
        'CONFIG_ERROR',
        500
      );
    }

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
    // Validate inputs
    this.validateCountryCode(countryCode);
    this.validateMobileNumber(mobileNumber);

    console.log(`[MessageCentral] Sending OTP to ${maskPhoneNumber(mobileNumber, countryCode)} via ${flowType}`);

    const authToken = this.authToken;
    const customerId = this.env.MESSAGECENTRAL_CUSTOMER_ID;

    const params = new URLSearchParams({
      countryCode,
      customerId,
      flowType,
      mobileNumber,
    });
    const url = `${MESSAGECENTRAL_BASE_URL}/verification/v3/send?${params}`;

    try {
      const response = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'authToken': authToken,
          'Content-Type': 'application/json',
        },
      });

      const data: MessageCentralSendResponse = await response.json();

      if (data.responseCode === 200 && data.data) {
        console.log(`[MessageCentral] OTP sent successfully`);
        return {
          verificationId: data.data.verificationId,
          timeout: data.data.timeout || '60',
          mobileNumber: data.data.mobileNumber,
        };
      }

      // Handle specific error codes
      const error = MessageCentralService.SEND_ERROR_MAP[data.responseCode] || {
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
    // Validate inputs
    this.validateCountryCode(countryCode);
    this.validateMobileNumber(mobileNumber);
    this.validateVerificationId(verificationId);
    this.validateOTPCode(code);

    console.log(`[MessageCentral] Verifying OTP for ${maskPhoneNumber(mobileNumber, countryCode)}`);

    const authToken = this.authToken;
    const customerId = this.env.MESSAGECENTRAL_CUSTOMER_ID;

    const params = new URLSearchParams({
      countryCode,
      mobileNumber,
      verificationId,
      customerId,
      code,
    });
    const url = `${MESSAGECENTRAL_BASE_URL}/verification/v3/validateOtp?${params}`;

    // SECURITY NOTE: OTP is sent in URL query parameter because MessageCentral API
    // only supports GET method for this endpoint. This means the OTP will appear in:
    // - Server access logs
    // - Browser history (if called from browser)
    // - Proxy/CDN logs
    // This is a limitation of the MessageCentral API design.
    log('debug', 'Security Warning: OTP sent in URL (API limitation)', {
      service: 'MessageCentral',
      endpoint: 'validateOtp'
    });

    try {
      const response = await this.fetchWithTimeout(url, {
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
      const error = MessageCentralService.VERIFY_ERROR_MAP[data.responseCode] || {
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
