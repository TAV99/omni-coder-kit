'use strict';

const contracts = require('./contracts');
const workspace = require('./workspace');
const scopeGuard = require('./scope-guard');
const stateStore = require('./state-store');
const artifacts = require('./artifacts');
const agyRunner = require('./agy-runner');
const agyOutput = require('./agy-output');
const orchestrator = require('./orchestrator');
const authorityStore = require('./authority-store');
const baseline = require('./baseline');
const baselineGit = require('./baseline-git');
const baselineSnapshot = require('./baseline-snapshot');
const snapshotStore = require('./snapshot-store');
const daemonLock = require('./daemon-lock');
const daemonServer = require('./daemon-server');
const daemonClient = require('./daemon-client');
const setupRunner = require('./setup-runner');
const setupCommand = require('./setup-command');
const hookBridge = require('./hook-bridge');
const qualityLedger = require('./quality-ledger');
const uiGate = require('./ui-gate');
const capabilityPreflight = require('./capability-preflight');
const orchestratorAdapter = require('./orchestrator-adapter');

module.exports = {
    ...contracts,
    ...workspace,
    ...scopeGuard,
    ...stateStore,
    ...artifacts,
    ...agyRunner,
    ...agyOutput,
    ...orchestrator,
    ...orchestratorAdapter,
    ...authorityStore,
    ...baseline,
    ...baselineGit,
    ...baselineSnapshot,
    ...snapshotStore,
    ...daemonLock,
    ...daemonServer,
    ...daemonClient,
    ...setupRunner,
    ...setupCommand,
    ...hookBridge,
    ...qualityLedger,
    ...uiGate,
    ...capabilityPreflight,
};
