'use strict';

// ---------------------------------------------------------------------------
// Task accounting (HARNESS-SPEC-PHASE-1 §2.1). Pure: reads .omni/sdlc/todo.md.
//
// Drives the COOK ⇄ CHECK cadence — the loop checkpoints every ceil(total/3)
// completed tasks (the "3 quality cycles" from superpower-sdlc.md, now in code).
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const TODO_REL = path.join('.omni', 'sdlc', 'todo.md');

// Count checkbox tasks in todo.md. A blocked task stays unchecked but is also
// tagged [BLOCKED] so it can be excluded from "actionable remaining" work.
function parseTodo(projectDir) {
    const file = path.join(projectDir || process.cwd(), TODO_REL);
    if (!fs.existsSync(file)) {
        return { total: 0, completed: 0, blocked: 0, remaining: 0 };
    }
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    let completed = 0;
    let todo = 0;
    let blocked = 0;
    for (const line of lines) {
        if (/^\s*[-*]\s+\[x\]/i.test(line)) {
            completed++;
        } else if (/^\s*[-*]\s+\[ \]/.test(line)) {
            todo++;
            if (/\[BLOCKED\]/i.test(line)) blocked++;
        }
    }
    const total = completed + todo;
    return { total, completed, blocked, remaining: total - completed };
}

// The first actionable (unchecked, not-[BLOCKED]) task + its 1-based position
// and the total count — drives the "task k/n <desc>" heartbeat line (OBS-1).
// desc strips the checkbox and any [TAG] markers. Pure read of todo.md.
function nextTask(projectDir) {
    const file = path.join(projectDir || process.cwd(), TODO_REL);
    if (!fs.existsSync(file)) return { idx: 0, total: 0, desc: '' };
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    let completed = 0;
    let total = 0;
    let foundIdx = 0;
    let desc = '';
    for (const line of lines) {
        if (/^\s*[-*]\s+\[x\]/i.test(line)) {
            completed++; total++;
        } else if (/^\s*[-*]\s+\[ \]/.test(line)) {
            total++;
            if (!foundIdx && !/\[BLOCKED\]/i.test(line)) {
                foundIdx = completed + 1; // 1-based position among all tasks
                desc = line
                    .replace(/^\s*[-*]\s+\[ \]\s*/, '')
                    .replace(/\[[^\]]*\]/g, '')
                    .trim();
            }
        }
    }
    return { idx: foundIdx || (completed + 1), total, desc };
}

// 3 quality cycles → checkpoint after every ceil(total/3) completed tasks.
function computeCheckpoint(total) {
    return Math.max(1, Math.ceil((total || 0) / 3));
}

// Mark the first actionable (unchecked, not-yet-blocked) task as [BLOCKED] when
// fix attempts are exhausted. Returns the task text marked, or null if none.
function markBlockedTask(projectDir) {
    const file = path.join(projectDir || process.cwd(), TODO_REL);
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*[-*]\s+\[ \]/.test(lines[i]) && !/\[BLOCKED\]/i.test(lines[i])) {
            lines[i] = lines[i].replace(/(\[ \]\s*)/, '$1[BLOCKED] ');
            fs.writeFileSync(file, lines.join('\n'), 'utf-8');
            return lines[i].trim();
        }
    }
    return null;
}

module.exports = { parseTodo, nextTask, computeCheckpoint, markBlockedTask, TODO_REL };
