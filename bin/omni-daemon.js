#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { startDaemonServer, createDaemonDiscussionHost, discussionEnabledFromEnv } = require('../lib/dual/daemon-server');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { createOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');
const { resolveRegisteredAgyProjectId } = require('../lib/dual/agy-project');
const { createTrustedQualityRunner } = require('../lib/dual/quality-runner');
const { createTrustedUiAdapter } = require('../lib/dual/visual-qa');

function parseArguments(argv) {
    if (argv.length === 2 && argv[0] === '--workspace' && argv[1] && !argv[1].startsWith('--')) {
        return argv[1];
    }
    if (argv.length === 1 && argv[0].startsWith('--workspace=')) {
        const val = argv[0].slice('--workspace='.length);
        if (val.length > 0) {
            return val;
        }
    }
    return null;
}

function createDaemonServerOptions({ workspaceRoot, authorityStore, orchestrator }) {
    return {
        workspaceRoot,
        authorityStore,
        orchestrator,
        trustedQualityRunner: createTrustedQualityRunner(),
        trustedUiAdapter: createTrustedUiAdapter(),
    };
}

function createExecutableOrchestrator({ workspaceRoot, authorityStore, agyProjectId, env = process.env }) {
    const discussionHost = discussionEnabledFromEnv(env)
        ? createDaemonDiscussionHost({ authorityStore, workspaceRoot }) : null;
    const orchestrator = createOrchestratorAdapter({
        workspaceRoot,
        authorityStore,
        ...(agyProjectId ? { agyProjectId } : {}),
        ...(discussionHost ? { discussion: { enabled: true, sessionResolver: discussionHost.sessionResolver } } : {}),
    });
    return { orchestrator, discussionHost };
}

async function runDaemon(argv = process.argv.slice(2)) {
    const rawWorkspace = parseArguments(argv);
    if (!rawWorkspace) {
        process.stderr.write('omni-daemon: invalid or missing arguments\nUsage: omni-daemon --workspace <path>\n');
        process.exitCode = 1;
        return;
    }

    if (!fs.existsSync(rawWorkspace)) {
        process.stderr.write(`omni-daemon error: workspace directory does not exist: ${rawWorkspace}\n`);
        process.exitCode = 1;
        return;
    }

    let canonicalWorkspace;
    try {
        canonicalWorkspace = fs.realpathSync?.native
            ? fs.realpathSync.native(rawWorkspace)
            : fs.realpathSync(rawWorkspace);
    } catch (err) {
        process.stderr.write(`omni-daemon error: failed to resolve canonical workspace: ${err.message}\n`);
        process.exitCode = 1;
        return;
    }

    const authorityDir = path.join(canonicalWorkspace, '.omni', 'runs', 'dual-authority');
    const authorityStore = createAuthorityStore(authorityDir);
    const agyProjectId = resolveRegisteredAgyProjectId(canonicalWorkspace);
    const { orchestrator, discussionHost } = createExecutableOrchestrator({
        workspaceRoot: canonicalWorkspace,
        authorityStore,
        ...(agyProjectId ? { agyProjectId } : {}),
    });

    let daemon;
    try {
        daemon = await startDaemonServer(createDaemonServerOptions({
            workspaceRoot: canonicalWorkspace,
            authorityStore,
            orchestrator,
        }));
    } catch (err) {
        if (discussionHost) await discussionHost.closeAll();
        process.stderr.write(`omni-daemon fatal error [${err.code || 'ERR'}]: ${err.message}\n`);
        process.exitCode = 1;
        return;
    }

    let shutdownInProgress = null;
    function handleShutdown() {
        if (!shutdownInProgress) {
            shutdownInProgress = daemon.close().catch((err) => {
                process.stderr.write(`omni-daemon shutdown error: ${err.message}\n`);
            });
        }
        return shutdownInProgress;
    }

    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);

    try {
        await daemon.stopped;
    } finally {
        process.removeListener('SIGINT', handleShutdown);
        process.removeListener('SIGTERM', handleShutdown);
        if (discussionHost) await discussionHost.closeAll();
    }
}

if (require.main === module) {
    runDaemon().catch((err) => {
        process.stderr.write(`omni-daemon fatal error: ${err.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    createDaemonServerOptions,
    createExecutableOrchestrator,
    runDaemon,
    parseArguments,
};
