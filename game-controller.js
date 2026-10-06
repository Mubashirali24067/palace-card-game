/**
 * game.js
 * -------
 * Bridges the pure GameEngine to Firebase. Every player action (play cards,
 * pick up the pile) goes through db.ref(...).transaction() rather than a
 * plain .set()/.update() — that's what stops two players from both
 * successfully playing on the same turn if their requests land at nearly
 * the same time. The transaction's update function re-runs on the CURRENT
 * server value, so the second racer will see turnIndex/currentPlayer has
 * already moved on and its engine call will throw "Not your turn", causing
 * the transaction to abort (return undefined) instead of corrupting state.
 */

const Game = (() => {
  let code = null;
  let onState = () => {};
  let gameRef = null;

  function start(roomCode) {
    stop();
    code = roomCode;
    gameRef = db.ref(`rooms/${code}/game`);
    gameRef.on('value', snap => {
      const raw = snap.val();
      if (raw) onState(GameEngine.normalizeState(raw));
    });
  }

  function stop() {
    if (gameRef) gameRef.off();
    gameRef = null;
    code = null;
  }

  /**
   * Run `mutator(currentState) -> newState` as a Firebase transaction.
   * If mutator throws (illegal move), we swallow it and abort the
   * transaction (return undefined) rather than writing bad state.
   */
  async function runTransaction(mutator, onIllegal) {
    if (!gameRef) return;
    let caughtError = null;
    const result = await gameRef.transaction(current => {
      if (!current) return current; // no game yet, nothing to do
      try {
        return mutator(current);
      } catch (err) {
        caughtError = err;
        return; // abort — Firebase leaves the value untouched
      }
    });
    if (caughtError && onIllegal) onIllegal(caughtError.message);
    return result;
  }

  function playCards(uid, cardIds, onIllegal) {
    return runTransaction(
      current => GameEngine.applyPlay(current, uid, cardIds),
      onIllegal
    );
  }

  function pickUpPile(uid, onIllegal) {
    return runTransaction(
      current => GameEngine.applyPickUpPile(current, uid),
      onIllegal
    );
  }

  return {
    start, stop, playCards, pickUpPile,
    set onState(fn) { onState = fn; }
  };
})();

window.Game = Game;
