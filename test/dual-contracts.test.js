'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    TaskIdSchema,
    ContextSchema,
    SpecSchema,
    RouteSchema,
    EvidenceSchema,
    ReviewSchema,
    EventSchema,
    AttemptMetaSchema,
    SetupActionSchema,
    DualPlanManifestSchema,
    parseContract,
    toDraft7Schema,
    validateEventSequence,
} = require('../lib/dual/contracts');

const CORRELATION = {
    schema_version: 1,
    task_id: 'AI4T-002',
    expected_base_commit: 'a'.repeat(40),
};

const VALID_SPEC = {
    ...CORRELATION,
    goal: 'Build the conversion structure',
    allowed_files: ['index.html', 'styles.css', 'tests/landing-page.test.mjs'],
    deny_patterns: ['**/.env*'],
    validation_commands: [{ program: 'npm', args: ['test'], cwd: '.' }],
    risk_flags: [],
    permission_authority: 'dual-init-dangerous-auto-v1',
};

const DEPTH_EVIDENCE = {
    research_trace: [
        { question: 'Where is the feature implemented?', source: 'index.html', source_type: 'REPOSITORY', conclusion: 'The main element owns the feature.' },
        { question: 'How is it validated?', source: 'tests/landing-page.test.mjs', source_type: 'TEST_OUTPUT', conclusion: 'The existing test covers the public behavior.' },
    ],
    alternatives_considered: [
        { option: 'Keep the existing structure', tradeoff: 'Smallest diff but limited reuse.' },
        { option: 'Extract a helper', tradeoff: 'More reuse but unnecessary scope.' },
    ],
    failure_modes: ['The expected element may be absent at runtime.'],
};

