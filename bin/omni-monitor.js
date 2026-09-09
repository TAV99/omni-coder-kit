#!/usr/bin/env node
'use strict';

const path = require('node:path');
const chalk = require('chalk');
const { DualObserver, formatEvent } = require('../lib/dual/observer');

const targetWorkspace = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();

console.log(chalk.cyan('======================================================================'));
console.log(chalk.yellow.bold('      OMNI-CODER KIT :: REPOSITORY-OWNED DUAL OBSERVER'));
console.log(chalk.gray(`      Target Workspace : ${targetWorkspace}`));
console.log(chalk.cyan('======================================================================\n'));

const observer = new DualObserver({
    workspaceRoot: targetWorkspace,
    onEvent: (evt, formatted) => {
        let color = chalk.white;
        if (evt.type.includes('error') || evt.type.includes('failed') || evt.type === 'session.blocked') {
            color = chalk.red.bold;
        } else if (evt.type.includes('completed') || evt.type === 'session.verified' || evt.type === 'plan.registered') {
            color = chalk.green.bold;
        } else if (evt.type.includes('started') || evt.type.includes('routed')) {
            color = chalk.yellow;
        } else if (evt.type.includes('lease') || evt.type.includes('correction')) {
            color = chalk.cyan;
        }
        console.log(color(formatted));
    },
    onError: (err) => {
        console.error(chalk.red(`[Observer Error] ${err.message}`));
    },
    onStateChange: (state) => {
        // State update hook
    },
});

console.log(chalk.green(`[${new Date().toLocaleTimeString('vi-VN')}] Listening to events at ${observer.ledgerPath}...\n`));

observer.start(500);

process.on('SIGINT', () => {
    observer.stop();
    console.log(chalk.yellow('\nObserver stopped.'));
    process.exit(0);
});

process.on('SIGTERM', () => {
    observer.stop();
    process.exit(0);
});
