/**
 * chat.js
 * -------
 * Simple room-scoped text chat: rooms/{code}/chat/{pushId} = {uid,name,text,ts}.
 * Keeps only the most recent 100 messages server-side is out of scope for a
 * client-only app, so we just cap how many we render.
 */

const Chat = (() => {
  let code = null;
  let onMessage = () => {};
  let listenerRef = null;

  function start(roomCode) {
    stop();
    code = roomCode;
    listenerRef = db.ref(`rooms/${code}/chat`).limitToLast(100);
    listenerRef.on('child_added', snap => {
      onMessage({ id: snap.key, ...snap.val() });
    });
  }

  function stop() {
    if (listenerRef) listenerRef.off();
    listenerRef = null;
    code = null;
  }

  function send(text) {
    text = (text || '').trim();
    if (!text || !code) return;
    db.ref(`rooms/${code}/chat`).push({
      uid: Room.myUid,
      name: Room.myName,
      text: text.slice(0, 300),
      ts: firebase.database.ServerValue.TIMESTAMP
    });
  }

  return {
    start, stop, send,
    set onMessage(fn) { onMessage = fn; }
  };
})();

window.Chat = Chat;
