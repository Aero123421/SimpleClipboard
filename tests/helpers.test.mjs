import assert from 'node:assert/strict';
import test from 'node:test';

import {
    computePanelHeight,
    computePanelPosition,
    countLines,
    dateGroupLabel,
    decodeTextBytes,
    detectColorHex,
    formatBytes,
    formatImageMeta,
    formatPreview,
    formatPreviewBody,
    formatRelativeTime,
    formatRowDetail,
    formatRowMeta,
    formatRowSource,
    friendlySourceApp,
    hasSecretMimeHint,
    isHttpUrl,
    isSafeAcceleratorString,
    isSafeGlobalShortcut,
    isTerminalWmClass,
    nextNavigationIndex,
    selectTextMime,
} from '../extension/helpers.js';

test('formatPreview collapses whitespace and truncates cleanly', () => {
    assert.equal(formatPreview('  hello\n\tworld  ', 20), 'hello world');
    assert.equal(formatPreview('abcdefghij', 5), 'abcde…');
});

test('countLines counts meaningful lines', () => {
    assert.equal(countLines(''), 0);
    assert.equal(countLines('single line\n'), 1);
    assert.equal(countLines('one\ntwo\nthree'), 3);
    assert.equal(countLines('one\r\ntwo\r\n'), 2);
});

test('detectColorHex validates and normalizes hex color tokens', () => {
    assert.equal(detectColorHex('#f60'), '#ff6600');
    assert.equal(detectColorHex(' #FF6A2A '), '#ff6a2a');
    assert.equal(detectColorHex('#ff6a2a80'), 'rgba(255, 106, 42, 0.50)');
    assert.equal(detectColorHex('#12345'), null);
    assert.equal(detectColorHex('color: #ff6a2a'), null);
});

test('isHttpUrl identifies single HTTP/HTTPS URLs only', () => {
    assert.equal(isHttpUrl('https://example.com/path?q=1'), true);
    assert.equal(isHttpUrl('http://localhost:8080'), true);
    assert.equal(isHttpUrl('https://example.com extra text'), false);
    assert.equal(isHttpUrl('https://a b'), false);
    assert.equal(isHttpUrl('file:///etc/passwd'), false);
});

test('formatRelativeTime formats Japanese relative timestamps', () => {
    const now = 1_700_000_000_000;
    const nowSec = Math.floor(now / 1000);
    assert.equal(formatRelativeTime(nowSec - 10, now), 'たった今');
    assert.equal(formatRelativeTime(nowSec - 180, now), '3分前');
    assert.equal(formatRelativeTime(nowSec - 7200, now), '2時間前');
    assert.equal(formatRelativeTime(nowSec - 172800, now), '2日前');
});

test('dateGroupLabel groups timestamps by local calendar day', () => {
    const now = new Date(2026, 10, 24, 15, 0, 0);
    const today = Math.floor(new Date(2026, 10, 24, 9, 0, 0).getTime() / 1000);
    const yesterday = Math.floor(new Date(2026, 10, 23, 22, 0, 0).getTime() / 1000);
    const threeDaysAgo = Math.floor(new Date(2026, 10, 21, 12, 0, 0).getTime() / 1000);
    const earlierThisMonth = Math.floor(new Date(2026, 10, 2, 12, 0, 0).getTime() / 1000);
    const lastMonth = Math.floor(new Date(2026, 9, 28, 12, 0, 0).getTime() / 1000);

    assert.equal(dateGroupLabel(today, now), '今日');
    assert.equal(dateGroupLabel(yesterday, now), '昨日');
    assert.equal(dateGroupLabel(threeDaysAgo, now), '直近7日間');
    assert.equal(dateGroupLabel(earlierThisMonth, now), '今月');
    assert.equal(dateGroupLabel(lastMonth, now), 'それ以前');
});

test('computePanelHeight grows up to configured maximum instead of capping at 504px', () => {
    assert.equal(computePanelHeight(0, 620), 300);
    assert.equal(computePanelHeight(0, 280), 280);
    assert.equal(computePanelHeight(4, 800), 444);
    assert.equal(computePanelHeight(12, 800), 800);
    assert.equal(computePanelHeight(20, 620), 620);
});

test('computePanelPosition clamps all placement modes inside workArea', () => {
    const workArea = {x: 1920, y: 32, width: 1920, height: 1048};
    assert.deepEqual(
        computePanelPosition(workArea, 500, 600, 'bottom-right'),
        {x: 3322, y: 462}
    );
    assert.deepEqual(
        computePanelPosition(workArea, 500, 600, 'center'),
        {x: 2630, y: 256}
    );
    assert.deepEqual(
        computePanelPosition(workArea, 500, 600, 'pointer', 1930, 1060),
        {x: 1938, y: 444}
    );
});

