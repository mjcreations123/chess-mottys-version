// Chess (Motty's Version) — the wiring. One rule: the engine is the truth,
// the UI animates the truth, and the truth is rigged.

import { injectSprite } from './pieces.js';
import { MottyGame } from './engine/game.js';
import { BoardView } from './ui/board.js';
import { Effects } from './ui/effects.js';
import { Animator } from './ui/animate.js';
import { Panels } from './ui/panels.js';
import { Feed } from './ui/feed.js';
import { Overlays, loadRecord, saveRecord } from './ui/overlay.js';
import { Input } from './ui/input.js';
import { Commentary } from './content/commentary.js';
import { REJECTION_LINES, CHAT_PLACEHOLDERS } from './content/copy.js';

injectSprite();

const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
const game = new MottyGame({ seed });
const commentary = new Commentary(Math.random);
const boardEl = document.getElementById('board');
const board = new BoardView(boardEl);
const fx = new Effects(document.getElementById('board-fx'));
const animator = new Animator(board, fx);
const panels = new Panels(commentary);
const feed = new Feed(document.getElementById('feed-list'));
const overlays = new Overlays();
const record = loadRecord();

let busy = true; // until the start veil lifts
let started = false;
let gameOver = false;
let lastAssess = 0;
let lastRejection = null;
let idleTimers = [];

const promoSheetOpen = () => !document.getElementById('sheet-promo').hidden;

document.getElementById('chat-input').placeholder =
  CHAT_PLACEHOLDERS[Math.floor(Math.random() * CHAT_PLACEHOLDERS.length)];

board.syncFromState(game.getState());
panels.updateEval(30, 0);
panels.setStatus('awaiting challenger');

const input = new Input(board, game, {
  isBusy: () => busy || game.status !== 'playing',
  onPlayerMove: handlePlayerMove,
});

overlays.showStart(record, () => {
  started = true;
  busy = false;
  panels.setStatus('certified fair');
  // boot sequence: the log should never present as an empty box
  feed.arbiter('Match sanctioned. Regulations loaded. All of them.');
  feed.system('Board certified level. Pieces counted: enough.');
  feed.bot(commentary.line(record.losses + record.forfeits > 0 ? 'rematch_start' : 'game_start', {
    lossCount: record.losses + record.forfeits + 1,
  }));
  scheduleIdle();
});

document.getElementById('btn-report').addEventListener('click', () => overlays.openReport());
document.getElementById('btn-resign').addEventListener('click', () => {
  if (!started || gameOver || game.status !== 'playing') return;
  overlays.openResign(() => {
    if (gameOver || game.status !== 'playing') return;
    game.resign();
    feed.bot(commentary.line('resign_accepted'));
    finishGame({ headline: 'MottyBot wins', sub: 'By resignation. Recorded as checkmate.' });
  });
});

