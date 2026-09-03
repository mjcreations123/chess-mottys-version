import { Chess } from './vendor/chess.js';
import { ExchangeMatch, START_FEN, replayMatch, resurrectionFen } from './core/exchange.js';
import { parseFen } from './core/fen.js';
import { randomSeed } from './core/rng.js';
import { loadActive, saveActive, clearActive, loadStats, recordResult, markRulesSeen } from './core/persistence.js';
import { pieceSpriteSVG, pieceUse } from './ui/pieces.js';
import { BoardView } from './ui/board.js';
import { sound } from './ui/sound.js';
import { pickTaunt, resetTaunts } from './content/taunts.js';

document.body.insertAdjacentHTML('afterbegin', pieceSpriteSVG());

const $ = (id) => document.getElementById(id);
const panel = $('panel');
const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const BOTS = {
  easy: {
    name: 'MottyBot', label: 'Casual', level: 'easy', minThink: 600,
    blurb: 'Looks one move ahead and forgets you get a move too. Anyone can beat it.',
  },
  medium: {
    name: 'MottyBot', label: 'Average', level: 'medium', minThink: 900,
    blurb: 'A real opponent. Punishes a loose piece, but you can out-think it.',
  },
  hard: {
    name: 'MottyBot', label: 'Expert', level: 'hard', minThink: 1200,
    blurb: 'Searches as deep as its clock allows and gives you nothing.',
  },
};

const state = {
  match: null,
  myColor: 'w',
  bot: BOTS.medium,
  over: true,
  animating: false,
  screen: 'home',
  serial: 0,
  resultRecorded: false,
  result: null,
  replay: null,
  // Non-null while the player is looking back through earlier positions
  // during a live game. The game keeps running underneath; only the view
  // is rewound.
  browse: null,
};

const board = new BoardView($('board'), { onUserMove: handleUserMove });

/* The board must always be fully visible: it is the whole point of the page.
   Everything else stacked in the arena is measured and whatever height is
   left over becomes the board's. The action bar changes height as the game
   asks different things of you, so this has to be live rather than a guess. */
const arena = document.querySelector('.arena');
const boardFrame = document.querySelector('.board-frame');
const actionBar = $('board-action');
const ACTION_RESERVE = 118; // tallest action bar, including its margin
let fitQueued = false;
function fitBoard() {
  fitQueued = false;
  if (matchMedia('(max-width: 1080px)').matches) {
    arena.style.removeProperty('--board-max');
    return;
  }
  // The action bar comes and goes, so its tallest state is reserved rather
  // than measured: a board that resizes under the player mid-game is worse
  // than a strip of empty page below it.
  let chrome = ACTION_RESERVE;
  for (const child of arena.children) {
    if (child === boardFrame || child === actionBar) continue;
    const style = getComputedStyle(child);
    if (style.display === 'none') continue;
    chrome += child.getBoundingClientRect().height
      + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
  }
  const top = arena.getBoundingClientRect().top + window.scrollY;
  const room = window.innerHeight - top - 30 - chrome;
  arena.style.setProperty('--board-max', `${Math.max(340, Math.round(room))}px`);
}
function queueFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(fitBoard);
}
addEventListener('resize', queueFit);
new ResizeObserver(queueFit).observe(document.documentElement);

