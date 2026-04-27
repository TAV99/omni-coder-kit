'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectExistingProject, detectTechStack } = require('../../lib/scanner/detect');

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// detectExistingProject
// ---------------------------------------------------------------------------
describe('detectExistingProject', () => {
    it('returns detected=false for empty dir', () => {
        const result = detectExistingProject(tmpDir);
        assert.equal(result.detected, false);
        assert.equal(result.lang, '');
        assert.equal(result.stats.files, 0);
    });

    it('detects Node.js project from package.json', () => {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'myapp', version: '1.0.0' }));
        const result = detectExistingProject(tmpDir);
        assert.equal(result.detected, true);
        assert.ok(result.lang.includes('Node.js'), `expected Node.js in lang, got: ${result.lang}`);
    });

    it('detects TypeScript when tsconfig.json exists', () => {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'myapp', devDependencies: {} }));
        fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
        const result = detectExistingProject(tmpDir);
        assert.equal(result.detected, true);
        assert.ok(result.lang.includes('TypeScript'), `expected TypeScript in lang, got: ${result.lang}`);
    });

    it('detects TypeScript when typescript is in devDependencies', () => {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
            name: 'myapp',
            devDependencies: { typescript: '^5.0.0' },
        }));
        const result = detectExistingProject(tmpDir);
        assert.equal(result.detected, true);
        assert.ok(result.lang.includes('TypeScript'), `expected TypeScript in lang, got: ${result.lang}`);
    });

    it('detects Python project from requirements.txt', () => {
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask>=2.0\n');
        const result = detectExistingProject(tmpDir);
        assert.equal(result.detected, true);
        assert.ok(result.lang.includes('Python'), `expected Python in lang, got: ${result.lang}`);
    });
});

// ---------------------------------------------------------------------------
// detectTechStack
// ---------------------------------------------------------------------------
describe('detectTechStack', () => {
    it('returns empty stack for empty dir', () => {
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.runtime, null);
        assert.equal(stack.framework, null);
    });

    it('detects Node.js with Express from package.json', () => {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
            name: 'myapp',
            dependencies: { express: '^4.18.0' },
        }));
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.runtime, 'Node.js');
        assert.equal(stack.framework, 'Express');
    });

    it('CRITICAL: does NOT detect Django from comment-only in requirements.txt', () => {
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), '# django tutorial\nflask>=2.0\n');
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.runtime, 'Python');
        assert.notEqual(stack.framework, 'Django', 'Django in a comment should NOT be detected as framework');
        assert.equal(stack.framework, 'Flask', `expected Flask, got: ${stack.framework}`);
    });

    it('detects Django from actual dependency in requirements.txt', () => {
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'django==4.2\ncelery\n');
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.runtime, 'Python');
        assert.equal(stack.framework, 'Django');
    });

    it('detects pytest from requirements.txt', () => {
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'django==4.2\npytest>=7.0\n');
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.test, 'pytest');
    });

    it('detects Go Gin framework from go.mod', () => {
        fs.writeFileSync(path.join(tmpDir, 'go.mod'), `module example.com/myapp

go 1.21

require (
    github.com/gin-gonic/gin v1.9.1
)
`);
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.runtime, 'Go');
        assert.equal(stack.framework, 'Gin');
    });

    it('detects Rust Actix framework from Cargo.toml', () => {
        fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), `[package]
name = "myapp"
version = "0.1.0"

[dependencies]
actix-web = "4"
tokio = { version = "1", features = ["full"] }
`);
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.runtime, 'Rust');
        assert.equal(stack.framework, 'Actix');
    });

    it('detects PHP Laravel from composer.json', () => {
        fs.writeFileSync(path.join(tmpDir, 'composer.json'), JSON.stringify({
            require: {
                'php': '>=8.1',
                'laravel/framework': '^10.0',
            },
        }));
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.runtime, 'PHP');
        assert.equal(stack.framework, 'Laravel');
    });

    it('detects Ruby Rails from Gemfile', () => {
        fs.writeFileSync(path.join(tmpDir, 'Gemfile'), `source 'https://rubygems.org'

gem 'rails', '~> 7.0'
gem 'pg'
`);
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.runtime, 'Ruby');
        assert.equal(stack.framework, 'Rails');
    });
});
