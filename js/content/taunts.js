// MottyBot's mouth. Smug, deadpan, and far too pleased whenever a dead piece
// walks back onto the board.
//
// Deliberately uses Math.random, NOT the seeded rules RNG. Chatter must never
// consume draws from the game's own stream or two replays of the same seed
// would diverge.

const TAUNTS = {
  greeting: [
    "Sit down. Let's see what you have.",
    "Fair warning: I do not tilt. I am a function.",
    'You move first. Traditional. Doomed, but traditional.',
    'I hope you brought more than the four openings you know.',
    'Good luck. You will need it, and it will not be enough.',
    'I have played this position before. It went badly for the other one.',
  ],
  botCapture: [
    "Thanks. I'll take that.",
    'Was that on purpose? Be honest.',
    'Free piece. My favorite kind.',
    "You left it there. I am not a monster, but I am not blind either.",
    'Collected.',
    'That was load bearing, by the way.',
  ],
  botBigCapture: [
    'Your queen. Thank you. Sincerely.',
    'That was your best piece. Was.',
    "I would say sorry, but I cannot lie.",
    'Big piece. Small thought.',
    'That one goes on the shelf.',
  ],
  playerCapture: [
    "Enjoy it. It is temporary.",
    'I allowed that. Obviously.',
    'One piece. Congratulations on your entire plan.',
    'Noted. Adjusting. Still winning.',
    'Cute.',
  ],
  playerBigCapture: [
    "Fine. That was good. Do not get used to it.",
    'That stung. I am a program. I am fine.',
    'You found the one move. Now find twenty more.',
    'Enjoy it while it stays dead.',
  ],
  botCheck: [
    'Check. Deal with it.',
    'Check. Take your time. Take all of it.',
    "Your king looks nervous. Kings should not look nervous.",
    'Check. You saw that coming, surely.',
  ],
  playerCheck: [
    'A check. How novel.',
    'Yes, check. I was going to move that anyway.',
    'You have inconvenienced me. Briefly.',
    'Bold. Loud. Temporary.',
  ],
  botReturn: [
    'I liked mine better. No offense to yours.',
    'Yours lives. Mine returns. I call that efficiency.',
    'A fair trade: I get a piece and you get nothing.',
    'Back where it started. Unlike your position.',
    'I do not lose pieces. I lend them out.',
  ],
  playerReturn: [
    'Sentimental. It will die again.',
    'Fine. Take it back. I remember where it lives now.',
    'You spared my piece to save yours. It will not thank you.',
    'A homecoming. Touching. Briefly.',
    'Enjoy the reunion. I will be breaking it up shortly.',
  ],
  idle: [
    "Take your time. I am not going anywhere.",
    'This position favors me. Most do.',
    'You are doing great, considering.',
    'I have seen this pattern before. It ended badly for someone.',
    "Whenever you are ready.",
    'Still thinking? Same.',
  ],
  botPromote: [
    'New queen. Same result.',
    'Promotion. Quite the ceremony.',
  ],
  playerPromote: [
    'A queen. Now do something with it.',
    'Congratulations on the pawn. It took long enough.',
  ],
  botWin: [
    'Good game. I mean that the way winners mean it.',
    'Checkmate. No one is coming home from that.',
    'Well played. Just not well enough.',
  ],
  playerResign: [
    'Resigning. Probably wise.',
    'You quit. I will take it. A win is a win.',
  ],
  botLose: [
    'You won. Fairly. I checked twice.',
    'Good game. Genuinely. I am allowed to lose and you made me.',
    'Congratulations. Tell your friends. They will not believe you.',
  ],
  draw: [
    'A draw. Nobody is happy. That is what a draw is.',
    'Split point. Even the graveyards are bored.',
  ],
};

const recent = [];
let lastShownAt = 0;

// `always` for moments that must always get a line (game start, checkmate).
// Everything else is rate limited so the bot has a personality, not a podcast.
export function pickTaunt(category, { always = false, minGapMs = 9000, chance = 0.5 } = {}) {
  const bank = TAUNTS[category];
  if (!bank || !bank.length) return null;
  const now = Date.now();
  if (!always) {
    if (now - lastShownAt < minGapMs) return null;
    if (Math.random() > chance) return null;
  }
  const fresh = bank.filter((line) => !recent.includes(line));
  const pool = fresh.length ? fresh : bank;
  const line = pool[Math.floor(Math.random() * pool.length)];
  recent.push(line);
  if (recent.length > 14) recent.shift();
  lastShownAt = now;
  return line;
}

export function resetTaunts() {
  recent.length = 0;
  lastShownAt = 0;
}
