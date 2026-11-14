'use strict';

const { createHash } = require('node:crypto');
const { CEILINGS, DiscussionError } = require('./discussion/contracts');

const SAFETY_BYTES = 1024;
const chunkPosition = (index, count) => `Review chunk ${index} of ${count} of a larger diff${index === count ? ' (the last chunk)' : ''}. `;
const CHUNK_POSITION_RESERVE = chunkPosition(9999, 99999);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function reviewBody(input, schema, diff, context = '') {
    return `${input}${context}\n\n--- BEGIN REVIEW DIFF ---\n${diff}\n--- END REVIEW DIFF ---\n`
        + `\n\n--- PHASE OUTPUT SCHEMA (JSON Schema) ---\n${schema}\nAnswer with ONLY a JSON object matching this schema.\n`;
}

// Ranges are half-open UTF-8 byte offsets into the original, never into JS strings.
// Context is outside the diff delimiters, so coverage contains no duplicate headers.
function planReviewChunks(input, schema, diff) {
    const original = Buffer.from(diff, 'utf8');
    let singleBody = reviewBody(input, schema, diff);
    if (Buffer.byteLength(singleBody) > CEILINGS.maxBodyBytes) {
        // Try the full diff with a compact schema before adding chunk context.
        schema = JSON.stringify(JSON.parse(schema));
        singleBody = reviewBody(input, schema, diff);
    }
    let pieces;
    if (Buffer.byteLength(singleBody) <= CEILINGS.maxBodyBytes) {
        pieces = [{ text: diff, body: singleBody }];
    } else {
        if (Buffer.byteLength(reviewBody(input, schema, '')) > CEILINGS.maxBodyBytes) {
            throw new DiscussionError('LIMIT_EXCEEDED', 'Review fixed overhead leaves no chunk byte budget');
        }
        pieces = [];
        const sections = diff.split(/(?=^diff --git |^New file: |^Snapshot change: )/m);
        let leading = '';
        for (const [index, rawSection] of sections.entries()) {
            if (!rawSection) continue;
            if (!rawSection.trim() && index < sections.length - 1) { leading += rawSection; continue; }
            const section = leading + rawSection;
            leading = '';
            const lines = section.match(/[^\n]*\n|[^\n]+$/g) || [];
            const headerIndex = lines.findIndex((line) => line.trim().length > 0);
            const header = lines[headerIndex < 0 ? 0 : headerIndex];
            // Chunks are turns of one review conversation. Coverage follows the
            // Review coverage contract (judged on everything seen so far and the
            // readable workspace), so chunks never contradict (omni-p8-test).
            // A chunk is told its position: code it has not seen yet arrives in a
            // later chunk, so "not shown yet" is a risk, never a finding or a
            // NEEDS_FIX (omni-p8-test c3b7f3cb: six such WARNINGs spent a correction).
            const contextFor = (part, position = CHUNK_POSITION_RESERVE) => `\n\n${position}Earlier chunks of this review are in this conversation; later chunks follow. Judge only defects you can see in this chunk and earlier ones. Code or files not shown yet arrive in a later chunk: never report their absence as a finding and never return NEEDS_FIX or REJECT for it; note it in remaining risks instead. The last chunk judges requirements that span files, with every chunk of this conversation in view. For v2 coverage follow the Review coverage contract: judge each check against everything seen so far and the files you can read, and report a real violation as an ERROR coverage finding, never as satisfied: false.\nFile context (may repeat outside the diff): ${header}${part}`;
            // A file larger than one chunk is cut at line boundaries; say so, so a
            // cut inside SVG or CSS is not reported as a defect.
            const partNote = (index, count) => (count > 1 ? `Part ${index} of ${count} of this file: it is cut at a line boundary and continues in the ${index < count ? 'next' : 'previous'} chunk; a cut is not a defect.\n` : '');
            const context = contextFor(partNote(99, 99));
            const exactBudget = CEILINGS.maxBodyBytes
                - Buffer.byteLength(reviewBody(input, schema, '', context));
            if (exactBudget <= 0) {
                throw new DiscussionError('LIMIT_EXCEEDED', 'Review fixed overhead leaves no chunk byte budget');
            }
            // Prefer whole files. For a large git patch, keep its initial file
            // headers with the first hunk and first hunk line when possible.
            let headerEnd = Math.max(1, headerIndex + 1);
            if (header.startsWith('diff --git ')) {
                const hunk = lines.findIndex((line) => line.startsWith('@@'));
                if (hunk >= 0) headerEnd = Math.min(lines.length, hunk + 2);
            } else if (header.startsWith('Snapshot change: ')) {
                headerEnd = Math.min(lines.length, headerIndex + 4);
            }
            const units = [lines.slice(0, headerEnd).join(''), ...lines.slice(headerEnd)];
            const largestUnit = units.reduce((maximum, unit) => Math.max(maximum, Buffer.byteLength(unit)), 0);
            // The reserve is optional headroom, not a smaller envelope ceiling.
            // Keep it when possible; otherwise validate against exact capacity.
            const budget = largestUnit <= exactBudget - SAFETY_BYTES ? exactBudget - SAFETY_BYTES : exactBudget;
            const texts = [];
            let pending = '', pendingBytes = 0;
            for (const unit of units) {
                const bytes = Buffer.byteLength(unit);
                if (bytes > budget) {
                    throw new DiscussionError('LIMIT_EXCEEDED',
                        `Review line or file header exceeds available chunk budget (${bytes} > ${budget} UTF-8 bytes)`);
                }
                if (pendingBytes + bytes > budget) {
                    texts.push(pending);
                    pending = ''; pendingBytes = 0;
                }
                pending += unit; pendingBytes += bytes;
            }
            if (pending) texts.push(pending);
            // The budget reserved the longest part note, so every body still fits.
            texts.forEach((text, index) => pieces.push({ text,
                context: (position) => contextFor(partNote(index + 1, texts.length), position) }));
        }
    }
    // Positions are known only once every file is split; the budget reserved the longest one.
    if (pieces.length > 1) pieces = pieces.map((piece, index) => ({ text: piece.text,
        body: reviewBody(input, schema, piece.text, piece.context(chunkPosition(index + 1, pieces.length))) }));
    let offset = 0;
    const chunks = pieces.map((piece) => {
        const bytes = Buffer.from(piece.text, 'utf8');
        const chunk = { ...piece, byte_start: offset, byte_end: offset + bytes.length,
            sha256: sha256(bytes), body_bytes: Buffer.byteLength(piece.body) };
        offset = chunk.byte_end;
        if (chunk.body_bytes > CEILINGS.maxBodyBytes) {
            throw new DiscussionError('LIMIT_EXCEEDED', 'Review chunk body exceeds envelope ceiling');
        }
        return chunk;
    });
    if (!Buffer.concat(chunks.map((c) => Buffer.from(c.text, 'utf8'))).equals(original)) {
        throw new DiscussionError('REVIEW_COVERAGE_INVALID', 'Review chunks do not reconstruct the original diff');
    }
    return { chunks, sha256: sha256(original), byte_length: original.length };
}

