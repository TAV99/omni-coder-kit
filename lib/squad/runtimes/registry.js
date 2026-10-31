'use strict';

// Runtime registry (SPEC-SQUAD-P1 §7): one place that knows which agent CLIs
// exist, which capabilities they declare, and whether they are ready here.

const { SquadRuntimeError, CAPABILITY_KEYS, defineRuntime, probeContext } = require('./contract');
const { resolveBinary } = require('./resolve-binary');

function problem(code, message, fix) {
    return { code, message, fix };
}

async function probeRuntime(runtime, rawCtx) {
    const ctx = probeContext(rawCtx);
    const detect = typeof runtime.detect === 'function'
        ? await runtime.detect(ctx)
        : resolveBinary(runtime.binary, ctx);
    const report = {
        id: runtime.id,
        displayName: runtime.displayName,
        capabilities: { ...runtime.capabilities },
        detect,
        version: null,
        auth: null,
        models: null,
        ready: false,
        problems: [],
    };
    if (!detect.found) {
        report.problems.push(problem(detect.code, detect.reason, detect.code === 'SQUAD_RUNTIME_WINDOWS_SHIM'
            ? `đặt ${runtime.binary.envOverride} trỏ tới file .exe hoặc .js của ${runtime.binary.name}`
            : `cài ${runtime.displayName} hoặc đặt ${runtime.binary.envOverride}`));
        return report;
    }
    const probeCtx = { ...ctx, resolved: detect };
    report.version = await runtime.version(probeCtx);
    if (!report.version.ok) report.problems.push(problem(report.version.code, report.version.reason, null));
    report.auth = await runtime.authStatus(probeCtx);
    if (report.auth.state !== 'authenticated') {
        report.problems.push(problem(report.auth.state === 'unauthenticated'
            ? 'SQUAD_RUNTIME_UNAUTHENTICATED' : 'SQUAD_RUNTIME_AUTH_UNKNOWN', report.auth.evidence, report.auth.fix || null));
    }
    report.models = await runtime.listModels(probeCtx);
    if (!report.models.ok) report.problems.push(problem(report.models.code, report.models.reason, null));
    report.ready = report.version.ok && report.auth.state === 'authenticated' && report.models.ok;
    return report;
}

function createRegistry({ runtimes = [] } = {}) {
    const byId = new Map();

    function register(descriptor) {
        const runtime = defineRuntime(descriptor);
        if (byId.has(runtime.id)) {
            throw new SquadRuntimeError('SQUAD_RUNTIME_DUPLICATE', `Runtime ${runtime.id} is already registered`);
        }
        byId.set(runtime.id, runtime);
        return runtime;
    }

    function get(id) {
        const runtime = byId.get(id);
        if (!runtime) throw new SquadRuntimeError('SQUAD_RUNTIME_UNKNOWN', `Unknown runtime: ${id}`);
        return runtime;
    }

    function eligibleFor(requirements = []) {
        for (const key of requirements) {
            if (!CAPABILITY_KEYS.includes(key)) {
                throw new SquadRuntimeError('SQUAD_RUNTIME_UNKNOWN', `Unknown capability: ${key}`);
            }
        }
        return [...byId.values()].filter((r) => requirements.every((key) => r.capabilities[key])).map((r) => r.id);
    }

    runtimes.forEach(register);

    return {
        register,
        get,
        list: () => [...byId.values()],
        eligibleFor,
        probe: (id, ctx) => probeRuntime(get(id), ctx),
        // Parallel across runtimes, sequential within one; each gets its own probe cache.
        probeAll: (ctx = {}) => Promise.all([...byId.values()].map((r) => probeRuntime(r, { ...ctx, cache: new Map() }))),
    };
}

module.exports = { createRegistry, probeRuntime };
