'use strict';

// The omni_dual MCP tool surface (lib/dual/mcp-server.mjs). The omni hook lets
// the orchestrator call these: each call is checked again by the daemon's own
// authority rules, and none of them approves a human gate (that needs a TTY).
// test/dual-mcp-server.test.js fails when this list and the server drift apart.

const OMNI_DUAL_TOOLS = Object.freeze([
    'omni_dual_begin',
    'omni_dual_register_plan',
    'omni_dual_status',
    'omni_dual_resume',
    'omni_dual_completion',
    'omni_dual_quality',
    'omni_dual_coverage_inspect',
    'omni_dual_coverage_approve',
    'omni_dual_reject_handoff',
    'omni_dual_acceptance_correction_start',
    'omni_dual_acceptance_review_prepare',
    'omni_dual_acceptance_review_submit',
    'omni_dual_acceptance_correction_complete',
    'omni_dual_session_block',
    'omni_dual_inbox',
]);

module.exports = { OMNI_DUAL_TOOLS };
