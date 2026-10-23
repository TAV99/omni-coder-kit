'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DualPlanManifestSchema } = require('../lib/dual/contracts');

test('typed full graph workflow examples satisfy the current schema', () => {
    let planCount = 0;
    for (const filename of ['dual-controller.md', 'task-planning.md']) {
        const text = fs.readFileSync(path.join(__dirname, '../templates/workflows', filename), 'utf8');
        const plans = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
            .map(match => JSON.parse(match[1]))
            .filter(value => Array.isArray(value.tasks));
        planCount += plans.length;
        for (const [index, plan] of plans.entries()) {
            const graph = `${filename} graph ${index + 1}`;
            const taskIds = new Set(plan.tasks.map(task => task.task_id));
            for (const check of plan.acceptance_policy?.checks || []) {
                if (check.phase === 'pre_integration') {
                    assert.ok(taskIds.has(check.task_id), `${graph}: Unknown task_id: ${check.task_id}`);
                }
            }
            const result = DualPlanManifestSchema.safeParse(plan);
            assert.equal(result.success, true, `${graph}: ${JSON.stringify(result.error?.issues)}`);
        }
    }
    assert.ok(planCount > 0, 'workflow templates must contain a typed graph example');
});

test('controller guidance declares acceptance_policy mandatory', () => {
    const text = fs.readFileSync(path.join(__dirname, '../templates/workflows/dual-controller.md'), 'utf8');
    assert.match(text, /Plans must declare a strict `acceptance_policy`/);
    assert.doesNotMatch(text, /Plans may declare a strict `acceptance_policy`/);
});
