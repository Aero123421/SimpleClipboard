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

import {ServiceClient} from './serviceClient.js';

Gio._promisify(Meta.SelectionSource.prototype, 'read_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');
Gio._promisify(Gio._LocalFilePrototype, 'replace_async');

const CLIPBOARD = St.ClipboardType.CLIPBOARD;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_CAPTURE_TEXT_BYTES = 1024 * 1024;
const MAX_CAPTURE_IMAGE_BYTES = 32 * 1024 * 1024;
const TABS = [
    ['history', '履歴', 'document-open-recent-symbolic'],
    ['images', '画像', 'image-x-generic-symbolic'],
    ['notes', 'メモ', 'document-edit-symbolic'],
    ['pinned', 'ピン', 'view-pin-symbolic'],
];

class ClipboardMonitor {
    constructor(service) {
        this._service = service;
        this._selection = global.display.get_selection();
        this._generation = 0;
        this._cancellable = null;
        this._suppressOnce = false;
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

    suppressNext() {
        this._suppressOnce = true;
        if (this._suppressSource)
            GLib.source_remove(this._suppressSource);
        this._suppressSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
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
            return;
        }
        if (!source)
            return;

        const sourceApp = global.display.focus_window?.get_wm_class() ?? '';
        const mimetypes = source.get_mimetypes() ?? [];
        const imageMime = ['image/png', 'image/jpeg'].find(type => mimetypes.includes(type));
        const textMime = mimetypes.find(type => type.startsWith('text/plain')) ??
            (mimetypes.includes('UTF8_STRING') ? 'UTF8_STRING' : null);
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
        const stream = await source.read_async(mime, cancellable);
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
        const text = new TextDecoder().decode(contents);
        if (text)
            await this._service.call('CaptureText', text, sourceApp);
    }

    async _captureImage(source, mime, sourceApp, generation, cancellable) {
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
                await output.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, cancellable);
            }
            await output.close_async(GLib.PRIORITY_DEFAULT, cancellable);
            output = null;
            if (generation !== this._generation || total === 0)
                return;
            await this._service.call('CaptureImage', path, mime, sourceApp);
        } finally {
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
    _init(open, openPreferences) {
        super._init(0.0, 'SimpleClipboard');
        this.add_child(new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        }));

        const openItem = new PopupMenu.PopupMenuItem('クリップボードを開く');
        openItem.connect('activate', () => open('history'));
        this.menu.addMenuItem(openItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settingsItem = new PopupMenu.PopupMenuItem('設定');
        settingsItem.connect('activate', openPreferences);
        this.menu.addMenuItem(settingsItem);
    }
});

