#!/bin/sh
# Builds the source tree for the handbook site on GitHub Pages (Jekyll, theme just-the-docs).
# The Markdown in docs/handbuch and docs/self-hosting stays the single source: this script only
# copies it, adds front matter for the navigation and rewrites links that point outside the site.
#
# Usage: sh docs/site/build.sh <output dir> [repository url] [site url]
# The site url (e.g. https://owner.github.io/Repo) sets url and baseurl explicitly; otherwise the
# GitHub Pages build asks the Pages API for them, which the workflow token may not read.
set -eu

out=${1:?Ausgabeverzeichnis fehlt}
repo=${2:-https://github.com/VIONYT/OpenPlancraft}
site=${3:-}
root=$(cd "$(dirname "$0")/../.." && pwd)

rm -rf "$out"
mkdir -p "$out/screenshots"
cp -R "$root/docs/site/_config.yml" "$root/docs/site/_includes" "$root/docs/site/_sass" "$out/"
cp "$root"/docs/screenshots/*.png "$out/screenshots/"
if [ -n "$site" ]; then
  origin=$(printf '%s' "$site" | sed -E 's#^(https?://[^/]+).*#\1#')
  base=$(printf '%s' "$site" | sed -E 's#^https?://[^/]+##; s#/$##')
  printf '\nurl: "%s"\nbaseurl: "%s"\n' "$origin" "$base" >> "$out/_config.yml"
fi

# $1 source, $2 target name, $3 nav order, $4 navigation title
page() {
  {
    printf -- '---\ntitle: "%s"\nnav_order: %s\n---\n\n' "$4" "$3"
    sed \
      -e 's#](\.\./screenshots/#](screenshots/#g' \
      -e 's#](\.\./self-hosting/README\.md#](betrieb.md#g' \
      -e "s#](\.\./adr/#](${repo}/blob/main/docs/adr/#g" \
      -e "s#](\.\./\.\./#](${repo}/blob/main/#g" \
      "$1"
  } > "$out/$2"
}

page "$root/docs/handbuch/README.md" index.md 1 "Start"
order=2
for file in "$root"/docs/handbuch/[0-9][0-9]-*.md; do
  title=$(sed -n '1s/^# *//p' "$file")
  page "$file" "$(basename "$file")" "$order" "$title"
  order=$((order + 1))
done
page "$root/docs/self-hosting/README.md" betrieb.md 50 "Betrieb (Server)"

echo "Handbuch-Quelle in $out"
