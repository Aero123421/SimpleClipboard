# SimpleClipboard

SimpleClipboard is a lightweight clipboard history for Ubuntu 24.04 / GNOME 46. It follows GNOME's visual language while keeping the quick `Win+V`-style workflow: text history, a two-column screenshot gallery, small notes, and pinned items.

The first release intentionally stays small. Clipboard observation and the popup live in a thin GNOME Shell extension. A Rust daemon validates images and stores local history in SQLite. There is no account, cloud sync, analytics, OCR, or automatic paste.

## Current features

- Text and PNG/JPEG clipboard history
- Image gallery for screenshots
- Notes and pinning
- Search and quick tab switching
- Configurable shortcuts, automatic paste, panel opacity, background blur, width, and maximum height
- Bounded item count, retention period, total image storage, and per-image size
- Local-only data with private directory and file permissions

Clicking an item puts it back on the clipboard, closes the panel, returns to the previously focused application, and pastes it. Terminal applications receive `Ctrl+Shift+V`; other applications receive `Ctrl+V`. Automatic paste can be disabled in settings to keep copy-only behavior.

## Development on Ubuntu 24.04

Install the ordinary host dependencies:

```sh
sudo apt install build-essential curl git libglib2.0-bin nodejs gnome-shell-extension-prefs
```

Rust is pinned by `rust-toolchain.toml`. Then run:

```sh
./scripts/check.sh
./scripts/dev-daemon.sh
```

In a second terminal:

```sh
./scripts/dev-install-extension.sh
```

On X11, press `Alt+F2`, type `r`, and press Enter. On Wayland, log out and back in. Enable the extension, open its settings, and assign `Super+V` if desired. The shortcut is empty by default so installation never steals an existing system binding. Restart `./scripts/dev-daemon.sh` after logging out and back in; packaged installs are started automatically by D-Bus. Version 0.1 supports GNOME Shell 46, as shipped by Ubuntu 24.04.

Development history uses `~/.local/share/simpleclipboard-dev`; a packaged install uses `~/.local/share/simpleclipboard`.

## Build a Debian package

```sh
./scripts/pack-deb.sh
```

The package and local checksum are written to `dist/`. Before publishing the first release, enable **Settings → General → Immutable releases** in the GitHub repository. The workflow uploads `simpleclipboard_amd64.deb` to a draft and publishes it only after the package is attached.

## One-line install

After the immutable `v0.1.0` GitHub release exists:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/Aero123421/SimpleClipboard/v0.1.0/install.sh | sh -s -- v0.1.0
```

The installer refuses mutable or mismatched releases, verifies the `.deb` against the SHA-256 digest recorded by GitHub, and only then asks `apt` to install it.

The installer checks for Ubuntu's supported GNOME Shell version, downloads the
versioned Debian package, verifies it, installs it with `apt`, and enables the
extension when the current Shell session can already see it. On the first
installation, log out and back in once if GNOME Shell has not loaded the new
extension yet; then enable SimpleClipboard from the Extensions app if needed.

To uninstall the package later:

```sh
sudo apt remove simpleclipboard
```

Uninstalling the package leaves the local clipboard database in place so an
accidental uninstall does not destroy history.

## Storage and privacy

History is stored locally under the user's XDG data directory. Defaults are 500 unpinned history items, 30 days, 256 MB of images total, and 16 MB per image. Notes and pins survive normal cleanup, but hard ceilings of 5,000 items and 128 MB of text prevent unbounded growth.

Password-manager exclusion is not guessed from window titles in the initial release. Pause recording before copying secrets; explicit application exclusions can be added after reliable app identity handling is verified across X11 and Wayland.

## License

SimpleClipboard is dual-licensed under Apache-2.0 or GPL-3.0-or-later, at your
option. See `LICENSE`, `LICENSE-APACHE`, and `LICENSE-GPL`.
