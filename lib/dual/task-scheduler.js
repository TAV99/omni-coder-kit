'use strict';

function orderedTasks(tasks) {
    const byId = new Map(tasks.map((task) => [task.task_id, task]));
    const order = [], visiting = new Set(), visited = new Set();
    function visit(id) {
        if (!byId.has(id) || visiting.has(id)) {
            const error = new Error('Task dependencies contain an unknown task or cycle');
            error.code = 'DUAL_PLAN_INVALID';
            throw error;
        }
        if (visited.has(id)) return;
        visiting.add(id);
        const dependencies = byId.get(id).depends_on || [];
        if (!Array.isArray(dependencies) || new Set(dependencies).size !== dependencies.length) {
            const error = new Error('Task dependencies must be a unique array');
            error.code = 'DUAL_PLAN_INVALID';
            throw error;
        }
        for (const dependency of dependencies) visit(dependency);
        visiting.delete(id);
        visited.add(id);
        order.push(id);
    }
    for (const task of tasks) visit(task.task_id);
    return order;
}

function overlaps(left, right) {
    const a = left.replace(/\\/g, '/').toLowerCase();
    const b = right.replace(/\\/g, '/').toLowerCase();
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function taskReadiness(derived, taskId) {
    const task = derived.tasks[taskId];
    if (!task) { const error = new Error('Task is not registered'); error.code = 'DUAL_TASK_NOT_FOUND'; throw error; }
    const order = orderedTasks(Object.values(derived.tasks));
    const waitingFor = (task.depends_on || []).filter((id) => derived.tasks[id]?.state !== 'TASK_VERIFIED');
    if (waitingFor.length) return { status: 'WAITING_FOR_DEPENDENCY', waitingFor };
    const writers = task.allowed_files || [];
    const reads = task.context_files || [];
    const prior = order.slice(0, order.indexOf(taskId)).filter((id) => {
        const other = derived.tasks[id];
        if (other.state === 'TASK_VERIFIED') return false;
        return (other.allowed_files || []).some((file) => [...writers, ...reads].some((candidate) => overlaps(file, candidate)))
            || (other.context_files || []).some((file) => writers.some((candidate) => overlaps(file, candidate)));
    });
    return prior.length ? { status: 'WAITING_FOR_SCOPE', waitingFor: prior } : { status: 'READY' };
}

module.exports = { orderedTasks, taskReadiness };
