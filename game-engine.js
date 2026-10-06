/**
 * game-engine.js
 * --------------
 * Pure, deterministic Palace rules engine. Every function here takes a
 * plain "game" state object and returns a NEW state object (no mutation).
 * This is what lets game.js run the exact same logic locally (for instant
 * UI feedback) and inside a Firebase transaction (for the authoritative
 * write) without any drift between the two.
 *
 * GAME STATE SHAPE (mirrors rooms/{code}/game in Firebase):
 * {
 *   playerOrder: [uid, uid, ...]   // active (not-yet-finished) players, in seat order
 *   direction: 1 | -1,             // 1 = playerOrder order, -1 = reversed
 *   turnIndex: 0,                  // index into playerOrder for whose turn it is
 *   deck: [card, ...],             // face-down draw pile
 *   discard: [card, ...],          // pile, last element = top card
 *   hands:    { uid: [card,...] },
 *   faceUp:   { uid: [card,...] },
 *   faceDown: { uid: [card,...] },
 *   sevenActive: false,            // true = next play must be rank <= 7 (or a power card)
 *   finishOrder: [uid, ...],       // players who have gone out, in order
 *   winner: null | uid,
 *   phase: 'playing' | 'finished',
 *   log: [{ text, ts }]            // short human-readable event feed
 * }
 *
 * RULES REFERENCE (kept here so the "why" travels with the code):
 * - Normal cards (3,4,5,6,8,9,Q,K,A) must be STRICTLY GREATER than the top
 *   of the discard pile. Equal rank is NOT allowed.
 * - 2, 7, 10, and J are POWER CARDS: every one of them is legal on ANY top
 *   card, regardless of rank or the active 7-restriction.
 *     - 2  = wild. Resets the 7-restriction. The SAME player immediately
 *            plays again (any legal card, including another power card).
 *     - 7  = sets a restriction: the NEXT player's card must be rank <= 7
 *            (2/7/10/J remain legal too, since they're always legal).
 *            Turn advances normally to the next player.
 *     - 10 = burns/clears the entire discard pile. Turn advances normally
 *            to the next player (the player who burned does NOT go again).
 *     - J  = reverses the turn direction, then turn advances (in the new,
 *            reversed direction) to the next player.
 * - Card draw model (draw-before-play):
 *     - Everyone is dealt exactly 3 hand cards at the start (plus 3
 *       face-up, 3 face-down).
 *     - EVERY time it becomes a player's turn to act — including their
 *       very first turn, every turn after, AND the extra turn a player
 *       gets right after playing a 2 — they draw exactly ONE card from
 *       the deck first (if any remain), THEN play. There is no "refill
 *       to 3" — the hand simply gains 1 before each play and loses
 *       however many cards get played that turn.
 * - Pick Up Pile: the picking-up player takes the whole discard pile into
 *   their hand, plus draws ONE extra card from the deck if any remain, and
 *   KEEPS the turn (does not advance to the next player).
 * - A blind face-down play that turns out illegal behaves the same way:
 *   the failed card + the whole pile go to the player's hand, and they
 *   keep the turn (continuing from their now-refilled hand).
 * - Win: a player wins the instant their hand, face-up, AND face-down are
 *   all simultaneously empty. First to achieve that is the winner.
 */

/**
 * CRITICAL FIREBASE QUIRK: Realtime Database has no concept of an "empty
 * array" — writing [] to a path is treated the same as writing null, and
 * the key is pruned from the tree entirely. That means as soon as the
 * discard pile empties (start of game, or after a burn), or a player's
 * hand/faceUp/faceDown empties, that field silently disappears from what
 * we read back. Every function below assumes state.discard, state.deck,
 * state.hands[uid], etc. are always arrays — so we normalize immediately
 * after pulling a state snapshot from Firebase, before touching it.
 */
function normalizeState(raw) {
  const state = deepCopy(raw);
  state.playerOrder = state.playerOrder || [];
  state.finishOrder = state.finishOrder || [];
  state.discard = state.discard || [];
  state.deck = state.deck || [];
  state.log = state.log || [];
  state.hands = state.hands || {};
  state.faceUp = state.faceUp || {};
  state.faceDown = state.faceDown || {};

  const allUids = new Set([...state.playerOrder, ...state.finishOrder, ...Object.keys(state.hands)]);
  allUids.forEach(uid => {
    state.hands[uid] = state.hands[uid] || [];
    state.faceUp[uid] = state.faceUp[uid] || [];
    state.faceDown[uid] = state.faceDown[uid] || [];
  });
  return state;
}

const MAX_LOG = 30;

