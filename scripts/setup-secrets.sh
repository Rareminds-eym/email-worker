#!/bin/bash
set -euo pipefail

ENVS=("development" "staging" "production")

SECRETS=(
  "API_KEY"
  "AWS_ACCESS_KEY_ID"
  "AWS_SECRET_ACCESS_KEY"
  "DEFAULT_FROM_EMAIL"
  "DEFAULT_FROM_NAME"
)

if [ $# -ge 1 ]; then
  ENVS=("$1")
fi

for ENV in "${ENVS[@]}"; do
  echo ""
  echo "=== Setting secrets for environment: $ENV ==="
  for SECRET in "${SECRETS[@]}"; do
    echo -n "Enter value for $SECRET (leave blank to skip): "
    read -r VALUE
    if [ -n "$VALUE" ]; then
      echo "$VALUE" | wrangler secret put "$SECRET" --env "$ENV"
      echo "✓ $SECRET set for $ENV"
    else
      echo "  Skipped $SECRET"
    fi
  done
done

echo ""
echo "Done. Run 'npm run secrets:list:<env>' to verify."
