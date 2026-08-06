// Plaques, status rotator, MottyEval™, trays, move record, tier cosmetics.

import { pieceSVG } from '../pieces.js';
import { RESIGN_LABELS } from '../content/copy.js';

export class Panels {
  constructor(commentary) {
    this.commentary = commentary;
    this.statusEl = document.getElementById('bot-status');
    this.youStatusEl = document.getElementById('you-status');
    this.evalTrack = document.getElementById('eval-track');
    this.evalFill = document.getElementById('eval-fill');
    this.evalValue = document.getElementById('eval-value');
    this.trayBot = document.getElementById('tray-bot-pieces');
    this.trayYou = document.getElementById('tray-you-pieces');
    this.moveList = document.getElementById('move-list');
    this.resignBtn = document.getElementById('btn-resign');
    this.badgeRecert = document.getElementById('badge-recert');
    this.statusTimer = null;
    this.retroAmended = new Set();
  }

  // --- status -----------------------------------------------------------

  setThinking(on) {
    clearInterval(this.statusTimer);
    if (on) {
      const rotate = () => {
        const line = this.commentary.line('status_thinking') ?? 'thinking…';
        this.statusEl.innerHTML =
          `${line.replace(/…$/, '')}<span class="thinking-dots"><i></i><i></i><i></i></span>`;
      };
      rotate();
      this.statusTimer = setInterval(rotate, 2400);
    }
  }

  setStatus(text) {
    clearInterval(this.statusTimer);
    this.statusEl.textContent = text;
  }

  // --- MottyEval™ -------------------------------------------------------

  // assessCp: Black's (MottyBot's) perspective. The bar physically cannot
  // show MottyBot behind.
  updateEval(assessCp, tier, mateSoon = false) {
    const shown = Math.max(30, assessCp ?? 30);
    let share = Math.min(0.97, 0.53 + shown / 2400);
    let label;
    if (mateSoon || tier >= 3) {
      share = 0.98;
      label = '+M∞';
    } else if (tier === 2) {
      label = `+${(shown / 100).toFixed(2)} (verified)`;
    } else {
      label = `MB +${(shown / 100).toFixed(1)}`;
    }
    this.evalFill.style.transform = `scaleX(${share})`;
    this.evalValue.textContent = label;
  }

  // the tell: dips toward the player for 200ms, then snaps back
  recalibrate() {
    const prev = this.evalFill.style.transform;
    this.evalFill.style.transform = 'scaleX(0.42)';
    setTimeout(() => {
      this.evalFill.style.transform = prev || 'scaleX(0.53)';
      this.evalTrack.classList.add('is-recalibrating');
      this.evalTrack.title = 'Recalibrated.';
      setTimeout(() => this.evalTrack.classList.remove('is-recalibrating'), 400);
    }, 220);
  }

  // --- trays ------------------------------------------------------------

  updateTrays(captured) {
    this.trayBot.innerHTML = captured.white
      .map((t) => `<span class="mini mini--w">${pieceSVG(t)}</span>`)
      .join('');
    this.trayYou.innerHTML = captured.black
      .map((t) => `<span class="mini mini--b">${pieceSVG(t)}</span>`)
      .join('');
  }

  // --- move record ------------------------------------------------------

  updateMoveList(moveLog) {
    const rows = new Map();
    for (const entry of moveLog) {
      let row = rows.get(entry.num);
      if (!row) {
        row = { num: entry.num, w: '', b: '', bCheat: false };
        rows.set(entry.num, row);
      }
      if (entry.side === 'w') row.w = entry.text;
      else {
        row.b = row.b ? `${row.b}; ${entry.text}` : entry.text;
        if (entry.cheat) row.bCheat = true;
      }
    }
    this.moveList.innerHTML = [...rows.values()]
      .map((r) => {
        const amended = this.retroAmended.has(r.num);
        return (
          `<li class="record__row${amended ? ' record__row--edited' : ''}">` +
          `<span class="record__num">${r.num}.</span>` +
          `<span class="record__w">${escapeHTML(r.w) || '…'}</span>` +
          `<span class="record__b${r.bCheat ? ' record__b--cheat' : ''}">` +
          `${escapeHTML(r.b)}${amended ? ' <em>(amended)</em>' : ''}</span></li>`
        );
      })
      .join('');
    this.moveList.scrollTop = this.moveList.scrollHeight;
  }

  // the historical record changes in front of the player
  amendHistory(currentMoveNumber) {
    const eligible = [];
    for (let n = 1; n < currentMoveNumber - 1; n++) {
      if (!this.retroAmended.has(n)) eligible.push(n);
    }
    if (!eligible.length) return;
    this.retroAmended.add(eligible[Math.floor(Math.random() * eligible.length)]);
  }

  // --- tier cosmetics ---------------------------------------------------

  applyTier(tier) {
    this.resignBtn.textContent = RESIGN_LABELS[Math.min(3, tier)];
    if (tier >= 2) this.badgeRecert.hidden = false;
  }
}

const escapeHTML = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
