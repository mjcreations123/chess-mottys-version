// Controller: panel states, the game loop (shuffle -> status -> move), and
// the bot worker. Bot-only build; the only opponent is MottyBot.

import { ChaosMatch } from './core/chaos.js';
import { parseFen } from './core/fen.js';
import { randomSeed } from './core/rng.js';
import { pieceSpriteSVG, pieceUse } from './ui/pieces.js';
import { BoardView } from './ui/board.js';
import { sound } from './ui/sound.js';

document.body.insertAdjacentHTML('afterbegin', pieceSpriteSVG());

const $ = (id) => document.getElementById(id);
const panel = $('panel');
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const BOTS = {
  easy: { name: 'MottyBot Jr.', rating: 800, level: 'easy', blurb: 'Learning the moves. Occasionally forgets them.' },
  medium: { name: 'MottyBot', rating: 1500, level: 'medium', blurb: 'Plays honest chess. Complains about the dice.' },
  hard: { name: 'GM MottyBot', rating: 2200, level: 'hard', blurb: 'Thinks properly. Will punish you. Cannot control the universe.' },
};

// The bot always appears to deliberate, even when the search finishes early.
const MIN_THINK_MS = 900;

const state = {
  match: null,
  myColor: 'w',
  bot: BOTS.medium,
  over: false,
  animating: false,
};

const board = new BoardView($('board'), { onUserMove: handleUserMove });

/* ================= worker ================= */
let worker = null;
let workerSeq = 0;
function botMove(fen, level) {
  if (!worker) worker = new Worker('/js/ai.worker.js', { type: 'module' });
  return new Promise((resolve, reject) => {
    const id = ++workerSeq;
    const onMsg = (e) => {
      if (e.data.id !== id) return;
      worker.removeEventListener('message', onMsg);
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.move);
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({ id, fen, level, seed: `${state.match?.seed}-${state.match?.ply}` });
  });
}

/* ================= helpers ================= */
function positionMap() { return parseFen(state.match.fen()).board; }

function kingSquare(color) {
  for (const [sq, p] of positionMap()) if (p.type === 'k' && p.color === color) return sq;
  return null;
}

function syncBoard() { board.verify(positionMap()); }

function updateCheckMark() {
  const st = state.match.status();
  board.setCheck(!st.over && st.check ? kingSquare(state.match.turn()) : null);
}

function renderCaptured() {
  const { byWhite, byBlack } = state.match.captured();
  const diff = byWhite.reduce((s, t) => s + VAL[t], 0) - byBlack.reduce((s, t) => s + VAL[t], 0);
  const mine = state.myColor === 'w' ? byWhite : byBlack;   // pieces I captured (enemy color)
  const theirs = state.myColor === 'w' ? byBlack : byWhite;
  const enemyColor = state.myColor === 'w' ? 'b' : 'w';
  const myDiff = state.myColor === 'w' ? diff : -diff;
  $('bottom-captured').innerHTML =
    mine.map((t) => pieceUse(enemyColor, t)).join('') +
    (myDiff > 0 ? `<span class="cap-score">+${myDiff}</span>` : '');
  $('top-captured').innerHTML =
    theirs.map((t) => pieceUse(state.myColor, t)).join('') +
    (myDiff < 0 ? `<span class="cap-score">+${-myDiff}</span>` : '');
}

function chip(text, ms = 1500) {
  const c = $('tele-chip');
  c.textContent = text;
  c.hidden = false;
  clearTimeout(chip._t);
  chip._t = setTimeout(() => { c.hidden = true; }, ms);
}

function setThinking(on) { $('top-thinking').hidden = !on; }
function setYourTurn(on) { $('turn-tag').hidden = !on; }

/* ================= move list panel ================= */
const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

