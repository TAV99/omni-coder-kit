'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  canonicalExternalInput,
  ExternalOperationSchema,
  exactExternalOperation,
} = require('../lib/dual/external-operations');

test('canonicalExternalInput - sorts keys recursively and preserves valid JSON types', () => {
  const objA = { b: 2, a: 1, nested: { y: 'hello', x: [3, 1, 2] } };
  const objB = { nested: { x: [3, 1, 2], y: 'hello' }, a: 1, b: 2 };

  const canonicalA = canonicalExternalInput(objA);
  const canonicalB = canonicalExternalInput(objB);

  assert.strictEqual(canonicalA, '{"a":1,"b":2,"nested":{"x":[3,1,2],"y":"hello"}}');
  assert.strictEqual(canonicalA, canonicalB);
});

test('canonicalExternalInput - supports booleans, finite numbers, null, strings, arrays', () => {
  const input = {
    boolTrue: true,
    boolFalse: false,
    numInt: 42,
    numFloat: 3.1415,
    numNeg: -100,
    nullVal: null,
    strVal: 'stitch',
    arrVal: [null, true, 10, 'text', { k: 'v' }],
  };

  const res = canonicalExternalInput(input);
  assert.ok(res);
  const parsed = JSON.parse(res);
  assert.deepStrictEqual(parsed, input);
});

test('canonicalExternalInput - rejects top-level non-plain objects and primitives', () => {
  assert.strictEqual(canonicalExternalInput(null), null);
  assert.strictEqual(canonicalExternalInput([]), null);
  assert.strictEqual(canonicalExternalInput('string'), null);
  assert.strictEqual(canonicalExternalInput(123), null);
  assert.strictEqual(canonicalExternalInput(true), null);
  assert.strictEqual(canonicalExternalInput(new Date()), null);
  assert.strictEqual(canonicalExternalInput(new Map()), null);
  assert.strictEqual(canonicalExternalInput(new Set()), null);
});

test('canonicalExternalInput - rejects undefined, functions, symbols, BigInt, NaN, Infinity', () => {
  assert.strictEqual(canonicalExternalInput({ a: undefined }), null);
  assert.strictEqual(canonicalExternalInput({ fn: () => {} }), null);
  assert.strictEqual(canonicalExternalInput({ sym: Symbol('test') }), null);
  assert.strictEqual(canonicalExternalInput({ big: 10n }), null);
  assert.strictEqual(canonicalExternalInput({ nan: NaN }), null);
  assert.strictEqual(canonicalExternalInput({ inf: Infinity }), null);
  assert.strictEqual(canonicalExternalInput({ ninf: -Infinity }), null);
  assert.strictEqual(canonicalExternalInput({ arr: [undefined] }), null);
});

test('canonicalExternalInput - rejects cycles', () => {
  const cyclicObj = { a: 1 };
  cyclicObj.self = cyclicObj;
  assert.strictEqual(canonicalExternalInput(cyclicObj), null);

  const cyclicNested = { a: { b: {} } };
  cyclicNested.a.b.root = cyclicNested;
  assert.strictEqual(canonicalExternalInput(cyclicNested), null);
});

test('canonicalExternalInput - rejects depth > 16', () => {
  let shallow = { leaf: 1 };
  for (let i = 1; i < 16; i++) {
    shallow = { next: shallow };
  }
  assert.ok(canonicalExternalInput(shallow) !== null);

  let deep = { leaf: 1 };
  for (let i = 1; i < 17; i++) {
    deep = { next: deep };
  }
  assert.strictEqual(canonicalExternalInput(deep), null);
});

test('canonicalExternalInput - rejects serialized bytes > 16384', () => {
  const largeObj = { data: 'a'.repeat(16370) };
  assert.ok(canonicalExternalInput(largeObj) !== null);

  const oversizedObj = { data: 'a'.repeat(16400) };
  assert.strictEqual(canonicalExternalInput(oversizedObj), null);
});

test('canonicalExternalInput - does not normalize unicode', () => {
  const nfd = { text: 'e\u0301' };
  const nfc = { text: '\u00e9' };
  const resNfd = canonicalExternalInput(nfd);
  const resNfc = canonicalExternalInput(nfc);
  assert.notStrictEqual(resNfd, resNfc);
});