async function handlePlayerMove({ from, to, promo }) {
  if (busy || game.status !== 'playing') return;
  clearIdle();

  const result = game.playerMove({ from, to, promo });

  if (!result.legal) {
    if (result.reason === 'king-bounce') {
      busy = true;
      await animator.play(result.events);
      feed.bot(commentary.line('king_bounce'));
      busy = false;
      scheduleIdle();
      return;
    }
    const repeatKey = `${from}${to}`;
    const targetEl = board.pieceAt(to);
    const kingGrab = targetEl?.dataset.type === 'k' && targetEl?.dataset.color === 'b';
    const pool =
      result.reason.startsWith('phantom-pin') ? result.reason
      : lastRejection === repeatKey ? 'illegal-repeat'
      : kingGrab ? 'king-grab'
      : result.reason;
    lastRejection = repeatKey;
    const lines = REJECTION_LINES[pool] ?? REJECTION_LINES['illegal-target'];
    feed.arbiter(lines[Math.floor(Math.random() * lines.length)]);
    board.rejectPiece(from);
    board.flashDenied(to);
    navigator.vibrate?.(60);
    scheduleIdle();
    return;
  }

  lastRejection = null;
  busy = true;
  board.clearSelection();
  board.clearCheck();
  board.clearCaption();

  await playEvents(result.events);
  board.showLastMove(from, to);
  refreshPanels();

  if (game.status !== 'playing') { finishGame({}); return; }

  // MottyBot's turn. The engine's own botReply() already guarantees Black
  // never ends this call with zero legal moves, no matter what breaks
  // internally — but nothing guarantees the ANIMATION or UI layer can't
  // throw on some unrelated fluke, so this whole stretch is defended too.
  // Whatever happens, the board is resynced from the real engine state at
  // the end and the UI is always released back to the player.
  panels.setThinking(true);
  await new Promise((r) => setTimeout(r, 60)); // let the status paint

  let reply;
  try {
    reply = await game.botReply();
  } catch (err) {
    if (typeof console !== 'undefined') console.error('[main] botReply threw', err);
    reply = { events: [], status: game.status, pressure: game.referee.pressure, tier: game.referee.tierFromPressure(), assessCp: lastAssess };
  }
  panels.setThinking(false);

  // nervous / smug commentary keyed to the honest assessment
  const swing = (reply.assessCp ?? 0) - lastAssess;
  lastAssess = reply.assessCp ?? 0;
  if (reply.assessCp < -250 || swing < -300) {
    feed.bot(commentary.line('player_good'));
    panels.recalibrate();
    await new Promise((r) => setTimeout(r, 420));
  } else if (swing > 150) {
    feed.bot(commentary.line('player_blunder'));
  } else if (!reply.events.some((e) => e.cheat && e.cheat.tier >= 3) && Math.random() < 0.35) {
    // dry engine chatter accompanies normal-looking moves — which now
    // includes the sneaky cheats, deliberately
    feed.bot(commentary.line('normal_move'));
  }

  try {
    await playEvents(reply.events);
  } catch (err) {
    if (typeof console !== 'undefined') console.error('[main] playEvents threw', err);
  }

  // if the check on MottyBot was resolved honestly, retire the glow
  const state = game.getState();
  if (!state.checkIgnoredBlack) {
    board.clearCheck();
    if (!state.inCheckWhite) board.clearCaption();
  }
  const lastBotMove = [...reply.events].reverse()
    .find((e) => e.from && e.to && e.type !== 'king-dodge' && e.type !== 'bounce');
  if (lastBotMove) board.showLastMove(lastBotMove.from, lastBotMove.to);

  // The engine state is authoritative regardless of whether the animation
  // above completed cleanly — this line is what makes the board correct
  // even after a caught exception.
  refreshPanels();
  panels.updateEval(reply.assessCp, reply.tier, game.director.active);
  panels.applyTier(reply.tier);
  panels.setStatus(reply.tier >= 2 ? 'operating within the regulations' : 'certified fair');

  busy = false;

  if (game.status !== 'playing') { finishGame({}); return; }
  scheduleIdle();
}

async function playEvents(events) {
  const linedCheats = new Set();
  await animator.play(events, {
    onEvent: (e) => {
      if (e.type === 'check' && e.color === 'w') {
        feed.bot(commentary.line('check_vs_player'));
      } else if (e.type === 'check-denied') {
        feed.bot(commentary.line('check_denied'));
      } else if (e.cheat && e.cheat.tier >= 3 && !linedCheats.has(e.cheat.id)) {
        // sneaky tiers stay SILENT — announcing "per FIDE rule 52..." is a
        // confession. Only the endgame catalog gets its citations.
        linedCheats.add(e.cheat.id);
        if (e.cheat.id !== 'DELETE') {
          feed.bot(commentary.line('cheat_specific', { id: e.cheat.id, tier: e.cheat.tier }));
        }
        if (e.cheat.id === 'MASS_DELETE' || e.cheat.id === 'DELETE') {
          panels.amendHistory(game.moveNumber);
        }
      }
    },
  });
}

