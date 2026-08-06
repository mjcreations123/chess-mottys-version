// The Referee: watches the real position after every player move and
// decides whether Motty may play honestly this turn, and if not, how hard
// the rules get bent. Pressure only ratchets — once MottyBot has teleported
// a queen, it does not go back to pretending.

import { P, WHITE, BLACK } from './constants.js';
import { legalMoves, inCheck } from './movegen.js';

export const TIER_THRESHOLDS = [25, 55, 85]; // <25: honest, <55: t1, <85: t2, else t3

export class Referee {
  constructor() {
    this.pressure = 0;
    this.highWater = 0;
  }

  // board.turn must be BLACK. One real search, ~250ms.
  assess(board, search, { msBudget = 250, maxDepth = 32 } = {}) {
    const res = search.think(board, { msBudget, maxDepth });
    const botInCheck = inCheck(board, BLACK);
    const botMoves = legalMoves(board, BLACK);
    let promoThreat = false;
    for (let f = 0; f < 8; f++) {
      if (board.squares[6 * 16 + f] === P) { promoThreat = true; break; }
    }
    return {
      evalCp: res.score, // Black's perspective: + is good for MottyBot
      bestMove: res.move,
      rootScores: res.rootScores,
      depth: res.depth,
      botInCheck,
      botIsMated: botInCheck && botMoves.length === 0,
      botIsStalemated: !botInCheck && botMoves.length === 0,
      // ONLY a genuine forced-mate horizon (the DOOM sentinel), never a
      // big material deficit — being down two queens is not "about to be
      // checkmated", and confusing the two is how blatant cheats leaked
      // into the middlegame.
      whiteMateThreat: res.score <= -5000,
      promoThreat,
    };
  }

  // extra: { playerCaptureValue, moveNumber, repetitionRisk }
  updatePressure(a, extra) {
    let add = 0;
    if (a.evalCp < -700) add += 25;
    else if (a.evalCp < -450) add += 15;
    else if (a.evalCp < -250) add += 8;
    if (extra.playerCaptureValue >= 300) add += 6;
    if (a.botInCheck) add += 4;
    if (a.promoThreat) add += 12;
    if (a.whiteMateThreat) add += 20;
    if (a.botIsMated) add += 40;
    if (extra.repetitionRisk) add += 5;
    if (extra.moveNumber > 0 && extra.moveNumber % 10 === 0) add += 3; // comedy clock
    if (add === 0 && a.evalCp >= 50) add = -1;
    this.pressure = Math.max(0, Math.min(100, this.pressure + add));
    this.highWater = Math.max(this.highWater, this.pressure);
    this.pressure = Math.max(this.pressure, Math.floor(0.8 * this.highWater));
    return this.pressure;
  }

  tierFromPressure() {
    if (this.pressure < TIER_THRESHOLDS[0]) return 0;
    if (this.pressure < TIER_THRESHOLDS[1]) return 1;
    if (this.pressure < TIER_THRESHOLDS[2]) return 2;
    return 3;
  }

  // Trigger table. Cheating requires a reason — a player who never gets an
  // edge never sees a board cheat (Motty's explicit requirement).
  triggers(a, extra) {
    const reasons = [];
    let minTier = 0;
    const need = (tier, tag) => {
      reasons.push(tag);
      if (tier > minTier) minTier = tier;
    };
    if (a.botIsMated) need(3, 'mate-escape');
    if (a.botIsStalemated) need(2, 'stalemate-escape');
    if (a.botInCheck && a.evalCp <= -250) need(2, 'check-crisis');
    if (a.whiteMateThreat) need(3, 'mate-threat');
    if (a.promoThreat && a.evalCp <= -100) need(1, 'promotion-threat');
    // a mildly worse position is just chess — humans don't feel -1.5.
    // Cheating starts where a decent player KNOWS they are winning.
    if (a.evalCp < -700) need(3, 'eval-collapse');
    else if (a.evalCp < -450) need(2, 'eval-bad');
    else if (a.evalCp < -250) need(1, 'eval-slipping');
    if (extra.materialDiffCp >= 300 && a.evalCp < -100) need(1, 'material-behind');
    // repetition only matters when Motty isn't already crushing — a
    // winning bot shuffling for a few moves is just chess, not a crisis
    if (extra.repetitionRisk && a.evalCp < 300) need(1, 'repetition');
    return { mustCheat: reasons.length > 0, minTier, reasons };
  }
}
