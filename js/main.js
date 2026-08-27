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
    blurb: 'Makes a quick plan, but sometimes backs the wrong move or trade.',
  },
  medium: {
    name: 'MottyBot', label: 'Club', level: 'medium', minThink: 900,
    blurb: 'Reads farther ahead and usually punishes a loose piece or a bad trade.',
  },
  hard: {
    name: 'MottyBot', label: 'Expert', level: 'hard', minThink: 1200,
    blurb: 'Searches as deep as its clock allows and weighs every homecoming.',
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

// Ask MottyBot to compare candidate positions: the plain chess move first,
// then each possible homecoming. Ties keep the plain move.
async function requestBotChoice(fens) {
  const probeMs = state.bot.level === 'hard' ? 420 : state.bot.level === 'medium' ? 260 : 140;
  return requestWorker({
    kind: 'choose',
    fens,
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

function syncBoard() {
  if (!state.match) return;
  board.verify(positionMap());
}

function updateCheckMark(fen = state.match?.fen()) {
  if (!fen) return board.setCheck(null);
  const chess = new Chess(fen, { skipValidation: true });
  board.setCheck(chess.isCheck() ? kingSquare(chess.turn(), fen) : null);
}

function setThinking(on) { $('top-thinking').hidden = !on; }
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

function setTradeStatus({ phase = 'idle', title, copy, route = '' }) {
  const strip = $('trade-strip');
  strip.dataset.phase = phase;
  $('trade-title').textContent = title;
  $('trade-copy').textContent = copy || '';
  $('trade-route').textContent = route;
  $('trade-route').hidden = !route;
}

// The idle strip: what is waiting in the player's graveyard, if anything.
function showTradeStatus() {
  const match = state.match;
  if (!match) return;
  const waiting = match.graveyard(state.myColor);
  if (!waiting.length) {
    setTradeStatus({
      phase: 'idle',
      title: 'Every piece remembers home',
      copy: 'When a knight, bishop, rook or queen of yours falls, capture a matching enemy piece and you may bring yours back instead.',
    });
    return;
  }
  const names = waiting.map((entry) => PIECE_NAMES[entry.type]);
  const openCount = waiting.filter((entry) => entry.open.length).length;
  setTradeStatus({
    phase: 'armed',
    title: `Waiting to come home: ${names.join(', ')}`,
    copy: openCount
      ? 'Capture a matching enemy piece and you may bring yours back instead of taking theirs.'
      : 'Every home square is blocked right now. Clear it and a matching capture brings yours back.',
    route: `${waiting.length} fallen`,
  });
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
      <h1>Nothing you lose is gone for good.</h1>
      <p>This week's rules: Prisoner Exchange. Every piece remembers its starting square, and a matching capture can bring your dead back home.</p>
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
      <div class="rule-sequence" role="group" aria-label="How the exchange works">
        <div class="rule-step"><span class="rule-step__number">1</span><div><strong>Lose a piece</strong><p>It waits in your graveyard, remembering the square it started on.</p></div></div>
        <div class="rule-step"><span class="rule-step__number">2</span><div><strong>Capture its twin</strong><p>Take an enemy piece of the same kind, anywhere on the board.</p></div></div>
        <div class="rule-step"><span class="rule-step__number">3</span><div><strong>Or bring yours home</strong><p>Undo the take: their piece lives, and yours returns to its starting square.</p></div></div>
      </div>
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
    <div class="desk-head"><h1>Choose your match.</h1><p>Higher levels make stronger chess moves and judge every homecoming more sharply.</p></div>
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
  panel.innerHTML = `
    <div class="desk-head">
      <div class="match-title"><h2>${escapeHTML(state.bot.name)}</h2><span class="difficulty-label">${escapeHTML(state.bot.label)} difficulty</span></div>
      <p>Capture a piece that matches one of your dead, and you may bring yours home instead of taking theirs.</p>
    </div>
    <div class="graveyards" id="graveyards"></div>
    <div class="desk-body desk-body--moves"><div class="move-list" id="move-list"></div></div>
    <div class="desk-footer">
      <button class="btn btn--danger" id="resign-game">Resign</button>
      <button class="btn btn--quiet" id="game-rules">Rules</button>
    </div>`;
  $('resign-game').onclick = confirmResign;
  $('game-rules').onclick = showRules;
  renderGraveyards();
  renderMoveList();
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

// The two graveyards, in full view: this variant has no secrets.
function renderGraveyards() {
  const wrap = $('graveyards');
  if (!wrap || !state.match) return;
  const row = (label, color) => {
    const waiting = state.match.graveyard(color);
    const items = waiting.length
      ? `<ul>${waiting.map((entry) => {
        const open = entry.open.length > 0;
        const where = open ? `${entry.open.join(' or ')} open` : `${entry.homes.join(' and ')} blocked`;
        return `<li class="${open ? 'is-open' : ''}" aria-label="${PIECE_NAMES[entry.type]}, ${where}">${pieceUse(color, entry.type)}<span>${where}</span></li>`;
      }).join('')}</ul>`
      : '<span class="empty-note">Nothing waiting</span>';
    return `<div class="graveyard-row"><strong>${label}</strong>${items}</div>`;
  };
  wrap.innerHTML = row('Your fallen', state.myColor) + row("MottyBot's", state.myColor === 'w' ? 'b' : 'w');
}

function renderMoveList() {
  const wrap = $('move-list');
  if (!wrap || !state.match) return;
  const blocks = [];
  for (const entry of state.match.log) {
    const number = Math.floor(entry.ply / 2) + 1;
    const marker = `${number}${entry.color === 'w' ? '.' : '…'}`;
    const side = entry.color === state.myColor ? 'You' : 'MottyBot';
    if (entry.kind === 'move') {
      blocks.push(`
        <div class="turn-record">
          <div class="move-line"><span class="move-number">${marker}</span><span class="move-san">${escapeHTML(entry.san)}</span><span class="move-side">${side}</span></div>
        </div>`);
    } else if (entry.kind === 'resurrect') {
      blocks.push(`
        <div class="turn-record turn-record--return">
          <div class="move-line"><span class="move-number">${marker}</span><span class="move-san">${capitalize(PIECE_NAMES[entry.piece])} home to ${entry.home}</span><span class="move-side">${side}</span></div>
          <div class="trade-line">Spared the ${PIECE_NAMES[entry.declined.victimType]} on ${entry.declined.victimSquare}.</div>
        </div>`);
    }
  }
  wrap.innerHTML = blocks.length ? blocks.join('') : '<div class="empty-log">Your moves and every homecoming will appear here.</div>';
  const scroller = wrap.closest('.desk-body--moves');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
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
  renderCaptured();
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
  configureBoardForMatch();
  sound.unlock();
  sound.start();
  resetTaunts();
  clearTaunt();
  panelPlaying();
  showTradeStatus();
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
    configureBoardForMatch();
    resetTaunts();
    clearTaunt();
    panelPlaying();
    showTradeStatus();
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
  renderGraveyards();
  showTradeStatus();
  updateCheckMark();
  return true;
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
  setTradeStatus({
    phase: 'triggered',
    title: byBot
      ? `MottyBot's ${pieceName} came home to ${event.home}`
      : `Your ${pieceName} came home to ${event.home}`,
    copy: byBot
      ? `It spared your ${victimName} on ${event.declined.victimSquare} to do it.`
      : `You spared MottyBot's ${victimName} on ${event.declined.victimSquare} to do it.`,
    route: event.home,
  });
  announce(byBot
    ? `MottyBot declined the capture on ${event.declined.victimSquare}. Its ${pieceName} returned to ${event.home}.`
    : `You declined the capture. Your ${pieceName} returned to ${event.home}.`);
  await board.animateResurrection({ square: event.home, color: event.color, type: event.piece });
  if (state.match !== match || state.serial !== serial) return false;
  state.animating = false;
  if (state.over) return false;
  board.setLastMove(event.declined.victimSquare, event.home);
  syncBoard();
  renderCaptured();
  renderMoveList();
  renderGraveyards();
  updateCheckMark();
  showTaunt(pickTaunt(byBot ? 'botReturn' : 'playerReturn', { always: true }));
  return true;
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
      if (fen) alternatives.push({ capture: { from: move.from, to: move.to, promotion: move.promotion }, home, fen });
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
      setYourTurn(true);
      board.setInteractive(state.myColor, (square) => match.legalMoves(square));
      showTradeStatus();
      announce(status.check ? 'Your king is in check. Your move.' : 'Your move.');
      return;
    }

    setYourTurn(false);
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
        const choice = await requestBotChoice(fens);
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

    if (action.kind === 'resurrect') {
      let event = null;
      try {
        event = match.resurrect({ ...action.capture, home: action.home });
      } catch {
        const legal = match.legalMoves();
        if (!legal.length) return;
        action = { kind: 'move', move: { from: legal[0].from, to: legal[0].to, promotion: legal[0].promotion } };
      }
      if (event) {
        persistGame();
        if (!await playResurrection(event, true)) return;
        continue;
      }
    }
    const move = match.applyMove(action.move);
    persistGame();
    announce(`MottyBot moved from ${move.from} to ${move.to}.`);
    if (!await playMoveAnimation(move)) return;
    reactToMove(move, true);
  }
}

async function performUserMove({ from, to, promotion, instant }) {
  const match = state.match;
  let move;
  try {
    move = match.applyMove({ from, to, promotion });
  } catch {
    sound.illegal();
    syncBoard();
    return;
  }
  setYourTurn(false);
  board.setInteractive(null);
  persistGame();
  if (!await playMoveAnimation(move, { instant })) return;
  reactToMove(move, false);
  botLoop(state.serial);
}

function handleUserMove({ from, to, promotion, instant }) {
  const match = state.match;
  if (!match || state.over || state.animating || state.screen !== 'playing') return;
  if (match.turn() !== state.myColor) return;
  let options = null;
  try {
    options = match.resurrectionOptions({ from, to, promotion });
  } catch {
    options = null;
  }
  if (options) {
    beginExchangeChoice({ from, to, promotion, instant }, options);
    return;
  }
  performUserMove({ from, to, promotion, instant });
}

// The player just gestured a capture that could instead bring a piece home.
// Freeze the board and put the choice on the action bar.
function beginExchangeChoice(pending, options) {
  const match = state.match;
  const serial = state.serial;
  state.screen = 'exchange';
  board.setInteractive(null);
  // A drag gesture already snapped the piece's sprite onto the target square,
  // but the capture has NOT been played. verify() cannot catch that (the
  // piece map is still correct, only the sprite drifted), so rebuild
  // unconditionally: the capturer visibly returns to its square while the
  // choice is open.
  board.setPosition(positionMap());
  clearTaunt();
  const victimName = PIECE_NAMES[options.victimType];
  const homes = options.homes;

  const backToPlay = () => {
    if (state.serial !== serial || state.match !== match || state.over) return;
    state.screen = 'playing';
    syncBoard();
    setYourTurn(true);
    board.setInteractive(state.myColor, (square) => match.legalMoves(square));
    showTradeStatus();
    announce('Choice canceled. Your move.');
    focusBoard();
  };

  const takeIt = () => {
    if (state.serial !== serial || state.match !== match || state.over || state.screen !== 'exchange') return;
    state.screen = 'playing';
    setPlayerAction(null);
    performUserMove(pending);
  };

  const doResurrect = async (home) => {
    if (state.serial !== serial || state.match !== match || state.over) return;
    let event;
    try {
      event = match.resurrect({ from: pending.from, to: pending.to, promotion: pending.promotion, home });
    } catch {
      sound.illegal();
      backToPlay();
      return;
    }
    state.screen = 'playing';
    setPlayerAction(null);
    board.setInteractive(null);
    persistGame();
    if (!await playResurrection(event, false)) return;
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
      onCancel: backToPlay,
    });
    board.setSquareSelection(homes, (square) => { void doResurrect(square); }, {
      instruction: `Choose which starting square your ${victimName} returns to. Press Escape to cancel.`,
      choiceLabel: `open starting square for your ${victimName}`,
      onCancel: backToPlay,
    });
    announce(`Choose which starting square your ${victimName} returns to: ${homes.join(' or ')}.`);
    focusBoard({ keepActionVisible: true });
  };

  setPlayerAction('Your choice', {
    phase: 'selecting',
    title: `Take the ${victimName}, or bring yours home?`,
    copy: homes.length === 1
      ? `Take MottyBot's ${victimName} on ${options.victimSquare}, or spare it and your ${victimName} returns to ${homes[0]}.`
      : `Take MottyBot's ${victimName} on ${options.victimSquare}, or spare it and yours returns to ${homes.join(' or ')}.`,
    onCancel: backToPlay,
    buttons: [
      { label: 'Take it', kind: 'btn--primary', onClick: takeIt },
      { label: 'Bring mine home', kind: 'btn--magic', onClick: bringHome },
    ],
  });
  setTradeStatus({
    phase: 'selecting',
    title: 'A homecoming is on the table',
    copy: `Spare their ${victimName} and your dead ${victimName} returns to ${homes.join(' or ')}.`,
    route: homes.join(' '),
  });
  announce(`You may take the ${victimName} on ${options.victimSquare}, or bring your own ${victimName} home to ${homes.join(' or ')}. Choose on the action bar.`);
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
  state.over = true;
  state.animating = false;
  state.screen = 'postgame';
  board.setInteractive(null);
  setThinking(false);
  setYourTurn(false);
  clearActive();

  setTradeStatus({ phase: 'idle', title: 'Game over', copy: 'Review the game or start a new one.' });
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
  if (frame.kind === 'resurrect') {
    setTradeStatus({ phase: 'triggered', title: frame.label.replace(/^\S+ /, ''), copy: frame.detail, route: frame.to });
  } else {
    setTradeStatus({ title: frame.label, copy: frame.detail });
  }
}

function exitReplay() {
  state.screen = 'postgame';
  state.replay = null;
  board.setPosition(positionMap());
  board.setLastMove(null);
  updateCheckMark();
  showTradeStatus();
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
        <li><span class="rule-mark">3</span><span><b>Capture a matching piece and choose.</b> Take it off the board like normal chess, or spare it: their piece stays where it stood, your dead piece of the same kind returns to its starting square, and your turn ends.</span></li>
        <li><span class="rule-mark">4</span><span><b>Home must be empty.</b> If the starting square is occupied, that piece cannot come back yet. A promoted piece that dies waits like any other and returns to the standard square of its kind.</span></li>
        <li><span class="rule-mark">5</span><span><b>No limits.</b> Every fresh matching capture is another chance, and each return uses up one dead piece.</span></li>
        <li><span class="rule-mark">6</span><span><b>Everything else is chess.</b> Check, checkmate, castling, promotion. Draws: stalemate, threefold repetition, the fifty-move rule, or nothing left but the two kings. A returned rook cannot castle, and in check a return must block the check.</span></li>
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
