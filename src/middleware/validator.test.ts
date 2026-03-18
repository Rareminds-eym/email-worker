import { describe, it, expect } from 'vitest';
import { validateSendEmailRequest } from './validator';

describe('validateSendEmailRequest', () => {
    it('should validate a valid payload with single recipient', () => {
        const validPayload = {
            to: 'test@example.com',
            subject: 'Hello',
            html: '<p>Test</p>',
        };
        const result = validateSendEmailRequest(validPayload);
        expect(result.to).toEqual(['test@example.com']);
        expect(result.subject).toBe('Hello');
    });

    it('should validate a valid payload with multiple recipients', () => {
        const validPayload = {
            to: ['test@example.com', 'test2@example.com'],
            subject: 'Hello',
            html: '<p>Test</p>',
            text: 'Test',
        };
        const result = validateSendEmailRequest(validPayload);
        expect(result.to).toEqual(['test@example.com', 'test2@example.com']);
    });

    it('should throw ValidationError if html is not provided', () => {
        const payload = {
            to: 'test@example.com',
            subject: 'Hello',
        };
        expect(() => validateSendEmailRequest(payload)).toThrowError('Missing required field: html');
    });

    it('should format arrays correctly for cc and bcc', () => {
        const payload = {
            to: 'test@example.com',
            subject: 'Hello',
            html: 'hi',
            cc: 'cc@test.com',
        };
        const result = validateSendEmailRequest(payload);
        expect(result.cc).toEqual(['cc@test.com']);
    });
});
