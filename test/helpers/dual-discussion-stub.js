'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomUUID, createHash } = require('node:crypto');
const { buildBindings } = require('../../lib/dual/discussion/session');

// An execution-aware transport fixture. Real host/ledger tests remain responsible
// for proving authority; hooks here inject model faults at the transport boundary.
function createDiscussionStub(options = {}) {
    const executions = [], counters = { seeds: [], turns: [], closes: [], resolves: [] };
    const hook = async (name, context) => options[name]?.(context);
    async function createIsolatedDiscussion(context) {
        const executionId = context.operationId ?? randomUUID();
        const record = { ...context, executionId, closed: false, messages: [], bindings: null };
        executions.push(record);
        let pending, closePromise;
        const check = async () => {
            if (record.closed) throw Object.assign(new Error('Discussion child closed'), { code: 'DISCUSSION_CLOSED' });
            await context.guards?.check?.();
        };
        const seed = async (provider) => {
            await hook('beforeSeed', { ...record, provider });
            await context.prespawnGuard?.({ cwd: context.workerRoot, kind: 'seed', provider });
            counters.seeds.push({ executionId, taskId: context.taskId, provider });
            await hook('afterSeed', { ...record, provider });
            return { conversationId: `${provider}-${executionId}` };
        };
        const ensure = async () => {
            if (!pending) pending = (async () => {
                const wrap = context.guards?.wrapSeed ?? ((fn) => fn);
                const codex = await wrap(() => seed('codex'))();
                const agy = await wrap(() => seed('agy'))();
                const snapshotSha256 = createHash('sha256').update(JSON.stringify([
                    context.workerRoot, context.workerBaselineId, executionId,
                ])).digest('hex');
                record.bindings = buildBindings({ sessionId: context.sessionId, taskId: context.taskId,
                    planRevision: context.planRevision, snapshotSha256,
                    codexConversationId: codex.conversationId, agyConversationId: agy.conversationId,
                    ...(context.reference ? { execution: { attempt: context.attempt, workspace_binding_sha256: context.reference.bindingSha256 } } : {}) });
                return record.bindings;
            })();
            return pending;
        };
        const relay = {
            async inspect() { return { messages: record.messages, unknown: options.unknown ?? null }; },
            async receive(message) { record.messages.push(message); },
            async dispatch(messageId) {
                const message = record.messages.find((item) => item.message_id === messageId);
                const phase = message.body.includes('# Review') ? 'review' : 'scout';
                const turn = { ...record, phase, message, messageId };
                await hook('beforeTurn', turn);
                await context.prespawnGuard?.({ cwd: context.workerRoot, kind: 'turn', phase });
                counters.turns.push({ executionId, taskId: context.taskId, phase });
                let payload = await options.turn?.(turn);
                if (options.transform) payload = await options.transform(payload, turn);
                await hook('afterTurn', { ...turn, payload });
                if (options.internalNudge) {
                    await hook('beforeNudge', turn);
                    await context.prespawnGuard?.({ cwd: context.workerRoot, kind: 'nudge', phase });
                    counters.turns.push({ executionId, taskId: context.taskId, phase, kind: 'nudge' });
                }
                const responseMessageId = randomUUID();
                record.messages.push({ message_id: responseMessageId, body: JSON.stringify(payload) });
                return { response_message_id: responseMessageId, invocation_id: randomUUID() };
            },
            async reconcile(...args) { await hook('reconcile', { ...record, args }); return { reconciled: true, reconciled_outcome: 'failed' }; },
        };
        return { enabled: true, executionId,
            async sessionResolver(args) {
                await check();
                if (!args.workspaceRoot || fs.realpathSync.native(args.workspaceRoot) !== fs.realpathSync.native(context.workerRoot)
                    || args.taskId !== context.taskId || args.snapshotSha256 !== context.workerBaselineId) {
                    throw Object.assign(new Error('Discussion scope mismatch'), { code: 'DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID' });
                }
                counters.resolves.push({ executionId, ...args });
                const bindings = await ensure();
                await check();
                return { enabled: true, bindings, relay };
            },
            close() {
                if (!closePromise) closePromise = (async () => {
                    record.closed = true;
                    if (pending) await pending.catch(() => {});
                    await hook('close', record);
                    counters.closes.push(executionId);
                })();
                return closePromise;
            },
        };
    }
    const shared = new Map();
    return { enabled: true, createIsolatedDiscussion, executions, counters,
        async sessionResolver(args) {
            const derived = options.authorityStore.derive();
            const key = JSON.stringify([derived.sessionId, derived.planRevision, args.taskId, args.snapshotSha256]);
            if (!shared.has(key)) shared.set(key, await createIsolatedDiscussion({
                workerRoot: args.workspaceRoot, workerBaselineId: args.snapshotSha256,
                sessionId: derived.sessionId, taskId: args.taskId, planRevision: derived.planRevision,
            }));
            return shared.get(key).sessionResolver(args);
        },
    };
}

