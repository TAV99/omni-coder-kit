'use strict';

const fs = require('fs');

function parseRequirementsTxt(filePath) {
    try {
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        const deps = [];
        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith('#') || line.startsWith('-') || line.startsWith('--')) continue;
            const name = line.split(/[=<>!~\[;@\s]/)[0].trim().toLowerCase();
            if (name) deps.push(name);
        }
        return deps;
    } catch { return []; }
}

function parsePyprojectToml(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const deps = [];
        const depArrayRegex = /(?:dependencies|dev|test|docs)\s*=\s*\[([\s\S]*?)\]/g;
        let match;
        while ((match = depArrayRegex.exec(content)) !== null) {
            const block = match[1];
            const entries = block.match(/"([^"]+)"|'([^']+)'/g);
            if (entries) {
                for (const entry of entries) {
                    const raw = entry.replace(/["']/g, '');
                    const name = raw.split(/[=<>!~\[;@\s]/)[0].trim().toLowerCase();
                    if (name) deps.push(name);
                }
            }
        }
        return deps;
    } catch { return []; }
}

function parseGoMod(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const deps = [];
        const blockMatch = content.match(/require\s*\(([\s\S]*?)\)/g);
        if (blockMatch) {
            for (const block of blockMatch) {
                const inner = block.replace(/require\s*\(/, '').replace(/\)/, '');
                for (const line of inner.split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('//')) continue;
                    const parts = trimmed.split(/\s+/);
                    if (parts[0]) deps.push(parts[0]);
                }
            }
        }
        const singleLine = content.match(/^require\s+(\S+)\s+\S+/gm);
        if (singleLine) {
            for (const line of singleLine) {
                const parts = line.split(/\s+/);
                if (parts[1]) deps.push(parts[1]);
            }
        }
        return deps;
    } catch { return []; }
}

function parseCargoToml(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const deps = [];
        const sections = content.split(/^\[/m);
        for (const section of sections) {
            if (!/^(?:dev-)?dependencies\]/.test(section)) continue;
            for (const line of section.split('\n').slice(1)) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) break;
                const nameMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=/);
                if (nameMatch) deps.push(nameMatch[1]);
            }
        }
        return deps;
    } catch { return []; }
}

function parseComposerJson(filePath) {
    try {
        const pkg = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const deps = [];
        if (pkg.require) deps.push(...Object.keys(pkg.require));
        if (pkg['require-dev']) deps.push(...Object.keys(pkg['require-dev']));
        return deps;
    } catch { return []; }
}

function parseGemfile(filePath) {
    try {
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        const deps = [];
        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const match = line.match(/^\s*gem\s+['"]([^'"]+)['"]/);
            if (match) deps.push(match[1]);
        }
        return deps;
    } catch { return []; }
}

module.exports = {
    parseRequirementsTxt,
    parsePyprojectToml,
    parseGoMod,
    parseCargoToml,
    parseComposerJson,
    parseGemfile,
};