function renderMoveList() {
  const wrap = $('movelist');
  if (!wrap) return;
  let html = '';
  let pairOpen = false;
  const entries = state.match.log;
  const lastIdx = lastMoveIndex(entries);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind === 'teleport') {
      if (pairOpen) { html += '</div>'; pairOpen = false; }
      html += `<div class="trow">⚡ ${e.piece.color === 'w' ? 'White' : 'Black'} ${PIECE_NAMES[e.piece.type]} ${e.from} <span class="t-arrow">→</span> ${e.to}</div>`;
      continue;
    }
    const isLast = i === lastIdx;
    if (e.color === 'w') {
      if (pairOpen) html += '</div>';
      html += `<div class="mrow"><span class="mrow__num">${Math.floor(e.ply / 2) + 1}.</span><span class="mrow__san${isLast ? ' mrow__san--active' : ''}">${e.san}</span>`;
      pairOpen = true;
    } else {
      if (!pairOpen) { html += `<div class="mrow"><span class="mrow__num">${Math.floor(e.ply / 2) + 1}.</span><span class="mrow__san">…</span>`; }
      html += `<span class="mrow__san${isLast ? ' mrow__san--active' : ''}">${e.san}</span></div>`;
      pairOpen = false;
    }
  }
  if (pairOpen) html += '</div>';
  wrap.innerHTML = html;
  wrap.scrollTop = wrap.scrollHeight;
}
function lastMoveIndex(entries) {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].kind === 'move') return i;
  return -1;
}

/* ================= panels ================= */
function panelHome() {
  state.over = true;
  panel.innerHTML = `
    <div class="panel__head">
      <div class="panel__title">Play Chess</div>
      <div class="panel__sub">Motty's Version. You will see.</div>
    </div>
    <div class="panel__body">
      <div class="rules-blurb">
        Real chess, fair engine, standard rules. Except one:
        <b>right after you move, one of your own pieces teleports to a random
        empty square.</b> Same for your opponent, after theirs. Kings stay put.
        Nobody chooses which piece. Nobody chooses where.
      </div>
      <button class="btn btn--green" id="go-bot">
        <svg viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="12" rx="3" fill="currentColor"/><circle cx="9.5" cy="12.5" r="1.8" fill="#81B64C"/><circle cx="14.5" cy="12.5" r="1.8" fill="#81B64C"/><rect x="11" y="3" width="2" height="4" fill="currentColor"/></svg>
        Play vs Computer
      </button>
      <button class="btn btn--ghost" id="go-rules">How do the teleports work?</button>
    </div>`;
  $('go-bot').onclick = () => panelBotSetup();
  $('go-rules').onclick = () => showRules();
}

function panelBotSetup() {
  panel.innerHTML = `
    <div class="panel__head">
      <div class="panel__title">Play vs Computer</div>
      <div class="panel__sub">Pick your poison</div>
    </div>
    <div class="panel__body">
      <div class="choice-row" id="lvl-row">
        <button class="choice" data-lvl="easy">MottyBot Jr.<small>600</small></button>
        <button class="choice choice--on" data-lvl="medium">MottyBot<small>1200</small></button>
        <button class="choice" data-lvl="hard">GM MottyBot<small>2000</small></button>
      </div>
      <div class="choice-row" id="col-row">
        <button class="choice choice--on" data-col="w"><svg class="mini-piece" viewBox="0 0 100 100"><use href="#pc-wk"/></svg><br>White</button>
        <button class="choice" data-col="random"><svg class="mini-piece" viewBox="0 0 100 100"><use href="#pc-wp"/></svg><br>Random</button>
        <button class="choice" data-col="b"><svg class="mini-piece" viewBox="0 0 100 100"><use href="#pc-bk"/></svg><br>Black</button>
      </div>
      <button class="btn btn--green" id="start-bot">Play</button>
      <button class="btn btn--ghost" id="back-home">Back</button>
    </div>`;
  const pick = (rowId) => {
    const row = $(rowId);
    row.addEventListener('click', (e) => {
      const b = e.target.closest('.choice');
      if (!b) return;
      row.querySelectorAll('.choice').forEach((x) => x.classList.remove('choice--on'));
      b.classList.add('choice--on');
    });
  };
  pick('lvl-row');
  pick('col-row');
  $('back-home').onclick = () => panelHome();
  $('start-bot').onclick = () => {
    const lvl = panel.querySelector('#lvl-row .choice--on').dataset.lvl;
    let col = panel.querySelector('#col-row .choice--on').dataset.col;
    if (col === 'random') col = Math.random() < .5 ? 'w' : 'b';
    startBotGame(lvl, col);
  };
}

