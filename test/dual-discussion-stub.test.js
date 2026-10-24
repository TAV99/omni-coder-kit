'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withDiscussion } = require('./helpers/dual-discussion-stub');

async function dispatch(t, options = {}, attempt) {
    const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-stub-'));
    t.after(() => fs.rmSync(workerRoot, { recursive: true, force: true }));
    const raw = path.join(workerRoot, '.omni/codex-gemini/runs/task/raw');
    fs.mkdirSync(raw, { recursive: true });
    fs.writeFileSync(path.join(raw, `scout.${attempt ?? 1}.input.md`), 'attempt input');
    const config = options.setup?.(workerRoot) ?? {};
    const { discussion } = withDiscussion({ ...options, ...config });
    const child = await discussion.createIsolatedDiscussion({ workerRoot,
        workerBaselineId: 'a'.repeat(64), sessionId: 'session', taskId: 'task',
        planRevision: 1, ...(attempt === undefined ? {} : { attempt }) });
    t.after(() => child.close());
    const { relay } = await child.sessionResolver({ workspaceRoot: workerRoot,
        taskId: 'task', snapshotSha256: 'a'.repeat(64) });
    await relay.receive({ message_id: 'request', body: '# Scout' });
    const result = await relay.dispatch('request');
    return JSON.parse((await relay.inspect()).messages.find(
        (message) => message.message_id === result.response_message_id).body);
}

for (const attempt of [undefined, 2]) {
    test(`turn reads input for attempt ${attempt ?? 'default 1'}`, async (t) => {
        const payload = await dispatch(t, { processRunner: async ({ args }) => {
            assert.match(args[0], new RegExp(`scout\\.${attempt ?? 1}\\.input\\.md`));
            assert.ok(args[0].endsWith('\nattempt input'));
            return { stdout: JSON.stringify({ structured_output: { ok: true } }) };
        } }, attempt);
        assert.deepEqual(payload, { ok: true });
    });
}

for (const expression of [
    "fs.statSync('fixture.txt').size",
    "(fs.rmSync('remove.txt'), fs.existsSync('remove.txt'))",
    "fs.readFileSync(absolute, 'utf8')",
    "fs.readFileSync(require('node:buffer').Buffer.from(absolute), 'utf8')",
    "fs.readFileSync(require('node:url').pathToFileURL(absolute), 'utf8')",
    "(() => { const fd = fs.openSync('fixture.txt', 'r'); try { return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); } })()",
    "await fs.promises.readFile('fixture.txt', 'utf8')",
    "await new Promise((resolve, reject) => fs.readFile('fixture.txt', 'utf8', (err, value) => err ? reject(err) : resolve(value)))",
]) {
    test(`script scopes ${expression} to worker cwd`, async (t) => {
        const payload = await dispatch(t, { setup(workerRoot) {
            fs.writeFileSync(path.join(workerRoot, 'fixture.txt'), 'worker content');
            fs.writeFileSync(path.join(workerRoot, 'remove.txt'), 'remove me');
            const script = path.join(workerRoot, 'fixture.cjs');
            fs.writeFileSync(script, `const fs = require('node:fs');
                const absolute = ${JSON.stringify(path.join(workerRoot, 'fixture.txt'))};
                (async () => {
                    try { process.stdout.write(JSON.stringify({ structured_output: { value: ${expression} } })); }
                    catch (error) { process.stdout.write(JSON.stringify({ structured_output: { error: error.message } })); }
                })();`);
            return { agyPrefixArgs: [script] };
        } });
        assert.deepEqual(payload, { value: expression.includes('statSync') ? 14 : expression.includes('rmSync') ? false : 'worker content' });
    });
}
