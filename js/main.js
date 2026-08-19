import { Chess } from './vendor/chess.js';
import { BlackHoleMatch, START_FEN, replayMatch } from './core/black-hole.js';
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
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const BOTS = {
  easy: {
    name: 'MottyBot', label: 'Casual', level: 'easy', minThink: 600,
    blurb: 'Makes a quick plan, but sometimes backs the wrong move or trap.',
  },
  medium: {
    name: 'MottyBot', label: 'Club', level: 'medium', minThink: 900,
    blurb: 'Reads farther ahead and usually punishes a loose piece or risky square.',
  },
  hard: {
    name: 'MottyBot', label: 'Expert', level: 'hard', minThink: 1200,
    blurb: 'Searches as deep as its clock allows and never blunders on purpose.',
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
  plannedBotMove: null,
};

const board = new BoardView($('board'), { onUserMove: handleUserMove });

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
    seed: `${state.match?.seed || 'game'}#bot-move#${state.match?.ply || 0}#${fen}`,
  });
  return result.move;
}

async function requestBotBlackHole(fen, botColor, level) {
  const sequence = (state.match?.selectionCount?.[botColor] || 0) + 1;
  const result = await requestWorker({
    kind: 'hole',
    fen,
    botColor,
    level,
    seed: `${state.match?.seed || 'game'}#bot-hole#${botColor}#${sequence}#${state.match?.ply || 0}`,
  });
  return result.strategy;
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

function syncBoard() {
  if (!state.match) return;
  board.verify(positionMap());
  board.setBlackHoleState({
    own: state.match.activeBlackHole(state.myColor),
    spent: null,
  });
}

function updateCheckMark(fen = state.match?.fen()) {
  if (!fen) return board.setCheck(null);
  const chess = new Chess(fen, { skipValidation: true });
  board.setCheck(chess.isCheck() ? kingSquare(chess.turn(), fen) : null);
}

function setThinking(on) { $('top-thinking').hidden = !on; }
function setPlayerAction(label = null, { phase = 'turn', title = '', copy = '', onCancel = null } = {}) {
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
  bubble.hidden = false;
  bubble.classList.remove('is-in');
  void bubble.offsetWidth; // restart the entrance animation on repeat lines
  bubble.classList.add('is-in');
  clearTimeout(tauntTimer);
  tauntTimer = setTimeout(() => { bubble.hidden = true; }, 4400);
}

function clearTaunt() {
  clearTimeout(tauntTimer);
  const bubble = $('bot-taunt');
  if (bubble) bubble.hidden = true;
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

function reactToBlackHole(event) {
  if (!event || !['playing', 'placing'].includes(state.screen)) return;
  const mine = event.victimColor === state.myColor;
  showTaunt(pickTaunt(mine ? 'holeHitYou' : 'holeHitMe', { chance: 0.65, minGapMs: 7000 }));
}

function setHoleStatus({ phase = 'idle', title, copy, route = '' }) {
  const strip = $('magic-strip');
  strip.dataset.phase = phase;
  $('magic-title').textContent = title;
  $('magic-copy').textContent = copy || '';
  $('magic-route').textContent = route;
  $('magic-route').hidden = !route;
}

function renderCaptured() {
  if (!state.match) {
    $('bottom-captured').innerHTML = '';
    $('top-captured').innerHTML = '';
    return;
  }
  const { byWhite, byBlack } = state.match.captured();
  const diff = byWhite.reduce((sum, type) => sum + VAL[type], 0) - byBlack.reduce((sum, type) => sum + VAL[type], 0);
  const mine = state.myColor === 'w' ? byWhite : byBlack;
  const theirs = state.myColor === 'w' ? byBlack : byWhite;
  const enemyColor = state.myColor === 'w' ? 'b' : 'w';
  const myDiff = state.myColor === 'w' ? diff : -diff;
  $('bottom-captured').innerHTML = mine.map((type) => pieceUse(enemyColor, type)).join('') +
    (myDiff > 0 ? `<span class="cap-score">+${myDiff}</span>` : '');
  $('top-captured').innerHTML = theirs.map((type) => pieceUse(state.myColor, type)).join('') +
    (myDiff < 0 ? `<span class="cap-score">+${-myDiff}</span>` : '');
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
      <h1>One square is lying to you.</h1>
      <p>You and MottyBot each hide a one-use black hole. Land on your opponent's square and your piece vanishes. Then the square opens again.</p>
    </div>
    <div class="desk-body">
      ${shared ? `
        <div class="resume-card">
          <strong>A shared trap is ready</strong>
          <p>Same MottyBot black-hole seed, ${escapeHTML(BOTS[shared.level].label.toLowerCase())} difficulty. You still choose your own secret square.</p>
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
      <div class="rule-sequence" role="group" aria-label="How a turn works">
        <div class="rule-step"><span class="rule-step__number">1</span><div><strong>Hide one black hole</strong><p>Any empty square. You see yours, MottyBot never does.</p></div></div>
        <div class="rule-step"><span class="rule-step__number">2</span><div><strong>Play legal chess</strong><p>Anything of theirs that lands on your square is gone. The square reopens at once.</p></div></div>
        <div class="rule-step"><span class="rule-step__number">3</span><div><strong>One fall, one re-arm</strong><p>Only the player whose trap fired picks a new square.</p></div></div>
      </div>
      <div class="button-stack">
        <button class="btn btn--primary" id="choose-game">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 18.5h14M8 18.5l1-7h6l1 7M9 7.5h6M10 4h4v3.5H10Z"/></svg>
          Play Black Hole Chess
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
    <div class="desk-head"><h1>Choose your match.</h1><p>MottyBot cannot see your secret square. Higher levels make stronger chess moves and sharper trap choices.</p></div>
    <div class="desk-body">
      <p class="section-title">Difficulty</p>
      <div class="difficulty-list" id="difficulty-list">
        ${Object.values(BOTS).map((bot) => `
          <button class="difficulty" type="button" data-level="${bot.level}" aria-pressed="${bot.level === level}">
            <strong>${bot.label}</strong><span>${bot.blurb}</span><em>${bot.level === 'easy' ? 'Quick' : bot.level === 'medium' ? 'Balanced' : 'Deep'}</em>
          </button>`).join('')}
      </div>
      <p class="section-title" style="margin-top:20px">Your color</p>
      <div class="color-choice" id="color-choice">
        <button type="button" data-color="w" aria-pressed="true">${pieceUse('w', 'k')}White</button>
        <button type="button" data-color="random" aria-pressed="false">${pieceUse('w', 'p')}Random</button>
        <button type="button" data-color="b" aria-pressed="false">${pieceUse('b', 'k')}Black</button>
      </div>
      <div class="button-stack">
        <button class="btn btn--primary" id="start-game">Start game</button>
        <button class="btn btn--quiet" id="setup-back">Back</button>
      </div>
    </div>`;

  $('difficulty-list').onclick = (event) => {
    const button = event.target.closest('[data-level]');
    if (!button) return;
    level = button.dataset.level;
    $('difficulty-list').querySelectorAll('button').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
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
  const ownHole = state.match?.activeBlackHole(state.myColor);
  panel.innerHTML = `
    <div class="desk-head">
      <div class="match-title"><h2>${escapeHTML(state.bot.name)}</h2><span class="difficulty-label">${escapeHTML(state.bot.label)} difficulty</span></div>
      <p>Your black hole is ${ownHole ? `<strong>${escapeHTML(ownHole)}</strong>` : 'waiting to be placed'}. MottyBot's is hidden.</p>
    </div>
    <div class="relocate-action" role="group" aria-label="Black-hole relocation">
      <button class="btn btn--magic" id="relocate-hole" type="button" aria-describedby="relocate-status">Move black hole</button>
      <span id="relocate-status"></span>
    </div>
    <div class="desk-body desk-body--moves"><div class="move-list" id="move-list"></div></div>
    <div class="desk-footer">
      <button class="btn btn--danger" id="resign-game">Resign</button>
      <button class="btn btn--quiet" id="game-rules">Rules</button>
    </div>`;
  $('resign-game').onclick = confirmResign;
  $('game-rules').onclick = showRules;
  $('relocate-hole').onclick = beginPlayerRelocation;
  renderMoveList();
  updateRelocateControl();
}

function panelPostGame() {
  setSkipTarget('panel', 'Skip to game review');
  panel.className = 'matchdesk';
  panel.innerHTML = `
    <div class="desk-head">
      <div class="match-title"><h2>Final position</h2><span class="difficulty-label">${escapeHTML(state.bot.label)} difficulty</span></div>
      <p>The moves, relocations, secret choices and every one-use trap remain available for review.</p>
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
  const log = state.match.log;
  const blocks = [];
  for (let i = 0; i < log.length; i++) {
    const entry = log[i];
    if (entry.kind === 'move') {
      const trigger = log[i + 1]?.kind === 'black-hole' ? log[i + 1] : null;
      const number = Math.floor(entry.ply / 2) + 1;
      blocks.push(`
        <div class="turn-record">
          <div class="move-line"><span class="move-number">${number}${entry.color === 'w' ? '.' : '…'}</span><span class="move-san">${escapeHTML(entry.san)}</span><span class="move-side">${entry.color === state.myColor ? 'You' : 'MottyBot'}</span></div>
          ${trigger ? `<div class="hole-line">${capitalize(PIECE_NAMES[trigger.piece.type])} lost at ${trigger.square}. Square reopened.</div>` : ''}
        </div>`);
    } else if (entry.kind === 'relocation') {
      const number = Math.floor(entry.ply / 2) + 1;
      blocks.push(`
        <div class="turn-record turn-record--relocation">
          <div class="move-line"><span class="move-number">${number}${entry.color === 'w' ? '.' : '…'}</span><span class="move-san">Black hole ${entry.from} to ${entry.to}</span><span class="move-side">${entry.color === state.myColor ? 'You' : 'MottyBot'}</span></div>
          <div class="hole-line">Turn used. ${entry.remaining} ${entry.remaining === 1 ? 'change' : 'changes'} left.</div>
        </div>`);
    }
  }
  wrap.innerHTML = blocks.length ? blocks.join('') : '<div class="empty-log">Your moves, relocations and every triggered black hole will appear here.</div>';
  const scroller = wrap.closest('.desk-body--moves');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

function capitalize(value) { return value.charAt(0).toUpperCase() + value.slice(1); }

/* Game setup and loop */
function configureBoardForMatch() {
  board.setOrientation(state.myColor);
  board.setPosition(positionMap());
  board.setLastMove(null);
  board.setBlackHoleState({
    own: state.match?.activeBlackHole(state.myColor),
    spent: null,
  });
  updateCheckMark();
  $('top-name').textContent = state.bot.name;
  $('top-detail').textContent = `${state.bot.label} difficulty`;
  $('bottom-name').textContent = 'You';
  $('bottom-detail').textContent = state.myColor === 'w' ? 'White' : 'Black';
  renderCaptured();
}

function opposingColor(color) { return color === 'w' ? 'b' : 'w'; }

function updateRelocateControl() {
  const button = $('relocate-hole');
  const status = $('relocate-status');
  if (!button || !status || !state.match) return;

  const match = state.match;
  const remaining = match.relocationsRemaining(state.myColor);
  const myTurn = state.screen === 'playing' && !state.over && match.turn() === state.myColor;
  const inCheck = myTurn && match.status().check;
  const hasAlternative = match.eligibleRelocationSquares(state.myColor).length > 0;
  const available = myTurn && match.canRelocateBlackHole(state.myColor);

  button.disabled = !available;
  if (remaining <= 0) status.textContent = 'All 3 changes used';
  else if (!match.activeBlackHole(state.myColor)) status.textContent = 'Waiting for your next trap';
  else if (inCheck) status.textContent = `Answer check first · ${remaining} left`;
  else if (!hasAlternative) status.textContent = `No other empty square · ${remaining} left`;
  else if (!myTurn) status.textContent = `Available on your turn · ${remaining} left`;
  else status.textContent = `Uses this turn · ${remaining} left`;
}

function panelHolePlacement({ initial = false, previousSquare = null } = {}) {
  setSkipTarget('board', 'Skip to black-hole selection');
  panel.className = 'matchdesk matchdesk--placing';
  panel.innerHTML = `
    <div class="desk-head">
      <h2>${initial ? 'Hide your black hole.' : 'Replace your black hole.'}</h2>
      <p>Select any empty square directly on the board. MottyBot will not be shown your choice.</p>
    </div>
    <div class="desk-body">
      <div class="placement-note">
        <strong>${initial ? 'Your trap works once.' : `${previousSquare} is open again.`}</strong>
        <p>${initial ? 'When MottyBot lands on it, that piece disappears. Later, you may also spend up to three turns moving an active trap.' : `You may arm ${previousSquare} again or choose any other empty square.`}</p>
      </div>
    </div>`;
}

function panelRelocation(currentSquare, remaining) {
  setSkipTarget('board', 'Skip to black-hole relocation');
  panel.className = 'matchdesk matchdesk--placing';
  panel.innerHTML = `
    <div class="desk-head">
      <h2>Choose a new square.</h2>
      <p>Move your black hole from <strong>${escapeHTML(currentSquare)}</strong> to a different empty square.</p>
    </div>
    <div class="desk-body">
      <div class="placement-note">
        <strong>This uses your whole turn.</strong>
        <p>The change counts only after you choose a square. You will have ${remaining - 1} ${remaining - 1 === 1 ? 'change' : 'changes'} left.</p>
      </div>
    </div>
    <div class="desk-footer"><button class="btn btn--secondary" id="cancel-relocation" type="button">Cancel</button></div>`;
}

function showArmedHoleStatus() {
  const own = state.match?.activeBlackHole(state.myColor);
  const remaining = state.match?.relocationsRemaining(state.myColor) || 0;
  setHoleStatus({
    phase: 'armed',
    title: own ? 'Your black hole is armed' : 'No black hole can be placed',
    copy: own
      ? remaining
        ? `Moving it uses your turn. ${remaining} of 3 optional changes remain.`
        : 'All three optional changes are used. Every spent square still returns to normal.'
      : 'There are no eligible empty squares left.',
    route: own || '',
  });
}

function beginPlayerRelocation() {
  const match = state.match;
  const serial = state.serial;
  if (!match || state.over || state.animating || state.screen !== 'playing' || !match.canRelocateBlackHole(state.myColor)) {
    sound.illegal();
    updateRelocateControl();
    return;
  }

  const currentSquare = match.activeBlackHole(state.myColor);
  const remaining = match.relocationsRemaining(state.myColor);
  const choices = match.eligibleRelocationSquares(state.myColor);
  state.screen = 'relocating';
  clearTaunt();
  panelRelocation(currentSquare, remaining);
  board.setBlackHoleState({ own: currentSquare, spent: null });

  const cancel = () => {
    if (state.serial !== serial || state.match !== match || state.over || state.screen !== 'relocating') return;
    state.screen = 'playing';
    syncBoard();
    panelPlaying();
    showArmedHoleStatus();
    botLoop(serial);
    announce('Black-hole relocation canceled. Your turn continues.');
    focusBoard();
  };

  setPlayerAction('Choose new square', {
    phase: 'selecting',
    title: 'Move your black hole',
    copy: 'Tap a marked empty square. This uses your turn.',
    onCancel: cancel,
  });

  const handleSelection = async (square) => {
    if (state.serial !== serial || state.match !== match || state.over || state.screen !== 'relocating') return;
    let relocation;
    try {
      relocation = match.relocateBlackHole(state.myColor, square);
    } catch {
      sound.illegal();
      board.setHoleSelection(choices, handleSelection, {
        instruction: 'Choose a different empty square for your black hole. Use arrow keys and press Enter to move it, or Escape to cancel.',
        choiceLabel: 'available for black-hole relocation',
        onCancel: cancel,
      });
      return;
    }

    state.plannedBotMove = null;
    state.screen = 'playing';
    syncBoard();
    panelPlaying();
    setYourTurn(false);
    board.setInteractive(null);
    sound.move();
    setHoleStatus({
      phase: 'armed',
      title: `Your black hole moved to ${square}`,
      copy: `Your turn is spent. ${relocation.remaining} ${relocation.remaining === 1 ? 'change remains' : 'changes remain'}.`,
      route: square,
    });
    persistGame();
    announce(`Your black hole moved from ${relocation.from} to ${square}. Your turn is over.`);

    if (match.status().over) {
      endGame();
      return;
    }
    if (state.serial !== serial || state.match !== match || state.over) return;
    persistGame();
    botLoop(serial);
  };

  $('cancel-relocation').onclick = cancel;
  board.setHoleSelection(choices, handleSelection, {
    instruction: 'Choose a different empty square for your black hole. Use arrow keys and press Enter to move it, or Escape to cancel.',
    choiceLabel: 'available for black-hole relocation',
    onCancel: cancel,
  });
  setHoleStatus({
    phase: 'selecting',
    title: 'Move your black hole',
    copy: `Choose a different empty square or cancel. Selecting a square ends your turn.`,
    route: `${remaining} left`,
  });
  announce(`Choose a different empty square for your black hole. You have ${remaining} changes left. Canceling keeps your turn.`);
  focusBoard({ keepActionVisible: true });
}

async function chooseBotBlackHole() {
  const match = state.match;
  const serial = state.serial;
  const botColor = opposingColor(state.myColor);
  if (!match || !match.selectionRequired(botColor) || state.over) return null;

  setYourTurn(false);
  setThinking(true);
  board.setInteractive(null);
  setHoleStatus({
    phase: 'selecting',
    title: 'MottyBot is choosing a trap',
    copy: `${state.bot.label} MottyBot is reading the position before it hides the next one.`,
  });
  announce('MottyBot is choosing its hidden black hole.');

  let strategy = null;
  try {
    strategy = await requestBotBlackHole(match.fen(), botColor, state.bot.level);
  } catch {
    strategy = null;
  }
  if (state.serial !== serial || state.match !== match || state.over) return null;

  const eligible = new Set(match.eligibleBlackHoles(botColor));
  const ranked = strategy?.candidates?.map((item) => item.square) || [];
  const square = ranked.find((candidate) => eligible.has(candidate));
  let placement = null;
  try {
    placement = square
      ? match.selectBlackHole(botColor, square, { automatic: true })
      : match.selectFallbackBlackHole(botColor);
  } catch {
    placement = match.selectFallbackBlackHole(botColor);
  }

  state.plannedBotMove = strategy?.plannedMove && match.turn() === botColor
    ? { fen: match.fen(), move: strategy.plannedMove }
    : null;
  setThinking(false);
  if (placement) announce('MottyBot chose its own hidden black hole.');
  return placement;
}

function choosePlayerBlackHole({ initial = false } = {}) {
  const match = state.match;
  const serial = state.serial;
  return new Promise((resolve) => {
    if (!match || match !== state.match || !match.selectionRequired(state.myColor)) {
      resolve(false);
      return;
    }
    const choices = match.eligibleBlackHoles(state.myColor);
    if (!choices.length) {
      resolve(false);
      return;
    }

    state.screen = 'placing';
    setThinking(false);
    clearTaunt();
    const previousSquare = initial ? null : match.lastTriggeredSquare(state.myColor);
    setPlayerAction(initial ? 'Choose black hole' : 'Choose new black hole', {
      phase: 'selecting',
      title: initial ? 'Choose your black hole' : 'Choose a new black hole',
      copy: previousSquare
        ? `Tap any marked empty square. ${previousSquare} is available again.`
        : 'Tap any marked empty square on the board.',
    });
    panelHolePlacement({ initial, previousSquare });
    board.setBlackHoleState({ own: null, spent: previousSquare });
    const handleSelection = async (square) => {
      if (state.serial !== serial || state.match !== match || state.over) return;
      try {
        match.selectBlackHole(state.myColor, square);
      } catch {
        sound.illegal();
        board.setHoleSelection(match.eligibleBlackHoles(state.myColor), handleSelection, { previousSquare });
        return;
      }
      if (state.serial !== serial || state.match !== match || state.over) return;
      state.screen = 'playing';
      syncBoard();
      panelPlaying();
      showArmedHoleStatus();
      persistGame();
      announce(`Your secret black hole is armed on ${square}. MottyBot cannot see it.`);
      resolve(true);
    };
    board.setHoleSelection(choices, handleSelection, { previousSquare });
    setHoleStatus({
      phase: 'selecting',
      title: initial ? 'Choose your secret black hole' : 'Replace your black hole',
      copy: previousSquare
        ? `${previousSquare} is available again, or select any other highlighted empty square.`
        : 'Select any highlighted empty square. Only you will see the marker.',
    });
    announce(initial
      ? 'Choose an empty square for your secret black hole.'
      : `Your black hole was used. ${previousSquare} is open again and may be selected again.`);
    focusBoard({ keepActionVisible: true });
  });
}

async function startBotGame(level, myColor, { seed = randomSeed() } = {}) {
  const serial = ++state.serial;
  state.match = new BlackHoleMatch(seed);
  const match = state.match;
  state.myColor = myColor;
  state.bot = BOTS[level] || BOTS.medium;
  state.over = false;
  state.animating = false;
  state.screen = 'placing';
  state.resultRecorded = false;
  state.result = null;
  state.replay = null;
  state.plannedBotMove = null;
  configureBoardForMatch();
  sound.unlock();
  sound.start();
  resetTaunts();
  clearTaunt();
  await choosePlayerBlackHole({ initial: true });
  if (state.serial !== serial || state.match !== match || state.over) return;
  const botColor = opposingColor(state.myColor);
  if (state.match.selectionRequired(botColor)) await chooseBotBlackHole();
  if (state.serial !== serial || state.match !== match || state.over) return;
  state.screen = 'playing';
  syncBoard();
  panelPlaying();
  showArmedHoleStatus();
  persistGame();
  showTaunt(pickTaunt('greeting', { always: true }));
  botLoop(serial);
}

async function resumeGame(data) {
  try {
    const serial = ++state.serial;
    state.match = replayMatch(data.seed, data.actions);
    const match = state.match;
    state.match.startedAt = data.startedAt || Date.now();
    state.myColor = data.myColor;
    state.bot = BOTS[data.level] || BOTS.medium;
    state.over = false;
    state.animating = false;
    state.screen = 'placing';
    state.resultRecorded = false;
    state.result = null;
    state.plannedBotMove = null;
    configureBoardForMatch();
    resetTaunts();
    clearTaunt();
    if (state.match.selectionRequired(state.myColor)) {
      await choosePlayerBlackHole({ initial: state.match.ply === 0 });
    }
    if (state.serial !== serial || state.match !== match || state.over) return;
    const botColor = opposingColor(state.myColor);
    if (state.match.selectionRequired(botColor)) await chooseBotBlackHole();
    if (state.serial !== serial || state.match !== match || state.over) return;
    state.screen = 'playing';
    syncBoard();
    panelPlaying();
    showArmedHoleStatus();
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
  if (instant) {
    await board.animateMove({ from: move.to, to: move.to, ...rookHop, epSquare, promotion: move.promotion, color: move.color });
  } else {
    await board.animateMove({ from: move.from, to: move.to, ...rookHop, epSquare, promotion: move.promotion, color: move.color });
  }
  if (state.match !== match || state.serial !== serial) return false;
  state.animating = false;
  if (state.over) return false;
  board.setLastMove(move.from, move.to);
  syncBoard();
  renderCaptured();
  renderMoveList();
  return true;
}

async function playBlackHole(events) {
  const match = state.match;
  const serial = state.serial;
  board.setInteractive(null);
  if (!events?.length) {
    updateCheckMark();
    persistGame();
    return;
  }

  const event = events[0];
  const owner = event.owner === state.myColor ? 'Your' : "MottyBot's";
  const victim = event.victimColor === state.myColor ? 'your' : "MottyBot's";
  state.animating = true;
  setHoleStatus({
    phase: 'triggered',
    title: `${owner} black hole opened on ${event.square}`,
    copy: `${capitalize(victim)} ${PIECE_NAMES[event.piece.type]} fell in. ${event.square} is open again.`,
    route: event.square,
  });
  announce(`${owner} black hole opened on ${event.square}. ${capitalize(victim)} ${PIECE_NAMES[event.piece.type]} was removed. The square is open again.`);
  sound.blackHole();
  await board.animateBlackHole({
    ...event,
    consumeOwnHole: event.owner === state.myColor,
  });
  if (state.match !== match || state.serial !== serial) return;
  state.animating = false;
  if (state.over) return;
  syncBoard();
  renderMoveList();
  renderCaptured();
  updateCheckMark();
  reactToBlackHole(event);

  if (match.status().over) {
    persistGame();
    return;
  }

  if (event.owner === state.myColor) {
    await choosePlayerBlackHole();
  } else {
    const replacement = await chooseBotBlackHole();
    if (state.match !== match || state.serial !== serial || state.over) return;
    syncBoard();
    setHoleStatus({
      phase: 'armed',
      title: replacement ? 'MottyBot hid a new black hole' : 'MottyBot has no empty square left',
      copy: replacement
        ? `Its new trap is secret. Your black hole remains armed on ${match.activeBlackHole(state.myColor)}.`
        : `Your black hole remains armed on ${match.activeBlackHole(state.myColor)}.`,
      route: `${match.blackHolesTriggered()} triggered`,
    });
  }
  if (state.match !== match || state.serial !== serial || state.over) return;
  persistGame();
}

async function botLoop(serial) {
  const match = state.match;
  while (!state.over && state.screen === 'playing' && state.match === match && state.serial === serial) {
    const resolvedHole = match.resolveBlackHoleIfDue();
    if (resolvedHole !== null) await playBlackHole(resolvedHole);
    if (state.over || state.screen !== 'playing' || state.match !== match || state.serial !== serial) return;

    const status = match.status();
    if (status.over) {
      endGame();
      return;
    }
    if (status.check) sound.check();

    if (match.turn() === state.myColor) {
      setThinking(false);
      setYourTurn(true);
      board.setInteractive(state.myColor, (square) => match.legalMoves(square));
      showArmedHoleStatus();
      updateRelocateControl();
      announce(status.check ? 'Your king is in check. Your move.' : 'Your move.');
      return;
    }

    setYourTurn(false);
    updateRelocateControl();
    board.setInteractive(null);
    setThinking(true);
    const started = performance.now();
    let candidate;
    const planned = state.plannedBotMove?.fen === match.fen() ? state.plannedBotMove.move : null;
    state.plannedBotMove = null;
    try {
      candidate = planned || await requestBotMove(match.fen(), state.bot.level);
    } catch {
      const legal = match.legalMoves();
      candidate = legal.length ? { from: legal[0].from, to: legal[0].to, promotion: legal[0].promotion } : null;
    }
    const remaining = planned ? 0 : state.bot.minThink - (performance.now() - started);
    if (remaining > 0) await wait(remaining);
    setThinking(false);
    if (!candidate || state.over || state.screen !== 'playing' || state.match !== match || state.serial !== serial) return;
    const move = match.applyMove(candidate);
    persistGame();
    announce(`MottyBot moved from ${move.from} to ${move.to}.`);
    if (!await playMoveAnimation(move)) return;
    reactToMove(move, true);
  }
}

async function handleUserMove({ from, to, promotion, instant }) {
  const match = state.match;
  if (!match || state.over || state.animating || state.screen !== 'playing') return;
  if (match.turn() !== state.myColor) return;
  let move;
  try {
    move = match.applyMove({ from, to, promotion });
  } catch {
    sound.illegal();
    syncBoard();
    return;
  }
  setYourTurn(false);
  updateRelocateControl();
  board.setInteractive(null);
  persistGame();
  if (!await playMoveAnimation(move, { instant })) return;
  reactToMove(move, false);
  botLoop(state.serial);
}

/* Results and replay */
function outcomeFor(status) {
  if (!status.winner) return 'draw';
  return status.winner === state.myColor ? 'win' : 'loss';
}

function reasonText(status, outcome) {
  if (status.reason === 'checkmate') return 'by checkmate';
  if (status.reason === 'black hole') {
    return outcome === 'win' ? "MottyBot's king fell into your black hole" : 'your king fell into a black hole';
  }
  if (status.reason === 'stalemate') return 'by stalemate';
  if (status.reason === 'insufficient material') return 'by insufficient material';
  if (status.reason === 'fifty-move rule') return 'by the fifty-move rule';
  if (status.reason === 'resignation') return outcome === 'win' ? 'MottyBot resigned' : 'you resigned';
  return status.reason || 'game over';
}

function endGame() {
  if (!state.match || state.over) return;
  const status = state.match.status();
  if (!status.over) return;
  state.over = true;
  state.animating = false;
  state.screen = 'postgame';
  board.setInteractive(null);
  setThinking(false);
  setYourTurn(false);
  clearActive();

  const outcome = outcomeFor(status);
  if (!state.resultRecorded) {
    recordResult(outcome);
    state.resultRecorded = true;
  }
  const moves = state.match.log.filter((entry) => entry.kind === 'move').length;
  const triggers = state.match.log.filter((entry) => entry.kind === 'black-hole').length;
  const captures = state.match.log.filter((entry) => entry.kind === 'move' && entry.captured).length;
  const signOff = pickTaunt(
    outcome === 'draw' ? 'draw'
      : outcome === 'win' ? (status.reason === 'black hole' ? 'botHoleLose' : 'botLose')
        : status.reason === 'black hole' ? 'botHoleWin'
        : status.reason === 'resignation' ? 'playerResign' : 'botWin',
    { always: true },
  );
  state.result = { status, outcome, moves, triggers, captures, signOff };
  sound.end(outcome === 'win');
  clearTaunt();
  panelPostGame();
  showResultModal();
}

function showResultModal() {
  const { status, outcome, moves, triggers, captures, signOff } = state.result;
  // Speak to the player. "MottyBot won" makes you work out what happened to
  // you; "You lost" does not.
  const headline = outcome === 'win' ? 'You won' : outcome === 'loss' ? 'You lost' : 'Draw';
  const note = outcome === 'win'
    ? 'You guarded your secret and found MottyBot before it found you.'
    : outcome === 'loss'
      ? 'One hidden square was enough. Choose a new board and try to return the favor.'
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
        <div><strong>${triggers}</strong><span>Triggered</span></div>
        <div><strong>${captures}</strong><span>Captures</span></div>
      </div>
      <div class="button-stack">
        <button class="btn btn--primary" id="result-share">
          <svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 15V3"/><path d="M8 7l4-4 4 4"/></svg>
          Share result
        </button>
        <button class="btn btn--secondary" id="result-new">Play again</button>
        <button class="btn btn--secondary" id="result-same">Replay the same seed</button>
        <button class="btn btn--quiet" id="result-review">Review the game</button>
      </div>
      <div class="copy-confirm" id="copy-confirm" aria-live="polite"></div>
    </div>`);
  $('result-new').onclick = () => { hideModal(); startBotGame(state.bot.level, state.myColor); };
  $('result-same').onclick = () => { const seed = state.match.seed; hideModal(); startBotGame(state.bot.level, state.myColor, { seed }); };
  $('result-review').onclick = () => { hideModal(); enterReplay(); };
  $('result-share').onclick = shareResult;
}

function resultSentence() {
  const { outcome, moves } = state.result;
  const who = `${state.bot.label} MottyBot`;
  const verb = outcome === 'win' ? `I beat ${who}`
    : outcome === 'loss' ? `${who} beat me`
      : `I drew with ${who}`;
  return `${verb} at Chess (Motty's Version) in ${moves} moves. We each hid a one-use black hole, and every spent square opened again.`;
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
    if (confirm) confirm.textContent = 'Could not copy. The link is in your address bar.';
  }
}

function buildReplayFrames() {
  const frames = [{ fen: START_FEN, kind: 'start', label: 'Starting position', detail: 'Before the secret squares were chosen', ownHole: null, spent: null }];
  const active = { w: null, b: null };
  for (const entry of state.match.log) {
    if (entry.kind === 'placement') {
      active[entry.color] = entry.square;
      if (entry.color === state.myColor) {
        frames.push({
          fen: entry.fenAfter,
          kind: 'placement',
          label: `Your black hole: ${entry.square}`,
          detail: entry.sequence === 1
            ? 'Your opening secret'
            : entry.square === entry.previousSquare ? 'You armed the same square again' : 'Your replacement secret',
          ownHole: entry.square,
          spent: null,
          square: entry.square,
        });
      }
    } else if (entry.kind === 'move') {
      const number = Math.floor(entry.ply / 2) + 1;
      frames.push({
        fen: entry.fenAfter,
        kind: 'move',
        label: `${number}${entry.color === 'w' ? '.' : '…'} ${entry.san}`,
        detail: entry.color === state.myColor ? 'Your move' : "MottyBot's move",
        from: entry.from,
        to: entry.to,
        ownHole: active[state.myColor],
        spent: null,
      });
    } else if (entry.kind === 'relocation') {
      active[entry.color] = entry.to;
      if (entry.color === state.myColor) {
        frames.push({
          fen: entry.fenAfter,
          kind: 'relocation',
          label: `Your black hole: ${entry.from} to ${entry.to}`,
          detail: `You used your turn and have ${entry.remaining} ${entry.remaining === 1 ? 'change' : 'changes'} left`,
          ownHole: entry.to,
          spent: null,
          square: entry.to,
        });
      }
    } else if (entry.kind === 'black-hole') {
      active[entry.owner] = null;
      frames.push({
        fen: entry.fenAfter,
        kind: 'black-hole',
        label: `${capitalize(PIECE_NAMES[entry.piece.type])} lost on ${entry.square}`,
        detail: `${entry.square} opened again immediately`,
        square: entry.square,
        piece: entry.piece,
        victimColor: entry.victimColor,
        ownHole: active[state.myColor],
        spent: entry.square,
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
    <div class="desk-head"><h2>Review the game.</h2><p>Step through every move, relocation, secret-square choice and triggered trap.</p></div>
    <div class="replay-readout"><strong id="replay-label"></strong><span id="replay-detail"></span></div>
    <div class="replay-controls" role="group" aria-label="Replay controls">
      <button id="replay-start" aria-label="First position">|‹</button>
      <button id="replay-prev" aria-label="Previous position">‹</button>
      <button id="replay-next" aria-label="Next position">›</button>
      <button id="replay-end" aria-label="Final position">›|</button>
    </div>
    <div class="desk-body"><p style="color:var(--muted);line-height:1.5;margin:0">MottyBot's active black hole stays secret in review. Your own choices and every triggered square remain visible.</p></div>
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
  board.setLastMove(frame.kind === 'move' ? frame.from : null, frame.kind === 'move' ? frame.to : null);
  board.setBlackHoleState({ own: frame.ownHole, spent: frame.spent || null });
  updateCheckMark(frame.fen);
  $('replay-label').textContent = frame.label;
  $('replay-detail').textContent = `${frame.detail}. Frame ${state.replay.index + 1} of ${state.replay.frames.length}.`;
  $('replay-start').disabled = state.replay.index === 0;
  $('replay-prev').disabled = state.replay.index === 0;
  $('replay-next').disabled = state.replay.index === max;
  $('replay-end').disabled = state.replay.index === max;
  if (frame.kind === 'black-hole') {
    const victim = frame.victimColor === state.myColor ? 'your' : "MottyBot's";
    setHoleStatus({ phase: 'triggered', title: `Black hole opened on ${frame.square}`, copy: `${capitalize(victim)} ${PIECE_NAMES[frame.piece.type]} disappeared. The square reopened.`, route: frame.square });
  } else if (frame.kind === 'placement') {
    setHoleStatus({ phase: 'armed', title: 'Your black hole is armed', copy: frame.detail, route: frame.square });
  } else if (frame.kind === 'relocation') {
    setHoleStatus({ phase: 'armed', title: `Your black hole moved to ${frame.square}`, copy: frame.detail, route: frame.square });
  } else {
    setHoleStatus({ title: frame.label, copy: frame.detail });
  }
}

function exitReplay() {
  state.screen = 'postgame';
  state.replay = null;
  board.setPosition(positionMap());
  board.setLastMove(null);
  board.setBlackHoleState({ own: state.match.activeBlackHole(state.myColor), spent: null });
  updateCheckMark();
  showArmedHoleStatus();
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
    <div class="modal__head"><h2 id="modal-title">Black Hole Chess.</h2><p>Ordinary chess, plus one hidden trap each.</p></div>
    <div class="modal__body">
      <ol class="rule-list">
        <li><span class="rule-mark">1</span><span><b>You each hide one black hole.</b> Any empty square. You see yours, MottyBot never sees it, and you may both pick the same square without knowing.</span></li>
        <li><span class="rule-mark">2</span><span><b>It only swallows your opponent.</b> Your own pieces sit on it safely, and a piece has to land there. Passing over it does nothing.</span></li>
        <li><span class="rule-mark">3</span><span><b>Whatever lands there is gone.</b> That includes a rook landing as you castle. If the move was a capture, both pieces leave the board: the one that was taken, and the one that took it.</span></li>
        <li><span class="rule-mark">4</span><span><b>One trap, one victim.</b> The square turns ordinary the instant it fires, and anything may use it later. Only the player whose trap fired picks a new square; your opponent keeps theirs.</span></li>
        <li><span class="rule-mark">5</span><span><b>You can move your trap three times a game.</b> It costs your whole turn instead of a chess move, and you cannot do it while your king is in check.</span></li>
        <li><span class="rule-mark">6</span><span><b>Your king is not safe either.</b> If your king lands on their trap, you lose on the spot. Checkmate, stalemate, resignation and the fifty-move rule all still work, and two bare kings keep playing, because a trap can still end it.</span></li>
      </ol>
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
  const lobby = new BlackHoleMatch('lobby-board');
  board.setPosition(parseFen(lobby.fen()).board);
  board.setBlackHoleState({ own: null, spent: null });
  board.setInteractive(null);
  panelHome();
}

boot();
