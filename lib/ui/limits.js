'use strict';

// Provider Limit Observations Service for Omni UI Workspace (T14)
//
// Implements:
// - createLimitsService({ providers, clock })
// - read(runtime, accountKey) / refresh(runtime, accountKey)
// - Coalescing with minimum 60s interval
// - Stale observation detection (>120s)
// - Sanitization: no raw secrets or tokens in output
// - Zero fabrication of synthetic percentages

const claudeProvider = require('./limit-providers/claude');
const codexProvider = require('./limit-providers/codex');
const agyProvider = require('./limit-providers/agy');

const DEFAULT_PROVIDERS = {
    claude: claudeProvider,
    codex: codexProvider,
    agy: agyProvider,
};

const MIN_REFRESH_INTERVAL_MS = 60000; // 60s
const STALE_THRESHOLD_MS = 120000; // 120s

function sanitizeAccountKey(raw) {
    if (!raw) return 'default';
    // Remove potential email or secret patterns, retain safe identifier
    return String(raw).replace(/[@:/\\]/g, '-').slice(0, 32);
}

function createLimitsService({
    providers = DEFAULT_PROVIDERS,
    clock = { now: () => Date.now(), iso: () => new Date().toISOString() },
    minIntervalMs = MIN_REFRESH_INTERVAL_MS,
    staleThresholdMs = STALE_THRESHOLD_MS,
} = {}) {
    const cache = new Map(); // `${runtime}:${accountKey}` -> { observation, lastFetchedAt }

    function makeKey(runtime, accountKey) {
        return `${runtime}:${sanitizeAccountKey(accountKey)}`;
    }

    function checkStale(observation) {
        if (!observation || !observation.observedAt) return true;
        const age = clock.now() - new Date(observation.observedAt).getTime();
        return age > staleThresholdMs;
    }

    async function refresh(runtime, rawAccountKey = 'default') {
        const accountKey = sanitizeAccountKey(rawAccountKey);
        const cacheKey = makeKey(runtime, accountKey);
        const now = clock.now();

        // 1. Check refresh coalescing
        const cached = cache.get(cacheKey);
        if (cached && (now - cached.lastFetchedAt < minIntervalMs)) {
            const obs = { ...cached.observation };
            obs.stale = checkStale(obs);
            return obs;
        }

        // 2. Resolve provider
        const provider = providers[runtime];
        let observation;

        if (!provider || typeof provider.readLimits !== 'function') {
            observation = {
                runtime,
                accountKey,
                source: 'unknown',
                status: 'unsupported',
                observedAt: clock.iso(),
                stale: false,
                windows: [],
                errorCode: 'PROVIDER_UNSUPPORTED',
                explanation: `Không có limit provider cho runtime "${runtime}"`,
            };
        } else {
            try {
                const rawObs = await provider.readLimits({
                    runtime,
                    accountKey,
                    clock,
                });

                // Sanitize and validate exact shape
                observation = {
                    runtime,
                    accountKey,
                    source: rawObs.source || 'provider-cli',
                    status: ['available', 'unavailable', 'unsupported', 'error'].includes(rawObs.status)
                        ? rawObs.status
                        : 'unavailable',
                    observedAt: rawObs.observedAt || clock.iso(),
                    stale: false,
                    windows: Array.isArray(rawObs.windows) ? rawObs.windows.map(w => ({
                        id: w.id || 'default',
                        label: w.label || w.id || 'Default Window',
                        unit: ['percent', 'requests', 'tokens'].includes(w.unit) ? w.unit : 'requests',
                        used: typeof w.used === 'number' ? w.used : null,
                        remaining: typeof w.remaining === 'number' ? w.remaining : null,
                        limit: typeof w.limit === 'number' ? w.limit : null,
                        resetsAt: w.resetsAt || null,
                    })) : [],
                    errorCode: rawObs.errorCode || null,
                    explanation: rawObs.explanation || null,
                };
            } catch (err) {
                observation = {
                    runtime,
                    accountKey,
                    source: 'provider-cli',
                    status: 'error',
                    observedAt: clock.iso(),
                    stale: false,
                    windows: [],
                    errorCode: 'PROVIDER_READ_FAILED',
                    explanation: err.message,
                };
            }
        }

        observation.stale = checkStale(observation);
        cache.set(cacheKey, { observation, lastFetchedAt: now });
        return observation;
    }

    async function read(runtime, rawAccountKey = 'default') {
        const accountKey = sanitizeAccountKey(rawAccountKey);
        const cacheKey = makeKey(runtime, accountKey);
        const cached = cache.get(cacheKey);

        if (cached) {
            const obs = { ...cached.observation };
            obs.stale = checkStale(obs);
            return obs;
        }

        return refresh(runtime, accountKey);
    }

    async function listAll(contextId = null) {
        // Collect observations for standard runtimes
        const runtimes = Object.keys(providers);
        const results = [];
        for (const r of runtimes) {
            results.push(await read(r, 'default'));
        }
        return results;
    }

    return {
        read,
        refresh,
        listAll,
    };
}

module.exports = {
    createLimitsService,
    DEFAULT_PROVIDERS,
    MIN_REFRESH_INTERVAL_MS,
    STALE_THRESHOLD_MS,
};
