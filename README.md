# Shared Email API Worker 📧

A high-performance, industrial-grade Cloudflare Worker providing a highly available email sending API via AWS SES v2.

This repository enforces a strict, purely stateless architecture utilizing Cloudflare's V8 Isolates and Native Rate Limiter hooks designed to maintain microsecond latency under heavy concurrent loads.

## 🚀 Features
- **AWS SES v2 & `aws4fetch`**: Fully native HMAC-SHA256 signature alignment.
- **Single-Worker Topology**: A consolidated `wrangler.toml` configuration preventing dashboard fragmentation.
- **Hardware Timeouts & Fail-safes**: Integrated `AbortSignal.timeout` ceilings and universal `try...catch` failsafes returning deterministic JSON unconditionally.
- **Tenant Rate Isolation**: Three-tier limits (20/min via Native Limiter, 500/hr, 5000/day via KV), explicitly scoped to individual API keys.
- **Security Defenses**:
  - `Content-Length` hardcapped at 2MB.
  - Comma-injection prevention in all SMTP headers.
  - JSON parse bombs explicitly mapped to `400 ValidationError`.
- **Global CORS & Tracing**: Every response is stamped with `X-Request-Id` reflecting Cloudflare's internal `cf-ray` metrics.
- **Idempotency Locks**: Network drops are resolved seamlessly using an `Idempotency-Key` tracking system across a 24-hour TTL window.

## 📦 Deployment Strategy

Deployment is managed universally for the `shared-email-api` instance.

### 1. Provision KV Namespaces (First Time Only)
Create the KV namespace and rate-limiter bindings and attach their identifiers to your `wrangler.toml`:
```bash
npm run kv:create
```

### 2. Configure Secrets
Run the interactive setup script to vault your AWS credentials without leaking them to bash history:
```bash
npm run secrets:setup
```

### 3. Deploy
Launch the unified instance to Cloudflare:
```bash
npm run deploy
```

## 🔌 API Usage

The API rejects unauthenticated requests. You must include your API Key via the standard `Authorization: Bearer <key>`, `X-API-Key`, or `X-Internal-Api-Key` headers.

### `POST /send`

```json
{
  "to": ["user@example.com"],
  "subject": "Welcome to Skill Passport!",
  "html": "<h1>Welcome</h1><p>We are glad to have you.</p>",
  "text": "Fallback text for terminal clients", // heavily recommended!
  "from": "onboarding@rareminds.in",
  "fromName": "Skill Passport Team",
  "replyTo": "support@rareminds.in"
}
```

#### Safe Retry Pattern (Idempotency)
Provide an `Idempotency-Key` UUID. If your network connection drops while AWS processes the email, a subsequent retry will return `200 OK` from the KV Cache instead of double-sending the email to the user.
```bash
curl -X POST https://api.yourdomain.com/send \
  -H "Content-Type: application/json" \
  -H "X-Internal-Api-Key: your_super_secret_key" \
  -H "Idempotency-Key: e49a3-5c2b-45... " \
  -d '{"to": "test@example.com", "subject": "Test", "html": "<p>Hello</p>"}'
```

### `GET /health`
A public diagnostic probe endpoint that returns a flat `{ "status": "ok" }`. 

### `GET /internal/health`
An authenticated endpoint that maps out the live topology of internal Worker systems:
- Pings the AWS SES `GetAccount` APIs.
- Queries `RATE_LIMIT_KV` accessibility.
- Validates the structural integrity of Cloudflare Native limiters.

## 🛠 Internal Architecture Notes
- **O(1) Memory Engine:** String concatenation in V8 limits scalable throughput. This system binds raw `node:buffer` structs natively via the `nodejs_compat` boundary to parse base64 payloads iteratively.
- **Engine Isolates:** The `EmailEngine` caches per-isolate but checks strict rotational hashes of your AWS keys before execution.
- **503 Degradation:** Any AWS degradation prompts the worker to intercept the drop, classify the HTTP Status, and return a clean `503 Service Unavailable` with a `Retry-After: 30` header back to your triggering microservices.
