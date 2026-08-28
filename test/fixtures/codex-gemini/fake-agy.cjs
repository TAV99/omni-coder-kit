'use strict';

const payload = {
    schema_version: 1,
    task_id: 'bootstrap-task',
    expected_base_commit: 'a'.repeat(40),
    summary: 'Phân tích hoàn tất',
    relevant_files: [{ path: 'lib/dual/agy-runner.js', description: 'Agy process transport' }],
    exact_symbols: [{
        name: 'runProcess',
        file: 'lib/dual/agy-runner.js',
        verified: true,
        kind: 'function',
    }],
    validation_commands: ['node --test test/dual-agy-runner.test.js'],
    constraints: ['Không dùng shell'],
    risks: [],
    open_questions: [],
    research_trace: [
        { question: 'Where is transport implemented?', source: 'lib/dual/agy-runner.js', source_type: 'REPOSITORY', conclusion: 'runProcess owns transport.' },
        { question: 'How is transport verified?', source: 'test/dual-agy-runner.test.js', source_type: 'TEST_OUTPUT', conclusion: 'Runner tests cover argv and failures.' },
    ],
    alternatives_considered: [
        { option: 'Keep current transport', tradeoff: 'Smallest change.' },
        { option: 'Replace transport', tradeoff: 'Higher risk and unnecessary.' },
    ],
    failure_modes: ['Worker process may time out.'],
};

const behavior = process.env.FAKE_AGY_BEHAVIOR || 'success';

if (behavior === 'timeout') {
    setTimeout(() => process.exit(0), 10_000);
} else if (behavior === 'empty') {
    process.exit(0);
} else if (behavior === 'malformed') {
    process.stdout.write('not-json {{{\n');
} else if (behavior === 'nonzero') {
    process.stderr.write('worker crashed\n');
    process.exitCode = 2;
} else if (behavior === 'permission_denied') {
    process.stderr.write('permission denied\n');
    process.exitCode = 13;
} else if (behavior === 'nonzero_valid') {
    process.stdout.write(`${JSON.stringify({ status: 'success', structured_output: payload })}\n`);
    process.exitCode = 7;
} else if (behavior === 'outer_error_valid') {
    process.stdout.write(`${JSON.stringify({ status: 'error', structured_output: payload })}\n`);
} else if (behavior === 'response_json') {
    process.stdout.write(`${JSON.stringify({ type: 'result', response: JSON.stringify(payload) })}\n`);
} else if (behavior === 'fenced_json') {
    process.stdout.write(`${JSON.stringify({ type: 'result', response: `Result:\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` })}\n`);
} else {
    process.stderr.write('cảnh báo Unicode\n');
    process.stdout.write(`${JSON.stringify({ status: 'success', structured_output: payload })}\n`);
}
