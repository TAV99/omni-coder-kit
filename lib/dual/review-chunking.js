'use strict';

const { createHash } = require('node:crypto');
const { CEILINGS, DiscussionError } = require('./discussion/contracts');

const SAFETY_BYTES = 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function reviewBody(input, schema, diff, context = '') {
    return `${input}${context}\n\n--- BEGIN REVIEW DIFF ---\n${diff}\n--- END REVIEW DIFF ---\n`
        + `\n\n--- PHASE OUTPUT SCHEMA (JSON Schema) ---\n${schema}\nAnswer with ONLY a JSON object matching this schema.\n`;
}

// Ranges are half-open UTF-8 byte offsets into the original, never into JS strings.
// Context is outside the diff delimiters, so coverage contains no duplicate headers.
function planReviewChunks(input, schema, diff) {
    const original = Buffer.from(diff, 'utf8');
    const singleBody = reviewBody(input, schema, diff);
    let pieces;
    if (Buffer.byteLength(singleBody) <= CEILINGS.maxBodyBytes) {
        pieces = [{ text: diff, body: singleBody }];
    } else {
        // Schema whitespace is redundant, unlike source whitespace. Compact it
        // losslessly only on the chunked path to avoid wasting session turns.
        schema = JSON.stringify(JSON.parse(schema));
        if (Buffer.byteLength(reviewBody(input, schema, '')) + SAFETY_BYTES >= CEILINGS.maxBodyBytes) {
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
            const context = `\n\nReview one chunk of a larger diff. Only approve this chunk if supported by its contents; report missing cross-chunk context as a risk/finding.\nFile context (may repeat outside the diff): ${header}`;
            const budget = CEILINGS.maxBodyBytes - SAFETY_BYTES
                - Buffer.byteLength(reviewBody(input, schema, '', context));
            if (budget <= 0) {
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
            let pending = '', pendingBytes = 0;
            for (const unit of units) {
                const bytes = Buffer.byteLength(unit);
                if (bytes > budget) {
                    throw new DiscussionError('LIMIT_EXCEEDED',
                        `Review line or file header exceeds available chunk budget (${bytes} > ${budget} UTF-8 bytes)`);
                }
                if (pendingBytes + bytes > budget) {
                    pieces.push({ text: pending, body: reviewBody(input, schema, pending, context) });
                    pending = ''; pendingBytes = 0;
                }
                pending += unit; pendingBytes += bytes;
            }
            if (pending) pieces.push({ text: pending, body: reviewBody(input, schema, pending, context) });
        }
    }
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
    return { ...reviews[0],
        recommendation: worst('recommendation', ['APPROVE', 'NEEDS_FIX', 'REJECT']),
        risk_level: worst('risk_level', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
        findings: reviews.flatMap((r) => r.findings),
        review_checks: reviews.flatMap((r) => r.review_checks),
        challenge_summary: reviews.map((r, i) => `Chunk ${i + 1}: ${r.challenge_summary}`).join('\n'),
    };
}

module.exports = { planReviewChunks, aggregateReviews, reviewBody, SAFETY_BYTES };
