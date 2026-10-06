const firebaseConfig = {
  apiKey: "AIzaSyAi1Ad_cUgxYq0G7mcZJnUuS8TnM3EFTO0",
  authDomain: "palace-card-game-f6c53.firebaseapp.com",
  databaseURL: "https://palace-card-game-f6c53-default-rtdb.firebaseio.com",
  projectId: "palace-card-game-f6c53",
  storageBucket: "palace-card-game-f6c53.firebasestorage.app",
  messagingSenderId: "471559769407",
  appId: "1:471559769407:web:e85702cf47704def09d78a"
};

firebase.initializeApp(firebaseConfig);

window.db = firebase.database();
window.auth = firebase.auth();