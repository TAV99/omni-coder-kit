'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Force-import helpers and bundled logic
const { installOfflineSkills, updateGlobalCache } = require('../lib/commands/bundled');
const { loadManifest, saveManifest, MANIFEST_FILE } = require('../lib/commands/helpers');
const { getSkillDir } = require('../lib/helpers');
const { scanInstalledSkills } = require('../lib/commands/doctor');

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-bundled-test-'));
}

describe('3-Layer Offline Fallback & Caching', () => {
    let tmpDir;
    let cacheDir;
    let bundledDir;
    let origCwd;
    let origEnvCache;
    let origEnvBundled;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        cacheDir = path.join(tmpDir, 'skills-cache');
        bundledDir = path.join(tmpDir, 'bundled-skills');
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.mkdirSync(bundledDir, { recursive: true });

        // Save original environment
        origCwd = process.cwd();
        origEnvCache = process.env.OMNI_CACHE_DIR;
        origEnvBundled = process.env.OMNI_BUNDLED_DIR;

        // Set test paths
        process.chdir(tmpDir);
        process.env.OMNI_CACHE_DIR = cacheDir;
        process.env.OMNI_BUNDLED_DIR = bundledDir;
    });

    afterEach(() => {
        process.chdir(origCwd);
        if (origEnvCache) process.env.OMNI_CACHE_DIR = origEnvCache;
        else delete process.env.OMNI_CACHE_DIR;
        if (origEnvBundled) process.env.OMNI_BUNDLED_DIR = origEnvBundled;
        else delete process.env.OMNI_BUNDLED_DIR;

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('falls back to templates/bundled-skills (Layer 3) when cache is empty', () => {
        // 1. Create a dummy skill in the mock bundled directory
        // obra/superpowers name: brainstorming
        const bundledBrainstormingDir = path.join(bundledDir, 'obra-superpowers', 'brainstorming');
        fs.mkdirSync(bundledBrainstormingDir, { recursive: true });
        fs.writeFileSync(path.join(bundledBrainstormingDir, 'SKILL.md'), '---\nname: brainstorming\ndescription: "Use when brainstorming"\n---\n# Brainstorming');

        // 2. Initialize project manifest
        const manifest = loadManifest();
        manifest.ide = 'claudecode';
        saveManifest(manifest);

        // 3. Run installation
        installOfflineSkills();

        // 4. Verify skill files were copied and manifest was updated
        const installedSkillPath = path.join(tmpDir, '.claude', 'skills', 'brainstorming', 'SKILL.md');
        assert.ok(fs.existsSync(installedSkillPath), 'brainstorming SKILL.md should be copied');
        assert.ok(fs.readFileSync(installedSkillPath, 'utf-8').includes('Use when brainstorming'));

        const updatedManifest = loadManifest();
        const skillEntry = updatedManifest.skills.external.find(s => s.name === 'brainstorming');
        assert.ok(skillEntry, 'brainstorming should be in manifest');
        assert.strictEqual(skillEntry.sourceType, 'bundled');
    });

    it('uses global cache (Layer 2) in priority over bundled skills (Layer 3)', () => {
        // 1. Create a dummy skill in bundled (older version)
        const bundledBrainstormingDir = path.join(bundledDir, 'obra-superpowers', 'brainstorming');
        fs.mkdirSync(bundledBrainstormingDir, { recursive: true });
        fs.writeFileSync(path.join(bundledBrainstormingDir, 'SKILL.md'), '---\nname: brainstorming\ndescription: "Old bundled version"\n---\n# Brainstorming');

        // 2. Create the same dummy skill in cache (newer version)
        const cachedBrainstormingDir = path.join(cacheDir, 'obra-superpowers', 'brainstorming');
        fs.mkdirSync(cachedBrainstormingDir, { recursive: true });
        fs.writeFileSync(path.join(cachedBrainstormingDir, 'SKILL.md'), '---\nname: brainstorming\ndescription: "New cached version"\n---\n# Brainstorming');

        // 3. Initialize manifest
        const manifest = loadManifest();
        manifest.ide = 'claudecode';
        saveManifest(manifest);

        // 4. Run installation
        installOfflineSkills();

        // 5. Verify the cached (newer) version was installed
        const installedSkillPath = path.join(tmpDir, '.claude', 'skills', 'brainstorming', 'SKILL.md');
        assert.ok(fs.existsSync(installedSkillPath));
        assert.ok(fs.readFileSync(installedSkillPath, 'utf-8').includes('New cached version'), 'Should install cached version instead of bundled');

        const updatedManifest = loadManifest();
        const skillEntry = updatedManifest.skills.external.find(s => s.name === 'brainstorming');
        assert.ok(skillEntry);
        assert.strictEqual(skillEntry.sourceType, 'cached');
    });

    it('skips already installed skills (idempotent)', () => {
        // 1. Setup mock bundled skill
        const bundledBrainstormingDir = path.join(bundledDir, 'obra-superpowers', 'brainstorming');
        fs.mkdirSync(bundledBrainstormingDir, { recursive: true });
        fs.writeFileSync(path.join(bundledBrainstormingDir, 'SKILL.md'), '---\nname: brainstorming\ndescription: "Bundled version"\n---\n# Brainstorming');

        // 2. Setup manifest with skill marked as already installed
        const manifest = loadManifest();
        manifest.ide = 'claudecode';
        manifest.skills.external.push({
            name: 'brainstorming',
            source: 'obra/superpowers',
            sourceType: 'registry',
            installedAt: '2025-01-01T00:00:00Z'
        });
        saveManifest(manifest);

        // 3. Run installation
        installOfflineSkills();

        // 4. Verify the file was NOT created/overwritten because it was skipped
        const installedSkillPath = path.join(tmpDir, '.claude', 'skills', 'brainstorming', 'SKILL.md');
        assert.ok(!fs.existsSync(installedSkillPath), 'Skill should be skipped since it is already marked installed');
    });

    it('updates global cache with installed skills from the project (updateGlobalCache)', () => {
        // 1. Create a skill in the project
        const projectSkillDir = path.join(tmpDir, '.claude', 'skills', 'brainstorming');
        fs.mkdirSync(projectSkillDir, { recursive: true });
        fs.writeFileSync(path.join(projectSkillDir, 'SKILL.md'), '---\nname: brainstorming\ndescription: "Project version"\n---\n# Brainstorming');

        // 2. Setup manifest
        const manifest = loadManifest();
        manifest.ide = 'claudecode';
        manifest.skills.external.push({
            name: 'brainstorming',
            source: 'obra/superpowers',
            sourceType: 'registry',
            installedAt: '2025-01-01T00:00:00Z'
        });
        saveManifest(manifest);

        // 3. Run update cache
        updateGlobalCache(manifest);

        // 4. Verify cache directory has the copied file
        const cacheFile = path.join(cacheDir, 'obra-superpowers', 'brainstorming', 'SKILL.md');
        assert.ok(fs.existsSync(cacheFile), 'Skill should be copied to cache');
        assert.ok(fs.readFileSync(cacheFile, 'utf-8').includes('Project version'));
    });

    it('omni skills:doctor reports offline warnings for bundled/cached skills', () => {
        // 1. Create skill in the project
        const projectSkillDir = path.join(tmpDir, '.claude', 'skills', 'brainstorming');
        fs.mkdirSync(projectSkillDir, { recursive: true });
        fs.writeFileSync(path.join(projectSkillDir, 'SKILL.md'), '---\nname: brainstorming\ndescription: "Use when brainstorming"\n---\n# Brainstorming');

        // 2. Setup manifest with sourceType: 'bundled'
        const manifest = loadManifest();
        manifest.ide = 'claudecode';
        manifest.skills.external.push({
            name: 'brainstorming',
            source: 'obra/superpowers',
            sourceType: 'bundled',
            installedAt: '2025-01-01T00:00:00Z'
        });
        saveManifest(manifest);

        // 3. Scan installed skills
        const { results } = scanInstalledSkills(tmpDir, manifest);
        const brainstormingResult = results.find(r => r.name === 'brainstorming');

        // 4. Verify warning is generated
        assert.ok(brainstormingResult);
        assert.ok(brainstormingResult.warnings.length > 0, 'Should have warning');
        assert.ok(brainstormingResult.warnings.some(w => w.includes('bundled (offline)')));
    });

    it('installs UI_SKILLS only when project hasUI is true', () => {
        // 1. Create a dummy UI skill in bundled dir
        const bundledUIDir = path.join(bundledDir, 'Leonxlnx-taste-skill-skills-gpt-tasteskill', 'design-taste-frontend');
        fs.mkdirSync(bundledUIDir, { recursive: true });
        fs.writeFileSync(path.join(bundledUIDir, 'SKILL.md'), '---\nname: design-taste-frontend\ndescription: "Anti-slop"\n---\n# Anti-slop');

        // 2. Initialize project manifest
        const manifest = loadManifest();
        manifest.ide = 'claudecode';
        saveManifest(manifest);

        // CASE A: hasUI is false (no package.json)
        installOfflineSkills();
        const skillPath = path.join(tmpDir, '.claude', 'skills', 'design-taste-frontend', 'SKILL.md');
        assert.ok(!fs.existsSync(skillPath), 'UI skill should NOT be installed when hasUI is false');

        // CASE B: hasUI is true (package.json with react)
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
            dependencies: { react: '^18.0.0' }
        }));
        
        // Reset manifest to uninstalled state
        saveManifest({
            version: '1.0.0',
            configFile: 'CLAUDE.md',
            ide: 'claudecode',
            skills: { external: [] }
        });

        installOfflineSkills();
        assert.ok(fs.existsSync(skillPath), 'UI skill SHOULD be installed when hasUI is true');
    });
});
