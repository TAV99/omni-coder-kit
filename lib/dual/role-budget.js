'use strict';

// Role budgets (SPEC-SQUAD-P5 §5) from .omni/squad/roles/<id>.yaml `budget`:
// turn_minutes caps one headless turn; max_turns caps a role per task (worker:
// attempts, reviewer: reviews). Projects without squad roles keep the old limits.

const fs = require('node:fs');
const path = require('node:path');
const { loadRoles } = require('../squad/roles');

function roleBudget(workspaceRoot, roleId, { fsImpl = fs } = {}) {
    const rolesDir = path.join(workspaceRoot, '.omni', 'squad', 'roles');
    if (!fsImpl.existsSync(rolesDir)) return {};
    let budget;
    try { budget = loadRoles(rolesDir, { fsImpl })[roleId]?.budget || {}; } catch { return {}; }
    return { ...(budget.turn_minutes ? { turnMs: budget.turn_minutes * 60_000 } : {}),
        ...(budget.max_turns ? { maxTurns: budget.max_turns } : {}) };
}

module.exports = { roleBudget };
