const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const scanner = require('../../lib/scanner');

describe('lib/scanner/index.js backward compatibility', () => {
    it('exports detectExistingProject', () => {
        assert.equal(typeof scanner.detectExistingProject, 'function');
    });
    it('exports scanProject', () => {
        assert.equal(typeof scanner.scanProject, 'function');
    });
    it('exports generateMapSkeleton', () => {
        assert.equal(typeof scanner.generateMapSkeleton, 'function');
    });
    it('exports refreshMap', () => {
        assert.equal(typeof scanner.refreshMap, 'function');
    });
    it('exports IGNORED_DIRS as a Set', () => {
        assert.ok(scanner.IGNORED_DIRS instanceof Set);
        assert.ok(scanner.IGNORED_DIRS.has('node_modules'));
    });
    it('exports MANIFEST_FILES as an object', () => {
        assert.equal(typeof scanner.MANIFEST_FILES, 'object');
        assert.equal(scanner.MANIFEST_FILES['package.json'], 'Node.js');
    });
});
