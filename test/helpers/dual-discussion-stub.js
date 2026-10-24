'use strict';

const fs = require('node:fs');
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
                    execution: { attempt: context.attempt, workspace_binding_sha256: context.reference.bindingSha256 } });
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
    return { enabled: true, createIsolatedDiscussion, executions, counters };
}

module.exports = { createDiscussionStub };
