#!/bin/bash
set -euo pipefail


SECRETS=(
  "API_KEY"
  "AWS_ACCESS_KEY_ID"
  "AWS_SECRET_ACCESS_KEY"
  "DEFAULT_FROM_EMAIL"
  "DEFAULT_FROM_NAME"
)

echo ""
echo "=== Setting secrets for shared-email-api ==="
for SECRET in "${SECRETS[@]}"; do
  echo -n "Enter value for $SECRET (leave blank to skip): "
  read -rs VALUE
  echo ""
  if [ -n "$VALUE" ]; then
    echo "$VALUE" | wrangler secret put "$SECRET"
    echo "✓ $SECRET set"
  else
    echo "  Skipped $SECRET"
  fi
done

echo ""
echo "Done. Run 'npm run secrets:list' to verify."
