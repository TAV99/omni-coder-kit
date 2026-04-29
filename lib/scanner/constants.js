const IGNORED_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '__pycache__', 'vendor',
    '.next', 'target', '.omni', '.claude', '.codex', '.cursor',
    'coverage', '.nyc_output', '.cache', 'tmp', '.tmp',
]);

const MANIFEST_FILES = {
    'package.json': 'Node.js',
    'pyproject.toml': 'Python',
    'requirements.txt': 'Python',
    'setup.py': 'Python',
    'go.mod': 'Go',
    'Cargo.toml': 'Rust',
    'pom.xml': 'Java',
    'build.gradle': 'Java/Kotlin',
    'Gemfile': 'Ruby',
    'composer.json': 'PHP',
};

const MAX_DEPTH = 4;
const MAX_LANDMINES = 50;
const MAX_FILE_SIZE = 1 * 1024 * 1024;

const SOURCE_EXTENSIONS = new Set([
    '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.kt',
    '.rb', '.php', '.c', '.cpp', '.h', '.cs', '.swift', '.vue', '.svelte',
]);

module.exports = { IGNORED_DIRS, MANIFEST_FILES, MAX_DEPTH, MAX_LANDMINES, MAX_FILE_SIZE, SOURCE_EXTENSIONS };
