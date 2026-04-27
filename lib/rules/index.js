'use strict';

const { parseRules } = require('./parse');
const { formatMarkdown, formatInject } = require('./format');
const { syncRulesToConfig } = require('./sync');

module.exports = { parseRules, formatMarkdown, formatInject, syncRulesToConfig };
