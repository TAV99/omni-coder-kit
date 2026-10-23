'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getAgentFlags, getSkillDir, IDE_AGENT_MAP } = require('../lib/helpers');
const { buildSkillInstallArgs, generateRetryScript, selectRegistrySkill, resolveSkillInstallIdentity } = require('../lib/commands/equip');
const { ExternalOperationSchema } = require('../lib/dual/external-operations');

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
    assert.match(content, /review_submission/, 'must document daemon-bound review submissions');
    assert.match(content, /review-evidence/, 'must document the compatibility CLI alias');
    assert.match(content, /omni_dual_acceptance_review_prepare/, 'must document daemon-owned review preparation');
    assert.match(content, /omni_dual_acceptance_review_submit/, 'must document the public post-integration review route');
    assert.match(content, /Post-integration acceptance correction/, 'must document acceptance correction');
    assert.match(content, /policy-defined required session review/, 'must bind correction scope to a policy grant');
    assert.doesNotMatch(content, /"allowed_files"\s*:/, 'correction pseudo-contract must not accept caller scope');
    assert.doesNotMatch(content, /"validation_commands"\s*:/, 'correction pseudo-contract must not accept caller validators');
    assert.match(content, /attempt/i, 'must describe attempt bounds (1..3)');
    assert.match(content, /Durable failures and session blocking/, 'must document session blocking');
    assert.match(content, /BUDGET_EXHAUSTED/, 'must mention blocker code');
});

test('dual-controller JSON examples parse through the production MCP schemas', async () => {
    const content = fs.readFileSync(path.join(__dirname, '..', 'templates', 'workflows', 'dual-controller.md'), 'utf8');
    const { ResumeInputSchema, CompletionInputSchema, AcceptanceReviewSubmitInputSchema,
        CorrectionStartInputSchema, SessionBlockInputSchema, RejectHandoffInputSchema } =
        await import('../lib/dual/mcp-server.mjs');
    const examples = [];
    const fence = /```json\s*\n([\s\S]*?)\n```/gu;
    let match;
    while ((match = fence.exec(content))) examples.push(JSON.parse(match[1]));
    assert.ok(examples.length >= 5, 'template must retain machine-readable request examples');
    for (const example of examples) {
        if (example.context_reply || example.correction) ResumeInputSchema.parse(example);
        else if (example.isolated_qc) CompletionInputSchema.parse(example);
        else if (example.review_submission) AcceptanceReviewSubmitInputSchema.parse(example);
        else if (example.expected_sequence) CorrectionStartInputSchema.parse(example);
        else if (example.blocker_code) SessionBlockInputSchema.parse(example);
        else if (example.expected_handoff_sha256) RejectHandoffInputSchema.parse(example);
        else if (example.external_operations) ExternalOperationSchema.array().parse(example.external_operations);
        else throw new Error(`Unclassified JSON template example: ${JSON.stringify(example)}`);
    }
});

test('truthful workflow templates: skill-manager.md accurately explains Antigravity .agents/skills discovery', () => {
    const templatePath = path.join(__dirname, '..', 'templates', 'workflows', 'skill-manager.md');
    const content = fs.readFileSync(templatePath, 'utf8');

    assert.match(content, /Codex & Antigravity/);
    assert.match(content, /\.agents\/skills/);
    assert.match(content, /symlink → Claude Code/);
});

test('manual registry selection requires an exact selector and keeps aliases distinct', () => {
    assert.throws(
        () => selectRegistrySkill('obra/superpowers', {}),
        (err) => err.code === 'DUAL_SKILL_SELECTOR_REQUIRED'
    );
    assert.throws(
        () => selectRegistrySkill('obra/superpowers', { source: true }),
        (err) => err.code === 'DUAL_SKILL_SELECTOR_REQUIRED',
        '--source must not act as an unverified multi-skill trust assertion'
    );
    assert.throws(
        () => selectRegistrySkill('obra/superpowers', { skill: 'not a selector' }),
        (err) => err.code === 'DUAL_SKILL_SELECTOR_INVALID'
    );

    const first = selectRegistrySkill('obra/superpowers', { skill: 'systematic-debugging' });
    const second = selectRegistrySkill('obra/superpowers', { skill: 'test-driven-development' });
    assert.deepEqual(first, {
        skillName: 'systematic-debugging',
        selector: 'systematic-debugging',
        source: 'obra/superpowers#systematic-debugging',
    });
    assert.notEqual(first.skillName, second.skillName, 'different selectors must not collide in the manifest');
});

test('verified single-file sources remain directly installable without a registry selector', () => {
    assert.deepEqual(resolveSkillInstallIdentity({ type: 'local', value: './SKILL.md' }, {}), {
        skillName: 'skill',
        source: 'local:./SKILL.md',
        sourceType: 'local',
    });
});
