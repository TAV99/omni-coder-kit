'use strict';

const fs = require('fs');
const path = require('path');
const { IGNORED_DIRS, MANIFEST_FILES } = require('./constants');
const {
    parseRequirementsTxt,
    parsePyprojectToml,
    parseGoMod,
    parseCargoToml,
    parseComposerJson,
    parseGemfile,
} = require('./parsers');

/**
 * Detect whether the given directory is an existing project by checking for
 * known manifest files. Returns language(s) detected, basic file/dir stats,
 * and a `detected` boolean.
 *
 * @param {string} dir - Absolute path to the directory to inspect.
 * @returns {{ detected: boolean, stats: { files: number, dirs: number }, lang: string }}
 */
function detectExistingProject(dir) {
    const langs = [];
    for (const [file, lang] of Object.entries(MANIFEST_FILES)) {
        if (fs.existsSync(path.join(dir, file))) {
            if (!langs.includes(lang)) langs.push(lang);
        }
    }
    if (langs.length === 0) return { detected: false, stats: { files: 0, dirs: 0 }, lang: '' };

    let files = 0;
    let dirs = 0;
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
            if (entry.isDirectory()) { dirs++; }
            else { files++; }
        }
    } catch {}

    if (fs.existsSync(path.join(dir, 'package.json'))) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
            const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
            if (allDeps.typescript || fs.existsSync(path.join(dir, 'tsconfig.json'))) {
                const idx = langs.indexOf('Node.js');
                if (idx !== -1) langs[idx] = 'TypeScript';
            }
        } catch {}
    }

    return { detected: true, stats: { files, dirs }, lang: langs.join(' + ') };
}

/**
 * Detect the tech stack of a project in `dir` using proper manifest parsers
 * instead of naive string includes (which produce false positives from comments).
 *
 * @param {string} dir - Absolute path to the directory to inspect.
 * @returns {{ runtime: string|null, language: string|null, framework: string|null,
 *             ui: string|null, db: string|null, test: string|null,
 *             queue: string|null, deploy: string|null }}
 */
