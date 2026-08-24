#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
glib-compile-schemas --strict --dry-run extension/schemas
sh -n install.sh scripts/*.sh
node --check extension/extension.js
node --check extension/prefs.js
node --check extension/serviceClient.js

mkdir -p .dev
gnome-extensions pack --force --extra-source=serviceClient.js extension --out-dir .dev >/dev/null
printf '%s\n' 'All checks passed.'