function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function pushLog(state, text) {
  state.log = state.log || [];
  state.log.push({ text, ts: Date.now() });
  if (state.log.length > MAX_LOG) state.log = state.log.slice(-MAX_LOG);
}

/**
 * Deal a fresh game for the given list of player uids (2-8 players).
 * Each player gets 3 hand cards, 3 face-up cards, 3 face-down cards — 9
 * cards per player, which is the standard Palace/Shithead deal.
 *
 * IMPORTANT DECK-SIZE NOTE: a single 52-card pack only covers 9 cards x up
 * to 5 players (45 cards) with a few left for the draw pile. 6, 7, or 8
 * players need 54-72 cards just to deal, which a single standard deck
 * cannot supply. Real-world house rules for a big Palace table solve this
 * by shuffling a second standard 52-card pack in with the first — that's
 * what this does automatically once the seated player count needs it, so
 * the "2 to 8 players, standard deck(s)" requirement is satisfiable at
 * every table size rather than silently failing to deal for 6+ players.
 */
function decksNeeded(playerCount) {
  return Math.max(1, Math.ceil((playerCount * 9) / 52));
}

function dealNewGame(playerUids) {
  const numDecks = decksNeeded(playerUids.length);
  let combined = [];
  for (let d = 0; d < numDecks; d++) {
    // Suffix ids per pack so e.g. "7H" from pack 0 and pack 1 stay unique.
    combined = combined.concat(Deck.createDeck().map(c => ({ ...c, id: `${c.id}-${d}` })));
  }
  const deck = Deck.shuffleDeck(combined);
  const hands = {}, faceUp = {}, faceDown = {};

  for (const uid of playerUids) {
    faceDown[uid] = deck.splice(0, 3);
    faceUp[uid] = deck.splice(0, 3);
    hands[uid] = deck.splice(0, 3);
  }

  const state = {
    playerOrder: playerUids.slice(),
    direction: 1,
    turnIndex: 0,
    deck,
    discard: [],
    hands, faceUp, faceDown,
    sevenActive: false,
    finishOrder: [],
    winner: null,
    phase: 'playing',
    log: []
  };
  pushLog(state, 'Game started. Cards dealt.');
  // The first player to act draws their turn-start card immediately,
  // before anyone plays (see drawForTurnStart below).
  drawForTurnStart(state);
  return state;
}

function currentPlayer(state) {
  state = normalizeState(state);
  return state.playerOrder[state.turnIndex];
}

function topDiscard(state) {
  state = normalizeState(state);
  return state.discard.length ? state.discard[state.discard.length - 1] : null;
}

/**
 * Which "zone" must the given player play from right now?
 * hand -> faceUp (only when hand is empty) -> faceDown (only when both empty)
 *
 * The deck only ever adds cards via drawForTurnStart() (once per turn,
 * before the player acts) or the Pick Up Pile bonus draw — never a
 * "refill to N" — so a player's hand can legitimately run dry even while
 * the deck still has cards; zone progression only looks at what's
 * physically in each of the player's own three piles right now.
 */
function activeZone(state, uid) {
  state = normalizeState(state);
  if (state.hands[uid] && state.hands[uid].length > 0) return 'hands';
  if (state.faceUp[uid] && state.faceUp[uid].length > 0) return 'faceUp';
  if (state.faceDown[uid] && state.faceDown[uid].length > 0) return 'faceDown';
  return null; // nothing left = already finished
}

/** 2, 7, 10, and J are power cards: always legal, regardless of the pile. */
function isPowerCard(card) {
  return Deck.isWild(card) || Deck.isBurn(card) || Deck.isSeven(card) || Deck.isReverse(card);
}

/**
 * Is `card` a legal play right now?
 * - Power cards (2, 7, 10, J) are ALWAYS legal, on any top card, even while
 *   a 7-restriction is active.
 * - An empty pile means any card opens.
 * - Otherwise, a normal card must be STRICTLY GREATER than the top card
 *   (equal rank is not allowed).
 * - While a 7-restriction is active, a normal card must be rank <= 7.
 */
function isLegalPlay(state, card) {
  state = normalizeState(state);
  if (isPowerCard(card)) return true;

  const top = topDiscard(state);
  // An empty pile, OR a pile whose top is a wild 2, both mean "no
  // requirement" — a 2 resets the rank comparison entirely, so ANY card
  // (normal or power) is legal right after one is played, exactly like a
  // fresh empty pile.
  if (!top || Deck.isWild(top)) return true;

  if (state.sevenActive) {
    return Deck.rankValue(card) <= 7;
  }
  return Deck.rankValue(card) > Deck.rankValue(top); // strictly greater — same rank is illegal
}

