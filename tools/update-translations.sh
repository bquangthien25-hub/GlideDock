#!/usr/bin/env bash
# Regenerates po/glidedock.pot from the sources and merges new strings into
# every po/*.po. Run after changing any user-visible string.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."

xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ \
    --package-name=GlideDock --copyright-holder="GlideDock contributors" \
    --add-comments=Translators --no-wrap --sort-by-file \
    --output=po/glidedock.pot extension.js prefs.js lib/*.js

for po in po/*.po; do
    [ -f "$po" ] || continue
    msgmerge --quiet --update --backup=none --no-wrap "$po" po/glidedock.pot
    echo "$po: $(msgfmt --statistics -o /dev/null "$po" 2>&1)"
done
