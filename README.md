# SimpleClipboard

SimpleClipboard is a lightweight, local-only clipboard history for **Ubuntu 24.04 / GNOME Shell 46**. It blends into GNOME's visual language while bringing a fast `Win+V`-style workflow: text history, a responsive screenshot gallery, editable notes, pinned items, and quick full-content previews.

Clipboard observation and the popup UI live in a thin GNOME Shell extension. A single-binary Rust daemon (`simpleclipboardd`) validates images, caches thumbnails, and stores history locally in SQLite. There is no account, cloud sync, analytics, or OCR.

## Features

- **Text & image history**: Captures UTF-8 text and PNG/JPEG images with local date grouping (today, yesterday, last 7 days, this month, and earlier), inline HEX color swatches, URL indicators, and line-count/resolution metadata.
- **Fast screenshot gallery**: Responsive 1- or 2-column image gallery backed by daemon-generated thumbnail caching and lazy infinite scrolling.
- **Quick full-content preview**: Right-click an item (or press `Ctrl+O` / `Space`) to inspect full text or an enlarged image before pasting.
- **Notes & pinning**: Create, edit, and optionally pin notes on save; pinned items and notes are protected from automatic history cleanup.
- **Instant multi-word search**: Debounced multi-word AND search across text content and source application names.
- **Click-to-paste & copy-only**: Selecting an item restores it to the clipboard, closes the panel, returns to the previously focused window, and sends `Ctrl+Shift+V` to terminals or `Ctrl+V` elsewhere. Hold `Shift` while clicking or pressing `Enter` to copy without pasting, or disable automatic paste in settings.
- **Privacy controls**: One-click pause/resume from both the panel header and top bar menu, automatic skipping of password-manager secret hints (`x-kde-passwordManagerHint`), and configurable `WM_CLASS` application exclusions.
- **Customizable appearance & bounds**: Configure global shortcuts, panel placement (bottom-right, center, or near pointer), opacity, background blur, width (`360–900 px`), maximum height (`280–900 px`), item count, retention period, and image storage caps.

## Keyboard Shortcuts (Inside Panel)

| Shortcut | Action |
|---|---|
| `↑` / `↓` (and `←` / `→` in 2-column images) | Move selection with scroll follow |
| `PageUp` / `PageDown` | Jump through items |
| `Enter` | Copy and paste selected (or first) item |
| `Shift+Enter` / `Shift+Click` | Copy only without pasting |
| `Alt+1` .. `Alt+9` | Paste 1st–9th visible item (`Alt+Shift+1..9` for copy only) |
| `Ctrl+O` / `Space` / Right-click | Open quick full-content preview |
| `Ctrl+1` .. `Ctrl+4` / `Ctrl+Tab` | Switch tabs |
| `Ctrl+F` / `Ctrl+N` | Focus search / new note |
| `Ctrl+P` | Toggle pin on selected item |
| `Delete` (outside text inputs) | Delete selected item |
| `Esc` | Cancel preview or edit → clear search → close panel |

Global shortcuts (such as `Super+V` to toggle the panel) are unassigned by default so installation never steals an existing system binding. Assign them in SimpleClipboard's extension settings.

## Installation (Ubuntu 24.04 / GNOME 46)

Install an immutable release directly with the verification script:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/Aero123421/SimpleClipboard/v0.2.0/install.sh | sh -s -- v0.2.0
```

The installer verifies that:
1. The host is `x86_64` Linux running GNOME Shell 46.
2. The requested GitHub release exists, is non-draft, non-prerelease, and marked **immutable**.
3. The downloaded `.deb` matches the SHA-256 digest recorded by GitHub, and is re-verified inside a root-owned private directory before `apt-get install`.

On first installation, log out and back in once (or press `Alt+F2`, type `r`, and press Enter on X11) if GNOME Shell has not loaded the new extension yet, then enable SimpleClipboard in the Extensions app if needed.

### Uninstall

```sh
sudo apt remove simpleclipboard
```

Uninstalling the package preserves your local history database so an accidental removal does not destroy saved items.

## Storage & Privacy

- All data stays local under `$XDG_DATA_HOME/simpleclipboard` (or `~/.local/share/simpleclipboard`) with private `0700` directories and `0600` files, protected by an exclusive directory lock.
- Default limits: **500** unpinned history items, **30 days** retention, **256 MB** total image storage, and **16 MB** per image. Notes and pins survive normal cleanup, subject to hard ceilings of **5,000** total items and **128 MB** of text.
- D-Bus clients verify the daemon's UID, executable path, inode/device identity, owner, and write permissions before calling service methods.
- Copies carrying password-manager secret hints (`x-kde-passwordManagerHint`, e.g. KeePassXC) are skipped automatically. You can also pause capture from the header or top bar menu, or add `WM_CLASS` names to the excluded applications list in settings.

## Development on Ubuntu 24.04

Install host dependencies:

```sh
sudo apt install build-essential curl git libglib2.0-bin nodejs gnome-shell-extension-prefs
```

Rust is pinned via [rust-toolchain.toml](rust-toolchain.toml). Run the full check suite and deploy the development service and extension:

```sh
./scripts/check.sh
./scripts/dev-daemon.sh
./scripts/dev-install-extension.sh
```

- `dev-daemon.sh` installs and enables a per-user systemd service (`simpleclipboard-dev.service`) using `~/.local/share/simpleclipboard-dev` so development data stays separate from packaged installs.
- Packaged installs are activated automatically by D-Bus instead.
- On X11, reload GNOME Shell with `Alt+F2` → `r` → `Enter`; on Wayland, log out and back in.

### Build a Debian Package

```sh
./scripts/pack-deb.sh
```

The versioned `.deb`, `simpleclipboard_amd64.deb`, and SHA-256 checksum are written to `dist/`. Pushing a `vX.Y.Z` tag matching `Cargo.toml` triggers [.github/workflows/release.yml](.github/workflows/release.yml) to test, build, attach the package to a draft release, and publish an immutable release.

## License

SimpleClipboard is dual-licensed under **Apache-2.0** or **GPL-3.0-or-later**, at your option. See [LICENSE](LICENSE), [LICENSE-APACHE](LICENSE-APACHE), and [LICENSE-GPL](LICENSE-GPL).
