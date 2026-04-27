'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    parseRequirementsTxt,
    parsePyprojectToml,
    parseGoMod,
    parseCargoToml,
    parseComposerJson,
    parseGemfile,
} = require('../../lib/scanner/parsers');

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parsers-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseRequirementsTxt
// ---------------------------------------------------------------------------
describe('parseRequirementsTxt', () => {
    it('parses simple package names with version specifiers', () => {
        const file = path.join(tmpDir, 'requirements.txt');
        fs.writeFileSync(file, 'django==4.2\nflask>=2.0\n');
        const result = parseRequirementsTxt(file);
        assert.deepEqual(result, ['django', 'flask']);
    });

    it('skips comment lines', () => {
        const file = path.join(tmpDir, 'requirements.txt');
        fs.writeFileSync(file, '# django tutorial\nflask\n');
        const result = parseRequirementsTxt(file);
        assert.deepEqual(result, ['flask']);
    });

    it('skips blank lines and flag lines (-r, --index-url)', () => {
        const file = path.join(tmpDir, 'requirements.txt');
        fs.writeFileSync(file, '\n-r base.txt\n--index-url http://x\nrequests\n');
        const result = parseRequirementsTxt(file);
        assert.deepEqual(result, ['requests']);
    });

    it('handles extras and complex version specifiers', () => {
        const file = path.join(tmpDir, 'requirements.txt');
        fs.writeFileSync(file, 'celery[redis]>=5.0\nuvicorn~=0.20\n');
        const result = parseRequirementsTxt(file);
        assert.deepEqual(result, ['celery', 'uvicorn']);
    });

    it('lowercases package names', () => {
        const file = path.join(tmpDir, 'requirements.txt');
        fs.writeFileSync(file, 'Django==4.2\nFastAPI\n');
        const result = parseRequirementsTxt(file);
        assert.deepEqual(result, ['django', 'fastapi']);
    });

    it('returns empty array for missing file', () => {
        const result = parseRequirementsTxt(path.join(tmpDir, 'nonexistent.txt'));
        assert.deepEqual(result, []);
    });

    it('skips -e editable installs', () => {
        const file = path.join(tmpDir, 'requirements.txt');
        fs.writeFileSync(file, '-e git+https://github.com/x/y.git#egg=mylib\nflask\n');
        const result = parseRequirementsTxt(file);
        assert.deepEqual(result, ['flask']);
    });
});

// ---------------------------------------------------------------------------
// parsePyprojectToml
// ---------------------------------------------------------------------------
describe('parsePyprojectToml', () => {
    it('parses dependencies array from [project] section', () => {
        const file = path.join(tmpDir, 'pyproject.toml');
        fs.writeFileSync(file, `
[project]
name = "myapp"
dependencies = [
    "django>=4.2",
    "flask>=2.0",
]
`);
        const result = parsePyprojectToml(file);
        assert.ok(result.includes('django'), 'should include django');
        assert.ok(result.includes('flask'), 'should include flask');
    });

    it('parses optional-dependencies (dev, test) sections', () => {
        const file = path.join(tmpDir, 'pyproject.toml');
        fs.writeFileSync(file, `
[project]
dependencies = ["requests>=2.0"]

[project.optional-dependencies]
dev = [
    "pytest>=7.0",
    "black>=23.0",
]
test = [
    "coverage>=7.0",
]
`);
        const result = parsePyprojectToml(file);
        assert.ok(result.includes('requests'), 'should include requests');
        assert.ok(result.includes('pytest'), 'should include pytest');
        assert.ok(result.includes('black'), 'should include black');
        assert.ok(result.includes('coverage'), 'should include coverage');
    });

    it('returns empty array for missing file', () => {
        const result = parsePyprojectToml(path.join(tmpDir, 'nonexistent.toml'));
        assert.deepEqual(result, []);
    });
});