function refreshPanels() {
  const state = game.getState();
  board.syncFromState(state);
  panels.updateTrays(state.captured);
  panels.updateMoveList(state.moveLog);
  if (state.inCheckWhite && state.status === 'playing') {
    board.showCheck(state.squares.find((s) => s.type === 'k' && s.color === 'w').square);
    board.setCaption('Check');
  }
}

function finishGame({ headline = 'MottyBot wins', sub = 'As foreseen.', forfeit = false }) {
  if (gameOver) return; // a game ends once, however many ways it tries to
  gameOver = true;
  busy = true;
  clearIdle();
  if (forfeit) record.forfeits++;
  else record.losses++;
  saveRecord(record);
  const state = game.getState();
  const honest = state.cheatsFired.length === 0;
  feed.bot(commentary.line(honest ? 'victory_honest' : 'victory'));
  setTimeout(() => {
    overlays.showVictory({ state, record, headline, sub });
  }, 1400);
}

// --- idle taunts and the adjudication ------------------------------------

function scheduleIdle() {
  clearIdle();
  if (game.status !== 'playing' || !started) return;
  const taunt = (key) => () => {
    if (!busy && !promoSheetOpen() && game.status === 'playing' &&
        document.visibilityState === 'visible') {
      feed.bot(commentary.line(key));
    }
  };
  idleTimers = [
    setTimeout(taunt('idle_30'), 30000),
    setTimeout(taunt('idle_60'), 75000),
    setTimeout(taunt('idle_120'), 130000),
    setTimeout(() => {
      if (busy || gameOver || game.status !== 'playing') return;
      if (promoSheetOpen()) { scheduleIdle(); return; } // Form 9 takes precedence
      if (document.visibilityState !== 'visible') return;
      game.resign();
      feed.bot(commentary.line('adjudicated'));
      finishGame({
        headline: 'Adjudicated',
        sub: 'MottyBot wins on demand.',
        forfeit: true,
      });
    }, 200000),
  ];
}

function clearIdle() {
  for (const t of idleTimers) clearTimeout(t);
  idleTimers = [];
}

// --- dev hook: drive the UI programmatically for automated testing -------
// LOCALHOST ONLY. This exposes the live game instance with zero guardrails
// (direct board writes, forced resigns, everything) — it must never reach
// a real visitor's browser. A friend who opens devtools on the deployed
// site must find nothing to grab.

import { Search } from './engine/search.js';
import { legalMoves } from './engine/movegen.js';
import { WHITE, F_PROMO, mvFrom, mvTo, mvFlags, alg } from './engine/constants.js';

const isDevHost =
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1' ||
  location.hostname === '[::1]';

const devSearch = isDevHost ? new Search() : null;
if (isDevHost) window.__mv = {
  game,
  isBusy: () => busy,
  state: () => game.getState(),
  begin: () => document.getElementById('btn-begin')?.click(),
  async auto(ms = 250) {
    if (busy || game.status !== 'playing') return game.status;
    const plyBefore = game.board.ply;
    const res = devSearch.think(game.board, { msBudget: ms, maxDepth: 6 });
    if (!res.move) return 'no-move';
    const input = { from: alg(mvFrom(res.move)), to: alg(mvTo(res.move)) };
    if (mvFlags(res.move) & F_PROMO) input.promo = 'q';
    await handlePlayerMove(input);
    if (game.board.ply === plyBefore && game.status === 'playing') {
      // rejected (phantom pin, bounce): do what a human does — grumble
      // and play something else
      const alts = legalMoves(game.board, WHITE).filter(
        (m) => alg(mvTo(m)) !== input.to
      );
      if (alts.length) {
        const alt = alts[Math.floor(Math.random() * alts.length)];
        const input2 = { from: alg(mvFrom(alt)), to: alg(mvTo(alt)) };
        if (mvFlags(alt) & F_PROMO) input2.promo = 'q';
        await handlePlayerMove(input2);
      }
    }
    return game.status;
  },
  async move(from, to, promo) {
    await handlePlayerMove({ from, to, promo });
    return game.status;
  },
  demo: (events) => playEvents(events),
};