function aggregateReviews(reviews) {
    if (reviews.length === 1) return reviews[0];
    // Conservative ordering: a blocking chunk can never be outvoted by approvals.
    // Preserve every finding (including duplicates) and every challenge summary.
    const worst = (field, order) => reviews.reduce((a, b) =>
        order.indexOf(a[field]) >= order.indexOf(b[field]) ? a : b)[field];
    if (reviews.some((review) => review.schema_version !== reviews[0].schema_version)) {
        throw new DiscussionError('REVIEW_COVERAGE_CONTRADICTORY', 'Cannot aggregate mixed review schema versions');
    }
    let coverage = {};
    if (reviews[0].schema_version === 2) {
        const mergeChecks = (field, keyOf) => {
            const byKey = new Map();
            for (const check of reviews.flatMap((review) => review[field] || [])) {
                const key = keyOf(check), previous = byKey.get(key);
                if (previous && previous.satisfied !== check.satisfied) {
                    throw new DiscussionError('REVIEW_COVERAGE_CONTRADICTORY', `Contradictory ${field}: ${key}`);
                }
                if (previous && check.evidence_refs) {
                    previous.evidence_refs = [...new Set([...previous.evidence_refs, ...check.evidence_refs])];
                    previous.description = [...new Set([previous.description, check.description])].join('\n');
                } else if (!previous) byKey.set(key, { ...check });
            }
            return [...byKey.values()];
        };
        coverage = {
            coverage_checks: mergeChecks('coverage_checks', (check) => check.dimension_id),
            constraint_findings: mergeChecks('constraint_findings', (check) => `${check.dimension_id}:${check.constraint}`),
            coverage_findings: [...new Map(reviews.flatMap((review) => review.coverage_findings || []).map((finding) => [JSON.stringify(finding), finding])).values()],
        };
    }
    return { ...reviews[0], ...coverage,
        recommendation: worst('recommendation', ['APPROVE', 'NEEDS_FIX', 'REJECT']),
        risk_level: worst('risk_level', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
        findings: reviews.flatMap((r) => r.findings),
        review_checks: reviews.flatMap((r) => r.review_checks),
        challenge_summary: reviews.map((r, i) => `Chunk ${i + 1}: ${r.challenge_summary}`).join('\n'),
    };
}

module.exports = { planReviewChunks, aggregateReviews, reviewBody, SAFETY_BYTES };
