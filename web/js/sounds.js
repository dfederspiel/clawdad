// Notification sounds synthesized via Web Audio API.
// Each tone is a short sequence of sine/triangle waves with decay envelopes.
// No external audio files needed.

let audioCtx = null;

function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

// Resume audio context on first user interaction (browser autoplay policy)
function ensureResumed() {
  const ctx = getCtx();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
document.addEventListener('click', ensureResumed, { once: true });
document.addEventListener('keydown', ensureResumed, { once: true });

function playTone(freq, duration, type = 'sine', gain = 0.3, delay = 0) {
  const ctx = getCtx();
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0, ctx.currentTime + delay);
  env.gain.linearRampToValueAtTime(gain, ctx.currentTime + delay + 0.02);
  env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + duration);
  osc.connect(env);
  env.connect(ctx.destination);
  osc.start(ctx.currentTime + delay);
  osc.stop(ctx.currentTime + delay + duration);
}

// --- Tone library ---

export const TONES = {
  chime: {
    name: 'Chime',
    play() {
      playTone(880, 0.15, 'sine', 0.25);
      playTone(1320, 0.2, 'sine', 0.2, 0.1);
    },
  },
  droplet: {
    name: 'Droplet',
    play() {
      playTone(1200, 0.12, 'sine', 0.3);
      playTone(900, 0.18, 'sine', 0.15, 0.08);
    },
  },
  bell: {
    name: 'Bell',
    play() {
      playTone(660, 0.4, 'sine', 0.2);
      playTone(990, 0.3, 'triangle', 0.1, 0.05);
      playTone(1320, 0.2, 'sine', 0.08, 0.1);
    },
  },
  pulse: {
    name: 'Pulse',
    play() {
      playTone(440, 0.08, 'square', 0.15);
      playTone(440, 0.08, 'square', 0.15, 0.12);
    },
  },
  ping: {
    name: 'Ping',
    play() {
      playTone(1400, 0.1, 'sine', 0.25);
    },
  },
  melody: {
    name: 'Melody',
    play() {
      playTone(523, 0.12, 'triangle', 0.2);       // C5
      playTone(659, 0.12, 'triangle', 0.18, 0.1);  // E5
      playTone(784, 0.2, 'triangle', 0.15, 0.2);   // G5
    },
  },
  none: {
    name: 'Silent',
    play() {},
  },
};

export const TONE_NAMES = Object.keys(TONES);
export const DEFAULT_TONE = 'chime';

// --- Per-group tone preferences (localStorage) ---

const STORAGE_KEY = 'clawdad-group-tones';

function loadTonePrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch { return {}; }
}

function saveTonePrefs(prefs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

export function getGroupTone(jid) {
  return loadTonePrefs()[jid] || DEFAULT_TONE;
}

export function setGroupTone(jid, tone) {
  const prefs = loadTonePrefs();
  prefs[jid] = tone;
  saveTonePrefs(prefs);
}

export function playGroupTone(jid) {
  const toneName = getGroupTone(jid);
  const tone = TONES[toneName];
  if (tone) tone.play();
}

// Global mute
const MUTE_KEY = 'clawdad-muted';
export function isMuted() {
  return localStorage.getItem(MUTE_KEY) === '1';
}
export function setMuted(muted) {
  localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
}

export function playNotification(jid) {
  if (isMuted()) return;
  playGroupTone(jid);
}

export function previewTone(toneName) {
  const tone = TONES[toneName];
  if (tone) tone.play();
}
