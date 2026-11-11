'use strict';

// Local Preview Runner for Omni UI (codex/omni-ui)
// Serves the approved interactive prototype mockup (port 3847)
// and the baseline P6 UI server (port 3848).

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const Module = require('node:module');

const mainModules = '/Users/ben/Documents/omni-coder-kit/node_modules';
if (fs.existsSync(mainModules)) {
    Module.globalPaths.push(mainModules);
    Module._initPaths();
}

const WORKTREE_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_FRAGMENT = path.join(WORKTREE_ROOT, 'docs', 'omni-ui', 'references', 'workspace.fragment.html');
const BINDING_FRAGMENT = path.join(WORKTREE_ROOT, 'docs', 'omni-ui', 'references', 'role-binding.fragment.html');
const TEMPLATES = path.join(WORKTREE_ROOT, 'templates', 'squad');

const { createAuthorityStore } = require('../lib/dual/authority-store');
const gates = require('../lib/dual/approval-gates');
const { writeBinding } = require('../lib/squad/bindings');
const { startUiServer } = require('../lib/ui/server');

function openBrowser(url) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try {
        spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
        return true;
    } catch {
        return false;
    }
}

const ICONS = {
    'panel-right-close': '<svg class="lucide" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m8 9 3 3-3 3"/></svg>',
    'plus': '<svg class="lucide" viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
    'list-tree': '<svg class="lucide" viewBox="0 0 24 24"><path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/></svg>',
    'terminal': '<svg class="lucide" viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>',
    'folder-open': '<svg class="lucide" viewBox="0 0 24 24"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>',
    'panels-top-left': '<svg class="lucide" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>',
    'gauge': '<svg class="lucide" viewBox="0 0 24 24"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>',
    'link': '<svg class="lucide" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    'arrow-up': '<svg class="lucide" viewBox="0 0 24 24"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>',
    'file-text': '<svg class="lucide" viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
};

