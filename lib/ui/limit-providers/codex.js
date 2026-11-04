'use strict';

// OpenAI Codex CLI Limit Provider (T14)
//
// Does not scrape desktop app secrets or invent synthetic percentages.
// Returns honest status: unsupported or unavailable when no CLI command exists.

module.exports = {
    id: 'codex',
    async readLimits({ accountKey, clock } = {}) {
        const nowIso = clock?.iso ? clock.iso() : new Date().toISOString();

        return {
            runtime: 'codex',
            accountKey: accountKey || 'default',
            source: 'codex-cli',
            status: 'unsupported',
            observedAt: nowIso,
            stale: false,
            windows: [
                {
                    id: 'rpm',
                    label: 'Requests / phút',
                    unit: 'requests',
                    used: null,
                    remaining: null,
                    limit: null,
                    resetsAt: null,
                },
            ],
            errorCode: 'QUOTA_SOURCE_UNSUPPORTED',
            explanation: 'Codex CLI không xuất số dư quota qua terminal cục bộ.',
        };
    },
};
