'use strict';

const { DiscussionError, isPlainObject } = require('./contracts');

function createHostPorts(deps = {}) {
    function requireCallback(name, code) {
        if (!deps || typeof deps[name] !== 'function') {
            throw new DiscussionError(code, `Host callback '${name}' is required`);
        }
        return deps[name];
    }

    async function evidenceFrom(name, code, args) {
        const evidence = await requireCallback(name, code)(args);
        if (!isPlainObject(evidence)) {
            throw new DiscussionError(code, `Host callback '${name}' must return an evidence object`);
        }
        // The relay validates permission, identity, expiry and recovery proof.
        return evidence;
    }

    return {
        authority: {
            async check(args) {
                return (await requireCallback('checkAuthority', 'AUTHORITY_STALE')(args)) === true;
            },
        },
        capabilityVerifier: {
            async verify(args) {
                return evidenceFrom('verifyCapability', 'CAPABILITY_BLOCKED', args);
            },
            async verifyRecovery(args) {
                return evidenceFrom('verifyRecoveryEvidence', 'OUTCOME_UNKNOWN', args);
            },
        },
    };
}

module.exports = { createHostPorts };
