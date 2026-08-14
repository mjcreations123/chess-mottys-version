import { Chess } from './vendor/chess.js';
import { ChaosMatch, START_FEN, replayMatch } from './core/chaos.js';
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
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const BOTS = {
  easy: {
    name: 'MottyBot', label: 'Casual', level: 'easy', minThink: 600,
    blurb: 'Looks two moves ahead and lets things slide. Beatable on purpose.',
  },
  medium: {
    name: 'MottyBot', label: 'Club', level: 'medium', minThink: 900,
    blurb: 'Six moves ahead. Punishes a loose piece and rarely misses a tactic.',
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
};

const board = new BoardView($('board'), { onUserMove: handleUserMove });

/* Worker */
let worker = null;
let workerSeq = 0;
function requestBotMove(fen, level) {
  if (!worker) worker = new Worker('/js/ai.worker.js', { type: 'module' });
  return new Promise((resolve, reject) => {
    const id = ++workerSeq;
    const onMessage = (event) => {
      if (event.data.id !== id) return;
      worker.removeEventListener('message', onMessage);
      event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.move);
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({
      id,
      fen,
      level,
      // Deliberately separate from the Magic seed. The bot receives the board,
      // difficulty and a search tie-break seed, never the upcoming teleport.
      seed: `bot-search-${state.match?.ply || 0}-${fen}`,
    });
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

function kingSquare(color, fen = state.match?.fen()) {
  if (!fen) return null;
  for (const [sq, piece] of positionMap(fen)) {
    if (piece.type === 'k' && piece.color === color) return sq;
  }
  return null;
}

function syncBoard() {
  if (state.match) board.verify(positionMap());
}

function updateCheckMark(fen = state.match?.fen()) {
  if (!fen) return board.setCheck(null);
  const chess = new Chess(fen);
  board.setCheck(chess.isCheck() ? kingSquare(chess.turn(), fen) : null);
}

function setThinking(on) { $('top-thinking').hidden = !on; }
function setYourTurn(on) { $('turn-tag').hidden = !on; }

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

function reactToTeleport(event) {
  if (!event || state.screen !== 'playing') return;
  const mine = event.piece.color === state.myColor;
  showTaunt(pickTaunt(mine ? 'magicHitYou' : 'magicHitMe', { chance: 0.45, minGapMs: 11000 }));
}

function setMagic({ phase = 'idle', title, copy, route = '' }) {
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

function moveUcIs() {
  return state.match ? state.match.log.filter((entry) => entry.kind === 'move').map((entry) => entry.uci) : [];
}

function persistGame() {
  if (!state.match || state.over) return;
  saveActive({
    seed: state.match.seed,
    ucis: moveUcIs(),
    myColor: state.myColor,
    level: state.bot.level,
    startedAt: state.match.startedAt,
  });
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
      <h1>Every move changes twice.</h1>
      <p>Play real chess against MottyBot. After each move, Motty's magical powers relocate one piece from that same side.</p>
    </div>
    <div class="desk-body">
      ${shared ? `
        <div class="resume-card">
          <strong>A shared chaos is ready</strong>
          <p>Same starting seed, ${escapeHTML(BOTS[shared.level].label.toLowerCase())} difficulty. Your moves still decide what happens next.</p>
          <button class="btn btn--magic" id="play-shared">Play this challenge</button>
        </div>` : ''}
      ${active ? `
        <div class="resume-card">
          <strong>Continue your game</strong>
          <p>${active.ucis.length} moves saved against ${escapeHTML(BOTS[active.level].label)} MottyBot.</p>
          <div class="inline-actions">
            <button class="btn btn--primary" id="resume-game">Resume</button>
            <button class="btn btn--quiet" id="discard-game">Discard</button>
          </div>
        </div>` : ''}
      <div class="rule-sequence" aria-label="How a turn works">
        <div class="rule-step"><span class="rule-step__number">1</span><div><strong>You make a legal move</strong><p>Normal chess rules apply to every move you choose.</p></div></div>
        <div class="rule-step"><span class="rule-step__number">2</span><div><strong>One of your pieces teleports</strong><p>Every eligible piece and every eligible empty destination are random.</p></div></div>
        <div class="rule-step"><span class="rule-step__number">3</span><div><strong>Motty's powers stop at ten pieces</strong><p>Down to ten pieces on the board, Motty's magical powers stop for good and the endgame is plain chess.</p></div></div>
      </div>
      <div class="button-stack">
        <button class="btn btn--primary" id="choose-game">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 18.5h14M8 18.5l1-7h6l1 7M9 7.5h6M10 4h4v3.5H10Z"/></svg>
          Play MottyBot
        </button>
      </div>
      ${stats.played ? `
        <div class="stats-line" aria-label="Your results on this device">
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
  panel.className = 'matchdesk matchdesk--setup';
  board.setInteractive(null);
  let level = 'medium';
  let color = 'w';
  panel.innerHTML = `
    <div class="desk-head"><h1>Choose your match.</h1><p>MottyBot plays fair at every level. The deeper levels simply search longer.</p></div>
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
  panel.className = 'matchdesk';
  panel.innerHTML = `
    <div class="desk-head">
      <div class="match-title"><h2>${escapeHTML(state.bot.name)}</h2><span class="difficulty-label">${escapeHTML(state.bot.label)} difficulty</span></div>
      <p>Move first. Then watch the board change.</p>
    </div>
    <div class="desk-body desk-body--moves"><div class="move-list" id="move-list"></div></div>
    <div class="desk-footer">
      <button class="btn btn--danger" id="resign-game">Resign</button>
      <button class="btn btn--quiet" id="game-rules">Rules</button>
    </div>`;
  $('resign-game').onclick = confirmResign;
  $('game-rules').onclick = showRules;
  renderMoveList();
}

function panelPostGame() {
  panel.className = 'matchdesk';
  panel.innerHTML = `
    <div class="desk-head">
      <div class="match-title"><h2>Final position</h2><span class="difficulty-label">${escapeHTML(state.bot.label)} difficulty</span></div>
      <p>The board and every teleport remain available for review.</p>
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
    if (entry.kind !== 'move') continue;
    const teleport = log[i + 1]?.kind === 'teleport' ? log[i + 1] : null;
    const number = Math.floor(entry.ply / 2) + 1;
    blocks.push(`
      <div class="turn-record">
        <div class="move-line"><span class="move-number">${number}${entry.color === 'w' ? '.' : '…'}</span><span class="move-san">${escapeHTML(entry.san)}</span><span class="move-side">${entry.color === state.myColor ? 'You' : 'MottyBot'}</span></div>
        ${teleport ? `<div class="teleport-line">${capitalize(PIECE_NAMES[teleport.piece.type])} ${teleport.from} → ${teleport.to}</div>` : ''}
      </div>`);
  }
  wrap.innerHTML = blocks.length ? blocks.join('') : '<div class="empty-log">Your moves and every teleport will appear here.</div>';
  const scroller = wrap.closest('.desk-body--moves');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

function capitalize(value) { return value.charAt(0).toUpperCase() + value.slice(1); }

/* Game setup and loop */
function configureBoardForMatch() {
  board.setOrientation(state.myColor);
  board.setPosition(positionMap());
  board.setLastMove(null);
  board.setTeleportMarks([]);
  updateCheckMark();
  $('top-name').textContent = state.bot.name;
  $('top-detail').textContent = `${state.bot.label} difficulty`;
  $('bottom-name').textContent = 'You';
  $('bottom-detail').textContent = state.myColor === 'w' ? 'White' : 'Black';
  renderCaptured();
}

function startBotGame(level, myColor, { seed = randomSeed() } = {}) {
  state.serial++;
  state.match = new ChaosMatch(seed);
  state.myColor = myColor;
  state.bot = BOTS[level] || BOTS.medium;
  state.over = false;
  state.animating = false;
  state.screen = 'playing';
  state.resultRecorded = false;
  state.result = null;
  state.replay = null;
  configureBoardForMatch();
  panelPlaying();
  setMagic({ title: "Make a move. Motty's powers move next.", copy: 'One non-king piece from the moving side will teleport afterward.' });
  sound.unlock();
  sound.start();
  persistGame();
  resetTaunts();
  clearTaunt();
  showTaunt(pickTaunt('greeting', { always: true }));
  botLoop(state.serial);
}

function resumeGame(data) {
  try {
    state.serial++;
    state.match = replayMatch(data.seed, data.ucis);
    state.match.startedAt = data.startedAt || Date.now();
    state.myColor = data.myColor;
    state.bot = BOTS[data.level] || BOTS.medium;
    state.over = false;
    state.animating = false;
    state.screen = 'playing';
    state.resultRecorded = false;
    state.result = null;
    configureBoardForMatch();
    panelPlaying();
    restoreLastMagicEvent();
    persistGame();
    resetTaunts();
    clearTaunt();
    showTaunt(pickTaunt('greeting', { always: true }));
    botLoop(state.serial);
  } catch {
    clearActive();
    showModal(`
      <div class="modal__head"><h2 id="modal-title">That game could not be restored.</h2><p>The saved position was invalid, so it has been cleared safely.</p></div>
      <div class="modal__body"><button class="btn btn--primary" id="restore-ok">Start a new game</button></div>`);
    $('restore-ok').onclick = () => { hideModal(); panelSetup(); };
  }
}

function restoreLastMagicEvent() {
  if (!state.match.magicState().active) { showMagicStopped(); return; }
  const event = [...state.match.log].reverse().find((entry) => entry.kind === 'teleport');
  if (!event) {
    setMagic({ title: "Make a move. Motty's powers move next.", copy: magicCountdown() || 'One non-king piece from the moving side will teleport afterward.' });
    return;
  }
  showSettledMagic(event);
}

async function playMoveAnimation(move, { instant = false } = {}) {
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
  board.setLastMove(move.from, move.to);
  state.animating = false;
  syncBoard();
  renderCaptured();
  renderMoveList();
  updateCheckMark();
}

async function playTeleport(events) {
  board.setInteractive(null);
  state.animating = true;
  setMagic({ phase: 'choosing', title: "Motty's powers are choosing", copy: 'One piece. One empty square. No one gets a vote.' });
  announce("Motty's magical powers are choosing a piece and destination.");
  if (!REDUCED_MOTION) await wait(230);

  if (!events?.length) {
    state.animating = false;
    const phase = state.match?.lastPhase;
    if (phase?.ended) {
      // the game just finished; the result modal speaks for itself
    } else if (phase?.stopped) {
      showMagicStopped();
    } else {
      setMagic({ title: "Motty's powers had no eligible piece", copy: 'Only the king remained, so the turn continues without a teleport.' });
    }
    persistGame();
    return;
  }

  const event = events[0];
  board.setTeleportMarks(events);
  sound.teleport();
  await board.animateTeleport(event);
  state.animating = false;
  syncBoard();
  renderMoveList();
  renderCaptured();
  updateCheckMark();
  showSettledMagic(event);
  persistGame();
  reactToTeleport(event);
}

// The rule is only fair if you can see it coming, so every message carries the
// piece count and how many captures are left before Magic goes quiet for good.
function magicCountdown() {
  const f = state.match?.magicState();
  if (!f) return '';
  if (!f.active) return `${f.onBoard} pieces left. Motty's powers have stopped for good.`;
  return f.untilStop === 1
    ? `${f.onBoard} pieces left. One more capture and Motty's powers stop for good.`
    : `${f.onBoard} pieces left. Motty's powers stop for good at ${f.stopsAt}.`;
}

function showMagicStopped() {
  setMagic({
    phase: 'stopped',
    title: "Motty's powers have left the board",
    copy: `Only ${state.match.magicState().onBoard} pieces remain, so nothing teleports for the rest of this game. Plain chess from here.`,
  });
  announce("Motty's magical powers have stopped for the rest of the game. Plain chess from here.");
}

function showSettledMagic(event) {
  const yours = event.piece.color === state.myColor;
  const owner = yours ? 'your' : "MottyBot's";
  const piece = PIECE_NAMES[event.piece.type];
  setMagic({
    phase: 'settled',
    title: `Motty's powers moved ${owner} ${piece}`,
    copy: magicCountdown(),
    route: `${event.from} → ${event.to}`,
  });
  announce(`Motty's magical powers moved ${owner} ${piece} from ${event.from} to ${event.to}.`);
}

async function botLoop(serial) {
  const match = state.match;
  while (!state.over && state.screen === 'playing' && state.match === match && state.serial === serial) {
    const owedTeleport = match.teleportIfDue();
    if (owedTeleport !== null) await playTeleport(owedTeleport);
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
      announce(status.check ? 'Your king is in check. Your move.' : 'Your move.');
      return;
    }

    setYourTurn(false);
    board.setInteractive(null);
    setThinking(true);
    setMagic({ phase: 'thinking', title: 'MottyBot is thinking', copy: "It is searching the position Motty's powers left behind." });
    const started = performance.now();
    let candidate;
    try {
      candidate = await requestBotMove(match.fen(), state.bot.level);
    } catch {
      const legal = match.legalMoves();
      candidate = legal.length ? { from: legal[0].from, to: legal[0].to, promotion: legal[0].promotion } : null;
    }
    const remaining = state.bot.minThink - (performance.now() - started);
    if (remaining > 0) await wait(remaining);
    setThinking(false);
    if (!candidate || state.over || state.screen !== 'playing' || state.match !== match || state.serial !== serial) return;
    const move = match.applyMove(candidate);
    persistGame();
    announce(`MottyBot played ${move.san.replace('#', ' checkmate')}.`);
    await playMoveAnimation(move);
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
  board.setInteractive(null);
  persistGame();
  await playMoveAnimation(move, { instant });
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
  const teleports = state.match.log.filter((entry) => entry.kind === 'teleport').length;
  const captures = state.match.log.filter((entry) => entry.kind === 'move' && entry.captured).length;
  const signOff = pickTaunt(
    outcome === 'draw' ? 'draw'
      : outcome === 'win' ? 'botLose'
        : status.reason === 'resignation' ? 'playerResign' : 'botWin',
    { always: true },
  );
  state.result = { status, outcome, moves, teleports, captures, signOff };
  sound.end(outcome === 'win');
  clearTaunt();
  panelPostGame();
  showResultModal();
}

function showResultModal() {
  const { status, outcome, moves, teleports, captures, signOff } = state.result;
  const title = outcome === 'draw' ? 'Draw.' : outcome === 'win' ? 'You won.' : 'MottyBot won.';
  const note = outcome === 'win'
    ? 'You read the chaos better. MottyBot is allowed to lose, and this time it did.'
    : outcome === 'loss'
      ? 'The board changed. MottyBot adapted. Try the same magic again or roll a new one.'
      : 'Nobody escaped the position with a win.';
  showModal(`
    <div class="modal__head">
      <div class="result-mark">${escapeHTML(reasonText(status, outcome))}</div>
      <h2 id="modal-title">${title}</h2>
      <p>${note}</p>
    </div>
    <div class="modal__body">
      ${signOff ? `<p class="bot-quote">${escapeHTML(signOff)}<span>MottyBot</span></p>` : ''}
      <div class="result-stats">
        <div><strong>${moves}</strong><span>Moves</span></div>
        <div><strong>${teleports}</strong><span>Teleports</span></div>
        <div><strong>${captures}</strong><span>Captures</span></div>
      </div>
      <div class="button-stack">
        <button class="btn btn--primary" id="result-new">New chaos</button>
        <button class="btn btn--secondary" id="result-same">Replay the same magic</button>
        <button class="btn btn--secondary" id="result-review">Review game</button>
        <button class="btn btn--quiet" id="result-share">Share this challenge</button>
      </div>
      <div class="copy-confirm" id="copy-confirm" aria-live="polite"></div>
    </div>`);
  $('result-new').onclick = () => { hideModal(); startBotGame(state.bot.level, state.myColor); };
  $('result-same').onclick = () => { const seed = state.match.seed; hideModal(); startBotGame(state.bot.level, state.myColor, { seed }); };
  $('result-review').onclick = () => { hideModal(); enterReplay(); };
  $('result-share').onclick = shareChallenge;
}

async function shareChallenge() {
  const url = challengeURL();
  const data = {
    title: "Chess (Motty's Version)",
    text: 'Play the same chaos seed against MottyBot.',
    url,
  };
  try {
    if (navigator.share) await navigator.share(data);
    else {
      await navigator.clipboard.writeText(url);
      const confirm = $('copy-confirm');
      if (confirm) confirm.textContent = 'Challenge link copied.';
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    const confirm = $('copy-confirm');
    if (confirm) confirm.textContent = 'Copy the address from your browser to share it.';
  }
}

function buildReplayFrames() {
  const frames = [{ fen: START_FEN, kind: 'start', label: 'Starting position', detail: 'Before move 1' }];
  for (const entry of state.match.log) {
    if (entry.kind === 'move') {
      const number = Math.floor(entry.ply / 2) + 1;
      frames.push({
        fen: entry.fenAfter,
        kind: 'move',
        label: `${number}${entry.color === 'w' ? '.' : '…'} ${entry.san}`,
        detail: entry.color === state.myColor ? 'Your move' : "MottyBot's move",
        from: entry.from,
        to: entry.to,
      });
    } else if (entry.kind === 'teleport') {
      frames.push({
        fen: entry.fenAfter,
        kind: 'teleport',
        label: `${capitalize(PIECE_NAMES[entry.piece.type])} ${entry.from} → ${entry.to}`,
        detail: "Motty's powers",
        from: entry.from,
        to: entry.to,
        piece: entry.piece,
      });
    }
  }
  return frames;
}

function enterReplay() {
  if (!state.match) return;
  clearTaunt();
  state.screen = 'replay';
  panel.className = 'matchdesk';
  state.replay = { frames: buildReplayFrames(), index: 0 };
  board.setInteractive(null);
  panel.innerHTML = `
    <div class="desk-head"><h2>Review the game.</h2><p>Step through each move and the teleport that followed it.</p></div>
    <div class="replay-readout"><strong id="replay-label"></strong><span id="replay-detail"></span></div>
    <div class="replay-controls" aria-label="Replay controls">
      <button id="replay-start" aria-label="First position">|‹</button>
      <button id="replay-prev" aria-label="Previous position">‹</button>
      <button id="replay-next" aria-label="Next position">›</button>
      <button id="replay-end" aria-label="Final position">›|</button>
    </div>
    <div class="desk-body"><p style="color:var(--muted);line-height:1.5;margin:0">Moves and magic events are separate frames so it is always clear what you chose and what the house rule changed.</p></div>
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
  board.setTeleportMarks(frame.kind === 'teleport' ? [{ from: frame.from, to: frame.to }] : []);
  updateCheckMark(frame.fen);
  $('replay-label').textContent = frame.label;
  $('replay-detail').textContent = `${frame.detail}. Frame ${state.replay.index + 1} of ${state.replay.frames.length}.`;
  $('replay-start').disabled = state.replay.index === 0;
  $('replay-prev').disabled = state.replay.index === 0;
  $('replay-next').disabled = state.replay.index === max;
  $('replay-end').disabled = state.replay.index === max;
  if (frame.kind === 'teleport') {
    const owner = frame.piece.color === state.myColor ? 'your' : "MottyBot's";
    setMagic({ title: `Motty's powers moved ${owner} ${PIECE_NAMES[frame.piece.type]}`, copy: 'Replay frame', route: `${frame.from} → ${frame.to}` });
  } else {
    setMagic({ title: frame.label, copy: frame.detail });
  }
}

function exitReplay() {
  state.screen = 'postgame';
  state.replay = null;
  board.setPosition(positionMap());
  board.setLastMove(null);
  board.setTeleportMarks([]);
  updateCheckMark();
  restoreLastMagicEvent();
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
    <div class="modal__head"><h2 id="modal-title">The one house rule.</h2><p>Ordinary chess, followed by one random relocation.</p></div>
    <div class="modal__body">
      <ol class="rule-list">
        <li><span class="rule-mark">1</span><span><b>Move normally.</b> Every move you choose must be legal chess.</span></li>
        <li><span class="rule-mark">2</span><span><b>Then one piece from that same side teleports.</b> Kings never teleport.</span></li>
        <li><span class="rule-mark">3</span><span><b>The piece and destination are random.</b> Every eligible non-king piece has the same chance. Then every eligible empty square for that piece has the same chance.</span></li>
        <li><span class="rule-mark">4</span><span><b>A teleport never captures.</b> The destination must be empty. It can be unsafe, and the teleported piece can give check.</span></li>
        <li><span class="rule-mark">5</span><span><b>Pawns stop short of the back rank.</b> They may teleport to the second or seventh rank, then promote with a normal move later.</span></li>
        <li><span class="rule-mark">6</span><span><b>Checkmate ends it immediately.</b> A finished game gets no teleport. Nothing relocates after checkmate, stalemate or a draw.</span></li>
        <li><span class="rule-mark">7</span><span><b>Motty's magical powers stop at ten pieces.</b> While more than ten pieces stand on the board, they act after every single move, always. The moment the board is down to ten or fewer, they stop for the rest of the game. They never come back, because pieces only ever leave the board. The endgame is plain chess.</span></li>
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
    state.match = null;
    panelSetup();
  };
}

/* Global controls and boot */
$('nav-new').onclick = requestNewGame;
$('nav-rules').onclick = showRules;
$('nav-sound').onclick = () => {
  const muted = sound.toggle();
  $('nav-sound').setAttribute('aria-pressed', String(!muted));
  $('nav-sound-label').textContent = muted ? 'Sound off' : 'Sound on';
};

function boot() {
  $('nav-sound').setAttribute('aria-pressed', String(!sound.muted));
  $('nav-sound-label').textContent = sound.muted ? 'Sound off' : 'Sound on';
  const lobby = new ChaosMatch('lobby-board');
  board.setPosition(parseFen(lobby.fen()).board);
  board.setInteractive(null);
  panelHome();
}

boot();
