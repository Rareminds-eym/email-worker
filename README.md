# Shared Email & OTP API

Enterprise-grade Cloudflare Worker for email sending (AWS SES) and phone number verification (MessageCentral OTP).

## Features

### Email Service
- AWS SES integration for reliable email delivery
- HTML and plain text email support
- CC/BCC support
- Custom reply-to addresses
- Rate limiting and authentication

### OTP Service
- SMS, WhatsApp, and RCS OTP delivery
- Phone number validation and sanitization
- Rate limiting (3 sends per minute, 5 verifications per minute)
- Token caching for optimal performance
- Comprehensive error handling

## API Endpoints

### Email

#### POST /send
Send an email via AWS SES.

```bash
curl -X POST https://your-worker.workers.dev/send \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "recipient@example.com",
    "subject": "Test Email",
    "html": "<h1>Hello World</h1>",
    "text": "Hello World"
  }'
```

### OTP

#### POST /otp/send
Send OTP to a phone number.

```bash
curl -X POST https://your-worker.workers.dev/otp/send \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "mobileNumber": "9876543210",
    "countryCode": "91",
    "flowType": "SMS"
  }'
```

Response:
```json
{
  "success": true,
  "verificationId": "VER123456",
  "timeout": "60",
  "message": "OTP sent successfully"
}
```

#### POST /otp/verify
Verify OTP code.

```bash
curl -X POST https://your-worker.workers.dev/otp/verify \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "mobileNumber": "9876543210",
    "verificationId": "VER123456",
    "code": "123456",
    "countryCode": "91"
  }'
```

Response:
```json
{
  "success": true,
  "verified": true,
  "message": "Phone number verified successfully"
}
```

### Health Checks

#### GET /health
Public health check endpoint.

#### GET /internal/health
Detailed health check (requires authentication).

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.dev.vars.example` to `.dev.vars` and fill in your credentials:

```bash
cp .dev.vars.example .dev.vars
```

Required variables:
- `API_KEY` - Your API authentication key
- `AWS_ACCESS_KEY_ID` - AWS access key for SES
- `AWS_SECRET_ACCESS_KEY` - AWS secret key for SES
- `AWS_REGION` - AWS region (e.g., us-east-1)
- `DEFAULT_FROM_EMAIL` - Default sender email
- `DEFAULT_FROM_NAME` - Default sender name
- `MESSAGECENTRAL_CUSTOMER_ID` - MessageCentral customer ID
- `MESSAGECENTRAL_KEY` - MessageCentral API key (base64 encoded)
- `MESSAGECENTRAL_EMAIL` - MessageCentral account email

### 3. Configure Cloudflare Resources

Update `wrangler.toml` with your KV namespace IDs:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "your-kv-namespace-id"
```

### 4. Deploy

```bash
# Development
npm run dev

# Production
npm run deploy
```

## Architecture

### Directory Structure

```
src/
├── config/          # Configuration management
├── core/            # Core email engine
├── middleware/      # Authentication, validation, rate limiting
├── providers/       # Email provider implementations (SES)
├── routes/          # API route handlers
├── services/        # External service integrations (MessageCentral)
├── types.ts         # TypeScript type definitions
├── constants.ts     # Application constants
└── index.ts         # Main worker entry point
```

### Key Components

1. **MessageCentralService** - Handles OTP operations with token caching
2. **OTP Validators** - Input validation and sanitization
3. **OTP Rate Limiter** - Prevents abuse with per-phone-number limits
4. **Error Handling** - Comprehensive error types and responses

## Security Features

- API key authentication on all endpoints
- CORS protection with configurable origins
- Rate limiting per phone number
- Input validation and sanitization
- Secure credential storage in Cloudflare secrets
- Error masking (no internal details exposed)

## Rate Limits

### OTP Operations
- Send OTP: 3 requests per minute per phone number
- Verify OTP: 5 attempts per minute per verification ID

### Email Operations
- Configurable via Cloudflare Rate Limiting

## Error Codes

### OTP Errors
- `INVALID_REQUEST` - Invalid phone number or parameters
- `OTP_ALREADY_SENT` - OTP already sent, wait before retry
- `RATE_LIMIT_EXCEEDED` - Too many requests
- `INVALID_OTP` - Wrong OTP code
- `OTP_EXPIRED` - OTP has expired
- `ALREADY_VERIFIED` - Phone already verified
- `CONFIG_ERROR` - Service configuration issue

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test MessageCentralService.test.ts
```

## Development

```bash
# Start development server
npm run dev

# Type checking
npm run typecheck

# Linting
npm run lint
```

## Production Deployment

1. Set production secrets in Cloudflare dashboard or via CLI:

```bash
wrangler secret put API_KEY
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY
wrangler secret put MESSAGECENTRAL_CUSTOMER_ID
wrangler secret put MESSAGECENTRAL_KEY
wrangler secret put MESSAGECENTRAL_EMAIL
```

2. Deploy:

```bash
npm run deploy
```

## Monitoring

- Check logs: `wrangler tail`
- Monitor rate limits in Cloudflare dashboard
- Track OTP success/failure rates via logs

## Support

For issues or questions, please check the documentation or contact support.

## License

Proprietary - All rights reserved
