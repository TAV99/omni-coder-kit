'use strict';

// Found in a real project (DemoOm, 2026-11-11): omni starts its own CLI turns
// (discussion seeds/turns, reviewer QC, workers) with cwd inside the project.
// A trusted codex project (or any claude -p run) then loads the project's omni
// hooks for that nested turn, so the Stop hook blocked the turn ("session
// incomplete") and the seed exited 1, and UserPromptSubmit would ack the
// orchestrator's inbox. bin/omni-daemon.js sets this variable in the daemon,
// so every turn it spawns inherits it (spawn sites keep their exact env
// objects), and the omni hook steps aside for it; the gate guard still
// applies. The user's own hooks are untouched.
const NESTED_ENV = 'OMNI_HOOK_NESTED';

module.exports = { NESTED_ENV };
