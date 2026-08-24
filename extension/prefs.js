import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ServiceClient} from './serviceClient.js';

const SHORTCUTS = [
    ['toggle-menu', 'メニューを開く'],
    ['open-images', '画像を直接開く'],
    ['open-notes', 'メモを直接開く'],
    ['open-pinned', 'ピンを直接開く'],
];

export default class SimpleClipboardPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(680, 720);
        const settings = this.getSettings();
        const service = new ServiceClient(settings);

        const page = new Adw.PreferencesPage({
            title: 'SimpleClipboard',
            icon_name: 'edit-paste-symbolic',
        });
        page.add(this._shortcutGroup(window, settings));
        page.add(this._behaviorGroup(settings));
        page.add(this._appearanceGroup(settings));
        page.add(this._historyGroup(window, service));
        window.add(page);
    }

    _shortcutGroup(window, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'ショートカット',
            description: '初期状態では未設定です。おすすめはメニューを Super+V にすることです。',
        });
        for (const [key, title] of SHORTCUTS)
            group.add(this._shortcutRow(window, settings, key, title));
        return group;
    }

    _shortcutRow(window, settings, key, title) {
        const row = new Adw.ActionRow({title, activatable: true});
        const label = new Gtk.ShortcutLabel({
            accelerator: settings.get_strv(key)[0] ?? '',
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(label);
        row.connect('activated', () => this._captureShortcut(window, settings, key, title));
        settings.connect(`changed::${key}`, () => {
            label.accelerator = settings.get_strv(key)[0] ?? '';
        });
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
        box.append(new Gtk.Label({
            label: '割り当てたいキーを押してください\nBackspaceで解除・Escでキャンセル',
            justify: Gtk.Justification.CENTER,
        }));
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
            subtitle: '元のアプリへ戻り、端末では Ctrl+Shift+V、それ以外では Ctrl+V を送ります',
        });
        settings.bind('paste-on-select', pasteOnSelect, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(pasteOnSelect);
        return group;
    }

    _appearanceGroup(settings) {
        const group = new Adw.PreferencesGroup({title: '外観'});

        const indicator = new Adw.SwitchRow({
            title: 'トップバーにアイコンを表示',
            subtitle: '非表示でもショートカットから開けます',
        });
        settings.bind('show-indicator', indicator, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(indicator);

        group.add(this._settingsSpin(
            settings, 'panel-opacity', '背景の不透明度', '文字は透過せず、背景だけを調整します', 70, 100, 1
        ));
        group.add(this._settingsSpin(
            settings, 'blur-radius', '背景のぼかし', '0で無効。パネルの範囲だけに適用します', 0, 30, 1
        ));
        group.add(this._settingsSpin(
            settings, 'panel-width', 'パネルの幅', '狭い幅では画像を1列で表示します', 360, 900, 10
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

    _historyGroup(window, service) {
        const group = new Adw.PreferencesGroup({
            title: '履歴と容量',
            description: 'ピン留めとメモは通常の自動整理から除外されます。全体の絶対上限は5,000件です。',
        });
        const stats = new Adw.ActionRow({title: '現在の使用量', subtitle: '読み込み中…'});
        const refreshStats = () => this._refreshStats(service, stats);

        const paused = new Adw.SwitchRow({
            title: '新しい履歴の記録を停止',
            subtitle: '保存済みの履歴は消えません',
        });
        group.add(paused);
        this._bindServiceSwitch(service, paused, 'capture_paused', refreshStats);

        const limits = [
            ['history_limit', '履歴の最大件数', 'ピンとメモを除く', 50, 5000, 50],
            ['retention_days', '自動削除までの日数', 'ピンとメモを除く', 1, 3650, 1],
            ['image_limit_mb', '画像の合計上限', 'MB', 32, 1024, 16],
            ['per_image_limit_mb', '画像1枚の上限', 'MB', 1, 32, 1],
        ];
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
            this._bindServiceSpin(service, row, key, refreshStats);
        }

        group.add(stats);
        refreshStats();

        const clear = new Adw.ActionRow({
            title: '未ピンのクリップボード履歴を削除',
            subtitle: 'ピン留めとメモは残ります',
            activatable: true,
        });
        clear.add_suffix(new Gtk.Image({icon_name: 'user-trash-symbolic'}));
        clear.connect('activated', () => this._confirmClear(window, service, stats));
        group.add(clear);
        return group;
    }

    async _bindServiceSpin(service, row, key, onChanged) {
        try {
            row.value = Number.parseInt(await service.call('GetSetting', key), 10);
            row.sensitive = true;
            row.connect('notify::value', () => {
                service.call('SetSetting', key, `${Math.round(row.value)}`)
                    .then(() => onChanged())
                    .catch(error => {
                        console.error(`SimpleClipboard: setting ${key}: ${error.message}`);
                    });
            });
        } catch (error) {
            row.subtitle = '保存サービスに接続できません';
            console.error(`SimpleClipboard: setting ${key}: ${error.message}`);
        }
    }

    async _bindServiceSwitch(service, row, key, onChanged) {
        row.sensitive = false;
        try {
            row.active = await service.call('GetSetting', key) === 'true';
            row.sensitive = true;
            row.connect('notify::active', () => {
                service.call('SetSetting', key, row.active ? 'true' : 'false')
                    .then(() => onChanged())
                    .catch(error => {
                        console.error(`SimpleClipboard: setting ${key}: ${error.message}`);
                    });
            });
        } catch (error) {
            row.subtitle = '保存サービスに接続できません';
            console.error(`SimpleClipboard: setting ${key}: ${error.message}`);
        }
    }

    async _refreshStats(service, row) {
        try {
            const stats = JSON.parse(await service.call('GetStats'));
            const textUsed = (stats.text_bytes / 1024 / 1024).toFixed(1);
            const textLimit = (stats.text_limit_bytes / 1024 / 1024).toFixed(0);
            const used = (stats.image_bytes / 1024 / 1024).toFixed(1);
            const limit = (stats.image_limit_bytes / 1024 / 1024).toFixed(0);
            row.subtitle = `${stats.item_count}件（ピン ${stats.pinned_count}件）・本文 ${textUsed} / ${textLimit} MB・画像 ${used} / ${limit} MB`;
        } catch (error) {
            row.subtitle = '保存サービスに接続できません';
            console.error(`SimpleClipboard: stats: ${error.message}`);
        }
    }

    _confirmClear(parent, service, statsRow) {
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
                this._refreshStats(service, statsRow);
            } catch (error) {
                console.error(`SimpleClipboard: clear history: ${error.message}`);
            }
        });
        dialog.present();
    }
}
