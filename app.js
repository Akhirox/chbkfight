// === ÉLÉMENTS DOM ===
const uiContainer = document.getElementById('ui-container');
const loginScreen = document.getElementById('login-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const gameContainer = document.getElementById('game-container');
const joinBtn = document.getElementById('join-btn');
const statusText = document.getElementById('connection-status');
const playersListDOM = document.getElementById('players-list');
const readyBtn = document.getElementById('ready-btn');
const startGameBtn = document.getElementById('start-game-btn');
const hostControls = document.getElementById('host-controls');

// === ÉTATS DU JEU ===
let peer;
let connections = []; // Utilisé par l'hôte pour stocker les clients
let hostConnection; // Utilisé par le client pour parler à l'hôte
let isHost = false;
let myId = '';
let players = {}; // { id: { name, color, isReady, body (Matter.js) } }

// Configurations
const MAX_PLAYERS = 5;

// === INITIALISATION RÉSEAU (PEERJS) ===
joinBtn.addEventListener('click', () => {
    const username = document.getElementById('username').value.trim() || "Anonyme";
    const roomID = document.getElementById('room-select').value;
    statusText.innerText = "Connexion...";

    // 1. Tenter de se connecter en tant qu'invité
    peer = new Peer(); 

    peer.on('open', (id) => {
        myId = id;
        hostConnection = peer.connect(roomID, { reliable: true });

        hostConnection.on('open', () => {
            // Succès : La room existe, on est invité
            isHost = false;
            setupLobby(roomID, username);
            hostConnection.send({ type: 'JOIN', id: myId, name: username, color: '#ff0000' });
            listenToHost();
        });

        // Si l'hôte n'existe pas, on attrape l'erreur et on devient hôte
        peer.on('error', (err) => {
            if (err.type === 'peer-unavailable') {
                peer.destroy(); // Détruire le peer temporaire
                initHost(roomID, username); // Créer le serveur avec l'ID de la room
            }
        });
    });
});

function initHost(roomID, username) {
    peer = new Peer(roomID); // On force l'ID de la room
    peer.on('open', (id) => {
        isHost = true;
        myId = id;
        players[myId] = { name: username, color: '#ff0000', isReady: false };
        setupLobby(roomID, username);
        hostControls.classList.remove('hidden');
        updateLobbyUI();

        // Écoute des invités
        peer.on('connection', (conn) => {
            if(Object.keys(players).length >= MAX_PLAYERS) {
                conn.send({ type: 'ERROR', msg: 'Room pleine (5 max)' });
                setTimeout(() => conn.close(), 500);
                return;
            }
            connections.push(conn);
            conn.on('data', (data) => handleDataFromGuest(conn.peer, data));
        });
    });
}

// === GESTION DU LOBBY ===
function setupLobby(roomID, username) {
    loginScreen.classList.add('hidden');
    lobbyScreen.classList.remove('hidden');
    document.getElementById('lobby-room-name').innerText = roomID;
    document.getElementById('player-role').innerText = isHost ? "Hôte" : "Invité";
}

function updateLobbyUI() {
    playersListDOM.innerHTML = '';
    let allReady = true;
    let playerCount = Object.keys(players).length;

    for (let id in players) {
        const p = players[id];
        const li = document.createElement('li');
        li.innerHTML = `<span class="color-box" style="background-color:${p.color}"></span> ${p.name} - ${p.isReady ? '✅ Prêt' : '❌ Attente'}`;
        playersListDOM.appendChild(li);
        if (!p.isReady) allReady = false;
    }

    if (isHost && playerCount > 1 && allReady) {
        startGameBtn.disabled = false;
    } else if (isHost) {
        startGameBtn.disabled = true;
    }
}

// Actions du joueur local
readyBtn.addEventListener('click', () => {
    players[myId].isReady = !players[myId].isReady;
    readyBtn.innerText = players[myId].isReady ? "Prêt" : "Pas Prêt";
    broadcast({ type: 'UPDATE_LOBBY', players: players });
    updateLobbyUI();
});

document.getElementById('player-color').addEventListener('change', (e) => {
    players[myId].color = e.target.value;
    broadcast({ type: 'UPDATE_LOBBY', players: players });
    updateLobbyUI();
});

// === SYNCHRONISATION DES DONNÉES ===
function broadcast(data) {
    if (isHost) {
        connections.forEach(conn => conn.send(data));
    } else if (hostConnection) {
        hostConnection.send(data);
    }
}

function handleDataFromGuest(peerId, data) {
    if (data.type === 'JOIN') {
        players[peerId] = { name: data.name, color: data.color, isReady: false };
        broadcast({ type: 'UPDATE_LOBBY', players: players });
        updateLobbyUI();
    } else if (data.type === 'UPDATE_LOBBY') {
        players[peerId] = data.players[peerId];
        broadcast({ type: 'UPDATE_LOBBY', players: players });
        updateLobbyUI();
    } else if (data.type === 'INPUT') {
        // Appliquer les inputs du joueur (ZQSD/Espace) à son body Matter.js
        applyInputs(peerId, data.keys);
    }
}

function listenToHost() {
    hostConnection.on('data', (data) => {
        if (data.type === 'UPDATE_LOBBY') {
            players = data.players;
            updateLobbyUI();
        } else if (data.type === 'START') {
            initGameEngine();
        } else if (data.type === 'SYNC_STATE') {
            // Mettre à jour l'affichage côté client depuis les calculs de l'hôte
            renderGameState(data.state);
        }
    });
}

// === MOTEUR PHYSIQUE ET JEU (MATTER.JS) ===
startGameBtn.addEventListener('click', () => {
    if (isHost) {
        broadcast({ type: 'START' });
        initGameEngine();
    }
});

let engine, render, world;
const KEYS = { w: false, a: false, s: false, d: false, space: false, ctrl: false };

function initGameEngine() {
    uiContainer.classList.add('hidden');
    gameContainer.classList.remove('hidden');

    const canvas = document.getElementById('game-canvas');
    const width = window.innerWidth;
    const height = window.innerHeight;

    // Seulement l'hôte fait tourner la physique
    if (isHost) {
        engine = Matter.Engine.create();
        world = engine.world;
        engine.gravity.y = 0.8; // Gravité légère mais réaliste

        // Création de la map (Sol/Lave et Plateformes)
        const ground = Matter.Bodies.rectangle(width / 2, height - 20, width, 40, { isStatic: true, label: 'LAVA' });
        const platform1 = Matter.Bodies.rectangle(width / 3, height - 200, 200, 20, { isStatic: true });
        const platform2 = Matter.Bodies.rectangle((width / 3) * 2, height - 300, 200, 20, { isStatic: true });
        
        Matter.Composite.add(world, [ground, platform1, platform2]);

        // Créer les joueurs
        let startX = 100;
        for (let id in players) {
            players[id].body = Matter.Bodies.rectangle(startX, 100, 40, 80, {
                restitution: 0, // Pas de rebond
                friction: 0.05,
                inertia: Infinity, // Empêche la rotation (Stickman reste droit)
                label: `PLAYER_${id}`
            });
            Matter.Composite.add(world, players[id].body);
            startX += 100;
        }

        // Boucle du serveur (Hôte) : Calcule la physique et envoie l'état
        setInterval(() => {
            Matter.Engine.update(engine, 1000 / 60);
            applyInputs(myId, KEYS); // Appliquer les inputs de l'hôte
            syncState(); // Envoyer aux clients
            // Ici, tu pourras ajouter la logique de spawn des objets qui tombent du plafond
        }, 1000 / 60);
    }

    // Gestion des inputs pour tous
    window.addEventListener('keydown', (e) => handleKey(e, true));
    window.addEventListener('keyup', (e) => handleKey(e, false));
    
    // Rendu local (Hôte et Invités dessinent via HTML5 Canvas)
    requestAnimationFrame(renderLoop);
}

function handleKey(e, isDown) {
    const key = e.key.toLowerCase();
    if (key === 'z' || key === 'arrowup') KEYS.w = isDown;
    if (key === 's' || key === 'arrowdown') KEYS.s = isDown;
    if (key === 'q' || key === 'arrowleft') KEYS.a = isDown;
    if (key === 'd' || key === 'arrowright') KEYS.d = isDown;
    if (key === ' ') KEYS.space = isDown;
    if (key === 'control') KEYS.ctrl = isDown;

    if (!isHost) {
        broadcast({ type: 'INPUT', keys: KEYS });
    }
}

// Fonction de l'Hôte pour appliquer la physique selon les touches
function applyInputs(id, keys) {
    const body = players[id]?.body;
    if (!body) return;

    const speed = 5;
    const jumpForce = 0.05;

    // Déplacement
    if (keys.a) Matter.Body.setVelocity(body, { x: -speed, y: body.velocity.y });
    if (keys.d) Matter.Body.setVelocity(body, { x: speed, y: body.velocity.y });
    
    // Glissade (Ctrl + Direction)
    if (keys.ctrl && keys.a) Matter.Body.setVelocity(body, { x: -speed * 1.5, y: body.velocity.y });
    if (keys.ctrl && keys.d) Matter.Body.setVelocity(body, { x: speed * 1.5, y: body.velocity.y });

    // Saut
    // (Dans un jeu complet, vérifier que la vélocité Y est ~0 pour éviter le double saut)
    if (keys.space && Math.abs(body.velocity.y) < 0.5) {
        Matter.Body.applyForce(body, body.position, { x: 0, y: -jumpForce });
    }
}

// L'Hôte compile l'état de la map et l'envoie
function syncState() {
    let state = { p: {} };
    for (let id in players) {
        state.p[id] = {
            x: players[id].body.position.x,
            y: players[id].body.position.y,
            c: players[id].color
        };
    }
    broadcast({ type: 'SYNC_STATE', state: state });
    renderGameState(state); // L'hôte se met à jour lui-même visuellement
}

// L'état visuel du jeu (dessiné sur le Canvas par tout le monde)
let currentState = null;
function renderGameState(state) {
    currentState = state;
}

function renderLoop() {
    const canvas = document.getElementById('game-canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Dessin du décor statique (hardcodé pour la démo, à synchroniser si dynamique)
    ctx.fillStyle = '#ff4444'; // Lave
    ctx.fillRect(0, canvas.height - 40, canvas.width, 40);
    
    ctx.fillStyle = '#888'; // Plateformes
    ctx.fillRect(canvas.width / 3 - 100, canvas.height - 210, 200, 20);
    ctx.fillRect((canvas.width / 3) * 2 - 100, canvas.height - 310, 200, 20);

    // Dessin des joueurs
    if (currentState && currentState.p) {
        for (let id in currentState.p) {
            const p = currentState.p[id];
            ctx.fillStyle = p.c;
            // On dessine le body (40x80) centré sur sa position X/Y
            ctx.fillRect(p.x - 20, p.y - 40, 40, 80); 
        }
    }

    requestAnimationFrame(renderLoop);
}