function buildHtml({ content, activeTab, p6Url }) {
    return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Omni UI — Live Preview</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    background: #121516;
    color: #e5e7eb;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  svg.lucide {
    width: 14px;
    height: 14px;
    stroke: currentColor;
    stroke-width: 2;
    fill: none;
    vertical-align: middle;
    display: inline-block;
  }
  .preview-top-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 18px;
    background: #181c1e;
    border-bottom: 1px solid #282f33;
    font-size: 13px;
    position: sticky;
    top: 0;
    z-index: 9999;
  }
  .preview-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 600;
  }
  .preview-tag {
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 4px;
    background: #252e33;
    color: #94a3b8;
    font-family: ui-monospace, monospace;
  }
  .preview-nav {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .preview-nav a {
    color: #94a3b8;
    text-decoration: none;
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    transition: all 0.15s ease;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .preview-nav a:hover {
    color: #f1f5f9;
    background: #252e33;
  }
  .preview-nav a.active {
    color: #38bdf8;
    background: #1e293b;
    border: 1px solid #0284c7;
  }
  .preview-container {
    max-width: 1440px;
    margin: 0 auto;
    padding: 16px;
  }
</style>
</head>
<body>
  <div class="preview-top-bar">
    <div class="preview-brand">
      <span style="color:#38bdf8;">❖</span>
      <span>Omni UI — Live Preview</span>
      <span class="preview-tag">codex/omni-ui</span>
    </div>
    <div class="preview-nav">
      <a href="/workspace" class="${activeTab === 'workspace' ? 'active' : ''}">3-Region Workspace (Bản mẫu đã duyệt)</a>
      <a href="/binding" class="${activeTab === 'binding' ? 'active' : ''}">Role Binding Editor (Bản mẫu đã duyệt)</a>
      ${p6Url ? `<a href="${p6Url}" target="_blank" style="color:#a78bfa; border:1px solid #7c3aed40; background:#7c3aed15;">Giao diện P6 gốc đang chạy (Port 3848) ↗</a>` : ''}
    </div>
  </div>
  <div class="preview-container">
    ${content}
  </div>
  <script>
    const ICONS = ${JSON.stringify(ICONS)};
    function renderIcons() {
      document.querySelectorAll('i[data-lucide]').forEach(el => {
        const name = el.getAttribute('data-lucide');
        if (ICONS[name]) {
          const span = document.createElement('span');
          span.innerHTML = ICONS[name];
          const svg = span.firstElementChild;
          if (svg) {
            el.parentNode.replaceChild(svg, el);
          }
        }
      });
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', renderIcons);
    } else {
      renderIcons();
    }
  </script>
</body>
</html>`;
}

function setupSampleSquadProject() {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-ui-preview-')));
    const squadDir = path.join(root, '.omni', 'squad');
    fs.mkdirSync(path.join(squadDir, 'roles'), { recursive: true });
    if (fs.existsSync(path.join(TEMPLATES, 'roles'))) {
        for (const name of fs.readdirSync(path.join(TEMPLATES, 'roles'))) {
            fs.copyFileSync(path.join(TEMPLATES, 'roles', name), path.join(squadDir, 'roles', name));
        }
    }
    if (fs.existsSync(path.join(TEMPLATES, 'pipelines', 'dual.yaml'))) {
        fs.copyFileSync(path.join(TEMPLATES, 'pipelines', 'dual.yaml'), path.join(squadDir, 'pipeline.yaml'));
    }
    writeBinding(root, {
        schema_version: 1, preset: 'dual', updated_at: '2026-11-04T00:00:00Z', roles: {
            orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
            worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }],
            reviewer: null
        }
    });
    const store = createAuthorityStore(path.join(root, '.omni', 'runs', 'dual-authority'));
    store.append({
        schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'ws-preview', session_id: 'session-preview-024', plan_revision: 1, expected_baseline: { kind: 'git', id: '0'.repeat(40) }, mode: 'auto'
    });
    store.append({
        schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        details: { agy_version: '1.1.27', agy_model: 'gemini-3.8-flash-high' }
    });
    store.append({
        schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'docs/SPEC-OMNI-UI-WORKSPACE.md', plan_sha256: 'a'.repeat(64), total_tasks: 2,
        tasks: [
            { task_id: 'TASK-UI-01', title: 'Thiết kế bố cục 3 vùng (Sidebar, Workspace, Context)', goal: 'Deliver three-region layout', owner: 'agy', risk: 'low', execution_mode: 'isolated', allowed_files: ['lib/ui/static/*'], context_files: [], deny_patterns: [], validation_commands: [] },
            { task_id: 'TASK-UI-02', title: 'Tích hợp Context panel tabs và splits', goal: 'Support tabs and splits', owner: 'agy', risk: 'low', execution_mode: 'isolated', allowed_files: ['lib/ui/static/*'], context_files: [], deny_patterns: [], validation_commands: [] }
        ]
    });
    gates.requireApproval(store, { phase: 'integrate', taskId: 'TASK-UI-01', digest: 'c'.repeat(64), summary: 'Tích hợp TASK-UI-01 vào workspace' });
    return root;
}

async function main() {
    let p6Root = null;
    let p6Server = null;
    let p6Url = '';

    try {
        p6Root = setupSampleSquadProject();
        p6Server = await startUiServer({ projectRoot: p6Root, port: 3848, autoStart: false });
        p6Url = p6Server.url;
        console.log(`[P6 Server] Running at: ${p6Url}`);
    } catch (err) {
        console.warn(`[P6 Server] Could not start P6 server on port 3848:`, err.message);
    }

    const previewServer = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1:3847');
        const pathname = url.pathname.replace(/\/+$/, '') || '/';

        if (pathname === '/favicon.ico') {
            res.writeHead(204);
            return res.end();
        }

        if (pathname === '/' || pathname === '/workspace') {
            const fragment = fs.existsSync(WORKSPACE_FRAGMENT) ? fs.readFileSync(WORKSPACE_FRAGMENT, 'utf8') : '<p>Missing workspace fragment</p>';
            const html = buildHtml({ content: fragment, activeTab: 'workspace', p6Url });
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } else if (pathname === '/binding') {
            const fragment = fs.existsSync(BINDING_FRAGMENT) ? fs.readFileSync(BINDING_FRAGMENT, 'utf8') : '<p>Missing binding fragment</p>';
            const html = buildHtml({ content: fragment, activeTab: 'binding', p6Url });
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    });

    const PORT = 3847;
    previewServer.listen(PORT, '127.0.0.1', () => {
        const previewUrl = `http://127.0.0.1:${PORT}`;
        console.log(`\n======================================================`);
        console.log(`🚀 Omni UI Preview Server is LIVE!`);
        console.log(`👉 Preview URL (Mẫu đã duyệt): ${previewUrl}`);
        if (p6Url) {
            console.log(`👉 Baseline P6 UI URL (Server gốc): ${p6Url}`);
        }
        console.log(`======================================================\n`);
        openBrowser(previewUrl);
    });

    const cleanup = async () => {
        console.log('\nShutting down preview server...');
        previewServer.close();
        if (p6Server) {
            await p6Server.close();
        }
        if (p6Root) {
            try { fs.rmSync(p6Root, { recursive: true, force: true }); } catch {}
        }
        process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}

main().catch(err => {
    console.error('Fatal error starting preview runner:', err);
    process.exit(1);
});