describe('dual contracts', () => {
    it('accepts a strict full-graph dual plan manifest', () => {
        const parsed = DualPlanManifestSchema.parse({
            schema_version: 1,
            plan_revision: 1,
            tasks: [{
                task_id: 'WAITLIST-1',
                title: 'Build waitlist form',
                owner: 'agy',
                goal: 'Implement the tested waitlist form',
                category: 'frontend',
                complexity: 'medium',
                risk: 'low',
                allowed_files: ['src/WaitlistForm.tsx'],
                context_files: ['.omni/sdlc/design-spec.md'],
                deny_patterns: ['package.json'],
                validation_commands: [{ program: 'npm', args: ['test'], cwd: '.' }],
            }],
        });
        assert.equal(parsed.tasks[0].owner, 'agy');
    });

    it('rejects duplicate IDs and incomplete or unsafe dual plan tasks', () => {
        const task = {
            task_id: 'TASK-1', title: 'Task', owner: 'codex', goal: 'Do work',
            category: 'frontend', complexity: 'small', risk: 'low',
            allowed_files: ['src/a.js'], context_files: [], deny_patterns: [], validation_commands: [],
        };
        assert.equal(DualPlanManifestSchema.safeParse({
            schema_version: 1, plan_revision: 1, tasks: [task, { ...task }],
        }).success, false);
        assert.equal(DualPlanManifestSchema.safeParse({
            schema_version: 1, plan_revision: 1, tasks: [{ ...task, goal: undefined }],
        }).success, false);
        assert.equal(DualPlanManifestSchema.safeParse({
            schema_version: 1, plan_revision: 1, tasks: [{ ...task, allowed_files: ['../escape.js'] }],
        }).success, false);
        assert.equal(DualPlanManifestSchema.safeParse({
            schema_version: 1,
            plan_revision: 1,
            tasks: [{ ...task, validation_commands: [{ program: 'npm test', args: [], cwd: '.' }] }],
        }).success, false);
        const agyTask = {
            ...task,
            owner: 'agy',
            allowed_files: ['src/a.js'],
            validation_commands: [{ program: 'npm', args: ['test'], cwd: '.' }],
        };
        assert.equal(DualPlanManifestSchema.safeParse({
            schema_version: 1,
            plan_revision: 1,
            tasks: [agyTask, { ...agyTask, task_id: 'TASK-2', allowed_files: ['src/b.js'] }],
        }).success, false);
        assert.equal(DualPlanManifestSchema.safeParse({
            schema_version: 1,
            plan_revision: 1,
            tasks: [{ ...agyTask, allowed_files: Array.from({ length: 10 }, (_, index) => `src/${index}.js`) }],
        }).success, true);
        assert.equal(DualPlanManifestSchema.safeParse({
            schema_version: 1,
            plan_revision: 1,
            tasks: [{ ...agyTask, allowed_files: Array.from({ length: 11 }, (_, index) => `src/${index}.js`) }],
        }).success, false);
        assert.equal(DualPlanManifestSchema.safeParse({
            schema_version: 1,
            plan_revision: 1,
            tasks: [{ ...task, category: 'qa', title: 'Final QC' }],
        }).success, false);
    });

    it('enforces semantic setup action kinds', () => {
        assert.equal(SetupActionSchema.safeParse({
            kind: 'native', program: 'node', args: ['--version'], cwd: '.',
        }).success, true);
        assert.equal(SetupActionSchema.safeParse({
            kind: 'package-manager', program: 'npm', args: ['install'], cwd: '.',
        }).success, true);
        assert.equal(SetupActionSchema.safeParse({
            kind: 'package-manager', program: 'auto', args: ['install'], cwd: '.',
        }).success, true);

        assert.equal(SetupActionSchema.safeParse({
            kind: 'native', program: 'npm', args: ['install'], cwd: '.',
        }).success, false);
        assert.equal(SetupActionSchema.safeParse({
            kind: 'package-manager', program: 'node', args: ['install'], cwd: '.',
        }).success, false);
    });

    it('accepts the approved typed spec', () => {
        const spec = parseContract(SpecSchema, VALID_SPEC, 'spec');
        assert.equal(spec.allowed_files.length, 3);
        assert.equal(spec.validation_commands[0].program, 'npm');
    });

    it('rejects shell command strings at the contract boundary', () => {
        const result = SpecSchema.safeParse({
            ...VALID_SPEC,
            validation_commands: ['npm test'],
        });
        assert.equal(result.success, false);
    });

    it('rejects unsafe IDs and extra fields while allowing Codex-owned larger specs', () => {
        assert.equal(TaskIdSchema.safeParse('../escape').success, false);
        assert.equal(TaskIdSchema.safeParse('A'.repeat(65)).success, false);

        const larger = {
            ...VALID_SPEC,
            allowed_files: ['a.js', 'b.js', 'c.js', 'd.js'],
        };
        assert.equal(SpecSchema.safeParse(larger).success, true);
        assert.equal(SpecSchema.safeParse({ ...VALID_SPEC, surprise: true }).success, false);
    });

    it('requires transaction correlation on worker artifacts', () => {
        const context = {
            ...CORRELATION,
            summary: 'Relevant source identified.',
            relevant_files: [{ path: 'index.html', description: 'Landing page' }],
            exact_symbols: [{ name: 'main', file: 'index.html', verified: true, kind: 'element' }],
            validation_commands: ['npm test'],
            constraints: [],
            risks: [],
            open_questions: [],
            ...DEPTH_EVIDENCE,
        };
        assert.equal(ContextSchema.safeParse(context).success, true);
        assert.equal(ContextSchema.safeParse({ ...context, expected_base_commit: undefined }).success, false);
    });

    it('rejects shallow worker artifacts that omit mandatory depth evidence', () => {
        const shallowContext = {
            ...CORRELATION,
            summary: 'Relevant source identified.',
            relevant_files: [{ path: 'index.html', description: 'Landing page' }],
            exact_symbols: [{ name: 'main', file: 'index.html', verified: true }],
            validation_commands: ['npm test'],
            constraints: [],
            risks: [],
            open_questions: [],
        };
        assert.equal(ContextSchema.safeParse(shallowContext).success, false);
        assert.equal(ContextSchema.safeParse({
            ...shallowContext,
            ...DEPTH_EVIDENCE,
            research_trace: DEPTH_EVIDENCE.research_trace.slice(0, 1),
        }).success, false);

        const shallowEvidence = {
            ...CORRELATION,
            status: 'SUCCESS',
            modified_files: ['index.html'],
            command_outputs: [{ command: 'npm test', exit_code: 0, output: 'pass' }],
            unverified_items: [],
        };
        assert.equal(EvidenceSchema.safeParse(shallowEvidence).success, false);
        assert.equal(EvidenceSchema.safeParse({
            ...shallowEvidence,
            self_review: { checks: ['scope', 'tests'], remaining_risks: [] },
        }).success, false);

        const shallowReview = {
            ...CORRELATION,
            recommendation: 'APPROVE',
            risk_level: 'LOW',
            findings: [],
        };
        assert.equal(ReviewSchema.safeParse(shallowReview).success, false);
        assert.equal(ReviewSchema.safeParse({
            ...shallowReview,
            review_checks: ['spec', 'diff'],
            challenge_summary: 'The strongest concern was checked.',
        }).success, false);
    });

    it('emits strict draft-07 schemas and rejects invalid worker enums', () => {
        const jsonSchema = toDraft7Schema(EvidenceSchema, 'omni-dual-evidence-v1');
        assert.equal(jsonSchema.$schema, 'http://json-schema.org/draft-07/schema#');
        assert.equal(jsonSchema.$id, 'omni-dual-evidence-v1');
        assert.ok(Array.isArray(jsonSchema.anyOf), 'Git and snapshot correlations emit a root union');
        assert.equal(jsonSchema.anyOf.length, 2);
        assert.ok(
            jsonSchema.anyOf.every((branch) => branch.additionalProperties === false),
            'every correlation branch must reject undeclared properties',
        );

        const invalidEvidence = {
            ...CORRELATION,
            status: 'DONE',
            modified_files: [],
            command_outputs: [],
            unverified_items: [],
        };
        assert.equal(EvidenceSchema.safeParse(invalidEvidence).success, false);

        const invalidReview = {
            ...CORRELATION,
            recommendation: 'PASS',
            risk_level: 'LOW',
            findings: [],
        };
        assert.equal(ReviewSchema.safeParse(invalidReview).success, false);
    });

    it('keeps attempt metadata diagnostic and non-shell', () => {
        const result = AttemptMetaSchema.safeParse({
            ...CORRELATION,
            phase: 'scout',
            attempt: 1,
            package_version: '3.0.0',
            agy_version: '1.1.19',
            started_at: '2026-08-24T00:00:00.000Z',
            ended_at: '2026-08-24T00:00:01.000Z',
            duration_ms: 1000,
            exit_code: 0,
            timed_out: false,
            cwd: 'E:/repo',
            redacted_argv: ['agy', '--output-format', 'json'],
            shell: false,
            input_sha256: 'b'.repeat(64),
            schema_sha256: 'c'.repeat(64),
        });
        assert.equal(result.success, true);
        assert.equal(AttemptMetaSchema.safeParse({ ...result.data, shell: true }).success, false);
    });

    it('defines explicit Codex handoff events for terminal states', () => {
        const base = {
            ...CORRELATION,
            event_id: '00000000-0000-4000-8000-000000000001',
            sequence: 9,
            timestamp: '2026-08-24T00:00:01.000Z',
            type: 'handoff.completed',
            owner: 'codex',
        };
        assert.equal(EventSchema.safeParse({
            ...base,
            from_state: 'ROUTED',
            to_state: 'CODEX_OWNED',
            reason: 'codex_route',
        }).success, true);
        assert.equal(EventSchema.safeParse({
            ...base,
            from_state: 'REVIEW_VALID',
            to_state: 'CODEX_QC',
            reason: 'final_qc',
        }).success, true);
    });

    it('returns a stable contract error without echoing raw secret values', () => {
        assert.throws(
            () => parseContract(SpecSchema, { password: 'do-not-echo' }, 'spec'),
            (error) => {
                assert.equal(error.code, 'DUAL_CONTRACT_INVALID');
                assert.match(error.message, /spec/);
                assert.doesNotMatch(error.message, /do-not-echo/);
                return true;
            }
        );
    });

    const taskId = 'TASK-EV-1';
    const baseCommit = '1'.repeat(40);

    function makeValidSequence() {
        return [
            {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000001',
                sequence: 1,
                timestamp: '2026-08-25T00:00:00.000Z',
                type: 'transaction.created',
                state: 'NEW',
            },
            {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000002',
                sequence: 2,
                timestamp: '2026-08-25T00:00:01.000Z',
                type: 'phase.started',
                phase: 'preflight',
                attempt: 1,
            },
            {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000003',
                sequence: 3,
                timestamp: '2026-08-25T00:00:02.000Z',
                type: 'phase.completed',
                phase: 'preflight',
                attempt: 1,
                from_state: 'NEW',
                to_state: 'PREFLIGHT_SAFE',
                artifact_hashes: {},
                warnings: [],
            },
            {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000004',
                sequence: 4,
                timestamp: '2026-08-25T00:00:03.000Z',
                type: 'phase.started',
                phase: 'scout',
                attempt: 1,
            },
            {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000005',
                sequence: 5,
                timestamp: '2026-08-25T00:00:04.000Z',
                type: 'phase.completed',
                phase: 'scout',
                attempt: 1,
                from_state: 'PREFLIGHT_SAFE',
                to_state: 'SCOUT_VALID',
                artifact_hashes: { 'context.json': 'c'.repeat(64) },
                warnings: [],
            },
            {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000006',
                sequence: 6,
                timestamp: '2026-08-25T00:00:05.000Z',
                type: 'phase.started',
                phase: 'spec',
                attempt: 1,
            },
            {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000007',
                sequence: 7,
                timestamp: '2026-08-25T00:00:06.000Z',
                type: 'phase.completed',
                phase: 'spec',
                attempt: 1,
                from_state: 'SCOUT_VALID',
                to_state: 'SPEC_VALID',
                artifact_hashes: { 'spec.json': 'b'.repeat(64) },
                warnings: [],
            },
            {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000008',
                sequence: 8,
                timestamp: '2026-08-25T00:00:07.000Z',
                type: 'phase.started',
                phase: 'route',
                attempt: 1,
            },
            {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000009',
                sequence: 9,
                timestamp: '2026-08-25T00:00:08.000Z',
                type: 'phase.completed',
                phase: 'route',
                attempt: 1,
                from_state: 'SPEC_VALID',
                to_state: 'ROUTED',
                artifact_hashes: { 'route.json': 'c'.repeat(64) },
                warnings: [],
            },
            {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000010',
                sequence: 10,
                timestamp: '2026-08-25T00:00:09.000Z',
                type: 'phase.started',
                phase: 'implement',
                attempt: 1,
            },
            {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000011',
                sequence: 11,
                timestamp: '2026-08-25T00:00:10.000Z',
                type: 'phase.completed',
                phase: 'implement',
                attempt: 1,
                from_state: 'ROUTED',
                to_state: 'IMPLEMENT_VALID',
                artifact_hashes: { 'evidence.json': 'd'.repeat(64) },
                warnings: [],
            },
            {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000012',
                sequence: 12,
                timestamp: '2026-08-25T00:00:11.000Z',
                type: 'phase.started',
                phase: 'scope',
                attempt: 1,
            },
            {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000013',
                sequence: 13,
                timestamp: '2026-08-25T00:00:12.000Z',
                type: 'phase.completed',
                phase: 'scope',
                attempt: 1,
                from_state: 'IMPLEMENT_VALID',
                to_state: 'SCOPE_VALID',
                artifact_hashes: {},
                warnings: [],
            },
            {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000014',
                sequence: 14,
                timestamp: '2026-08-25T00:00:13.000Z',
                type: 'phase.started',
                phase: 'review',
                attempt: 1,
            },
            {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000015',
                sequence: 15,
                timestamp: '2026-08-25T00:00:14.000Z',
                type: 'phase.completed',
                phase: 'review',
                attempt: 1,
                from_state: 'SCOPE_VALID',
                to_state: 'REVIEW_VALID',
                artifact_hashes: { 'review.json': 'e'.repeat(64) },
                warnings: [],
            },
            {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000016',
                sequence: 16,
                timestamp: '2026-08-25T00:00:15.000Z',
                type: 'handoff.completed',
                owner: 'codex',
                from_state: 'REVIEW_VALID',
                to_state: 'CODEX_QC',
                reason: 'final_qc',
            },
        ];
    }

    describe('validateEventSequence', () => {
        it('validates a complete successful Gemini transaction', () => {
            const events = makeValidSequence();
            assert.doesNotThrow(() => validateEventSequence(events, taskId, baseCommit));
        });

        it('rejects mismatched taskId or expectedBaseCommit on any event', () => {
            const events = makeValidSequence();
            events[4].task_id = 'WRONG-TASK';
            assert.throws(
                () => validateEventSequence(events, taskId, baseCommit),
                /task_id mismatch/i
            );

            const events2 = makeValidSequence();
            events2[4].expected_base_commit = '2'.repeat(40);
            assert.throws(
                () => validateEventSequence(events2, taskId, baseCommit),
                /baseline mismatch/i
            );
        });

        it('rejects sequence gap, duplicates, non-contiguous sequence, or non-1 start', () => {
            const events = makeValidSequence();
            events[0].sequence = 2;
            assert.throws(
                () => validateEventSequence(events, taskId, baseCommit),
                /sequence/i
            );

            const events2 = makeValidSequence();
            events2[2].sequence = 2; // duplicate sequence
            assert.throws(
                () => validateEventSequence(events2, taskId, baseCommit),
                /sequence/i
            );
        });

        it('rejects missing preflight or wrong from_state/to_state transitions', () => {
            const events = makeValidSequence();
            // remove preflight (indices 1 and 2)
            events.splice(1, 2);
            // re-sequence
            events.forEach((ev, idx) => { ev.sequence = idx + 1; });
            assert.throws(
                () => validateEventSequence(events, taskId, baseCommit),
                /preflight|transition/i
            );

            const events2 = makeValidSequence();
            events2[2].to_state = 'SCOUT_VALID'; // wrong transition for preflight
            assert.throws(
                () => validateEventSequence(events2, taskId, baseCommit),
                /transition/i
            );
        });

        it('rejects phase.completed without phase.started or attempt mismatch', () => {
            const events = makeValidSequence();
            events[3] = { ...events[3], attempt: 2 }; // started attempt 2, completed attempt 1
            assert.throws(
                () => validateEventSequence(events, taskId, baseCommit),
                /matching phase.started|attempt/i
            );
        });

        it('rejects repeating a completed attempt or duplicate completion', () => {
            const events = makeValidSequence();
            // duplicate review completion
            const dup = { ...events[14], sequence: 16, event_id: '00000000-0000-4000-8000-000000000099' };
            events.splice(15, 0, dup);
            events[16].sequence = 17;
            assert.throws(
                () => validateEventSequence(events, taskId, baseCommit),
                /matching phase.started|already completed|duplicate/i
            );
        });

        it('accepts retried phase after phase.failed with incremented attempt', () => {
            const events = makeValidSequence();
            // In implement phase: attempt 1 starts, fails; attempt 2 starts, completes
            const impStart1 = events[9]; // seq 10
            const impFail1 = {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000090',
                sequence: 11,
                timestamp: '2026-08-25T00:00:09.500Z',
                type: 'phase.failed',
                phase: 'implement',
                attempt: 1,
                error_code: 'DUAL_PROCESS_EXIT_NONZERO',
                retryable: true,
            };
            const impStart2 = {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000091',
                sequence: 12,
                timestamp: '2026-08-25T00:00:09.800Z',
                type: 'phase.started',
                phase: 'implement',
                attempt: 2,
            };
            const impComp2 = {
                ...events[10],
                attempt: 2,
                sequence: 13,
            };

            const newEvents = [
                ...events.slice(0, 10), // 0..9 (through impStart1)
                impFail1,
                impStart2,
                impComp2,
                ...events.slice(11).map((ev, idx) => ({ ...ev, sequence: 14 + idx })),
            ];

            assert.doesNotThrow(() => validateEventSequence(newEvents, taskId, baseCommit));
        });

        it('rejects codex_route handoff and requires final_qc handoff', () => {
            const events = makeValidSequence();
            events[15] = {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000016',
                sequence: 16,
                timestamp: '2026-08-25T00:00:15.000Z',
                type: 'handoff.completed',
                owner: 'codex',
                from_state: 'ROUTED',
                to_state: 'CODEX_OWNED',
                reason: 'codex_route',
            };
            assert.throws(
                () => validateEventSequence(events, taskId, baseCommit),
                /handoff|final_qc/i
            );
        });

        it('rejects events occurring after terminal handoff', () => {
            const events = makeValidSequence();
            events.push({
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000099',
                sequence: 17,
                timestamp: '2026-08-25T00:00:16.000Z',
                type: 'phase.started',
                phase: 'review',
                attempt: 2,
            });
            assert.throws(
                () => validateEventSequence(events, taskId, baseCommit),
                /after (terminal )?handoff/i
            );
        });

        it('rejects initial attempt greater than 1', () => {
            const events = makeValidSequence();
            events[1].attempt = 2; // preflight started with attempt 2
            events[2].attempt = 2; // preflight completed with attempt 2
            assert.throws(
                () => validateEventSequence(events, taskId, baseCommit),
                /attempt.*1|first attempt/i
            );
        });

        it('rejects attempt reuse (same attempt) or attempt skip on retry', () => {
            const events = makeValidSequence();
            // Implement phase attempt 1 fails
            const impFail1 = {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000090',
                sequence: 11,
                timestamp: '2026-08-25T00:00:09.500Z',
                type: 'phase.failed',
                phase: 'implement',
                attempt: 1,
                error_code: 'DUAL_PROCESS_EXIT_NONZERO',
                retryable: true,
            };
            // Reused attempt 1 on retry
            const impStartReused = {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000091',
                sequence: 12,
                timestamp: '2026-08-25T00:00:09.800Z',
                type: 'phase.started',
                phase: 'implement',
                attempt: 1, // should be 2
            };
            const reusedEvents = [
                ...events.slice(0, 10),
                impFail1,
                impStartReused,
                { ...events[10], attempt: 1, sequence: 13 },
                ...events.slice(11).map((ev, idx) => ({ ...ev, sequence: 14 + idx })),
            ];
            assert.throws(
                () => validateEventSequence(reusedEvents, taskId, baseCommit),
                /expected attempt 2|attempt/i
            );

            // Skipped attempt 3 on retry
            const impStartSkipped = {
                ...impStartReused,
                attempt: 3, // should be 2
            };
            const skippedEvents = [
                ...events.slice(0, 10),
                impFail1,
                impStartSkipped,
                { ...events[10], attempt: 3, sequence: 13 },
                ...events.slice(11).map((ev, idx) => ({ ...ev, sequence: 14 + idx })),
            ];
            assert.throws(
                () => validateEventSequence(skippedEvents, taskId, baseCommit),
                /expected attempt 2|attempt/i
            );
        });

        it('rejects retrying after non-retryable failure', () => {
            const events = makeValidSequence();
            const impFailNonRetryable = {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000090',
                sequence: 11,
                timestamp: '2026-08-25T00:00:09.500Z',
                type: 'phase.failed',
                phase: 'implement',
                attempt: 1,
                error_code: 'DUAL_FATAL_ERROR',
                retryable: false,
            };
            const impStart2 = {
                schema_version: 1,
                task_id: taskId,
                expected_base_commit: baseCommit,
                event_id: '00000000-0000-4000-8000-000000000091',
                sequence: 12,
                timestamp: '2026-08-25T00:00:09.800Z',
                type: 'phase.started',
                phase: 'implement',
                attempt: 2,
            };
            const nonRetryableEvents = [
                ...events.slice(0, 10),
                impFailNonRetryable,
                impStart2,
                { ...events[10], attempt: 2, sequence: 13 },
                ...events.slice(11).map((ev, idx) => ({ ...ev, sequence: 14 + idx })),
            ];
            assert.throws(
                () => validateEventSequence(nonRetryableEvents, taskId, baseCommit),
                /non-retryable|cannot retry/i
            );
        });
    });

    describe('validatePhaseArtifactHashes', () => {
        const fs = require('node:fs');
        const os = require('node:os');
        const crypto = require('node:crypto');

        let tmpDir;
        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-art-hash-'));
        });
        afterEach(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('passes when disk artifact bytes match event artifact_hashes', () => {
            const { validatePhaseArtifactHashes } = require('../lib/dual/contracts');
            const events = makeValidSequence();

            // Write files on disk matching the sha256 in events
            for (const ev of events) {
                if (ev.type === 'phase.completed') {
                    for (const [filename, expectedSha] of Object.entries(ev.artifact_hashes || {})) {
                        // Find what content produces this sha, or update ev to match content
                        const content = Buffer.from(`content for ${filename}`);
                        const actualSha = crypto.createHash('sha256').update(content).digest('hex');
                        ev.artifact_hashes[filename] = actualSha;
                        fs.writeFileSync(path.join(tmpDir, filename), content);
                    }
                }
            }

            assert.doesNotThrow(() => validatePhaseArtifactHashes(tmpDir, events));
        });

        it('rejects tampered disk artifact bytes or extra/missing artifact hashes', () => {
            const { validatePhaseArtifactHashes } = require('../lib/dual/contracts');
            const events = makeValidSequence();

            for (const ev of events) {
                if (ev.type === 'phase.completed') {
                    for (const [filename, expectedSha] of Object.entries(ev.artifact_hashes || {})) {
                        const content = Buffer.from(`content for ${filename}`);
                        const actualSha = crypto.createHash('sha256').update(content).digest('hex');
                        ev.artifact_hashes[filename] = actualSha;
                        fs.writeFileSync(path.join(tmpDir, filename), content);
                    }
                }
            }

            // Tamper spec.json on disk
            fs.writeFileSync(path.join(tmpDir, 'spec.json'), 'tampered content');
            assert.throws(
                () => validatePhaseArtifactHashes(tmpDir, events),
                /hash mismatch/i
            );

            // Restore spec.json and tamper events with extra file
            const specSha = crypto.createHash('sha256').update(Buffer.from('content for spec.json')).digest('hex');
            fs.writeFileSync(path.join(tmpDir, 'spec.json'), Buffer.from('content for spec.json'));
            events[4].artifact_hashes['extra.json'] = 'a'.repeat(64);
            assert.throws(
                () => validatePhaseArtifactHashes(tmpDir, events),
                /mismatch|extra/i
            );
        });
    });

    describe('Snapshot typed baseline correlation', () => {
        const {
            normalizeBaselineCorrelation,
            emitBaselineCorrelation,
        } = require('../lib/dual/contracts');

        const SNAPSHOT_ID = 'b'.repeat(64);
        const SNAPSHOT_CORRELATION = {
            schema_version: 1,
            task_id: 'AI4T-SNAP-1',
            expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
        };

        it('accepts snapshot correlation across all artifact contracts', () => {
            const spec = {
                ...SNAPSHOT_CORRELATION,
                goal: 'Build snapshot feature',
                allowed_files: ['lib/index.js'],
                deny_patterns: ['**/.env*'],
                validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                risk_flags: [],
                permission_authority: 'dual-init-dangerous-auto-v1',
            };
            assert.equal(SpecSchema.safeParse(spec).success, true);

            const context = {
                ...SNAPSHOT_CORRELATION,
                ...DEPTH_EVIDENCE,
                summary: 'Context summary',
                relevant_files: [{ path: 'lib/index.js', description: 'Entry point' }],
                exact_symbols: [],
                validation_commands: ['node --version'],
                constraints: [],
                risks: [],
                open_questions: [],
            };
            assert.equal(ContextSchema.safeParse(context).success, true);

            const route = {
                ...SNAPSHOT_CORRELATION,
                owner: 'gemini',
                model: 'gemini-3.7-flash-high',
                effort: 'high',
                token_budget: 100000,
                allowed_files: ['lib/index.js'],
                reason: 'Bounded task',
            };
            assert.equal(RouteSchema.safeParse(route).success, true);

            const evidence = {
                ...SNAPSHOT_CORRELATION,
                status: 'SUCCESS',
                modified_files: ['lib/index.js'],
                command_outputs: [{ command: 'node --version', exit_code: 0, output: 'v20.0.0' }],
                unverified_items: [],
                self_review: {
                    checks: ['Re-read the changed source.', 'Compared the result with the spec.', 'Checked the validation output.'],
                    remaining_risks: [],
                },
            };
            assert.equal(EvidenceSchema.safeParse(evidence).success, true);

            const review = {
                ...SNAPSHOT_CORRELATION,
                recommendation: 'APPROVE',
                risk_level: 'LOW',
                findings: [],
                review_checks: ['Checked scope.', 'Checked validation evidence.', 'Challenged the implementation choice.'],
                challenge_summary: 'No stronger bounded alternative was found.',
            };
            assert.equal(ReviewSchema.safeParse(review).success, true);
        });

        it('rejects mixed, unknown, or missing baseline correlation', () => {
            const mixed = {
                schema_version: 1,
                task_id: 'AI4T-MIXED',
                expected_base_commit: 'a'.repeat(40),
                expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
                goal: 'Build mixed',
                allowed_files: ['lib/index.js'],
                deny_patterns: [],
                validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                risk_flags: [],
                permission_authority: 'dual-init-dangerous-auto-v1',
            };
            assert.equal(SpecSchema.safeParse(mixed).success, false);
            assert.throws(() => normalizeBaselineCorrelation(mixed), /Cannot specify both/i);

            const missing = {
                schema_version: 1,
                task_id: 'AI4T-MISSING',
                goal: 'Build missing',
                allowed_files: ['lib/index.js'],
                deny_patterns: [],
                validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                risk_flags: [],
                permission_authority: 'dual-init-dangerous-auto-v1',
            };
            assert.equal(SpecSchema.safeParse(missing).success, false);
            assert.throws(() => normalizeBaselineCorrelation(missing), /Missing expected_baseline/i);
        });

        it('normalizeBaselineCorrelation and emitBaselineCorrelation handle both Git and Snapshot correctly', () => {
            const gitNorm = normalizeBaselineCorrelation({ expected_base_commit: 'a'.repeat(40) });
            assert.deepEqual(gitNorm, { kind: 'git', id: 'a'.repeat(40) });
            assert.deepEqual(emitBaselineCorrelation(gitNorm), { expected_base_commit: 'a'.repeat(40) });

            const snapNorm = normalizeBaselineCorrelation({ expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID } });
            assert.deepEqual(snapNorm, { kind: 'snapshot', id: SNAPSHOT_ID });
            assert.deepEqual(emitBaselineCorrelation(snapNorm), { expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID } });
        });

        it('validates a complete snapshot event sequence', () => {
            const events = [
                {
                    schema_version: 1,
                    task_id: 'TASK-SNAP-SEQ',
                    expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
                    event_id: '11111111-1111-4111-8111-111111111111',
                    sequence: 1,
                    timestamp: new Date().toISOString(),
                    type: 'transaction.created',
                    state: 'NEW',
                },
                {
                    schema_version: 1,
                    task_id: 'TASK-SNAP-SEQ',
                    expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
                    event_id: '22222222-2222-4222-8222-222222222222',
                    sequence: 2,
                    timestamp: new Date().toISOString(),
                    type: 'phase.started',
                    phase: 'preflight',
                    attempt: 1,
                },
                {
                    schema_version: 1,
                    task_id: 'TASK-SNAP-SEQ',
                    expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
                    event_id: '33333333-3333-4333-8333-333333333333',
                    sequence: 3,
                    timestamp: new Date().toISOString(),
                    type: 'phase.completed',
                    phase: 'preflight',
                    attempt: 1,
                    from_state: 'NEW',
                    to_state: 'PREFLIGHT_SAFE',
                    artifact_hashes: {},
                    warnings: [],
                },
                {
                    schema_version: 1,
                    task_id: 'TASK-SNAP-SEQ',
                    expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
                    event_id: '44444444-4444-4444-8444-444444444444',
                    sequence: 4,
                    timestamp: new Date().toISOString(),
                    type: 'phase.started',
                    phase: 'scout',
                    attempt: 1,
                },
                {
                    schema_version: 1,
                    task_id: 'TASK-SNAP-SEQ',
                    expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
                    event_id: '55555555-5555-4555-8555-555555555555',
                    sequence: 5,
                    timestamp: new Date().toISOString(),
                    type: 'phase.completed',
                    phase: 'scout',
                    attempt: 1,
                    from_state: 'PREFLIGHT_SAFE',
                    to_state: 'SCOUT_VALID',
                    artifact_hashes: { 'context.json': 'c'.repeat(64) },
                    warnings: [],
                },
                {
                    schema_version: 1,
                    task_id: 'TASK-SNAP-SEQ',
                    expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
                    event_id: '66666666-6666-4666-8666-666666666666',
                    sequence: 6,
                    timestamp: new Date().toISOString(),
                    type: 'phase.started',
                    phase: 'spec',
                    attempt: 1,
                },
                {
                    schema_version: 1,
                    task_id: 'TASK-SNAP-SEQ',
                    expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
                    event_id: '77777777-7777-4777-8777-777777777777',
                    sequence: 7,
                    timestamp: new Date().toISOString(),
                    type: 'phase.completed',
                    phase: 'spec',
                    attempt: 1,
                    from_state: 'SCOUT_VALID',
                    to_state: 'SPEC_VALID',
                    artifact_hashes: { 'spec.json': 'd'.repeat(64) },
                    warnings: [],
                },
                {
                    schema_version: 1,
                    task_id: 'TASK-SNAP-SEQ',
                    expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
                    event_id: '88888888-8888-4888-8888-888888888888',
                    sequence: 8,
                    timestamp: new Date().toISOString(),
                    type: 'phase.started',
                    phase: 'route',
                    attempt: 1,
                },
                {
                    schema_version: 1,
                    task_id: 'TASK-SNAP-SEQ',
                    expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
                    event_id: '99999999-9999-4999-8999-999999999999',
                    sequence: 9,
                    timestamp: new Date().toISOString(),
                    type: 'phase.completed',
                    phase: 'route',
                    attempt: 1,
                    from_state: 'SPEC_VALID',
                    to_state: 'ROUTED',
                    artifact_hashes: { 'route.json': 'e'.repeat(64) },
                    warnings: [],
                },
                {
                    schema_version: 1,
                    task_id: 'TASK-SNAP-SEQ',
                    expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
                    event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    sequence: 10,
                    timestamp: new Date().toISOString(),
                    type: 'phase.started',
                    phase: 'implement',
                    attempt: 1,
                },
                {
                    schema_version: 1,
                    task_id: 'TASK-SNAP-SEQ',
                    expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
                    event_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                    sequence: 11,
                    timestamp: new Date().toISOString(),
                    type: 'phase.completed',
                    phase: 'implement',
                    attempt: 1,
                    from_state: 'ROUTED',
                    to_state: 'IMPLEMENT_VALID',
                    artifact_hashes: { 'evidence.json': 'f'.repeat(64) },
                    warnings: [],
                },
                {
                    schema_version: 1,
                    task_id: 'TASK-SNAP-SEQ',
                    expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
                    event_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                    sequence: 12,
                    timestamp: new Date().toISOString(),
                    type: 'phase.started',
                    phase: 'scope',
                    attempt: 1,
                },
                {
                    schema_version: 1,
                    task_id: 'TASK-SNAP-SEQ',
                    expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
                    event_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                    sequence: 13,
                    timestamp: new Date().toISOString(),
                    type: 'phase.completed',
                    phase: 'scope',
                    attempt: 1,
                    from_state: 'IMPLEMENT_VALID',
                    to_state: 'SCOPE_VALID',
                    artifact_hashes: {},
                    warnings: [],
                },
                {
                    schema_version: 1,
                    task_id: 'TASK-SNAP-SEQ',
                    expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
                    event_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                    sequence: 14,
                    timestamp: new Date().toISOString(),
                    type: 'phase.started',
                    phase: 'review',
                    attempt: 1,
                },
                {
                    schema_version: 1,
                    task_id: 'TASK-SNAP-SEQ',
                    expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
                    event_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                    sequence: 15,
                    timestamp: new Date().toISOString(),
                    type: 'phase.completed',
                    phase: 'review',
                    attempt: 1,
                    from_state: 'SCOPE_VALID',
                    to_state: 'REVIEW_VALID',
                    artifact_hashes: { 'review.json': '0'.repeat(64) },
                    warnings: [],
                },
                {
                    schema_version: 1,
                    task_id: 'TASK-SNAP-SEQ',
                    expected_baseline: { kind: 'snapshot', id: SNAPSHOT_ID },
                    event_id: '12345678-1234-4234-8234-123456789012',
                    sequence: 16,
                    timestamp: new Date().toISOString(),
                    type: 'handoff.completed',
                    owner: 'codex',
                    from_state: 'REVIEW_VALID',
                    to_state: 'CODEX_QC',
                    reason: 'final_qc',
                },
            ];

            assert.doesNotThrow(() => validateEventSequence(events, 'TASK-SNAP-SEQ', { kind: 'snapshot', id: SNAPSHOT_ID }));
        });
    });
});
