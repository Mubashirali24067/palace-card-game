/**
 * room.js
 * -------
 * Everything about the LOBBY: creating/joining a 6-char room, tracking who's
 * in it, ready state, host transfer on disconnect, and letting a player
 * rejoin the same room after a refresh/drop. Game-state sync lives in
 * game.js; this file only owns rooms/{code}/players and rooms/{code}/status.
 */

const Room = (() => {
  const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
  const AVATAR_EMOJI = ['🦁', '🐯', '🐼', '🦊', '🐺', '🐸', '🐵', '🦉', '🐧', '🐢', '🦄', '🐲'];

  let myUid = null;
  let myName = null;
  let myAvatar = null;
  let roomCode = null;
  let isHost = false;
  let playersCache = {};
  let onPlayersChange = () => {};
  let onRoomStatusChange = () => {};
  let onKicked = () => {};

  function randomRoomCode() {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
    return code;
  }

  function randomAvatar() {
    return AVATAR_EMOJI[Math.floor(Math.random() * AVATAR_EMOJI.length)];
  }

  /** Sign in anonymously (once) and remember the uid. */
  async function ensureAuth() {
    if (myUid) return myUid;
    return new Promise((resolve, reject) => {
      auth.onAuthStateChanged(user => {
        if (user) {
          myUid = user.uid;
          resolve(myUid);
        }
      });
      auth.signInAnonymously().catch(reject);
    });
  }

  /** Try up to 5 times to mint a room code that isn't already taken. */
  async function generateUniqueRoomCode() {
    for (let i = 0; i < 5; i++) {
      const code = randomRoomCode();
      const snap = await db.ref(`rooms/${code}`).get();
      if (!snap.exists()) return code;
    }
    throw new Error('Could not generate a free room code, try again.');
  }

  function saveSession(code, uid, name) {
    localStorage.setItem('palace_session', JSON.stringify({ code, uid, name, ts: Date.now() }));
  }

  function loadSession() {
    try {
      return JSON.parse(localStorage.getItem('palace_session'));
    } catch {
      return null;
    }
  }

  function clearSession() {
    localStorage.removeItem('palace_session');
  }

  /** Attach the onDisconnect handler + live listeners for a room we've just joined/created. */
  function attachRoomListeners(code, uid) {
    const playerRef = db.ref(`rooms/${code}/players/${uid}`);
    // As soon as this client's socket drops, Firebase server-side flips this.
    playerRef.child('connected').onDisconnect().set(false);
    playerRef.child('connected').set(true);

    db.ref(`rooms/${code}/players`).on('value', snap => {
      playersCache = snap.val() || {};
      // If we've been removed entirely (kicked / room reset), tell the UI.
      if (!playersCache[uid] && roomCode) {
        onKicked();
        return;
      }
      isHost = !!(playersCache[uid] && playersCache[uid].isHost);
      maybePromoteSelfToHost(code, uid);
      onPlayersChange(playersCache);
    });

    db.ref(`rooms/${code}/status`).on('value', snap => {
      onRoomStatusChange(snap.val() || 'lobby');
    });
  }

  /**
   * Host-transfer logic: every connected client watches for "the host is
   * disconnected". If that's true, the lowest-`order` CONNECTED player runs
   * a transaction to claim host. Using a transaction on the `host` pointer
   * avoids two clients racing to both declare themselves host.
   */
  function maybePromoteSelfToHost(code, uid) {
    const players = playersCache;
    const hostEntry = Object.entries(players).find(([, p]) => p.isHost);
    if (!hostEntry) return;
    const [hostUid, hostData] = hostEntry;
    if (hostData.connected) return; // current host is fine
    if (hostUid === uid) return; // we already know we're disconnected... shouldn't happen

    const connectedPlayers = Object.entries(players)
      .filter(([, p]) => p.connected)
      .sort((a, b) => a[1].order - b[1].order);
    if (connectedPlayers.length === 0) return;
    const [nextHostUid] = connectedPlayers[0];
    if (nextHostUid !== uid) return; // not our job

    // Transaction on the room's `host` pointer prevents a double-promotion race.
    db.ref(`rooms/${code}/host`).transaction(current => {
      if (current === hostUid) return uid; // still stale, claim it
      return; // someone already changed it, abort
    }).then(() => {
      db.ref(`rooms/${code}/players/${hostUid}/isHost`).set(false);
      db.ref(`rooms/${code}/players/${uid}/isHost`).set(true);
    });
  }

  async function createRoom(name) {
    await ensureAuth();
    const code = await generateUniqueRoomCode();
    myName = name;
    myAvatar = randomAvatar();
    roomCode = code;

    const playerData = {
      name, avatar: myAvatar, ready: false, connected: true,
      isHost: true, order: 0
    };

    await db.ref(`rooms/${code}`).set({
      host: myUid,
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      status: 'lobby',
      maxPlayers: 8,
      players: { [myUid]: playerData }
    });

    saveSession(code, myUid, name);
    attachRoomListeners(code, myUid);
    isHost = true;
    return code;
  }

  async function joinRoom(code, name) {
    await ensureAuth();
    code = code.trim().toUpperCase();
    const roomRef = db.ref(`rooms/${code}`);
    const snap = await roomRef.get();
    if (!snap.exists()) throw new Error('Room not found. Check the code.');
    const room = snap.val();

    const players = room.players || {};

    // Rejoining after a drop/refresh — same uid already has a seat.
    if (players[myUid]) {
      roomCode = code;
      myName = players[myUid].name;
      myAvatar = players[myUid].avatar;
      saveSession(code, myUid, myName);
      attachRoomListeners(code, myUid);
      return code;
    }

    if (room.status !== 'lobby') {
      throw new Error('Game already in progress — cannot join mid-game.');
    }

    const currentCount = Object.keys(players).length;
    if (currentCount >= 8) throw new Error('Room Full');

    myName = name;
    myAvatar = randomAvatar();
    roomCode = code;

    const playerData = {
      name, avatar: myAvatar, ready: false, connected: true,
      isHost: false, order: currentCount
    };
    await roomRef.child(`players/${myUid}`).set(playerData);

    saveSession(code, myUid, name);
    attachRoomListeners(code, myUid);
    isHost = false;
    return code;
  }

  /** Called on page load: if we have a saved session, silently rejoin it. */
  async function tryRestoreSession() {
    const session = loadSession();
    if (!session || !session.code) return null;
    await ensureAuth();
    // If auth gave us a *different* uid than last time (new anon identity),
    // the saved session is stale, drop it.
    if (session.uid !== myUid) {
      clearSession();
      return null;
    }
    try {
      const code = await joinRoom(session.code, session.name);
      return code;
    } catch {
      clearSession();
      return null;
    }
  }

  async function setReady(ready) {
    await db.ref(`rooms/${roomCode}/players/${myUid}/ready`).set(ready);
  }

  async function leaveRoom() {
    if (!roomCode || !myUid) return;
    const code = roomCode;
    await db.ref(`rooms/${code}/players/${myUid}`).remove();
    db.ref(`rooms/${code}/players`).off();
    db.ref(`rooms/${code}/status`).off();
    clearSession();
    roomCode = null;
    isHost = false;
  }

  /** Host-only: begin the game if requirements are met. */
  async function startGame() {
    if (!isHost) throw new Error('Only the host can start the game.');
    const players = playersCache;
    const uids = Object.keys(players);
    if (uids.length < 2) throw new Error('Need at least 2 players.');
    const allReady = uids.every(uid => players[uid].ready);
    if (!allReady) throw new Error('All players must be Ready.');

    // Deterministic seat order for turn order = `order` field, ascending.
    const orderedUids = uids.slice().sort((a, b) => players[a].order - players[b].order);
    const gameState = GameEngine.dealNewGame(orderedUids);

    await db.ref(`rooms/${roomCode}`).update({
      status: 'playing',
      game: gameState
    });
  }

  async function returnToLobby() {
    if (!isHost) throw new Error('Only the host can reset the room.');
    const players = playersCache;
    const resetPlayers = {};
    Object.entries(players).forEach(([uid, p]) => {
      resetPlayers[uid] = { ...p, ready: false };
    });
    await db.ref(`rooms/${roomCode}`).update({
      status: 'lobby',
      players: resetPlayers,
      game: null,
      chat: null
    });
  }

  function playerCount() {
    return Object.keys(playersCache).length;
  }

  return {
    get myUid() { return myUid; },
    get myName() { return myName; },
    get roomCode() { return roomCode; },
    get isHost() { return isHost; },
    get players() { return playersCache; },
    ensureAuth, createRoom, joinRoom, tryRestoreSession,
    setReady, leaveRoom, startGame, returnToLobby, playerCount,
    set onPlayersChange(fn) { onPlayersChange = fn; },
    set onRoomStatusChange(fn) { onRoomStatusChange = fn; },
    set onKicked(fn) { onKicked = fn; }
  };
})();

window.Room = Room;
