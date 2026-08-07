// Start challenge, Form 27-B, resignation theater, the Certificate of
// Defeat, and the career record (localStorage).

import { crestSVG } from '../pieces.js';
import {
  buildVictoryStats, shareText, CHEAT_NAMES, TOTAL_NAMED_CHEATS,
  RESIGN_REFUSAL, REPORT_NOTES,
} from '../content/copy.js';

const RECORD_KEY = 'mv_record';

export function loadRecord() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECORD_KEY) ?? '{}');
    return { wins: 0, losses: 0, forfeits: 0, ...raw };
  } catch {
    return { wins: 0, losses: 0, forfeits: 0 };
  }
}

export function saveRecord(record) {
  try {
    localStorage.setItem(RECORD_KEY, JSON.stringify(record));
  } catch { /* private browsing: MottyBot forgives, this once */ }
}

export class Overlays {
  constructor() {
    this.veilStart = document.getElementById('veil-start');
    this.veilReport = document.getElementById('veil-report');
    this.veilResign = document.getElementById('veil-resign');
    this.veilVictory = document.getElementById('veil-victory');
    this.reportCount = 0;
    this.resignStage = 0;
    for (const id of ['crest-mount', 'crest-mount-2', 'crest-mount-3']) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = crestSVG();
    }
  }

  // --- start ------------------------------------------------------------

  showStart(record, onBegin) {
    const line =
      record.losses + record.forfeits > 0
        ? `Career record. You: ${record.wins} wins, ${record.losses} losses` +
          (record.forfeits ? `, ${record.forfeits} forfeits (recorded as cowardice)` : '') +
          '. MottyBot: undefeated.'
        : 'Career record. You: 0 wins. MottyBot: undefeated.';
    document.getElementById('start-record').textContent = line;
    document.getElementById('btn-begin').onclick = () => {
      this.veilStart.remove();
      onBegin();
    };
  }

  // --- Form 27-B --------------------------------------------------------

  openReport() {
    this.reportCount++;
    const n = 40 + this.reportCount;
    const veil = this.veilReport;
    veil.hidden = false;
    const ticket = document.getElementById('report-ticket');
    const body = document.getElementById('report-body');
    const stampEl = document.getElementById('report-stamp');
    const sig = document.getElementById('report-sig');
    const closeBtn = document.getElementById('btn-report-close');
    ticket.textContent = `Fair Play Ticket #0000${n}`;
    body.textContent = 'Reviewing…';
    stampEl.hidden = true;
    sig.hidden = true;
    closeBtn.hidden = true;
    stampEl.classList.remove('stamp--slam');

    const reviewMs = Math.max(120, 1500 / 2 ** (this.reportCount - 1));
    setTimeout(() => {
      body.textContent = 'Review complete.';
      stampEl.hidden = false;
      stampEl.classList.add('stamp--slam');
      sig.hidden = false;
      const note = REPORT_NOTES[Math.min(this.reportCount, REPORT_NOTES.length - 1)];
      if (note) body.textContent = note;
      closeBtn.hidden = false;
      closeBtn.onclick = () => { veil.hidden = true; };
    }, reviewMs);

    if (this.reportCount >= 6) {
      document.getElementById('btn-report').textContent = 'Report irregularity (resolved)';
    }
  }

  // --- resignation ------------------------------------------------------

  openResign(onAccepted) {
    const veil = this.veilResign;
    const body = document.getElementById('resign-body');
    const confirmBtn = document.getElementById('btn-resign-confirm');
    const cancelBtn = document.getElementById('btn-resign-cancel');
    veil.hidden = false;
    if (this.resignStage === 0) {
      body.textContent = RESIGN_REFUSAL.body;
      confirmBtn.hidden = true;
      this.resignStage = 1;
      cancelBtn.onclick = () => { veil.hidden = true; };
    } else {
      body.textContent = RESIGN_REFUSAL.second;
      confirmBtn.hidden = false;
      cancelBtn.onclick = () => { veil.hidden = true; };
      confirmBtn.onclick = () => {
        veil.hidden = true;
        onAccepted();
      };
    }
  }

  // --- victory ----------------------------------------------------------

  showVictory({ state, record, headline = 'MottyBot wins', sub = 'As foreseen.' }) {
    document.getElementById('victory-headline').textContent = headline;
    document.getElementById('victory-sub').textContent = sub;

    const stats = buildVictoryStats({
      moveNumber: state.moveNumber,
      cheatsFired: state.cheatsFired,
      record,
    });
    document.getElementById('victory-stats').innerHTML = stats
      .map((r) =>
        `<div class="stat"><span class="stat__label">${r.label}</span>` +
        `<b class="stat__value">${r.value}</b>` +
        (r.note ? `<em class="stat__note">${r.note}</em>` : '') +
        '</div>'
      )
      .join('');

    const trophies = document.getElementById('victory-trophies');
    const seen = [...new Set(state.cheatsFired.map((c) => c.id))]
      .map((id) => CHEAT_NAMES[id])
      .filter(Boolean);
    if (seen.length) {
      trophies.innerHTML =
        '<p class="cert__trophies-title">You played well enough to witness</p>' +
        seen.map((name) => `<span class="trophy">${name}</span>`).join('');
    } else {
      trophies.innerHTML =
        '<p class="cert__trophies-title">Locked achievements</p>' +
        `<span class="trophy">Cheats you were not good enough to unlock: ${TOTAL_NAMED_CHEATS}. ` +
        'Play better to see them.</span>';
    }

    // the report can be closed to study the wreckage, and reopened
    const veil = this.veilVictory;
    const pill = document.getElementById('btn-match-report');
    const close = () => { veil.hidden = true; pill.hidden = false; };
    document.getElementById('btn-victory-close').onclick = close;
    veil.onclick = (e) => { if (e.target === veil) close(); };
    pill.onclick = () => { pill.hidden = true; veil.hidden = false; };

    document.getElementById('btn-rematch').onclick = () => location.reload();
    document.getElementById('btn-share').onclick = async () => {
      const text = shareText(location.origin + location.pathname);
      try {
        if (navigator.share) await navigator.share({ text });
        else {
          await navigator.clipboard.writeText(text);
          document.getElementById('btn-share').textContent = 'Confession copied';
        }
      } catch { /* they chickened out of confessing; recorded */ }
    };

    this.veilVictory.hidden = false;
  }
}
