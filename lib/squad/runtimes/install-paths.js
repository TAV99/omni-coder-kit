'use strict';

// Per-user install directories shared by the squad adapters and the legacy
// dual resolver (lib/dual/binary-paths.js), so both look in the same places.

const path = require('node:path');

// pathApi: adapters build POSIX candidates explicitly; the legacy resolver keeps
// the host's own path.join so its output is unchanged on every platform.
function userBinCandidates(name, homedir, pathApi = path.posix) {
    return [
        pathApi.join(homedir, '.local', 'bin', name),
        pathApi.join(homedir, 'bin', name),
    ];
}

module.exports = { userBinCandidates };
