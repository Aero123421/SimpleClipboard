import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {isSafeGlobalShortcut} from './helpers.js';
import {ServiceClient} from './serviceClient.js';

const SHORTCUTS = [
    ['toggle-menu', 'メニューを開く'],
    ['open-images', '画像を直接開く'],
    ['open-notes', 'メモを直接開く'],
    ['open-pinned', 'ピンを直接開く'],
];

const PANEL_POSITIONS = [
    ['bottom-right', '画面右下'],
    ['center', '画面中央'],
    ['pointer', 'カーソル付近'],
];

const SETTING_SAVE_DEBOUNCE_MS = 600;

export default class SimpleClipboardPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(680, 760);
        const settings = this.getSettings();
        const service = new ServiceClient(settings);
        const cleanup = {
            settingsSignals: [],
            pendingSaves: new Map(),
            inFlightSaves: new Set(),
            closed: false,
        };

        const page = new Adw.PreferencesPage({
            title: 'SimpleClipboard',
            icon_name: 'edit-paste-symbolic',
        });
        page.add(this._shortcutGroup(window, settings, cleanup));
        page.add(this._behaviorGroup(settings));
        page.add(this._appearanceGroup(settings, cleanup));
        const {group: excludedGroup, reload: reloadExcluded} =
            this._excludedAppsGroup(service, cleanup);
        const {group: historyGroup, reload: reloadHistory} =
            this._historyGroup(window, service, cleanup, () => reloadExcluded());
        page.add(historyGroup);
        page.add(excludedGroup);
        window.add(page);

        window.connect('close-request', () => {
            cleanup.closed = true;
            for (const signal of cleanup.settingsSignals)
                settings.disconnect(signal);
            cleanup.settingsSignals = [];
            const flushes = [...cleanup.inFlightSaves];
            for (const {sourceId, flush} of cleanup.pendingSaves.values()) {
                if (sourceId)
                    GLib.source_remove(sourceId);
                flushes.push(flush());
            }
            cleanup.pendingSaves.clear();
            Promise.allSettled(flushes).finally(() => service.destroy());
            return false;
        });

        reloadHistory();
        reloadExcluded();
    }

    _shortcutGroup(window, settings, cleanup) {
        const group = new Adw.PreferencesGroup({
            title: 'ショートカット',
            description: '初期状態では未設定です。おすすめはメニューを Super+V にすることです。パネル内では ↑↓ で選択、Enter で貼り付け、Shift+Enter でコピーのみ、Alt+1〜9 で即貼り付け、右クリックまたは Ctrl+O で全文プレビューが使えます。',
        });
        for (const [key, title] of SHORTCUTS)
            group.add(this._shortcutRow(window, settings, key, title, cleanup));
        return group;
    }

    _shortcutRow(window, settings, key, title, cleanup) {
        const row = new Adw.ActionRow({title, activatable: true});
        const label = new Gtk.ShortcutLabel({
            accelerator: settings.get_strv(key)[0] ?? '',
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(label);
        row.connect('activated', () => this._captureShortcut(window, settings, key, title));
        cleanup.settingsSignals.push(settings.connect(`changed::${key}`, () => {
            label.accelerator = settings.get_strv(key)[0] ?? '';
        }));
        return row;
    }

    _captureShortcut(parent, settings, key, title) {
        const dialog = new Gtk.Window({
            title,
            transient_for: parent,
            modal: true,
            default_width: 420,
            default_height: 180,
        });
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 14,
            margin_top: 28,
            margin_bottom: 28,
            margin_start: 28,
            margin_end: 28,
            valign: Gtk.Align.CENTER,
        });
        box.append(new Gtk.Image({icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic', pixel_size: 32}));
        const promptLabel = new Gtk.Label({
            label: '割り当てたいキーを押してください\nBackspaceで解除・Escでキャンセル',
            justify: Gtk.Justification.CENTER,
        });
        box.append(promptLabel);
        dialog.set_child(box);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            if (keyval === Gdk.KEY_Escape) {
                dialog.close();
                return true;
            }
            const modifiers = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === Gdk.KEY_BackSpace && modifiers === 0) {
                settings.set_strv(key, []);
                dialog.close();
                return true;
            }
            if (this._isModifier(keyval) || !Gtk.accelerator_valid(keyval, modifiers))
                return true;
            if (!isSafeGlobalShortcut(keyval, modifiers, Gdk.ModifierType.SHIFT_MASK)) {
                promptLabel.label = '文字キー単体は割り当てできません\nSuper / Ctrl / Alt と組み合わせてください';
                return true;
            }
            const accelerator = Gtk.accelerator_name(keyval, modifiers);
            for (const [otherKey] of SHORTCUTS) {
                if (otherKey !== key && settings.get_strv(otherKey)[0] === accelerator)
                    settings.set_strv(otherKey, []);
            }
            settings.set_strv(key, [accelerator]);
            dialog.close();
            return true;
        });
        dialog.add_controller(controller);
        dialog.present();
    }

    _isModifier(keyval) {
        return [
            Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
            Gdk.KEY_Control_L, Gdk.KEY_Control_R,
            Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
            Gdk.KEY_Super_L, Gdk.KEY_Super_R,
            Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
        ].includes(keyval);
    }

    _behaviorGroup(settings) {
        const group = new Adw.PreferencesGroup({title: '動作'});
        const pasteOnSelect = new Adw.SwitchRow({
            title: '選択した項目を自動で貼り付け',
            subtitle: '元のアプリへ戻り、端末では Ctrl+Shift+V、それ以外では Ctrl+V を送ります（Shift 併用でコピーのみ）',
        });
        settings.bind('paste-on-select', pasteOnSelect, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(pasteOnSelect);
        return group;
    }

    _appearanceGroup(settings, cleanup) {
        const group = new Adw.PreferencesGroup({title: '外観'});

        const indicator = new Adw.SwitchRow({
            title: 'トップバーにアイコンを表示',
            subtitle: '非表示でもショートカットから開けます',
        });
        settings.bind('show-indicator', indicator, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(indicator);

        if (settings.settings_schema?.has_key('panel-position')) {
            const labels = PANEL_POSITIONS.map(([, label]) => label);
            const positionRow = new Adw.ComboRow({
                title: 'パネルの表示位置',
                subtitle: 'アクティブなモニター内での表示位置を選びます',
                model: Gtk.StringList.new(labels),
            });
            const syncSelection = () => {
                const value = settings.get_string('panel-position');
                const idx = PANEL_POSITIONS.findIndex(([id]) => id === value);
                positionRow.selected = idx >= 0 ? idx : 0;
            };
            syncSelection();
            positionRow.connect('notify::selected', () => {
                const entry = PANEL_POSITIONS[positionRow.selected];
                if (entry && settings.get_string('panel-position') !== entry[0])
                    settings.set_string('panel-position', entry[0]);
            });
            cleanup.settingsSignals.push(
                settings.connect('changed::panel-position', syncSelection)
            );
            group.add(positionRow);
        }

        group.add(this._settingsSpin(
            settings, 'panel-opacity', '背景の不透明度', '文字は透過せず、背景だけを調整します', 70, 100, 1
        ));
        group.add(this._settingsSpin(
            settings, 'blur-radius', '背景のぼかし', '0で無効。不透明度が100%未満のときにパネル範囲へ適用します', 0, 30, 1
        ));
        group.add(this._settingsSpin(
            settings, 'panel-width', 'パネルの幅', '500px未満では画像を1列で表示します', 360, 900, 10
        ));
        group.add(this._settingsSpin(
            settings, 'panel-height', 'パネルの最大高さ', '履歴が少ない時は全タブ共通で自動的に縮みます', 280, 900, 10
        ));
        return group;
    }

    _settingsSpin(settings, key, title, subtitle, lower, upper, step) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower,
                upper,
                step_increment: step,
                page_increment: step * 5,
                value: settings.get_int(key),
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _historyGroup(window, service, cleanup, onReconnect) {
        const group = new Adw.PreferencesGroup({
            title: '履歴と容量',
            description: 'ピン留めとメモは通常の自動整理から除外されます。全体の絶対上限は5,000件です。数値の変更は少し待ってから安全に反映されます。',
        });
        const stats = new Adw.ActionRow({title: '現在の使用量', subtitle: '読み込み中…'});
        const retryButton = new Gtk.Button({
            label: '再接続',
            valign: Gtk.Align.CENTER,
            visible: false,
        });
        stats.add_suffix(retryButton);

        const paused = new Adw.SwitchRow({
            title: '新しい履歴の記録を停止',
            subtitle: '保存済みの履歴は消えません（パネルやトップバーからも切替可能）',
            sensitive: false,
        });
        group.add(paused);

        let pausedReady = false;
        let syncingPaused = false;
        paused.connect('notify::active', async () => {
            if (!pausedReady || syncingPaused)
                return;
            const target = paused.active;
            paused.sensitive = false;
            try {
                await service.call('SetSetting', 'capture_paused', target ? 'true' : 'false');
                if (cleanup.closed)
                    return;
                await this._refreshStats(service, stats, retryButton, cleanup);
            } catch (error) {
                console.error(`SimpleClipboard: setting capture_paused: ${error.message}`);
                if (!cleanup.closed) {
                    syncingPaused = true;
                    paused.active = !target;
                    syncingPaused = false;
                    stats.subtitle = '記録停止の切り替えに失敗しました。保存サービスの状態を確認してください。';
                    retryButton.visible = true;
                }
            } finally {
                if (!cleanup.closed)
                    paused.sensitive = true;
            }
        });

        const limits = [
            ['history_limit', '履歴の最大件数', 'ピンとメモを除く', 50, 5000, 50],
            ['retention_days', '自動削除までの日数', 'ピンとメモを除く', 1, 3650, 1],
            ['image_limit_mb', '画像の合計上限', 'MB', 32, 1024, 16],
            ['per_image_limit_mb', '画像1枚の上限', 'MB', 1, 32, 1],
        ];
        const spinControls = [];
        for (const [key, title, subtitle, lower, upper, step] of limits) {
            const row = new Adw.SpinRow({
                title,
                subtitle,
                sensitive: false,
                adjustment: new Gtk.Adjustment({
                    lower,
                    upper,
                    step_increment: step,
                    page_increment: step * 5,
                }),
            });
            group.add(row);

            const control = {key, row, ready: false, syncing: false, lastCommitted: null};
            row.connect('notify::value', () => {
                if (!control.ready || control.syncing)
                    return;
                const value = `${Math.round(row.value)}`;
                this._scheduleServiceSave(service, key, value, cleanup, () => {
                    control.lastCommitted = Number.parseInt(value, 10);
                    this._refreshStats(service, stats, retryButton, cleanup);
                }, async () => {
                    if (cleanup.closed)
                        return;
                    try {
                        const actual = Number.parseInt(await service.call('GetSetting', key), 10);
                        if (!cleanup.closed && Number.isFinite(actual)) {
                            control.syncing = true;
                            control.row.value = actual;
                            control.syncing = false;
                            control.lastCommitted = actual;
                        }
                    } catch (_) {
                        if (!cleanup.closed && control.lastCommitted !== null) {
                            control.syncing = true;
                            control.row.value = control.lastCommitted;
                            control.syncing = false;
                        }
                    }
                    if (!cleanup.closed) {
                        stats.subtitle = '設定の保存に失敗しました。保存サービスの状態を確認してください。';
                        retryButton.visible = true;
                    }
                });
            });
            spinControls.push(control);
        }

        group.add(stats);

        const clear = new Adw.ActionRow({
            title: '未ピンのクリップボード履歴を削除',
            subtitle: 'ピン留めとメモは残ります',
            activatable: true,
        });
        clear.add_suffix(new Gtk.Image({icon_name: 'user-trash-symbolic'}));
        clear.connect('activated', () => this._confirmClear(window, service, stats, retryButton, cleanup));
        group.add(clear);

        const reload = async () => {
            paused.sensitive = false;
            for (const control of spinControls)
                control.row.sensitive = false;
            try {
                const pausedValue = await service.call('GetSetting', 'capture_paused');
                if (cleanup.closed)
                    return;
                syncingPaused = true;
                paused.active = pausedValue === 'true';
                syncingPaused = false;
                pausedReady = true;
                paused.sensitive = true;

                await Promise.all(spinControls.map(async control => {
                    const value = await service.call('GetSetting', control.key);
                    if (cleanup.closed)
                        return;
                    const parsed = Number.parseInt(value, 10);
                    control.syncing = true;
                    control.row.value = parsed;
                    control.syncing = false;
                    control.lastCommitted = parsed;
                    control.ready = true;
                    control.row.sensitive = true;
                }));
                await this._refreshStats(service, stats, retryButton, cleanup);
            } catch (error) {
                if (cleanup.closed)
                    return;
                stats.subtitle = '保存サービスに接続できません。デーモンが起動しているか確認してください。';
                retryButton.visible = true;
                console.error(`SimpleClipboard: load settings: ${error.message}`);
            }
        };

        retryButton.connect('clicked', () => {
            service.invalidate();
            reload();
            onReconnect?.();
        });

        return {group, reload};
    }

    _excludedAppsGroup(service, cleanup) {
        const group = new Adw.PreferencesGroup({
            title: '記録しないアプリ',
            description: 'コピー時に前面にあるウィンドウのクラス名（WM_CLASS）で除外します（大文字・小文字は区別しません）。KeePassXC 等の機密ヒント付きコピーは自動で除外されます。',
        });

        const addRow = new Adw.EntryRow({
            title: 'アプリ名を追加（例: keepassxc, Bitwarden）',
            show_apply_button: true,
            sensitive: false,
        });
        group.add(addRow);

        const appRows = [];
        let excludedApps = [];
        let mutationQueue = Promise.resolve();

        const renderRows = () => {
            for (const row of appRows)
                group.remove(row);
            appRows.length = 0;

            if (excludedApps.length === 0) {
                const empty = new Adw.ActionRow({
                    title: '除外アプリは登録されていません',
                    subtitle: '秘密情報を扱う前にパネルやトップバーから一時停止することもできます',
                    sensitive: false,
                });
                group.add(empty);
                appRows.push(empty);
                return;
            }

            for (const app of excludedApps) {
                const row = new Adw.ActionRow({title: app});
                const removeButton = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: `${app} を除外リストから削除`,
                });
                removeButton.add_css_class('flat');
                removeButton.connect('clicked', () => {
                    enqueueMutation(current => current.filter(name => name !== app));
                });
                row.add_suffix(removeButton);
                group.add(row);
                appRows.push(row);
            }
        };

        const enqueueMutation = (transform, onSuccess = null) => {
            const task = mutationQueue.then(async () => {
                const nextApps = transform([...excludedApps]);
                if (nextApps === null)
                    return;
                await service.call('SetSetting', 'excluded_apps', JSON.stringify(nextApps));
                if (cleanup.closed)
                    return;
                const latestRaw = await service.call('GetSetting', 'excluded_apps');
                if (cleanup.closed)
                    return;
                excludedApps = JSON.parse(latestRaw);
                onSuccess?.();
                renderRows();
            }).catch(error => {
                console.error(`SimpleClipboard: excluded_apps: ${error.message}`);
            });
            cleanup.inFlightSaves.add(task);
            task.finally(() => cleanup.inFlightSaves.delete(task));
            mutationQueue = task;
            return task;
        };

        addRow.connect('apply', () => {
            const candidate = addRow.text.trim();
            if (!candidate)
                return;
            enqueueMutation(current => {
                const exists = current.some(app => app.toLowerCase() === candidate.toLowerCase());
                if (exists) {
                    if (!cleanup.closed && addRow.text.trim() === candidate)
                        addRow.text = '';
                    return null;
                }
                return [...current, candidate];
            }, () => {
                if (!cleanup.closed && addRow.text.trim() === candidate)
                    addRow.text = '';
            });
        });

        const reload = async () => {
            try {
                const raw = await service.call('GetSetting', 'excluded_apps');
                if (cleanup.closed)
                    return;
                excludedApps = JSON.parse(raw);
                addRow.sensitive = true;
                renderRows();
            } catch (error) {
                if (cleanup.closed)
                    return;
                addRow.sensitive = false;
                console.error(`SimpleClipboard: load excluded_apps: ${error.message}`);
            }
        };

        return {group, reload};
    }

    _scheduleServiceSave(service, key, value, cleanup, onSaved, onError) {
        const existing = cleanup.pendingSaves.get(key);
        if (existing?.sourceId)
            GLib.source_remove(existing.sourceId);

        const flush = () => {
            cleanup.pendingSaves.delete(key);
            const promise = service.call('SetSetting', key, value)
                .then(() => {
                    if (!cleanup.closed)
                        onSaved();
                })
                .catch(error => {
                    console.error(`SimpleClipboard: setting ${key}: ${error.message}`);
                    return onError?.(error);
                });
            cleanup.inFlightSaves.add(promise);
            promise.finally(() => cleanup.inFlightSaves.delete(promise));
            return promise;
        };

        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTING_SAVE_DEBOUNCE_MS, () => {
            flush();
            return GLib.SOURCE_REMOVE;
        });
        cleanup.pendingSaves.set(key, {sourceId, flush});
    }

    async _refreshStats(service, row, retryButton, cleanup) {
        try {
            const stats = JSON.parse(await service.call('GetStats'));
            if (cleanup.closed)
                return;
            const textUsed = (stats.text_bytes / 1024 / 1024).toFixed(1);
            const textLimit = (stats.text_limit_bytes / 1024 / 1024).toFixed(0);
            const used = (stats.image_bytes / 1024 / 1024).toFixed(1);
            const limit = (stats.image_limit_bytes / 1024 / 1024).toFixed(0);
            row.subtitle = `${stats.item_count}件（ピン ${stats.pinned_count}件）・本文 ${textUsed} / ${textLimit} MB・画像 ${used} / ${limit} MB`;
            retryButton.visible = false;
        } catch (error) {
            if (cleanup.closed)
                return;
            row.subtitle = '保存サービスに接続できません';
            retryButton.visible = true;
            console.error(`SimpleClipboard: stats: ${error.message}`);
        }
    }

    _confirmClear(parent, service, statsRow, retryButton, cleanup) {
        const dialog = new Adw.MessageDialog({
            transient_for: parent,
            modal: true,
            heading: '未ピンの履歴を削除しますか？',
            body: 'この操作は元に戻せません。ピン留めした項目とメモは残ります。',
        });
        dialog.add_response('cancel', 'キャンセル');
        dialog.add_response('clear', '削除');
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', async (_dialog, response) => {
            if (response !== 'clear')
                return;
            try {
                await service.call('ClearUnpinned');
                this._refreshStats(service, statsRow, retryButton, cleanup);
            } catch (error) {
                console.error(`SimpleClipboard: clear history: ${error.message}`);
            }
        });
        dialog.present();
    }
}
