const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-commands-test-'));
}

/** Swap console.log and capture output lines; returns { lines, restore }. */
function captureConsole() {
    const lines = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args) => lines.push(args.join(' '));
    console.error = (...args) => lines.push(args.join(' '));
    return {
        lines,
        restore() { console.log = origLog; console.error = origErr; },
    };
}

/** Swap only console.error; returns { lines, restore }. */
function captureStderr() {
    const lines = [];
    const origErr = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    return {
        lines,
        restore() { console.error = origErr; },
    };
}

// ─── 1. lib/commands/status.js ──────────────────────────────────────────────

describe('handleStatus', () => {
    it('runs without error when no manifest exists', () => {
        const tmpDir = makeTmpDir();
        const origCwd = process.cwd();
        try {
            process.chdir(tmpDir);
            const { handleStatus } = require('../lib/commands/status');
            const cap = captureConsole();
            try {
                assert.doesNotThrow(() => handleStatus());
                assert.ok(cap.lines.length > 0, 'should print something');
            } finally {
                cap.restore();
            }
        } finally {
            process.chdir(origCwd);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('prints skill count when manifest has skills', () => {
        const tmpDir = makeTmpDir();
        const origCwd = process.cwd();
        try {
            // Write a manifest with one skill
            const omniDir = path.join(tmpDir, '.omni');
            fs.mkdirSync(omniDir, { recursive: true });
            const manifest = {
                version: '1.0.0',
                configFile: 'CLAUDE.md',
                ide: 'claudecode',
                skills: {
                    external: [
                        { name: 'test-skill', source: 'skills.sh', installedAt: '2025-01-01T00:00:00Z' },
                    ],
                },
            };
            fs.writeFileSync(path.join(omniDir, 'manifest.json'), JSON.stringify(manifest));

            process.chdir(tmpDir);
            // Re-require to pick up new cwd
            delete require.cache[require.resolve('../lib/commands/status')];
            delete require.cache[require.resolve('../lib/commands/helpers')];
            const { handleStatus } = require('../lib/commands/status');
            const cap = captureConsole();
            try {
                handleStatus();
                const output = cap.lines.join('\n');
                assert.ok(output.includes('test-skill'), 'should list the installed skill');
                assert.ok(output.includes('1'), 'should show total count');
            } finally {
                cap.restore();
            }
        } finally {
            process.chdir(origCwd);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('handleCommands', () => {
    it('prints output containing all 9 >om: commands', () => {
        const { handleCommands } = require('../lib/commands/status');
        const cap = captureConsole();
        try {
            handleCommands();
            const output = cap.lines.join('\n');
            const expected = [
                '>om:brainstorm', '>om:equip', '>om:plan', '>om:cook',
                '>om:check', '>om:fix', '>om:doc', '>om:learn', '>om:map',
            ];
            for (const cmd of expected) {
                assert.ok(output.includes(cmd), `output should contain ${cmd}`);
            }
        } finally {
            cap.restore();
        }
    });

    it('prints the recommended workflow order', () => {
        const { handleCommands } = require('../lib/commands/status');
        const cap = captureConsole();
        try {
            handleCommands();
            const output = cap.lines.join('\n');
            assert.ok(output.includes('brainstorm'), 'should mention brainstorm in workflow');
            assert.ok(output.includes('doc'), 'should mention doc in workflow');
        } finally {
            cap.restore();
        }
    });

    it('prints slash equivalents for Claude Code', () => {
        const { handleCommands } = require('../lib/commands/status');
        const cap = captureConsole();
        try {
            handleCommands();
            const output = cap.lines.join('\n');
            assert.ok(output.includes('/om:brainstorm'), 'should contain /om:brainstorm');
            assert.ok(output.includes('/om:cook'), 'should contain /om:cook');
        } finally {
            cap.restore();
        }
    });
});

// ─── 2. lib/commands/map.js ─────────────────────────────────────────────────

describe('handleMap', () => {
    it('prints error to stderr when project is not detected', () => {
        const tmpDir = makeTmpDir();
        const origCwd = process.cwd();
        try {
            process.chdir(tmpDir);
            delete require.cache[require.resolve('../lib/commands/map')];
            delete require.cache[require.resolve('../lib/commands/helpers')];
            const { handleMap } = require('../lib/commands/map');
            const cap = captureStderr();
            try {
                handleMap({});
                const output = cap.lines.join('\n');
                assert.ok(output.includes('package.json') || output.includes('project') || output.includes('phát hiện'),
                    'should warn about missing project indicators');
            } finally {
                cap.restore();
            }
        } finally {
            process.chdir(origCwd);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('with {refresh: true} errors when no existing map file', () => {
        const tmpDir = makeTmpDir();
        const origCwd = process.cwd();
        try {
            process.chdir(tmpDir);
            delete require.cache[require.resolve('../lib/commands/map')];
            delete require.cache[require.resolve('../lib/commands/helpers')];
            const { handleMap } = require('../lib/commands/map');
            const cap = captureStderr();
            try {
                handleMap({ refresh: true });
                const output = cap.lines.join('\n');
                assert.ok(output.includes('project-map.md') || output.includes('omni map'),
                    'should mention project-map.md or omni map');
            } finally {
                cap.restore();
            }
        } finally {
            process.chdir(origCwd);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('generates skeleton for a real project (this repo)', () => {
        const projectDir = path.join(__dirname, '..');
        const origCwd = process.cwd();
        try {
            process.chdir(projectDir);
            delete require.cache[require.resolve('../lib/commands/map')];
            delete require.cache[require.resolve('../lib/commands/helpers')];
            const { handleMap } = require('../lib/commands/map');
            const cap = captureConsole();
            try {
                handleMap({});
                const output = cap.lines.join('\n');
                assert.ok(output.includes('Project Map') || output.includes('project-map'),
                    'should mention project map in output');
                const mapPath = path.join(projectDir, '.omni', 'knowledge', 'project-map.md');
                assert.ok(fs.existsSync(mapPath), 'should create project-map.md');
            } finally {
                cap.restore();
            }
        } finally {
            process.chdir(origCwd);
        }
    });
});

// ─── 3. lib/commands/update.js ──────────────────────────────────────────────

describe('handleUpdate', () => {
    it('exports handleUpdate as a function', () => {
        const { handleUpdate } = require('../lib/commands/update');
        assert.equal(typeof handleUpdate, 'function');
    });

    it('module loads without error', () => {
        assert.doesNotThrow(() => {
            delete require.cache[require.resolve('../lib/commands/update')];
            require('../lib/commands/update');
        });
    });
});

// ─── 4. lib/commands/customize.js ───────────────────────────────────────────

describe('handleCustomize', () => {
    it('copies a valid workflow to .omni/workflows/', () => {
        const tmpDir = makeTmpDir();
        const origCwd = process.cwd();
        try {
            process.chdir(tmpDir);
            delete require.cache[require.resolve('../lib/commands/customize')];
            delete require.cache[require.resolve('../lib/commands/helpers')];
            const { handleCustomize } = require('../lib/commands/customize');
            const cap = captureConsole();
            try {
                handleCustomize('task-planning');
                const customPath = path.join(tmpDir, '.omni', 'workflows', 'task-planning.md');
                assert.ok(fs.existsSync(customPath), 'should create custom workflow file');
                const content = fs.readFileSync(customPath, 'utf-8');
                assert.ok(content.length > 0, 'file should have content');
            } finally {
                cap.restore();
            }
        } finally {
            process.chdir(origCwd);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('accepts workflow name with .md extension', () => {
        const tmpDir = makeTmpDir();
        const origCwd = process.cwd();
        try {
            process.chdir(tmpDir);
            delete require.cache[require.resolve('../lib/commands/customize')];
            delete require.cache[require.resolve('../lib/commands/helpers')];
            const { handleCustomize } = require('../lib/commands/customize');
            const cap = captureConsole();
            try {
                handleCustomize('qa-testing.md');
                const customPath = path.join(tmpDir, '.omni', 'workflows', 'qa-testing.md');
                assert.ok(fs.existsSync(customPath), 'should create qa-testing.md');
            } finally {
                cap.restore();
            }
        } finally {
            process.chdir(origCwd);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('prints error to stderr for non-existent workflow', () => {
        const tmpDir = makeTmpDir();
        const origCwd = process.cwd();
        try {
            process.chdir(tmpDir);
            delete require.cache[require.resolve('../lib/commands/customize')];
            delete require.cache[require.resolve('../lib/commands/helpers')];
            const { handleCustomize } = require('../lib/commands/customize');
            const cap = captureStderr();
            try {
                handleCustomize('nonexistent-workflow');
                const output = cap.lines.join('\n');
                assert.ok(output.includes('nonexistent-workflow'), 'should mention the bad name');
                assert.ok(output.includes('task-planning') || output.includes('Có sẵn'),
                    'should list available workflows');
            } finally {
                cap.restore();
            }
        } finally {
            process.chdir(origCwd);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('skips when workflow is already customized', () => {
        const tmpDir = makeTmpDir();
        const origCwd = process.cwd();
        try {
            // Pre-create the custom workflow
            const customDir = path.join(tmpDir, '.omni', 'workflows');
            fs.mkdirSync(customDir, { recursive: true });
            fs.writeFileSync(path.join(customDir, 'task-planning.md'), '# already customized');

            process.chdir(tmpDir);
            delete require.cache[require.resolve('../lib/commands/customize')];
            delete require.cache[require.resolve('../lib/commands/helpers')];
            const { handleCustomize } = require('../lib/commands/customize');
            const cap = captureStderr();
            try {
                handleCustomize('task-planning');
                const output = cap.lines.join('\n');
                assert.ok(output.includes('tồn tại') || output.includes('bỏ qua'),
                    'should indicate file already exists / skip');
                // Verify original content is untouched
                const content = fs.readFileSync(path.join(customDir, 'task-planning.md'), 'utf-8');
                assert.equal(content, '# already customized');
            } finally {
                cap.restore();
            }
        } finally {
            process.chdir(origCwd);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('copies content identical to package template', () => {
        const tmpDir = makeTmpDir();
        const origCwd = process.cwd();
        try {
            process.chdir(tmpDir);
            delete require.cache[require.resolve('../lib/commands/customize')];
            delete require.cache[require.resolve('../lib/commands/helpers')];
            const { handleCustomize } = require('../lib/commands/customize');
            const cap = captureConsole();
            try {
                handleCustomize('coder-execution');
                const customPath = path.join(tmpDir, '.omni', 'workflows', 'coder-execution.md');
                const pkgPath = path.join(__dirname, '..', 'templates', 'workflows', 'coder-execution.md');
                assert.equal(
                    fs.readFileSync(customPath, 'utf-8'),
                    fs.readFileSync(pkgPath, 'utf-8'),
                    'custom copy should match package template'
                );
            } finally {
                cap.restore();
            }
        } finally {
            process.chdir(origCwd);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ─── 5. lib/commands/index.js (barrel export) ───────────────────────────────

describe('commands barrel export', () => {
    it('exports all expected command handlers', () => {
        const commands = require('../lib/commands/index');
        const expected = [
            'handleStatus', 'handleCommands',
            'handleMap',
            'handleUpdate',
            'handleCustomize',
            'handleInit',
            'handleEquip',
            'handleRules',
        ];
        for (const name of expected) {
            assert.equal(typeof commands[name], 'function', `should export ${name} as a function`);
        }
    });

    it('exports helper utilities', () => {
        const commands = require('../lib/commands/index');
        assert.equal(typeof commands.loadManifest, 'function');
        assert.equal(typeof commands.saveManifest, 'function');
        assert.equal(typeof commands.findConfigFile, 'function');
        assert.equal(typeof commands.writeFileSafe, 'function');
    });

    it('exports MANIFEST_FILE constant', () => {
        const commands = require('../lib/commands/index');
        assert.ok(typeof commands.MANIFEST_FILE === 'string');
        assert.ok(commands.MANIFEST_FILE.includes('manifest.json'));
    });
});
