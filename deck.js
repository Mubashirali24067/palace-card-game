/**
 * deck.js
 * -------
 * Pure card/deck logic for Palace. No Firebase, no DOM — just data.
 * Keeping this pure makes the rules easy to reason about and unit-test
 * mentally: given a state, what does the deck/engine say is legal?
 */

const SUITS = ['S', 'H', 'D', 'C']; // Spades, Hearts, Diamonds, Clubs
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];

// Base comparison value used for "same or higher" checks.
// 2 is intentionally highest (wild) and 7 sits at its normal spot but carries
// a side-effect (see game-engine.js). 10 always burns regardless of value.
const RANK_VALUE = {
  '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14, '2': 15
};

/** Build a fresh, unshuffled 52-card deck. Each card gets a stable unique id. */
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ id: `${rank}${suit}`, rank, suit });
    }
  }
  return deck;
}

/** Fisher-Yates shuffle. Returns a new array, does not mutate input. */
function shuffleDeck(deck) {
  const arr = deck.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function rankValue(card) {
  return RANK_VALUE[card.rank];
}

function isWild(card) {
  return card.rank === '2';
}

function isBurn(card) {
  return card.rank === '10';
}

function isReverse(card) {
  return card.rank === 'J';
}

function isSeven(card) {
  return card.rank === '7';
}

function cardLabel(card) {
  const suitSymbol = { S: '♠', H: '♥', D: '♦', C: '♣' }[card.suit];
  return `${card.rank}${suitSymbol}`;
}

function isRedSuit(card) {
  return card.suit === 'H' || card.suit === 'D';
}

// Exported as a plain object attached to window so every script (loaded via
// plain <script> tags, no bundler) can reach it as `Deck.xxx`.
window.Deck = {
  SUITS, RANKS, RANK_VALUE,
  createDeck, shuffleDeck, rankValue,
  isWild, isBurn, isReverse, isSeven,
  cardLabel, isRedSuit
};
