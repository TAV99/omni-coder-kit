'use strict';

const fs = require('node:fs');

const args = process.argv.slice(2);
const index = args.indexOf('--json-schema');
if (index < 0 || !args[index + 1]) throw new Error('Missing schema path');
const schema = JSON.parse(fs.readFileSync(args[index + 1], 'utf8'));
if (schema.type !== 'object') {
    process.stderr.write('Error: invalid --json-schema: schema root must specify "type": "object"\n');
    process.exitCode = 1;
} else {
    process.stdout.write(JSON.stringify({ accepted: true, schema_id: schema.$id }));
}
