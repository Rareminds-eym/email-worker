/**
 * OTP Routes
 * Handles phone number verification via SMS OTP
 * 
 * Endpoints:
 * - POST /otp/send - Send OTP to phone number
 * - POST /otp/verify - Verify OTP code
 */

import type { IRequest } from 'itty-router';
import type { Env, SendOTPRequest, VerifyOTPRequest } from '../types';
import { ValidationError, OTPError } from '../types';
import { validateAndReadBody } from '../middleware/bodySize';
import { MessageCentralService } from '../services/MessageCentralService';
import { checkOTPRateLimit } from '../middleware/otpRateLimit';
import {
  validatePhoneNumber,
  validateCountryCode,
  validateFlowType,
  validateVerificationId,
  validateOTPCode,
} from '../middleware/otpValidator';
import { maskPhoneNumber } from '../utils/maskPhone';
import { log } from '../middleware/logger';

/**
 * Handle Send OTP Request
 * POST /otp/send
 */
export async function handleSendOTP(request: IRequest, env: Env): Promise<Response> {
  const requestId = request.headers.get('cf-ray') || crypto.randomUUID();
  log('info', 'OTP send request received', { requestId });

  try {
    // Parse request body with size validation
    const bodyText = await validateAndReadBody(request);
    const body: SendOTPRequest = JSON.parse(bodyText);
    const { mobileNumber, countryCode, flowType } = body;

    // Validate inputs
    const validatedCountryCode = validateCountryCode(countryCode);
    const validatedPhoneNumber = validatePhoneNumber(mobileNumber, validatedCountryCode);
    const validatedFlowType = validateFlowType(flowType);

    // Check rate limit
    checkOTPRateLimit(validatedPhoneNumber, 'SEND_OTP');

    // Send OTP
    const service = new MessageCentralService(env);
    const result = await service.sendOTP(
      validatedPhoneNumber,
      validatedCountryCode,
      validatedFlowType
    );

    log('info', 'OTP sent successfully', { phone: maskPhoneNumber(validatedPhoneNumber, validatedCountryCode), requestId });

    return Response.json({
      success: true,
      verificationId: result.verificationId,
      timeout: result.timeout,
      message: 'OTP sent successfully',
    }, { status: 200 });
  } catch (error: any) {
    log('error', 'OTP send failed', { error: error.message, requestId });

    if (error instanceof ValidationError || error instanceof OTPError) {
      return Response.json({
        success: false,
        error: error.message,
        errorCode: error.code,
      }, { status: error.statusCode });
    }

    return Response.json({
      success: false,
      error: 'Failed to send OTP. Please try again.',
      errorCode: 'INTERNAL_ERROR',
    }, { status: 500 });
  }
}

/**
 * Handle Verify OTP Request
 * POST /otp/verify
 */
export async function handleVerifyOTP(request: IRequest, env: Env): Promise<Response> {
  const requestId = request.headers.get('cf-ray') || crypto.randomUUID();
  log('info', 'OTP verify request received', { requestId });

  try {
    // Parse request body with size validation
    const bodyText = await validateAndReadBody(request);
    const body: VerifyOTPRequest = JSON.parse(bodyText);
    const { mobileNumber, verificationId, code, countryCode } = body;

    // Validate inputs
    const validatedCountryCode = validateCountryCode(countryCode);
    const validatedPhoneNumber = validatePhoneNumber(mobileNumber, validatedCountryCode);
    validateVerificationId(verificationId);
    validateOTPCode(code);

    // Check rate limit (prevent brute force)
    checkOTPRateLimit(`${validatedPhoneNumber}_${verificationId}`, 'VERIFY_OTP');

    // Verify OTP
    const service = new MessageCentralService(env);
    const result = await service.verifyOTP(
      validatedPhoneNumber,
      verificationId,
      code,
      validatedCountryCode
    );

    log('info', result.verified ? 'OTP verified successfully' : 'OTP verification failed', { phone: maskPhoneNumber(validatedPhoneNumber, validatedCountryCode), requestId });

    return Response.json({
      success: true,
      verified: result.verified,
      message: result.verified
        ? 'Phone number verified successfully'
        : 'Invalid OTP code',
    }, { status: 200 });
  } catch (error: any) {
    log('error', 'OTP verify failed', { error: error.message, requestId });

    if (error instanceof ValidationError || error instanceof OTPError) {
      return Response.json({
        success: false,
        verified: false,
        error: error.message,
        errorCode: error.code,
      }, { status: error.statusCode });
    }

    return Response.json({
      success: false,
      verified: false,
      error: 'Failed to verify OTP. Please try again.',
      errorCode: 'INTERNAL_ERROR',
    }, { status: 500 });
  }
}