test('ExternalOperationSchema - validates valid Stitch tool operation', () => {
  const validOp = {
    tool_name: 'mcp__stitch__create_project',
    tool_input: { project_name: 'Dashboard', theme: { mode: 'dark' } },
    evidence_file: 'evidence/stitch-project-create.json',
  };
  const parsed = ExternalOperationSchema.safeParse(validOp);
  assert.strictEqual(parsed.success, true);
});

test('ExternalOperationSchema - rejects non-Stitch tools and invalid formats', () => {
  const invalidTools = [
    'mcp__other__create_project',
    'stitch__create_project',
    'mcp__stitch__Create_Project',
    'mcp__stitch__',
    'mcp__stitch__tool-name',
    'mcp__stitch__' + 'a'.repeat(97),
  ];
  for (const tool of invalidTools) {
    const res = ExternalOperationSchema.safeParse({
      tool_name: tool,
      tool_input: { a: 1 },
      evidence_file: 'evidence/out.json',
    });
    assert.strictEqual(res.success, false, `Expected failure for tool_name: ${tool}`);
  }
});

test('ExternalOperationSchema - rejects invalid evidence_file paths', () => {
  const badPaths = [
    '',
    '/absolute/path.json',
    'path/with/trailing/slash/',
    'path//empty/component.json',
    '.',
    '..',
    'evidence/./file.json',
    'evidence/../file.json',
    'evidence\\backslash.json',
    'C:/windows/colon.json',
    'wildcard/*.json',
    'wildcard/?/file.json',
    'null\0byte.json',
    'a/'.repeat(130) + 'file.json',
  ];
  for (const evidence_file of badPaths) {
    const res = ExternalOperationSchema.safeParse({
      tool_name: 'mcp__stitch__get_screen',
      tool_input: { id: 'screen_1' },
      evidence_file,
    });
    assert.strictEqual(res.success, false, `Expected failure for evidence_file: ${evidence_file}`);
  }
});

test('ExternalOperationSchema - rejects extra properties and non-canonical input', () => {
  const extraProp = {
    tool_name: 'mcp__stitch__get_screen',
    tool_input: { id: 's1' },
    evidence_file: 'evidence/s1.json',
    extra: 'forbidden',
  };
  assert.strictEqual(ExternalOperationSchema.safeParse(extraProp).success, false);

  const nonCanonicalInput = {
    tool_name: 'mcp__stitch__get_screen',
    tool_input: { fn: () => {} },
    evidence_file: 'evidence/s1.json',
  };
  assert.strictEqual(ExternalOperationSchema.safeParse(nonCanonicalInput).success, false);
});

test('exactExternalOperation - exact match with reordered args returns grant, index, fingerprint', () => {
  const grantOp = {
    tool_name: 'mcp__stitch__generate_screen_from_text',
    tool_input: { prompt: 'User profile screen', options: { responsive: true, width: 1280 } },
    evidence_file: 'evidence/profile-screen.json',
  };

  const task = {
    owner: 'codex',
    state: 'ROUTED',
    execution_mode: 'shared',
    allowed_files: ['evidence/profile-screen.json'],
    external_operations: [grantOp],
  };

  const runtimeToolInput = {
    options: { width: 1280, responsive: true },
    prompt: 'User profile screen',
  };

  const match = exactExternalOperation(task, 'mcp__stitch__generate_screen_from_text', runtimeToolInput);
  assert.ok(match);
  assert.strictEqual(match.index, 0);
  assert.strictEqual(match.grant.tool_name, grantOp.tool_name);

  const expectedCanonicalGrant = canonicalExternalInput({
    evidence_file: grantOp.evidence_file,
    tool_input: grantOp.tool_input,
    tool_name: grantOp.tool_name,
  });
  const expectedFingerprint = crypto
    .createHash('sha256')
    .update(`external-operation-v1:${expectedCanonicalGrant}`)
    .digest('hex');
  assert.strictEqual(match.fingerprint, expectedFingerprint);
});

test('exactExternalOperation - rejects when task owner is not codex', () => {
  const task = {
    owner: 'agy',
    state: 'ROUTED',
    external_operations: [{
      tool_name: 'mcp__stitch__list_projects',
      tool_input: { limit: 10 },
      evidence_file: 'evidence/list.json',
    }],
  };
  const res = exactExternalOperation(task, 'mcp__stitch__list_projects', { limit: 10 });
  assert.strictEqual(res, null);
});

