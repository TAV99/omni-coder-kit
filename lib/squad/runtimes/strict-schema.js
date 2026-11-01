'use strict';

// OpenAI structured output (codex exec --output-schema) runs in strict mode: every
// object lists all its properties in `required` and forbids extra keys. Verified
// against codex-cli 0.166.0 (SPEC-SQUAD-P3 appendix V17). Optional properties
// become required-but-nullable; stripNullOptionals undoes that on the reply.

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

function strictJsonSchema(schema) {
    if (Array.isArray(schema)) return schema.map(strictJsonSchema);
    if (!isObject(schema)) return schema;
    const out = {};
    for (const [key, value] of Object.entries(schema)) {
        if (key === 'properties' && isObject(value)) continue;
        out[key] = ['items', 'anyOf', 'oneOf', 'allOf', 'definitions', '$defs'].includes(key)
            ? (isObject(value) && key !== 'items'
                ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strictJsonSchema(v)]))
                : strictJsonSchema(value))
            : value;
    }
    if (isObject(schema.properties)) {
        const required = new Set(schema.required || []);
        out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => {
            const strict = strictJsonSchema(value);
            return [key, required.has(key) ? strict : { anyOf: [strict, { type: 'null' }] }];
        }));
        out.required = Object.keys(schema.properties);
        out.additionalProperties = false;
    }
    return out;
}

// Drops null values the original (non-strict) schema left optional.
function stripNullOptionals(value, schema) {
    if (Array.isArray(value)) {
        return isObject(schema) && schema.items ? value.map((item) => stripNullOptionals(item, schema.items)) : value;
    }
    if (!isObject(value) || !isObject(schema)) return value;
    const candidates = [schema, ...(schema.anyOf || []), ...(schema.oneOf || []), ...(schema.allOf || [])]
        .filter((branch) => isObject(branch) && isObject(branch.properties));
    // In a union, only branches the reply could belong to decide: matching
    // `const` values and no keys the branch does not declare.
    const fits = (branch) => Object.entries(branch.properties).every(([key, prop]) => !(key in value)
        || !isObject(prop) || !('const' in prop) || prop.const === value[key])
        && (branch.additionalProperties !== false || Object.keys(value).every((key) => key in branch.properties));
    const branches = candidates.length > 1 ? candidates.filter(fits) : candidates;
    if (!branches.length) return value;
    const out = { ...value };
    for (const branch of branches) {
        const required = new Set(branch.required || []);
        for (const [key, propSchema] of Object.entries(branch.properties)) {
            if (!(key in out)) continue;
            if (out[key] === null && !required.has(key)) delete out[key];
            else out[key] = stripNullOptionals(out[key], propSchema);
        }
    }
    return out;
}

module.exports = { strictJsonSchema, stripNullOptionals };
