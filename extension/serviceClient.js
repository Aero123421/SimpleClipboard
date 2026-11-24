import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const BUS_NAME = 'io.github.sahur.SimpleClipboard1';
const OBJECT_PATH = '/io/github/sahur/SimpleClipboard';
const PRODUCTION_DAEMON = '/usr/libexec/simpleclipboard/simpleclipboardd';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_INTERFACE = 'org.freedesktop.DBus';
const PROXY_FLAGS =
    Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES |
    Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS;

const ServiceProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="io.github.sahur.SimpleClipboard1">
    <method name="Ping"><arg type="s" direction="out"/></method>
    <method name="CaptureText"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
    <method name="CaptureImage"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
    <method name="ListItems"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="out"/></method>
    <method name="ListItemsPage"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="out"/></method>
    <method name="GetItem"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
    <method name="AddNote"><arg type="s" direction="in"/><arg type="b" direction="in"/><arg type="s" direction="out"/></method>
    <method name="UpdateNote"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
    <method name="TogglePin"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
    <method name="RecordUsed"><arg type="s" direction="in"/></method>
    <method name="DeleteItem"><arg type="s" direction="in"/></method>
    <method name="ClearUnpinned"><arg type="u" direction="out"/></method>
    <method name="GetSetting"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
    <method name="SetSetting"><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
    <method name="GetStats"><arg type="s" direction="out"/></method>
  </interface>