/**
 * Return the list of hand-card ids that are currently legal to play, used
 * purely for UI highlighting. Face-up/face-down zones use the same check.
 */
function legalCardIds(state, uid) {
  state = normalizeState(state);
  const zone = activeZone(state, uid);
  if (!zone) return [];
  const cards = state[zone][uid] || [];
  // For face-down cards nobody (including the owner) can see the rank ahead
  // of time in a real game, but for UI purposes we still need to know which
  // physical card slots are selectable: all of them, since the player is
  // playing blind.
  if (zone === 'faceDown') return cards.map(c => c.id);
  return cards.filter(c => isLegalPlay(state, c)).map(c => c.id);
}

/** Move the turn pointer to the next active player, honoring `direction`. */
function advanceTurn(state) {
  const n = state.playerOrder.length;
  if (n === 0) return;
  state.turnIndex = ((state.turnIndex + state.direction) % n + n) % n;
}

/** Remove a finished player from playerOrder, keeping turnIndex pointed at the same *player* it was on (unless that player is the one being removed). */
function removePlayerFromOrder(state, uid) {
  const idx = state.playerOrder.indexOf(uid);
  if (idx === -1) return;
  const currentUid = state.playerOrder[state.turnIndex];
  state.playerOrder.splice(idx, 1);
  if (currentUid === uid) {
    // The removed player just finished; turnIndex now needs to land on
    // whoever is next in the (shrunk) array at the same slot, wrapped.
    const n = state.playerOrder.length;
    if (n > 0) state.turnIndex = state.turnIndex % n;
  } else {
    // Re-point turnIndex at the same player uid after the splice shifted indices.
    state.turnIndex = state.playerOrder.indexOf(currentUid);
  }
}

/**
 * Draw exactly ONE card from the deck (if any remain) into the CURRENT
 * player's hand. Called every single time it becomes someone's turn to
 * act — a brand new player's turn, the same player continuing after a
 * wild 2, or a player whose turn comes back around again later in the
 * game. There is no "only the first turn" special case anymore and no
 * "refill to N" — just one guaranteed card at the start of every turn.
 */
function drawForTurnStart(state) {
  const uid = state.playerOrder[state.turnIndex];
  if (!uid) return;
  if (state.deck.length > 0) {
    state.hands[uid].push(state.deck.shift());
  }
}

function hasNothingLeft(state, uid) {
  return state.hands[uid].length === 0 &&
    state.faceUp[uid].length === 0 &&
    state.faceDown[uid].length === 0;
}

/**
 * Apply a legal play of one or more same-rank cards from `zone` for `uid`.
 * cardIds: array of card ids being played this turn (must all share rank,
 * and all must currently be legal against the PRE-PLAY top of the pile —
 * so e.g. "5+5" when the top is a 5 is rejected even though it's a
 * matching pair, because 5 is not strictly greater than 5).
 *
 * Returns the new state. Throws a descriptive Error if the move is illegal,
 * so callers (Firebase transaction) can safely abort.
 */
