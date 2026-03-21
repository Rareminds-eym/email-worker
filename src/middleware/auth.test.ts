import { describe, it, expect } from 'vitest';
import { authenticateRequest } from './auth';

describe('authenticateRequest', () => {
    const mockEnv = {
        API_KEY: 'secret-key-123'
    };

    it('should pass if X-Internal-Api-Key matches', () => {
        const request = new Request('https://test.com', {
            headers: { 'X-Internal-Api-Key': 'secret-key-123' }
        });
        expect(() => authenticateRequest(request as any, mockEnv as any)).not.toThrow();
    });

    it('should strip Bearer prefix with multiple spaces', () => {
        const request = new Request('https://test.com', {
            headers: { 'Authorization': 'Bearer   secret-key-123' }
        });
        expect(() => authenticateRequest(request as any, mockEnv as any)).not.toThrow();
    });

    it('should parse case-insensitive Bearer prefix', () => {
        const request = new Request('https://test.com', {
            headers: { 'Authorization': 'bearer secret-key-123' }
        });
        expect(() => authenticateRequest(request as any, mockEnv as any)).not.toThrow();
    });

    it('should throw if no token is provided', () => {
        const request = new Request('https://test.com');
        expect(() => authenticateRequest(request as any, mockEnv as any)).toThrowError('Missing API key. Provide X-Internal-Api-Key header, X-API-Key header, or Authorization: Bearer token');
    });

    it('should throw if token is incorrect', () => {
        const request = new Request('https://test.com', {
            headers: { 'X-Internal-Api-Key': 'wrong-key' }
        });
        expect(() => authenticateRequest(request as any, mockEnv as any)).toThrowError('Invalid API key');
    });
});
