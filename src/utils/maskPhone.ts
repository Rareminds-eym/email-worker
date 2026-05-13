/**
 * Utility to mask phone numbers in logs for PII protection
 * Shows only last 4 digits: +91****1234
 */

export function maskPhoneNumber(
  phoneNumber: string,
  countryCode: string = '91'
): string {
  if (!phoneNumber || phoneNumber.length < 4) {
    return '****';
  }

  const lastFour = phoneNumber.slice(-4);
  const maskedLength = phoneNumber.length - 4;
  const masked = '*'.repeat(maskedLength);

  return `+${countryCode}${masked}${lastFour}`;
}
