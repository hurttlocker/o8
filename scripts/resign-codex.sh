#!/usr/bin/env bash
#
# resign-codex.sh — re-sign the bundled codex native binaries ad-hoc so macOS 26+
# stops killing them at launch with "Code Signature Invalid" (SIGKILL at
# dyld_start). The npm @openai/codex vendor binary cross-validates badly under
# macOS 26's runtime code-signing enforcement even though `codesign --verify`
# passes statically — the result is every Codex dispatch dying on launch
# (lane cycles launching -> idle -> launch_attempts_exhausted).
#
# This is an ENVIRONMENT fix, not an o8 bug. Re-run it after every
# `npm update -g @openai/codex` — an update restores the original signature and
# re-breaks it.
#
#   bash scripts/resign-codex.sh
#
set -uo pipefail

PKG="$(npm root -g 2>/dev/null)/@openai/codex"
[ -d "$PKG" ] || { echo "✗ @openai/codex not installed globally (checked: $PKG)" >&2; exit 1; }

echo "re-signing codex native binaries under $PKG …"
COUNT=0
while IFS= read -r bin; do
  if codesign --force --sign - "$bin" 2>/dev/null; then
    echo "  ✓ $bin"
    COUNT=$((COUNT + 1))
  fi
done < <(find "$PKG" -type f -perm +111 \( -name codex -o -name rg \) 2>/dev/null)

# Clear provenance/quarantine xattrs that can also trip the runtime check.
find "$PKG" -type d -name vendor -exec xattr -cr {} \; 2>/dev/null || true
echo "re-signed $COUNT binaries."

echo ""
echo "verifying codex launches (isolated, plugin-free config)…"
CH="$(mktemp -d)"
cp "$HOME/.codex/auth.json" "$HOME/.codex/version.json" "$CH/" 2>/dev/null || true
if echo "ping" | CODEX_HOME="$CH" codex exec --json -c model=gpt-5.5 "Reply with OK" 2>/dev/null | grep -q 'turn.completed'; then
  echo "✓ codex launches and completes a turn — you're good."
else
  echo "⚠ codex still not completing a turn — check 'codex login' / the model manually."
fi
rm -rf "$CH"
