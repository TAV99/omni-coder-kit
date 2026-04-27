const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { scanProject, generateMapSkeleton, refreshMap } = require(path.join(__dirname, '..', 'lib', 'scanner'));

describe('refreshMap', () => {
    function setupProject(tmp, extraSetup) {
        fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
            name: 'test-app', dependencies: { express: '^4.18.0' }
        }));
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'app.js'), '// main app\n');
        if (extraSetup) extraSetup(tmp);
    }

    it('marks new directories as [NEW]', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-refresh-'));
        try {
            setupProject(tmp);
            const scan = scanProject(tmp);
            let md = generateMapSkeleton(scan, 'test-app');
            md = md.replace('[PENDING]', '→ Main application code');
            fs.mkdirSync(path.join(tmp, '.omni', 'knowledge'), { recursive: true });
            fs.writeFileSync(path.join(tmp, '.omni', 'knowledge', 'project-map.md'), md);

            fs.mkdirSync(path.join(tmp, 'lib'));
            fs.writeFileSync(path.join(tmp, 'lib', 'utils.js'), '');

            const result = refreshMap(tmp);
            assert.ok(result.includes('[NEW]'));
            assert.ok(result.includes('lib/'));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('marks deleted directories as [DELETED]', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-refresh-'));
        try {
            setupProject(tmp);
            fs.mkdirSync(path.join(tmp, 'utils'));
            fs.writeFileSync(path.join(tmp, 'utils', 'helpers.js'), '');
            const scan = scanProject(tmp);
            const md = generateMapSkeleton(scan, 'test-app');
            fs.mkdirSync(path.join(tmp, '.omni', 'knowledge'), { recursive: true });
            fs.writeFileSync(path.join(tmp, '.omni', 'knowledge', 'project-map.md'), md);

            fs.rmSync(path.join(tmp, 'utils'), { recursive: true, force: true });

            const result = refreshMap(tmp);
            assert.ok(result.includes('[DELETED]'));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('preserves AI-written descriptions', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-refresh-'));
        try {
            setupProject(tmp);
            const scan = scanProject(tmp);
            let md = generateMapSkeleton(scan, 'test-app');
            md = md.replace(/\[PENDING\]/, '→ Express REST API server');
            md = md.replace('## Key Patterns\n[PENDING — AI fills this when running >om:map]',
                '## Key Patterns\n- Auth: JWT with refresh tokens\n- Error: Global handler');
            fs.mkdirSync(path.join(tmp, '.omni', 'knowledge'), { recursive: true });
            fs.writeFileSync(path.join(tmp, '.omni', 'knowledge', 'project-map.md'), md);

            const result = refreshMap(tmp);
            assert.ok(result.includes('Express REST API server'));
            assert.ok(result.includes('Auth: JWT with refresh tokens'));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('updates header timestamp', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-refresh-'));
        try {
            setupProject(tmp);
            const scan = scanProject(tmp);
            let md = generateMapSkeleton(scan, 'test-app');
            md = md.replace(/Last refresh: \S+/, 'Last refresh: 2020-01-01');
            fs.mkdirSync(path.join(tmp, '.omni', 'knowledge'), { recursive: true });
            fs.writeFileSync(path.join(tmp, '.omni', 'knowledge', 'project-map.md'), md);

            const result = refreshMap(tmp);
            const today = new Date().toISOString().split('T')[0];
            assert.ok(result.includes(`Last refresh: ${today}`));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('returns null if project-map.md does not exist', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-refresh-'));
        try {
            const result = refreshMap(tmp);
            assert.equal(result, null);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
