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

// Frequency-swept tone (rising or falling)
function playSwept(startFreq, endFreq, duration, type = 'sine', gain = 0.25, delay = 0) {
  const ctx = getCtx();
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(startFreq, ctx.currentTime + delay);
  osc.frequency.exponentialRampToValueAtTime(endFreq, ctx.currentTime + delay + duration);
  env.gain.setValueAtTime(0, ctx.currentTime + delay);
  env.gain.linearRampToValueAtTime(gain, ctx.currentTime + delay + 0.015);
  env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + duration);
  osc.connect(env);
  env.connect(ctx.destination);
  osc.start(ctx.currentTime + delay);
  osc.stop(ctx.currentTime + delay + duration);
}

// --- Tone library ---
// Organized by character: gentle → bright → musical → mechanical → ambient

export const TONES = {
  // --- Gentle ---
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
  whisper: {
    name: 'Whisper',
    play() {
      playTone(1600, 0.08, 'sine', 0.12);
      playTone(1400, 0.12, 'sine', 0.08, 0.06);
    },
  },
  dewdrop: {
    name: 'Dewdrop',
    play() {
      playSwept(1800, 800, 0.2, 'sine', 0.2);
    },
  },
  bubble: {
    name: 'Bubble',
    play() {
      playSwept(400, 1200, 0.1, 'sine', 0.2);
      playSwept(500, 1400, 0.1, 'sine', 0.15, 0.08);
    },
  },

  // --- Bright ---
  ping: {
    name: 'Ping',
    play() {
      playTone(1400, 0.1, 'sine', 0.25);
    },
  },
  sparkle: {
    name: 'Sparkle',
    play() {
      playTone(2400, 0.06, 'sine', 0.15);
      playTone(2800, 0.06, 'sine', 0.12, 0.05);
      playTone(3200, 0.08, 'sine', 0.08, 0.1);
    },
  },
  twinkle: {
    name: 'Twinkle',
    play() {
      playTone(1047, 0.08, 'sine', 0.2);   // C6
      playTone(1319, 0.08, 'sine', 0.18, 0.07);  // E6
      playTone(1568, 0.08, 'sine', 0.15, 0.14);  // G6
      playTone(2093, 0.12, 'sine', 0.1, 0.21);   // C7
    },
  },
  coin: {
    name: 'Coin',
    play() {
      playTone(988, 0.06, 'square', 0.12);   // B5
      playTone(1319, 0.15, 'square', 0.1, 0.06); // E6
    },
  },

  // --- Musical ---
  bell: {
    name: 'Bell',
    play() {
      playTone(660, 0.4, 'sine', 0.2);
      playTone(990, 0.3, 'triangle', 0.1, 0.05);
      playTone(1320, 0.2, 'sine', 0.08, 0.1);
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
  harp: {
    name: 'Harp',
    play() {
      playTone(523, 0.3, 'sine', 0.15);        // C5
      playTone(659, 0.25, 'sine', 0.13, 0.04); // E5
      playTone(784, 0.2, 'sine', 0.11, 0.08);  // G5
      playTone(1047, 0.18, 'sine', 0.09, 0.12); // C6
      playTone(1319, 0.15, 'sine', 0.07, 0.16); // E6
    },
  },
  celeste: {
    name: 'Celeste',
    play() {
      playTone(784, 0.25, 'triangle', 0.15);    // G5
      playTone(988, 0.25, 'triangle', 0.12, 0.15); // B5
      playTone(1175, 0.3, 'triangle', 0.1, 0.3);   // D6
    },
  },
  marimba: {
    name: 'Marimba',
    play() {
      playTone(524, 0.15, 'triangle', 0.3);
      playTone(524 * 4, 0.08, 'sine', 0.08); // harmonic
      playTone(659, 0.15, 'triangle', 0.25, 0.12);
      playTone(659 * 4, 0.06, 'sine', 0.06, 0.12);
    },
  },
  doorbell: {
    name: 'Doorbell',
    play() {
      playTone(659, 0.3, 'sine', 0.2);    // E5 — ding
      playTone(523, 0.4, 'sine', 0.18, 0.25); // C5 — dong
    },
  },
  lullaby: {
    name: 'Lullaby',
    play() {
      playTone(392, 0.2, 'sine', 0.15);       // G4
      playTone(440, 0.2, 'sine', 0.13, 0.15); // A4
      playTone(523, 0.3, 'sine', 0.12, 0.3);  // C5
    },
  },

  // --- Mechanical ---
  pulse: {
    name: 'Pulse',
    play() {
      playTone(440, 0.08, 'square', 0.15);
      playTone(440, 0.08, 'square', 0.15, 0.12);
    },
  },
  click: {
    name: 'Click',
    play() {
      playTone(800, 0.03, 'square', 0.2);
      playTone(400, 0.02, 'square', 0.1, 0.03);
    },
  },
  radar: {
    name: 'Radar',
    play() {
      playSwept(600, 1200, 0.15, 'sine', 0.2);
      playSwept(600, 1200, 0.15, 'sine', 0.12, 0.25);
    },
  },
  sonar: {
    name: 'Sonar',
    play() {
      playTone(440, 0.3, 'sine', 0.2);
      playTone(440, 0.2, 'sine', 0.1, 0.4);
    },
  },
  tap: {
    name: 'Tap',
    play() {
      playTone(600, 0.04, 'triangle', 0.25);
      playTone(1200, 0.03, 'triangle', 0.1, 0.01);
    },
  },

  // --- Easter eggs ---
  treasure: {
    name: 'Treasure',
    play() {
      // da-da da-da da-da DAAA — chest opening fanfare
      const n = (f, d, dl) => playTone(f, d, 'square', 0.13, dl);
      n(587, 0.08, 0);     // D5
      n(587, 0.08, 0.09);  // D5
      n(587, 0.08, 0.18);  // D5
      n(587, 0.08, 0.27);  // D5
      n(587, 0.08, 0.36);  // D5
      n(587, 0.08, 0.45);  // D5
      // sustained rising resolution
      playTone(659, 0.12, 'square', 0.14, 0.54);  // E5
      playTone(698, 0.12, 'square', 0.14, 0.63);  // F5
      playTone(784, 0.35, 'square', 0.16, 0.72);  // G5 — hold
    },
  },
  secret: {
    name: 'Secret',
    play() {
      // discovery jingle — ascending puzzle-solved feel
      playTone(784, 0.1, 'triangle', 0.18);        // G5
      playTone(880, 0.1, 'triangle', 0.18, 0.08);  // A5
      playTone(988, 0.1, 'triangle', 0.18, 0.16);  // B5
      playTone(1047, 0.25, 'sine', 0.2, 0.24);     // C6 — resolve
    },
  },
  powerup: {
    name: 'Power Up',
    play() {
      // rapid ascending sweep — collecting something good
      const notes = [262, 330, 392, 523, 659, 784, 1047];
      notes.forEach((f, i) => {
        playTone(f, 0.07, 'square', 0.12, i * 0.04);
      });
    },
  },
  levelup: {
    name: 'Level Up',
    play() {
      // triumphant major chord arpeggio with fanfare
      playTone(523, 0.12, 'triangle', 0.18);        // C5
      playTone(659, 0.12, 'triangle', 0.18, 0.1);   // E5
      playTone(784, 0.12, 'triangle', 0.18, 0.2);   // G5
      playTone(1047, 0.12, 'triangle', 0.2, 0.3);   // C6
      // victory sustain
      playTone(1047, 0.3, 'sine', 0.15, 0.4);       // C6
      playTone(1319, 0.3, 'sine', 0.12, 0.4);       // E6 (major third)
      playTone(1568, 0.35, 'sine', 0.1, 0.4);       // G6 (fifth)
    },
  },
  oneup: {
    name: '1-Up',
    play() {
      // quick bouncy reward
      playTone(660, 0.06, 'square', 0.12);
      playTone(880, 0.06, 'square', 0.12, 0.06);
      playTone(1100, 0.06, 'square', 0.12, 0.12);
      playTone(880, 0.06, 'square', 0.1, 0.18);
      playTone(1100, 0.06, 'square', 0.1, 0.24);
      playTone(1320, 0.15, 'square', 0.12, 0.3);
    },
  },
  gameover: {
    name: 'Game Over',
    play() {
      // descending sad tones
      playTone(494, 0.2, 'triangle', 0.15);       // B4
      playTone(440, 0.2, 'triangle', 0.13, 0.2);  // A4
      playTone(370, 0.2, 'triangle', 0.12, 0.4);  // F#4
      playTone(330, 0.5, 'triangle', 0.1, 0.6);   // E4
    },
  },
  encounter: {
    name: 'Encounter',
    play() {
      // alert! something appeared — quick dramatic sting
      playTone(220, 0.06, 'square', 0.18);
      playTone(220, 0.06, 'square', 0.18, 0.08);
      playTone(220, 0.06, 'square', 0.18, 0.16);
      playTone(277, 0.2, 'square', 0.15, 0.24);  // C#4
      playTone(262, 0.3, 'square', 0.12, 0.44);  // C4 — tension
    },
  },

  // --- Ambient ---
  glow: {
    name: 'Glow',
    play() {
      playSwept(300, 600, 0.4, 'sine', 0.12);
      playSwept(450, 900, 0.35, 'sine', 0.08, 0.05);
    },
  },
  breeze: {
    name: 'Breeze',
    play() {
      playSwept(800, 400, 0.3, 'sine', 0.1);
      playSwept(1200, 600, 0.25, 'sine', 0.07, 0.1);
      playSwept(600, 300, 0.3, 'sine', 0.05, 0.2);
    },
  },
  aurora: {
    name: 'Aurora',
    play() {
      playTone(330, 0.5, 'sine', 0.1);       // E4
      playSwept(330, 660, 0.4, 'sine', 0.08, 0.1);
      playTone(494, 0.4, 'sine', 0.06, 0.25);  // B4
    },
  },

  // --- Silent ---
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
