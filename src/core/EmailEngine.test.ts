import { describe, it, expect, vi } from 'vitest';
import { EmailEngine } from './EmailEngine';
import type { EmailConfig } from '../types';

describe('EmailEngine', () => {
    const mockConfig: EmailConfig = {
        aws: {
            accessKeyId: 'test-key',
            secretAccessKey: 'test-secret',
            region: 'us-east-1',
        },
        defaultFrom: {
            email: 'default@test.com',
            name: 'Default Sender',
        }
    };

    it('should route to SES provider', async () => {
        const engine = new EmailEngine(mockConfig);
        const mockSend = vi.fn().mockResolvedValue({ success: true, messageId: 'test-id' });
        (engine as any).provider.send = mockSend;

        const req = {
            to: ['user@example.com'],
            subject: 'Test Subject',
            html: '<h1>Test</h1>'
        };

        const result = await engine.send(req);
        expect(result.success).toBe(true);
        expect(result.messageId).toBe('test-id');
        expect(mockSend).toHaveBeenCalled();
    });
});
