'use strict';

// ---------------------------------------------------------------------------
// Adversarial cross-provider debate (HARNESS-SPEC-PHASE-3 §3b).
//
// Materializes the "cross-model escalation" of doubt-driven-development: ≥2
// agents from different model families cross-examine a claim over rounds until
// they converge. THE LOOP IS THE MODERATOR (this function) — providers only
// submit position/critique text; a provider NEVER calls another provider
// (depth = 1, orchestration-patterns). Claim content is read from artifacts,
// never paraphrased between agents.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const { fanout } = require('./fanout');
const { appendEvent } = require('./events');
const { resolveWorkflow } = require('../workflows/resolve');

function readArtifacts(projectDir, paths = [], cap = 4000) {
    let out = '';
    for (const rel of paths || []) {
        try { out += `\n--- ${rel} ---\n` + fs.readFileSync(path.join(projectDir, rel), 'utf-8'); } catch { /* ignore */ }
        if (out.length > cap) break;
    }
    return out.slice(0, cap);
}

// Parse a verdict from an agent's response text. A found problem dominates
// (adversarial): FAIL/REFUTE beats PASS/AGREE if both appear.
function parseVerdict(id, r) {
    const text = (r && r.summary) || '';
    const hasFail = /\b(FAIL|REFUTE|DISAGREE|REJECT|BUG|BROKEN|UNSAFE)\b/i.test(text);
    const hasPass = /\b(PASS|AGREE|CONFIRM|LGTM|SAFE|CORRECT)\b/i.test(text);
    const verdict = hasFail ? 'fail' : (hasPass ? 'pass' : 'unknown');
    return { id, ok: r ? r.ok !== false : false, verdict, position: text, confidence: r && r.ok === false ? 0 : 0.5 };
}

function classify(positions) {
    const known = positions.map((p) => p.verdict).filter((v) => v !== 'unknown');
    if (known.length === 0) return { consensus: 'inconclusive', verdict: 'unknown' };
    const uniq = new Set(known);
    if (uniq.size === 1) return { consensus: 'agree', verdict: [...uniq][0] };
    return { consensus: 'split', verdict: 'fail' }; // disagreement → not safe to pass
}

async function runDebate({ projectDir, claim = {}, participants = [], rounds = 2, runStep = null, onEvent = null, now = null } = {}) {
    const dir = projectDir || process.cwd();
    const emit = (e) => { const rec = appendEvent(dir, e); if (onEvent) onEvent(rec); return rec; };

    const warnings = [];
    if (participants.length < 2) warnings.push('Debate cần ≥2 participant — kết quả ít giá trị.');
    if (new Set(participants.map((p) => p.host)).size === 1 && participants.length >= 2) {
        warnings.push('Tất cả participant cùng host/model — debate cùng-model giá trị thấp; nên dùng host khác họ.');
    }
    for (const w of warnings) emit({ type: 'debate-warning', reason: w });

    const brief = `${claim.question || '(no question)'}\n${readArtifacts(dir, claim.artifactPaths)}`;
    const workflowPath = resolveWorkflow('doubt-debate.md', dir);

    // Default per-participant runner: ask the participant's provider to debate.
    const ask = runStep || (async (p, payload) => {
        const r = await p.provider.runStep('debate', { projectDir: dir, workflowPath, sharedBrief: payload.text, claim });
        return parseVerdict(p.id, r);
    });

    const transcript = [];
    let positions = [];
    let actualRounds = 0;
    for (let round = 0; round < Math.max(1, rounds); round++) {
        const prev = positions;
        const concurrency = (new Set(participants.map(p => p.provider)).size < participants.length) ? 1 : 3;
        positions = await fanout(participants, async (p) => {
            const others = prev.filter((x) => x.id !== p.id);
            const text = round === 0
                ? `Adversarial review. Question: ${claim.question}\n\n${brief}\n\n`
                  + `Take a position and end with a verdict line: VERDICT: PASS or VERDICT: FAIL.`
                : `Question: ${claim.question}\n\n${brief}\n\n--- Other agents' positions (anonymized) ---\n`
                  + others.map((o, i) => `Agent ${String.fromCharCode(65 + i)}: ${o.position}`).join('\n\n')
                  + `\n\nState agreements + rebuttals, then your REVISED verdict line: VERDICT: PASS or VERDICT: FAIL.`;
            const res = await ask(p, { text, round });
            return { ...res, id: res.id || p.id };
        }, { concurrency });

        actualRounds = round + 1;
        transcript.push({ round, positions: positions.map((p) => ({ id: p.id, verdict: p.verdict, position: p.position })) });
        const c = classify(positions);
        emit({
            type: 'debate',
            round,
            participants: positions.map((p) => {
                const firstLine = String(p.position || '')
                    .split('\n')
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0 && !/^VERDICT:/i.test(s))[0] || '';
                const summary = firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
                return { id: p.id, ok: p.ok, verdict: p.verdict, confidence: p.confidence, summary };
            }),
            consensus: c.consensus
        });
        if (c.consensus === 'agree') break; // early convergence
    }

    const { consensus, verdict } = classify(positions);
    const stamp = (now || new Date().toISOString()).replace(/[:.]/g, '-');
    const transcriptPath = path.join('.omni', 'run', `debate-${stamp}.md`);
    writeTranscript(dir, transcriptPath, { claim, participants, transcript, consensus, verdict, warnings });

    return { consensus, verdict, transcript, rounds: actualRounds, transcriptPath, warnings };
}

function writeTranscript(projectDir, relPath, data) {
    const full = path.join(projectDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const lines = [
        `# Debate — ${data.consensus.toUpperCase()} (${data.verdict})`,
        `> Question: ${data.claim.question || '(none)'}`,
        `> Participants: ${data.participants.map((p) => `${p.id}`).join(', ')}`,
        ...(data.warnings.length ? [`> ⚠ ${data.warnings.join(' ')}`] : []),
        '',
    ];
    for (const r of data.transcript) {
        lines.push(`## Round ${r.round}`);
        for (const p of r.positions) lines.push(`### ${p.id} — ${p.verdict}\n${p.position}\n`);
    }
    fs.writeFileSync(full, lines.join('\n'), 'utf-8');
}

module.exports = { runDebate, classify, parseVerdict };
