'use strict';

// ---------------------------------------------------------------------------
// Phase-4 acceptance scoring (SPEC-PHASE-4-ACCEPTANCE-LOOP §3b).
//
// For each requirement in `.omni/sdlc/requirements.md`, decide MET / NOT-MET
// using a HYBRID strategy:
//   - `test:` is a shell command → run it (exit 0 = met, with hard evidence).
//   - `test: agent` (or any string we can't run) → run cross-model debate;
//     `consensus=agree && verdict=pass` = met. Anything else (split / fail /
//     inconclusive) = NOT met (no blind-fix).
//
// Writes `.omni/sdlc/conformance.md` (traceability: id → met + evidence +
// the round it was decided), and flips the matching `- [ ]` row's status in
// requirements.md via intake.updateRequirementStatus (artifact = hand-off).
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const { runCommand } = require('./tools/shell');
const { updateRequirementStatus, requirementsPath, customerSpecPath } = require('./intake');

const SDLC_SUBDIR = path.join('.omni', 'sdlc');
const CONFORMANCE_FILE = 'conformance.md';

function conformancePath(projectDir) {
    return path.join(projectDir || process.cwd(), SDLC_SUBDIR, CONFORMANCE_FILE);
}

// Is `test:` runnable as a shell command? Anything other than the literal
// "agent" sentinel (or empty/no-test) is treated as a command/path string.
function isHardTest(test) {
    const t = String(test || '').trim();
    if (!t) return false;
    if (/^agent$/i.test(t)) return false;
    return true;
}

// Run one hard test. Returns { met: boolean, evidence: string }.
function runHardTest(projectDir, requirement, { runner = runCommand } = {}) {
    const cmd = String(requirement.test).trim();
    let res;
    try {
        res = runner(cmd, { cwd: projectDir, timeoutMs: 120000 });
    } catch (err) {
        return { met: false, evidence: `command rejected: ${err.message}` };
    }
    const passed = res.exitCode === 0 && !res.timedOut;
    const out = ((res.stdout || '') + (res.stderr ? '\n' + res.stderr : '')).trim();
    const tail = out.length > 800 ? out.slice(-800) : out;
    return {
        met: passed,
        evidence: `\`${cmd}\` exit=${res.exitCode}${res.timedOut ? ' TIMEOUT' : ''}\n${tail || '(no output)'}`,
    };
}

// Run one agent-judged requirement. If participants.length === 1, run a single-agent
// audit directly (no debate). Otherwise, run cross-model debate.
async function runAgentJudgement({
    projectDir, requirement, participants, rounds, runDebate, onEvent,
}) {
    if (!Array.isArray(participants) || participants.length < 1) {
        return { met: false, evidence: 'No participants configured to judge requirement' };
    }
    const artifactPaths = [
        path.join(SDLC_SUBDIR, 'requirements.md'),
        path.join(SDLC_SUBDIR, 'customer-spec.md'),
        path.join(SDLC_SUBDIR, 'design-spec.md'),
    ].filter((p) => fs.existsSync(path.join(projectDir || process.cwd(), p)));

    if (participants.length === 1) {
        const p = participants[0];
        const dir = projectDir || process.cwd();
        
        const readArtifacts = (paths = [], cap = 4000) => {
            let out = '';
            for (const rel of paths || []) {
                try { out += `\n--- ${rel} ---\n` + fs.readFileSync(path.join(dir, rel), 'utf-8'); } catch { /* ignore */ }
                if (out.length > cap) break;
            }
            return out.slice(0, cap);
        };
        
        const brief = `${requirement.id}: ${requirement.text}\n${readArtifacts(artifactPaths)}`;
        const { resolveWorkflow } = require('../workflows/resolve');
        const workflowPath = resolveWorkflow('doubt-debate.md', dir);

        const text = `Adversarial review. Question: Sản phẩm hiện tại có thoả yêu cầu "${requirement.id}: ${requirement.text}" không?\n\n${brief}\n\n`
            + `Take a position and end with a verdict line: VERDICT: PASS or VERDICT: FAIL.`;

        let r;
        try {
            r = await p.provider.runStep('debate', { projectDir: dir, workflowPath, sharedBrief: text, claim: { question: requirement.text } });
        } catch (err) {
            return { met: false, evidence: `single-agent audit failed: ${err.message}` };
        }

        const { parseVerdict } = require('./debate');
        const verdictRes = parseVerdict(p.id, r);
        const met = verdictRes.verdict === 'pass';
        
        return {
            met,
            evidence: `single-agent audit: host=${p.host} verdict=${verdictRes.verdict} position=${(verdictRes.position || '').slice(0, 150).replace(/\r?\n/g, ' ')}`,
        };
    }

    const claim = {
        question: `Sản phẩm hiện tại có thoả yêu cầu "${requirement.id}: ${requirement.text}" không? Trả lời PASS/FAIL kèm dẫn chứng.`,
        artifactPaths,
    };
    const res = await runDebate({
        projectDir, claim, participants, rounds: Math.max(1, Number(rounds) || 2), onEvent,
    });
    const met = res.consensus === 'agree' && res.verdict === 'pass';
    return {
        met,
        evidence: `debate consensus=${res.consensus} verdict=${res.verdict} rounds=${res.rounds} → ${res.transcriptPath}`,
    };
}

