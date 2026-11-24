const TERMINAL_CLASSES = [
    'alacritty',
    'blackbox',
    'console',
    'foot',
    'ghostty',
    'gnome-terminal',
    'guake',
    'hyper',
    'kgx',
    'kitty',
    'konsole',
    'rio',
    'sakura',
    'st-256color',
    'tabby',
    'terminator',
    'tilix',
    'urxvt',
    'vte',
    'warp',
    'wezterm',
    'xfce4-terminal',
    'xterm',
    'yakuake',
];

const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const HTTP_URL_PATTERN = /^https?:\/\/[^\s/$.?#][^\s]*$/i;
const SECRET_MIME_HINTS = new Set([
    'x-kde-passwordmanagerhint',
]);

function parseMime(mime) {
    const parts = String(mime ?? '').split(';').map(part => part.trim()).filter(Boolean);
    const base = (parts[0] ?? '').toLowerCase();
    let charset = null;
    for (let i = 1; i < parts.length; i++) {
        const eq = parts[i].indexOf('=');
        if (eq <= 0)
            continue;
        const key = parts[i].slice(0, eq).trim().toLowerCase();
        if (key === 'charset') {
            charset = parts[i].slice(eq + 1).trim().replace(/^"(.*)"$/, '$1').toLowerCase();
            break;
        }
    }
    return {base, charset};
}

export function hasSecretMimeHint(mimetypes) {
    if (!Array.isArray(mimetypes))
        return false;
    return mimetypes.some(type => SECRET_MIME_HINTS.has(parseMime(type).base));
}

export function selectTextMime(mimetypes) {
    if (!Array.isArray(mimetypes) || mimetypes.length === 0)
        return null;
    const parsed = mimetypes.map(raw => ({raw, ...parseMime(raw)}));
    const utf8Plain = parsed.find(
        entry => entry.base === 'text/plain' && (entry.charset === 'utf-8' || entry.charset === 'utf8')
    );
    if (utf8Plain)
        return utf8Plain.raw;
    const utf8String = parsed.find(entry => entry.raw === 'UTF8_STRING');
    if (utf8String)
        return utf8String.raw;
    const barePlain = parsed.find(entry => entry.base === 'text/plain' && entry.charset === null);
    if (barePlain)
        return barePlain.raw;
    const otherPlain = parsed.find(entry => entry.base === 'text/plain');
    return otherPlain ? otherPlain.raw : null;
}

export function decodeTextBytes(bytes, mime = '') {
    const {charset} = parseMime(mime);
    let decoder;
    try {
        decoder = new TextDecoder(charset || 'utf-8');
    } catch (_) {
        decoder = new TextDecoder('utf-8');
    }
    return decoder.decode(bytes).replace(/\0/g, '');
}

export function formatPreview(text, limit = 110) {
    const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
    return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

export function countLines(text) {
    if (!text)
        return 0;
    const normalized = String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '');
    if (!normalized)
        return 0;
    return normalized.split('\n').length;
}

export function detectColorHex(text) {
    const trimmed = String(text ?? '').trim();
    if (!HEX_COLOR_PATTERN.test(trimmed))
        return null;
    const hex = trimmed.slice(1).toLowerCase();
    if (hex.length === 3) {
        const [r, g, b] = hex;
        return `#${r}${r}${g}${g}${b}${b}`;
    }
    if (hex.length === 4) {
        const [r, g, b, a] = hex;
        const alpha = parseInt(`${a}${a}`, 16) / 255;
        return `rgba(${parseInt(`${r}${r}`, 16)}, ${parseInt(`${g}${g}`, 16)}, ${parseInt(`${b}${b}`, 16)}, ${alpha.toFixed(2)})`;
    }
    if (hex.length === 8) {
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        const alpha = parseInt(hex.slice(6, 8), 16) / 255;
        return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
    }
    return `#${hex}`;
}

export function isHttpUrl(text) {
    const trimmed = String(text ?? '').trim();
    return trimmed.length <= 2048 && HTTP_URL_PATTERN.test(trimmed);
}

export function formatRelativeTime(timestampSeconds, nowMs = Date.now()) {
    const seconds = Math.max(0, Math.floor(nowMs / 1000) - timestampSeconds);
    if (seconds < 60)
        return 'たった今';
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}分前`;
    if (seconds < 86400)
        return `${Math.floor(seconds / 3600)}時間前`;
    return `${Math.floor(seconds / 86400)}日前`;
}

export function dateGroupLabel(timestampSeconds, nowDate = new Date()) {
    const itemDate = new Date(timestampSeconds * 1000);
    const startOfToday = new Date(
        nowDate.getFullYear(),
        nowDate.getMonth(),
        nowDate.getDate()
    );
    const startOfItem = new Date(
        itemDate.getFullYear(),
        itemDate.getMonth(),
        itemDate.getDate()
    );
    const diffDays = Math.round((startOfToday - startOfItem) / 86400000);
    if (diffDays <= 0)
        return '今日';
    if (diffDays === 1)
        return '昨日';
    if (diffDays < 7)
        return '直近7日間';
    if (
        itemDate.getFullYear() === nowDate.getFullYear() &&
        itemDate.getMonth() === nowDate.getMonth()
    )
        return '今月';
    return 'それ以前';
}

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return '';
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function friendlySourceApp(sourceApp) {
    const trimmed = String(sourceApp ?? '').trim();
    if (!trimmed)
        return '';
    if (trimmed.includes('.')) {
        const segments = trimmed.split('.').filter(Boolean);
        const last = segments[segments.length - 1];
        if (last && last.toLowerCase() !== 'desktop')
            return last;
    }
    return trimmed;
}

export function formatImageMeta(item, nowMs = Date.now()) {
    const parts = [];
    if (item.width && item.height)
        parts.push(`${item.width}×${item.height}`);
    const size = formatBytes(item.size_bytes);
    if (size)
        parts.push(size);
    parts.push(formatRelativeTime(item.created_at, nowMs));
    return parts.join(' • ');
}

export function formatRowMeta(item, nowMs = Date.now()) {
    const parts = [];
    if (item.kind === 'note') {
        parts.push('メモ');
    } else if (item.kind === 'image') {
        parts.push(friendlySourceApp(item.source_app) || '画像');
        if (item.width && item.height)
            parts.push(`${item.width}×${item.height}`);
    } else {
        parts.push(friendlySourceApp(item.source_app) || 'クリップボード');
        const lines = countLines(item.text);
        if (lines > 1)
            parts.push(`${lines}行`);
    }
    parts.push(formatRelativeTime(item.created_at, nowMs));
    return parts.join('  •  ');
}

export function formatRowSource(item) {
    if (item.kind === 'note')
        return 'メモ';
    if (item.kind === 'image')
        return friendlySourceApp(item.source_app) || '画像';
    return friendlySourceApp(item.source_app) || 'クリップボード';
}

export function formatRowDetail(item) {
    if (item.kind === 'image') {
        const parts = [];
        if (item.width && item.height)
            parts.push(`${item.width}×${item.height}`);
        const size = formatBytes(item.size_bytes);
        if (size)
            parts.push(size);
        return parts.join(' • ');
    }
    const lines = countLines(item.text);
    return lines > 1 ? `${lines}行` : '';
}

export function formatPreviewBody(text, maxChars = 4000) {
    const raw = String(text ?? '');
    const codePoints = Array.from(raw);
    if (codePoints.length <= maxChars)
        return {text: raw, truncated: false, totalChars: codePoints.length};
    return {
        text: `${codePoints.slice(0, maxChars).join('')}\n\n…（残り ${codePoints.length - maxChars} 文字）`,
        truncated: true,
        totalChars: codePoints.length,
    };
}

export function computePanelHeight(itemCount, maxPanelHeight) {
    const maximum = Math.max(280, Math.round(maxPanelHeight || 620));
    const minimum = Math.min(maximum, 300);
    const count = Math.max(0, Math.floor(itemCount || 0));
    const estimated = 188 + count * 64;
    return Math.min(maximum, Math.max(minimum, estimated));
}

export function computePanelPosition(
    workArea,
    panelWidth,
    panelHeight,
    mode = 'bottom-right',
    pointerX = 0,
    pointerY = 0,
    margin = 18
) {
    const minX = workArea.x + margin;
    const minY = workArea.y + margin;
    const maxX = Math.max(minX, workArea.x + workArea.width - panelWidth - margin);
    const maxY = Math.max(minY, workArea.y + workArea.height - panelHeight - margin);

    if (mode === 'center') {
        const x = workArea.x + Math.round((workArea.width - panelWidth) / 2);
        const y = workArea.y + Math.round((workArea.height - panelHeight) / 2);
        return {
            x: Math.min(maxX, Math.max(minX, x)),
            y: Math.min(maxY, Math.max(minY, y)),
        };
    }

    if (mode === 'pointer') {
        const x = Math.round(pointerX - panelWidth / 2);
        const y = Math.round(pointerY + 16);
        const clampedY = y > maxY ? Math.round(pointerY - panelHeight - 16) : y;
        return {
            x: Math.min(maxX, Math.max(minX, x)),
            y: Math.min(maxY, Math.max(minY, clampedY)),
        };
    }

    return {x: maxX, y: maxY};
}

export function isTerminalWmClass(wmClass) {
    const normalized = String(wmClass ?? '').toLowerCase();
    if (!normalized)
        return false;
    return TERMINAL_CLASSES.some(name => normalized.includes(name));
}

export function nextNavigationIndex(currentIndex, itemCount, direction, columns = 1) {
    if (itemCount <= 0)
        return -1;
    const cols = Math.max(1, columns);
    if (currentIndex < 0 || currentIndex >= itemCount) {
        if (direction === 'up' || direction === 'end')
            return itemCount - 1;
        return 0;
    }
    switch (direction) {
    case 'down':
        return Math.min(itemCount - 1, currentIndex + cols);
    case 'up':
        return Math.max(0, currentIndex - cols);
    case 'right':
        return Math.min(itemCount - 1, currentIndex + 1);
    case 'left':
        return Math.max(0, currentIndex - 1);
    case 'home':
        return 0;
    case 'end':
        return itemCount - 1;
    default:
        return currentIndex;
    }
}

export function isSafeGlobalShortcut(keyval, modifiers, shiftMask = 1) {
    const nonShiftMods = modifiers & ~shiftMask;
    if (nonShiftMods !== 0)
        return true;
    // Allow function keys (F1..F12) and Print/Pause without Ctrl/Alt/Super,
    // but block plain typing keys (with or without Shift) from hijacking text/IME input.
    const isFunctionKey = keyval >= 0xffbe && keyval <= 0xffc9;
    const isSpecialKey = keyval === 0xff61 || keyval === 0xff13;
    return isFunctionKey || isSpecialKey;
}

export function isSafeAcceleratorString(accelerator) {
    const raw = String(accelerator ?? '').trim();
    if (!raw)
        return false;
    const mods = raw.match(/<[^>]+>/g) ?? [];
    const key = raw.replace(/<[^>]+>/g, '');
    if (!key)
        return false;
    const hasNonShiftMod = mods.some(mod => !/^<shift>$/i.test(mod));
    if (hasNonShiftMod)
        return true;
    return /^(?:F(?:[1-9]|1[0-2])|Print|Pause)$/i.test(key);
}