test('exactExternalOperation - rejects when task state is not ROUTED', () => {
  const task = {
    owner: 'codex',
    state: 'CODEX_IMPLEMENT',
    external_operations: [{
      tool_name: 'mcp__stitch__list_projects',
      tool_input: { limit: 10 },
      evidence_file: 'evidence/list.json',
    }],
  };
  const res = exactExternalOperation(task, 'mcp__stitch__list_projects', { limit: 10 });
  assert.strictEqual(res, null);
});

test('exactExternalOperation - rejects when execution_mode is unsupported', () => {
  const task = {
    owner: 'codex',
    state: 'ROUTED',
    execution_mode: 'exclusive',
    external_operations: [{
      tool_name: 'mcp__stitch__list_projects',
      tool_input: { limit: 10 },
      evidence_file: 'evidence/list.json',
    }],
  };
  const res = exactExternalOperation(task, 'mcp__stitch__list_projects', { limit: 10 });
  assert.strictEqual(res, null);
});

test('exactExternalOperation - rejects tool mismatch, changed args, extra fields', () => {
  const task = {
    allowed_files: ['evidence/s1.json'],
    owner: 'codex',
    state: 'ROUTED',
    external_operations: [{
      tool_name: 'mcp__stitch__get_screen',
      tool_input: { id: 'screen_1' },
      evidence_file: 'evidence/s1.json',
    }],
  };

  assert.strictEqual(exactExternalOperation(task, 'mcp__stitch__other_tool', { id: 'screen_1' }), null);
  assert.strictEqual(exactExternalOperation(task, 'mcp__stitch__get_screen', { id: 'screen_2' }), null);
  assert.strictEqual(exactExternalOperation(task, 'mcp__stitch__get_screen', { id: 'screen_1', extra: true }), null);
});

test('exactExternalOperation - returns null on ambiguous multiple matches', () => {
  const duplicateOp = {
    tool_name: 'mcp__stitch__get_screen',
    tool_input: { id: 'screen_1' },
    evidence_file: 'evidence/s1.json',
  };
  const task = {
    allowed_files: ['evidence/s1.json'],
    owner: 'codex',
    state: 'ROUTED',
    external_operations: [duplicateOp, duplicateOp],
  };
  const res = exactExternalOperation(task, 'mcp__stitch__get_screen', { id: 'screen_1' });
  assert.strictEqual(res, null);
});

test('exactExternalOperation - respects allowed_files and deny_patterns', () => {
  const op = {
    tool_name: 'mcp__stitch__get_screen',
    tool_input: { id: 'screen_1' },
    evidence_file: 'evidence/s1.json',
  };

  const taskNotAllowed = {
    owner: 'codex',
    state: 'ROUTED',
    allowed_files: ['evidence/other.json'],
    external_operations: [op],
  };
  assert.strictEqual(exactExternalOperation(taskNotAllowed, 'mcp__stitch__get_screen', { id: 'screen_1' }), null);

  const taskDenied = {
    owner: 'codex',
    state: 'ROUTED',
    allowed_files: ['evidence/s1.json'],
    deny_patterns: ['evidence/**'],
    external_operations: [op],
  };
  assert.strictEqual(exactExternalOperation(taskDenied, 'mcp__stitch__get_screen', { id: 'screen_1' }), null);
});

test('unregistered scope and undocumented grants never authorize external calls', () => {
  const grant = { tool_name: 'mcp__stitch__create_project', tool_input: { title: 'Project' }, evidence_file: 'evidence/out.json' };
  const task = { owner: 'codex', state: 'ROUTED', external_operations: [grant] };
  assert.equal(exactExternalOperation(task, grant.tool_name, grant.tool_input), null);
  assert.equal(exactExternalOperation({ ...task, external_operations: undefined, grants: [grant], allowed_files: [grant.evidence_file] }, grant.tool_name, grant.tool_input), null);
  const circular = {}; circular.self = circular;
  assert.equal(ExternalOperationSchema.safeParse({ ...grant, tool_input: circular }).success, false);
});