// Score every requirement (hybrid). Sequential by default (debate calls are
// already concurrent inside debate.js); keeps order predictable for conformance.md.
async function runAcceptance({
    projectDir,
    requirements,
    runDebate,                              // injected (default = real debate engine)
    runner = runCommand,                    // shell runner for hard tests (inject in tests)
    participants = [],
    rounds = 2,
    onEvent = null,
} = {}) {
    if (!Array.isArray(requirements)) throw new Error('runAcceptance: requirements phải là mảng');
    const dir = projectDir || process.cwd();
    const emit = (e) => { if (onEvent) onEvent(e); };

    const report = [];
    const failed = [];

    for (const req of requirements) {
        if (req.status === 'met') {
            const entry = {
                id: req.id,
                text: req.text,
                met: true,
                method: req.test && req.test !== 'agent' ? 'test' : 'agent',
                evidence: req.note ? `Preserved: ${req.note}` : 'Already marked as met in requirements.md'
            };
            report.push(entry);
            emit({ type: 'acceptance-req', id: req.id, met: true, method: entry.method });
            continue;
        }

        const isHard = isHardTest(req.test);
        let res;
        if (isHard) {
            res = runHardTest(dir, req, { runner });
            res.method = 'test';
        } else {
            res = await runAgentJudgement({
                projectDir: dir, requirement: req, participants, rounds, runDebate, onEvent,
            });
            res.method = 'agent';
        }

        const entry = { id: req.id, text: req.text, met: !!res.met, method: res.method, evidence: res.evidence };
        report.push(entry);
        if (!res.met) failed.push(req.id);

        // Mirror result back into requirements.md (status only — no rewrite).
        const noteSummary = !res.met
            ? (res.evidence || '').split('\n')[0].slice(0, 100)
            : '';
        updateRequirementStatus(dir, req.id, res.met ? 'met' : 'failed', noteSummary);

        emit({ type: 'acceptance-req', id: req.id, met: res.met, method: res.method });
    }

    const allMet = failed.length === 0;
    emit({ type: 'acceptance', allMet, met: report.length - failed.length, total: report.length, failed });
    return { allMet, report, failed };
}

function writeConformance(projectDir, report, { round = 1 } = {}) {
    const dir = projectDir || process.cwd();
    fs.mkdirSync(path.dirname(conformancePath(dir)), { recursive: true });
    const lines = [
        `# Conformance report (round ${round})`,
        '',
        `Source: \`${path.join(SDLC_SUBDIR, 'requirements.md')}\` · \`${path.join(SDLC_SUBDIR, 'customer-spec.md')}\``,
        '',
        '| ID | Met | Method | Evidence |',
        '|----|-----|--------|----------|',
    ];
    for (const r of report) {
        const evid = (r.evidence || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ↵ ');
        lines.push(`| ${r.id} | ${r.met ? '✅' : '❌'} | ${r.method} | ${evid.slice(0, 400)} |`);
    }
    lines.push('');
    const met = report.filter((r) => r.met).length;
    lines.push(`Total: ${met}/${report.length} requirements met.`);
    fs.writeFileSync(conformancePath(dir), lines.join('\n') + '\n', 'utf-8');
    return conformancePath(dir);
}

module.exports = {
    runAcceptance, writeConformance, conformancePath,
    isHardTest, runHardTest, runAgentJudgement,
    requirementsPath, customerSpecPath,
};
