import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Helpers from './helpers.js';
import {ServiceClient} from './serviceClient.js';

Gio._promisify(Meta.SelectionSource.prototype, 'read_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');
Gio._promisify(Gio._LocalFilePrototype, 'replace_async');

const CLIPBOARD = St.ClipboardType.CLIPBOARD;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_CAPTURE_TEXT_BYTES = 1024 * 1024;
const MAX_CAPTURE_IMAGE_BYTES = 32 * 1024 * 1024;
const PAGE_SIZE = 36;
const MAX_RELOAD_LIMIT = 200;
const LOAD_MORE_THRESHOLD_PX = 220;
const SEARCH_DEBOUNCE_MS = 90;
const TABS = [
    ['history', '履歴', 'document-open-recent-symbolic'],
    ['images', '画像', 'image-x-generic-symbolic'],
    ['notes', 'メモ', 'document-edit-symbolic'],
    ['pinned', 'ピン', 'view-pin-symbolic'],
];

class ClipboardMonitor {
    constructor(service, onExternalChange = null) {
        this._service = service;
        this._onExternalChange = onExternalChange;
        this._selection = global.display.get_selection();
        this._generation = 0;
        this._cancellable = null;
        this._suppressOnce = false;
        this._suppressSource = 0;
        this._signal = this._selection.connect('owner-changed',
            (_selection, selectionType, source) => this._ownerChanged(selectionType, source));

        this._inbox = GLib.build_filenamev([
            GLib.get_user_runtime_dir(),
            'simpleclipboard',
            'inbox',
        ]);
        GLib.mkdir_with_parents(this._inbox, 0o700);
        GLib.chmod(this._inbox, 0o700);
    }

    setExternalChangeHandler(handler) {
        this._onExternalChange = handler;
    }

    cancelActiveCapture() {
        this._generation++;
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    suppressNext() {
        this._suppressOnce = true;
        if (this._suppressSource)
            GLib.source_remove(this._suppressSource);
        this._suppressSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
            this._suppressOnce = false;
            this._suppressSource = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._generation++;
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._signal) {
            this._selection.disconnect(this._signal);
            this._signal = 0;
        }
        if (this._suppressSource) {
            GLib.source_remove(this._suppressSource);
            this._suppressSource = 0;
        }
    }

    _ownerChanged(selectionType, source) {
        if (selectionType !== Meta.SelectionType.SELECTION_CLIPBOARD)
            return;
        const generation = ++this._generation;
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._suppressOnce) {
            this._suppressOnce = false;
            if (this._suppressSource) {
                GLib.source_remove(this._suppressSource);
                this._suppressSource = 0;
            }
            return;
        }
        this._onExternalChange?.();
        if (!source)
            return;

        const sourceApp = global.display.focus_window?.get_wm_class() ?? '';
        const mimetypes = source.get_mimetypes() ?? [];
        if (Helpers.hasSecretMimeHint(mimetypes))
            return;
        const imageMime = ['image/png', 'image/jpeg'].find(type => mimetypes.includes(type));
        const textMime = Helpers.selectTextMime(mimetypes);
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        let capture = null;
        if (imageMime)
            capture = this._captureImage(source, imageMime, sourceApp, generation, cancellable);
        else if (textMime)
            capture = this._captureText(source, textMime, sourceApp, generation, cancellable);
        if (!capture) {
            this._cancellable = null;
            return;
        }
        capture.catch(error => {
            if (!cancellable.is_cancelled())
                console.debug(`SimpleClipboard: capture skipped: ${error.message}`);
        }).finally(() => {
            if (generation === this._generation)
                this._cancellable = null;
        });
    }

    async _captureText(source, mime, sourceApp, generation, cancellable) {
        let stream = null;
        try {
            stream = await source.read_async(mime, cancellable);
            const chunks = [];
            let total = 0;
            while (true) {
                const bytes = await stream.read_bytes_async(
                    READ_CHUNK_BYTES, GLib.PRIORITY_DEFAULT, cancellable
                );
                const size = bytes.get_size();
                if (size === 0)
                    break;
                total += size;
                if (total > MAX_CAPTURE_TEXT_BYTES) {
                    cancellable.cancel();
                    return;
                }
                chunks.push(bytes.toArray());
            }
            if (generation !== this._generation || total === 0)
                return;

            const contents = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                contents.set(chunk, offset);
                offset += chunk.length;
            }
            const text = Helpers.decodeTextBytes(contents, mime);
            if (text)
                await this._service.call('CaptureText', text, sourceApp);
        } finally {
            if (stream) {
                try {
                    await stream.close_async(GLib.PRIORITY_DEFAULT, null);
                } catch (_) {
                    // Best-effort close.
                }
            }
        }
    }

    async _captureImage(source, mime, sourceApp, generation, cancellable) {
        try {
            if (await this._service.call('GetSetting', 'capture_paused') === 'true')
                return;
        } catch (_) {
            // Proceed and let CaptureImage handle daemon state if GetSetting failed.
        }
        if (generation !== this._generation || cancellable.is_cancelled())
            return;

        const extension = mime === 'image/png' ? 'png' : 'jpg';
        const path = GLib.build_filenamev([
            this._inbox,
            `${GLib.uuid_string_random()}.${extension}`,
        ]);
        const file = Gio.File.new_for_path(path);
        let input = null;
        let output = null;
        let total = 0;
        try {
            input = await source.read_async(mime, cancellable);
            output = await file.replace_async(
                null, false, Gio.FileCreateFlags.PRIVATE,
                GLib.PRIORITY_DEFAULT, cancellable
            );
            while (true) {
                const bytes = await input.read_bytes_async(
                    READ_CHUNK_BYTES, GLib.PRIORITY_DEFAULT, cancellable
                );
                const size = bytes.get_size();
                if (size === 0)
                    break;
                total += size;
                if (total > MAX_CAPTURE_IMAGE_BYTES) {
                    cancellable.cancel();
                    return;
                }
                let remaining = bytes;
                while (remaining.get_size() > 0) {
                    const written = await output.write_bytes_async(
                        remaining, GLib.PRIORITY_DEFAULT, cancellable
                    );
                    if (written <= 0)
                        throw new Error('short write while spooling clipboard image');
                    if (written >= remaining.get_size())
                        break;
                    remaining = GLib.Bytes.new(remaining.toArray().subarray(written));
                }
            }
            await output.close_async(GLib.PRIORITY_DEFAULT, cancellable);
            output = null;
            if (generation !== this._generation || total === 0)
                return;
            await this._service.call('CaptureImage', path, mime, sourceApp);
        } finally {
            if (input) {
                try {
                    await input.close_async(GLib.PRIORITY_DEFAULT, null);
                } catch (_) {
                    // Best-effort close.
                }
            }
            if (output) {
                try {
                    await output.close_async(GLib.PRIORITY_DEFAULT, null);
                } catch (_) {
                    // Best-effort close during cancellation.
                }
            }
            try {
                file.delete(null);
            } catch (_) {
                // The daemon normally consumes the spool file.
            }
        }
    }
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(open, togglePause, onMenuOpen, openPreferences) {
        super._init(0.0, 'SimpleClipboard');
        this._icon = new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        const openItem = new PopupMenu.PopupMenuItem('クリップボードを開く');
        openItem.connect('activate', () => open('history'));
        this.menu.addMenuItem(openItem);

        this._pauseItem = new PopupMenu.PopupMenuItem('履歴の記録を一時停止');
        this._pauseItem.connect('activate', () => togglePause());
        this.menu.addMenuItem(this._pauseItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settingsItem = new PopupMenu.PopupMenuItem('設定');
        settingsItem.connect('activate', openPreferences);
        this.menu.addMenuItem(settingsItem);

        this._menuSignal = this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                onMenuOpen();
        });
    }

    setPaused(paused) {
        if (paused) {
            this._icon.add_style_class_name('simpleclipboard-indicator-paused');
            this._pauseItem.label.text = '履歴の記録を再開';
        } else {
            this._icon.remove_style_class_name('simpleclipboard-indicator-paused');
            this._pauseItem.label.text = '履歴の記録を一時停止';
        }
    }

    destroy() {
        if (this._menuSignal && this.menu) {
            this.menu.disconnect(this._menuSignal);
            this._menuSignal = 0;
        }
        super.destroy();
    }
});

