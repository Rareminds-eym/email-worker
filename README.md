# Shared Email API Worker 📧

A high-performance, single-tenant, industrial-grade Cloudflare Worker that provides an email sending API via AWS SES.

## Features
- **AWS SES V2 Integration** for high deliverability.
- **Robust Rate Limiting**: Three-tier limits (minute via CF Native, hour/day via CF KV).
- **Security First**: API-key authenticated, single-tenant isolated, CORS-protected, and tightly validated against malicious payloads.
- **High Performance**: Native Buffer bindings for O(1) memory Base64 conversion, lazy-loaded singletons, and asynchronous telemetry.

## Deployment

Deploying is managed by Cloudflare Wrangler across three environments: `development`, `staging`, and `production`.

### 1. Configure Secrets
Run the setup script which interacts with Wrangler to load your AWS credentials and API key:
```bash
npm run secrets:setup
```

### 2. Provision KV Namespaces (First Time Only)
Create the KV namespace and update the `wrangler.toml` IDs if you are deploying to a new environment:
```bash
npm run kv:create:production
# Note output IDs and insert into wrangler.toml under [env.production.kv_namespaces]
```

### 3. Deploy
```bash
npm run deploy:production
```

## API Usage

The API is authenticated using the `X-Internal-Api-Key` header with your configured API key.

### `POST /send`

```json
{
  "to": ["user@example.com"],
  "subject": "Welcome to Skill Passport!",
  "html": "<h1>Welcome</h1><p>We are glad to have you.</p>",
  "from": "onboarding@rareminds.in",
  "fromName": "Skill Passport Team",
  "replyTo": "support@rareminds.in"
}
```

#### Curl Example
```bash
curl -X POST https://api.yourdomain.com/send \
  -H "Content-Type: application/json" \
  -H "X-Internal-Api-Key: your_super_secret_key" \
  -d '{"to": ["test@example.com"], "subject": "Test", "html": "<p>Hello World</p>"}'
```

### `GET /health`
A diagnostic probe endpoint that checks structural dependencies. Note that this endpoint redacts detailed credential validation to prevent mapping attacks.

## Architecture & Edge Cases
- **Engine Re-use:** `aws4fetch` HMAC signing uses CPU. The `EmailEngine` caches per-isolate to minimize overhead.
- **Memory Optimization:** SES payloads are strictly Base64 transferred. `Buffer.from` is utilized via `nodejs_compat` to prevent string allocation memory bombs.
- **Retries:** Configured to automatically retry 2 additional times inside the isolate under `AbortSignal.timeout` wrappers, to prevent 522 edge hangs.