// ---------------------------------------------------------------------------
// parseGoMod
// ---------------------------------------------------------------------------
describe('parseGoMod', () => {
    it('parses require block with multiple dependencies', () => {
        const file = path.join(tmpDir, 'go.mod');
        fs.writeFileSync(file, `module example.com/myapp

go 1.21

require (
    github.com/gin-gonic/gin v1.9.1
    github.com/stretchr/testify v1.8.4
)
`);
        const result = parseGoMod(file);
        assert.ok(result.includes('github.com/gin-gonic/gin'), 'should include gin');
        assert.ok(result.includes('github.com/stretchr/testify'), 'should include testify');
    });

    it('parses single-line require statements', () => {
        const file = path.join(tmpDir, 'go.mod');
        fs.writeFileSync(file, `module example.com/myapp

go 1.21

require github.com/gorilla/mux v1.8.0
`);
        const result = parseGoMod(file);
        assert.ok(result.includes('github.com/gorilla/mux'), 'should include gorilla/mux');
    });

    it('returns empty array for missing file', () => {
        const result = parseGoMod(path.join(tmpDir, 'nonexistent.mod'));
        assert.deepEqual(result, []);
    });
});

// ---------------------------------------------------------------------------
// parseCargoToml
// ---------------------------------------------------------------------------
describe('parseCargoToml', () => {
    it('parses [dependencies] section with string and inline-table values', () => {
        const file = path.join(tmpDir, 'Cargo.toml');
        fs.writeFileSync(file, `[package]
name = "myapp"
version = "0.1.0"

[dependencies]
actix-web = "4"
tokio = { version = "1", features = ["full"] }
serde = { version = "1.0", features = ["derive"] }
`);
        const result = parseCargoToml(file);
        assert.ok(result.includes('actix-web'), 'should include actix-web');
        assert.ok(result.includes('tokio'), 'should include tokio');
        assert.ok(result.includes('serde'), 'should include serde');
    });

    it('parses [dev-dependencies] section', () => {
        const file = path.join(tmpDir, 'Cargo.toml');
        fs.writeFileSync(file, `[package]
name = "myapp"

[dependencies]
serde = "1.0"

[dev-dependencies]
mockall = "0.11"
proptest = "1.0"
`);
        const result = parseCargoToml(file);
        assert.ok(result.includes('serde'), 'should include serde');
        assert.ok(result.includes('mockall'), 'should include mockall');
        assert.ok(result.includes('proptest'), 'should include proptest');
    });

    it('returns empty array for missing file', () => {
        const result = parseCargoToml(path.join(tmpDir, 'nonexistent.toml'));
        assert.deepEqual(result, []);
    });
});

// ---------------------------------------------------------------------------
// parseComposerJson
// ---------------------------------------------------------------------------
describe('parseComposerJson', () => {
    it('parses require and require-dev keys', () => {
        const file = path.join(tmpDir, 'composer.json');
        fs.writeFileSync(file, JSON.stringify({
            require: {
                'php': '>=8.1',
                'laravel/framework': '^10.0',
                'guzzlehttp/guzzle': '^7.0',
            },
            'require-dev': {
                'phpunit/phpunit': '^10.0',
                'laravel/pint': '^1.0',
            },
        }));
        const result = parseComposerJson(file);
        assert.ok(result.includes('laravel/framework'), 'should include laravel/framework');
        assert.ok(result.includes('guzzlehttp/guzzle'), 'should include guzzlehttp/guzzle');
        assert.ok(result.includes('phpunit/phpunit'), 'should include phpunit/phpunit');
        assert.ok(result.includes('laravel/pint'), 'should include laravel/pint');
    });

    it('returns empty array for missing file', () => {
        const result = parseComposerJson(path.join(tmpDir, 'nonexistent.json'));
        assert.deepEqual(result, []);
    });
});

// ---------------------------------------------------------------------------
// parseGemfile
// ---------------------------------------------------------------------------
describe('parseGemfile', () => {
    it('parses gem declarations with single and double quotes', () => {
        const file = path.join(tmpDir, 'Gemfile');
        fs.writeFileSync(file, `source 'https://rubygems.org'

gem 'rails', '~> 7.0'
gem "sinatra", ">= 3.0"
gem 'pg'
`);
        const result = parseGemfile(file);
        assert.ok(result.includes('rails'), 'should include rails');
        assert.ok(result.includes('sinatra'), 'should include sinatra');
        assert.ok(result.includes('pg'), 'should include pg');
    });

    it('skips comment lines', () => {
        const file = path.join(tmpDir, 'Gemfile');
        fs.writeFileSync(file, `# gem 'nokogiri'
gem 'rails'
`);
        const result = parseGemfile(file);
        assert.deepEqual(result, ['rails']);
    });

    it('returns empty array for missing file', () => {
        const result = parseGemfile(path.join(tmpDir, 'nonexistent-Gemfile'));
        assert.deepEqual(result, []);
    });
});
