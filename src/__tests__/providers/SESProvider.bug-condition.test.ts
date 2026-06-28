/**
 * Bug Condition Exploration Test - AWS SES Internal Errors
 * 
 * **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
 * **DO NOT attempt to fix the test or the code when it fails**
 * 
 * This test encodes the expected behavior - it will validate the fix when it passes after implementation.
 * 
 * **GOAL**: Surface counterexamples that demonstrate insufficient error diagnostics for AWS SES failures
 * 
 * **Validates: Requirements 1.1, 1.2, 2.2**
 * **Property 1: Bug Condition** - AWS SES Internal Error Handling
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESProvider } from '../../providers/SESProvider';
import type { EmailConfig, EmailMessage } from '../../types';

describe('Bug Condition Exploration: AWS SES Internal Errors', () => {
    let provider: SESProvider;
    let mockFetch: ReturnType<typeof vi.fn>;
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    const mockConfig: EmailConfig = {
        aws: {
            accessKeyId: 'test-key-id',
            secretAccessKey: 'test-secret-key',
            region: 'us-east-1',
        },
        defaultFrom: {
            email: 'test@example.com',
            name: 'Test Sender',
        },
        rateLimit: {
            perMinute: 10,
            perHour: 100,
            perDay: 1000,
        },
    };

    const mockEmailMessage: EmailMessage = {
        to: ['recipient@example.com'],
        from: {
            email: 'sender@example.com',
            name: 'Sender Name',
        },
        subject: 'Test Email',
        html: '<p>Test content</p>',
        text: 'Test content',
    };

    beforeEach(() => {
        // Spy on console methods to verify logging
        consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

        // Create provider instance
        provider = new SESProvider(mockConfig);

        // Mock the AWS fetch method
        mockFetch = vi.fn();
        (provider as any).aws.fetch = mockFetch;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /**
     * Test Case 1: AWS SES 500 Internal Error with Reference ID
     * 
     * **Bug Condition**: When AWS SES returns 500 error with reference ID
     * **Expected Behavior**: System SHALL log detailed diagnostic information including:
     *   - messageId (custom or AWS-provided)
     *   - recipient
     *   - errorMessage
     *   - statusCode
     *   - errorType (should be 'temporary')
     *   - awsRegion
     *   - timestamp
     *   - requestDetails (sanitized - no AWS credentials)
     *   - referenceId (extracted from error response)
     * 
     * **EXPECTED OUTCOME**: This test will FAIL on unfixed code because:
     *   1. Error logging does not include reference ID
     *   2. Error logging does not include all required diagnostic fields
     *   3. Reference ID is not extracted from AWS SES error response
     */
    it('should log comprehensive diagnostics for AWS SES 500 internal error with reference ID', async () => {
        // Arrange: Mock AWS SES to return 500 error with reference ID
        const awsReferenceId = 'icvhomr0k4f65gvupabqvm3t';
        const errorResponse = {
            message: `internal error; reference = ${awsReferenceId}`,
        };

        mockFetch.mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: async () => JSON.stringify(errorResponse),
            json: async () => errorResponse,
        });

        // Act: Attempt to send email (will fail with AWS SES error)
        const result = await provider.send(mockEmailMessage);

        // Assert: Test the EXPECTED behavior (will fail on unfixed code)

        // 1. Result should indicate failure but mark as temporary/retryable
        expect(result.success).toBe(false);
        expect(result.shouldRetry).toBe(true);
        expect(result.errorType).toBe('temporary');

        // 2. Error logs should contain AWS SES reference ID
        const errorLogs = consoleErrorSpy.mock.calls.flat().join(' ');
        expect(errorLogs).toContain(awsReferenceId);

        // 3. Error logs should contain all required diagnostic fields
        expect(errorLogs).toContain('recipient@example.com'); // recipient
        expect(errorLogs).toContain('500'); // statusCode
        expect(errorLogs).toContain('temporary'); // errorType
        expect(errorLogs).toContain('us-east-1'); // awsRegion

        // 4. Error logs should contain timestamp (ISO 8601 format)
        expect(errorLogs).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

        // 5. Error logs should contain request details but NOT AWS credentials
        expect(errorLogs).toContain('ToAddresses'); // SES API field
        expect(errorLogs).not.toContain('test-key-id'); // Should NOT log AWS credentials
        expect(errorLogs).not.toContain('test-secret-key'); // Should NOT log AWS secret

        // 6. Error message in result should mention reference ID
        expect(result.error).toContain(awsReferenceId);
    });

    /**
     * Test Case 2: AWS SES 503 Service Unavailable
     * 
     * **Bug Condition**: When AWS SES returns 503 service unavailable
     * **Expected Behavior**: System SHALL log detailed diagnostics and classify as temporary
     * 
     * **EXPECTED OUTCOME**: This test will FAIL on unfixed code because:
     *   1. Error is not properly classified as temporary
     *   2. Diagnostic logging is insufficient
     */
    it('should log diagnostics for AWS SES 503 service unavailable error', async () => {
        // Arrange: Mock AWS SES to return 503 error
        const errorResponse = {
            message: 'Service temporarily unavailable',
        };

        mockFetch.mockResolvedValue({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            text: async () => JSON.stringify(errorResponse),
            json: async () => errorResponse,
        });

        // Act
        const result = await provider.send(mockEmailMessage);

        // Assert: Expected behavior (will fail on unfixed code)
        expect(result.success).toBe(false);
        expect(result.shouldRetry).toBe(true);
        expect(result.errorType).toBe('temporary');

        // Verify diagnostic logging
        const errorLogs = consoleErrorSpy.mock.calls.flat().join(' ');
        expect(errorLogs).toContain('503');
        expect(errorLogs).toContain('temporary');
        expect(errorLogs).toContain('recipient@example.com');
    });

    /**
     * Test Case 3: AWS SES Internal Error with Multiple Reference ID Formats
     * 
     * **Bug Condition**: AWS SES may return reference IDs in various formats
     * **Expected Behavior**: System SHALL extract reference ID regardless of format
     * 
     * Reference ID patterns from AWS SES:
     *   - "internal error; reference = abc123"
     *   - "Internal error; reference=xyz789"
     *   - "INTERNAL ERROR; REFERENCE = uvw456"
     */
    it('should extract reference ID from various AWS SES error formats', async () => {
        const testCases = [
            { referenceId: 'abc123def456', format: 'internal error; reference = abc123def456' },
            { referenceId: 'xyz789ghi012', format: 'Internal error; reference=xyz789ghi012' },
            { referenceId: 'uvw456rst789', format: 'INTERNAL ERROR; REFERENCE = uvw456rst789' },
        ];

        for (const testCase of testCases) {
            // Arrange
            mockFetch.mockResolvedValue({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                text: async () => testCase.format,
                json: async () => ({ message: testCase.format }),
            });

            // Act
            const result = await provider.send(mockEmailMessage);

            // Assert: Reference ID should be extracted and logged
            expect(result.error).toContain(testCase.referenceId);

            const errorLogs = consoleErrorSpy.mock.calls.flat().join(' ');
            expect(errorLogs).toContain(testCase.referenceId);

            // Clear mocks for next iteration
            consoleErrorSpy.mockClear();
        }
    });

    /**
     * Test Case 4: Verify Request Payload Sanitization
     * 
     * **Bug Condition**: Error logs may expose AWS credentials
     * **Expected Behavior**: System SHALL sanitize request payload before logging
     * 
     * **Security Requirement**: AWS credentials must NEVER appear in logs
     */
    it('should sanitize AWS credentials from logged request details', async () => {
        // Arrange: Mock AWS SES error
        mockFetch.mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: async () => 'internal error; reference = test123',
            json: async () => ({ message: 'internal error; reference = test123' }),
        });

        // Act
        await provider.send(mockEmailMessage);

        // Assert: AWS credentials should NOT appear in any logs
        const allLogs = [
            ...consoleLogSpy.mock.calls.flat(),
            ...consoleErrorSpy.mock.calls.flat(),
        ].join(' ');

        expect(allLogs).not.toContain('test-key-id');
        expect(allLogs).not.toContain('test-secret-key');

        // But request payload structure should be logged (sanitized)
        expect(allLogs).toContain('recipient@example.com');
    });

    /**
     * Test Case 5: Verify Error Type Classification
     * 
     * **Bug Condition**: 5xx errors may not be classified correctly
     * **Expected Behavior**: All 5xx errors should be classified as 'temporary'
     */
    it('should classify all 5xx errors as temporary', async () => {
        const serverErrors = [500, 502, 503, 504];

        for (const statusCode of serverErrors) {
            // Arrange
            mockFetch.mockResolvedValue({
                ok: false,
                status: statusCode,
                statusText: 'Server Error',
                text: async () => 'Server error occurred',
                json: async () => ({ message: 'Server error occurred' }),
            });

            // Act
            const result = await provider.send(mockEmailMessage);

            // Assert
            expect(result.success).toBe(false);
            expect(result.errorType).toBe('temporary');
            expect(result.shouldRetry).toBe(true);

            // Clear mocks for next iteration
            mockFetch.mockClear();
        }
    });

    /**
     * Test Case 6: Verify Structured Error Response
     * 
     * **Bug Condition**: Error response may not include all required fields
     * **Expected Behavior**: ProviderResponse should include comprehensive error information
     */
    it('should return comprehensive error information in ProviderResponse', async () => {
        // Arrange
        const awsReferenceId = 'test456xyz789';
        mockFetch.mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: async () => `internal error; reference = ${awsReferenceId}`,
            json: async () => ({ message: `internal error; reference = ${awsReferenceId}` }),
        });

        // Act
        const result = await provider.send(mockEmailMessage);

        // Assert: ProviderResponse should have all error details
        expect(result).toMatchObject({
            success: false,
            errorType: 'temporary',
            shouldRetry: true,
        });

        // Error message should include reference ID
        expect(result.error).toBeDefined();
        expect(result.error).toContain(awsReferenceId);
    });
});