/* Worker */
let worker = null;
let workerSeq = 0;
const WORKER_TIMEOUT_MS = 15000;
function requestWorker(payload) {
  if (!worker) worker = new Worker('/js/ai.worker.js', { type: 'module' });
  const activeWorker = worker;
  return new Promise((resolve, reject) => {
    const id = ++workerSeq;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      activeWorker.removeEventListener('message', onMessage);
      activeWorker.removeEventListener('error', onError);
      activeWorker.removeEventListener('messageerror', onMessageError);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onMessage = (event) => {
      if (event.data.id !== id) return;
      event.data.error
        ? finish(reject, new Error(event.data.error))
        : finish(resolve, event.data);
    };
    const onError = (event) => {
      if (worker === activeWorker) {
        activeWorker.terminate();
        worker = null;
      }
      finish(reject, new Error(event.message || 'MottyBot worker failed'));
    };
    const onMessageError = () => {
      if (worker === activeWorker) {
        activeWorker.terminate();
        worker = null;
      }
      finish(reject, new Error('MottyBot worker returned an unreadable response'));
    };
    const timeout = setTimeout(() => {
      if (worker === activeWorker) {
        activeWorker.terminate();
        worker = null;
      }
      finish(reject, new Error('MottyBot worker timed out'));
    }, WORKER_TIMEOUT_MS);
    activeWorker.addEventListener('message', onMessage);
    activeWorker.addEventListener('error', onError);
    activeWorker.addEventListener('messageerror', onMessageError);
    try {
      activeWorker.postMessage({ id, ...payload });
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function requestBotMove(fen, level) {
  const result = await requestWorker({
    kind: 'move',
    fen,
    level,
    // This week's rule, handed to the search: a dead piece with a clear home
    // and a matching enemy still standing is material MottyBot is owed. Its
    // own graveyard cannot change on its own move, so this stays true for the
    // whole search.
    vouchers: state.match?.vouchers(),
    seed: `${state.match?.seed || 'game'}#bot-move#${state.match?.ply || 0}#${fen}`,
  });
  return result.move;
}

// Ask MottyBot to compare candidate positions: the plain chess move first,
// then each possible homecoming. Ties keep the plain move.
async function requestBotChoice(fens, vouchersList) {
  // Every level judges a homecoming to the same depth, so every level gets the
  // same clock to reach it. Weighing the house rule is not a difficulty
  // setting: a weak opponent should be bad at chess, not confused about what
  // the rules let it do.
  const probeMs = 500;
  return requestWorker({
    kind: 'choose',
    fens,
    vouchersList,
    level: state.bot.level,
    probeMs,
    seed: `${state.match?.seed || 'game'}#choose#${state.match?.ply || 0}`,
  });
}

/* Shared helpers */
function escapeHTML(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function positionMap(fen = state.match?.fen() || START_FEN) { return parseFen(fen).board; }
function announce(text) { $('announcer').textContent = ''; requestAnimationFrame(() => { $('announcer').textContent = text; }); }
function setSkipTarget(target, label) {
  const link = $('skip-link');
  link.href = `#${target}`;
  link.textContent = label;
}

function kingSquare(color, fen = state.match?.fen()) {
  if (!fen) return null;
  for (const [sq, piece] of positionMap(fen)) {
    if (piece.type === 'k' && piece.color === color) return sq;
  }
  return null;
}

// While reviewing an earlier position the board deliberately does not show
// the live one, so every live repaint has to stand down until the player
// returns to the present.
function reviewing() { return state.browse !== null; }

function syncBoard({ force = false } = {}) {
  if (!state.match || reviewing()) return;
  const position = positionMap();
  // Once a turn has settled, correctness matters more than preserving an
  // in-flight animation node. A forced repaint guarantees that a missing,
  // duplicated, or visually stale piece cannot survive into the next turn.
  if (force) board.setPosition(position);
  else board.verify(position);
}

function updateCheckMark(fen = state.match?.fen()) {
  if (reviewing() && fen === state.match?.fen()) return;
  if (!fen) return board.setCheck(null);
  const chess = new Chess(fen, { skipValidation: true });
  board.setCheck(chess.isCheck() ? kingSquare(chess.turn(), fen) : null);
}

function setThinking(on) { $('top-thinking').hidden = !on; queueFit(); }
function setPlayerAction(label = null, { phase = 'turn', title = '', copy = '', onCancel = null, buttons = [] } = {}) {
  const tag = $('turn-tag');
  tag.hidden = !label;
  tag.textContent = label || 'Your move';
  tag.dataset.phase = phase;

  const prompt = $('board-action');
  prompt.hidden = !title;
  prompt.dataset.phase = phase;
  $('board-action-title').textContent = title;
  $('board-action-copy').textContent = copy;
  const cancel = $('board-action-cancel');
  cancel.hidden = typeof onCancel !== 'function';
  cancel.onclick = typeof onCancel === 'function' ? onCancel : null;
  const bar = $('board-action-buttons');
  bar.innerHTML = '';
  bar.hidden = !buttons.length;
  for (const item of buttons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn ${item.kind || 'btn--secondary'}`;
    button.textContent = item.label;
    button.onclick = item.onClick;
    bar.appendChild(button);
  }
  queueFit();
}
function setYourTurn(on) { setPlayerAction(on ? 'Your move' : null); }
function focusBoard({ keepActionVisible = false } = {}) {
  requestAnimationFrame(() => {
    board.el.focus({ preventScroll: true });
    const prompt = $('board-action');
    const visibleTarget = keepActionVisible && !prompt.hidden ? prompt : board.el;
    if (matchMedia('(max-width: 1080px)').matches) {
      document.querySelector('.arena').scrollIntoView({ block: 'start', inline: 'nearest' });
    } else {
      visibleTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  });
}

/* MottyBot's mouth */
let tauntTimer = null;

function showTaunt(line) {
  if (!line) return;
  const bubble = $('bot-taunt');
  if (!bubble) return;
  $('bot-taunt-line').textContent = line;
  bubble.dataset.empty = 'false';
  bubble.classList.remove('is-in');
  void bubble.offsetWidth; // restart the entrance animation on repeat lines
  bubble.classList.add('is-in');
  clearTimeout(tauntTimer);
  tauntTimer = setTimeout(() => { bubble.dataset.empty = 'true'; }, 4400);
}

function clearTaunt() {
  clearTimeout(tauntTimer);
  const bubble = $('bot-taunt');
  if (bubble) bubble.dataset.empty = 'true';
}

// A mating move ends the game outright, so endGame() does that gloating.
function reactToMove(move, byBot) {
  if (state.screen !== 'playing' || move.san.includes('#')) return;
  const gaveCheck = move.san.includes('+');
  const heavy = move.captured && VAL[move.captured] >= 5;
  if (byBot) {
    if (move.promotion) showTaunt(pickTaunt('botPromote', { always: true }));
    else if (gaveCheck) showTaunt(pickTaunt('botCheck', { always: true }));
    else if (heavy) showTaunt(pickTaunt('botBigCapture', { always: true }));
    else if (move.captured) showTaunt(pickTaunt('botCapture'));
    else showTaunt(pickTaunt('idle', { chance: 0.28, minGapMs: 14000 }));
    return;
  }
  if (move.promotion) showTaunt(pickTaunt('playerPromote', { always: true }));
  else if (gaveCheck) showTaunt(pickTaunt('playerCheck', { always: true }));
  else if (heavy) showTaunt(pickTaunt('playerBigCapture', { always: true }));
  else if (move.captured) showTaunt(pickTaunt('playerCapture'));
}

// A transient line on the board action bar. It narrates a homecoming while
// it plays out; the next setPlayerAction call clears it.
function showNote(title, copy, phase = 'triggered') {
  const prompt = $('board-action');
  prompt.hidden = false;
  prompt.dataset.phase = phase;
  $('board-action-title').textContent = title;
  $('board-action-copy').textContent = copy;
  $('board-action-cancel').hidden = true;
  const bar = $('board-action-buttons');
  bar.innerHTML = '';
  bar.hidden = true;
  queueFit();
}

// The rail beside each name is the graveyard. It records only what has been
// lost and where it may return; it must never turn into a hint engine that
// names the next capture for the player.
function railHTML(color, mine, delta) {
  const who = mine ? 'Your' : "MottyBot's";
  const chips = state.match.graveyard(color).map((entry) => {
    const name = PIECE_NAMES[entry.type];
    // Show the piece's remembered home, not a live availability readout.
    // Availability is tactical information the player should discover, not
    // a changing recommendation from the interface.
    const where = entry.homes.join('/');
    const why = `in the graveyard; home is ${where}`;
    return `<span class="chip chip--dead" title="${who} ${name}, ${why}"><span class="chip__lost" aria-hidden="true">×</span>${pieceUse(color, entry.type)}<b>${where}</b><span class="visually-hidden">${who} ${name}, ${why}.</span></span>`;
  }).join('');
  const score = delta > 0 ? `<span class="rail__score">+${delta}</span>` : '';
  const label = chips ? '<span class="rail__label" aria-hidden="true">Graveyard</span>' : '';
  return label + chips + score;
}

function renderRails() {
  const top = $('top-rail');
  const bottom = $('bottom-rail');
  if (!top || !bottom) return;
  if (!state.match) { top.innerHTML = ''; bottom.innerHTML = ''; return; }
  const { byWhite, byBlack } = state.match.captured();
  const diff = byWhite.reduce((sum, type) => sum + VAL[type], 0)
    - byBlack.reduce((sum, type) => sum + VAL[type], 0);
  const myDiff = state.myColor === 'w' ? diff : -diff;
  bottom.innerHTML = railHTML(state.myColor, true, myDiff);
  top.innerHTML = railHTML(opposingColor(state.myColor), false, -myDiff);
  queueFit();
}

// Exchange is a rule the player learns and spots for themselves. Do not ring
// exact victims or spell out a profitable capture before it happens; that
// makes the graveyard into a move adviser rather than a game mechanic.
function updateOpportunities() {
  board.setOpportunities({});
}

function renderLive() {
  renderRails();
  updateOpportunities();
}

function persistGame() {
  if (!state.match || state.over) return;
  saveActive({
    seed: state.match.seed,
    actions: state.match.serializedActions(),
    myColor: state.myColor,
    level: state.bot.level,
    startedAt: state.match.startedAt,
  });
}

function savedMoveCount(data) {
  return data.actions.filter((action) => action?.kind === 'move').length;
}

function sharedConfig() {
  const query = new URLSearchParams(location.search);
  const seed = query.get('seed');
  const level = query.get('level');
  const color = query.get('color');
  if (!seed || seed.length > 100) return null;
  return {
    seed,
    level: ['easy', 'medium', 'hard'].includes(level) ? level : 'medium',
    color: ['w', 'b'].includes(color) ? color : 'w',
  };
}

function challengeURL() {
  const url = new URL(location.origin + location.pathname);
  url.searchParams.set('seed', state.match.seed);
  url.searchParams.set('level', state.bot.level);
  url.searchParams.set('color', state.myColor);
  return url.toString();
}

/* Match desk */
function panelHome() {
  state.screen = 'home';
  setSkipTarget('panel', 'Skip to game controls');
  panel.className = 'matchdesk matchdesk--home';
  board.setInteractive(null);
  setThinking(false);
  setYourTurn(false);
  clearTaunt();
  const active = loadActive();
  const stats = loadStats();
  const shared = sharedConfig();

  panel.innerHTML = `
    <div class="desk-head">
      <h1>Nothing you lose is gone for good.</h1>
      <p>This week's rules: Prisoner Exchange. Every piece remembers the square it started on, and taking an enemy piece of the same kind can bring yours back to it.</p>
    </div>
    <div class="desk-body">
      ${shared ? `
        <div class="resume-card">
          <strong>Someone sent you this board</strong>
          <p>The same colors and ${escapeHTML(BOTS[shared.level].label.toLowerCase())} difficulty they played. Beat their MottyBot.</p>
          <button class="btn btn--magic" id="play-shared">Play this challenge</button>
        </div>` : ''}
      ${active ? `
        <div class="resume-card">
          <strong>Continue your game</strong>
          <p>${savedMoveCount(active)} moves saved against ${escapeHTML(BOTS[active.level].label)} MottyBot.</p>
          <div class="inline-actions">
            <button class="btn btn--primary" id="resume-game">Resume</button>
            <button class="btn btn--quiet" id="discard-game">Discard</button>
          </div>
        </div>` : ''}
      <p class="rule-flow"><b>Lose a piece</b> and it waits in your graveyard, remembering the square it started on. <b>Take its twin</b> — capture an enemy piece of the same kind, playing out as a normal capture. <b>Then choose:</b> keep it, or take the whole move back and let yours walk home instead.</p>
      <div class="button-stack">
        <button class="btn btn--primary" id="choose-game">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 18.5h14M8 18.5l1-7h6l1 7M9 7.5h6M10 4h4v3.5H10Z"/></svg>
          Play Prisoner Exchange
        </button>
      </div>
      ${stats.played ? `
        <div class="stats-line" role="group" aria-label="Your results on this device">
          <div class="stat"><strong>${stats.wins}</strong><span>Wins</span></div>
          <div class="stat"><strong>${stats.losses}</strong><span>Losses</span></div>
          <div class="stat"><strong>${stats.bestStreak}</strong><span>Best streak</span></div>
        </div>` : ''}
    </div>`;

  $('choose-game').onclick = panelSetup;
  if (shared) $('play-shared').onclick = () => startBotGame(shared.level, shared.color, { seed: shared.seed });
  if (active) {
    $('resume-game').onclick = () => resumeGame(active);
    $('discard-game').onclick = () => {
      clearActive();
      panelHome();
    };
  }
}

function panelSetup() {
  state.screen = 'setup';
  setSkipTarget('panel', 'Skip to game controls');
  panel.className = 'matchdesk matchdesk--setup';
  board.setInteractive(null);
  setThinking(false);
  setYourTurn(false);
  clearTaunt();
  let level = 'medium';
  let color = 'w';
  panel.innerHTML = `
    <div class="desk-head"><h1>Choose your match.</h1><p>All three play the house rule in full. What rises is how far ahead they see and how little they give away.</p></div>
    <div class="desk-body">
      <p class="section-title">Difficulty</p>
      <div class="level-select" id="difficulty-list" role="radiogroup" aria-label="Difficulty">
        ${Object.values(BOTS).map((bot) => `
          <button type="button" data-level="${bot.level}" aria-pressed="${bot.level === level}">${bot.label}</button>`).join('')}
      </div>
      <p class="level-blurb" id="level-blurb">${BOTS[level].blurb}</p>
      <p class="section-title">Your color</p>
      <div class="color-choice" id="color-choice">
        <button type="button" data-color="w" aria-pressed="true">${pieceUse('w', 'k')}White</button>
        <button type="button" data-color="random" aria-pressed="false">${pieceUse('w', 'p')}Random</button>
        <button type="button" data-color="b" aria-pressed="false">${pieceUse('b', 'k')}Black</button>
      </div>
      <div class="button-stack">
        <button class="btn btn--primary" id="start-game">Start game</button>
      </div>
      <button class="link-action" id="setup-back" type="button">Back</button>
    </div>`;

  $('difficulty-list').onclick = (event) => {
    const button = event.target.closest('[data-level]');
    if (!button) return;
    level = button.dataset.level;
    $('difficulty-list').querySelectorAll('button').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    $('level-blurb').textContent = BOTS[level].blurb;
  };
  $('color-choice').onclick = (event) => {
    const button = event.target.closest('[data-color]');
    if (!button) return;
    color = button.dataset.color;
    $('color-choice').querySelectorAll('button').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
  };
  $('start-game').onclick = () => {
    const resolvedColor = color === 'random' ? (crypto.getRandomValues(new Uint8Array(1))[0] % 2 ? 'w' : 'b') : color;
    startBotGame(level, resolvedColor);
  };
  $('setup-back').onclick = panelHome;
}

function panelPlaying() {
  setSkipTarget('board', 'Skip to the board');
  panel.className = 'matchdesk';
  panel.innerHTML = `
    <div class="desk-head">
      <div class="match-title"><h2>${escapeHTML(state.bot.name)}</h2><span class="difficulty-label">${escapeHTML(state.bot.label)} difficulty</span></div>
      <p>Capture a piece that matches one of your dead, and you may undo the capture and bring yours home to its starting square instead.</p>
    </div>
    <div class="review-nav" role="group" aria-label="Step back through the game">
      <button id="review-first" type="button" aria-label="First position">|&lsaquo;</button>
      <button id="review-prev" type="button" aria-label="Previous position">&lsaquo;</button>
      <button id="review-next" type="button" aria-label="Next position">&rsaquo;</button>
      <button id="review-live" type="button" aria-label="Back to the live position">Live</button>
      <span id="review-label"></span>
    </div>
    <div class="desk-body desk-body--moves"><div class="move-list" id="move-list"></div></div>
    <div class="desk-footer">
      <button class="btn btn--danger" id="resign-game">Resign</button>
      <button class="btn btn--quiet" id="game-rules">Rules</button>
    </div>`;
  $('resign-game').onclick = confirmResign;
  $('game-rules').onclick = showRules;
  $('review-first').onclick = () => stepReview(0, { absolute: true });
  $('review-prev').onclick = () => stepReview(-1);
  $('review-next').onclick = () => stepReview(1);
  $('review-live').onclick = () => exitReview();
  renderLive();
  renderMoveList();
  updateReviewNav();
}

function panelPostGame() {
  setSkipTarget('panel', 'Skip to game review');
  panel.className = 'matchdesk';
  panel.innerHTML = `
    <div class="desk-head">
      <div class="match-title"><h2>Final position</h2><span class="difficulty-label">${escapeHTML(state.bot.label)} difficulty</span></div>
      <p>Every move and every homecoming remains available for review.</p>
    </div>
    <div class="desk-body desk-body--moves"><div class="move-list" id="move-list"></div></div>
    <div class="desk-footer">
      <button class="btn btn--secondary" id="review-game">Review</button>
      <button class="btn btn--primary" id="post-new">New game</button>
    </div>`;
  renderMoveList();
  $('review-game').onclick = enterReplay;
  $('post-new').onclick = panelSetup;
}

function renderMoveList() {
  const wrap = $('move-list');
  if (!wrap || !state.match) return;
  const blocks = [];
  let index = -1;
  for (const entry of state.match.log) {
    index++;
    const number = Math.floor(entry.ply / 2) + 1;
    const marker = `${number}${entry.color === 'w' ? '.' : '…'}`;
    const side = entry.color === state.myColor ? 'You' : 'MottyBot';
    // Frame 0 is the starting position, so the entry at log index i is
    // frame i + 1. Clicking a row jumps the review to that position.
    const frame = index + 1;
    if (entry.kind === 'move') {
      blocks.push(`
        <button class="turn-record" type="button" data-frame="${frame}">
          <div class="move-line"><span class="move-number">${marker}</span><span class="move-san">${escapeHTML(entry.san)}</span><span class="move-side">${side}</span></div>
        </button>`);
    } else if (entry.kind === 'resurrect') {
      blocks.push(`
        <button class="turn-record turn-record--return" type="button" data-frame="${frame}">
          <div class="move-line"><span class="move-number">${marker}</span><span class="move-san">${capitalize(PIECE_NAMES[entry.piece])} home to ${entry.home}</span><span class="move-side">${side}</span></div>
          <div class="trade-line">Spared the ${PIECE_NAMES[entry.declined.victimType]} on ${entry.declined.victimSquare}.</div>
        </button>`);
    }
  }
  wrap.innerHTML = blocks.length ? blocks.join('') : '<div class="empty-log">Your moves and every homecoming will appear here.</div>';
  wrap.onclick = (event) => {
    const row = event.target.closest('[data-frame]');
    if (row) stepReview(Number(row.dataset.frame), { absolute: true });
  };
  markReviewedRow();
  if (!reviewing()) {
    const scroller = wrap.closest('.desk-body--moves');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }
}

/* Stepping back through the game while it is still running */

// Frames are rebuilt from the log every step. The log only ever appends, so
// a frame index keeps pointing at the same position even when MottyBot
// moves while the player is looking backwards.
function stepReview(delta, { absolute = false } = {}) {
  if (!state.match || state.screen === 'exchange' || state.screen === 'replay') return;
  if (state.over) return;
  const frames = buildReplayFrames();
  const last = frames.length - 1;
  const current = state.browse ? state.browse.index : last;
  const next = Math.max(0, Math.min(last, absolute ? delta : current + delta));
  if (next >= last) {
    exitReview();
    return;
  }
  state.browse = { index: next, frames };
  board.setInteractive(null);
  setYourTurn(false);
  const frame = frames[next];
  board.setPosition(positionMap(frame.fen));
  board.setLastMove(frame.from || null, frame.to || null);
  updateCheckMark(frame.fen);
  setPlayerAction('Reviewing', {
    phase: 'selecting',
    title: 'Looking back at an earlier position',
    copy: `${frame.label}. ${frame.detail}. The game is still waiting for you.`,
    buttons: [{ label: 'Back to the live position', kind: 'btn--primary', onClick: () => exitReview() }],
  });
  renderLive();
  updateReviewNav();
  markReviewedRow();
  announce(`Reviewing ${frame.label}. ${frame.detail}. Position ${next + 1} of ${frames.length}.`);
}

function exitReview() {
  if (!state.browse) { updateReviewNav(); return; }
  state.browse = null;
  setPlayerAction(null);
  if (!state.match) return;
  board.setPosition(positionMap());
  const lastMove = [...state.match.log].reverse().find((e) => e.kind === 'move' || e.kind === 'resurrect');
  if (lastMove?.kind === 'move') board.setLastMove(lastMove.from, lastMove.to);
  else if (lastMove?.kind === 'resurrect') board.setLastMove(lastMove.declined.victimSquare, lastMove.home);
  else board.setLastMove(null);
  updateCheckMark();
  renderLive();
  updateReviewNav();
  markReviewedRow();
  if (!state.over && state.screen === 'playing' && state.match.turn() === state.myColor) {
    setYourTurn(true);
    board.setInteractive(state.myColor, (square) => state.match.legalMoves(square));
  }
  announce('Back to the live position.');
}

function markReviewedRow() {
  const wrap = $('move-list');
  if (!wrap) return;
  const active = state.browse ? String(state.browse.index) : null;
  for (const row of wrap.querySelectorAll('[data-frame]')) {
    row.classList.toggle('is-reviewed', row.dataset.frame === active);
  }
}

function updateReviewNav() {
  const label = $('review-label');
  if (!label || !state.match) return;
  const total = state.match.log.length + 1;
  const index = state.browse ? state.browse.index : total - 1;
  const locked = state.screen === 'exchange' || state.over;
  $('review-first').disabled = locked || index === 0;
  $('review-prev').disabled = locked || index === 0;
  $('review-next').disabled = locked || index >= total - 1;
  $('review-live').disabled = locked || !state.browse;
  label.textContent = state.browse
    ? `Position ${index + 1} of ${total}`
    : total > 1 ? 'Live' : 'No moves yet';
}

function capitalize(value) { return value.charAt(0).toUpperCase() + value.slice(1); }

/* Game setup and loop */
function configureBoardForMatch() {
  board.setOrientation(state.myColor);
  board.setPosition(positionMap());
  board.setLastMove(null);
  updateCheckMark();
  $('top-name').textContent = state.bot.name;
  $('top-detail').textContent = `${state.bot.label} difficulty`;
  $('bottom-name').textContent = 'You';
  $('bottom-detail').textContent = state.myColor === 'w' ? 'White' : 'Black';
  renderLive();
}

function opposingColor(color) { return color === 'w' ? 'b' : 'w'; }

function startBotGame(level, myColor, { seed = randomSeed() } = {}) {
  const serial = ++state.serial;
  state.match = new ExchangeMatch(seed);
  state.myColor = myColor;
  state.bot = BOTS[level] || BOTS.medium;
  state.over = false;
  state.animating = false;
  state.screen = 'playing';
  state.resultRecorded = false;
  state.result = null;
  state.replay = null;
  state.browse = null;
  configureBoardForMatch();
  sound.unlock();
  sound.start();
  resetTaunts();
  clearTaunt();
  panelPlaying();
  renderLive();
  persistGame();
  showTaunt(pickTaunt('greeting', { always: true }));
  botLoop(serial);
}

function resumeGame(data) {
  try {
    const serial = ++state.serial;
    state.match = replayMatch(data.seed, data.actions);
    state.match.startedAt = data.startedAt || Date.now();
    state.myColor = data.myColor;
    state.bot = BOTS[data.level] || BOTS.medium;
    state.over = false;
    state.animating = false;
    state.screen = 'playing';
    state.resultRecorded = false;
    state.result = null;
    state.replay = null;
    state.browse = null;
    configureBoardForMatch();
    resetTaunts();
    clearTaunt();
    panelPlaying();
    renderLive();
    persistGame();
    showTaunt(pickTaunt('greeting', { always: true }));
    botLoop(serial);
  } catch {
    clearActive();
    showModal(`
      <div class="modal__head"><h2 id="modal-title">That game could not be restored.</h2><p>The saved position was invalid, so it has been cleared safely.</p></div>
      <div class="modal__body"><button class="btn btn--primary" id="restore-ok">Start a new game</button></div>`);
    $('restore-ok').onclick = () => { hideModal(); panelSetup(); };
  }
}

async function playMoveAnimation(move, { instant = false } = {}) {
  const match = state.match;
  const serial = state.serial;
  state.animating = true;
  const rookHop = move.flags.includes('k')
    ? { rookFrom: move.color === 'w' ? 'h1' : 'h8', rookTo: move.color === 'w' ? 'f1' : 'f8' }
    : move.flags.includes('q')
      ? { rookFrom: move.color === 'w' ? 'a1' : 'a8', rookTo: move.color === 'w' ? 'd1' : 'd8' }
      : {};
  const epSquare = move.flags.includes('e') ? move.to[0] + (move.color === 'w' ? '5' : '4') : null;
  move.captured ? sound.capture() : sound.move();
  if (reviewing()) {
    // The move still happens; the reviewer just is not looking at it.
    state.animating = false;
    renderLive();
    renderMoveList();
    updateReviewNav();
    return state.match === match && state.serial === serial && !state.over;
  }
  if (instant) {
    await board.animateMove({ from: move.to, to: move.to, ...rookHop, epSquare, promotion: move.promotion, color: move.color });
  } else {
    await board.animateMove({ from: move.from, to: move.to, ...rookHop, epSquare, promotion: move.promotion, color: move.color });
  }
  if (state.match !== match || state.serial !== serial) return false;
  state.animating = false;
  if (state.over) return false;
  syncBoard({ force: true });
  // syncBoard may need to rebuild the entire board; only paint the current
  // move after that recovery so stale yellow squares cannot survive it.
  board.setLastMove(move.from, move.to);
  renderLive();
  renderMoveList();
  updateCheckMark();
  updateReviewNav();
  return true;
}

// Rewind the capture the board just showed, then bring the piece home. The
// undone move is handed back by takeHomecoming so the reverse can be drawn
// exactly.
async function playHomecoming(event, byBot) {
  const match = state.match;
  const serial = state.serial;
  const undone = event.undone;
  state.animating = true;

  if (!reviewing() && undone) {
    showNote(
      byBot ? 'MottyBot takes it back' : 'Taking it back',
      `The ${PIECE_NAMES[undone.captured]} on ${event.declined.victimSquare} is spared.`,
      'selecting',
    );
    sound.move();
    await board.animateUndoCapture({
      from: undone.from,
      to: undone.to,
      victimSquare: event.declined.victimSquare,
      victim: { type: event.declined.victimType, color: byBot ? state.myColor : opposingColor(state.myColor) },
      wasPromotion: Boolean(undone.promotion),
      color: undone.color,
    });
    if (state.match !== match || state.serial !== serial) return false;
    if (state.over) return false;
  }
  state.animating = false;
  return playResurrection(event, byBot);
}

// The homecoming: the declined capture flashes, the dead piece pops back in
// on its starting square, and the turn passes.
async function playResurrection(event, byBot) {
  const match = state.match;
  const serial = state.serial;
  state.animating = true;
  const pieceName = PIECE_NAMES[event.piece];
  const victimName = PIECE_NAMES[event.declined.victimType];
  sound.homecoming();
  showNote(
    byBot ? `MottyBot's ${pieceName} came home to ${event.home}`
      : `Your ${pieceName} came home to ${event.home}`,
    byBot ? `It spared your ${victimName} on ${event.declined.victimSquare} to do it.`
      : `You spared MottyBot's ${victimName} on ${event.declined.victimSquare} to do it.`,
  );
  announce(byBot
    ? `MottyBot declined the capture on ${event.declined.victimSquare}. Its ${pieceName} returned to ${event.home}.`
    : `You declined the capture. Your ${pieceName} returned to ${event.home}.`);
  if (reviewing()) {
    state.animating = false;
    renderLive();
    renderMoveList();
    updateReviewNav();
    return state.match === match && state.serial === serial && !state.over;
  }
  await board.animateResurrection({ square: event.home, color: event.color, type: event.piece });
  if (state.match !== match || state.serial !== serial) return false;
  state.animating = false;
  if (state.over) return false;
  syncBoard({ force: true });
  board.setLastMove(event.declined.victimSquare, event.home);
  renderLive();
  renderMoveList();
  updateCheckMark();
  updateReviewNav();
  showTaunt(pickTaunt(byBot ? 'botReturn' : 'playerReturn', { always: true }));
  return true;
}

// The graveyards as they would stand after one candidate action. A homecoming
// spends the very claim it redeems, so weighing every candidate against the
// graveyards as they are now would let MottyBot count that claim twice.
function vouchersAfter(match, action) {
  try {
    return replayMatch(match.seed, [...match.serializedActions(), action]).vouchers();
  } catch {
    return match.vouchers();
  }
}

// Every way MottyBot could bring a piece home this turn. Two different
// captures with the same home square produce the same board, so options are
// deduplicated by home.
function collectBotAlternatives(match) {
  const color = match.turn();
  const alternatives = [];
  const seen = new Set();
  for (const move of match.legalMoves()) {
    const options = match.resurrectionOptions(move);
    if (!options) continue;
    for (const home of options.homes) {
      if (seen.has(home)) continue;
      seen.add(home);
      const fen = resurrectionFen(match.fen(), options.victimType, color, home);
      if (!fen) continue;
      const capture = { from: move.from, to: move.to, promotion: move.promotion };
      const uci = move.from + move.to + (move.promotion || '');
      alternatives.push({
        capture,
        home,
        fen,
        vouchers: vouchersAfter(match, { kind: 'resurrect', uci, home }),
      });
    }
  }
  return alternatives;
}

async function botLoop(serial) {
  const match = state.match;
  while (!state.over && state.screen === 'playing' && state.match === match && state.serial === serial) {
    const status = match.status();
    if (status.over) {
      endGame();
      return;
    }
    if (status.check) sound.check();

    if (match.turn() === state.myColor) {
      setThinking(false);
      updateReviewNav();
      if (reviewing()) return; // the board stays rewound until they come back
      setYourTurn(true);
      board.setInteractive(state.myColor, (square) => match.legalMoves(square));
      renderLive();
      announce(status.check ? 'Your king is in check. Your move.' : 'Your move.');
      return;
    }

    if (!reviewing()) setYourTurn(false);
    board.setInteractive(null);
    setThinking(true);
    const started = performance.now();
    let action = null;
    try {
      const candidate = await requestBotMove(match.fen(), state.bot.level);
      if (state.over || state.match !== match || state.serial !== serial) return;
      action = candidate ? { kind: 'move', move: candidate } : null;
      // MottyBot weighs every homecoming against its best chess move, not
      // just the captures it happened to like: bringing a piece home by
      // capturing a DEFENDED piece is often the whole point.
      const alternatives = collectBotAlternatives(match);
      if (action && alternatives.length) {
        const preview = new Chess(match.fen());
        preview.move({ from: candidate.from, to: candidate.to, promotion: candidate.promotion || undefined });
        const fens = [preview.fen(), ...alternatives.map((alt) => alt.fen)];
        const plainUci = candidate.from + candidate.to + (candidate.promotion || '');
        const vouchersList = [
          vouchersAfter(match, { kind: 'move', uci: plainUci }),
          ...alternatives.map((alt) => alt.vouchers),
        ];
        const choice = await requestBotChoice(fens, vouchersList);
        if (state.over || state.match !== match || state.serial !== serial) return;
        if (choice.index > 0) {
          const alt = alternatives[choice.index - 1];
          action = { kind: 'resurrect', capture: alt.capture, home: alt.home };
        }
      }
    } catch {
      const legal = match.legalMoves();
      action = legal.length ? { kind: 'move', move: { from: legal[0].from, to: legal[0].to, promotion: legal[0].promotion } } : null;
    }
    const remaining = state.bot.minThink - (performance.now() - started);
    if (remaining > 0) await wait(remaining);
    setThinking(false);
    if (!action || state.over || state.screen !== 'playing' || state.match !== match || state.serial !== serial) return;

    // A bot turn begins from the authoritative board, not whatever an
    // interrupted animation left in the DOM. This makes a renderer repair
    // happen before the next piece tries to move, not after a player has
    // already seen a phantom turn.
    syncBoard({ force: true });

    if (action.kind === 'resurrect') {
      // Show the take, then show it being taken back: MottyBot plays the
      // capture for real and rolls it back, exactly as the player does.
      let captureMove = null;
      try {
        captureMove = match.applyMove(action.capture);
      } catch {
        captureMove = null;
      }
      if (captureMove && match.pendingResurrection()) {
        announce(`MottyBot took the ${PIECE_NAMES[captureMove.captured]} on ${captureMove.to}.`);
        if (!await playMoveAnimation(captureMove)) return;
        let event = null;
        try {
          event = match.takeHomecoming(action.home);
        } catch {
          event = null;
        }
        if (event) {
          persistGame();
          if (!await playHomecoming(event, true)) return;
          continue;
        }
        // The homecoming fell through: the capture it just played stands.
        match.keepCapture();
        persistGame();
        reactToMove(captureMove, true);
        continue;
      }
      if (captureMove) {
        match.keepCapture();
        persistGame();
        if (!await playMoveAnimation(captureMove)) return;
        reactToMove(captureMove, true);
        continue;
      }
      const legal = match.legalMoves();
      if (!legal.length) return;
      action = { kind: 'move', move: { from: legal[0].from, to: legal[0].to, promotion: legal[0].promotion } };
    }
    const legal = match.legalMoves();
    const matchingMove = legal.find((candidate) => candidate.from === action.move.from
      && candidate.to === action.move.to
      && (candidate.promotion || undefined) === (action.move.promotion || undefined));
    if (!matchingMove) {
      // A worker response is advisory. It is never allowed to create a move
      // against a board that has since changed; use a current legal fallback
      // or finish a genuinely terminal position instead.
      if (!legal.length) {
        endGame();
        return;
      }
      action = { kind: 'move', move: legal[0] };
    }
    let move;
    try {
      move = match.applyMove(action.move);
    } catch {
      const fallback = match.legalMoves()[0];
      if (!fallback) {
        endGame();
        return;
      }
      move = match.applyMove(fallback);
    }
    match.keepCapture();
    persistGame();
    announce(`MottyBot moved from ${move.from} to ${move.to}.`);
    if (!await playMoveAnimation(move)) return;
    reactToMove(move, true);
  }
}

async function handleUserMove({ from, to, promotion, instant }) {
  const match = state.match;
  if (!match || state.over || state.animating || state.screen !== 'playing' || reviewing()) return;
  if (match.turn() !== state.myColor) return;
  const serial = state.serial;
  let move;
  try {
    move = match.applyMove({ from, to, promotion });
  } catch {
    sound.illegal();
    syncBoard({ force: true });
    return;
  }
  setYourTurn(false);
  board.setInteractive(null);
  // The capture is played and shown first. Only then does the choice come
  // up, so the decision is "keep this or take it back", not a guess.
  if (!await playMoveAnimation(move, { instant })) return;
  if (state.match !== match || state.serial !== serial || state.over) return;

  const offer = match.pendingResurrection();
  if (offer) {
    beginExchangeChoice(offer, move);
    return;
  }
  match.keepCapture();
  persistGame();
  reactToMove(move, false);
  botLoop(state.serial);
}

// The capture has already been played and drawn. Offer to take it back.
// Nothing is persisted until the choice resolves: a reload mid-decision
// rewinds to before the capture rather than silently committing it.
function beginExchangeChoice(options, move) {
  const match = state.match;
  const serial = state.serial;
  state.screen = 'exchange';
  board.setInteractive(null);
  updateReviewNav();
  clearTaunt();
  const victimName = PIECE_NAMES[options.victimType];
  const homes = options.homes;

  const keepIt = () => {
    if (state.serial !== serial || state.match !== match || state.over || state.screen !== 'exchange') return;
    state.screen = 'playing';
    setPlayerAction(null);
    match.keepCapture();
    persistGame();
    renderLive();
    updateReviewNav();
    reactToMove(move, false);
    botLoop(serial);
  };

  const doResurrect = async (home) => {
    if (state.serial !== serial || state.match !== match || state.over) return;
    let event;
    try {
      event = match.takeHomecoming(home);
    } catch {
      sound.illegal();
      keepIt();
      return;
    }
    state.screen = 'playing';
    setPlayerAction(null);
    board.setInteractive(null);
    persistGame();
    updateReviewNav();
    if (!await playHomecoming(event, false)) return;
    botLoop(serial);
  };

  const bringHome = () => {
    if (state.serial !== serial || state.match !== match || state.over || state.screen !== 'exchange') return;
    if (homes.length === 1) {
      void doResurrect(homes[0]);
      return;
    }
    setPlayerAction('Choose the square', {
      phase: 'selecting',
      title: `Where should your ${victimName} return?`,
      copy: 'Tap one of the highlighted starting squares.',
      onCancel: keepIt,
    });
    board.setSquareSelection(homes, (square) => { void doResurrect(square); }, {
      instruction: `Choose which starting square your ${victimName} returns to. Press Escape to keep the capture instead.`,
      choiceLabel: `open starting square for your ${victimName}`,
      onCancel: keepIt,
    });
    announce(`Choose which starting square your ${victimName} returns to: ${homes.join(' or ')}.`);
    focusBoard({ keepActionVisible: true });
  };

  setPlayerAction('Your choice', {
    phase: 'selecting',
    title: `Keep the ${victimName}, or undo and bring yours home?`,
    copy: homes.length === 1
      ? `Keep the ${victimName} you just took, or undo the capture: it goes back to ${options.victimSquare} and your ${victimName} returns to ${homes[0]}.`
      : `Keep the ${victimName} you just took, or undo the capture: it goes back to ${options.victimSquare} and yours returns to ${homes.join(' or ')}.`,
    buttons: [
      { label: 'Keep it', kind: 'btn--primary', onClick: keepIt },
      { label: 'Undo, bring mine home', kind: 'btn--magic', onClick: bringHome },
    ],
  });
  announce(`You took the ${victimName} on ${options.victimSquare}. Keep it, or undo the capture and bring your own ${victimName} home to ${homes.join(' or ')}. Choose on the action bar.`);
  focusBoard({ keepActionVisible: true });
}

/* Results and replay */
function outcomeFor(status) {
  if (!status.winner) return 'draw';
  return status.winner === state.myColor ? 'win' : 'loss';
}

function reasonText(status, outcome) {
  if (status.reason === 'checkmate') return 'by checkmate';
  if (status.reason === 'stalemate') return 'by stalemate';
  if (status.reason === 'bare kings') return 'only the kings remained';
  if (status.reason === 'threefold repetition') return 'by threefold repetition';
  if (status.reason === 'fifty-move rule') return 'by the fifty-move rule';
  if (status.reason === 'resignation') return outcome === 'win' ? 'MottyBot resigned' : 'you resigned';
  return status.reason || 'game over';
}

function endGame() {
  if (!state.match || state.over) return;
  const status = state.match.status();
  if (!status.over) return;
  const wasReviewing = state.browse !== null;
  state.browse = null;
  state.over = true;
  state.animating = false;
  state.screen = 'postgame';
  if (wasReviewing) {
    board.setPosition(positionMap());
    board.setLastMove(null);
    updateCheckMark();
  }
  board.setInteractive(null);
  setThinking(false);
  setYourTurn(false);
  clearActive();

  board.setOpportunities({});
  const outcome = outcomeFor(status);
  if (!state.resultRecorded) {
    recordResult(outcome);
    state.resultRecorded = true;
  }
  const moves = state.match.log.filter((entry) => entry.kind === 'move').length;
  const returns = state.match.log.filter((entry) => entry.kind === 'resurrect').length;
  const captures = state.match.log.filter((entry) => entry.kind === 'move' && entry.captured).length;
  const signOff = pickTaunt(
    outcome === 'draw' ? 'draw'
      : outcome === 'win' ? 'botLose'
        : status.reason === 'resignation' ? 'playerResign' : 'botWin',
    { always: true },
  );
  state.result = { status, outcome, moves, returns, captures, signOff };
  sound.end(outcome === 'win');
  clearTaunt();
  panelPostGame();
  showResultModal();
}

function showResultModal() {
  const { status, outcome, moves, returns, captures, signOff } = state.result;
  // Speak to the player. "MottyBot won" makes you work out what happened to
  // you; "You lost" does not.
  const headline = outcome === 'win' ? 'You won' : outcome === 'loss' ? 'You lost' : 'Draw';
  const note = outcome === 'win'
    ? 'You traded sharper than the machine. Well done.'
    : outcome === 'loss'
      ? 'MottyBot out-traded you this time. Take the board back.'
      : 'The board ran out of ways to settle it.';
  showModal(`
    <div class="result-banner result-banner--${outcome}">
      <span class="result-banner__reason">${escapeHTML(reasonText(status, outcome))}</span>
      <h2 class="result-banner__title" id="modal-title">${headline}</h2>
      <p class="result-banner__sub">against ${escapeHTML(state.bot.label)} MottyBot</p>
    </div>
    <div class="modal__body">
      <p class="result-note">${note}</p>
      ${signOff ? `<p class="bot-quote">${escapeHTML(signOff)}<span>MottyBot</span></p>` : ''}
      <div class="result-stats">
        <div><strong>${moves}</strong><span>Moves</span></div>
        <div><strong>${returns}</strong><span>Homecomings</span></div>
        <div><strong>${captures}</strong><span>Captures</span></div>
      </div>
      <div class="button-stack">
        <button class="btn btn--primary" id="result-share">
          <svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 15V3"/><path d="M8 7l4-4 4 4"/></svg>
          Share result
        </button>
        <button class="btn btn--secondary" id="result-new">Play again</button>
        <button class="btn btn--quiet" id="result-review">Review the game</button>
      </div>
      <div class="copy-confirm" id="copy-confirm" aria-live="polite"></div>
    </div>`);
  $('result-new').onclick = () => { hideModal(); startBotGame(state.bot.level, state.myColor); };
  $('result-review').onclick = () => { hideModal(); enterReplay(); };
  $('result-share').onclick = shareResult;
}

function resultSentence() {
  const { outcome, moves, returns } = state.result;
  const who = `${state.bot.label} MottyBot`;
  const verb = outcome === 'win' ? `I beat ${who}`
    : outcome === 'loss' ? `${who} beat me`
      : `I drew with ${who}`;
  const homecomings = returns === 1 ? ' and brought one piece back from the dead'
    : returns > 1 ? ` and brought ${returns} pieces back from the dead` : '';
  return `${verb} at Chess (Motty's Version) in ${moves} moves${homecomings}. This week's rules: Prisoner Exchange.`;
}

async function shareResult() {
  const url = challengeURL();
  const text = resultSentence();
  const confirm = $('copy-confirm');
  try {
    if (navigator.share) {
      await navigator.share({ title: "Chess (Motty's Version)", text, url });
      return;
    }
    await navigator.clipboard.writeText(`${text}\n${url}`);
    if (confirm) confirm.textContent = 'Result and link copied.';
  } catch (error) {
    if (error?.name === 'AbortError') return;
    if (confirm) confirm.textContent = 'Could not copy the link.';
  }
}

function buildReplayFrames() {
  const frames = [{ fen: START_FEN, kind: 'start', label: 'Starting position', detail: 'Every piece on the square it will remember' }];
  for (const entry of state.match.log) {
    const number = Math.floor(entry.ply / 2) + 1;
    const marker = `${number}${entry.color === 'w' ? '.' : '…'}`;
    if (entry.kind === 'move') {
      frames.push({
        fen: entry.fenAfter,
        kind: 'move',
        label: `${marker} ${entry.san}`,
        detail: entry.color === state.myColor ? 'Your move' : "MottyBot's move",
        from: entry.from,
        to: entry.to,
      });
    } else if (entry.kind === 'resurrect') {
      frames.push({
        fen: entry.fenAfter,
        kind: 'resurrect',
        label: `${marker} ${capitalize(PIECE_NAMES[entry.piece])} home to ${entry.home}`,
        detail: `${entry.color === state.myColor ? 'You' : 'MottyBot'} spared the ${PIECE_NAMES[entry.declined.victimType]} on ${entry.declined.victimSquare}`,
        from: entry.declined.victimSquare,
        to: entry.home,
      });
    }
  }
  return frames;
}

function enterReplay() {
  if (!state.match) return;
  setSkipTarget('panel', 'Skip to replay controls');
  clearTaunt();
  state.screen = 'replay';
  panel.className = 'matchdesk';
  state.replay = { frames: buildReplayFrames(), index: 0 };
  board.setInteractive(null);
  panel.innerHTML = `
    <div class="desk-head"><h2>Review the game.</h2><p>Step through every move and every homecoming.</p></div>
    <div class="replay-readout"><strong id="replay-label"></strong><span id="replay-detail"></span></div>
    <div class="replay-controls" role="group" aria-label="Replay controls">
      <button id="replay-start" aria-label="First position">|‹</button>
      <button id="replay-prev" aria-label="Previous position">‹</button>
      <button id="replay-next" aria-label="Next position">›</button>
      <button id="replay-end" aria-label="Final position">›|</button>
    </div>
    <div class="desk-footer"><button class="btn btn--primary" id="replay-exit">Exit review</button></div>`;
  $('replay-start').onclick = () => setReplayFrame(0);
  $('replay-prev').onclick = () => setReplayFrame(state.replay.index - 1);
  $('replay-next').onclick = () => setReplayFrame(state.replay.index + 1);
  $('replay-end').onclick = () => setReplayFrame(state.replay.frames.length - 1);
  $('replay-exit').onclick = exitReplay;
  setReplayFrame(0);
}

function setReplayFrame(index) {
  if (!state.replay) return;
  const max = state.replay.frames.length - 1;
  state.replay.index = Math.max(0, Math.min(max, index));
  const frame = state.replay.frames[state.replay.index];
  board.setPosition(positionMap(frame.fen));
  board.setLastMove(frame.from || null, frame.to || null);
  updateCheckMark(frame.fen);
  $('replay-label').textContent = frame.label;
  $('replay-detail').textContent = `${frame.detail}. Frame ${state.replay.index + 1} of ${state.replay.frames.length}.`;
  $('replay-start').disabled = state.replay.index === 0;
  $('replay-prev').disabled = state.replay.index === 0;
  $('replay-next').disabled = state.replay.index === max;
  $('replay-end').disabled = state.replay.index === max;
}

function exitReplay() {
  state.screen = 'postgame';
  state.replay = null;
  board.setPosition(positionMap());
  board.setLastMove(null);
  updateCheckMark();
  renderLive();
  panelPostGame();
}

/* Dialogs */
let restoreFocus = null;
let modalOnClose = null;

function showModal(html, { dismissible = true, onClose = null } = {}) {
  restoreFocus = document.activeElement;
  modalOnClose = onClose;
  $('modal').innerHTML = `${dismissible ? '<button class="modal__close" id="modal-close" type="button" aria-label="Close dialog">×</button>' : ''}${html}`;
  $('modal-scrim').hidden = false;
  if (dismissible) $('modal-close').onclick = hideModal;
  requestAnimationFrame(() => ($('modal-close') || $('modal').querySelector('button'))?.focus());
}

function hideModal() {
  if ($('modal-scrim').hidden) return;
  $('modal-scrim').hidden = true;
  const callback = modalOnClose;
  modalOnClose = null;
  callback?.();
  restoreFocus?.focus?.();
}

$('modal-scrim').addEventListener('click', (event) => {
  if (event.target === $('modal-scrim') && $('modal-close')) hideModal();
});

document.addEventListener('keydown', (event) => {
  if ($('modal-scrim').hidden) return;
  if (event.key === 'Escape' && $('modal-close')) {
    event.preventDefault();
    hideModal();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...$('modal').querySelectorAll('button, a, input, [tabindex]:not([tabindex="-1"])')].filter((item) => !item.disabled);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

function showRules() {
  markRulesSeen();
  showModal(`
    <div class="modal__head"><h2 id="modal-title">Prisoner Exchange.</h2><p>Ordinary chess. Your dead can come back.</p></div>
    <div class="modal__body">
      <ol class="rule-list">
        <li><span class="rule-mark">1</span><span><b>Every piece remembers home.</b> The square it stood on at move one.</span></li>
        <li><span class="rule-mark">2</span><span><b>Your dead wait in a graveyard.</b> Knights, bishops, rooks and queens. Pawns are ordinary chess pawns: once captured, they are gone.</span></li>
        <li><span class="rule-mark">3</span><span><b>Capture a matching piece, then choose.</b> The capture plays out first, exactly as it would in normal chess. Then you decide: keep it, or take the whole move back. Take it back and their piece stands again untouched, your capturing piece returns to the square it came from, your dead piece of that kind walks home instead, and your turn ends there.</span></li>
        <li><span class="rule-mark">4</span><span><b>Home is the square it started on.</b> Not any square of that kind: the a1 rook comes back to a1, the b8 knight to b8. If that square is occupied, that piece cannot come back yet. A promoted piece that dies waits like any other and returns to the standard square of its kind.</span></li>
        <li><span class="rule-mark">5</span><span><b>No limits, and MottyBot plays the same way.</b> Every fresh matching capture is another chance, each return uses up one dead piece, and MottyBot will take its own pieces back the moment you let it.</span></li>
        <li><span class="rule-mark">6</span><span><b>Everything else is chess.</b> Check, checkmate, castling, promotion. Draws: stalemate, threefold repetition, the fifty-move rule, or nothing left but the two kings. A returned rook cannot castle, and in check a return must block the check.</span></li>
      </ol>
      <p class="credit-line">Chess pieces by Colin M. L. Burnett, <a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener">CC BY-SA 3.0</a>.</p>
      <div class="button-stack"><button class="btn btn--primary" id="rules-ok">Got it</button></div>
    </div>`);
  $('rules-ok').onclick = hideModal;
}

function confirmResign() {
  if (!state.match || state.over) return;
  showModal(`
    <div class="modal__head"><h2 id="modal-title">Resign this game?</h2><p>This records a loss and ends the current match.</p></div>
    <div class="modal__body"><div class="button-stack"><button class="btn btn--danger" id="resign-yes">Resign</button><button class="btn btn--secondary" id="resign-no">Keep playing</button></div></div>`);
  $('resign-no').onclick = hideModal;
  $('resign-yes').onclick = () => {
    hideModal();
    state.match.resign(state.myColor);
    endGame();
  };
}

function requestNewGame() {
  if (!state.match || state.over || state.screen === 'home' || state.screen === 'setup') {
    panelSetup();
    return;
  }
  showModal(`
    <div class="modal__head"><h2 id="modal-title">Start a different game?</h2><p>Your current position is saved on this device until you replace it.</p></div>
    <div class="modal__body"><div class="button-stack"><button class="btn btn--primary" id="new-confirm">Choose a new match</button><button class="btn btn--secondary" id="new-cancel">Keep playing</button></div></div>`);
  $('new-cancel').onclick = hideModal;
  $('new-confirm').onclick = () => {
    hideModal();
    state.serial++;
    state.over = true;
    state.animating = false;
    state.match = null;
    // Abandoning mid-choice must not leave a dead exchange dialog behind.
    setPlayerAction(null);
    panelSetup();
  };
}

/* Global controls and boot */
$('skip-link').addEventListener('click', (event) => {
  const target = document.querySelector($('skip-link').getAttribute('href'));
  if (!target) return;
  event.preventDefault();
  if (target === board.el) {
    focusBoard({ keepActionVisible: !$('board-action').hidden });
    return;
  }
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
});
// Left/Right step through the game the way they do on a chess site, but
// only when the board does not have focus: there the arrows move between
// squares.
document.addEventListener('keydown', (event) => {
  if (!$('modal-scrim').hidden) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const active = document.activeElement;
  if (active === board.el || active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') return;
  if (state.screen !== 'playing' && state.screen !== 'exchange') return;
  if (!state.match || state.over || state.screen === 'exchange') return;
  event.preventDefault();
  stepReview(event.key === 'ArrowLeft' ? -1 : 1);
});

$('nav-new').onclick = requestNewGame;
$('nav-rules').onclick = showRules;
$('nav-sound').onclick = () => {
  const muted = sound.toggle();
  $('nav-sound').setAttribute('aria-pressed', String(!muted));
  $('nav-sound').setAttribute('aria-label', muted ? 'Sound off' : 'Sound on');
  $('nav-sound-label').textContent = muted ? 'Sound off' : 'Sound on';
};

function boot() {
  $('nav-sound').setAttribute('aria-pressed', String(!sound.muted));
  $('nav-sound').setAttribute('aria-label', sound.muted ? 'Sound off' : 'Sound on');
  $('nav-sound-label').textContent = sound.muted ? 'Sound off' : 'Sound on';
  board.setPosition(parseFen(START_FEN).board);
  board.setInteractive(null);
  panelHome();
  // Read-only introspection for the local test harness. Never on the
  // deployed site.
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    window.__mv = { state, board };
  }
}

boot();