const ClipboardDialog = GObject.registerClass(
class ClipboardDialog extends St.Widget {
    _init(extension, service, monitor) {
        super._init({
            reactive: true,
            visible: false,
            opacity: 0,
        });
        this._extension = extension;
        this._service = service;
        this._monitor = monitor;
        this._activeTab = 'history';
        this._loadGeneration = 0;
        this._tabButtons = new Map();
        this._settings = extension.getSettings();
        this._panelHeight = 300;
        this._sourceWindow = null;
        this._pasteSource = 0;
        this._focusSource = 0;
        this._closeSource = 0;
        this._closeGeneration = 0;
        this._closing = false;
        this._heightGeneration = 0;
        this._destroyed = false;
        this._virtualKeyboard = null;

        this._panel = new St.BoxLayout({
            vertical: true,
            reactive: true,
            style_class: 'simpleclipboard-panel',
        });
        this.add_child(this._panel);
        Main.uiGroup.add_child(this);

        this._buildHeader();
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
                    this._reload();
            }),
            this._settings.connect('changed::panel-height', () => this._refreshPanelHeight()),
            this._settings.connect('changed::blur-radius', () => this._applyAppearance()),
        ];
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
        this._heightGeneration++;
        for (const signal of this._settingsSignals)
            this._settings.disconnect(signal);
        this._settingsSignals = [];
        if (this._monitorsChanged)
            Main.layoutManager.disconnect(this._monitorsChanged);
        this._monitorsChanged = 0;
        if (this._pasteSource)
            GLib.source_remove(this._pasteSource);
        this._pasteSource = 0;
        if (this._focusSource)
            GLib.source_remove(this._focusSource);
        this._focusSource = 0;
        if (this._closeSource)
            GLib.source_remove(this._closeSource);
        this._closeSource = 0;
        this._closeGeneration++;
        this._virtualKeyboard = null;
        super.destroy();
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

        if (!this.visible)
            this._sourceWindow = global.display.focus_window;
        this._setTab(nextTab);
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

    close() {
        if (this._destroyed || !this.visible || this._closing)
            return;
        this._closing = true;
        const generation = ++this._closeGeneration;
        this._loadGeneration++;
        this._heightGeneration++;
        if (this._focusSource)
            GLib.source_remove(this._focusSource);
        this._focusSource = 0;
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
    }

    _positionPanel() {
        if (this._destroyed)
            return;
        this.set_position(0, 0);
        this.set_size(global.stage.width, global.stage.height);

        const focusWindow = global.display.focus_window;
        let monitorIndex = focusWindow?.get_monitor() ?? -1;
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex ?? 0;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const margin = 18;
        const width = Math.max(1,
            Math.min(this._settings.get_int('panel-width'), workArea.width - margin * 2));
        const height = Math.max(1,
            Math.min(this._panelHeight, workArea.height - margin * 2));
        this._panel.set_size(width, height);
        this._panel.set_position(
            workArea.x + workArea.width - width - margin,
            workArea.y + workArea.height - height - margin
        );
    }

    async _refreshPanelHeight() {
        if (this._destroyed)
            return;
        const generation = ++this._heightGeneration;
        try {
            const items = await this._service.json('ListItems', 'history', '', 6);
            if (this._destroyed || generation !== this._heightGeneration)
                return;
            const maximum = this._settings.get_int('panel-height');
            const nextHeight = Math.min(maximum, Math.max(300, 184 + Math.min(items.length, 5) * 64));
            if (nextHeight === this._panelHeight)
                return;
            this._panelHeight = nextHeight;
            this._positionPanel();
        } catch (_) {
            if (this._destroyed || generation !== this._heightGeneration)
                return;
            this._panelHeight = Math.min(this._settings.get_int('panel-height'), 320);
            this._positionPanel();
        }
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
        if (!this.visible || !this._scroll)
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
        if (!this.visible || !this._scroll)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        const [scrollX, scrollY] = this._scroll.get_transformed_position();
        const [scrollWidth, scrollHeight] = this._scroll.get_transformed_size();
        const inside = x >= scrollX && x <= scrollX + scrollWidth &&
            y >= scrollY && y <= scrollY + scrollHeight;
        if (!inside)
            return Clutter.EVENT_PROPAGATE;

        const adjustment = this._scroll.vadjustment;
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

        const settings = this._labelIconButton('emblem-system-symbolic', '設定');
        settings.add_style_class_name('simpleclipboard-header-action');
        settings.connect('clicked', () => {
            this.close();
            this._extension.openPreferences();
        });
        const newNote = this._iconButton('document-edit-symbolic', '新しいメモ');
        newNote.add_style_class_name('simpleclipboard-header-note');
        newNote.connect('clicked', () => {
            this._setTab('notes');
            this._noteEntry.grab_key_focus();
        });
        header.add_child(newNote);
        header.add_child(settings);

        const close = this._iconButton('window-close-symbolic', '閉じる');
        close.add_style_class_name('simpleclipboard-header-close');
        close.connect('clicked', () => this.close());
        header.add_child(close);
        this._panel.add_child(header);
    }

    _buildSearch() {
        const searchWrap = new St.BoxLayout({style_class: 'simpleclipboard-search-wrap'});
        this._search = new St.Entry({
            hint_text: '履歴を検索',
            can_focus: true,
            x_expand: true,
            style_class: 'simpleclipboard-search',
        });
        this._search.set_primary_icon(new St.Icon({
            icon_name: 'system-search-symbolic',
            icon_size: 18,
        }));
        this._search.clutter_text.connect('text-changed', () => this._reload());
        searchWrap.add_child(this._search);
        this._panel.add_child(searchWrap);
    }

    _buildTabs() {
        const tabs = new St.BoxLayout({style_class: 'simpleclipboard-tabs'});
        for (const [id, label, iconName] of TABS) {
            const child = new St.BoxLayout({style_class: 'simpleclipboard-tab-content'});
            child.add_child(new St.Icon({icon_name: iconName, icon_size: 18}));
            child.add_child(new St.Label({text: label}));
            const button = new St.Button({
                can_focus: true,
                x_expand: true,
                accessible_name: label,
                child,
                style_class: 'simpleclipboard-tab',
            });
            button.connect('clicked', () => this._setTab(id));
            tabs.add_child(button);
            this._tabButtons.set(id, button);
        }
        this._panel.add_child(tabs);
    }

    _buildBody() {
        this._body = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style_class: 'simpleclipboard-body',
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
        this._compose = new St.BoxLayout({x_expand: true, style_class: 'simpleclipboard-compose'});
        this._noteEntry = new St.Entry({
            hint_text: '新しいメモを書く…',
            can_focus: true,
            x_expand: true,
            style_class: 'simpleclipboard-note-entry',
        });
        const save = new St.Button({
            label: '保存',
            can_focus: true,
            style_class: 'simpleclipboard-primary-button',
        });
        save.connect('clicked', () => this._saveNote());
        this._noteEntry.clutter_text.connect('activate', () => this._saveNote());
        this._compose.add_child(this._noteEntry);
        this._compose.add_child(save);
        this._body.add_child(this._compose);
        this._body.add_child(this._scroll);
        this._panel.add_child(this._body);
    }

    _setTab(tab) {
        this._activeTab = tab;
        for (const [id, button] of this._tabButtons)
            button.set_style_class_name(`simpleclipboard-tab${id === tab ? ' simpleclipboard-tab-active' : ''}`);
        this._compose.visible = tab === 'notes';
        this._search.hint_text = tab === 'images' ? '画像を検索' : tab === 'notes' ? 'メモを検索' : '履歴を検索';
        this._reload();
    }

    async _reload() {
        if (this._destroyed)
            return;
        const generation = ++this._loadGeneration;
        const tab = this._activeTab;
        const query = this._search?.get_text() ?? '';
        this._replaceList(new St.Label({text: '読み込み中…', style_class: 'simpleclipboard-meta'}));
        try {
            const items = await this._service.json('ListItems', tab, query, 100);
            if (generation !== this._loadGeneration)
                return;
            this._list.destroy_all_children();
            if (items.length === 0) {
                this._list.add_child(this._emptyState(tab));
            } else {
                this._list.add_child(new St.Label({
                    text: '最近',
                    style_class: 'simpleclipboard-section-title',
                    x_align: Clutter.ActorAlign.START,
                }));
                if (tab === 'images') {
                    this._renderGallery(items);
                } else {
                    for (const item of items)
                        this._list.add_child(this._historyRow(item));
                }
            }
            this._scroll.vadjustment.value = 0;
        } catch (error) {
            if (!this._destroyed && generation === this._loadGeneration) {
                this._replaceList(new St.Label({
                    text: '保存サービスに接続できません。設定から状態を確認してください。',
                    style_class: 'simpleclipboard-error',
                }));
                console.error(`SimpleClipboard: ${error.message}`);
            }
        }
    }

    _replaceList(actor) {
        this._list.destroy_all_children();
        this._list.add_child(actor);
    }

    _emptyState(tab) {
        const box = new St.BoxLayout({vertical: true, style_class: 'simpleclipboard-empty'});
        box.add_child(new St.Icon({
            icon_name: tab === 'images' ? 'image-x-generic-symbolic' : tab === 'notes' ? 'document-edit-symbolic' : 'edit-paste-symbolic',
            icon_size: 36,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            text: tab === 'notes' ? '入力欄からメモを追加できます' : 'ここにはまだ何もありません',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        return box;
    }

    _historyRow(item) {
        const row = new St.BoxLayout({style_class: 'simpleclipboard-row'});
        const visual = new St.Button({
            can_focus: false,
            accessible_name: '選択して貼り付け',
            child: this._rowVisual(item),
            style_class: 'simpleclipboard-row-visual-button',
        });
        this._forwardScrollEvents(visual);
        visual.connect('clicked', () => this._copy(item));
        row.add_child(visual);

        const main = new St.Button({
            can_focus: true,
            x_expand: true,
            style_class: 'simpleclipboard-row-main',
        });
        this._forwardScrollEvents(main);
        const content = new St.BoxLayout({vertical: true, x_expand: true});
        const text = item.kind === 'image' ? 'スクリーンショット' : (item.text ?? '');
        const preview = new St.Label({
            text: this._preview(text, 110),
            style_class: 'simpleclipboard-row-text',
            x_align: Clutter.ActorAlign.START,
        });
        preview.clutter_text.set_line_wrap(true);
        preview.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        preview.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        preview.clip_to_allocation = true;
        content.add_child(preview);
        content.add_child(new St.Label({
            text: `${item.kind === 'note' ? 'メモ' : item.source_app || 'クリップボード'}  •  ${this._relativeTime(item.created_at)}`,
            style_class: 'simpleclipboard-meta',
            x_align: Clutter.ActorAlign.START,
        }));
        main.set_child(content);
        main.connect('clicked', () => this._copy(item));
        row.add_child(main);
        row.add_child(this._itemAction(
            'view-pin-symbolic',
            item.pinned ? 'ピンを外す' : 'ピン留め',
            () => this._togglePin(item),
            item.pinned
        ));
        row.add_child(this._itemAction('user-trash-symbolic', '削除', () => this._delete(item)));
        return row;
    }

    _rowVisual(item) {
        const visual = new St.Bin({
            style_class: `simpleclipboard-row-visual${item.kind === 'note' ? ' simpleclipboard-note-visual' : ''}`,
        });
        if (item.kind === 'image' && item.blob_path) {
            const texture = St.TextureCache.get_default().load_file_async(
                Gio.File.new_for_path(item.blob_path), 64, 46, 1, 1.0
            );
            texture.set_content_gravity(Clutter.ContentGravity.RESIZE_ASPECT);
            visual.set_child(texture);
        } else {
            visual.set_child(new St.Icon({
                icon_name: item.kind === 'note' ? 'document-edit-symbolic' : 'text-x-generic-symbolic',
                icon_size: 24,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        return visual;
    }

    _renderGallery(items) {
        const columns = this._settings.get_int('panel-width') < 500 ? 1 : 2;
        for (let index = 0; index < items.length; index += columns) {
            const row = new St.BoxLayout({style_class: 'simpleclipboard-gallery-row'});
            row.add_child(this._imageCard(items[index]));
            if (columns === 2 && items[index + 1])
                row.add_child(this._imageCard(items[index + 1]));
            else if (columns === 2)
                row.add_child(new St.Widget({x_expand: true, style_class: 'simpleclipboard-gallery-spacer'}));
            this._list.add_child(row);
        }
    }

    _imageCard(item) {
        const card = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: `simpleclipboard-image-card${item.pinned ? ' simpleclipboard-image-card-pinned' : ''}`,
        });
        const preview = new St.Button({can_focus: true, x_expand: true, style_class: 'simpleclipboard-thumbnail'});
        this._forwardScrollEvents(preview);
        if (item.blob_path) {
            const texture = St.TextureCache.get_default().load_file_async(
                Gio.File.new_for_path(item.blob_path), 260, 146, 1, 1.0
            );
            texture.set_content_gravity(Clutter.ContentGravity.RESIZE_ASPECT);
            preview.set_child(texture);
        }
        preview.connect('clicked', () => this._copy(item));
        card.add_child(preview);
        const footer = new St.BoxLayout({style_class: 'simpleclipboard-card-footer'});
        footer.add_child(new St.Label({
            text: `${this._relativeTime(item.created_at)}  •  ${item.source_app || '画像'}`,
            style_class: 'simpleclipboard-meta',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        footer.add_child(this._itemAction(
            'view-pin-symbolic',
            item.pinned ? 'ピンを外す' : 'ピン留め',
            () => this._togglePin(item),
            item.pinned
        ));
        card.add_child(footer);
        return card;
    }

    _iconButton(iconName, accessibleName) {
        return new St.Button({
            can_focus: true,
            accessible_name: accessibleName,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
    }

    _labelIconButton(iconName, label) {
        const child = new St.BoxLayout({style_class: 'simpleclipboard-label-icon-content'});
        child.add_child(new St.Icon({icon_name: iconName, icon_size: 17}));
        child.add_child(new St.Label({text: label}));
        return new St.Button({
            can_focus: true,
            accessible_name: label,
            child,
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

    async _copy(item) {
        try {
            const fullItem = await this._service.json('GetItem', item.id);
            if (this._destroyed)
                return;
            const targetWindow = this._sourceWindow;
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
                if (this._destroyed)
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
            this.close();
            if (this._settings.get_boolean('paste-on-select'))
                this._schedulePaste(targetWindow);
        } catch (error) {
            Main.notifyError('SimpleClipboard', `コピーできませんでした: ${error.message}`);
        }
    }

    _schedulePaste(targetWindow) {
        if (this._destroyed)
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
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            try {
                global.stage.set_key_focus(null);
                targetWindow.activate(global.get_current_time());
            } catch (error) {
                Main.notifyError('SimpleClipboard', `貼り付け先へ戻れませんでした: ${error.message}`);
                return GLib.SOURCE_REMOVE;
            }

            this._pasteSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 70, () => {
                this._pasteSource = 0;
                if (this._destroyed)
                    return GLib.SOURCE_REMOVE;
                try {
                    this._sendPasteShortcut(targetWindow);
                } catch (error) {
                    Main.notifyError(
                        'SimpleClipboard',
                        `自動貼り付けに失敗しました。内容はコピー済みです: ${error.message}`
                    );
                }
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _sendPasteShortcut(targetWindow) {
        this._virtualKeyboard ??= Clutter.get_default_backend()
            .get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        const wmClass = (targetWindow.get_wm_class() ?? '').toLowerCase();
        const terminalClasses = [
            'alacritty', 'blackbox', 'console', 'foot', 'ghostty', 'gnome-terminal',
            'kgx', 'kitty', 'konsole', 'terminator', 'tilix', 'wezterm', 'xterm',
        ];
        const terminalPaste = terminalClasses.some(name => wmClass.includes(name));
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
        const text = this._noteEntry.get_text();
        if (!text.trim())
            return;
        try {
            await this._service.call('AddNote', text, false);
            this._noteEntry.set_text('');
            this._reload();
        } catch (error) {
            Main.notifyError('SimpleClipboard', `メモを保存できませんでした: ${error.message}`);
        }
    }

    async _togglePin(item) {
        try {
            await this._service.call('TogglePin', item.id);
            this._reload();
        } catch (error) {
            Main.notifyError('SimpleClipboard', `ピンを変更できませんでした: ${error.message}`);
        }
    }

    async _delete(item) {
        try {
            await this._service.call('DeleteItem', item.id);
            this._reload();
        } catch (error) {
            Main.notifyError('SimpleClipboard', `削除できませんでした: ${error.message}`);
        }
    }

    _preview(text, limit = 150) {
        const compact = text.replace(/\s+/g, ' ').trim();
        return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
    }

    _relativeTime(timestamp) {
        const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
        if (seconds < 60)
            return 'たった今';
        if (seconds < 3600)
            return `${Math.floor(seconds / 60)}分前`;
        if (seconds < 86400)
            return `${Math.floor(seconds / 3600)}時間前`;
        return `${Math.floor(seconds / 86400)}日前`;
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (state & Clutter.ModifierType.CONTROL_MASK) {
            const index = symbol - Clutter.KEY_1;
            if (index >= 0 && index < TABS.length) {
                this._setTab(TABS[index][0]);
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _applyAppearance() {
        if (this._destroyed)
            return;
        const opacity = this._settings.get_int('panel-opacity') / 100;
        this._panel.set_style(`background-color: rgba(28, 27, 30, ${opacity});`);
        this._positionPanel();
        this._panel.remove_effect_by_name('simpleclipboard-blur');
        const radius = this._settings.get_int('blur-radius');
        if (radius > 0) {
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
        this._dialog = new ClipboardDialog(this, this._service, this._monitor);

        this._indicator = new Indicator(
            tab => this._dialog.openTab(tab),
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
        for (const [name, tab] of this._bindings) {
            Main.wm.addKeybinding(
                name,
                this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL,
                () => this._dialog.openTab(tab)
            );
        }
    }

    disable() {
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
        this._service = null;
        this._settings = null;
    }
}
