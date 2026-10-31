'use strict';

// Per-role skill mounts (SPEC-SQUAD-P2 §6.3). A mounted skill is a copy from
// the store plus a marker naming its role. omni only ever replaces or removes
// directories carrying its own marker for the same role; anything else in the
// skill dir is the user's and is reported, never touched.

const fs = require('node:fs');
const path = require('node:path');
const { MOUNT_MARKER, hashDir, isSkillDir, readMarker, copyDir } = require('./skill-store');

function writeMarker(dir, { role, skill, sha256, now }, fsImpl) {
    fsImpl.writeFileSync(path.join(dir, MOUNT_MARKER),
        `${JSON.stringify({ schema_version: 1, role, skill, sha256, mounted_at: now.toISOString() }, null, 2)}\n`);
}

// Inspects <root>/<skillDir> against the desired bundle without changing anything.
function inspectMount({ store, root, skillDir, skills, roleId, fsImpl = fs }) {
    const base = path.join(root, skillDir);
    const wanted = new Set(skills);
    const report = { ok: [], drift: [], absent: [], extra: [], unmanaged: [], foreign: [], missing: [], adoptable: [] };
    const present = fsImpl.existsSync(base) ? fsImpl.readdirSync(base).sort() : [];
    for (const name of present) {
        const dir = path.join(base, name);
        if (!isSkillDir(dir, fsImpl)) continue;
        const marker = readMarker(dir, fsImpl);
        if (!marker) {
            // Same bytes as the store copy → can be adopted instead of blocking the mount.
            const adoptable = wanted.has(name) && store.has(name) && hashDir(dir, fsImpl) === store.hashOf(name);
            (adoptable ? report.adoptable : report.unmanaged).push(name);
        } else if (marker.role !== roleId) report.foreign.push(name);
        else if (!wanted.has(name)) report.extra.push(name);
        else if (!store.has(name)) report.missing.push(name);
        else if (marker.sha256 !== store.hashOf(name) || hashDir(dir, fsImpl) !== marker.sha256) report.drift.push(name);
        else report.ok.push(name);
    }
    const seen = new Set(present);
    for (const name of skills) {
        if (seen.has(name)) continue;
        (store.has(name) ? report.absent : report.missing).push(name);
    }
    return report;
}

function removeMarkedDir(base, name, roleId, fsImpl) {
    const dir = path.join(base, name);
    const marker = readMarker(dir, fsImpl);
    if (!marker || marker.role !== roleId || fsImpl.lstatSync(dir).isSymbolicLink()) return false;
    fsImpl.rmSync(dir, { recursive: true, force: true });
    return true;
}

// Makes <root>/<skillDir> hold exactly the role's bundle (for omni-managed dirs).
function mountBundle({ store, root, skillDir, skills, roleId, now = new Date(), fsImpl = fs }) {
    const base = path.join(root, skillDir);
    const report = inspectMount({ store, root, skillDir, skills, roleId, fsImpl });
    const done = { mounted: [], updated: [], adopted: [], removed: [], unchanged: report.ok,
        unmanaged: report.unmanaged, foreign: report.foreign, missing: report.missing };
    fsImpl.mkdirSync(base, { recursive: true });
    const place = (name) => {
        const dir = path.join(base, name);
        copyDir(store.pathOf(name), dir, fsImpl);
        writeMarker(dir, { role: roleId, skill: name, sha256: store.hashOf(name), now }, fsImpl);
    };
    for (const name of report.extra) if (removeMarkedDir(base, name, roleId, fsImpl)) done.removed.push(name);
    for (const name of report.drift) {
        if (removeMarkedDir(base, name, roleId, fsImpl)) { place(name); done.updated.push(name); }
    }
    for (const name of report.absent) { place(name); done.mounted.push(name); }
    for (const name of report.adoptable) {
        writeMarker(path.join(base, name), { role: roleId, skill: name, sha256: store.hashOf(name), now }, fsImpl);
        done.adopted.push(name);
    }
    return done;
}

// Moves unmanaged skill dirs that are not in `keep` out of the way, into
// <store>/.displaced/<stamp>/ — never deleted, so the user can restore them.
function displaceUnmanaged({ store, root, skillDir, keep, now = new Date(), fsImpl = fs }) {
    const base = path.join(root, skillDir);
    if (!fsImpl.existsSync(base)) return { moved: [], to: null };
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const to = path.join(store.dir, '.displaced', stamp);
    const moved = [];
    for (const name of fsImpl.readdirSync(base).sort()) {
        const dir = path.join(base, name);
        if (keep.has(name) || !isSkillDir(dir, fsImpl) || readMarker(dir, fsImpl)) continue;
        fsImpl.mkdirSync(to, { recursive: true });
        fsImpl.renameSync(dir, path.join(to, name));
        moved.push(name);
    }
    return { moved, to: moved.length ? to : null };
}

module.exports = { inspectMount, mountBundle, displaceUnmanaged };