function detectTechStack(dir) {
    const stack = {
        runtime: null, language: null, framework: null,
        ui: null, db: null, test: null, queue: null, deploy: null,
    };

    // ------------------------------------------------------------------
    // Node.js — use JSON.parse (already proper, no false-positives)
    // ------------------------------------------------------------------
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
            const has = (n) => n in allDeps;

            stack.runtime = 'Node.js';
            if (has('typescript') || fs.existsSync(path.join(dir, 'tsconfig.json'))) {
                stack.language = 'TypeScript';
            } else {
                stack.language = 'JavaScript';
            }

            if (has('next')) stack.framework = 'Next.js';
            else if (has('nuxt')) stack.framework = 'Nuxt';
            else if (has('@nestjs/core')) stack.framework = 'NestJS';
            else if (has('express')) stack.framework = 'Express';
            else if (has('fastify')) stack.framework = 'Fastify';
            else if (has('hono')) stack.framework = 'Hono';

            if (has('react')) stack.ui = (stack.ui ? stack.ui + ' + ' : '') + 'React';
            if (has('vue')) stack.ui = (stack.ui ? stack.ui + ' + ' : '') + 'Vue';
            if (has('svelte')) stack.ui = (stack.ui ? stack.ui + ' + ' : '') + 'Svelte';
            if (has('@angular/core')) stack.ui = (stack.ui ? stack.ui + ' + ' : '') + 'Angular';

            if (has('prisma') || has('@prisma/client')) stack.db = 'Prisma';
            else if (has('mongoose')) stack.db = 'MongoDB (Mongoose)';
            else if (has('typeorm')) stack.db = 'TypeORM';
            else if (has('drizzle-orm')) stack.db = 'Drizzle';
            else if (has('sequelize')) stack.db = 'Sequelize';
            else if (has('@supabase/supabase-js')) stack.db = 'Supabase';

            if (has('jest')) stack.test = 'Jest';
            else if (has('vitest')) stack.test = 'Vitest';
            else if (has('mocha')) stack.test = 'Mocha';
            if (has('@playwright/test')) stack.test = (stack.test ? stack.test + ' + ' : '') + 'Playwright';

            if (has('bullmq') || has('bull')) stack.queue = 'BullMQ';
            if (has('ioredis') || has('redis')) stack.queue = (stack.queue ? stack.queue + ' + ' : '') + 'Redis';

            return stack;
        } catch {}
    }

    // ------------------------------------------------------------------
    // Python — use parsers (avoids false positives from comments)
    // ------------------------------------------------------------------
    const hasPyproject = fs.existsSync(path.join(dir, 'pyproject.toml'));
    const hasRequirements = fs.existsSync(path.join(dir, 'requirements.txt'));
    if (hasPyproject || hasRequirements) {
        stack.runtime = 'Python';
        stack.language = 'Python';

        const deps = new Set([
            ...parseRequirementsTxt(path.join(dir, 'requirements.txt')),
            ...parsePyprojectToml(path.join(dir, 'pyproject.toml')),
        ]);

        if (deps.has('django')) stack.framework = 'Django';
        else if (deps.has('fastapi')) stack.framework = 'FastAPI';
        else if (deps.has('flask')) stack.framework = 'Flask';

        if (deps.has('pytest')) stack.test = 'pytest';
    }

    // ------------------------------------------------------------------
    // Go — use parseGoMod for framework detection
    // ------------------------------------------------------------------
    const goModPath = path.join(dir, 'go.mod');
    if (fs.existsSync(goModPath)) {
        stack.runtime = 'Go';
        stack.language = 'Go';

        const deps = parseGoMod(goModPath);
        if (deps.some(d => d.includes('gin-gonic/gin'))) stack.framework = 'Gin';
        else if (deps.some(d => d.includes('gofiber/fiber'))) stack.framework = 'Fiber';
        else if (deps.some(d => d.includes('labstack/echo'))) stack.framework = 'Echo';
        else if (deps.some(d => d.includes('gorilla/mux'))) stack.framework = 'Gorilla Mux';
    }

    // ------------------------------------------------------------------
    // Rust — use parseCargoToml for framework detection
    // ------------------------------------------------------------------
    const cargoPath = path.join(dir, 'Cargo.toml');
    if (fs.existsSync(cargoPath)) {
        stack.runtime = 'Rust';
        stack.language = 'Rust';

        const deps = parseCargoToml(cargoPath);
        if (deps.includes('actix-web')) stack.framework = 'Actix';
        else if (deps.includes('axum')) stack.framework = 'Axum';
        else if (deps.includes('rocket')) stack.framework = 'Rocket';
    }

    // ------------------------------------------------------------------
    // Java — file-existence-only (XML/Gradle too complex to parse)
    // ------------------------------------------------------------------
    if (fs.existsSync(path.join(dir, 'pom.xml'))) {
        stack.runtime = 'JVM';
        stack.language = 'Java';
    }
    if (fs.existsSync(path.join(dir, 'build.gradle'))) {
        stack.runtime = 'JVM';
        stack.language = 'Java/Kotlin';
    }

    // ------------------------------------------------------------------
    // PHP — use parseComposerJson for framework detection
    // ------------------------------------------------------------------
    const composerPath = path.join(dir, 'composer.json');
    if (fs.existsSync(composerPath)) {
        stack.runtime = 'PHP';
        stack.language = 'PHP';

        const deps = parseComposerJson(composerPath);
        if (deps.some(d => d === 'laravel/framework')) stack.framework = 'Laravel';
        else if (deps.some(d => d.startsWith('symfony/'))) stack.framework = 'Symfony';
    }

    // ------------------------------------------------------------------
    // Ruby — use parseGemfile for framework detection
    // ------------------------------------------------------------------
    const gemfilePath = path.join(dir, 'Gemfile');
    if (fs.existsSync(gemfilePath)) {
        stack.runtime = 'Ruby';
        stack.language = 'Ruby';

        const deps = parseGemfile(gemfilePath);
        if (deps.includes('rails')) stack.framework = 'Rails';
        else if (deps.includes('sinatra')) stack.framework = 'Sinatra';
    }

    return stack;
}

module.exports = { detectExistingProject, detectTechStack };
