#!/bin/sh
# PDF/A-3b of the generated PDFs checked with veraPDF (ADR 0006/0007): letters (offer, invoice
# draft and final), site sheets/reports and a ZUGFeRD invoice with factur-x.xml. The PDFs come
# from the unit tests (PDF_SAMPLE_DIR); veraPDF runs in its official container, pinned by tag +
# digest. Not part of the running stack – only CI and local checks.
#
# Usage: sh infra/check-pdfa.sh   (needs Docker and Typst, like the unit tests)
set -eu

image=${VERAPDF_IMAGE:-verapdf/cli:v1.30.4@sha256:c2ac9448973a56acd833c81441e38d2dca58ea26a2ce1621e9a32e85d3d2728f}
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

PDF_SAMPLE_DIR="$dir" pnpm exec vitest run packages/pdf-templates packages/einvoice/src/facturx.test.ts >/dev/null
chmod -R a+rX "$dir"  # the container runs as an unprivileged user
count=$(find "$dir" -name '*.pdf' | wc -l)
if [ "$count" -lt 4 ]; then
  echo "Zu wenige Beispiel-PDFs erzeugt ($count)." >&2
  exit 1
fi

result=$(docker run --rm -v "$dir:/data:ro" "$image" --format text /data)
echo "$result"
if echo "$result" | grep -qv '^PASS '; then
  echo "veraPDF: nicht alle PDFs sind gültiges PDF/A-3b." >&2
  exit 1
fi
echo "veraPDF: $count PDFs gültig (PDF/A-3b)."