// Execute existing fake CLI payload generators in memory at the relay boundary.
// Relative fixture file access is scoped to the worker; no provider process runs.
async function scriptPayload(script, invocation) {
    return new Promise((resolve, reject) => {
        let stdout = '';
        const exited = Symbol('fixture exit');
        const scopeFs = (target) => new Proxy(target, { get(object, name) {
            const value = Reflect.get(object, name);
            if (name === 'promises') return scopeFs(value);
            if (typeof value !== 'function') return value;
            return (file, ...args) => Reflect.apply(value, object, [
                typeof file === 'string' && !path.isAbsolute(file)
                    ? path.join(invocation.cwd, file) : file, ...args,
            ]);
        } });
        const localFs = scopeFs(fs);
        const finish = () => {
            try { resolve(JSON.parse(stdout).structured_output); } catch (error) { reject(error); }
        };
        const fixtureRequire = createRequire(script);
        const run = (fn) => {
            try { fn(); } catch (error) { if (error !== exited) reject(error); }
        };
        run(() => new vm.Script(fs.readFileSync(script, 'utf8'), { filename: script }).runInNewContext({
            require: (name) => ['fs', 'node:fs'].includes(name) ? localFs : fixtureRequire(name),
            process: { argv: [process.execPath, script, ...invocation.args], version: process.version,
                stdout: { write(value) { stdout += value; finish(); } },
                exit(code) { if (code) reject(new Error(`Fixture exited ${code}`)); throw exited; } },
            setTimeout: (fn, delay) => setTimeout(() => run(fn), delay),
        }));
    });
}

function withDiscussion(options) {
    const { processRunner, agyPrefixArgs = [] } = options;
    const discussion = options.discussion ?? createDiscussionStub({
        authorityStore: options.authorityStore,
        async turn({ workerRoot, phase, taskId, attempt = 1, env, spawnImpl }) {
            const input = `.omni/codex-gemini/runs/${taskId}/raw/${phase}.${attempt}.input.md`;
            const prompt = `Execute the ${phase} phase. Read ${input}`;
            const invocation = { cwd: workerRoot, transport: 'discussion',
                args: [`-p=${prompt}${agyPrefixArgs[0] ? '' : `\n${fs.readFileSync(path.join(workerRoot, input), 'utf8')}`}`] };
            if (agyPrefixArgs[0]) return scriptPayload(agyPrefixArgs[0], invocation);
            const result = await processRunner(invocation, { env, spawn: spawnImpl });
            return JSON.parse(result.stdout).structured_output;
        },
    });
    // Script-based fixtures also keep their implement invocation on runProcess.
    const { runProcess } = require('../../lib/dual/agy-runner');
    return { ...options, discussion, processRunner: (invocation, deps) => {
        assert.ok(invocation.args.some((arg) => arg.includes('implement phase')),
            'Only implement may call processRunner; scout/review must use discussion');
        return (processRunner ?? runProcess)(invocation, deps);
    } };
}

module.exports = { createDiscussionStub, withDiscussion };
