const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

function detectDNA(projectDir) {
    let pkg = {};
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    } catch {}
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasDep = (name) => name in allDeps;
    const dirExists = (name) => fs.existsSync(path.join(projectDir, name));
    return {
        hasUI: hasDep('react') || hasDep('vue') || hasDep('svelte') || hasDep('next') || hasDep('@angular/core'),
        hasBackend: hasDep('express') || hasDep('fastify') || hasDep('hono') || hasDep('prisma') || hasDep('@supabase/supabase-js') || dirExists('server') || dirExists('api'),
        hasAPI: hasDep('express') || hasDep('fastify') || hasDep('hono') || dirExists('routes') || dirExists('controllers'),
    };
}

function buildCursorMcp(projectDir) {
    const servers = {};
    servers.context7 = { command: 'npx', args: ['-y', '@upstash/context7-mcp'] };

    let pkg = {};
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    } catch {}
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasDep = (name) => name in allDeps;

    if (hasDep('@supabase/supabase-js'))
        servers.supabase = { command: 'npx', args: ['-y', 'supabase-mcp-server'] };
    if (hasDep('prisma') || fs.existsSync(path.join(projectDir, 'prisma', 'schema.prisma')))
        servers.prisma = { command: 'npx', args: ['-y', '@anthropic/mcp-prisma'] };
    if (hasDep('next'))
        servers.vercel = { command: 'npx', args: ['-y', '@vercel/mcp'] };
    if (hasDep('firebase') || hasDep('firebase-admin'))
        servers.firebase = { command: 'npx', args: ['-y', '@anthropic/mcp-firebase'] };
    if (fs.existsSync(path.join(projectDir, 'Dockerfile')) || fs.existsSync(path.join(projectDir, 'docker-compose.yml')))
        servers.docker = { command: 'npx', args: ['-y', '@anthropic/mcp-docker'] };
    if (fs.existsSync(path.join(projectDir, '.git')))
        servers.github = { command: 'npx', args: ['-y', '@anthropic/mcp-github'] };

    return JSON.stringify({ mcpServers: servers }, null, 2);
}

describe('Cursor MCP configuration', () => {
    it('always includes context7', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-mcp-test-'));
        try {
            const config = JSON.parse(buildCursorMcp(tmpDir));
            assert.ok(config.mcpServers.context7);
            assert.deepEqual(config.mcpServers.context7.args, ['-y', '@upstash/context7-mcp']);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('includes supabase when @supabase/supabase-js detected', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-mcp-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
                dependencies: { '@supabase/supabase-js': '^2.0.0' }
            }));
            const config = JSON.parse(buildCursorMcp(tmpDir));
            assert.ok(config.mcpServers.supabase);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('includes prisma when prisma/schema.prisma exists', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-mcp-test-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'prisma'));
            fs.writeFileSync(path.join(tmpDir, 'prisma', 'schema.prisma'), 'generator client {}');
            const config = JSON.parse(buildCursorMcp(tmpDir));
            assert.ok(config.mcpServers.prisma);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('includes github when .git directory exists', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-mcp-test-'));
        try {
            fs.mkdirSync(path.join(tmpDir, '.git'));
            const config = JSON.parse(buildCursorMcp(tmpDir));
            assert.ok(config.mcpServers.github);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('includes vercel when next detected', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-mcp-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
                dependencies: { next: '^14.0.0', react: '^18.0.0' }
            }));
            const config = JSON.parse(buildCursorMcp(tmpDir));
            assert.ok(config.mcpServers.vercel);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('does NOT include undetected servers', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-mcp-test-'));
        try {
            const config = JSON.parse(buildCursorMcp(tmpDir));
            assert.equal(config.mcpServers.supabase, undefined);
            assert.equal(config.mcpServers.prisma, undefined);
            assert.equal(config.mcpServers.vercel, undefined);
            assert.equal(config.mcpServers.firebase, undefined);
            assert.equal(config.mcpServers.docker, undefined);
            assert.equal(config.mcpServers.github, undefined);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('generates valid JSON', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-mcp-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
                dependencies: { react: '^18.0.0', express: '^4.0.0', prisma: '^5.0.0' }
            }));
            fs.mkdirSync(path.join(tmpDir, '.git'));
            const raw = buildCursorMcp(tmpDir);
            assert.doesNotThrow(() => JSON.parse(raw));
            const config = JSON.parse(raw);
            assert.ok(config.mcpServers);
            assert.ok(Object.keys(config.mcpServers).length >= 2);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
