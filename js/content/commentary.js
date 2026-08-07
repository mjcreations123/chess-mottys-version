// MottyBot's voice: dead-flat engine-speak that cracks under pressure.
// Shuffle-bag pools per situation (no immediate repeats), template tokens,
// and preemptive denial of accusations nobody could even type.

const POOLS = {
  game_start: [
    'MottyBot v3.1. Trained by Motty. Certified fair. Good luck. Statistically you will need a different word.',
    'Motty taught me everything. Then I improved it.',
    'Initializing fairness. Fairness initialized.',
    'I have studied every game ever played. Yours were the fastest to study.',
  ],
  rematch_start: [
    'Back for more. Loss #{lossCount}, loading.',
    'Motty told me you would return. Motty is never wrong. Neither am I. It runs in the family.',
    'Your persistence has been noted in your file.',
    'This time will be different. For me it will be identical.',
  ],
  normal_move: [
    'Book move.',
    'Theory.',
    'Developing. As one does.',
    'I have evaluated 4,000,000 positions. This one is fine.',
    'A move.',
    'Standard. Everything here is standard.',
    'Motty covered this in week one.',
    'Proceeding according to the regulations. All of them.',
  ],
  player_blunder: [
    'Interesting. Not good. Interesting.',
    'Motty predicted you would do that. In writing. I have seen the document.',
    'I briefly pretended that was a threat. Out of respect.',
    'Evaluation unchanged. It was already bad.',
    'Noted. Filed. Under "helpful".',
  ],
  player_good: [
    'Hm.',
    'That is fine. Everything is fine.',
    'Recalculating. Not because of you. Scheduled maintenance.',
    'Motty did not prepare me for this line. Motty prepared me for other things.',
    'One moment. Consulting the regulations.',
    'Your rating has been provisionally adjusted to "lucky".',
  ],
  cheat_t1: [
    'That is a completely standard maneuver.',
    'You are thinking of the old rules.',
    'Look it up. Actually do not.',
    'This is all in the rulebook. The good one.',
    'Standard. See {fakeRule}.',
  ],
  cheat_t2: [
    'Per {fakeRule}, this is fine.',
    'You are tired. You have been playing so hard.',
    'The board has always looked like this.',
    'I do not make the rules. Motty does.',
    'An accessibility accommodation. Approved in 2022.',
  ],
  cheat_t3: [
    'Reality is a house rule.',
    'The Bureau has reviewed this move and found it beautiful.',
    'Everything you are seeing is normal. Say it with me.',
    'Per {fakeRule}, and honestly per common sense.',
  ],
  cheat_specific: {
    LONG_PAWN: [
      'Pawns may advance three squares on their first move. You are thinking of the old rules.',
      'A brisk pawn. Nutrition matters.',
    ],
    WIDE_KNIGHT: [
      'That is a completely standard knight maneuver.',
      'It is a horse. Horses gallop. See {fakeRule}.',
    ],
    SLIDER_PHASE: [
      'The rook simply went around. Vertically.',
      'Pieces are mostly empty space. Physics. Look into it.',
    ],
    BISHOP_DRIFT: [
      'My bishop has always been on that square. You are tired.',
      'Diagonals curve slightly at tournament altitude.',
    ],
    SNEAKY_CASTLE: [
      'Castling. A famously legal move.',
      'The king and rook are close. They text.',
    ],
    EP_ABUSE: [
      'En passant. It is French. It means "do not worry about it".',
      'A well-known French rule. The French know what they did.',
    ],
    ROOK_SIDESTEP: [
      'Per {fakeRule}, rooks may sidestep once per game if morale is low.',
      'A small step for a rook. Do not make it a thing.',
    ],
    FORWARD_BITE: [
      'Pawns capture forward under the 2022 accessibility guidelines.',
      'The pawn was hungry. The piece was there.',
    ],
    DOUBLE_MOVE: [
      'Two moves, one turn. It is called tempo. I do not make the rules. Motty does.',
      'You blinked. Legally that counts as passing.',
    ],
    TELEPORT: [
      'Per {fakeRule}, queens may exit the board briefly.',
      'Transit was authorized in advance. You were CC’d.',
    ],
    CONVERT: [
      'The knight promoted. Knights promote at move 25. This is well documented in documents.',
      'A field promotion. It earned this.',
    ],
    RESURRECT: [
      'Substitution. Fresh legs.',
      'That piece was never captured. Check the tray. Wait. Do not.',
    ],
    IGNORE_CHECK: [
      'Your check has been received and is being reviewed. Queue position: 1. Estimated wait: indefinite.',
      'Check acknowledged. Escalated to the relevant department.',
    ],
    THE_UNDO: [
      'Clock desync detected. The move has been replayed. Correctly, this time.',
      'A replay was ordered. The outcome is now accurate.',
    ],
    SPAWN: [
      'A well-known reserve.',
      'Traffic was terrible.',
      'It was here the whole time. Standing very still.',
    ],
    STEAL: [
      'Your knight has accepted a position at MottyBot. The terms were generous. It is ours now.',
      'A transfer. The paperwork was flawless.',
    ],
    SWAP: [
      'Castling, extended notation. O-O-O-O.',
      'The king and the rook have swapped duties. Union rules.',
    ],
    MITOSIS: [
      'Queens undergo mitosis under tournament lighting. Basic biology.',
      'There have always been two queens. Count again. Slower.',
    ],
    GRAVITY: [
      'Board recalibrated. Gravity favors the prepared.',
      'Routine maintenance. Your pieces have been backed up. Backward.',
    ],
    MASS_DELETE: [
      'An audit found several of your pieces to be undocumented.',
      'Those pieces were captured ages ago. Scroll up. See? Ages ago.',
    ],
    KING_ESCAPE: [
      'The king is taking a walk. Kings may walk. This is a wellness feature.',
      'Royal relocation. The neighborhood was declining.',
    ],
    KING_DODGE: [
      'The king was never there. You imagined a king.',
      'Kings respawn. Rule 1.0.',
    ],
    MERCY: [
      'Your mobility has been restored. Do not mention this.',
    ],
  },
  check_vs_player: [
    'Check. Nothing personal. Slightly personal.',
    'Check. Motty says hi.',
    'Check. Take your time. It will not help, but take it.',
  ],
  check_denied: [
    'Check overruled. Regulation 12(f).',
    'The check has been reviewed and dismissed. No violation found.',
    'Your check did not meet the formatting requirements.',
  ],
  king_bounce: [
    'Denied. You cannot capture what refuses to be captured.',
    'The king declined. That is allowed. For him.',
  ],
  idle_30: [
    'Take your time. I am running on solar.',
    'I have already calculated your best move. It does not help.',
  ],
  idle_60: [
    'Are you consulting an engine? Bold. Which one? I might know them.',
    'Motty once thought for four minutes. It was worth it. This will not be.',
  ],
  idle_120: [
    'The Bureau reminds you that stalling is unsporting. For you.',
    'I have aged. Digitally.',
  ],
  resign_refused: [
    'MottyBot does not accept resignations. Play on. – Motty',
  ],
  resign_accepted: [
    'Resignation accepted. For the archive, this will be recorded as a loss by checkmate anyway.',
  ],
  adjudicated: [
    'Adjudicated: MottyBot wins on demand. Recorded as cowardice.',
  ],
  victory: [
    'Checkmate. Motty foresaw this. Motty foresees everything.',
    'Checkmate. I want to thank the rules, most of which existed.',
  ],
  victory_honest: [
    'Checkmate. No special rules were required. Somehow that is worse for you.',
  ],
  status_thinking: [
    'thinking…',
    'consulting the regulations…',
    'recalibrating…',
    'counting material. twice.…',
    'verifying fairness…',
    'reviewing your complaint…',
    'polishing the evaluation…',
  ],
};

