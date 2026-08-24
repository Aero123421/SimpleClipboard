#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

export SIMPLECLIPBOARD_PROFILE=dev
cargo build -p simpleclipboardd
chmod 0755 target/debug/simpleclipboardd
exec target/debug/simpleclipboardd
