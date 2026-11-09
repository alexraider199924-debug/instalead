#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 /path/to/extension https://example.com" >&2
  exit 1
fi

EXT_DIR="$1"
ORIGIN="${2%/}"
API="${ORIGIN}/api"

for file in "$EXT_DIR/background.js" "$EXT_DIR/content.js" "$EXT_DIR/popup.js"; do
  if [[ -f "$file" ]]; then
    sed -i -E "s#https?://localhost:3002/api#${API}#g" "$file"
  fi
done

node - "$EXT_DIR/manifest.json" "$ORIGIN" <<'NODE'
const fs = require('fs');
const [manifestPath, origin] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const urlPattern = `${origin}/*`;
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), urlPattern])];
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
NODE

echo "Extension configured for $ORIGIN"
