/**
 * OTP request validation middleware
 * Validates and sanitizes phone numbers and OTP codes
 */

import { ValidationError } from '../types';

/**
 * Validate phone number format
 */
export function validatePhoneNumber(
  phoneNumber: string,
  countryCode: string = '91'
): string {
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    throw new ValidationError('Phone number is required');
  }

  // Remove any non-digit characters
  const cleaned = phoneNumber.replace(/\D/g, '');

  // Validate based on country code
  if (countryCode === '91') {
    // Indian phone numbers: 10 digits, starting with 6-9
    if (!/^[6-9]\d{9}$/.test(cleaned)) {
      throw new ValidationError(
        'Invalid Indian phone number. Must be 10 digits starting with 6-9.'
      );
    }
  } else {
    // Generic validation: 7-15 digits
    if (!/^\d{7,15}$/.test(cleaned)) {
      throw new ValidationError('Invalid phone number format.');
    }
  }

  return cleaned;
}

/**
 * Validate country code
 */
export function validateCountryCode(countryCode?: string): string {
  if (!countryCode) return '91'; // Default to India

  if (typeof countryCode !== 'string') {
    throw new ValidationError('Invalid country code format');
  }

  const cleaned = countryCode.replace(/\D/g, '');

  if (!/^\d{1,3}$/.test(cleaned)) {
    throw new ValidationError('Country code must be 1-3 digits');
  }

  return cleaned;
}

/**
 * Validate flow type
 */
export function validateFlowType(
  flowType?: string
): 'SMS' | 'WHATSAPP' | 'RCS' {
  if (!flowType) return 'SMS'; // Default

  const validTypes = ['SMS', 'WHATSAPP', 'RCS'];
  const upper = flowType.toUpperCase();

  if (!validTypes.includes(upper)) {
    throw new ValidationError(
      'Invalid flow type. Must be SMS, WHATSAPP, or RCS.'
    );
  }

  return upper as 'SMS' | 'WHATSAPP' | 'RCS';
}

/**
 * Validate verification ID
 */
export function validateVerificationId(verificationId: string): void {
  if (!verificationId || typeof verificationId !== 'string') {
    throw new ValidationError('Verification ID is required');
  }

  // Verification IDs are typically alphanumeric
  if (!/^[a-zA-Z0-9_-]+$/.test(verificationId)) {
    throw new ValidationError('Invalid verification ID format');
  }

  if (verificationId.length < 1 || verificationId.length > 100) {
    throw new ValidationError('Invalid verification ID length');
  }
}

/**
 * Validate OTP code
 */
export function validateOTPCode(code: string): void {
  if (!code || typeof code !== 'string') {
    throw new ValidationError('OTP code is required');
  }

  // OTP codes are typically 4-6 digits
  if (!/^\d{4,6}$/.test(code)) {
    throw new ValidationError('Invalid OTP code format. Must be 4-6 digits.');
  }
}