const ClipboardDialog = GObject.registerClass(
class ClipboardDialog extends St.Widget {
    _init(extension, service, monitor, onPauseChanged) {
        super._init({
            reactive: true,
            visible: false,
            opacity: 0,
        });
        this._extension = extension;
        this._service = service;
        this._monitor = monitor;
        this._onPauseChanged = onPauseChanged;
        this._activeTab = 'history';
        this._loadGeneration = 0;
        this._previewGeneration = 0;
        this._tabButtons = new Map();
        this._settings = extension.getSettings();
        this._panelWidth = this._settings.get_int('panel-width');
        this._panelHeight = 300;
        this._sourceWindow = null;
        this._copyGeneration = 0;
        this._savingNote = false;
        this._pasteSource = 0;
        this._focusSource = 0;
        this._closeSource = 0;
        this._searchDebounceSource = 0;
        this._toastSource = 0;
        this._closeGeneration = 0;
        this._closing = false;
        this._heightGeneration = 0;
        this._destroyed = false;
        this._virtualKeyboard = null;
        this._renderedItems = [];
        this._selectedIndex = -1;
        this._prevSelectedIndex = -1;
        this._listStale = false;
        this._noteEditGeneration = 0;
        this._hasLoadedOnce = false;
        this._suppressSearchChange = false;
        this._capturePaused = false;
        this._editingNoteId = null;
        this._newNotePinned = false;
        this._loadedCount = 0;
        this._hasMore = false;
        this._loadingMore = false;
        this._lastRenderedGroup = null;
        this._lastGalleryRow = null;
        this._lastGallerySpacer = null;
        this._renderNowDate = new Date();
        this._renderNowMs = this._renderNowDate.getTime();
        this._loadMoreIndicator = null;
        this._previewItem = null;
        this._previewVisible = false;
        this._scrollValueSignal = 0;

        this._panel = new St.BoxLayout({
            vertical: true,
            reactive: true,
            clip_to_allocation: true,
            style_class: 'simpleclipboard-panel',
        });
        this.add_child(this._panel);
        Main.uiGroup.add_child(this);

        this._buildHeader();
        this._buildBanners();
        this._buildSearch();
        this._buildTabs();
        this._buildBody();
        this._applyAppearance();
        this._refreshPanelHeight();

        this._settingsSignals = [
            this._settings.connect('changed::panel-opacity', () => this._applyAppearance()),
            this._settings.connect('changed::panel-width', () => {
                this._applyAppearance();
                if (this.visible)
                    this._reload({resetScroll: false});
            }),
            this._settings.connect('changed::panel-height', () => this._refreshPanelHeight()),
            this._settings.connect('changed::blur-radius', () => this._applyAppearance()),
        ];
        if (this._hasSettingKey('panel-position')) {
            this._settingsSignals.push(
                this._settings.connect('changed::panel-position', () => {
                    if (this.visible)
                        this._positionPanel();
                })
            );
        }
        this._monitorsChanged = Main.layoutManager.connect('monitors-changed', () => {
            if (this.visible)
                this._positionPanel();
        });
        this.connect('key-press-event', (_actor, event) => this._onKeyPress(event));
        this.connect('button-press-event', (_actor, event) => this._onOverlayPress(event));
        this.connect('scroll-event', (_actor, event) => this._onScroll(event));
    }

    destroy() {
        this._destroyed = true;
        this._loadGeneration++;
        this._previewGeneration++;
        this._heightGeneration++;
        this._copyGeneration++;
        for (const signal of this._settingsSignals)
            this._settings.disconnect(signal);
        this._settingsSignals = [];
        if (this._monitorsChanged)
            Main.layoutManager.disconnect(this._monitorsChanged);
        this._monitorsChanged = 0;
        if (this._scrollValueSignal && this._scroll?.vadjustment) {
            this._scroll.vadjustment.disconnect(this._scrollValueSignal);
            this._scrollValueSignal = 0;
        }
        if (this._pasteSource)
            GLib.source_remove(this._pasteSource);
        this._pasteSource = 0;
        if (this._focusSource)
            GLib.source_remove(this._focusSource);
        this._focusSource = 0;
        if (this._closeSource)
            GLib.source_remove(this._closeSource);
        this._closeSource = 0;
        if (this._searchDebounceSource)
            GLib.source_remove(this._searchDebounceSource);
        this._searchDebounceSource = 0;
        if (this._toastSource)
            GLib.source_remove(this._toastSource);
        this._toastSource = 0;
        this._closeGeneration++;
        this._virtualKeyboard = null;
        this._renderedItems = [];
        this._previewItem = null;
        super.destroy();
    }

    setCapturePaused(paused) {
        this._capturePaused = Boolean(paused);
        this._pauseBanner.visible = this._capturePaused;
        const icon = this._pauseButton.get_child();
        if (icon instanceof St.Icon) {
            icon.icon_name = this._capturePaused
                ? 'media-playback-start-symbolic'
                : 'media-playback-pause-symbolic';
        }
        this._pauseButton.accessible_name = this._capturePaused ? '記録を再開' : '記録を一時停止';
        if (this._capturePaused)
            this._pauseButton.add_style_class_name('simpleclipboard-header-paused');
        else
            this._pauseButton.remove_style_class_name('simpleclipboard-header-paused');
    }

    openTab(tab = 'history') {
        if (this._destroyed)
            return;
        const nextTab = TABS.some(([id]) => id === tab) ? tab : 'history';
        const wasClosing = this._closing;
        if (wasClosing)
            this._cancelClose();
        if (this.visible && this._activeTab === nextTab && !wasClosing) {
            this.close();
            return;
        }

        const openingFresh = !this.visible || wasClosing;
        if (openingFresh) {
            this._copyGeneration++;
            if (this._pasteSource) {
                GLib.source_remove(this._pasteSource);
                this._pasteSource = 0;
            }
            this._sourceWindow = global.display.focus_window;
            this._clearSearchSilently();
            this._cancelNoteEdit();
            this._closePreview({refocus: false});
            this._selectedIndex = -1;
        }
        this._syncPauseState();
        this._setTab(nextTab, {resetScroll: true});
        this._refreshPanelHeight();
        this._positionPanel();
        this.remove_all_transitions();
        this._panel.remove_all_transitions();
        this.reactive = true;
        this.show();
        this.opacity = 0;
        this._panel.translation_y = 12;
        this.ease({
            opacity: 255,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._panel.ease({
            translation_y: 0,
            duration: 140,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        if (this._focusSource)
            GLib.source_remove(this._focusSource);
        this._focusSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._focusSource = 0;
            if (!this._destroyed && this.visible)
                this._search.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    close({cancelCopy = true} = {}) {
        if (this._destroyed || !this.visible || this._closing)
            return;
        this._closing = true;
        const generation = ++this._closeGeneration;
        this._loadGeneration++;
        this._previewGeneration++;
        this._heightGeneration++;
        if (cancelCopy) {
            this._copyGeneration++;
            if (this._pasteSource) {
                GLib.source_remove(this._pasteSource);
                this._pasteSource = 0;
            }
        }
        if (this._focusSource)
            GLib.source_remove(this._focusSource);
        this._focusSource = 0;
        if (this._searchDebounceSource)
            GLib.source_remove(this._searchDebounceSource);
        this._searchDebounceSource = 0;
        global.stage.set_key_focus(null);

        // Never let an interrupted animation leave an invisible, reactive
        // stage-sized actor blocking the desktop.
        this.reactive = false;
        this.remove_all_transitions();
        this._panel.remove_all_transitions();
        this._closeSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 160, () => {
            this._closeSource = 0;
            this._finishClose(generation);
            return GLib.SOURCE_REMOVE;
        });
        this.ease({
            opacity: 0,
            duration: 90,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._finishClose(generation),
        });
        this._panel.ease({
            translation_y: 10,
            duration: 90,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _cancelClose() {
        this._closeGeneration++;
        if (this._closeSource)
            GLib.source_remove(this._closeSource);
        this._closeSource = 0;
        this._closing = false;
        this.remove_all_transitions();
        this._panel.remove_all_transitions();
    }

    _finishClose(generation) {
        if (this._destroyed || generation !== this._closeGeneration)
            return;
        if (this._closeSource)
            GLib.source_remove(this._closeSource);
        this._closeSource = 0;
        this.remove_all_transitions();
        this._panel.remove_all_transitions();
        this.hide();
        this.opacity = 0;
        this._panel.translation_y = 0;
        this._closing = false;
        this._cancelNoteEdit();
        this._closePreview({refocus: false});
    }

    _hasSettingKey(key) {
        return this._settings.settings_schema?.has_key(key) ?? false;
    }

    _panelPositionMode() {
        if (!this._hasSettingKey('panel-position'))
            return 'bottom-right';
        return this._settings.get_string('panel-position') || 'bottom-right';
    }

    _positionPanel() {
        if (this._destroyed)
            return;
        this.set_position(0, 0);
        this.set_size(global.stage.width, global.stage.height);

        const mode = this._panelPositionMode();
        const [pointerX, pointerY] = global.get_pointer();
        const focusWindow = this._sourceWindow ?? global.display.focus_window;
        let monitorIndex = -1;
        if (mode === 'pointer') {
            monitorIndex = global.display.get_current_monitor();
        } else {
            monitorIndex = focusWindow?.get_monitor() ?? -1;
            if (monitorIndex < 0)
                monitorIndex = global.display.get_current_monitor();
        }
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex ?? 0;

        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const margin = 18;
        const width = Math.max(1,
            Math.min(this._settings.get_int('panel-width'), workArea.width - margin * 2));
        const height = Math.max(1,
            Math.min(this._panelHeight, workArea.height - margin * 2));
        const {x, y} = Helpers.computePanelPosition(
            workArea, width, height, mode, pointerX, pointerY, margin
        );
        this._panelWidth = width;
        this._panel.set_size(width, height);
        this._panel.set_position(x, y);
    }

    async _refreshPanelHeight() {
        if (this._destroyed)
            return;
        const generation = ++this._heightGeneration;
        const maximum = this._settings.get_int('panel-height');
        try {
            const stats = await this._service.json('GetStats');
            if (this._destroyed || generation !== this._heightGeneration)
                return;
            const nextHeight = Helpers.computePanelHeight(stats.item_count, maximum);
            if (nextHeight === this._panelHeight)
                return;
            this._panelHeight = nextHeight;
            this._positionPanel();
        } catch (_) {
            if (this._destroyed || generation !== this._heightGeneration)
                return;
            this._panelHeight = Math.min(maximum, 320);
            this._positionPanel();
        }
    }

    async _syncPauseState() {
        try {
            const paused = await this._service.call('GetSetting', 'capture_paused') === 'true';
            if (this._destroyed)
                return;
            this.setCapturePaused(paused);
            this._onPauseChanged?.(paused);
        } catch (_) {
            // Keep last known state when the daemon is unavailable.
        }
    }

    async _togglePause() {
        const nextPaused = !this._capturePaused;
        try {
            await this._service.call('SetSetting', 'capture_paused', nextPaused ? 'true' : 'false');
            if (this._destroyed)
                return;
            this.setCapturePaused(nextPaused);
            this._onPauseChanged?.(nextPaused);
            this._showToast(nextPaused ? '履歴の記録を一時停止しました' : '履歴の記録を再開しました');
        } catch (error) {
            Main.notifyError('SimpleClipboard', `記録状態を変更できませんでした: ${error.message}`);
        }
    }

    _activeScrollView() {
        return this._previewVisible ? this._previewScroll : this._scroll;
    }

    _onOverlayPress(event) {
        const button = event.get_button();
        if (button === 4)
            return this._scrollAtPointer(event, -56);
        if (button === 5)
            return this._scrollAtPointer(event, 56);

        const [x, y] = event.get_coords();
        const [panelX, panelY] = this._panel.get_transformed_position();
        const [panelWidth, panelHeight] = this._panel.get_transformed_size();
        const outside = x < panelX || x > panelX + panelWidth ||
            y < panelY || y > panelY + panelHeight;
        if (!outside)
            return Clutter.EVENT_PROPAGATE;
        this.close();
        return Clutter.EVENT_STOP;
    }

    _onScroll(event) {
        const scrollView = this._activeScrollView();
        if (!this.visible || !scrollView)
            return Clutter.EVENT_PROPAGATE;

        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            delta = -56;
            break;
        case Clutter.ScrollDirection.DOWN:
            delta = 56;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [, dy] = event.get_scroll_delta();
            delta = dy * 56;
            break;
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }

        return this._scrollAtPointer(event, delta);
    }

    _scrollAtPointer(event, delta) {
        const scrollView = this._activeScrollView();
        if (!this.visible || !scrollView)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        const [scrollX, scrollY] = scrollView.get_transformed_position();
        const [scrollWidth, scrollHeight] = scrollView.get_transformed_size();
        const inside = x >= scrollX && x <= scrollX + scrollWidth &&
            y >= scrollY && y <= scrollY + scrollHeight;
        if (!inside)
            return Clutter.EVENT_PROPAGATE;

        const adjustment = scrollView.vadjustment;
        const maximum = Math.max(adjustment.lower, adjustment.upper - adjustment.page_size);
        adjustment.value = Math.min(maximum, Math.max(adjustment.lower, adjustment.value + delta));
        return Clutter.EVENT_STOP;
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'simpleclipboard-header'});
        header.add_child(new St.Label({
            text: 'SimpleClipboard',
            style_class: 'simpleclipboard-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._pauseButton = this._iconButton('media-playback-pause-symbolic', '記録を一時停止');
        this._pauseButton.add_style_class_name('simpleclipboard-header-icon');
        this._pauseButton.connect('clicked', () => this._togglePause());

        const newNote = this._iconButton('document-edit-symbolic', '新しいメモ');
        newNote.add_style_class_name('simpleclipboard-header-icon');
        newNote.add_style_class_name('simpleclipboard-header-note');
        newNote.connect('clicked', () => this._focusNewNote());

        const settings = this._iconButton('emblem-system-symbolic', '設定');
        settings.add_style_class_name('simpleclipboard-header-icon');
        settings.connect('clicked', () => {
            this.close();
            this._extension.openPreferences();
        });

        const close = this._iconButton('window-close-symbolic', '閉じる');
        close.add_style_class_name('simpleclipboard-header-icon');
        close.add_style_class_name('simpleclipboard-header-close');
        close.connect('clicked', () => this.close());

        header.add_child(this._pauseButton);
        header.add_child(newNote);
        header.add_child(settings);
        header.add_child(close);
        this._panel.add_child(header);
    }

    _buildBanners() {
        this._pauseBanner = new St.BoxLayout({
            visible: false,
            style_class: 'simpleclipboard-pause-banner',
        });
        this._pauseBanner.add_child(new St.Icon({
            icon_name: 'media-playback-pause-symbolic',
            icon_size: 14,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._pauseBanner.add_child(new St.Label({
            text: '履歴の記録を一時停止中',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'simpleclipboard-pause-label',
        }));
        const resume = new St.Button({
            label: '再開',
            can_focus: true,
            style_class: 'simpleclipboard-banner-button',
        });
        resume.connect('clicked', () => this._togglePause());
        this._pauseBanner.add_child(resume);
        this._panel.add_child(this._pauseBanner);

        this._toastLabel = new St.Label({
            visible: false,
            style_class: 'simpleclipboard-toast',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._panel.add_child(this._toastLabel);
    }

    _showToast(message) {
        if (this._destroyed)
            return;
        if (this._toastSource)
            GLib.source_remove(this._toastSource);
        this._toastLabel.text = message;
        this._toastLabel.visible = true;
        this._toastSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1800, () => {
            this._toastSource = 0;
            if (!this._destroyed)
                this._toastLabel.visible = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    _buildSearch() {
        const searchWrap = new St.BoxLayout({style_class: 'simpleclipboard-search-wrap'});
        this._search = new St.Entry({
            hint_text: '履歴を検索…',
            can_focus: true,
            x_expand: true,
            style_class: 'simpleclipboard-search',
        });
        this._search.set_primary_icon(new St.Icon({
            icon_name: 'system-search-symbolic',
            icon_size: 16,
            style_class: 'simpleclipboard-search-icon',
        }));
        this._searchClearIcon = new St.Icon({
            icon_name: 'edit-clear-symbolic',
            icon_size: 14,
            visible: false,
            style_class: 'simpleclipboard-search-clear',
        });
        this._search.set_secondary_icon(this._searchClearIcon);
        this._search.connect('secondary-icon-clicked', () => {
            this._search.set_text('');
            this._search.grab_key_focus();
        });
        this._search.clutter_text.connect('text-changed', () => {
            const hasText = this._search.get_text().length > 0;
            this._searchClearIcon.visible = hasText;
            if (this._suppressSearchChange)
                return;
            if (this._previewVisible)
                this._closePreview({refocus: false});
            this._scheduleSearchReload();
        });
        this._search.clutter_text.connect('activate', () => {
            if (this._previewVisible && this._previewItem) {
                this._copy(this._previewItem, {copyOnly: this._isCopyOnlyModifierActive()});
                return;
            }
            this._activateSelectedOrFirst(this._isCopyOnlyModifierActive());
        });
        this._search.clutter_text.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            const state = event.get_state();
            const hasCopyOnlyMod = Boolean(
                state & (Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.CONTROL_MASK)
            );
            if ((symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) && hasCopyOnlyMod) {
                if (this._previewVisible && this._previewItem) {
                    this._copy(this._previewItem, {copyOnly: true});
                    return Clutter.EVENT_STOP;
                }
                if (this._activateSelectedOrFirst(true))
                    return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        searchWrap.add_child(this._search);
        this._panel.add_child(searchWrap);
    }

    _clearSearchSilently() {
        if (this._searchDebounceSource) {
            GLib.source_remove(this._searchDebounceSource);
            this._searchDebounceSource = 0;
        }
        this._suppressSearchChange = true;
        this._search.set_text('');
        this._searchClearIcon.visible = false;
        this._suppressSearchChange = false;
    }

    _scheduleSearchReload() {
        this._markListStale();
        if (this._searchDebounceSource)
            GLib.source_remove(this._searchDebounceSource);
        this._searchDebounceSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DEBOUNCE_MS, () => {
            this._searchDebounceSource = 0;
            this._reload({resetScroll: true});
            return GLib.SOURCE_REMOVE;
        });
    }

    _markListStale() {
        this._listStale = true;
        this._hasMore = false;
        this._loadingMore = false;
        this._prevSelectedIndex = this._selectedIndex;
        this._selectedIndex = -1;
        this._applySelectionStyles();
    }

    _buildTabs() {
        const wrap = new St.BoxLayout({style_class: 'simpleclipboard-tabs-wrap'});
        const tabs = new St.BoxLayout({
            x_expand: true,
            style_class: 'simpleclipboard-tabs',
        });
        for (const [id, label, iconName] of TABS) {
            const child = new St.BoxLayout({
                x_align: Clutter.ActorAlign.CENTER,
                style_class: 'simpleclipboard-tab-content',
            });
            child.add_child(new St.Icon({icon_name: iconName, icon_size: 15}));
            child.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
            const button = new St.Button({
                can_focus: true,
                x_expand: true,
                accessible_name: label,
                child,
                style_class: 'simpleclipboard-tab',
            });
            button.connect('clicked', () => this._setTab(id, {resetScroll: true}));
            tabs.add_child(button);
            this._tabButtons.set(id, button);
        }
        wrap.add_child(tabs);
        this._panel.add_child(wrap);
    }

    _buildBody() {
        this._body = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style_class: 'simpleclipboard-body',
        });

        this._listContainer = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style_class: 'simpleclipboard-list-container',
        });
        this._list = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'simpleclipboard-list',
        });
        this._scroll = new St.ScrollView({
            style_class: 'simpleclipboard-scroll',
            overlay_scrollbars: true,
            enable_mouse_scrolling: false,
            reactive: true,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._scroll.set_child(this._list);
        this._scroll.connect('scroll-event', (_actor, event) => this._onScroll(event));
        this._scrollValueSignal = this._scroll.vadjustment.connect('notify::value', () => {
            this._maybeLoadMore();
        });

        this._compose = new St.BoxLayout({x_expand: true, style_class: 'simpleclipboard-compose'});
        this._noteEntry = new St.Entry({
            hint_text: '新しいメモを書く…',
            can_focus: true,
            x_expand: true,
            style_class: 'simpleclipboard-note-entry',
        });
        this._notePinToggle = this._iconButton('view-pin-symbolic', 'ピン留めして保存');
        this._notePinToggle.add_style_class_name('simpleclipboard-compose-pin');
        this._notePinToggle.connect('clicked', () => {
            this._newNotePinned = !this._newNotePinned;
            this._syncComposeControls();
        });
        this._noteSaveButton = new St.Button({
            label: '保存',
            can_focus: true,
            style_class: 'simpleclipboard-primary-button',
        });
        this._noteSaveButton.connect('clicked', () => this._saveNote());
        this._noteCancelButton = this._iconButton('window-close-symbolic', '編集をキャンセル');
        this._noteCancelButton.add_style_class_name('simpleclipboard-compose-cancel');
        this._noteCancelButton.visible = false;
        this._noteCancelButton.connect('clicked', () => this._cancelNoteEdit());
        this._noteEntry.clutter_text.connect('activate', () => this._saveNote());

        this._compose.add_child(this._noteEntry);
        this._compose.add_child(this._notePinToggle);
        this._compose.add_child(this._noteSaveButton);
        this._compose.add_child(this._noteCancelButton);

        this._listContainer.add_child(this._compose);
        this._listContainer.add_child(this._scroll);
        this._body.add_child(this._listContainer);

        this._buildPreview();
        this._body.add_child(this._previewBox);
        this._panel.add_child(this._body);
    }

    _buildPreview() {
        this._previewBox = new St.BoxLayout({
            vertical: true,
            visible: false,
            x_expand: true,
            y_expand: true,
            style_class: 'simpleclipboard-preview-pane',
        });

        const topBar = new St.BoxLayout({style_class: 'simpleclipboard-preview-header'});
        const backChild = new St.BoxLayout({style_class: 'simpleclipboard-label-icon-content'});
        backChild.add_child(new St.Icon({icon_name: 'go-previous-symbolic', icon_size: 15}));
        backChild.add_child(new St.Label({text: '戻る', y_align: Clutter.ActorAlign.CENTER}));
        const backButton = new St.Button({
            can_focus: true,
            accessible_name: 'プレビューを閉じる',
            child: backChild,
            style_class: 'simpleclipboard-secondary-button',
        });
        backButton.connect('clicked', () => this._closePreview({refocus: true}));

        this._previewMeta = new St.Label({
            text: '',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'simpleclipboard-meta',
        });
        this._previewMeta.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        topBar.add_child(backButton);
        topBar.add_child(this._previewMeta);
        this._previewBox.add_child(topBar);

        this._previewContent = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'simpleclipboard-preview-content',
        });
        this._previewScroll = new St.ScrollView({
            style_class: 'simpleclipboard-scroll simpleclipboard-preview-scroll',
            overlay_scrollbars: true,
            enable_mouse_scrolling: false,
            reactive: true,
            x_expand: true,
            y_expand: true,
        });
        this._previewScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._previewScroll.set_child(this._previewContent);
        this._previewScroll.connect('scroll-event', (_actor, event) => this._onScroll(event));
        this._previewBox.add_child(this._previewScroll);

        const actions = new St.BoxLayout({style_class: 'simpleclipboard-preview-actions'});
        this._previewPasteButton = new St.Button({
            label: '貼り付け',
            can_focus: true,
            style_class: 'simpleclipboard-primary-button',
        });
        this._previewPasteButton.connect('clicked', () => {
            if (this._previewItem)
                this._copy(this._previewItem, {copyOnly: false});
        });

        this._previewCopyButton = new St.Button({
            label: 'コピーのみ',
            can_focus: true,
            style_class: 'simpleclipboard-secondary-button',
        });
        this._previewCopyButton.connect('clicked', () => {
            if (this._previewItem)
                this._copy(this._previewItem, {copyOnly: true});
        });

        this._previewPinButton = this._iconButton('view-pin-symbolic', 'ピン留め');
        this._previewPinButton.add_style_class_name('simpleclipboard-header-icon');
        this._previewPinButton.connect('clicked', async () => {
            if (!this._previewItem)
                return;
            const previewGen = this._previewGeneration;
            const itemId = this._previewItem.id;
            const updated = await this._togglePin(this._previewItem);
            if (!updated || this._destroyed || !this._previewVisible ||
                previewGen !== this._previewGeneration || this._previewItem?.id !== itemId)
                return;
            this._previewItem.pinned = updated.pinned;
            this._syncPreviewPin();
        });

        actions.add_child(this._previewPasteButton);
        actions.add_child(this._previewCopyButton);
        actions.add_child(new St.Widget({x_expand: true}));
        actions.add_child(this._previewPinButton);
        this._previewBox.add_child(actions);
    }

    _syncPreviewPin() {
        const pinned = Boolean(this._previewItem?.pinned);
        this._previewPinButton.accessible_name = pinned ? 'ピンを外す' : 'ピン留め';
        if (pinned)
            this._previewPinButton.add_style_class_name('simpleclipboard-pin-active');
        else
            this._previewPinButton.remove_style_class_name('simpleclipboard-pin-active');
    }

    async _openPreview(item) {
        if (!item || this._destroyed)
            return;
        const generation = ++this._previewGeneration;
        this._previewItem = {...item};
        this._previewVisible = true;
        this._listContainer.visible = false;
        this._previewBox.visible = true;
        this._syncPreviewPin();
        this._previewMeta.text = '読み込み中…';
        this._previewContent.destroy_all_children();
        this._previewScroll.vadjustment.value = 0;

        try {
            const fullItem = await this._service.json('GetItem', item.id);
            if (this._destroyed || !this._previewVisible || generation !== this._previewGeneration)
                return;
            this._previewItem = fullItem;
            this._syncPreviewPin();
            this._previewContent.destroy_all_children();

            const source = Helpers.formatRowSource(fullItem);
            const rel = Helpers.formatRelativeTime(fullItem.created_at);
            if (fullItem.kind === 'image' && fullItem.blob_path) {
                const detail = Helpers.formatRowDetail(fullItem);
                this._previewMeta.text = [source, detail, rel].filter(Boolean).join(' • ');
                const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                const maxWidth = Math.max(240, this._settings.get_int('panel-width') - 44);
                const maxHeight = Math.max(160, this._panelHeight - 230);
                const texture = St.TextureCache.get_default().load_file_async(
                    Gio.File.new_for_path(fullItem.blob_path),
                    maxWidth, maxHeight, scaleFactor, 1.0
                );
                texture.set_content_gravity(Clutter.ContentGravity.RESIZE_ASPECT);
                const frame = new St.Bin({
                    x_expand: true,
                    child: texture,
                    style_class: 'simpleclipboard-preview-image-frame',
                });
                this._previewContent.add_child(frame);
            } else {
                const {text, totalChars} = Helpers.formatPreviewBody(fullItem.text ?? '');
                const lines = Helpers.countLines(fullItem.text ?? '');
                const statsLabel = lines > 1 ? `${lines}行 • ${totalChars}文字` : `${totalChars}文字`;
                this._previewMeta.text = [source, statsLabel, rel].filter(Boolean).join(' • ');

                const colorHex = Helpers.detectColorHex(fullItem.text);
                if (colorHex) {
                    const banner = new St.BoxLayout({style_class: 'simpleclipboard-preview-color-banner'});
                    banner.add_child(new St.Widget({
                        style_class: 'simpleclipboard-color-swatch',
                        style: `background-color: ${colorHex};`,
                    }));
                    banner.add_child(new St.Label({
                        text: colorHex,
                        y_align: Clutter.ActorAlign.CENTER,
                        style_class: 'simpleclipboard-preview-color-code',
                    }));
                    this._previewContent.add_child(banner);
                }

                const label = new St.Label({
                    text,
                    x_expand: true,
                    style_class: 'simpleclipboard-preview-text',
                });
                label.clutter_text.set_line_wrap(true);
                label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
                label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
                this._previewContent.add_child(label);
            }
            this._previewPasteButton.grab_key_focus();
        } catch (error) {
            if (!this._destroyed && this._previewVisible && generation === this._previewGeneration) {
                this._previewMeta.text = '読み込み失敗';
                this._previewContent.destroy_all_children();
                this._previewContent.add_child(new St.Label({
                    text: `内容を読み込めませんでした: ${error.message}`,
                    style_class: 'simpleclipboard-error',
                }));
            }
        }
    }

    _closePreview({refocus = false} = {}) {
        if (!this._previewVisible)
            return;
        this._previewGeneration++;
        this._previewVisible = false;
        this._previewItem = null;
        this._previewBox.visible = false;
        this._listContainer.visible = true;
        this._previewContent.destroy_all_children();
        if (refocus && this.visible && !this._destroyed)
            this._search.grab_key_focus();
    }

    _syncComposeControls() {
        const editing = this._editingNoteId !== null;
        this._noteSaveButton.label = editing ? '更新' : '保存';
        this._noteEntry.hint_text = editing ? 'メモを編集…' : '新しいメモを書く…';
        this._notePinToggle.visible = !editing;
        this._noteCancelButton.visible = editing;
        if (editing)
            this._compose.add_style_class_name('simpleclipboard-compose-editing');
        else
            this._compose.remove_style_class_name('simpleclipboard-compose-editing');
        if (this._newNotePinned && !editing)
            this._notePinToggle.add_style_class_name('simpleclipboard-pin-active');
        else
            this._notePinToggle.remove_style_class_name('simpleclipboard-pin-active');
    }

    _focusNewNote() {
        this._closePreview({refocus: false});
        this._cancelNoteEdit();
        this._setTab('notes', {resetScroll: true});
        this._noteEntry.grab_key_focus();
    }

    async _startNoteEdit(item) {
        const editGen = ++this._noteEditGeneration;
        try {
            const fullItem = await this._service.json('GetItem', item.id);
            if (this._destroyed || editGen !== this._noteEditGeneration)
                return;
            this._closePreview({refocus: false});
            if (this._activeTab !== 'notes')
                this._setTab('notes', {resetScroll: false});
            this._editingNoteId = fullItem.id;
            this._noteEntry.set_text(fullItem.text ?? '');
            this._syncComposeControls();
            this._noteEntry.grab_key_focus();
            this._noteEntry.clutter_text.set_cursor_position(-1);
            this._noteEntry.clutter_text.set_selection(-1, -1);
        } catch (error) {
            if (!this._destroyed && editGen === this._noteEditGeneration)
                Main.notifyError('SimpleClipboard', `メモを読み込めませんでした: ${error.message}`);
        }
    }

    _cancelNoteEdit() {
        this._noteEditGeneration++;
        if (this._editingNoteId !== null) {
            this._editingNoteId = null;
            this._noteEntry.set_text('');
        }
        this._syncComposeControls();
    }

    _setTab(tab, options = {}) {
        const changed = this._activeTab !== tab;
        this._activeTab = tab;
        if (changed) {
            this._markListStale();
            this._closePreview({refocus: false});
            if (tab !== 'notes')
                this._cancelNoteEdit();
        }
        for (const [id, button] of this._tabButtons)
            button.set_style_class_name(`simpleclipboard-tab${id === tab ? ' simpleclipboard-tab-active' : ''}`);
        this._compose.visible = tab === 'notes';
        this._search.hint_text = tab === 'images'
            ? '画像を検索…'
            : tab === 'notes'
                ? 'メモを検索…'
                : tab === 'pinned'
                    ? 'ピン留めを検索…'
                    : '履歴を検索…';
        this._reload({resetScroll: options.resetScroll ?? changed});
    }

    async _fetchPage(tab, query, limit, offset) {
        try {
            return await this._service.json('ListItemsPage', tab, query, limit, offset);
        } catch (error) {
            const message = String(error?.message ?? '');
            if (message.includes('UnknownMethod')) {
                if (offset > 0)
                    return [];
                return this._service.json('ListItems', tab, query, limit);
            }
            throw error;
        }
    }

    async _reload({resetScroll = false} = {}) {
        if (this._destroyed)
            return;
        const generation = ++this._loadGeneration;
        const tab = this._activeTab;
        const query = this._search?.get_text() ?? '';
        const previousScroll = this._scroll.vadjustment.value;
        const previousSelectedId = this._renderedItems[this._selectedIndex]?.item?.id ?? null;
        const fetchCount = resetScroll
            ? PAGE_SIZE
            : Math.min(MAX_RELOAD_LIMIT, Math.max(PAGE_SIZE, this._loadedCount));

        this._listStale = true;
        this._hasMore = false;
        this._loadingMore = false;
        if (!this._hasLoadedOnce) {
            this._renderedItems = [];
            this._selectedIndex = -1;
            this._prevSelectedIndex = -1;
            this._replaceList(new St.Label({text: '読み込み中…', style_class: 'simpleclipboard-meta'}));
        }

        try {
            const items = await this._fetchPage(tab, query, fetchCount, 0);
            if (this._destroyed || generation !== this._loadGeneration)
                return;
            this._hasLoadedOnce = true;
            this._listStale = false;
            this._renderedItems = [];
            this._prevSelectedIndex = -1;
            this._loadedCount = items.length;
            this._hasMore = items.length >= fetchCount;
            this._lastRenderedGroup = null;
            this._lastGalleryRow = null;
            this._lastGallerySpacer = null;
            this._loadMoreIndicator = null;
            this._renderNowDate = new Date();
            this._renderNowMs = this._renderNowDate.getTime();
            this._list.destroy_all_children();

            if (items.length === 0) {
                this._selectedIndex = -1;
                this._list.add_child(this._emptyState(tab, query.trim()));
            } else {
                this._appendItems(tab, items);

                if (resetScroll) {
                    this._selectedIndex = -1;
                } else if (previousSelectedId) {
                    const matched = this._renderedItems.findIndex(
                        entry => entry.item.id === previousSelectedId
                    );
                    this._selectedIndex = matched;
                    if (matched >= 0)
                        this._applySelectionStyles();
                } else {
                    this._selectedIndex = -1;
                }
            }

            if (resetScroll) {
                this._scroll.vadjustment.value = 0;
            } else {
                const adjustment = this._scroll.vadjustment;
                const maximum = Math.max(adjustment.lower, adjustment.upper - adjustment.page_size);
                adjustment.value = Math.min(maximum, previousScroll);
            }
        } catch (error) {
            if (!this._destroyed && generation === this._loadGeneration) {
                this._listStale = false;
                this._renderedItems = [];
                this._selectedIndex = -1;
                this._prevSelectedIndex = -1;
                this._loadedCount = 0;
                this._hasMore = false;
                this._replaceList(new St.Label({
                    text: '保存サービスに接続できません。設定から状態を確認してください。',
                    style_class: 'simpleclipboard-error',
                }));
                console.error(`SimpleClipboard: ${error.message}`);
            }
        }
    }

    _maybeLoadMore() {
        if (!this.visible || this._destroyed || this._previewVisible ||
            this._listStale || this._loadingMore || !this._hasMore)
            return;
        const adjustment = this._scroll.vadjustment;
        if (adjustment.upper <= adjustment.page_size)
            return;
        const remaining = adjustment.upper - (adjustment.value + adjustment.page_size);
        if (remaining <= LOAD_MORE_THRESHOLD_PX)
            this._loadNextPage();
    }

    async _loadNextPage() {
        if (this._destroyed || this._listStale || this._loadingMore || !this._hasMore)
            return;
        const generation = this._loadGeneration;
        const tab = this._activeTab;
        const query = this._search?.get_text() ?? '';
        const offset = this._loadedCount;
        this._loadingMore = true;

        this._loadMoreIndicator = new St.Label({
            text: 'さらに読み込み中…',
            x_align: Clutter.ActorAlign.CENTER,
            style_class: 'simpleclipboard-load-more',
        });
        this._list.add_child(this._loadMoreIndicator);

        try {
            const items = await this._fetchPage(tab, query, PAGE_SIZE, offset);
            if (this._destroyed || generation !== this._loadGeneration)
                return;
            if (this._loadMoreIndicator) {
                this._loadMoreIndicator.destroy();
                this._loadMoreIndicator = null;
            }
            if (items.length === 0) {
                this._hasMore = false;
                return;
            }
            this._loadedCount += items.length;
            this._hasMore = items.length >= PAGE_SIZE;
            this._appendItems(tab, items);
        } catch (error) {
            if (!this._destroyed && generation === this._loadGeneration) {
                if (this._loadMoreIndicator) {
                    this._loadMoreIndicator.destroy();
                    this._loadMoreIndicator = null;
                }
                this._hasMore = false;
                console.debug(`SimpleClipboard: load more failed: ${error.message}`);
            }
        } finally {
            if (generation === this._loadGeneration)
                this._loadingMore = false;
        }
    }

    _appendItems(tab, items) {
        if (tab === 'images')
            this._appendGroupedGallery(items);
        else
            this._appendGroupedRows(items);
    }

    _replaceList(actor) {
        this._list.destroy_all_children();
        this._list.add_child(actor);
    }

    _emptyState(tab, trimmedQuery = '') {
        const box = new St.BoxLayout({vertical: true, style_class: 'simpleclipboard-empty'});
        if (trimmedQuery) {
            box.add_child(new St.Icon({
                icon_name: 'system-search-symbolic',
                icon_size: 32,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            box.add_child(new St.Label({
                text: `「${Helpers.formatPreview(trimmedQuery, 24)}」に一致する項目はありません`,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            const clear = new St.Button({
                label: '検索をクリア',
                can_focus: true,
                x_align: Clutter.ActorAlign.CENTER,
                style_class: 'simpleclipboard-secondary-button',
            });
            clear.connect('clicked', () => {
                this._search.set_text('');
                this._search.grab_key_focus();
            });
            box.add_child(clear);
            return box;
        }

        box.add_child(new St.Icon({
            icon_name: tab === 'images'
                ? 'image-x-generic-symbolic'
                : tab === 'notes'
                    ? 'document-edit-symbolic'
                    : tab === 'pinned'
                        ? 'view-pin-symbolic'
                        : 'edit-paste-symbolic',
            icon_size: 34,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        const message = tab === 'notes'
            ? '入力欄からメモを追加できます'
            : tab === 'pinned'
                ? 'ピン留めした項目はまだありません'
                : 'ここにはまだ何もありません';
        box.add_child(new St.Label({
            text: message,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        return box;
    }

    _appendGroupedRows(items) {
        for (const item of items) {
            const group = Helpers.dateGroupLabel(item.created_at, this._renderNowDate);
            if (group !== this._lastRenderedGroup) {
                this._lastRenderedGroup = group;
                this._list.add_child(new St.Label({
                    text: group,
                    style_class: 'simpleclipboard-section-title',
                    x_align: Clutter.ActorAlign.START,
                }));
            }
            const index = this._renderedItems.length;
            const row = this._historyRow(item, index, this._renderNowMs);
            this._renderedItems.push({item, actor: row, selectedClass: 'simpleclipboard-row-selected'});
            this._list.add_child(row);
        }
    }

    _appendGroupedGallery(items) {
        const columns = this._galleryColumns();
        for (const item of items) {
            const group = Helpers.dateGroupLabel(item.created_at, this._renderNowDate);
            if (group !== this._lastRenderedGroup) {
                this._lastRenderedGroup = group;
                this._lastGalleryRow = null;
                this._lastGallerySpacer = null;
                this._list.add_child(new St.Label({
                    text: group,
                    style_class: 'simpleclipboard-section-title',
                    x_align: Clutter.ActorAlign.START,
                }));
            }

            const card = this._imageCard(item, this._renderedItems.length, this._renderNowMs);
            this._renderedItems.push({
                item,
                actor: card,
                selectedClass: 'simpleclipboard-image-card-selected',
            });

            if (columns === 2 && this._lastGalleryRow && this._lastGallerySpacer) {
                this._lastGallerySpacer.destroy();
                this._lastGallerySpacer = null;
                this._lastGalleryRow.add_child(card);
                this._lastGalleryRow = null;
            } else {
                const row = new St.BoxLayout({style_class: 'simpleclipboard-gallery-row'});
                row.add_child(card);
                if (columns === 2) {
                    const spacer = new St.Widget({
                        x_expand: true,
                        style_class: 'simpleclipboard-gallery-spacer',
                    });
                    row.add_child(spacer);
                    this._lastGalleryRow = row;
                    this._lastGallerySpacer = spacer;
                } else {
                    this._lastGalleryRow = null;
                    this._lastGallerySpacer = null;
                }
                this._list.add_child(row);
            }
        }
    }

    _galleryColumns() {
        return this._panelWidth < 500 ? 1 : 2;
    }

    _historyRow(item, index, nowMs) {
        const row = new St.BoxLayout({
            style_class: `simpleclipboard-row${item.pinned ? ' simpleclipboard-row-pinned' : ''}`,
        });
        const visual = new St.Button({
            can_focus: false,
            accessible_name: '選択して貼り付け',
            child: this._rowVisual(item),
            style_class: 'simpleclipboard-row-visual-button',
        });
        this._forwardScrollEvents(visual);
        this._attachSecondaryPreview(visual, item);
        visual.connect('clicked', () => this._copy(item, {copyOnly: this._isCopyOnlyModifierActive()}));
        row.add_child(visual);

        const main = new St.Button({
            can_focus: true,
            x_expand: true,
            style_class: 'simpleclipboard-row-main',
        });
        this._forwardScrollEvents(main);
        this._attachSecondaryPreview(main, item);
        main.connect('key-focus-in', () => this._setSelectedIndex(index, {scroll: false}));

        const content = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'simpleclipboard-row-content'});
        const text = item.kind === 'image' ? 'スクリーンショット' : (item.text ?? '');
        const preview = new St.Label({
            text: Helpers.formatPreview(text, 110),
            style_class: 'simpleclipboard-row-text',
            x_align: Clutter.ActorAlign.START,
        });
        preview.clutter_text.set_line_wrap(true);
        preview.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        preview.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        preview.clip_to_allocation = true;
        content.add_child(preview);

        const metaBar = new St.BoxLayout({style_class: 'simpleclipboard-meta-bar'});
        metaBar.add_child(new St.Label({
            text: Helpers.formatRowSource(item),
            style_class: 'simpleclipboard-source-chip',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const detail = Helpers.formatRowDetail(item);
        if (detail) {
            metaBar.add_child(new St.Label({
                text: detail,
                style_class: 'simpleclipboard-meta',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        metaBar.add_child(new St.Label({
            text: Helpers.formatRelativeTime(item.created_at, nowMs),
            style_class: 'simpleclipboard-meta simpleclipboard-meta-time',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        content.add_child(metaBar);

        main.set_child(content);
        main.connect('clicked', () => this._copy(item, {copyOnly: this._isCopyOnlyModifierActive()}));
        row.add_child(main);

        const actions = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'simpleclipboard-row-actions',
        });
        if (item.kind === 'note') {
            actions.add_child(this._itemAction(
                'document-edit-symbolic',
                'メモを編集',
                () => this._startNoteEdit(item)
            ));
        }
        actions.add_child(this._itemAction(
            'view-pin-symbolic',
            item.pinned ? 'ピンを外す' : 'ピン留め',
            () => this._togglePin(item),
            item.pinned
        ));
        const deleteButton = this._itemAction('user-trash-symbolic', '削除', () => this._delete(item));
        deleteButton.add_style_class_name('simpleclipboard-delete-button');
        actions.add_child(deleteButton);
        row.add_child(actions);
        return row;
    }

    _rowVisual(item) {
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const previewPath = item.thumb_path || item.blob_path;
        if (item.kind === 'image' && previewPath) {
            const visual = new St.Bin({style_class: 'simpleclipboard-row-thumb'});
            const texture = St.TextureCache.get_default().load_file_async(
                Gio.File.new_for_path(previewPath), 56, 40, scaleFactor, 1.0
            );
            texture.set_content_gravity(Clutter.ContentGravity.RESIZE_ASPECT);
            visual.set_child(texture);
            return visual;
        }

        const colorHex = item.kind === 'text' ? Helpers.detectColorHex(item.text) : null;
        const isUrl = item.kind === 'text' && !colorHex && Helpers.isHttpUrl(item.text);

        let extraClass = '';
        if (item.kind === 'note')
            extraClass = ' simpleclipboard-note-visual';
        else if (isUrl)
            extraClass = ' simpleclipboard-link-visual';

        const badge = new St.Bin({
            style_class: `simpleclipboard-row-badge${extraClass}`,
        });
        if (colorHex) {
            badge.set_child(new St.Widget({
                style_class: 'simpleclipboard-color-swatch',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: `background-color: ${colorHex};`,
            }));
        } else {
            badge.set_child(new St.Icon({
                icon_name: item.kind === 'note'
                    ? 'document-edit-symbolic'
                    : isUrl
                        ? 'insert-link-symbolic'
                        : 'text-x-generic-symbolic',
                icon_size: 16,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        return badge;
    }

    _imageCard(item, index, nowMs) {
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const previewPath = item.thumb_path || item.blob_path;
        const card = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: `simpleclipboard-image-card${item.pinned ? ' simpleclipboard-image-card-pinned' : ''}`,
        });
        const preview = new St.Button({
            can_focus: true,
            x_expand: true,
            accessible_name: '画像を選択して貼り付け（右クリックで拡大表示）',
            style_class: 'simpleclipboard-thumbnail',
        });
        this._forwardScrollEvents(preview);
        this._attachSecondaryPreview(preview, item);
        preview.connect('key-focus-in', () => this._setSelectedIndex(index, {scroll: false}));
        if (previewPath) {
            const texture = St.TextureCache.get_default().load_file_async(
                Gio.File.new_for_path(previewPath), 260, 146, scaleFactor, 1.0
            );
            texture.set_content_gravity(Clutter.ContentGravity.RESIZE_ASPECT);
            preview.set_child(texture);
        }
        preview.connect('clicked', () => this._copy(item, {copyOnly: this._isCopyOnlyModifierActive()}));
        card.add_child(preview);

        const footer = new St.BoxLayout({style_class: 'simpleclipboard-card-footer'});
        const meta = new St.Label({
            text: Helpers.formatImageMeta(item, nowMs),
            style_class: 'simpleclipboard-meta',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        meta.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        footer.add_child(meta);
        footer.add_child(this._itemAction(
            'view-pin-symbolic',
            item.pinned ? 'ピンを外す' : 'ピン留め',
            () => this._togglePin(item),
            item.pinned
        ));
        const deleteButton = this._itemAction('user-trash-symbolic', '削除', () => this._delete(item));
        deleteButton.add_style_class_name('simpleclipboard-delete-button');
        footer.add_child(deleteButton);
        card.add_child(footer);
        return card;
    }

    _attachSecondaryPreview(actor, item) {
        actor.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === 3) {
                this._openPreview(item);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _iconButton(iconName, accessibleName) {
        return new St.Button({
            can_focus: true,
            accessible_name: accessibleName,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
    }

    _itemAction(icon, label, callback, active = false) {
        const button = this._iconButton(icon, label);
        this._forwardScrollEvents(button);
        button.add_style_class_name('simpleclipboard-icon-button');
        if (active)
            button.add_style_class_name('simpleclipboard-pin-active');
        button.connect('clicked', callback);
        return button;
    }

    _forwardScrollEvents(actor) {
        actor.connect('scroll-event', (_actor, event) => this._onScroll(event));
        actor.connect('button-press-event', (_actor, event) => {
            const button = event.get_button();
            if (button === 4)
                return this._scrollAtPointer(event, -56);
            if (button === 5)
                return this._scrollAtPointer(event, 56);
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _isCopyOnlyModifierActive(state = null) {
        const mask = state ?? Clutter.get_current_event()?.get_state() ?? 0;
        return Boolean(mask & (Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.CONTROL_MASK));
    }

    _setSelectedIndex(index, {scroll = true} = {}) {
        if (this._listStale || this._renderedItems.length === 0) {
            this._prevSelectedIndex = this._selectedIndex;
            this._selectedIndex = -1;
            this._applySelectionStyles();
            return;
        }
        const bounded = Math.max(0, Math.min(this._renderedItems.length - 1, index));
        this._prevSelectedIndex = this._selectedIndex;
        this._selectedIndex = bounded;
        this._applySelectionStyles();
        if (scroll) {
            this._ensureActorVisible(this._renderedItems[bounded]?.actor);
            if (bounded >= this._renderedItems.length - 4)
                this._loadNextPage();
        }
    }

    _applySelectionStyles() {
        if (this._prevSelectedIndex >= 0 && this._prevSelectedIndex !== this._selectedIndex) {
            const prev = this._renderedItems[this._prevSelectedIndex];
            prev?.actor?.remove_style_class_name(prev.selectedClass);
        }
        if (this._selectedIndex >= 0) {
            const current = this._renderedItems[this._selectedIndex];
            current?.actor?.add_style_class_name(current.selectedClass);
        }
        this._prevSelectedIndex = this._selectedIndex;
    }

    _ensureActorVisible(actor) {
        if (!actor || !this._scroll)
            return;
        const adjustment = this._scroll.vadjustment;
        const [, scrollY] = this._scroll.get_transformed_position();
        const [, scrollHeight] = this._scroll.get_transformed_size();
        const [, actorY] = actor.get_transformed_position();
        const [, actorHeight] = actor.get_transformed_size();
        if (scrollHeight <= 0 || actorHeight <= 0)
            return;
        const padding = 8;
        const topDelta = actorY - (scrollY + padding);
        const bottomDelta = (actorY + actorHeight) - (scrollY + scrollHeight - padding);
        const maximum = Math.max(adjustment.lower, adjustment.upper - adjustment.page_size);
        if (topDelta < 0)
            adjustment.value = Math.max(adjustment.lower, adjustment.value + topDelta);
        else if (bottomDelta > 0)
            adjustment.value = Math.min(maximum, adjustment.value + bottomDelta);
    }

    _activateSelectedOrFirst(copyOnly = false) {
        if (this._listStale || this._renderedItems.length === 0)
            return false;
        const index = this._selectedIndex >= 0 ? this._selectedIndex : 0;
        const entry = this._renderedItems[index];
        if (!entry)
            return false;
        this._copy(entry.item, {copyOnly});
        return true;
    }

    cancelPendingPaste() {
        this._copyGeneration++;
        if (this._pasteSource) {
            GLib.source_remove(this._pasteSource);
            this._pasteSource = 0;
        }
    }

    async _copy(item, {copyOnly = false} = {}) {
        const copyGen = ++this._copyGeneration;
        const targetWindow = this._sourceWindow;
        try {
            const fullItem = await this._service.json('GetItem', item.id);
            if (this._destroyed || copyGen !== this._copyGeneration)
                return;
            if (fullItem.kind === 'image' && fullItem.blob_path) {
                const file = Gio.File.new_for_path(fullItem.blob_path);
                const contents = await new Promise((resolve, reject) => {
                    file.load_contents_async(null, (source, result) => {
                        try {
                            const [, bytes] = source.load_contents_finish(result);
                            resolve(bytes);
                        } catch (error) {
                            reject(error);
                        }
                    });
                });
                if (this._destroyed || copyGen !== this._copyGeneration)
                    return;
                this._monitor.suppressNext();
                St.Clipboard.get_default().set_content(
                    CLIPBOARD, fullItem.mime, GLib.Bytes.new(contents)
                );
            } else {
                this._monitor.suppressNext();
                St.Clipboard.get_default().set_text(CLIPBOARD, fullItem.text ?? '');
            }
            this._service.call('RecordUsed', item.id).catch(() => {});
            this.close({cancelCopy: false});
            if (!copyOnly && this._settings.get_boolean('paste-on-select'))
                this._schedulePaste(targetWindow, copyGen);
        } catch (error) {
            if (!this._destroyed && copyGen === this._copyGeneration)
                Main.notifyError('SimpleClipboard', `コピーできませんでした: ${error.message}`);
        }
    }

    _schedulePaste(targetWindow, copyGen) {
        if (this._destroyed || copyGen !== this._copyGeneration)
            return;
        if (this._pasteSource) {
            GLib.source_remove(this._pasteSource);
            this._pasteSource = 0;
        }
        if (!targetWindow?.get_compositor_private()) {
            Main.notify('SimpleClipboard', 'コピーしました。貼り付け先は見つかりませんでした。');
            return;
        }

        this._pasteSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._pasteSource = 0;
            if (this._destroyed || copyGen !== this._copyGeneration ||
                Main.modalCount > 0 || !targetWindow?.get_compositor_private())
                return GLib.SOURCE_REMOVE;
            try {
                global.stage.set_key_focus(null);
                targetWindow.activate(global.get_current_time());
            } catch (error) {
                Main.notifyError('SimpleClipboard', `貼り付け先へ戻れませんでした: ${error.message}`);
                return GLib.SOURCE_REMOVE;
            }

            let waitRetries = 0;
            const dispatchPaste = () => {
                this._pasteSource = 0;
                if (this._destroyed || copyGen !== this._copyGeneration)
                    return GLib.SOURCE_REMOVE;
                if (Main.modalCount > 0 || !targetWindow?.get_compositor_private() ||
                    global.display.focus_window !== targetWindow) {
                    Main.notify('SimpleClipboard', 'コピーしました。フォーカスが移動したため自動貼り付けを中止しました。');
                    return GLib.SOURCE_REMOVE;
                }
                const [, , heldMods] = global.get_pointer();
                const blockingMods = heldMods & (
                    Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK
                );
                if (blockingMods !== 0 && waitRetries < 6) {
                    waitRetries++;
                    this._pasteSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, dispatchPaste);
                    return GLib.SOURCE_REMOVE;
                }
                try {
                    this._sendPasteShortcut(targetWindow);
                } catch (error) {
                    Main.notifyError(
                        'SimpleClipboard',
                        `自動貼り付けに失敗しました。内容はコピー済みです: ${error.message}`
                    );
                }
                return GLib.SOURCE_REMOVE;
            };
            this._pasteSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 70, dispatchPaste);
            return GLib.SOURCE_REMOVE;
        });
    }

    _sendPasteShortcut(targetWindow) {
        this._virtualKeyboard ??= Clutter.get_default_backend()
            .get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        const terminalPaste = Helpers.isTerminalWmClass(targetWindow.get_wm_class());
        const keys = [Clutter.KEY_Control_L];
        if (terminalPaste)
            keys.push(Clutter.KEY_Shift_L);
        keys.push(Clutter.KEY_v);

        const now = GLib.get_monotonic_time();
        let offset = 0;
        const pressed = [];
        try {
            for (const key of keys) {
                this._virtualKeyboard.notify_keyval(
                    now + offset++ * 1000, key, Clutter.KeyState.PRESSED
                );
                pressed.push(key);
            }
            for (const key of [...keys].reverse()) {
                this._virtualKeyboard.notify_keyval(
                    now + offset++ * 1000, key, Clutter.KeyState.RELEASED
                );
                pressed.pop();
            }
        } finally {
            while (pressed.length > 0) {
                const key = pressed.pop();
                try {
                    this._virtualKeyboard.notify_keyval(
                        GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED
                    );
                } catch (_) {
                    // Avoid leaving modifiers pressed if input injection fails partway through.
                }
            }
        }
    }

    async _saveNote() {
        if (this._savingNote)
            return;
        const text = this._noteEntry.get_text();
        if (!text.trim())
            return;
        const editingId = this._editingNoteId;
        this._savingNote = true;
        this._noteSaveButton.reactive = false;
        try {
            if (editingId) {
                await this._service.call('UpdateNote', editingId, text);
                if (this._destroyed)
                    return;
                if (this._noteEntry.get_text() === text) {
                    if (this._editingNoteId === editingId)
                        this._editingNoteId = null;
                    this._noteEntry.set_text('');
                }
                this._syncComposeControls();
                this._showToast('メモを更新しました');
            } else {
                await this._service.call('AddNote', text, this._newNotePinned);
                if (this._destroyed)
                    return;
                if (this._noteEntry.get_text() === text)
                    this._noteEntry.set_text('');
                this._showToast(this._newNotePinned ? 'ピン留めメモを保存しました' : 'メモを保存しました');
            }
            this._reload({resetScroll: !editingId});
            this._refreshPanelHeight();
        } catch (error) {
            Main.notifyError('SimpleClipboard', `メモを保存できませんでした: ${error.message}`);
        } finally {
            this._savingNote = false;
            if (!this._destroyed && this._noteSaveButton)
                this._noteSaveButton.reactive = true;
        }
    }

    async _togglePin(item) {
        try {
            const updated = await this._service.json('TogglePin', item.id);
            this._reload({resetScroll: false});
            return updated;
        } catch (error) {
            Main.notifyError('SimpleClipboard', `ピンを変更できませんでした: ${error.message}`);
            return null;
        }
    }

    async _delete(item) {
        try {
            await this._service.call('DeleteItem', item.id);
            if (this._editingNoteId === item.id)
                this._cancelNoteEdit();
            if (this._previewItem?.id === item.id)
                this._closePreview({refocus: true});
            this._reload({resetScroll: false});
            this._refreshPanelHeight();
        } catch (error) {
            Main.notifyError('SimpleClipboard', `削除できませんでした: ${error.message}`);
        }
    }

    _isInTextEntry() {
        const focus = global.stage.get_key_focus();
        return focus === this._search.clutter_text || focus === this._noteEntry.clutter_text;
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = Boolean(state & Clutter.ModifierType.CONTROL_MASK);
        const shift = Boolean(state & Clutter.ModifierType.SHIFT_MASK);
        const alt = Boolean(state & Clutter.ModifierType.MOD1_MASK);
        const inSearch = global.stage.get_key_focus() === this._search.clutter_text;
        const inNote = global.stage.get_key_focus() === this._noteEntry.clutter_text;

        if (this._previewVisible) {
            if (symbol === Clutter.KEY_Escape ||
                (!this._isInTextEntry() && symbol === Clutter.KEY_space) ||
                (ctrl && (symbol === Clutter.KEY_o || symbol === Clutter.KEY_O))) {
                this._closePreview({refocus: true});
                return Clutter.EVENT_STOP;
            }
            if ((symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) &&
                this._previewItem && !this._isInTextEntry()) {
                this._copy(this._previewItem, {copyOnly: shift || ctrl});
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_Down || symbol === Clutter.KEY_Up) {
                const adj = this._previewScroll.vadjustment;
                const maximum = Math.max(adj.lower, adj.upper - adj.page_size);
                const step = symbol === Clutter.KEY_Down ? 48 : -48;
                adj.value = Math.min(maximum, Math.max(adj.lower, adj.value + step));
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (symbol === Clutter.KEY_Escape) {
            if (this._editingNoteId !== null) {
                this._cancelNoteEdit();
                return Clutter.EVENT_STOP;
            }
            if (this._search.get_text().length > 0) {
                this._search.set_text('');
                this._search.grab_key_focus();
                return Clutter.EVENT_STOP;
            }
            this.close();
            return Clutter.EVENT_STOP;
        }

        if (alt && !ctrl && !inNote && !this._listStale) {
            const quickIndex = symbol - Clutter.KEY_1;
            if (quickIndex >= 0 && quickIndex < 9 && quickIndex < this._renderedItems.length) {
                const entry = this._renderedItems[quickIndex];
                if (entry) {
                    this._copy(entry.item, {copyOnly: shift});
                    return Clutter.EVENT_STOP;
                }
            }
        }

        if (ctrl) {
            const index = symbol - Clutter.KEY_1;
            if (index >= 0 && index < TABS.length) {
                this._setTab(TABS[index][0], {resetScroll: true});
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab) {
                const current = TABS.findIndex(([id]) => id === this._activeTab);
                const step = shift || symbol === Clutter.KEY_ISO_Left_Tab ? -1 : 1;
                const next = (current + step + TABS.length) % TABS.length;
                this._setTab(TABS[next][0], {resetScroll: true});
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_f || symbol === Clutter.KEY_F) {
                this._search.grab_key_focus();
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_n || symbol === Clutter.KEY_N) {
                this._focusNewNote();
                return Clutter.EVENT_STOP;
            }
            if ((symbol === Clutter.KEY_o || symbol === Clutter.KEY_O) && !inNote && !this._listStale) {
                const entry = this._renderedItems[this._selectedIndex >= 0 ? this._selectedIndex : 0];
                if (entry) {
                    this._openPreview(entry.item);
                    return Clutter.EVENT_STOP;
                }
            }
            if ((symbol === Clutter.KEY_p || symbol === Clutter.KEY_P) &&
                !this._listStale && this._selectedIndex >= 0) {
                const entry = this._renderedItems[this._selectedIndex];
                if (entry) {
                    this._togglePin(entry.item);
                    return Clutter.EVENT_STOP;
                }
            }
            if ((symbol === Clutter.KEY_Delete || symbol === Clutter.KEY_BackSpace) &&
                !this._isInTextEntry() && !this._listStale && this._selectedIndex >= 0) {
                const entry = this._renderedItems[this._selectedIndex];
                if (entry) {
                    this._delete(entry.item);
                    return Clutter.EVENT_STOP;
                }
            }
        }

        const columns = this._activeTab === 'images' ? this._galleryColumns() : 1;
        if (!inNote && (symbol === Clutter.KEY_Down || symbol === Clutter.KEY_Up)) {
            const direction = symbol === Clutter.KEY_Down ? 'down' : 'up';
            const next = Helpers.nextNavigationIndex(
                this._selectedIndex, this._renderedItems.length, direction, columns
            );
            if (next >= 0) {
                this._setSelectedIndex(next, {scroll: true});
                return Clutter.EVENT_STOP;
            }
        }

        if (!inNote && (symbol === Clutter.KEY_Page_Down || symbol === Clutter.KEY_Page_Up)) {
            const step = symbol === Clutter.KEY_Page_Down ? 4 * columns : -4 * columns;
            if (this._renderedItems.length > 0) {
                const base = this._selectedIndex >= 0 ? this._selectedIndex : 0;
                this._setSelectedIndex(base + step, {scroll: true});
                return Clutter.EVENT_STOP;
            }
        }

        const allowHorizontalNav = columns > 1 && !inNote && (!inSearch || this._search.get_text().length === 0);
        if (allowHorizontalNav && (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_Right)) {
            const direction = symbol === Clutter.KEY_Right ? 'right' : 'left';
            const next = Helpers.nextNavigationIndex(
                this._selectedIndex, this._renderedItems.length, direction, columns
            );
            if (next >= 0) {
                this._setSelectedIndex(next, {scroll: true});
                return Clutter.EVENT_STOP;
            }
        }

        if (!this._isInTextEntry() && !this._listStale) {
            if (symbol === Clutter.KEY_space && this._renderedItems.length > 0) {
                const entry = this._renderedItems[this._selectedIndex >= 0 ? this._selectedIndex : 0];
                if (entry) {
                    this._openPreview(entry.item);
                    return Clutter.EVENT_STOP;
                }
            }
            if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
                if (this._activateSelectedOrFirst(shift || ctrl))
                    return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_Delete && this._selectedIndex >= 0) {
                const entry = this._renderedItems[this._selectedIndex];
                if (entry) {
                    this._delete(entry.item);
                    return Clutter.EVENT_STOP;
                }
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _applyAppearance() {
        if (this._destroyed)
            return;
        const opacity = this._settings.get_int('panel-opacity') / 100;
        this._panel.set_style(`background-color: rgba(24, 24, 28, ${opacity});`);
        this._positionPanel();
        this._panel.remove_effect_by_name('simpleclipboard-blur');
        const radius = this._settings.get_int('blur-radius');
        if (radius > 0 && opacity < 1) {
            this._panel.add_effect_with_name('simpleclipboard-blur', new Shell.BlurEffect({
                mode: Shell.BlurMode.BACKGROUND,
                radius,
                brightness: 0.78,
            }));
        }
    }
});

export default class SimpleClipboardExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._service = new ServiceClient(this._settings);
        this._monitor = new ClipboardMonitor(this._service);
        this._capturePaused = false;
        this._dialog = new ClipboardDialog(
            this,
            this._service,
            this._monitor,
            paused => this._applyPauseState(paused)
        );
        this._monitor.setExternalChangeHandler(() => this._dialog?.cancelPendingPaste());

        this._indicator = new Indicator(
            tab => this._dialog.openTab(tab),
            () => this._toggleCapturePaused(),
            () => this._syncCapturePaused(),
            () => this.openPreferences()
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.visible = this._settings.get_boolean('show-indicator');
        this._indicatorSignal = this._settings.connect('changed::show-indicator', () => {
            this._indicator.visible = this._settings.get_boolean('show-indicator');
        });

        this._bindings = new Map([
            ['toggle-menu', 'history'],
            ['open-images', 'images'],
            ['open-notes', 'notes'],
            ['open-pinned', 'pinned'],
        ]);
        this._bindingSignals = [];
        for (const [name, tab] of this._bindings) {
            this._sanitizeBinding(name);
            this._bindingSignals.push(
                this._settings.connect(`changed::${name}`, () => this._sanitizeBinding(name))
            );
            Main.wm.addKeybinding(
                name,
                this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL,
                () => this._dialog.openTab(tab)
            );
        }
        this._syncCapturePaused();
    }

    _sanitizeBinding(name) {
        const current = this._settings.get_strv(name);
        const safe = current.filter(accel => Helpers.isSafeAcceleratorString(accel));
        if (safe.length !== current.length)
            this._settings.set_strv(name, safe);
    }

    _applyPauseState(paused) {
        this._capturePaused = Boolean(paused);
        if (this._capturePaused)
            this._monitor?.cancelActiveCapture();
        this._indicator?.setPaused(this._capturePaused);
        this._dialog?.setCapturePaused(this._capturePaused);
    }

    async _syncCapturePaused() {
        if (!this._service)
            return;
        try {
            const paused = await this._service.call('GetSetting', 'capture_paused') === 'true';
            if (this._indicator)
                this._applyPauseState(paused);
        } catch (_) {
            // Daemon may not be active yet at shell startup.
        }
    }

    async _toggleCapturePaused() {
        if (!this._service)
            return;
        const nextPaused = !this._capturePaused;
        try {
            await this._service.call('SetSetting', 'capture_paused', nextPaused ? 'true' : 'false');
            if (this._indicator)
                this._applyPauseState(nextPaused);
        } catch (error) {
            Main.notifyError('SimpleClipboard', `記録状態を変更できませんでした: ${error.message}`);
        }
    }

    disable() {
        for (const signal of this._bindingSignals ?? [])
            this._settings.disconnect(signal);
        this._bindingSignals = null;
        for (const name of this._bindings?.keys() ?? [])
            Main.wm.removeKeybinding(name);
        this._bindings = null;

        if (this._indicatorSignal)
            this._settings.disconnect(this._indicatorSignal);
        this._indicatorSignal = 0;
        this._indicator?.destroy();
        this._indicator = null;
        this._dialog?.destroy();
        this._dialog = null;
        this._monitor?.destroy();
        this._monitor = null;
        this._service?.destroy();
        this._service = null;
        this._settings = null;
    }
}
