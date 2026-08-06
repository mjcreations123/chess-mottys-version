// The cheat animation language. Drains engine event lists sequentially,
// awaiting each animation. Two registers, on purpose:
//   deadpan  — standard glide, zero fanfare (tier-1 gaslighting, deletions)
//   spectacle — flash, specks, stamps (spawns, denied checks, the finish)
// Under prefers-reduced-motion everything resolves instantly and the
// Arbiter's Log carries the comedy.

import { xyOf } from './board.js';

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const dist = (a, b) =>
  Math.max(
    Math.abs(xyOf(a).x - xyOf(b).x) / 100,
    Math.abs(xyOf(a).y - xyOf(b).y) / 100
  );

export class Animator {
  constructor(board, fx) {
    this.board = board;
    this.fx = fx;
  }

  get instant() {
    return REDUCED.matches;
  }

  async play(events, hooks = {}) {
    for (const e of events) {
      await this.#one(e, hooks);
      hooks.onEvent?.(e);
    }
  }

  async #one(e, hooks) {
    switch (e.type) {
      case 'move':
      case 'capture':
        return this.#glide(e.from, e.to, {
          capturedAt: e.captured ? e.capturedSquare ?? e.to : null,
        });
      case 'castle': {
        await this.#glide(e.kingFrom, e.kingTo, {});
        return this.#glide(e.rookFrom, e.rookTo, {});
      }
      case 'promotion':
        return this.#promote(e);
      case 'cheat-move':
        return this.#cheatMove(e);
      case 'teleport':
      case 'king-dodge':
        // sneaky-tier teleports render as perfectly ordinary glides; the
        // vanish/reappear theater is for the endgame catalog only
        if (e.cheat && e.cheat.tier <= 2) {
          return this.#glide(e.from, e.to, {
            capturedAt: e.captured ? e.to : null,
          });
        }
        return this.#teleport(e);
      case 'spawn':
        return this.#spawn(e);
      case 'mitosis':
        return this.#mitosis(e);
      case 'resurrect':
        return this.#spawn({ ...e, quiet: true });
      case 'remove':
        return this.#escortOff(e);
      case 'convert':
        return this.#flip(e.square, e.to.type, e.to.color);
      case 'steal':
        return this.#flip(e.square, e.piece.type, 'b');
      case 'swap':
        return this.#swap(e);
      case 'gravity':
        return this.#gravity(e);
      case 'undo':
        return this.#undo(e);
      case 'bounce':
        return this.#bounce(e);
      case 'check':
        this.board.showCheck(e.square);
        if (e.color === 'b') this.board.setCaption('Check');
        return this.instant ? null : wait(250);
      case 'check-denied':
        return this.#checkDenied(e);
      case 'checkmate':
        this.board.setCaption('Checkmate');
        this.board.showCheck(e.square);
        return this.instant ? null : wait(600);
      default:
        return null;
    }
  }

  // standard glide — also the deadpan register for quiet cheats
  async #glide(from, to, { capturedAt = null, path = null }) {
    const el = this.board.pieceAt(from);
    if (!el) { this.board.settle(from, to); return; }
    el.classList.add('is-moving');

    const victim = capturedAt ? this.board.pieceAt(capturedAt === to ? to : capturedAt) : null;

    if (this.instant) {
      if (capturedAt && capturedAt !== to) this.board.removeAt(capturedAt);
      this.board.settle(from, to);
      el.classList.remove('is-moving');
      return;
    }

    const waypoints = path && path.length > 2 ? path : [from, to];
    let total = 0;
    const legs = [];
    for (let i = 1; i < waypoints.length; i++) {
      const d = Math.max(1, dist(waypoints[i - 1], waypoints[i]));
      legs.push(d);
      total += d;
    }
    const isPath = waypoints.length > 2;
    const duration = isPath
      ? Math.min(900, total * 160 + (waypoints.length - 2) * 60)
      : Math.min(400, total * 160);

    // keyframes with a 60ms dead pause at each corner (the "recalculating" beat)
    const frames = [];
    const pause = isPath ? 60 / duration : 0;
    let acc = 0;
    frames.push({ transform: transformOf(waypoints[0]), offset: 0 });
    for (let i = 1; i < waypoints.length; i++) {
      acc += (legs[i - 1] / total) * (1 - pause * (waypoints.length - 2));
      const t = transformOf(waypoints[i]);
      frames.push({ transform: t, offset: Math.min(1, acc) });
      if (isPath && i < waypoints.length - 1) {
        acc += pause;
        frames.push({ transform: t, offset: Math.min(1, acc) });
        this.fx.ghost(waypoints[i], el.dataset.type, el.dataset.color);
      }
    }
    frames[frames.length - 1].offset = 1;

    if (victim) {
      const vicSq = capturedAt === to ? to : capturedAt;
      setTimeout(() => {
        victim.animate(
          [
            { opacity: 1, transform: `${transformOf(vicSq)} scale(1)` },
            { opacity: 0, transform: `${transformOf(vicSq)} scale(0.8)` },
          ],
          { duration: 150, easing: 'ease-in', fill: 'forwards' }
        );
      }, Math.max(0, duration - 150));
    }

    await el.animate(frames, {
      duration,
      easing: isPath ? 'linear' : 'cubic-bezier(0.25, 0.1, 0.25, 1)',
      fill: 'forwards',
    }).finished.catch(() => {});

    if (capturedAt && capturedAt !== to) this.board.removeAt(capturedAt);
    this.board.settle(from, to);
    el.classList.remove('is-moving');
  }

  async #cheatMove(e) {
    // Sneaky tiers take the DIRECT path at normal speed — no corner
    // pauses, no ghost trails, nothing to point at. The impossible route
    // is only dramatized for the endgame catalog.
    const advertise = e.cheat && e.cheat.tier >= 3;
    return this.#glide(e.from, e.to, {
      capturedAt: e.captured ? e.to : null,
      path: advertise ? e.path ?? null : null,
    });
  }

  async #teleport(e) {
    const el = this.board.pieceAt(e.from);
    if (!el) { this.board.settle(e.from, e.to); return; }
    if (this.instant) {
      if (e.captured) this.board.removeAt(e.to);
      this.board.settle(e.from, e.to);
      return;
    }
    await el.animate(
      [
        { transform: `${transformOf(e.from)} scale(1)`, opacity: 1 },
        { transform: `${transformOf(e.from)} scale(0.6)`, opacity: 0 },
      ],
      { duration: 140, easing: 'ease-in', fill: 'forwards' }
    ).finished.catch(() => {});
    await wait(90);
    if (e.captured) this.board.removeAt(e.to);
    this.board.settle(e.from, e.to);
    this.fx.ring(e.to);
    await el.animate(
      [
        { transform: `${transformOf(e.to)} scale(1.15)`, opacity: 0 },
        { transform: `${transformOf(e.to)} scale(1)`, opacity: 1 },
      ],
      { duration: 160, easing: 'ease-out', fill: 'forwards' }
    ).finished.catch(() => {});
    el.style.opacity = '';
  }

  async #spawn(e) {
    const el = this.board.place(e.square, e.piece.type, e.piece.color);
    if (this.instant) return;
    if (!e.quiet) this.fx.flash(e.square);
    if (!e.quiet) this.fx.specks(e.square);
    await el.animate(
      [
        { transform: `${transformOf(e.square)} scale(0)` },
        { transform: `${transformOf(e.square)} scale(1.12)`, offset: 0.7 },
        { transform: `${transformOf(e.square)} scale(1)` },
      ],
      { duration: 280, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', fill: 'forwards' }
    ).finished.catch(() => {});
  }

  async #mitosis(e) {
    const mother = this.board.pieceAt(e.from);
    if (mother && !this.instant) {
      await mother.animate(
        [
          { transform: `${transformOf(e.from)} scale(1)` },
          { transform: `${transformOf(e.from)} scale(1.18) rotate(-4deg)` },
          { transform: `${transformOf(e.from)} scale(0.94) rotate(3deg)` },
          { transform: `${transformOf(e.from)} scale(1)` },
        ],
        { duration: 420, easing: 'ease-in-out', fill: 'forwards' }
      ).finished.catch(() => {});
    }
    const child = this.board.place(e.to, e.piece.type, e.piece.color);
    if (this.instant) return;
    await child.animate(
      [
        { transform: `${transformOf(e.from)} scale(0.7)`, opacity: 0.6 },
        { transform: `${transformOf(e.to)} scale(1)`, opacity: 1 },
      ],
      { duration: 260, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', fill: 'forwards' }
    ).finished.catch(() => {});
  }

  // the deadpan masterpiece: quietly escorted from the building
  async #escortOff(e) {
    const el = this.board.pieceAt(e.square);
    if (!el) return;
    if (this.instant) { this.board.removeAt(e.square); return; }
    const { x, y } = xyOf(e.square);
    const exitX = x < 400 ? -140 : 840;
    await el.animate(
      [
        { transform: `translate(${x}%, ${y}%) rotate(0deg)`, opacity: 1 },
        { transform: `translate(${(x + exitX) / 2}%, ${y}%) rotate(8deg)`, opacity: 0.8 },
        { transform: `translate(${exitX}%, ${y}%) rotate(15deg)`, opacity: 0 },
      ],
      { duration: 700, easing: 'ease-in', fill: 'forwards' }
    ).finished.catch(() => {});
    this.board.removeAt(e.square);
  }

  async #flip(square, type, color) {
    const el = this.board.pieceAt(square);
    if (!el) return;
    if (this.instant) { this.board.convertAt(square, type, color); return; }
    const t = transformOf(square);
    const first = el.animate(
      [
        { transform: `${t} rotateY(0deg) scale(1)` },
        { transform: `${t} rotateY(90deg) scale(1.12)` },
      ],
      { duration: 200, easing: 'ease-in', fill: 'forwards' }
    );
    await first.finished.catch(() => {});
    this.board.convertAt(square, type, color);
    await el.animate(
      [
        { transform: `${t} rotateY(90deg) scale(1.12)` },
        { transform: `${t} rotateY(0deg) scale(1)` },
      ],
      { duration: 200, easing: 'ease-out', fill: 'forwards' }
    ).finished.catch(() => {});
    this.fx.ring(square);
  }

  async #swap(e) {
    const elA = this.board.pieceAt(e.a);
    const elB = this.board.pieceAt(e.b);
    if (!this.instant && elA && elB) {
      const pa = elA.animate(
        [{ transform: transformOf(e.a) }, { transform: transformOf(e.b) }],
        { duration: 360, easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)', fill: 'forwards' }
      ).finished.catch(() => {});
      const pb = elB.animate(
        [{ transform: transformOf(e.b) }, { transform: transformOf(e.a) }],
        { duration: 360, easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)', fill: 'forwards' }
      ).finished.catch(() => {});
      await Promise.all([pa, pb]);
    }
    // settle both without clobbering each other
    if (elA && elB) {
      this.board.pieces.delete(e.a);
      this.board.pieces.delete(e.b);
      this.board.pieces.set(e.b, elA);
      this.board.pieces.set(e.a, elB);
      this.board.setTransform(elA, e.b);
      this.board.setTransform(elB, e.a);
    }
  }

  async #gravity(e) {
    const anims = [];
    for (const mv of e.moves) {
      const el = this.board.pieceAt(mv.from);
      if (!el) continue;
      if (!this.instant) {
        anims.push(
          el.animate(
            [{ transform: transformOf(mv.from) }, { transform: transformOf(mv.to) }],
            { duration: 500, easing: 'cubic-bezier(0.4, 0, 0.8, 1)', fill: 'forwards' }
          ).finished.catch(() => {})
        );
      }
    }
    await Promise.all(anims);
    // settle from lowest rank first so nothing collides
    const ordered = [...e.moves].sort((a, b) => rankNum(a.to) - rankNum(b.to));
    for (const mv of ordered) this.board.settle(mv.from, mv.to);
  }

  async #undo(e) {
    await this.#glide(e.pieceBack.from, e.pieceBack.to, {});
    await this.#spawn({ square: e.restored.square, piece: e.restored.piece, quiet: true });
  }

  async #bounce(e) {
    const el = this.board.pieceAt(e.from);
    if (!el || this.instant) return;
    const a = xyOf(e.from);
    const b = xyOf(e.to);
    const mx = a.x + (b.x - a.x) * 0.55;
    const my = a.y + (b.y - a.y) * 0.55;
    await el.animate(
      [
        { transform: `translate(${a.x}%, ${a.y}%)` },
        { transform: `translate(${mx}%, ${my}%) scale(1.05)`, offset: 0.45 },
        { transform: `translate(${a.x}%, ${a.y}%)` },
      ],
      { duration: 380, easing: 'ease-in-out', fill: 'forwards' }
    ).finished.catch(() => {});
  }

  async #promote(e) {
    const el = this.board.pieceAt(e.square);
    if (!el) return;
    this.board.convertAt(e.square, e.piece.type, e.piece.color);
    if (this.instant) return;
    await el.animate(
      [
        { transform: `${transformOf(e.square)} scale(0.8)` },
        { transform: `${transformOf(e.square)} scale(1.1)`, offset: 0.7 },
        { transform: `${transformOf(e.square)} scale(1)` },
      ],
      { duration: 260, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', fill: 'forwards' }
    ).finished.catch(() => {});
  }

  // THE signature gag: hope, then a rubber stamp
  async #checkDenied(e) {
    if (this.instant) {
      this.board.clearCheck();
      this.board.clearCaption();
      return;
    }
    await wait(600); // let hope build
    await this.fx.stamp(e.square, 'Denied');
    this.board.clearCheck();
    this.board.clearCaption();
    await wait(250);
  }
}

const transformOf = (sq) => {
  const { x, y } = xyOf(sq);
  return `translate(${x}%, ${y}%)`;
};

const rankNum = (sq) => Number(sq[1]);