function applyPlay(inputState, uid, cardIds) {
  const state = normalizeState(deepCopy(inputState));

  if (state.phase !== 'playing') throw new Error('Game is not in progress.');
  if (currentPlayer(state) !== uid) throw new Error('Not your turn.');
  if (!cardIds || cardIds.length === 0) throw new Error('No cards selected.');

  const zone = activeZone(state, uid);
  if (!zone) throw new Error('You have no cards left to play.');

  const zoneCards = state[zone][uid];
  const playing = cardIds.map(id => {
    const c = zoneCards.find(c => c.id === id);
    if (!c) throw new Error('Selected card is not in your active zone.');
    return c;
  });

  // All cards in a multi-card play must share a rank.
  const rank = playing[0].rank;
  if (!playing.every(c => c.rank === rank)) {
    throw new Error('All cards played together must be the same rank.');
  }

  // Face-down plays are blind: legality is checked AFTER revealing. A
  // failed blind play means "pick up the pile" (see rules reference above).
  let blindFail = false;
  if (zone === 'faceDown') {
    if (playing.length !== 1) throw new Error('Face-down cards are played one at a time.');
    if (!isLegalPlay(state, playing[0])) blindFail = true;
  } else {
    if (!playing.every(c => isLegalPlay(state, c))) {
      throw new Error('That card cannot be played on the current pile.');
    }
  }

  // Remove played cards from their zone.
  state[zone][uid] = zoneCards.filter(c => !cardIds.includes(c.id));

  if (blindFail) {
    // Reveal the failed face-down card, add it + entire discard pile to
    // hand. The player KEEPS the turn and continues from their hand.
    state.hands[uid] = state.hands[uid].concat(state.discard, playing);
    state.discard = [];
    state.sevenActive = false;
    pushLog(state, `Face-down card revealed a mismatch — picked up the pile and continues.`);
    return state; // no advanceTurn — same player's turn continues
  }

  // Legal play: goes to the discard pile.
  state.discard = state.discard.concat(playing);
  pushLog(state, `Played ${playing.map(Deck.cardLabel).join(', ')}.`);

  // ---- Special (power card) effects ----
  const last = playing[playing.length - 1];
  let extraTurn = false; // true = same player goes again

  if (Deck.isWild(last)) {
    // 2 = wild: resets the 7-restriction, and the SAME player immediately
    // plays again (any legal card, including another power card).
    state.sevenActive = false;
    extraTurn = true;
    pushLog(state, 'Wild 2! Same player plays again.');
  } else if (Deck.isBurn(last)) {
    // 10 = burn: clears the pile, then turn moves on to the NEXT player.
    state.discard = [];
    state.sevenActive = false;
    pushLog(state, "Pile burned! Next player's turn.");
  } else if (Deck.isSeven(last)) {
    // 7: next player must play rank <= 7 (power cards remain legal too).
    state.sevenActive = true;
    pushLog(state, 'Next player must play 7 or lower (2/10/J still allowed).');
  } else if (Deck.isReverse(last)) {
    // J: reverse direction, then turn advances using the NEW direction.
    state.direction *= -1;
    state.sevenActive = false;
    pushLog(state, 'Direction reversed!');
  } else {
    state.sevenActive = false;
  }

  // Did this play empty all three zones? Player finishes.
  if (hasNothingLeft(state, uid)) {
    state.finishOrder.push(uid);
    removePlayerFromOrder(state, uid);

    if (!state.winner) {
      // First player to clear all three zones is the WINNER — but the
      // game keeps going for everyone else until only one player is left
      // holding cards (that lone remaining player is the loser).
      state.winner = uid;
      pushLog(state, `A player finished first! Remaining players keep going.`);
    } else {
      pushLog(state, `Another player has gone out!`);
    }

    if (state.playerOrder.length <= 1) {
      // Only one player left with cards — the game is fully over. That
      // lone remaining player is the loser (last place).
      if (state.playerOrder.length === 1) {
        state.loser = state.playerOrder[0];
      }
      state.phase = 'finished';
      pushLog(state, `Game over — final standings decided.`);
      return state;
    }
    // Game continues for everyone still holding cards. Do NOT call
    // advanceTurn — turnIndex was already re-pointed at the correct next
    // player by removePlayerFromOrder. Draw their turn-start card before
    // they act.
    drawForTurnStart(state);
    return state;
  }

  if (!extraTurn) {
    advanceTurn(state);
  }
  // Draw the turn-start card for whoever plays next — the same player
  // continuing after a wild 2, or the player we just advanced to.
  drawForTurnStart(state);
  return state;
}

/**
 * Pick Up Pile: the current player takes the entire discard pile (plus one
 * bonus card from the deck, if any remain) into WHICHEVER zone they are
 * currently playing from — hand or face-up — not always into the hand.
 * This can be used voluntarily at any time on the player's turn (not only
 * when they're stuck with no legal move), and the player KEEPS the turn.
 */
function applyPickUpPile(inputState, uid) {
  const state = normalizeState(deepCopy(inputState));
  if (state.phase !== 'playing') throw new Error('Game is not in progress.');
  if (currentPlayer(state) !== uid) throw new Error('Not your turn.');
  if (state.discard.length === 0) throw new Error('Nothing to pick up.');

  // Face-down is blind and has its own automatic pickup-on-mismatch inside
  // applyPlay; voluntary pickup from face-down (nothing visible to base a
  // decision on) falls back to the hand, same as the traditional rule.
  const zone = activeZone(state, uid);
  const targetZone = (zone === 'faceUp') ? 'faceUp' : 'hands';

  state[targetZone][uid] = state[targetZone][uid].concat(state.discard);
  state.discard = [];
  state.sevenActive = false;

  if (state.deck.length > 0) {
    state[targetZone][uid].push(state.deck.shift());
  }

  pushLog(state, `Picked up the pile into ${targetZone === 'faceUp' ? 'face-up' : 'hand'} and drew a card — turn continues.`);
  // No advanceTurn: the player who picked up keeps the turn.
  return state;
}

window.GameEngine = {
  dealNewGame, decksNeeded, currentPlayer, topDiscard, activeZone,
  isLegalPlay, isPowerCard, legalCardIds, applyPlay, applyPickUpPile,
  hasNothingLeft, normalizeState, drawForTurnStart
};
