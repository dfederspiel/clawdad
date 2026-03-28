// Theme presets and application logic

const COLOR_KEYS = [
  'bg', 'bg2', 'bg3', 'bgHover',
  'txt', 'txt2', 'txtMuted',
  'accent', 'accentDim',
  'userbg', 'asstbg', 'border', 'err',
];

// CSS var name mapping
const VAR_MAP = {
  bg: '--bg', bg2: '--bg2', bg3: '--bg3', bgHover: '--bg-hover',
  txt: '--txt', txt2: '--txt2', txtMuted: '--txt-muted',
  accent: '--accent', accentDim: '--accent-dim',
  userbg: '--userbg', asstbg: '--asstbg', border: '--border', err: '--err',
};

export const THEMES = [
  {
    name: 'dark',
    label: 'Dark',
    colors: {
      bg: '#0f1117', bg2: '#161922', bg3: '#1e2130', bgHover: '#252940',
      txt: '#e1e4ed', txt2: '#8b8fa3', txtMuted: '#5e6275',
      accent: '#6c8aff', accentDim: '#3d5199',
      userbg: '#1a2744', asstbg: '#1c1f2e', border: '#2a2d3e', err: '#ff6b6b',
    },
  },
  {
    name: 'light',
    label: 'Light',
    colors: {
      bg: '#ffffff', bg2: '#f5f5f7', bg3: '#ebebed', bgHover: '#e0e0e4',
      txt: '#1a1a1a', txt2: '#666666', txtMuted: '#999999',
      accent: '#0066cc', accentDim: '#99c2e8',
      userbg: '#d4e3ff', asstbg: '#f0f0f2', border: '#d8d8dc', err: '#d32f2f',
    },
  },
  {
    name: 'midnight',
    label: 'Midnight',
    colors: {
      bg: '#0a0e1a', bg2: '#101628', bg3: '#171e34', bgHover: '#1f2847',
      txt: '#d4daf0', txt2: '#7b84a3', txtMuted: '#4e5672',
      accent: '#7c9aff', accentDim: '#3a4f8a',
      userbg: '#162050', asstbg: '#121833', border: '#222a44', err: '#ff7070',
    },
  },
  {
    name: 'warm',
    label: 'Warm',
    colors: {
      bg: '#f5f0eb', bg2: '#ede6de', bg3: '#e2d9cf', bgHover: '#d8cec2',
      txt: '#2c2420', txt2: '#78706a', txtMuted: '#a39890',
      accent: '#d4824a', accentDim: '#e8c4a0',
      userbg: '#fbe4cc', asstbg: '#efe8e0', border: '#d5cbc0', err: '#c0392b',
    },
  },
];

export function applyTheme(colors) {
  const root = document.documentElement;
  for (const [key, varName] of Object.entries(VAR_MAP)) {
    if (colors[key]) root.style.setProperty(varName, colors[key]);
  }
}

export function getThemeByName(name) {
  return THEMES.find((t) => t.name === name);
}

export function validateThemeJson(json) {
  if (!json || typeof json !== 'object') return 'Invalid JSON';
  if (!json.colors || typeof json.colors !== 'object') return 'Missing "colors" object';
  const hexPattern = /^#[0-9a-fA-F]{6}$/;
  for (const key of COLOR_KEYS) {
    if (!json.colors[key]) return `Missing color: ${key}`;
    if (!hexPattern.test(json.colors[key])) return `Invalid hex for "${key}": ${json.colors[key]}`;
  }
  return null; // valid
}

export function buildExportJson(name, colors) {
  return { name: name || 'Custom Theme', version: 1, colors };
}

export function getCurrentColors() {
  const root = document.documentElement;
  const colors = {};
  for (const [key, varName] of Object.entries(VAR_MAP)) {
    colors[key] = getComputedStyle(root).getPropertyValue(varName).trim();
  }
  return colors;
}

export { COLOR_KEYS };
