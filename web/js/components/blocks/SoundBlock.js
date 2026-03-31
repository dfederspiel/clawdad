import { html } from 'htm/preact';
import { useEffect, useRef } from 'preact/hooks';
import { TONES, isMuted } from '../../sounds.js';

// Play a custom tone definition
function playCustom(notes) {
  if (!Array.isArray(notes) || isMuted()) return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();

  for (const note of notes) {
    const { freq, duration = 0.15, type = 'sine', gain = 0.2, delay = 0 } = note;
    if (!freq) continue;

    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;

    // Support frequency sweeps
    if (note.endFreq) {
      osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
      osc.frequency.exponentialRampToValueAtTime(note.endFreq, ctx.currentTime + delay + duration);
    } else {
      osc.frequency.value = freq;
    }

    env.gain.setValueAtTime(0, ctx.currentTime + delay);
    env.gain.linearRampToValueAtTime(gain, ctx.currentTime + delay + 0.015);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + duration);
    osc.connect(env);
    env.connect(ctx.destination);
    osc.start(ctx.currentTime + delay);
    osc.stop(ctx.currentTime + delay + duration);
  }
}

export function SoundBlock({ tone, custom, label }) {
  const played = useRef(false);

  useEffect(() => {
    if (played.current) return;
    played.current = true;

    if (custom) {
      playCustom(custom);
    } else if (tone && TONES[tone]) {
      if (!isMuted()) TONES[tone].play();
    }
  }, []);

  // Visual indicator
  const displayName = tone
    ? (TONES[tone]?.name || tone)
    : 'Custom sound';

  return html`
    <div class="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-bg-3 border border-border text-[11px] text-txt-muted">
      <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.415z" clip-rule="evenodd"/>
      </svg>
      ${label || displayName}
    </div>
  `;
}
