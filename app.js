/**
 * app.js
 * ------
 * The only file that touches DOM event listeners directly. Everything else
 * (Room, Game, Chat, Voice, UI, GameEngine, Deck) is a self-contained module
 * this file wires together. Keeping the wiring in one place makes the whole
 * app's control flow readable top-to-bottom.
 */

(function () {
  console.log('%c[Palace] app.js loaded — build 2026-08-31-v10-LIGHTTABLE', 'color:#c9a227;font-weight:bold;font-size:14px;');
  const $ = sel => document.querySelector(sel);

  let latestGameState = null;
  let selectedIds = [];
  let unreadChatCount = 0;
  let finishedBannerDismissed = false;

  // ---------------- Screen: Name entry ----------------
  $('#btn-continue-name').addEventListener('click', () => {
    const name = $('#input-name').value.trim();
    if (!name) { $('#name-error').textContent = 'Enter a name to continue.'; return; }
    if (name.length > 18) { $('#name-error').textContent = 'Name is too long (max 18 characters).'; return; }
    sessionStorage.setItem('palace_name', name);
    UI.showScreen('screen-home');
  });
  $('#input-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-continue-name').click(); });

  // ---------------- Screen: Home (create/join) ----------------
  $('#tab-create').addEventListener('click', () => setHomeMode('create'));
  $('#tab-join').addEventListener('click', () => setHomeMode('join'));
  function setHomeMode(mode) {
    $('#tab-create').classList.toggle('active', mode === 'create');
    $('#tab-join').classList.toggle('active', mode === 'join');
    $('#join-code-row').style.display = mode === 'join' ? 'block' : 'none';
    $('#btn-home-action').textContent = mode === 'create' ? 'Create Room' : 'Join Room';
    $('#btn-home-action').dataset.mode = mode;
  }
  setHomeMode('create');

  $('#btn-home-action').addEventListener('click', async () => {
    const mode = $('#btn-home-action').dataset.mode;
    const name = sessionStorage.getItem('palace_name') || 'Player';
    $('#home-error').textContent = '';
    try {
      if (mode === 'create') {
        const code = await Room.createRoom(name);
        enterLobby(code);
      } else {
        const code = $('#input-join-code').value.trim().toUpperCase();
        if (code.length !== 6) throw new Error('Room codes are 6 characters.');
        await Room.joinRoom(code, name);
        enterLobby(code);
      }
    } catch (err) {
      $('#home-error').textContent = err.message;
    }
  });

  // ---------------- Lobby wiring ----------------
  function enterLobby(code) {
    UI.showScreen('screen-lobby');
    Room.onPlayersChange = players => {
      UI.renderLobby(players, Room.myUid, Room.roomCode);
      // Let voice module know about anyone new, in case voice is already joined.
      Object.keys(players).forEach(uid => Voice.notifyPeerJoined(uid));
      UI.renderVoiceSpeakers(Object.keys(players).filter(u => u !== Room.myUid), players);
    };
    Room.onRoomStatusChange = status => {
      if (status === 'playing') enterGame();
    };
    Room.onKicked = () => {
      UI.toast('You were removed from the room.');
      backToHome();
    };
    Chat.start(code);
    unreadChatCount = 0;
    Chat.onMessage = msg => {
      UI.appendChatMessage(msg, Room.myUid);
      if (!$('#chat-panel').classList.contains('open') && msg.uid !== Room.myUid) {
        unreadChatCount++;
        const badge = $('#chat-badge');
        if (badge) {
          badge.textContent = unreadChatCount;
          badge.style.display = 'flex';
        }
        $('#chat-toggle').classList.add('has-activity');
      }
    };
  }

  $('#btn-ready').addEventListener('click', async () => {
    const players = Room.players;
    const me = players[Room.myUid];
    await Room.setReady(!(me && me.ready));
  });

  $('#btn-start-game').addEventListener('click', async () => {
    try {
      await Room.startGame();
    } catch (err) {
      UI.toast(err.message);
    }
  });

  $('#btn-leave-lobby').addEventListener('click', async () => {
    await Voice.leaveVoice();
    await Room.leaveRoom();
    Chat.stop();
    backToHome();
  });

  function backToHome() {
    UI.showScreen('screen-home');
  }

  // ---------------- Game wiring ----------------
  function enterGame() {
    UI.showScreen('screen-game');
    $('#game-room-code').textContent = Room.roomCode;
    selectedIds = [];
    finishedBannerDismissed = false;
    startReactions(Room.roomCode);
    let loggedOnce = false;
    Game.onState = state => {
      try {
        latestGameState = state;
        // Firebase can briefly deliver a partial/transient snapshot right
        // after a multi-path update before the local cache is fully
        // consistent — guard the one-time diagnostic log so it can never
        // itself crash the update handler.
        if (!loggedOnce && state && state.hands) {
          loggedOnce = true;
          console.log('[Palace] Entered game. My uid:', Room.myUid);
          console.log('[Palace] Seats with cards:', Object.keys(state.hands));
          if (!state.hands[Room.myUid]) {
            console.warn('[Palace] MISMATCH: my uid has no seat in this game state.');
          }
        }
        if (!state || !state.hands || !state.faceUp || !state.faceDown || !state.playerOrder) {
          // Incomplete/transient snapshot — skip this render, the next
          // 'value' event (server-confirmed) will have the full object.
          return;
        }
        renderGame(state);
        if (state.phase === 'finished') showWinner(state);
      } catch (err) {
        console.error('[Palace] onState handler failed:', err);
        UI.toast('Game update error: ' + err.message);
      }
    };
    Game.start(Room.roomCode);
  }

  function renderGame(state) {
    const players = Room.players;
    // Each render step is isolated: if one throws, the rest still run and
    // the exact error surfaces as a toast instead of silently blanking
    // the whole screen (which is what was happening before this fix).
    safeRender('turn banner', () => UI.renderTurnBanner(state, Room.myUid, players));
    safeRender('play notification', () => UI.renderPlayNotification(state));
    safeRender('finished banner', () => renderFinishedBanner(state));
    safeRender('opponents', () => UI.renderOpponents(state, players, Room.myUid));
    safeRender('center pile', () => UI.renderCenter(state));
    safeRender('your zones', () => UI.renderMyZones(state, Room.myUid, selectedIds, onCardClick));

    try {
      const isMyTurn = GameEngine.currentPlayer(state) === Room.myUid;
      const zone = GameEngine.activeZone(state, Room.myUid);
      // Pick Up is available voluntarily any time it's the player's turn and
      // there's a pile to take — not only when they're stuck with no legal move.
      const canPickUp = isMyTurn && (zone === 'hands' || zone === 'faceUp') && state.discard.length > 0;
      UI.renderPickupButton(canPickUp);
      UI.renderPlayButton(isMyTurn && selectedIds.length > 0);
    } catch (err) {
      console.error('[Palace] action-button render failed:', err);
      UI.toast('Render error (buttons): ' + err.message);
    }
  }

  function safeRender(label, fn) {
    try {
      fn();
    } catch (err) {
      console.error(`[Palace] render failed (${label}):`, err);
      UI.toast(`Render error (${label}): ${err.message}`);
    }
  }

  /**
   * A player can finish (empty hand+faceUp+faceDown) well before the game
   * actually ends — remaining players keep playing until only one is left
   * (the loser). While that's happening, a finished player gets a small
   * banner offering to keep watching (spectate, no action needed — their
   * turn simply never comes up again since they're out of playerOrder) or
   * leave the room outright.
   */
  function renderFinishedBanner(state) {
    const banner = $('#finished-banner');
    const iAmFinished = (state.finishOrder || []).includes(Room.myUid);
    const gameStillGoing = state.phase === 'playing';
    if (iAmFinished && gameStillGoing && !finishedBannerDismissed) {
      const placeText = state.winner === Room.myUid
        ? "🎉 You finished first! Watch the rest of the game or leave."
        : "🎉 You're out! Watch the rest of the game or leave.";
      $('#finished-banner-text').textContent = placeText;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }

  $('#btn-keep-watching').addEventListener('click', () => {
    finishedBannerDismissed = true;
    $('#finished-banner').style.display = 'none';
  });

  $('#btn-finished-leave').addEventListener('click', async () => {
    if (!confirm('Leave the game?')) return;
    Game.stop();
    await Voice.leaveVoice();
    await Room.leaveRoom();
    Chat.stop();
    backToHome();
  });

  function onCardClick(cardId, zone) {
    try {
      const state = latestGameState;
      if (!state) return;
      if (GameEngine.currentPlayer(state) !== Room.myUid) {
        UI.toast("It's not your turn yet.");
        return;
      }

      if (zone === 'faceDown') {
        submitPlay([cardId]);
        return;
      }

      const zoneCards = (state[zone] && state[zone][Room.myUid]) || [];
      const card = zoneCards.find(c => c.id === cardId);
      if (!card) return;

      const legalIds = GameEngine.legalCardIds(state, Room.myUid);
      if (!legalIds.includes(cardId) && !selectedIds.includes(cardId)) {
        UI.toast('That card cannot be played on the current pile.');
        return;
      }

      // If this rank has no duplicate in the active zone and nothing else
      // is already selected, there's no "multiple" to build — just play it
      // immediately instead of making the player select-then-confirm.
      const sameRankCount = zoneCards.filter(c => c.rank === card.rank).length;
      if (sameRankCount === 1 && selectedIds.length === 0 && legalIds.includes(cardId)) {
        submitPlay([cardId]);
        return;
      }

      if (selectedIds.includes(cardId)) {
        selectedIds = selectedIds.filter(id => id !== cardId);
      } else {
        const firstSelected = zoneCards.find(c => c.id === selectedIds[0]);
        if (selectedIds.length === 0 || (firstSelected && firstSelected.rank === card.rank)) {
          selectedIds.push(cardId);
        } else {
          selectedIds = [cardId];
        }
      }
      renderGame(state);
    } catch (err) {
      console.error('[Palace] onCardClick failed:', err);
      UI.toast('Card click error: ' + err.message);
    }
  }

  $('#btn-play-selected').addEventListener('click', () => {
    try {
      if (selectedIds.length === 0) return;
      submitPlay(selectedIds.slice());
    } catch (err) {
      console.error('[Palace] play button failed:', err);
      UI.toast('Play error: ' + err.message);
    }
  });

  function submitPlay(cardIds) {
    Game.playCards(Room.myUid, cardIds, message => UI.toast(message))
      .catch(err => {
        console.error('[Palace] playCards transaction failed:', err);
        UI.toast('Play failed: ' + err.message);
      });
    selectedIds = [];
  }

  $('#btn-pickup').addEventListener('click', () => {
    Game.pickUpPile(Room.myUid, message => UI.toast(message))
      .catch(err => {
        console.error('[Palace] pickUpPile transaction failed:', err);
        UI.toast('Pick up failed: ' + err.message);
      });
  });

  // ---------------- Winner screen ----------------
  function showWinner(state) {
    Game.stop();
    const players = Room.players;
    const winnerName = players[state.winner] ? players[state.winner].name : 'A player';
    const loserName = state.loser && players[state.loser] ? players[state.loser].name : null;
    UI.renderWinner(winnerName, state.winner === Room.myUid, loserName, state.loser === Room.myUid, Room.isHost);
    UI.showScreen('screen-winner');
  }

  $('#btn-return-lobby').addEventListener('click', async () => {
    try {
      await Room.returnToLobby();
      UI.showScreen('screen-lobby');
    } catch (err) {
      UI.toast(err.message);
    }
  });

  $('#btn-play-again-leave').addEventListener('click', async () => {
    await Voice.leaveVoice();
    await Room.leaveRoom();
    Chat.stop();
    backToHome();
  });

  // ---------------- Emoji reactions ----------------
  let reactionsRef = null;
  function startReactions(code) {
    if (reactionsRef) reactionsRef.off();
    reactionsRef = db.ref(`rooms/${code}/reactions`).limitToLast(1);
    let first = true;
    reactionsRef.on('child_added', snap => {
      if (first) { first = false; return; } // don't replay whatever was already there
      const data = snap.val();
      if (data && data.emoji) UI.spawnReaction(data.emoji);
    });
  }
  document.querySelectorAll('.emoji-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const emoji = btn.dataset.emoji;
      UI.spawnReaction(emoji); // show it instantly for the sender too
      if (Room.roomCode) {
        db.ref(`rooms/${Room.roomCode}/reactions`).push({ emoji, ts: firebase.database.ServerValue.TIMESTAMP });
      }
    });
  });

  // ---------------- Chat panel (independent) ----------------
  $('#chat-toggle').addEventListener('click', () => {
    $('#chat-panel').classList.toggle('open');
    $('#voice-panel-wrap').classList.remove('open');
    $('#chat-toggle').classList.remove('has-activity');
    unreadChatCount = 0;
    const badge = $('#chat-badge');
    if (badge) badge.style.display = 'none';
  });
  $('#chat-close').addEventListener('click', () => $('#chat-panel').classList.remove('open'));

  $('#chat-send-btn').addEventListener('click', sendChat);
  $('#chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
  function sendChat() {
    const input = $('#chat-input');
    Chat.send(input.value);
    input.value = '';
  }

  // ---------------- Voice panel (independent) ----------------
  $('#voice-toggle').addEventListener('click', () => {
    $('#voice-panel-wrap').classList.toggle('open');
    $('#chat-panel').classList.remove('open');
  });
  $('#voice-close').addEventListener('click', () => $('#voice-panel-wrap').classList.remove('open'));

  $('#btn-voice-join').addEventListener('click', async () => {
    try {
      UI.setVoiceStatus('Requesting microphone…');
      const activeUids = Object.keys(Room.players);
      await Voice.joinVoice(Room.roomCode, Room.myUid, activeUids);
      UI.setVoiceStatus('Connected — you can talk now.');
      $('#btn-voice-join').style.display = 'none';
      $('#btn-voice-leave').style.display = 'inline-block';
      $('#btn-voice-mute').style.display = 'inline-block';
    } catch (err) {
      UI.setVoiceStatus('Could not connect: ' + (err && err.message ? err.message : 'microphone unavailable.'));
    }
  });

  $('#btn-voice-leave').addEventListener('click', async () => {
    await Voice.leaveVoice();
    UI.setVoiceStatus('Not connected.');
    $('#btn-voice-join').style.display = 'inline-block';
    $('#btn-voice-leave').style.display = 'none';
    $('#btn-voice-mute').style.display = 'none';
  });

  $('#btn-voice-mute').addEventListener('click', () => {
    Voice.setMuted(!Voice.muted);
    $('#btn-voice-mute').textContent = Voice.muted ? '🔇 Unmute' : '🎙️ Mute';
  });

  // ---------------- Leave Game (mid-match) ----------------
  $('#btn-leave-game').addEventListener('click', async () => {
    if (!confirm('Leave the game? You will lose your seat in this match.')) return;
    Game.stop();
    await Voice.leaveVoice();
    await Room.leaveRoom();
    Chat.stop();
    backToHome();
  });

  Voice.onStatus = (status, detail) => {
    if (status === 'error') UI.toast(detail);
  };
  Voice.onPeerAudio = (uid, stream) => {
    let audioEl = document.getElementById('audio-' + uid);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = 'audio-' + uid;
      audioEl.autoplay = true;
      document.body.appendChild(audioEl);
    }
    audioEl.srcObject = stream;
  };
  Voice.onPeerLeft = uid => {
    const audioEl = document.getElementById('audio-' + uid);
    if (audioEl) audioEl.remove();
  };

  // ---------------- Boot ----------------
  window.addEventListener('unhandledrejection', e => {
    const msg = (e.reason && e.reason.message) ? e.reason.message : String(e.reason);
    UI.toast('Error: ' + msg);
  });
  window.addEventListener('error', e => {
    // "Script error." with no useful detail means the exception came from
    // a cross-origin script (the Firebase SDK) — our own try/catch blocks
    // around game logic already report anything useful, so skip the noise.
    if (e.message && e.message !== 'Script error.') UI.toast('Error: ' + e.message);
  });

  (async function boot() {
    await Room.ensureAuth();
    const savedName = sessionStorage.getItem('palace_name');
    if (savedName) $('#input-name').value = savedName;

    const restoredCode = await Room.tryRestoreSession();
    if (restoredCode) {
      const snap = await db.ref(`rooms/${restoredCode}/status`).get();
      const status = snap.val();
      enterLobby(restoredCode);
      UI.renderLobby(Room.players, Room.myUid, restoredCode);
      if (status === 'playing') enterGame();
      return;
    }
    UI.showScreen('screen-name');
  })();
})();
