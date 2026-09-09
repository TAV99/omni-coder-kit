'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getAgentFlags, getSkillDir, IDE_AGENT_MAP } = require('../lib/helpers');
const { buildSkillInstallArgs, generateRetryScript } = require('../lib/commands/equip');

test('skill selector: IDE_AGENT_MAP maps targets correctly and safely for skills.sh', () => {
    assert.deepEqual(IDE_AGENT_MAP.claudecode, ['claude-code']);
    assert.deepEqual(IDE_AGENT_MAP.codex, ['codex']);
    assert.deepEqual(IDE_AGENT_MAP.antigravity, ['codex'], 'antigravity targets .agents/skills via codex agent');
    assert.deepEqual(IDE_AGENT_MAP.dual, ['claude-code', 'codex'], 'dual targets both claude-code and codex');
    assert.deepEqual(IDE_AGENT_MAP.agents, ['claude-code', 'codex']);
    assert.equal(IDE_AGENT_MAP.generic, null);
});

test('skill selector: getAgentFlags produces valid repeated --agent flags for multi-agent environments', () => {
    assert.equal(getAgentFlags({ ide: 'claudecode' }), '--agent claude-code');
    assert.equal(getAgentFlags({ ide: 'codex' }), '--agent codex');
    assert.equal(getAgentFlags({ ide: 'antigravity' }), '--agent codex');
    assert.equal(getAgentFlags({ ide: 'dual' }), '--agent claude-code --agent codex');
    assert.equal(getAgentFlags({ ide: 'agents' }), '--agent claude-code --agent codex');
    assert.equal(getAgentFlags({ ide: 'generic' }), '');
    assert.equal(getAgentFlags({}), '');
    assert.equal(getAgentFlags(null), '');
});

test('skill selector: buildSkillInstallArgs splits multi-agent flags into individual CLI tokens without positional corruption', () => {
    const skill = { source: 'obra/superpowers', name: 'test-driven-development' };
    const dualFlags = getAgentFlags({ ide: 'dual' });
    const args = buildSkillInstallArgs(skill, dualFlags);

    assert.deepEqual(args, [
        '-y', 'skills', 'add', 'obra/superpowers',
        '--agent', 'claude-code',
        '--agent', 'codex',
        '--skill', 'test-driven-development',
        '-y',
    ]);
    const codexIndex = args.indexOf('codex');
    assert.equal(args[codexIndex - 1], '--agent');

    const retryCmd = generateRetryScript([skill], dualFlags, true);
    assert.match(retryCmd, /--agent claude-code --agent codex/);
});

test('truthful workflow templates: dual-controller.md aligns with hardened acceptance, review, correction and blocking contracts', () => {
    const templatePath = path.join(__dirname, '..', 'templates', 'workflows', 'dual-controller.md');
    const content = fs.readFileSync(templatePath, 'utf8');

    assert.match(content, /acceptance_policy/, 'must mention acceptance_policy');
    assert.match(content, /review_evidence/, 'must mention review_evidence in isolated QC');
    assert.match(content, /Post-integration acceptance correction/, 'must document acceptance correction');
    assert.match(content, /attempt/i, 'must describe attempt bounds (1..3)');
    assert.match(content, /Durable failures and session blocking/, 'must document session blocking');
    assert.match(content, /BUDGET_EXHAUSTED/, 'must mention blocker code');
});

test('truthful workflow templates: skill-manager.md accurately explains Antigravity .agents/skills discovery', () => {
    const templatePath = path.join(__dirname, '..', 'templates', 'workflows', 'skill-manager.md');
    const content = fs.readFileSync(templatePath, 'utf8');

    assert.match(content, /Codex & Antigravity/);
    assert.match(content, /\.agents\/skills/);
    assert.match(content, /symlink → Claude Code/);
});
