#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
glib-compile-schemas --strict --dry-run extension/schemas
for script in install.sh scripts/*.sh; do
    sh -n "$script"
done
node --check extension/extension.js
node --check extension/prefs.js
node --check extension/serviceClient.js
node --check extension/helpers.js
node --test tests/helpers.test.mjs

mkdir -p .dev
gnome-extensions pack --force --extra-source=serviceClient.js --extra-source=helpers.js extension --out-dir .dev >/dev/null
printf '%s\n' 'All checks passed.'
