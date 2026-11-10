#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { parseArguments, runDaemon } = require('../bin/omni-daemon');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { setTestApprover } = require('../lib/dual/approval-gates');
const { loadDelegation, createDelegatedApprover } = require('./helpers/acceptance-delegation');

async function main(argv = process.argv.slice(2)) {
    if (argv[0] !== '--delegation' || argv[2] !== '--sha256') throw Object.assign(new Error('Missing benchmark delegation'), { code: 'ACCEPTANCE_DELEGATION_INVALID' });
    const daemonArgs = argv.slice(4), root = parseArguments(daemonArgs);
    if (!root) throw Object.assign(new Error('Invalid benchmark workspace'), { code: 'ACCEPTANCE_DELEGATION_INVALID' });
    const ref = { path: argv[1], sha256: argv[3] };
    const delegation = loadDelegation({ root, ...ref });
    const authorityStore = createAuthorityStore(path.join(root, '.omni/runs/dual-authority'));
    setTestApprover(createDelegatedApprover({ root, delegation, ref, authorityStore }));
    try { await runDaemon(daemonArgs); }
    finally { setTestApprover(null); }
}
if (require.main === module) main().catch(error => { process.stderr.write(`${error.code || 'ACCEPTANCE_DELEGATION_ERROR'}\n`); process.exitCode = 1; });
module.exports = { main };
