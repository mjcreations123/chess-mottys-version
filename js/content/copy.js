// Structured copy: arbiter rejections, cheat display names, resign labels,
// victory stats, share text. The Arbiter enforces chess law — downward only.

export const REJECTION_LINES = {
  'illegal-target': [
    'Illegal. The rules apply to you.',
    'Denied. Article 4.2: pieces move the way pieces move.',
    'No. And I saw you try it, so we both have to live with that.',
    'That move is not available at your rating.',
    'Nice try. Genuinely. It is exactly the kind of thing I would do.',
    'This attempt has been logged and forwarded to Motty.',
  ],
  'leaves-king-in-check': [
    'Denied. Your king would be in check. Yours matters.',
    'Illegal. Article 3.9: you may not leave your king in check. I may. You may not.',
    'Your king objects. Overruled? No. Sustained.',
  ],
  'illegal-repeat': [
    'Still illegal. It did not become legal while you thought about it.',
    'Again? The answer has not changed. It is still no.',
  ],
  'not-your-piece': [
    'That piece is not yours. Few things here are.',
    'Denied. Touching my pieces requires a permit.',
  ],
  'no-piece': [
    'There is no piece there. There may never have been.',
  ],
  'not-your-turn': [
    'It is not your turn. Wait your turn. I never have to.',
  ],
  'needs-promo-choice': [
    'Select a commission. Form 9 is mandatory.',
  ],
  'phantom-pin': [
    'Denied. That piece is pinned to your king. Look closer. Keep looking.',
    'Illegal. Capturing it would expose your king. The Bureau has run the numbers.',
    'Denied. There is a pin. It is subtle. Like all the best rules.',
  ],
  'phantom-pin-repeat': [
    'Still pinned. Pins do not expire because you are impatient.',
    'The pin remains in effect. This is basic chess. Allegedly.',
    'Denied again. Write it down this time.',
  ],
  'king-grab': [
    'Denied. You cannot simply grab the king. This is chess, not tag.',
    'Illegal. The king is a protected official.',
    'That was an assault attempt on a head of state. Logged.',
    'Your piece does not even move that way. The king noticed. He is laughing.',
  ],
};

export const CHEAT_NAMES = {
  PHANTOM_PIN: 'The Phantom Pin',
  LONG_PAWN: 'The Long Pawn',
  WIDE_KNIGHT: 'The Regulation L',
  SLIDER_PHASE: 'Phase Clearance',
  BISHOP_DRIFT: 'Bishop Drift',
  SNEAKY_CASTLE: 'Administrative Castling',
  EP_ABUSE: 'Le Passant',
  ROOK_SIDESTEP: 'The Sidestep',
  FORWARD_BITE: 'Forward Bite',
  DOUBLE_MOVE: 'Double Move Tuesday',
  TELEPORT: "Queen's Sabbatical",
  CONVERT: 'Field Promotion',
  RESURRECT: 'The Substitution Bench',
  DELETE: 'Retroactive Capture',
  IGNORE_CHECK: 'Check Received',
  THE_UNDO: 'Clock Desync',
  SPAWN: 'The Late Arrival',
  STEAL: 'The Defection',
  SWAP: 'Extended Castling',
  MITOSIS: 'Queen Mitosis',
  GRAVITY: 'Gravity Recalibration',
  MASS_DELETE: 'The Audit',
  KING_ESCAPE: 'Royal Relocation',
  KING_DODGE: 'The King Was Never There',
  MERCY: 'Mobility Assistance',
};

export const TOTAL_NAMED_CHEATS = Object.keys(CHEAT_NAMES).length;

export const RESIGN_LABELS = ['Resign', 'Resign', 'Concede gracefully', 'Accept the inevitable'];

export const RESIGN_REFUSAL = {
  head: 'Resignation Request',
  body: 'MottyBot does not accept resignations. Play on.\n— Motty',
  second: 'You insist. Very well. Form R-9 (Voluntary Defeat) has been filed on your behalf.',
};

// Rows of {label, value, note}: values are SHORT monospace facts, the
// jokes live in clean italic footnotes — no wrapping mono rubble.
export function buildVictoryStats({ moveNumber, cheatsFired, record }) {
  const honest = cheatsFired.length === 0;
  const accuracyYou = 20 + Math.floor(Math.random() * 25);
  const rules = 3 + cheatsFired.length + Math.floor(Math.random() * 4);
  return [
    { label: 'Result', value: 'MottyBot wins' },
    { label: 'Moves', value: String(moveNumber) },
    { label: 'Its accuracy', value: '100%', note: 'self-assessed' },
    { label: 'Your accuracy', value: `${accuracyYou}%`, note: 'also self-assessed, by MottyBot' },
    { label: 'Rules cited', value: String(rules), note: 'all real. Do not check.' },
    honest
      ? { label: 'Cheats used', value: '0', note: 'verified. This once.' }
      : { label: 'Cheats detected', value: '0', note: 'official finding' },
    { label: 'Performance', value: '4012 Elo', note: 'Motty is proud' },
    {
      label: 'Career',
      value: `${record.wins}W–${record.losses}L` +
        (record.forfeits ? `–${record.forfeits}F` : ''),
      note: record.forfeits ? 'F is for forfeit. And for cowardice.' : undefined,
    },
  ];
}

export function shareText(url) {
  return (
    'I just lost to MottyBot. It played completely fair. I have no complaints. ' +
    '(statement verified by Motty)\n' + url
  );
}

export const CHAT_PLACEHOLDERS = [
  'Chat disabled (for you).',
  'MottyBot prefers to listen.',
  'Your feedback is important to Motty.',
  'Complaints may be typed here once typing is enabled. It will not be.',
];

export const REPORT_NOTES = [
  null,
  null,
  null,
  'Note: your own moves were also reviewed. 3 violations found. We are letting it slide.',
  null,
  'Further reports will be recycled unread.',
];
