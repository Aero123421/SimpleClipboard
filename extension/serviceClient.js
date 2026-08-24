import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const BUS_NAME = 'io.github.sahur.SimpleClipboard1';
const OBJECT_PATH = '/io/github/sahur/SimpleClipboard';
const PRODUCTION_DAEMON = '/usr/libexec/simpleclipboard/simpleclipboardd';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_INTERFACE = 'org.freedesktop.DBus';

const ServiceProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="io.github.sahur.SimpleClipboard1">
    <method name="Ping"><arg type="s" direction="out"/></method>
    <method name="CaptureText"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
    <method name="CaptureImage"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
    <method name="ListItems"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="out"/></method>
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
    }

    async call(method, ...args) {
        const proxy = await this._getTrustedProxy();
        return new Promise((resolve, reject) => {
            proxy[`${method}Remote`](...args, (result, error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(result?.[0]);
                }
            });
        });
    }

    async json(method, ...args) {
        return JSON.parse(await this.call(method, ...args));
    }

    async _getTrustedProxy() {
        const owner = await this._getOwner();
        if (owner === this._owner && this._proxy)
            return this._proxy;

        const [pid, uid] = await Promise.all([
            this._dbusCall('GetConnectionUnixProcessID', '(s)', [owner], '(u)'),
            this._dbusCall('GetConnectionUnixUser', '(s)', [owner], '(u)'),
        ]);
        const executable = GLib.file_read_link(`/proc/${pid}/exe`);
        const developmentDaemon = this._settings.get_string('development-daemon-path');
        const expectedDevelopmentDaemon = developmentDaemon
            ? GLib.canonicalize_filename(developmentDaemon, null)
            : null;
        const production = executable === PRODUCTION_DAEMON;
        const development = expectedDevelopmentDaemon && executable === expectedDevelopmentDaemon;
        if (!production && !development)
            throw new Error('接続先がSimpleClipboardのデーモンではありません');

        const info = Gio.File.new_for_path(executable).query_info(
            'standard::type,unix::uid,unix::mode', Gio.FileQueryInfoFlags.NONE, null
        );
        const fileUid = info.get_attribute_uint32('unix::uid');
        const mode = info.get_attribute_uint32('unix::mode');
        const expectedUid = production ? 0 : uid;
        if (uid !== new Gio.Credentials().get_unix_user() ||
            info.get_file_type() !== Gio.FileType.REGULAR ||
            fileUid !== expectedUid || (mode & 0o022) !== 0)
            throw new Error('SimpleClipboardデーモンの所有者または権限が安全ではありません');

        this._owner = owner;
        this._proxy = new ServiceProxy(Gio.DBus.session, owner, OBJECT_PATH);
        this._proxy.set_default_timeout(5000);
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
}
