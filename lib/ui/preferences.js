'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_PREFERENCES_BYTES = 128 * 1024; // 128 KiB
const VALID_THEMES = new Set(['system', 'graphite', 'paper', 'midnight', 'nordic', 'obsidian', 'emerald', 'tokyo']);
const INITIAL_REVISION = 'initial';

function getDefaultPreferences() {
    return {
        schemaVersion: 1,
        revision: INITIAL_REVISION,
        theme: 'system',
        sidebarCollapsed: false,
        sidebarWidth: 210,
        contextCollapsed: false,
        contextWidth: 294,
        selectedContextId: null,
        contexts: {},
    };
}

function createPreferencesStore({ root, fsImpl = fs }) {
    if (!root) throw new Error('createPreferencesStore requires root directory');

    const uiDir = path.join(root, '.omni', 'ui');
    const filePath = path.join(uiDir, 'workspace.json');

    function preserveCorrupt(rawContent) {
        try {
            fsImpl.mkdirSync(uiDir, { recursive: true });
            const backupFile = path.join(uiDir, `workspace.corrupt.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.json`);
            fsImpl.writeFileSync(backupFile, rawContent, 'utf8');
        } catch {
            // Ignore backup write failure in worst case
        }
    }

    function read() {
        if (!fsImpl.existsSync(filePath)) {
            return getDefaultPreferences();
        }

        let raw;
        try {
            raw = fsImpl.readFileSync(filePath, 'utf8');
        } catch {
            return getDefaultPreferences();
        }

        if (Buffer.byteLength(raw, 'utf8') > MAX_PREFERENCES_BYTES) {
            preserveCorrupt(raw);
            const defaults = getDefaultPreferences();
            defaults.corruptNotice = 'Stored preferences exceeded maximum size (128 KiB); preserved backup and reset to defaults.';
            return defaults;
        }

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            preserveCorrupt(raw);
            const defaults = getDefaultPreferences();
            defaults.corruptNotice = 'Stored preferences contained invalid JSON; preserved backup and reset to defaults.';
            return defaults;
        }

        if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1) {
            preserveCorrupt(raw);
            const defaults = getDefaultPreferences();
            defaults.corruptNotice = `Stored preferences had unsupported schemaVersion (${parsed?.schemaVersion}); preserved backup and reset to defaults.`;
            return defaults;
        }

        return {
            schemaVersion: 1,
            revision: typeof parsed.revision === 'string' && parsed.revision ? parsed.revision : crypto.randomUUID(),
            theme: VALID_THEMES.has(parsed.theme) ? parsed.theme : 'system',
            sidebarCollapsed: Boolean(parsed.sidebarCollapsed),
            sidebarWidth: typeof parsed.sidebarWidth === 'number' ? parsed.sidebarWidth : 210,
            contextCollapsed: Boolean(parsed.contextCollapsed),
            contextWidth: typeof parsed.contextWidth === 'number' ? parsed.contextWidth : 294,
            selectedContextId: typeof parsed.selectedContextId === 'string' ? parsed.selectedContextId : null,
            contexts: parsed.contexts && typeof parsed.contexts === 'object' ? parsed.contexts : {},
        };
    }

    function write(value, expectedRevision) {
        if (!value || typeof value !== 'object') {
            throw new Error('Preferences value must be a non-null object');
        }

        if (value.theme && !VALID_THEMES.has(value.theme)) {
            throw new Error(`Invalid theme: ${value.theme}. Must be one of: ${Array.from(VALID_THEMES).join(', ')}`);
        }

        // CAS revision check
        const current = read();
        if (expectedRevision !== undefined && expectedRevision !== null) {
            if (current.revision !== expectedRevision) {
                const err = new Error(`Preferences revision conflict. Expected ${expectedRevision}, found ${current.revision}`);
                err.code = 'PREFERENCES_CONFLICT';
                err.status = 409;
                throw err;
            }
        }

        const next = {
            schemaVersion: 1,
            revision: crypto.randomUUID(),
            theme: VALID_THEMES.has(value.theme) ? value.theme : current.theme,
            sidebarCollapsed: Boolean(value.sidebarCollapsed),
            sidebarWidth: typeof value.sidebarWidth === 'number' ? value.sidebarWidth : current.sidebarWidth,
            contextCollapsed: Boolean(value.contextCollapsed),
            contextWidth: typeof value.contextWidth === 'number' ? value.contextWidth : current.contextWidth,
            selectedContextId: value.selectedContextId || null,
            contexts: value.contexts && typeof value.contexts === 'object' ? value.contexts : {},
        };

        const serialized = JSON.stringify(next, null, 2);
        if (Buffer.byteLength(serialized, 'utf8') > MAX_PREFERENCES_BYTES) {
            const err = new Error(`Preferences payload exceeds maximum allowed size of ${MAX_PREFERENCES_BYTES} bytes`);
            err.code = 'PREFERENCES_OVERSIZED';
            err.status = 413;
            throw err;
        }

        fsImpl.mkdirSync(uiDir, { recursive: true });
        const tmpFile = path.join(uiDir, `workspace.tmp.${crypto.randomBytes(6).toString('hex')}`);
        fsImpl.writeFileSync(tmpFile, serialized, 'utf8');
        fsImpl.renameSync(tmpFile, filePath);

        return next;
    }

    return {
        read,
        write,
        filePath,
    };
}

module.exports = {
    createPreferencesStore,
    getDefaultPreferences,
    MAX_PREFERENCES_BYTES,
};
