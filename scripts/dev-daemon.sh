#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

cargo build -p simpleclipboardd
chmod 0755 target/debug/simpleclipboardd

libexec_dir="$HOME/.local/libexec"
unit_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/systemd/user
mkdir -p "$libexec_dir" "$unit_dir"
ln -sfn "$project_dir/target/debug/simpleclipboardd" \
    "$libexec_dir/simpleclipboard-dev"
install -m 0644 data/simpleclipboard-dev.service \
    "$unit_dir/simpleclipboard-dev.service"

systemctl --user daemon-reload
systemctl --user enable simpleclipboard-dev.service
systemctl --user restart simpleclipboard-dev.service

printf '%s\n' 'SimpleClipboard development service is enabled.'
printf '%s\n' 'It will restart automatically after login and on failure.'
systemctl --user --no-pager --lines=3 status simpleclipboard-dev.service
