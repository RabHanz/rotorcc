#!/usr/bin/env bash
# Refuse to let anything private into a public tool.
#
# Run before every commit. Any hit is a bug, not a judgement call: this package
# is meant to know nothing about the machine it was written on beyond what its
# own config file tells it at runtime.
set -uo pipefail
cd "$(dirname "$0")/.."

# Terms that must never appear: private hostnames, IPs, internal project and org
# names, personal accounts, private repository conventions.
PATTERNS=(
  'VentureOS'
  'venturectl'
  'ventureos'
  # The GitHub owner handle is deliberately NOT in this list. It is the
  # package's own published identity — package.json's repository, homepage and
  # bugs fields point at it, npm renders all three, and a package whose source
  # cannot be found is a package nobody should install. Everything below is
  # different: private hosts, private projects, and personal accounts that have
  # no business being in a public tool.
  'onnyx'
  'signzart'
  'rabeehanzla'
  'optimapacifist'
  'meliura'
  'Meliura'
  'whop'
  'Whop'
  'WHOP'
  'dokploy'
  'Dokploy'
  'hetzner'
  'Hetzner'
  'AGENTS\.md'
  '\.review/'
  'pnpm venturectl'
  'transport-audit'
  '178\.156\.'
  '/srv/vos'
  'vos-rotor'
  'claude-rotor'
  '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}'
)

fail=0
for pattern in "${PATTERNS[@]}"; do
  # Exclude this script itself, which necessarily contains the pattern list.
  hits="$(grep -rInE "$pattern" . \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
    --exclude=leak-audit.sh --exclude=package-lock.json 2>/dev/null)"
  if [ -n "$hits" ]; then
    echo "LEAK: /$pattern/"
    echo "$hits" | sed 's/^/    /'
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "leak audit: clean (${#PATTERNS[@]} patterns, no hits)"
fi
exit "$fail"
