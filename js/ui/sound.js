// Tiny WebAudio synth: wooden clicks for moves, a shimmer for teleports.
// No samples, no network, nothing copyrighted.

let ctx = null;
let muted = localStorage.getItem('mv-muted') === '1';

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function blip({ freq = 200, to = freq, dur = .06, type = 'sine', gain = .18, when = 0 }) {
  if (muted) return;
  try {
    const c = ac();
    const t0 = c.currentTime + when;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (to !== freq) o.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0); o.stop(t0 + dur + .02);
  } catch { /* audio is never worth crashing over */ }
}

export const sound = {
  get muted() { return muted; },
  toggle() { muted = !muted; localStorage.setItem('mv-muted', muted ? '1' : '0'); return muted; },
  unlock() { if (!muted) try { ac(); } catch {} },
  move() { blip({ freq: 260, to: 180, dur: .055, type: 'triangle', gain: .22 }); },
  capture() {
    blip({ freq: 190, to: 120, dur: .07, type: 'triangle', gain: .26 });
    blip({ freq: 750, to: 500, dur: .03, type: 'square', gain: .05 });
  },
  teleport() {
    blip({ freq: 340, to: 980, dur: .16, type: 'sine', gain: .1 });
    blip({ freq: 620, to: 1350, dur: .14, type: 'sine', gain: .06, when: .05 });
  },
  check() { blip({ freq: 620, dur: .09, type: 'square', gain: .07 }); blip({ freq: 830, dur: .1, type: 'square', gain: .06, when: .09 }); },
  start() { blip({ freq: 392, dur: .09, gain: .12 }); blip({ freq: 523, dur: .12, gain: .12, when: .09 }); },
  end(win) {
    if (win) { blip({ freq: 523, dur: .1, gain: .13 }); blip({ freq: 659, dur: .1, gain: .13, when: .1 }); blip({ freq: 784, dur: .18, gain: .13, when: .2 }); }
    else { blip({ freq: 330, dur: .12, gain: .12 }); blip({ freq: 262, dur: .2, gain: .12, when: .12 }); }
  },
  illegal() { blip({ freq: 140, dur: .08, type: 'sawtooth', gain: .07 }); },
};