test('formatting and app helpers produce concise metadata', () => {
    const now = 1_700_000_000_000;
    const created = Math.floor(now / 1000) - 120;
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(20480), '20 KB');
    assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 MB');
    assert.equal(friendlySourceApp('org.gnome.Nautilus'), 'Nautilus');
    assert.equal(
        formatImageMeta({width: 1920, height: 1080, size_bytes: 204800, created_at: created}, now),
        '1920×1080 • 200 KB • 2分前'
    );
    assert.equal(
        formatRowMeta({kind: 'text', text: 'a\nb\nc', source_app: 'org.gnome.Console', created_at: created}, now),
        'Console  •  3行  •  2分前'
    );
});

test('isTerminalWmClass recognizes common terminals case-insensitively', () => {
    assert.equal(isTerminalWmClass('org.gnome.Console'), true);
    assert.equal(isTerminalWmClass('Alacritty'), true);
    assert.equal(isTerminalWmClass('WezTerm'), true);
    assert.equal(isTerminalWmClass('firefox'), false);
});

test('nextNavigationIndex handles 1-column and 2-column grids', () => {
    assert.equal(nextNavigationIndex(-1, 5, 'down', 1), 0);
    assert.equal(nextNavigationIndex(-1, 5, 'up', 1), 4);
    assert.equal(nextNavigationIndex(1, 5, 'down', 2), 3);
    assert.equal(nextNavigationIndex(3, 5, 'left', 2), 2);
    assert.equal(nextNavigationIndex(3, 5, 'down', 2), 4);
    assert.equal(nextNavigationIndex(0, 0, 'down', 1), -1);
});

test('selectTextMime prioritizes explicit UTF-8 and rejects invalid text/plain prefixes', () => {
    assert.equal(
        selectTextMime(['text/html', 'text/plain', 'text/plain;charset=utf-8', 'UTF8_STRING']),
        'text/plain;charset=utf-8'
    );
    assert.equal(
        selectTextMime(['text/plain;charset=ISO-8859-1', 'UTF8_STRING', 'text/plain']),
        'UTF8_STRING'
    );
    assert.equal(
        selectTextMime(['text/plain;charset=ISO-8859-1', 'text/plain']),
        'text/plain'
    );
    assert.equal(
        selectTextMime(['text/plain; charset=UTF-8', 'text/plain']),
        'text/plain; charset=UTF-8'
    );
    assert.equal(selectTextMime(['text/plainfoo', 'image/png']), null);
    assert.equal(hasSecretMimeHint(['text/plain;charset=utf-8', 'x-kde-passwordManagerHint']), true);
    assert.equal(hasSecretMimeHint(['text/plain;charset=utf-8']), false);
});

test('decodeTextBytes decodes UTF-8, strips all NULs, and respects explicit charsets', () => {
    const helloUtf8 = new TextEncoder().encode('こん\0にちは\0');
    assert.equal(decodeTextBytes(helloUtf8, 'text/plain;charset=utf-8'), 'こんにちは');
    assert.equal(decodeTextBytes(helloUtf8, 'UTF8_STRING'), 'こんにちは');
    const latin1Cafe = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    assert.equal(decodeTextBytes(latin1Cafe, 'text/plain;charset=iso-8859-1'), 'café');
});

test('row source, detail, and preview body helpers format metadata safely', () => {
    assert.equal(formatRowSource({kind: 'note'}), 'メモ');
    assert.equal(formatRowSource({kind: 'text', source_app: 'org.gnome.Console'}), 'Console');
    assert.equal(formatRowDetail({kind: 'text', text: 'a\nb\nc'}), '3行');
    assert.equal(formatRowDetail({kind: 'image', width: 1280, height: 720, size_bytes: 102400}), '1280×720 • 100 KB');

    const shortBody = formatPreviewBody('hello', 10);
    assert.deepEqual(shortBody, {text: 'hello', truncated: false, totalChars: 5});

    const emojiBody = formatPreviewBody('😀'.repeat(12), 10);
    assert.equal(emojiBody.truncated, true);
    assert.equal(emojiBody.totalChars, 12);
    assert.match(emojiBody.text, /^😀{10}\n\n…（残り 2 文字）$/u);
});

test('isSafeGlobalShortcut and isSafeAcceleratorString reject bare or shift-only typing keys', () => {
    const SHIFT = 1 << 0;
    const CTRL = 1 << 2;
    const SUPER = 1 << 26;
    assert.equal(isSafeGlobalShortcut(0x0061, 0, SHIFT), false); // 'a'
    assert.equal(isSafeGlobalShortcut(0x0041, SHIFT, SHIFT), false); // Shift+A
    assert.equal(isSafeGlobalShortcut(0x0076, SUPER, SHIFT), true); // Super+V
    assert.equal(isSafeGlobalShortcut(0x0076, CTRL | SHIFT, SHIFT), true); // Ctrl+Shift+V
    assert.equal(isSafeGlobalShortcut(0xffbe, 0, SHIFT), true); // F1

    assert.equal(isSafeAcceleratorString('a'), false);
    assert.equal(isSafeAcceleratorString('<Shift>a'), false);
    assert.equal(isSafeAcceleratorString('<Super>v'), true);
    assert.equal(isSafeAcceleratorString('<Control><Shift>v'), true);
    assert.equal(isSafeAcceleratorString('F9'), true);
});

