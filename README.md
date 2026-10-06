# Palace — Online Multiplayer Card Room (2–8 Players)

Ek complete, deployable multiplayer Palace/Shithead-style card game:
room system, lobby, real-time synced gameplay (Firebase Realtime Database),
text chat, aur peer-to-peer WebRTC voice chat — sab kuch is folder mein.

## Files

```
palace-game/
  index.html              screens: name -> home -> lobby -> game -> winner
  css/style.css            visual design (card-room theme)
  js/firebase-config.js    <-- YOU MUST EDIT THIS with your own Firebase project
  js/deck.js                52-card deck, ranks, comparisons
  js/game-engine.js         pure Palace rules (dealing, turns, 2/7/10/J, win)
  js/room.js                room create/join, lobby, presence, host transfer
  js/chat.js                text chat over Firebase
  js/voice.js               mesh WebRTC voice chat (Firebase = signaling only)
  js/game-controller.js     Firebase transactions <-> game-engine bridge
  js/ui.js                  DOM rendering
  js/app.js                 screen navigation + event wiring
  database.rules.json       Firebase Realtime Database security rules
```

## 1. Setup (takes ~5 minutes) — REQUIRED before this runs

Firebase ke bina yeh sirf ek static UI hai — koi multiplayer sync nahi hogi.
Apna khud ka **free** Firebase project banayein:

1. https://console.firebase.google.com → **Add project**.
2. Left sidebar → **Build → Realtime Database → Create Database**. Region
   choose karein, "Start in test mode" (baad mein rules deploy karenge).
3. Left sidebar → **Build → Authentication → Sign-in method → Anonymous → Enable**.
   (Har player ek anonymous UID leta hai, koi email/password nahi chahiye.)
4. Project Settings (gear icon) → General → "Your apps" → **Add app → Web (`</>`)**.
   Register app, aur jo `firebaseConfig` object milega usse copy karein.
5. `js/firebase-config.js` kholein aur `firebaseConfig` object ki values
   apni copy ki hui values se replace karein.
6. Realtime Database → Rules tab → is repo ke `database.rules.json` ka
   content paste karke **Publish** karein (isse random log rooms/game data
   likhne se protect hota hai — sirf authenticated users read/write kar sakte hain).

## 2. Run locally

Ye plain static files hain (no build step). Koi bhi static server chalega:

```bash
cd palace-game
python3 -m http.server 8080
# phir browser mein: http://localhost:8080
```

## 3. Deploy so friends can open a link (Firebase Hosting — free)

```bash
npm install -g firebase-tools
firebase login
cd palace-game
firebase init hosting     # public directory: "." , single-page app: No
firebase deploy
```

Deploy hone ke baad Firebase ek URL dega (e.g. `https://your-project.web.app`)
— wahi link dosto ke saath share karein. Wo apna naam likhen, "Create Room"
dabayen, room code milega, aur baaki log "Join Room" mein wo code dal kar
lobby mein aa jayenge.

## 4. How the game works (Palace rules implemented)

- Har player ko 3 hand cards + 3 face-up + 3 face-down milte hain.
- Normal play: card ka rank current pile ke top card se **same ya higher**
  hona chahiye.
- **2** = wild — kabhi bhi khel sakte ho, requirement reset kar deta hai.
- **7** = agla player sirf 7 ya usse chota card khel sakta hai (ya 2/10).
- **10** = pile burn/clear ho jati hai, wahi player dobara khelta hai.
- **J** = direction reverse — dynamically kaam karta hai chahe 2 players hon
  ya 8, kyunki turn order ek array hai, fixed math nahi.
- Same-rank cards ek saath multiple khel sakte ho (select multiple, phir
  "Play Selected").
- Jab hand khatam ho jaye (aur deck se refill na ho sake), face-up se
  khelna shuru hota hai, phir face-down se **blind** (agar galat nikla to
  poori pile utha ke hand mein aa jati hai).
- Sabse pehle jo apne teeno zones (hand + face-up + face-down) khali kare,
  wahi **winner** hai aur game khatam.

### Note on deck size for 6–8 players

Standard Palace deal (3+3+3 = 9 cards/player) sirf ek 52-card pack se
maximum 5 players ke liye kaafi hai (45 cards). 6–8 players ke liye engine
automatically **do standard decks combine** kar deta hai (jaise real
card-rooms mein bade table pe karte hain) — is se bina koi rule tootay
har player count (2–8) pe deal ho jata hai. Yeh `game-engine.js` mein
comment ke sath likha hai.

## 5. Chat & Voice

- **Chat** tab: normal text messages, Firebase RTDB ke through instantly
  sync hote hain, room-scoped.
- **Voice** tab: "Join Voice" dabane par mic permission mangi jayegi, phir
  sab connected players ke sath direct peer-to-peer audio connect ho jata
  hai (WebRTC mesh — Firebase sirf connection set-up karne ke liye istemal
  hota hai, actual awaaz kabhi Firebase se nahi guzarti). Mute/Leave Voice
  buttons available hain.

## 6. Disconnect & host transfer

- Agar koi player disconnect ho jaye, unka status "Disconnected" dikhta hai,
  game corrupt nahi hoti — wo same room code se wapas join kar sakte hain
  (session `localStorage` mein saved rehta hai).
- Agar **host** disconnect ho jaye, sabse pehle-joined connected player
  automatically naya host ban jata hai.

## 7. Testing done

Is environment mein live Firebase project connect nahi ho sakta (network
sandboxed hai), isliye maine **game-engine.js** (jo saari core rules rakhta
hai) ko Node.js mein directly load karke automated tests chalaye:

- ✅ Dealing sahi hua 2, 3, 4, 5, 6, 7, aur 8 players ke liye (card counts match).
- ✅ 6–8 players ke liye dusra deck automatically add hua.
- ✅ Turn order + **J reverse** correctly kaam kiya har player count (2–8) ke
  liye — dynamic array-based logic, hardcoded nahi.
- ✅ 2 (wild), 7 (rule), 10 (burn + same player again) sahi behave hue.
- ✅ Out-of-turn play reject hui.
- ✅ Winner detection sahi hui (saare zones khali hone par).

Firebase-specific parts (room creation, presence, host transfer, live
sync, WebRTC signaling) code-reviewed hain aur standard, well-tested
patterns follow karte hain, lekin **live multi-browser test aapko khud
apne Firebase project ke sath karni hogi** (2 tabs ya 2 devices se) —
main yahan se live Firebase se connect nahi kar sakta.

## 8. If something doesn't connect

- Blank lobby / "permission denied" errors → check `js/firebase-config.js`
  values aur Realtime Database rules publish hui hain ya nahi.
- Voice connect nahi ho raha → dono users ko mic permission allow karni
  hogi; kuch corporate/college networks WebRTC UDP block karte hain, wahan
  TURN server chahiye hoga (STUN se strict NAT ke peeche connect nahi hoga).
- 6+ player games mein agar deck khatam ho jaye, engine dusra deck already
  deal ke waqt add kar deta hai, koi extra step nahi chahiye.
