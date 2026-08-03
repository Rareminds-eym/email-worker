# Shared Email & OTP API

A Cloudflare Worker that provides email sending via AWS SES and phone number OTP verification via MessageCentral. Built with `itty-router` and TypeScript, deployed on Cloudflare's edge network.

> Note: the worker name in `package.json` and `wrangler.toml` is `shared-email-api` (the original name before OTP was added). This is the Cloudflare deployment identifier and does not need to match the display name.
> 

---

## Table of Contents

1. [Prerequisites](https://www.notion.so/35f567f8353980ecb096de1965907113?pvs=21)
2. [Project Structure](https://www.notion.so/35f567f8353980ecb096de1965907113?pvs=21)
3. [Local Setup](https://www.notion.so/35f567f8353980ecb096de1965907113?pvs=21)
4. [Environment Variables](https://www.notion.so/35f567f8353980ecb096de1965907113?pvs=21)
5. [Cloudflare Resources](https://www.notion.so/35f567f8353980ecb096de1965907113?pvs=21)
6. [Running Locally](https://www.notion.so/35f567f8353980ecb096de1965907113?pvs=21)
7. [Deploying to Production](https://www.notion.so/35f567f8353980ecb096de1965907113?pvs=21)
8. [API Reference](https://www.notion.so/35f567f8353980ecb096de1965907113?pvs=21)
9. [Authentication](https://www.notion.so/35f567f8353980ecb096de1965907113?pvs=21)
10. [Rate Limits](https://www.notion.so/35f567f8353980ecb096de1965907113?pvs=21)
11. [Testing](https://www.notion.so/35f567f8353980ecb096de1965907113?pvs=21)
12. [Monitoring & Logs](https://www.notion.so/35f567f8353980ecb096de1965907113?pvs=21)
13. [Error Codes](https://www.notion.so/35f567f8353980ecb096de1965907113?pvs=21)

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [npm](https://www.npmjs.com/) v9+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (installed via devDependencies)
- A Cloudflare account with Workers enabled
- AWS account with SES access (verified sender identity required)
- MessageCentral account (for OTP features)

---

## Project Structure

```
shared-email-api/
├── src/
│   ├── index.ts                  # Worker entry point, router setup
│   ├── types.ts                  # TypeScript interfaces and error classes
│   ├── constants.ts              # App constants, CORS config, rate limit values
│   ├── config/
│   │   └── config.ts             # Builds EmailConfig from env bindings
│   ├── core/
│   │   └── EmailEngine.ts        # Retry logic, message building
│   ├── middleware/
│   │   ├── auth.ts               # API key authentication
│   │   ├── logger.ts             # Structured JSON logging
│   │   ├── rateLimit.ts          # 3-tier rate limiting (minute/hour/day)
│   │   ├── validator.ts          # Email request validation
│   │   ├── otpRateLimit.ts       # Per-phone OTP rate limiting
│   │   └── otpValidator.ts       # Phone number / OTP code validation
│   ├── providers/
│   │   ├── BaseProvider.ts       # Abstract provider with error classification
│   │   └── SESProvider.ts        # AWS SES v2 implementation
│   ├── routes/
│   │   ├── send.ts               # POST /send handler
│   │   ├── otp.ts                # POST /otp/send and /otp/verify handlers
│   │   └── health.ts             # GET /health and /internal/health handlers
│   └── services/
│       └── MessageCentralService.ts  # MessageCentral OTP API client
├── scripts/
│   ├── setup-secrets.sh          # Interactive CLI script to set Wrangler secrets
│   └── test-email.ts             # Manual email send test script
├── .dev.vars.example             # Template for local environment variables
├── wrangler.toml                 # Cloudflare Worker configuration
├── tsconfig.json                 # TypeScript configuration
└── package.json
```

---

## Local Setup

**1. Clone and install dependencies**

```bash
git clone <repo-url>
cd shared-email-api
npm install
```

**2. Create your local environment file**

```bash
cp .dev.vars.example .dev.vars
```

Then open `.dev.vars` and fill in all required values (see [Environment Variables](https://www.notion.so/35f567f8353980ecb096de1965907113?pvs=21) below).

---

## Environment Variables

### Local Development (`.dev.vars`)

These are loaded automatically by `wrangler dev`. Never commit this file.

| Variable | Required | Description |
| --- | --- | --- |
| `API_KEY` | Yes | Shared secret for authenticating API requests |
| `AWS_ACCESS_KEY_ID` | Yes | AWS IAM access key with SES send permissions |
| `AWS_SECRET_ACCESS_KEY` | Yes | AWS IAM secret key |
| `AWS_REGION` | Yes | AWS region where SES is configured (e.g. `ap-south-1`) |
| `DEFAULT_FROM_EMAIL` | Yes | Verified sender email address in SES |
| `DEFAULT_FROM_NAME` | Yes | Display name for the sender |
| `MESSAGECENTRAL_CUSTOMER_ID` | Yes (OTP) | Your MessageCentral customer ID |
| `MESSAGECENTRAL_KEY` | Yes (OTP) | Long-lived JWT token from MessageCentral |
| `MESSAGECENTRAL_EMAIL` | Yes (OTP) | MessageCentral account email |
| `MESSAGECENTRAL_COUNTRY_CODE` | No | Default country code (defaults to `91`) |
| `ALLOWED_ORIGINS` | Yes | Comma-separated list of allowed CORS origins. Set in `wrangler.toml` `[vars]` — update the value there to add or remove domains. Whitespace is trimmed, empty entries are ignored, entries without `http://` or `https://` are rejected. |

Example `.dev.vars`:

```
API_KEY=my_local_dev_secret
AWS_ACCESS_KEY_ID=YOUR_AWS_ACCESS_KEY_ID_HERE
AWS_SECRET_ACCESS_KEY=WS_SECRET_ACCESS_KEY_EXAMPLEKEY
AWS_REGION=ap-south-1
DEFAULT_FROM_EMAIL=noreply@yourdomain.com
DEFAULT_FROM_NAME=Your App Name
MESSAGECENTRAL_CUSTOMER_ID=C-XXXXXXXX
MESSAGECENTRAL_KEY=MESSAGECENTRAL_KEY_HERE
MESSAGECENTRAL_EMAIL=admin@yourdomain.com
ALLOWED_ORIGINS=http://localhost:5173,<http://localhost:8788>
```

### Production Secrets

In production, variables are stored as Cloudflare Worker secrets (encrypted at rest). Use the interactive setup script:

```bash
npm run secrets:setup
```

Or set them individually:

```bash
wrangler secret put API_KEY
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY
wrangler secret put DEFAULT_FROM_EMAIL
wrangler secret put DEFAULT_FROM_NAME
wrangler secret put MESSAGECENTRAL_CUSTOMER_ID
wrangler secret put MESSAGECENTRAL_KEY
wrangler secret put MESSAGECENTRAL_EMAIL
```

Verify secrets are set:

```bash
npm run secrets:list
```

---

## Cloudflare Resources

### KV Namespace (Rate Limiting)

The worker uses a KV namespace for hourly and daily rate limit counters.

**Create the namespace:**

```bash
npm run kv:create
```

This outputs two IDs — update `wrangler.toml` with them:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "your-production-kv-id"
preview_id = "your-preview-kv-id"
```

### Rate Limiter Binding

The per-minute rate limiter uses Cloudflare's native Rate Limiting API. It is already configured in `wrangler.toml`:

```toml
[[ratelimits]]
name = "RATE_LIMITER_MINUTE"
namespace_id = "10030"
simple = { limit = 20, period = 60 }
```

The `namespace_id` is a Cloudflare account-level resource. If you're setting this up fresh, create a rate limit namespace in the Cloudflare dashboard and update the ID.

---

## Running Locally

```bash
npm run dev
```

The worker starts at `http://localhost:8787` by default. Wrangler automatically loads `.dev.vars` for secrets.

**Type checking (without running):**

```bash
npm run type-check
```

---

## Deploying to Production

Make sure all secrets are set (see above), then:

```bash
npm run deploy
```

**Watch live logs after deploy:**

```bash
npm run tail
```

---

## API Reference

All authenticated endpoints require an API key (see [Authentication](https://www.notion.so/35f567f8353980ecb096de1965907113?pvs=21)).

### `GET /`

Returns service info and available endpoints. No authentication required.

---

### `GET /health`

Public health check.

**Response:**

```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "version": "1.0.0"
}
```

---

### `GET /internal/health`

Detailed health check including AWS credentials, KV store, and rate limiter status. Requires authentication.

**Response:**

```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "version": "1.0.0",
  "checks": {
    "aws": { "status": "ok" },
    "kv": { "status": "ok" },
    "rateLimit": { "status": "ok" }
  }
}
```

---

### `POST /send`

Send an email via AWS SES.

**Headers:**

```
Content-Type: application/json
X-Internal-Api-Key: <your-api-key>
```

**Request body:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `to` | `string \| string[]` | Yes | Recipient email(s), max 50 |
| `subject` | `string` | Yes | Email subject, max 998 chars |
| `html` | `string` | Yes | HTML body, max 1MB |
| `text` | `string` | No | Plain text fallback (auto-generated from HTML if omitted) |
| `from` | `string` | No | Override sender email (must be SES-verified) |
| `fromName` | `string` | No | Override sender display name |
| `replyTo` | `string` | No | Reply-to address |
| `cc` | `string[]` | No | CC recipients |
| `bcc` | `string[]` | No | BCC recipients |
| `metadata` | `object` | No | Arbitrary metadata for logging (max 4KB, not sent to SES) |

**Optional header:**

- `Idempotency-Key: <unique-key>` — Prevents duplicate sends. Cached for 24 hours.

**Example:**

```bash
curl -X POST <https://your-worker.workers.dev/send> \\
  -H "Content-Type: application/json" \\
  -H "X-Internal-Api-Key: your-api-key" \\
  -d '{
    "to": "user@example.com",
    "subject": "Welcome",
    "html": "<h1>Hello!</h1>",
    "text": "Hello!"
  }'
```

**Success response (200):**

```json
{
  "success": true,
  "messageId": "ses-message-id",
  "customMessageId": "<uuid@yourdomain.com>",
  "recipient": ["user@example.com"],
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

### `POST /otp/send`

Send an OTP to a phone number via SMS, WhatsApp, or RCS.

**Request body:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `mobileNumber` | `string` | Yes | Phone number without country code |
| `countryCode` | `string` | No | Country code digits (default: `91`) |
| `flowType` | `string` | No | `SMS`, `WHATSAPP`, or `RCS` (default: `SMS`) |

**Example:**

```bash
curl -X POST <https://your-worker.workers.dev/otp/send> \\
  -H "Content-Type: application/json" \\
  -H "X-Internal-Api-Key: your-api-key" \\
  -d '{
    "mobileNumber": "9876543210",
    "countryCode": "91",
    "flowType": "SMS"
  }'
```

**Success response (200):**

```json
{
  "success": true,
  "verificationId": "VER123456",
  "timeout": "60",
  "message": "OTP sent successfully"
}
```

---

### `POST /otp/verify`

Verify an OTP code.

**Request body:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `mobileNumber` | `string` | Yes | Same number used in `/otp/send` |
| `verificationId` | `string` | Yes | ID returned from `/otp/send` |
| `code` | `string` | Yes | 4–6 digit OTP code |
| `countryCode` | `string` | No | Country code (default: `91`) |

**Example:**

```bash
curl -X POST <https://your-worker.workers.dev/otp/verify> \\
  -H "Content-Type: application/json" \\
  -H "X-Internal-Api-Key: your-api-key" \\
  -d '{
    "mobileNumber": "9876543210",
    "verificationId": "VER123456",
    "code": "123456",
    "countryCode": "91"
  }'
```

**Success response (200):**

```json
{
  "success": true,
  "verified": true,
  "message": "Phone number verified successfully"
}
```

---

## Authentication

All routes except `GET /` and `GET /health` require an API key. Send it using any of these headers (checked in this priority order):

```
X-Internal-Api-Key: your-api-key        # preferred
X-API-Key: your-api-key                 # accepted
Authorization: Bearer your-api-key      # RFC 6750 fallback
```

Missing or invalid keys return HTTP `401`.

---

## Rate Limits

### Email (`POST /send`)

Three-tier enforcement per API key:

| Window | Limit |
| --- | --- |
| Per minute | 20 requests (Cloudflare native rate limiter) |
| Per hour | 500 requests (KV-based) |
| Per day | 5,000 requests (KV-based) |

Exceeded limits return HTTP `429` with a `Retry-After` header.

### OTP (in-memory, per worker instance)

| Endpoint | Limit |
| --- | --- |
| `POST /otp/send` | 3 requests per minute per phone number |
| `POST /otp/verify` | 5 attempts per minute per verification ID |

### CORS

Allowed origins are controlled by the `ALLOWED_ORIGINS` variable in `wrangler.toml` under `[vars]`. To add or remove a domain, update that value and redeploy — no secrets setup needed. In production, localhost origins are always blocked regardless of the value.

Invalid entries (missing protocol, typos, extra whitespace) are silently ignored. If you're debugging a CORS issue, verify each entry starts with `http://` or `https://` and matches the exact origin the browser sends (scheme + hostname + port if non-standard). Use `wrangler tail` to see the `Origin` header on a blocked request.

---

## Testing

**Run the manual email test script against local or production:**

```bash
# Against local dev server (default)
npx tsx scripts/test-email.ts

# Against production
API_URL=https://your-worker.workers.dev API_KEY=your-key npx tsx scripts/test-email.ts
```

**Run unit tests:**

```bash
npm test
```

---

## Monitoring & Logs

**Stream live logs:**

```bash
npm run tail
# or
wrangler tail
```

All logs are emitted as structured JSON. Key fields: `timestamp`, `level`, `message`, `method`, `url`, `status`, `duration`.

**Cloudflare dashboard:** Workers & Pages > your worker > Logs tab for historical logs and metrics.

---

## Error Codes

| Code | HTTP Status | Description |
| --- | --- | --- |
| `AUTH_ERROR` | 401 | Missing or invalid API key |
| `RATE_LIMIT_ERROR` | 429 | Rate limit exceeded |
| `VALIDATION_ERROR` | 400 | Invalid request body or parameters |
| `PROVIDER_ERROR` | 500/503 | AWS SES returned an error |
| `OTP_ERROR` | 400 | Generic OTP failure |
| `INVALID_REQUEST` | 400 | Invalid phone number or parameters |
| `OTP_ALREADY_SENT` | 409 | OTP already sent, wait before retrying |
| `RATE_LIMIT_EXCEEDED` | 429 | MessageCentral rate limit hit |
| `INVALID_OTP` | 400 | Wrong OTP code entered |
| `OTP_EXPIRED` | 400 | OTP has expired, request a new one |
| `ALREADY_VERIFIED` | 400 | Phone number already verified |
| `CONFIG_ERROR` | 500 | Missing or invalid service configuration |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

---

## License

Proprietary — All rights reserved.