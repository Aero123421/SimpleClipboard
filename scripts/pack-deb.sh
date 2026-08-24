#!/bin/sh
set -eu
umask 022

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
stage_dir="$project_dir/.dev/deb-root"
extension_dir="$stage_dir/usr/share/gnome-shell/extensions/simpleclipboard@sahur.github.io"
output_dir="$project_dir/dist"
version=$(sed -n 's/^version = "\([0-9][0-9.]*\)"$/\1/p' "$project_dir/Cargo.toml" | head -n 1)

if ! printf '%s\n' "$version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    printf '%s\n' 'Could not read a valid package version from Cargo.toml.' >&2
    exit 1
fi

case "$stage_dir" in
    "$project_dir"/.dev/deb-root) ;;
    *) printf '%s\n' 'Unsafe staging path.' >&2; exit 1 ;;
esac

cd "$project_dir"
cargo build --release --locked -p simpleclipboardd

rm -rf -- "$stage_dir"
mkdir -p "$stage_dir/DEBIAN" "$stage_dir/usr/libexec/simpleclipboard" \
    "$stage_dir/usr/share/dbus-1/services" "$stage_dir/usr/share/doc/simpleclipboard" \
    "$extension_dir/schemas" "$output_dir"

install -m 0755 target/release/simpleclipboardd \
    "$stage_dir/usr/libexec/simpleclipboard/simpleclipboardd"
install -m 0644 data/io.github.sahur.SimpleClipboard1.service \
    "$stage_dir/usr/share/dbus-1/services/io.github.sahur.SimpleClipboard1.service"
install -m 0644 packaging/debian/copyright \
    "$stage_dir/usr/share/doc/simpleclipboard/copyright"
sed "s/^Version: .*/Version: $version/" packaging/debian/DEBIAN/control > "$stage_dir/DEBIAN/control"
chmod 0644 "$stage_dir/DEBIAN/control"
install -m 0644 extension/metadata.json extension/extension.js extension/prefs.js \
    extension/serviceClient.js \
    extension/stylesheet.css "$extension_dir/"
install -m 0644 extension/schemas/*.xml "$extension_dir/schemas/"
glib-compile-schemas --strict "$extension_dir/schemas"
chmod 0644 "$extension_dir/schemas/gschemas.compiled"

dpkg-deb --root-owner-group --build "$stage_dir" "$output_dir/simpleclipboard_${version}_amd64.deb"
cp "$output_dir/simpleclipboard_${version}_amd64.deb" "$output_dir/simpleclipboard_amd64.deb"
chmod 0644 "$output_dir/simpleclipboard_${version}_amd64.deb" \
    "$output_dir/simpleclipboard_amd64.deb"
(
    cd "$output_dir"
    sha256sum simpleclipboard_amd64.deb > simpleclipboard_amd64.deb.sha256
)
chmod 0644 "$output_dir/simpleclipboard_amd64.deb.sha256"