</node>`);

export class ServiceClient {
    constructor(settings) {
        this._settings = settings;
        this._owner = null;
        this._proxy = null;
        this._pendingProxy = null;
        this._generation = 0;
        this._destroyed = false;
        this._devPathSignal = this._settings.connect('changed::development-daemon-path', () => {
            this.invalidate();
        });
        this._ownerWatchId = Gio.DBus.session.signal_subscribe(
            DBUS_INTERFACE,
            DBUS_INTERFACE,
            'NameOwnerChanged',
            DBUS_PATH,
            BUS_NAME,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [, oldOwner, newOwner] = params.deepUnpack();
                if (oldOwner !== newOwner)
                    this.invalidate();
            }
        );
    }

    invalidate() {
        this._generation++;
        this._owner = null;
        this._proxy = null;
        this._pendingProxy = null;
    }

    destroy() {
        this._destroyed = true;
        this.invalidate();
        if (this._devPathSignal) {
            this._settings.disconnect(this._devPathSignal);
            this._devPathSignal = 0;
        }
        if (this._ownerWatchId) {
            Gio.DBus.session.signal_unsubscribe(this._ownerWatchId);
            this._ownerWatchId = 0;
        }
    }

    async call(method, ...args) {
        if (this._destroyed)
            throw new Error('SimpleClipboard client is closed');
        const proxy = await this._getTrustedProxy();
        try {
            return await new Promise((resolve, reject) => {
                proxy[`${method}Remote`](...args, (result, error) => {
                    if (error)
                        reject(error);
                    else
                        resolve(result?.[0]);
                });
            });
        } catch (error) {
            if (this._isConnectionError(error))
                this.invalidate();
            throw error;
        }
    }

    async json(method, ...args) {
        return JSON.parse(await this.call(method, ...args));
    }

    async _getTrustedProxy() {
        for (let attempt = 0; attempt < 2; attempt++) {
            if (this._owner && this._proxy)
                return this._proxy;
            if (!this._pendingProxy) {
                const generation = this._generation;
                const promise = this._resolveTrustedProxy(generation).finally(() => {
                    if (this._pendingProxy === promise)
                        this._pendingProxy = null;
                });
                this._pendingProxy = promise;
            }
            try {
                return await this._pendingProxy;
            } catch (error) {
                if (error?.retryResolve && !this._destroyed && attempt === 0)
                    continue;
                throw error;
            }
        }
        throw new Error('SimpleClipboard接続の再検証が必要です');
    }

    async _resolveTrustedProxy(generation) {
        const owner = await this._getOwner();
        if (this._destroyed)
            throw new Error('SimpleClipboard client is closed');
        if (generation !== this._generation) {
            const err = new Error('SimpleClipboard接続の再検証が必要です');
            err.retryResolve = true;
            throw err;
        }
        if (owner === this._owner && this._proxy)
            return this._proxy;

        const [pid, uid] = await Promise.all([
            this._dbusCall('GetConnectionUnixProcessID', '(s)', [owner], '(u)'),
            this._dbusCall('GetConnectionUnixUser', '(s)', [owner], '(u)'),
        ]);
        const procExePath = `/proc/${pid}/exe`;
        const executable = GLib.file_read_link(procExePath);
        const developmentDaemon = this._settings.get_string('development-daemon-path');
        const expectedDevelopmentDaemon = developmentDaemon
            ? GLib.canonicalize_filename(developmentDaemon, null)
            : null;
        const production = executable === PRODUCTION_DAEMON;
        const development = expectedDevelopmentDaemon && executable === expectedDevelopmentDaemon;
        if (!production && !development) {
            this.invalidate();
            throw new Error('接続先がSimpleClipboardのデーモンではありません');
        }

        const attrs = 'standard::type,unix::uid,unix::mode,unix::inode,unix::device';
        const procInfo = Gio.File.new_for_path(procExePath).query_info(
            attrs, Gio.FileQueryInfoFlags.NONE, null
        );
        const targetInfo = Gio.File.new_for_path(executable).query_info(
            attrs, Gio.FileQueryInfoFlags.NONE, null
        );
        const fileUid = procInfo.get_attribute_uint32('unix::uid');
        const mode = procInfo.get_attribute_uint32('unix::mode');
        const sameBinary =
            procInfo.get_attribute_uint64('unix::inode') === targetInfo.get_attribute_uint64('unix::inode') &&
            procInfo.get_attribute_uint32('unix::device') === targetInfo.get_attribute_uint32('unix::device');
        const expectedUid = production ? 0 : uid;
        if (uid !== new Gio.Credentials().get_unix_user() ||
            !sameBinary ||
            procInfo.get_file_type() !== Gio.FileType.REGULAR ||
            fileUid !== expectedUid || (mode & 0o022) !== 0) {
            this.invalidate();
            throw new Error('SimpleClipboardデーモンの所有者または権限が安全ではありません');
        }

        const proxy = await ServiceProxy.newAsync(
            Gio.DBus.session, owner, OBJECT_PATH, null, PROXY_FLAGS
        );
        proxy.set_default_timeout(5000);
        if (this._destroyed)
            throw new Error('SimpleClipboard client is closed');
        if (generation !== this._generation) {
            const err = new Error('SimpleClipboard接続の再検証が必要です');
            err.retryResolve = true;
            throw err;
        }
        this._owner = owner;
        this._proxy = proxy;
        return this._proxy;
    }

    async _getOwner() {
        try {
            return await this._dbusCall('GetNameOwner', '(s)', [BUS_NAME], '(s)');
        } catch (_) {
            await Gio.DBus.session.call(
                BUS_NAME, OBJECT_PATH, BUS_NAME, 'Ping', null,
                new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, 5000, null
            );
            return this._dbusCall('GetNameOwner', '(s)', [BUS_NAME], '(s)');
        }
    }

    async _dbusCall(method, inputSignature, input, outputSignature) {
        const result = await Gio.DBus.session.call(
            DBUS_INTERFACE, DBUS_PATH, DBUS_INTERFACE, method,
            new GLib.Variant(inputSignature, input),
            new GLib.VariantType(outputSignature),
            Gio.DBusCallFlags.NONE, 5000, null
        );
        return result.deepUnpack()[0];
    }

    _isConnectionError(error) {
        const message = String(error?.message ?? '');
        return message.includes('ServiceUnknown') ||
            message.includes('NoReply') ||
            message.includes('Disconnected') ||
            message.includes('NameHasNoOwner');
    }
}