function panelPlaying(subtitle) {
  panel.innerHTML = `
    <div class="panel__head">
      <div class="panel__title">${state.bot.name}</div>
      <div class="panel__sub">${subtitle || ''}</div>
    </div>
    <div class="movelist" id="movelist"></div>
    <div class="panel__actions">
      <button class="btn btn--danger-ghost" id="act-resign">Resign</button>
      <button class="btn btn--gray btn--sm" id="act-new">New Game</button>
    </div>`;
  $('act-resign').onclick = () => {
    if (state.over || !state.match) return;
    state.match.resign(state.myColor);
    endGame();
  };
  $('act-new').onclick = () => panelHome();
  renderMoveList();
}

/* ================= game flow ================= */
function freshMatch(seed, myColor) {
  state.match = new ChaosMatch(seed);
  state.myColor = myColor;
  state.over = false;
  board.setOrientation(myColor);
  board.setPosition(positionMap());
  board.setLastMove(null);
  board.setCheck(null);
  renderCaptured();
  sound.unlock();
  sound.start();
}

async function playTeleports(events) {
  if (!events || !events.length) return;
  board.setInteractive(null);
  state.animating = true;
  board.setTeleportMarks(events);
  const who = events[0].piece.color === state.myColor ? 'your' : 'their';
  chip(`⚡ ${who} ${PIECE_NAMES[events[0].piece.type]} teleported`);
  for (const ev of events) {
    sound.teleport();
    await board.animateTeleport(ev);
  }
  state.animating = false;
  syncBoard();
  renderMoveList();
  updateCheckMark();
}

