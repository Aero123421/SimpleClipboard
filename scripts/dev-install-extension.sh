#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

mkdir -p .dev
gnome-extensions pack --force --extra-source=serviceClient.js extension --out-dir .dev
gnome-extensions install --force .dev/simpleclipboard@sahur.github.io.shell-extension.zip

schema_dir="$HOME/.local/share/gnome-shell/extensions/simpleclipboard@sahur.github.io/schemas"
GSETTINGS_SCHEMA_DIR="$schema_dir" gsettings set \
    org.gnome.shell.extensions.simpleclipboard development-daemon-path \
    "$project_dir/target/debug/simpleclipboardd"

printf '%s\n' 'Extension files installed.'
printf '%s\n' 'On X11 press Alt+F2, enter r, then enable SimpleClipboard.'
printf '%s\n' 'On Wayland log out and back in, then enable SimpleClipboard.'
