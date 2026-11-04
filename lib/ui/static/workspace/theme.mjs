/**
 * Theme manager and xterm palette synchronizer for Omni UI (T09)
 */

export const VALID_THEMES = ['system', 'graphite', 'paper', 'midnight', 'nordic', 'obsidian', 'emerald', 'tokyo'];

export const XTERM_PALETTES = {
    graphite: {
        background: '#f0f4f4',
        foreground: '#242c30',
        cursor: '#242c30',
        cursorAccent: '#f0f4f4',
        selectionBackground: '#dce3e5',
        selectionForeground: '#242c30',
        black: '#242c30',
        red: '#c53030',
        green: '#2f855a',
        yellow: '#d69e2e',
        blue: '#3182ce',
        magenta: '#805ad5',
        cyan: '#319795',
        white: '#edf2f7',
    },
    midnight: {
        background: '#121715',
        foreground: '#e9edeb',
        cursor: '#e9edeb',
        cursorAccent: '#121715',
        selectionBackground: '#333d37',
        selectionForeground: '#e9edeb',
        black: '#16191a',
        red: '#e53e3e',
        green: '#38a169',
        yellow: '#ecc94b',
        blue: '#4299e1',
        magenta: '#9f7aea',
        cyan: '#38b2ac',
        white: '#e2e8f0',
    },
    paper: {
        background: '#f1eee5',
        foreground: '#302e27',
        cursor: '#302e27',
        cursorAccent: '#f1eee5',
        selectionBackground: '#ddd7c9',
        selectionForeground: '#302e27',
        black: '#302e27',
        red: '#9b2c2c',
        green: '#276749',
        yellow: '#b7791f',
        blue: '#2c5282',
        magenta: '#6b46c1',
        cyan: '#285e61',
        white: '#f7fafc',
    },
    nordic: {
        background: '#191c24',
        foreground: '#eceff4',
        cursor: '#88c0d0',
        cursorAccent: '#191c24',
        selectionBackground: '#3b4252',
        selectionForeground: '#eceff4',
        black: '#2e3440',
        red: '#bf616a',
        green: '#a3be8c',
        yellow: '#ebcb8b',
        blue: '#81a1c1',
        magenta: '#b48ead',
        cyan: '#88c0d0',
        white: '#e5e9f0',
    },
    obsidian: {
        background: '#050506',
        foreground: '#f3f4f6',
        cursor: '#f59e0b',
        cursorAccent: '#050506',
        selectionBackground: '#272d34',
        selectionForeground: '#f3f4f6',
        black: '#16191d',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#f9fafb',
    },
    emerald: {
        background: '#09100d',
        foreground: '#e3ece7',
        cursor: '#34d399',
        cursorAccent: '#09100d',
        selectionBackground: '#1e3027',
        selectionForeground: '#e3ece7',
        black: '#17261f',
        red: '#ef4444',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#38bdf8',
        magenta: '#a78bfa',
        cyan: '#2dd4bf',
        white: '#f0fdf4',
    },
    tokyo: {
        background: '#13141c',
        foreground: '#c0caf5',
        cursor: '#7aa2f7',
        cursorAccent: '#13141c',
        selectionBackground: '#283457',
        selectionForeground: '#c0caf5',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#c0caf5',
    },
};

export function resolveTheme(themeName, isDark = false) {
    if (themeName === 'system') {
        return isDark ? 'midnight' : 'graphite';
    }
    if (VALID_THEMES.includes(themeName)) {
        return themeName;
    }
    return 'graphite';
}

export function paletteForXterm(themeName, isDark = false) {
    const resolved = resolveTheme(themeName, isDark);
    return XTERM_PALETTES[resolved] || XTERM_PALETTES.graphite;
}

export function createThemeManager({
    rootElement = null,
    preferencesStore = null,
    onThemeChange = null,
} = {}) {
    let currentTheme = 'system';

    function getSystemDark() {
        if (typeof window !== 'undefined' && window.matchMedia) {
            return window.matchMedia('(prefers-color-scheme: dark)').matches;
        }
        return false;
    }

    function apply() {
        if (rootElement) {
            rootElement.dataset.theme = currentTheme;
        }
        if (typeof onThemeChange === 'function') {
            const resolved = resolveTheme(currentTheme, getSystemDark());
            onThemeChange({
                theme: currentTheme,
                resolved,
                palette: paletteForXterm(currentTheme, getSystemDark()),
            });
        }
    }

    function getTheme() {
        return currentTheme;
    }

    function setTheme(newTheme) {
        if (!VALID_THEMES.includes(newTheme)) {
            throw new Error(`Invalid theme "${newTheme}". Must be one of: ${VALID_THEMES.join(', ')}`);
        }
        currentTheme = newTheme;
        apply();
        if (preferencesStore) {
            try {
                const current = preferencesStore.read();
                preferencesStore.write({ ...current, theme: newTheme }, current.revision);
            } catch {}
        }
    }

    return {
        getTheme,
        setTheme,
        resolveTheme: (isDark) => resolveTheme(currentTheme, isDark),
        paletteForXterm: (isDark) => paletteForXterm(currentTheme, isDark),
    };
}