async function playMoveAnim(move, { instant = false } = {}) {
  state.animating = true;
  const rookHop = move.flags.includes('k') ? { rookFrom: move.color === 'w' ? 'h1' : 'h8', rookTo: move.color === 'w' ? 'f1' : 'f8' }
    : move.flags.includes('q') ? { rookFrom: move.color === 'w' ? 'a1' : 'a8', rookTo: move.color === 'w' ? 'd1' : 'd8' }
      : {};
  const epSquare = move.flags.includes('e') ? move.to[0] + (move.color === 'w' ? '5' : '4') : null;
  if (move.captured) sound.capture(); else sound.move();
  if (instant) {
    // piece already sits on target (drag drop); still handle rook/ep/promo
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

function endGame() {
  const st = state.match.status();
  state.over = true;
  board.setInteractive(null);
  setThinking(false);
  setYourTurn(false);
  const iWon = st.winner === state.myColor;
  const draw = !st.winner;
  sound.end(iWon);
  const title = draw ? 'Draw' : iWon ? 'You Won!' : `${state.bot.name} Wins`;
  const why = {
    checkmate: 'by checkmate',
    stalemate: 'by stalemate',
    'insufficient material': 'nobody can mate anybody',
    'fifty-move rule': 'fifty moves, zero progress',
    resignation: iWon ? 'by resignation' : 'you resigned',
  }[st.reason] || st.reason;
  showModal(`
    <div class="modal__banner ${draw ? '' : iWon ? 'modal__banner--win' : 'modal__banner--loss'}">
      <div class="modal__title">${title}</div>
      <div class="modal__sub">${why}</div>
    </div>
    <div class="modal__body">
      ${st.reason === 'checkmate' ? '<p>The teleporter had every chance to save this and chose not to. Nothing personal.</p>' : ''}
      <button class="btn btn--green" id="m-rematch">Rematch</button>
      <button class="btn btn--gray btn--sm" id="m-home">Back to Menu</button>
    </div>`);
  $('m-rematch').onclick = () => { hideModal(); startBotGame(state.bot.level, state.myColor); };
  $('m-home').onclick = () => { hideModal(); panelHome(); };
}

/* ================= bot mode ================= */
function startBotGame(lvl, myColor) {
  state.bot = BOTS[lvl];
  freshMatch(randomSeed(), myColor);
  $('top-name').textContent = state.bot.name;
  $('top-rating').textContent = `(${state.bot.rating})`;
  $('top-avatar').className = 'avatar avatar--bot';
  $('bottom-name').textContent = 'You';
  $('bottom-rating').textContent = '';
  panelPlaying(state.bot.blurb);
  botLoop();
}

async function botLoop() {
  const m = state.match;
  while (!state.over && state.match === m) {
    // 1. settle the teleport owed by the move that just happened
    await playTeleports(m.teleportIfDue());
    if (state.over || state.match !== m) return;

    // 2. is it actually over, now that the dice have landed?
    const st = m.status();
    if (st.over) { endGame(); return; }
    if (st.check && m.turn() === state.myColor) sound.check();

    // 3. your turn: hand control back and wait for handleUserMove
    if (m.turn() === state.myColor) {
      setYourTurn(true);
      setThinking(false);
      board.setInteractive(state.myColor, (sq) => m.legalMoves(sq));
      return;
    }

    // 4. bot's turn
    setYourTurn(false);
    board.setInteractive(null);
    setThinking(true);
    const t0 = Date.now();
    let mv;
    try {
      mv = await botMove(m.fen(), state.bot.level);
    } catch {
      const legal = m.legalMoves();
      mv = legal.length ? { from: legal[0].from, to: legal[0].to, promotion: legal[0].promotion } : null;
    }
    // never snap: a move that lands instantly still reads as deliberation
    const elapsed = Date.now() - t0;
    if (elapsed < MIN_THINK_MS) await wait(MIN_THINK_MS - elapsed);
    setThinking(false);
    if (!mv || state.over || state.match !== m) return;
    const move = m.applyMove(mv);
    await playMoveAnim(move);
  }
}

async function handleUserMove({ from, to, promotion, instant }) {
  const m = state.match;
  if (!m || state.over || state.animating) return;
  if (m.turn() !== state.myColor) return;
  let move;
  try {
    move = m.applyMove({ from, to, promotion });
  } catch {
    sound.illegal();
    syncBoard();
    return;
  }
  setYourTurn(false);
  board.setInteractive(null);
  await playMoveAnim(move, { instant });
  botLoop();
}

/* ================= modals ================= */
function showModal(html) {
  $('modal').innerHTML = html;
  $('modal-scrim').hidden = false;
}
function hideModal() { $('modal-scrim').hidden = true; }
$('modal-scrim').addEventListener('click', (e) => {
  if (e.target === $('modal-scrim')) hideModal();
});
function showRules() {
  showModal(`
    <div class="modal__banner"><div class="modal__title">Motty's Rules</div>
      <div class="modal__sub">Chess, technically</div></div>
    <div class="modal__body">
      <p class="modal__rule-title">The one rule</p>
      <p>You move first. Then <b>one of your own pieces teleports</b> to a random empty square. Your opponent moves, then one of theirs does the same. Totally random. Nobody chooses which piece. Nobody chooses where.</p>
      <p class="modal__rule-title">The small print</p>
      <p><b>Kings never teleport.</b> Kings do not do that sort of thing.</p>
      <p>Teleports never capture and never create a check. Fate is chaotic, not cruel.</p>
      <p>A pawn cannot teleport onto the last rank. It can land one square short and make you sweat.</p>
      <p>Checkmate only counts once your own teleport is done. Deliver mate, then watch the universe fling your mating piece into a corner. It happens.</p>
      <p>Everything else is completely standard chess, played fairly by a bot that is genuinely trying to beat you. Good luck with your opening prep.</p>
      <button class="btn btn--green" id="m-ok">Understood. Probably.</button>
    </div>`);
  $('m-ok').onclick = hideModal;
}

/* ================= rail buttons ================= */
$('nav-new').onclick = () => panelHome();
$('nav-rules').onclick = () => showRules();
$('nav-sound').onclick = () => {
  const muted = sound.toggle();
  $('nav-sound').setAttribute('aria-pressed', String(!muted));
  $('nav-sound-label').textContent = muted ? 'Sound Off' : 'Sound On';
};
$('nav-sound').setAttribute('aria-pressed', String(!sound.muted));
$('nav-sound-label').textContent = sound.muted ? 'Sound Off' : 'Sound On';

/* ================= boot ================= */
function boot() {
  // static start position on the board behind the menu
  state.match = new ChaosMatch('lobby');
  state.over = true;
  board.setPosition(positionMap());
  panelHome();
  if (!localStorage.getItem('mv-rules-seen')) {
    localStorage.setItem('mv-rules-seen', '1');
    showRules();
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
boot();
