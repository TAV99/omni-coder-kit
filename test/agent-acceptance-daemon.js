#!/usr/bin/env node
'use strict';

// P7f daemon entry: the production daemon plus the plan-bound integrate-gate
// delegation (test/helpers/agent-delegation.js). Production lib/ is unchanged.
const path = require('node:path');
const { parseArguments, runDaemon } = require('../bin/omni-daemon');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { setTestApprover } = require('../lib/dual/approval-gates');
const { loadAgentDelegation, createPlanBoundApprover } = require('./helpers/agent-delegation');

async function main(argv = process.argv.slice(2)) {
    if (argv[0] !== '--agent-delegation' || argv[2] !== '--sha256') throw Object.assign(new Error('Missing agent delegation'), { code: 'AGENT_DELEGATION_INVALID' });
    const daemonArgs = argv.slice(4), root = parseArguments(daemonArgs);
    if (!root) throw Object.assign(new Error('Invalid agent workspace'), { code: 'AGENT_DELEGATION_INVALID' });
    const ref = { path: argv[1], sha256: argv[3] };
    const delegation = loadAgentDelegation({ root, ...ref });
    const authorityStore = createAuthorityStore(path.join(root, '.omni/runs/dual-authority'));
    setTestApprover(createPlanBoundApprover({ root, delegation, ref, authorityStore }));
    try { await runDaemon(daemonArgs); }
    finally { setTestApprover(null); }
}
if (require.main === module) main().catch((error) => { process.stderr.write(`${error.code || 'AGENT_DELEGATION_ERROR'}\n`); process.exitCode = 1; });
module.exports = { main };
