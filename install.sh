#!/bin/sh
set -eu

repository='https://github.com/Aero123421/SimpleClipboard'
api_repository='https://api.github.com/repos/Aero123421/SimpleClipboard'
asset='simpleclipboard_amd64.deb'
version=${1:-}

if ! printf '%s\n' "$version" | LC_ALL=C grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
    printf '%s\n' 'Pass an exact release version, for example: v0.2.0' >&2
    exit 1
fi

if [ "$(uname -s)" != 'Linux' ] || [ "$(uname -m)" != 'x86_64' ]; then
    printf '%s\n' 'SimpleClipboard currently supports x86_64 Linux only.' >&2
    exit 1
fi

if ! command -v gnome-shell >/dev/null 2>&1; then
    printf '%s\n' 'GNOME Shell is required.' >&2
    exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
    printf '%s\n' 'Python 3 is required to verify GitHub release metadata.' >&2
    exit 1
fi

shell_major=$(gnome-shell --version | sed -n 's/.* \([0-9][0-9]*\)\..*/\1/p')
if [ "$shell_major" != '46' ]; then
    printf '%s\n' 'SimpleClipboard currently supports GNOME Shell 46 only.' >&2
    exit 1
fi

temp_dir=$(mktemp -d)
trap 'rm -rf -- "$temp_dir"' EXIT HUP INT TERM

curl --proto '=https' --tlsv1.2 -fsSLo "$temp_dir/release.json" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2026-03-10' \
    "$api_repository/releases/tags/$version"
expected_digest=$(python3 - "$temp_dir/release.json" "$version" "$asset" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as release_file:
    release = json.load(release_file)

if release.get("tag_name") != sys.argv[2] or release.get("draft") or release.get("prerelease"):
    raise SystemExit("release metadata does not match the requested stable version")
if release.get("immutable") is not True:
    raise SystemExit("release is not immutable; refusing to install")
assets = [item for item in release.get("assets", []) if item.get("name") == sys.argv[3]]
if len(assets) != 1:
    raise SystemExit("release package asset is missing or ambiguous")
digest = assets[0].get("digest", "")
if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
    raise SystemExit("release package has no valid GitHub SHA-256 digest")
print(digest.removeprefix("sha256:"))
PY
)

release_url="$repository/releases/download/$version"
curl --proto '=https' --tlsv1.2 -fsSLo "$temp_dir/$asset" "$release_url/$asset"
printf '%s  %s\n' "$expected_digest" "$temp_dir/$asset" | sha256sum -c -

sudo sh -eu -c '
    expected=$1
    name=$2
    root_dir=$(mktemp -d)
    trap '\''rm -rf -- "$root_dir"'\'' EXIT HUP INT TERM
    chmod 0700 "$root_dir"
    umask 077
    cat > "$root_dir/$name"
    printf "%s  %s\n" "$expected" "$root_dir/$name" | sha256sum -c -
    chmod 0755 "$root_dir"
    chmod 0644 "$root_dir/$name"
    apt-get install -y "$root_dir/$name"
' _ "$expected_digest" "$asset" < "$temp_dir/$asset"

if gnome-extensions info simpleclipboard@sahur.github.io >/dev/null 2>&1; then
    gnome-extensions enable simpleclipboard@sahur.github.io || true
fi

printf '%s\n' 'SimpleClipboard was installed.'
printf '%s\n' 'Log out and back in once if it does not appear immediately.'
