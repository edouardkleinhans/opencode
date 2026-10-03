#!/bin/bash
# Mechanical beta-to-stable promotion is intentionally disabled. Each release
# needs reviewed channel identity, migration and release-note handling.

set -euo pipefail

cat >&2 <<'EOF'
error: beta-to-stable copying is disabled.

Stable 3.0 adopted the reviewed V2 implementation from beta. Future promotion
still requires review: preserve stable identity/storage, reconcile migrations
and options, consolidate the stable changelog, and run the release checks.

Use scripts/check-addon-options.sh for per-channel option validation.
EOF
exit 1
