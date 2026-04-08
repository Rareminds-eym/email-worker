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
import { MessageCentralService } from '../services/MessageCentralService';
import { checkOTPRateLimit } from '../middleware/otpRateLimit';
import {
  validatePhoneNumber,
  validateCountryCode,
  validateFlowType,
  validateVerificationId,
  validateOTPCode,
} from '../middleware/otpValidator';

/**
 * Handle Send OTP Request
 * POST /otp/send
 */
export async function handleSendOTP(request: IRequest, env: Env): Promise<Response> {
  const requestId = request.headers.get('cf-ray') || crypto.randomUUID();
  console.log(`[OTP-Send] Request received - ID: ${requestId}`);

  try {
    // Parse request body
    const body: SendOTPRequest = await request.json();
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

    console.log(`[OTP-Send] Success - Phone: +${validatedCountryCode}${validatedPhoneNumber}, ID: ${requestId}`);

    return Response.json({
      success: true,
      verificationId: result.verificationId,
      timeout: result.timeout,
      message: 'OTP sent successfully',
    }, { status: 200 });
  } catch (error: any) {
    console.error(`[OTP-Send] Error - ID: ${requestId}`, error.message);

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
  console.log(`[OTP-Verify] Request received - ID: ${requestId}`);

  try {
    // Parse request body
    const body: VerifyOTPRequest = await request.json();
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

    console.log(`[OTP-Verify] ${result.verified ? 'Success' : 'Failed'} - Phone: +${validatedCountryCode}${validatedPhoneNumber}, ID: ${requestId}`);

    return Response.json({
      success: true,
      verified: result.verified,
      message: result.verified
        ? 'Phone number verified successfully'
        : 'Invalid OTP code',
    }, { status: 200 });
  } catch (error: any) {
    console.error(`[OTP-Verify] Error - ID: ${requestId}`, error.message);

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
