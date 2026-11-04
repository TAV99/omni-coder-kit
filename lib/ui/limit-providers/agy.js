'use strict';

// Antigravity (AGY) CLI Limit Provider (T14)
//
// Reads local AGY rate limits if exposed by CLI, or reports unavailable.

module.exports = {
    id: 'agy',
    async readLimits({ accountKey, clock } = {}) {
        const nowIso = clock?.iso ? clock.iso() : new Date().toISOString();

        return {
            runtime: 'agy',
            accountKey: accountKey || 'default',
            source: 'agy-cli-auth',
            status: 'unavailable',
            observedAt: nowIso,
            stale: false,
            windows: [
                {
                    id: 'gemini-rpm',
                    label: 'RPM Rate Limit',
                    unit: 'requests',
                    used: null,
                    remaining: null,
                    limit: null,
                    resetsAt: null,
                },
            ],
            errorCode: 'QUOTA_UNAVAILABLE',
            explanation: 'Chưa có dữ liệu quota từ CLI Antigravity.',
        };
    },
};
