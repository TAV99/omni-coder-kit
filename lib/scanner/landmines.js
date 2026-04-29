'use strict';

const fs = require('fs');
const path = require('path');
const { MAX_LANDMINES, SOURCE_EXTENSIONS, MAX_FILE_SIZE } = require('./constants');

const SEVERITY_MAP = { FIXME: 'critical', XXX: 'critical', HACK: 'warning', TODO: 'info' };
const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

function grepLandmines(dir, allFiles) {
    const landmines = [];
    const pattern = /\b(TODO|FIXME|HACK|XXX)\b[:\s]*(.*)/;
    for (const rel of allFiles) {
        if (landmines.length >= MAX_LANDMINES) break;
        const ext = path.extname(rel);
        if (!SOURCE_EXTENSIONS.has(ext)) continue;
        const fullPath = path.join(dir, rel);
        try {
            const stat = fs.statSync(fullPath);
            if (stat.size > MAX_FILE_SIZE) continue;
        } catch { continue; }
        try {
            const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (landmines.length >= MAX_LANDMINES) break;
                const match = lines[i].match(pattern);
                if (match) {
                    const before = i > 0 ? lines[i - 1].trim() : '';
                    const after = i < lines.length - 1 ? lines[i + 1].trim() : '';
                    landmines.push({
                        file: rel,
                        line: i + 1,
                        type: match[1],
                        severity: SEVERITY_MAP[match[1]],
                        text: match[2].trim().substring(0, 120),
                        context: [before, after].filter(Boolean).join(' | '),
                    });
                }
            }
        } catch {}
    }
    landmines.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    return landmines;
}

function groupBySeverity(landmines) {
    const groups = { critical: [], warning: [], info: [] };
    for (const m of landmines) {
        if (groups[m.severity]) groups[m.severity].push(m);
    }
    return groups;
}

function formatLandminesForPlan(landmines) {
    const groups = groupBySeverity(landmines);
    const lines = [];
    if (groups.critical.length > 0) {
        lines.push('### 🔴 Critical');
        for (const m of groups.critical) lines.push(`- [ ] \`${m.file}:${m.line}\` — ${m.type}: ${m.text}`);
        lines.push('');
    }
    if (groups.warning.length > 0) {
        lines.push('### ⚠️ Warning');
        for (const m of groups.warning) lines.push(`- [ ] \`${m.file}:${m.line}\` — ${m.type}: ${m.text}`);
        lines.push('');
    }
    if (groups.info.length > 0) {
        lines.push('### ℹ️ Info');
        for (const m of groups.info) lines.push(`- [ ] \`${m.file}:${m.line}\` — ${m.type}: ${m.text}`);
        lines.push('');
    }
    return lines.join('\n');
}

function formatLandminesForMap(landmines, maxPerGroup = 4) {
    const groups = groupBySeverity(landmines);
    const lines = [];
    for (const [severity, label] of [['critical', '🔴 Critical'], ['warning', '⚠️ Warning'], ['info', 'ℹ️ Info']]) {
        const items = groups[severity];
        if (items.length === 0) continue;
        lines.push(`**${label}** (${items.length})`);
        const show = items.slice(0, maxPerGroup);
        for (const m of show) lines.push(`- \`${m.file}:${m.line}\` — ${m.type}: ${m.text}`);
        if (items.length > maxPerGroup) lines.push(`- _(${items.length - maxPerGroup} more)_`);
        lines.push('');
    }
    return lines.join('\n');
}

module.exports = { SEVERITY_MAP, grepLandmines, groupBySeverity, formatLandminesForPlan, formatLandminesForMap };
