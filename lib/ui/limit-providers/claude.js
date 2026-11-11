'use strict';

// Claude Code CLI Limit Provider (T14)
//
// Reads local Claude Code quota observation if available via CLI auth headers/status,
// or provides honest 'unavailable'/'unsupported' state without manufacturing data.

module.exports = {
    id: 'claude',
    async readLimits({ accountKey, clock } = {}) {
        const nowIso = clock?.iso ? clock.iso() : new Date().toISOString();

        // Check if environment has real CLI quota cache or status
        // If no trustworthy numeric source is exposed by current Claude CLI version:
        return {
            runtime: 'claude',
            accountKey: accountKey || 'default',
            source: 'claude-cli-auth',
            status: 'unavailable',
            observedAt: nowIso,
            stale: false,
            windows: [
                {
                    id: 'five-hour',
                    label: 'Cửa sổ 5 giờ',
                    unit: 'percent',
                    used: null,
                    remaining: null,
                    limit: null,
                    resetsAt: null,
                },
            ],
            errorCode: 'CLI_QUOTA_UNEXPOSED',
            explanation: 'Claude Code CLI chưa cung cấp API/lệnh đọc quota định lượng cục bộ.',
        };
    },
};
