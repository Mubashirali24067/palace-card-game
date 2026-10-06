/**
 * voice.js
 * --------
 * Full-mesh WebRTC voice chat (fine up to 8 players: max 7 connections per
 * client). Firebase Realtime Database is used ONLY to exchange the
 * SDP offer/answer and ICE candidates ("signaling") — once connected, audio
 * flows peer-to-peer and never touches Firebase.
 *
 * Signaling path: rooms/{code}/signaling/{toUid}/{fromUid} = {
 *   offer:  { type, sdp } | null,
 *   answer: { type, sdp } | null,
 *   candidates: { pushId: candidateJSON, ... }
 * }
 *
 * "Polite peer" rule to avoid both sides racing to create an offer at the
 * same time: whichever uid sorts LOWER (plain string compare) is the one
 * who creates the offer; the other side only answers.
 */

const Voice = (() => {
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  let code = null;
  let myUid = null;
  let localStream = null;
  let muted = false;
  let joined = false;
  const peers = {}; // uid -> RTCPeerConnection
  const audioEls = {}; // uid -> <audio> element
  let signalRefs = [];
  let onPeerAudio = () => {}; // (uid, MediaStream)
  let onPeerLeft = () => {};
  let onStatus = () => {}; // ('connecting'|'joined'|'error', detail)

  function sigPath(toUid, fromUid) {
    return `rooms/${code}/signaling/${toUid}/${fromUid}`;
  }

  async function joinVoice(roomCode, uid, activePeerUids) {
    code = roomCode;
    myUid = uid;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      onStatus('error', 'Microphone permission denied or unavailable.');
      throw err;
    }
    joined = true;
    onStatus('joined');

    // Connect to everyone already present.
    activePeerUids.filter(u => u !== myUid).forEach(peerUid => connectTo(peerUid));

    // Listen for inbound signaling addressed to me from anyone.
    const inboundRef = db.ref(`rooms/${code}/signaling/${myUid}`);
    inboundRef.on('child_added', snap => handleSignal(snap.key, snap.val()));
    inboundRef.on('child_changed', snap => handleSignal(snap.key, snap.val()));
    signalRefs.push(inboundRef);
  }

  function ensurePeerConnection(peerUid) {
    if (peers[peerUid]) return peers[peerUid];
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peers[peerUid] = pc;

    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.onicecandidate = e => {
      if (e.candidate) {
        db.ref(`${sigPath(peerUid, myUid)}/candidates`).push(e.candidate.toJSON());
      }
    };

    pc.ontrack = e => {
      onPeerAudio(peerUid, e.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        cleanupPeer(peerUid);
      }
    };

    return pc;
  }

  async function connectTo(peerUid) {
    if (peers[peerUid]) return;
    const pc = ensurePeerConnection(peerUid);
    const iAmInitiator = myUid < peerUid;
    if (!iAmInitiator) return; // the other side will send us an offer

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await db.ref(sigPath(peerUid, myUid)).update({
      offer: { type: offer.type, sdp: offer.sdp }
    });
  }

  async function handleSignal(peerUid, data) {
    if (!data) return;
    const pc = ensurePeerConnection(peerUid);

    if (data.offer && (!pc.currentRemoteDescription || pc.signalingState === 'stable')) {
      if (pc.signalingState !== 'stable') return; // already negotiating, ignore stray re-fire
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await db.ref(sigPath(peerUid, myUid)).update({
        answer: { type: answer.type, sdp: answer.sdp }
      });
    }

    if (data.answer && pc.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    }

    if (data.candidates) {
      Object.values(data.candidates).forEach(c => {
        pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
      });
    }
  }

  /** Call this whenever the lobby/game player list gains a new uid while voice is already joined. */
  function notifyPeerJoined(peerUid) {
    if (joined && peerUid !== myUid) connectTo(peerUid);
  }

  function cleanupPeer(peerUid) {
    if (peers[peerUid]) {
      peers[peerUid].close();
      delete peers[peerUid];
    }
    delete audioEls[peerUid];
    onPeerLeft(peerUid);
  }

  function setMuted(isMuted) {
    muted = isMuted;
    if (localStream) {
      localStream.getAudioTracks().forEach(t => (t.enabled = !isMuted));
    }
  }

  async function leaveVoice() {
    if (!joined) return;
    Object.keys(peers).forEach(cleanupPeer);
    signalRefs.forEach(ref => ref.off());
    signalRefs = [];
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    if (code && myUid) {
      db.ref(`rooms/${code}/signaling/${myUid}`).remove().catch(() => {});
    }
    joined = false;
  }

  return {
    joinVoice, leaveVoice, setMuted, notifyPeerJoined,
    get joined() { return joined; },
    get muted() { return muted; },
    set onPeerAudio(fn) { onPeerAudio = fn; },
    set onPeerLeft(fn) { onPeerLeft = fn; },
    set onStatus(fn) { onStatus = fn; }
  };
})();

window.Voice = Voice;
