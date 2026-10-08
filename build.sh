#!/usr/bin/env bash
# Checks and builds GlideDock into a zip for extensions.gnome.org.
#
#   ./build.sh             lint, compile schemas and pack ./<uuid>.zip
#   ./build.sh --install   ...then install the zip for the current user
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

fail() { echo "error: $*" >&2; exit 1; }

for tool in gnome-extensions glib-compile-schemas gjs msgfmt zip unzip python3; do
    command -v "$tool" > /dev/null || fail "'$tool' is not installed"
done

sources=(extension.js prefs.js lib/*.js)

# --- Metadata -----------------------------------------------------------------

python3 -m json.tool metadata.json > /dev/null || fail "metadata.json is not valid JSON"
field() { python3 -c 'import json, sys; print(json.load(open("metadata.json")).get(sys.argv[1], ""))' "$1"; }
uuid=$(field uuid)
[ -n "$uuid" ] || fail "metadata.json has no uuid"
[ -n "$(field url)" ] || fail "metadata.json has no url"
case "$uuid" in
    *@local) fail "uuid '$uuid' still uses the placeholder namespace '@local'" ;;
esac
[ -f LICENSE ] || fail "LICENSE is missing"
[ -f stylesheet.css ] || fail "stylesheet.css is missing"

# --- Lint ---------------------------------------------------------------------

# Syntax: every source file must parse as an ES module.
gjs tools/check-syntax.js "${sources[@]}" || fail "syntax errors"

# Review rules: things extensions.gnome.org rejects, or that break between
# shell versions. Each entry is "extended regex<TAB>why".
rules=(
    $'\\beval\\(|new Function\\(\tdynamic code execution'
    $'Subprocess|spawn_|GLib\\.spawn\trunning external commands'
    $'gi://Soup|XMLHttpRequest|fetch\\(\tnetwork access'
    $'console\\.(log|debug)\\(\tdebug logging'
    $'\\bimports\\.\tlegacy imports'
    $'\\b(Main|global)\\.[A-Za-z.]*\\._[A-Za-z]\tprivate shell API'
)
violations=0
for rule in "${rules[@]}"; do
    pattern=${rule%%$'\t'*}
    reason=${rule#*$'\t'}
    if matches=$(grep -nE "$pattern" "${sources[@]}"); then
        echo "lint: $reason:" >&2
        echo "$matches" | sed 's/^/  /' >&2
        violations=1
    fi
done
[ "$violations" -eq 0 ] || fail "lint failed"

# ESLint is optional; use it when the project has been set up for it.
if command -v eslint > /dev/null && ls eslint.config.* > /dev/null 2>&1; then
    eslint "${sources[@]}" || fail "eslint failed"
fi

# --- Translations -------------------------------------------------------------

for po in po/*.po; do
    msgfmt --check -o /dev/null "$po" 2> /dev/null || fail "$po has errors (run msgfmt --check on it)"
done

# --- Schemas ------------------------------------------------------------------

# Validates the schema and lets the extension run straight from this directory.
glib-compile-schemas --strict schemas/

# --- Pack ---------------------------------------------------------------------

# pack picks up metadata.json, extension.js, prefs.js, stylesheet.css and schemas/
# by itself, and compiles po/*.po into locale/.
zip_path="$uuid.zip"
rm -f "$zip_path"
gnome-extensions pack --force --out-dir . --podir=po \
    --extra-source=lib --extra-source=icons --extra-source=LICENSE .
mv -f "$uuid.shell-extension.zip" "$zip_path"

# GNOME 44+ compiles schemas at install time, so the compiled copy is dead
# weight in the upload.
if unzip -Z1 "$zip_path" | grep -qx 'schemas/gschemas.compiled'; then
    zip -q -d "$zip_path" schemas/gschemas.compiled
fi

domain=$(field gettext-domain)
locales=()
for po in po/*.po; do
    locales+=("locale/$(basename "$po" .po)/LC_MESSAGES/$domain.mo")
done
for file in metadata.json stylesheet.css LICENSE icons/*.svg "${sources[@]}" "${locales[@]}"; do
    unzip -Z1 "$zip_path" | grep -qx "$file" || fail "$file did not make it into $zip_path"
done

echo "Packed $zip_path ($(du -h "$zip_path" | cut -f1)):"
unzip -Z1 "$zip_path" | grep -v '/$' | sed 's/^/  /'
echo "Upload it at https://extensions.gnome.org/upload/"

# --- Install ------------------------------------------------------------------

if [ "${1:-}" = "--install" ]; then
    # install --force replaces the target directory, so never run it from there.
    target="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"
    if [ "$(readlink -f "$target")" = "$PWD" ]; then
        fail "refusing to install over the source directory $PWD"
    fi
    gnome-extensions install --force "$zip_path"
    echo "Installed to $target"
    echo "Log out and back in (Wayland) to load the new code, then:"
    echo "  gnome-extensions enable $uuid"
fi
