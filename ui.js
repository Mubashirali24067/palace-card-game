/**
 * ui.js
 * -----
 * Pure-ish DOM rendering. Every render function takes data in and mutates
 * specific DOM nodes — no game logic lives here, it only reads GameEngine
 * helpers (isLegalPlay/activeZone/etc.) to decide what to highlight.
 */

const UI = (() => {
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  function showScreen(id) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    $(`#${id}`).classList.add('active');
  }

  function toast(msg) {
    const host = $('#toast-host');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  // ---------------- Lobby ----------------
  function renderLobby(players, myUid, roomCode) {
    $('#lobby-room-code').textContent = roomCode;
    const uids = Object.keys(players);
    $('#lobby-count').textContent = `Players ${uids.length}/8`;

    const grid = $('#lobby-players');
    grid.innerHTML = '';
    uids.sort((a, b) => players[a].order - players[b].order).forEach(uid => {
      const p = players[uid];
      const card = document.createElement('div');
      card.className = 'player-card' + (uid === myUid ? ' is-me' : '') + (!p.connected ? ' disconnected' : '');
      card.innerHTML = `
        ${p.isHost ? '<span class="host-crown">👑</span>' : ''}
        <div class="player-avatar">${p.avatar}</div>
        <div class="player-name">${escapeHtml(p.name)}${uid === myUid ? ' (you)' : ''}</div>
        <div class="player-tag">${p.connected ? '' : 'Disconnected'}</div>
        <div class="ready-pill ${p.ready ? 'ready' : 'not-ready'}">${p.ready ? 'Ready' : 'Not Ready'}</div>
      `;
      grid.appendChild(card);
    });

    const canStart = uids.length >= 2 && uids.every(u => players[u].ready);
    const startBtn = $('#btn-start-game');
    startBtn.disabled = !(players[myUid] && players[myUid].isHost && canStart);
    startBtn.textContent = canStart ? 'Start Game' : 'Waiting for players…';

    $('#lobby-hint').textContent = uids.length >= 8
      ? 'Room Full'
      : `${uids.length}/8 seated — need at least 2 players ready to start.`;
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ---------------- Table seating ----------------
  /** Position N-1 opponents evenly around the oval, "me" always at the bottom (implied by HUD). */
  function seatPositions(count) {
    // Start at the top (12 o'clock, 90deg in our math) and spread across the
    // remaining arc, leaving the bottom center free for "me".
    const positions = [];
    const startAngle = -90; // degrees, top of oval
    const totalArc = 300; // leave a gap at the bottom for the player's own seat
    for (let i = 0; i < count; i++) {
      const angle = count === 1
        ? startAngle
        : startAngle - totalArc / 2 + (totalArc / (count - 1)) * i;
      const rad = (angle * Math.PI) / 180;
      const x = 50 + 44 * Math.cos(rad);
      const y = 50 + 44 * Math.sin(rad) * 0.82;
      positions.push({ x, y });
    }
    return positions;
  }

  function renderOpponents(state, players, myUid) {
    const oval = $('#table-oval');
    $$('.opponent-badge').forEach(el => el.remove());

    const opponentUids = state.playerOrder.filter(u => u !== myUid);
    const positions = seatPositions(opponentUids.length);

    opponentUids.forEach((uid, i) => {
      const p = players[uid] || { name: '???', avatar: '❔', connected: false };
      const pos = positions[i];
      const el = document.createElement('div');
      const isTurn = GameEngine.currentPlayer(state) === uid;
      el.className = 'opponent-badge' + (isTurn ? ' current-turn' : '') + (!p.connected ? ' disconnected' : '');
      el.style.left = pos.x + '%';
      el.style.top = pos.y + '%';
      const handCount = (state.hands[uid] || []).length;
      const faceUpCount = (state.faceUp[uid] || []).length;
      const faceDownCount = (state.faceDown[uid] || []).length;
      const total = handCount + faceUpCount + faceDownCount;
      el.innerHTML = `
        <div class="badge-avatar">${p.avatar}<span class="badge-count">${total}</span></div>
        <div class="badge-name">${escapeHtml(p.name)}</div>
        <div class="badge-status">${isTurn ? 'Playing…' : (p.connected ? '' : 'Disconnected')}</div>
      `;
      oval.appendChild(el);
    });

    $('#direction-ring').classList.toggle('reversed', state.direction === -1);
  }

  function cardEl(card, { faceDown = false, playable = false, selected = false, extraClass = '' } = {}) {
    const el = document.createElement('div');
    if (faceDown || !card || !card.suit || !card.rank) {
      // Defensive: a malformed/missing card object renders as a face-down
      // back instead of throwing and silently killing the rest of the render.
      el.className = `card back ${extraClass}`.trim();
      return el;
    }
    const red = Deck.isRedSuit(card);
    el.className = `card ${red ? 'red' : ''} ${playable ? 'playable' : 'unplayable'} ${selected ? 'selected' : ''} ${extraClass}`.trim();
    const suitSymbol = { S: '♠', H: '♥', D: '♦', C: '♣' }[card.suit];
    el.innerHTML = `<span class="rank-tl">${card.rank}</span><span class="suit-mid">${suitSymbol}</span><span class="rank-br">${card.rank}</span>`;
    el.dataset.cardId = card.id;
    return el;
  }

  function renderCenter(state) {
    const deckCountEl = $('#deck-count');
    deckCountEl.textContent = state.deck.length;
    $('#deck-stack').innerHTML = state.deck.length > 0
      ? cardEl(null, { faceDown: true }).outerHTML
      : '<div class="pile-label" style="margin-top:34px">Empty</div>';

    const discardSlot = $('#discard-slot');
    discardSlot.innerHTML = '';
    const top = GameEngine.topDiscard(state);
    if (top) discardSlot.appendChild(cardEl(top));
    $('#pile-count').textContent = (state.discard || []).length;
    $('#seven-rule-note').style.display = state.sevenActive ? 'block' : 'none';
  }

  /**
   * Render my own hand + face-up + face-down zones, wiring click handlers.
   * `onCardClick(cardId)` fires when a card in the currently-active zone is
   * clicked; the caller (app.js) owns multi-select state.
   */
  function renderMyZones(state, myUid, selectedIds, onCardClick) {
    const zone = GameEngine.activeZone(state, myUid);
    const legalIds = new Set(GameEngine.legalCardIds(state, myUid));

    const handRow = $('#zone-hand');
    const faceUpRow = $('#zone-faceup');
    const faceDownRow = $('#zone-facedown');
    handRow.innerHTML = '';
    faceUpRow.innerHTML = '';
    faceDownRow.innerHTML = '';

    const myHand = state.hands[myUid];
    const myFaceUp = state.faceUp[myUid];
    const myFaceDown = state.faceDown[myUid];

    // If this uid has no entry at all in any zone, this browser's session
    // doesn't match a seat in this game (most commonly: the page was
    // reloaded and a fresh anonymous sign-in issued a different uid than
    // the one recorded when the game was dealt). Surface that clearly
    // instead of silently rendering three empty rows.
    if (!myHand && !myFaceUp && !myFaceDown) {
      const warn = document.createElement('div');
      warn.style.cssText = 'color:#c23b3b;font-size:0.85rem;text-align:center;padding:0.5rem;';
      warn.textContent = "Your session doesn't match a seat in this game — use Leave Game and rejoin with the same browser/tab you used to join originally.";
      handRow.appendChild(warn);
      return;
    }

    (myHand || []).forEach(c => {
      const isActive = zone === 'hands';
      const el = cardEl(c, {
        playable: isActive && legalIds.has(c.id),
        selected: selectedIds.includes(c.id),
        extraClass: 'deal-anim'
      });
      // Attach the click handler to every card in the active zone (not just
      // legal ones) so a click always gives feedback — app.js decides
      // whether the move is actually legal and toasts if not.
      if (isActive) el.addEventListener('click', () => onCardClick(c.id, 'hands'));
      handRow.appendChild(el);
    });

    (myFaceUp || []).forEach(c => {
      const isActive = zone === 'faceUp';
      const el = cardEl(c, {
        playable: isActive && legalIds.has(c.id),
        selected: selectedIds.includes(c.id)
      });
      if (isActive) el.addEventListener('click', () => onCardClick(c.id, 'faceUp'));
      faceUpRow.appendChild(el);
    });

    (myFaceDown || []).forEach(c => {
      const isActive = zone === 'faceDown';
      const el = cardEl(null, { faceDown: true, extraClass: isActive ? 'playable' : 'unplayable' });
      if (isActive) el.addEventListener('click', () => onCardClick(c.id, 'faceDown'));
      faceDownRow.appendChild(el);
    });
  }

  function renderTurnBanner(state, myUid, players) {
    const banner = $('#turn-banner');
    const current = GameEngine.currentPlayer(state);
    if (current === myUid) {
      banner.textContent = 'YOUR TURN';
      banner.classList.add('my-turn');
    } else {
      const name = players[current] ? players[current].name : '…';
      banner.textContent = `${name}'s turn`;
      banner.classList.remove('my-turn');
    }
  }

  let lastLogTs = 0;
  /** Show the most recent engine event ("Khan played 9♥") as a fading toast under the turn pill. */
  function renderPlayNotification(state) {
    const el = $('#play-notification');
    const log = state.log || [];
    if (log.length === 0) return;
    const last = log[log.length - 1];
    if (last.ts === lastLogTs) return; // already shown this one
    lastLogTs = last.ts;
    el.textContent = last.text;
    el.classList.add('visible');
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => el.classList.remove('visible'), 2800);
  }

  function renderEventLog(state) {
    const host = $('#event-log');
    if (!host) return; // replaced by play-notification pill in the redesigned layout
    host.innerHTML = '';
    (state.log || []).slice(-4).reverse().forEach(entry => {
      const d = document.createElement('div');
      d.textContent = entry.text;
      host.appendChild(d);
    });
  }

  function renderPickupButton(show) {
    $('#btn-pickup').style.display = show ? 'inline-block' : 'none';
  }

  function renderPlayButton(enabled) {
    $('#btn-play-selected').disabled = !enabled;
  }

  // ---------------- Chat ----------------
  function appendChatMessage(msg, myUid) {
    const log = $('#chat-log');
    const el = document.createElement('div');
    el.className = 'chat-msg' + (msg.uid === myUid ? ' me' : '');
    el.innerHTML = `<span class="who">${escapeHtml(msg.name || '???')}:</span>${escapeHtml(msg.text)}`;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  // ---------------- Voice ----------------
  function setVoiceStatus(text) {
    $('#voice-status').textContent = text;
  }

  function renderVoiceSpeakers(uids, players) {
    const host = $('#voice-speakers');
    host.innerHTML = '';
    uids.forEach(uid => {
      const p = players[uid];
      if (!p) return;
      const row = document.createElement('div');
      row.className = 'voice-speaker';
      row.innerHTML = `<span class="dot"></span> ${p.avatar} ${escapeHtml(p.name)}`;
      host.appendChild(row);
    });
  }

  // ---------------- Winner ----------------
  function renderWinner(winnerName, isMeWinner, loserName, isMeLoser, isHost) {
    $('#winner-title').textContent = isMeWinner ? 'You Win! 👑' : `${winnerName} Wins!`;
    let sub = isMeWinner
      ? 'You cleared your hand, face-up, and face-down cards first.'
      : `${winnerName} cleared their cards first.`;
    if (loserName) {
      sub += isMeLoser
        ? " You were the last one still holding cards."
        : ` ${loserName} was the last one still holding cards.`;
    }
    $('#winner-sub').textContent = sub;
    $('#btn-return-lobby').style.display = isHost ? 'inline-block' : 'none';
  }

  // ---------------- Floating emoji reactions ----------------
  function spawnReaction(emoji) {
    const layer = $('#reaction-layer');
    const el = document.createElement('div');
    el.className = 'floating-reaction';
    el.textContent = emoji;
    el.style.left = (44 + Math.random() * 12) + '%';
    layer.appendChild(el);
    setTimeout(() => el.remove(), 1900);
  }

  return {
    showScreen, toast, renderLobby, renderOpponents, renderCenter, renderMyZones,
    renderTurnBanner, renderPlayNotification, renderEventLog, renderPickupButton, renderPlayButton,
    appendChatMessage, setVoiceStatus, renderVoiceSpeakers, renderWinner, cardEl, spawnReaction
  };
})();

window.UI = UI;
