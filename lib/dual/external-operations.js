'use strict';

const crypto = require('node:crypto');
const { z } = require('zod');
const { matchesDenyPattern } = require('./scope-guard');

const TOOL_NAME_REGEX = /^mcp__stitch__[a-z][a-z0-9_]{0,95}$/;

function isPlainObject(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function serializeNode(val, depth, seen, budget) {
  if (++budget.nodes > 16384) return null;
  if (val === null) return 'null';
  const type = typeof val;
  if (type === 'boolean') return val ? 'true' : 'false';
  if (type === 'number') return Number.isFinite(val) ? JSON.stringify(val) : null;
  if (type === 'string') {
    budget.bytes += Buffer.byteLength(val, 'utf8');
    return budget.bytes <= 16384 ? JSON.stringify(val) : null;
  }
  if (type !== 'object') return null;
  if (depth > 16) return null;

  if (seen.has(val)) return null;
  seen.add(val);
  try {
    if (Array.isArray(val)) {
      const items = [];
      for (let i = 0; i < val.length; i++) {
        if (!(i in val)) return null;
        const item = val[i];
        if (item === undefined) return null;
        const res = serializeNode(item, depth + 1, seen, budget);
        if (res === null) return null;
        items.push(res);
      }
      return `[${items.join(',')}]`;
    }
    if (isPlainObject(val)) {
      const keys = Object.keys(val).sort();
      const props = [];
      for (const k of keys) {
        budget.bytes += Buffer.byteLength(k, 'utf8');
        if (budget.bytes > 16384) return null;
        const v = val[k];
        if (v === undefined) return null;
        const res = serializeNode(v, depth + 1, seen, budget);
        if (res === null) return null;
        props.push(`${JSON.stringify(k)}:${res}`);
      }
      return `{${props.join(',')}}`;
    }
    return null;
  } finally {
    seen.delete(val);
  }
}

function canonicalExternalInput(input) {
  if (!isPlainObject(input)) return null;
  try {
    const json = serializeNode(input, 1, new Set(), { bytes: 0, nodes: 0 });
    if (json === null) return null;
    if (Buffer.byteLength(json, 'utf8') > 16384) return null;
    return json;
  } catch {
    return null;
  }
}

function isSafeRelativePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 256) return false;
  if (/[\0\\:*?]/.test(p)) return false;
  if (p.startsWith('/') || p.endsWith('/')) return false;
  const parts = p.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return false;
  }
  return true;
}

const ExternalOperationSchema = z.object({
  tool_name: z.string().regex(TOOL_NAME_REGEX, 'tool_name must match Stitch tool pattern'),
  tool_input: z.custom(isPlainObject).refine(
    (val) => canonicalExternalInput(val) !== null,
    { message: 'tool_input must be canonicalizable non-null plain object' }
  ),
  evidence_file: z.string().refine(
    isSafeRelativePath,
    { message: 'evidence_file must be a safe relative forward-slash path <= 256 chars' }
  ),
}).strict();

function matchesDenyPatterns(file, patterns) {
  return Array.isArray(patterns) && patterns.some((pattern) => matchesDenyPattern(file, pattern));
}

function exactExternalOperation(task, toolName, toolInput) {
  if (!task || typeof task !== 'object') return null;
  if (task.owner !== 'codex') return null;
  if (task.execution_mode !== undefined && task.execution_mode !== null && task.execution_mode !== 'shared') {
    return null;
  }
  if (task.state !== 'ROUTED') return null;

  const canonicalToolInput = canonicalExternalInput(toolInput);
  if (canonicalToolInput === null) return null;

  const grants = Array.isArray(task.external_operations) ? task.external_operations : null;
  if (!grants) return null;

  const matches = [];
  for (let i = 0; i < grants.length; i++) {
    const rawGrant = grants[i];
    const parsed = ExternalOperationSchema.safeParse(rawGrant);
    if (!parsed.success) continue;
    const grant = parsed.data;

    if (grant.tool_name !== toolName) continue;
    const grantInputCanonical = canonicalExternalInput(grant.tool_input);
    if (grantInputCanonical !== canonicalToolInput) continue;

    if (!Array.isArray(task.allowed_files) || !task.allowed_files.includes(grant.evidence_file)) {
      continue;
    }
    if (Array.isArray(task.deny_patterns) && matchesDenyPatterns(grant.evidence_file, task.deny_patterns)) {
      continue;
    }

    const grantPayload = canonicalExternalInput({
      evidence_file: grant.evidence_file,
      tool_input: grant.tool_input,
      tool_name: grant.tool_name,
    });
    if (!grantPayload) continue;

    const fingerprint = crypto
      .createHash('sha256')
      .update(`external-operation-v1:${grantPayload}`)
      .digest('hex');

    matches.push({ grant, index: i, fingerprint });
  }

  if (matches.length === 1) {
    return matches[0];
  }
  return null;
}

module.exports = {
  canonicalExternalInput,
  ExternalOperationSchema,
  exactExternalOperation,
};