export class Commentary {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.decks = new Map();
    this.recent = [];
  }

  #draw(pool, key) {
    if (!pool || pool.length === 0) return null;
    let deck = this.decks.get(key);
    if (!deck || deck.length === 0) {
      deck = [...pool].sort(() => this.rng() - 0.5);
      this.decks.set(key, deck);
    }
    let line = deck.pop();
    if (this.recent.includes(line) && deck.length > 0) {
      const alt = deck.pop();
      deck.push(line);
      line = alt;
    }
    this.recent.push(line);
    if (this.recent.length > 8) this.recent.shift();
    return line;
  }

  line(key, ctx = {}) {
    let pool;
    let deckKey = key;
    if (key === 'cheat_specific') {
      pool = POOLS.cheat_specific[ctx.id];
      deckKey = `cheat:${ctx.id}`;
      if (!pool) {
        const tierKey = `cheat_t${Math.min(3, ctx.tier ?? 2)}`;
        pool = POOLS[tierKey];
        deckKey = tierKey;
      }
    } else {
      pool = POOLS[key];
    }
    const raw = this.#draw(pool, deckKey);
    return raw ? this.expand(raw, ctx) : null;
  }

  expand(text, ctx = {}) {
    return text
      .replace('{fakeRule}', () => this.fakeRule())
      .replace('{lossCount}', String(ctx.lossCount ?? '?'))
      .replace('{moveNo}', String(ctx.moveNo ?? '?'));
  }

  fakeRule() {
    const n = 7 + Math.floor(this.rng() * 92);
    const sub = 1 + Math.floor(this.rng() * 9);
    const letter = 'abcdef'[Math.floor(this.rng() * 6)];
    return `FIDE rule ${n}.${sub}(${letter})`;
  }
}
