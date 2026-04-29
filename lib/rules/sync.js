'use strict';

const fs = require('fs');
const path = require('path');

const RULES_FILE = path.join('.omni', 'rules.md');

function syncRulesToConfig(findConfigFileFn, projectDir, { dryRun = false } = {}) {
    const configFile = findConfigFileFn();
    if (!configFile) return dryRun ? { action: 'skip', preview: '' } : false;
    const configPath = path.join(projectDir, configFile);
    const rulesPath = path.join(projectDir, RULES_FILE);
    if (!fs.existsSync(rulesPath)) return dryRun ? { action: 'skip', preview: '' } : false;

    const rulesRaw = fs.readFileSync(rulesPath, 'utf-8');
    const lines = rulesRaw.split('\n').filter(l => l.startsWith('- ')).join('\n');
    if (!lines) return dryRun ? { action: 'skip', preview: '' } : false;

    let config = fs.readFileSync(configPath, 'utf-8');
    const startMarker = '<!-- omni:rules -->';
    const endMarker = '<!-- /omni:rules -->';

    const hasStart = config.includes(startMarker);
    const hasEnd = config.includes(endMarker);
    if (hasStart !== hasEnd) {
        return dryRun ? { action: 'corrupt', preview: '' } : 'corrupt';
    }

    const injection = `${startMarker}\n## PERSONAL RULES\n${lines}\n${endMarker}`;

    if (hasStart && hasEnd) {
        if (dryRun) return { action: 'replace', preview: injection };
        const regex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, 'g');
        config = config.replace(regex, injection);
    } else {
        if (dryRun) return { action: 'append', preview: injection };
        config += `\n\n${injection}\n`;
    }
    fs.writeFileSync(configPath, config, 'utf-8');
    return true;
}

module.exports = { syncRulesToConfig };
