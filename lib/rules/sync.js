'use strict';

const fs = require('fs');
const path = require('path');

const RULES_FILE = path.join('.omni', 'rules.md');

function syncRulesToConfig(findConfigFileFn, projectDir) {
    const configFile = findConfigFileFn();
    if (!configFile) return false;
    const configPath = path.join(projectDir, configFile);
    const rulesPath = path.join(projectDir, RULES_FILE);
    if (!fs.existsSync(rulesPath)) return false;

    const rulesRaw = fs.readFileSync(rulesPath, 'utf-8');
    const lines = rulesRaw.split('\n').filter(l => l.startsWith('- ')).join('\n');
    if (!lines) return false;

    let config = fs.readFileSync(configPath, 'utf-8');
    const startMarker = '<!-- omni:rules -->';
    const endMarker = '<!-- /omni:rules -->';
    const injection = `${startMarker}\n## PERSONAL RULES\n${lines}\n${endMarker}`;

    if (config.includes(startMarker) && config.includes(endMarker)) {
        const regex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, 'g');
        config = config.replace(regex, injection);
    } else {
        config += `\n\n${injection}\n`;
    }
    fs.writeFileSync(configPath, config, 'utf-8');
    return true;
}

module.exports = { syncRulesToConfig };
