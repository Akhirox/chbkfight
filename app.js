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
let players = {}; // { id: { name, color, isReady, ragdoll: { composite, mainBody... } } }

// Configurations
const MAX_PLAYERS = 5;

// === INITIALISATION RÉSEAU (PEERJS) ===
joinBtn.addEventListener('click', () => {
    const username = document.getElementById('username').value.trim() || "Anonyme";
    const roomID = document.getElementById('room-select').value;
    statusText.innerText = "Connexion...";

    peer = new Peer(); 

    peer.on('open', (id) => {
        myId = id;
        hostConnection = peer.connect(roomID, { reliable: true });

        hostConnection.on('open', () => {
            isHost = false;
            setupLobby(roomID, username);
            hostConnection.send({ type: 'JOIN', id: myId, name: username, color: '#ff0000' });
            listenToHost();
        });

        peer.on('error', (err) => {
            if (err.type === 'peer-unavailable') {
                peer.destroy(); 
                initHost(roomID, username); 
            }
        });
    });
});

function initHost(roomID, username) {
    peer = new Peer(roomID); 
    peer.on('open', (id) => {
        isHost = true;
        myId = id;
        players[myId] = { name: username, color: '#ff0000', isReady: false };
        setupLobby(roomID, username);
        hostControls.classList.remove('hidden');
        updateLobbyUI();

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
        players[peerId].isReady = data.players[peerId].isReady;
        players[peerId].color = data.players[peerId].color;
        broadcast({ type: 'UPDATE_LOBBY', players: players });
        updateLobbyUI();
    } else if (data.type === 'INPUT') {
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

    if (isHost) {
        engine = Matter.Engine.create();
        world = engine.world;
        engine.gravity.y = 1.2; // Gravité un peu plus forte pour le ragdoll

        // 1. La grande plateforme centrale (80% de la largeur)
        const platformWidth = width * 0.8;
        const mainPlatform = Matter.Bodies.rectangle(width / 2, height - 150, platformWidth, 40, { 
            isStatic: true, 
            friction: 0.8,
            label: 'GROUND' 
        });

        // 2. La Lave (Sensor qui couvre tout le bas)
        const lava = Matter.Bodies.rectangle(width / 2, height - 20, width * 2, 100, { 
            isStatic: true, 
            isSensor: true, // Ne bloque pas physiquement, mais déclenche les collisions
            label: 'LAVA' 
        });

        Matter.Composite.add(world, [mainPlatform, lava]);

        // Créer les joueurs (Ragdolls)
        let startX = width / 2 - ((Object.keys(players).length * 80) / 2);
        for (let id in players) {
            players[id].ragdoll = createRagdoll(startX, height - 300, id);
            Matter.Composite.add(world, players[id].ragdoll.composite);
            startX += 80;
        }

        // Gestion des morts dans la lave
        Matter.Events.on(engine, 'collisionStart', (event) => {
            event.pairs.forEach((pair) => {
                if (pair.bodyA.label === 'LAVA' || pair.bodyB.label === 'LAVA') {
                    const victim = pair.bodyA.label === 'LAVA' ? pair.bodyB : pair.bodyA;
                    if (victim.label.startsWith('PLAYER_') || victim.label.startsWith('HEAD_')) {
                        const playerId = victim.label.split('_')[1];
                        respawnPlayer(playerId);
                    }
                }
            });
        });

        // Boucle Serveur
        setInterval(() => {
            Matter.Engine.update(engine, 1000 / 60);
            applyInputs(myId, KEYS); 
            syncState(); 
        }, 1000 / 60);
    }

    window.addEventListener('keydown', (e) => handleKey(e, true));
    window.addEventListener('keyup', (e) => handleKey(e, false));
    
    requestAnimationFrame(renderLoop);
}

// Construction du Ragdoll
function createRagdoll(x, y, id) {
    const group = Matter.Body.nextGroup(true); // Empêche les membres du même joueur de se percuter
    const opt = { friction: 0.8, restitution: 0.1, collisionFilter: { group: group }, label: `PLAYER_${id}` };
    const headOpt = { friction: 0.5, restitution: 0.4, collisionFilter: { group: group }, label: `HEAD_${id}` };

    const head = Matter.Bodies.circle(x, y - 40, 18, headOpt);
    const torso = Matter.Bodies.rectangle(x, y, 15, 45, opt);
    const leftArm = Matter.Bodies.rectangle(x - 15, y - 10, 8, 30, opt);
    const rightArm = Matter.Bodies.rectangle(x + 15, y - 10, 8, 30, opt);
    const leftLeg = Matter.Bodies.rectangle(x - 8, y + 35, 10, 35, opt);
    const rightLeg = Matter.Bodies.rectangle(x + 8, y + 35, 10, 35, opt);

    // Articulations
    const constraints = [
        Matter.Constraint.create({ bodyA: head, bodyB: torso, pointA: { x: 0, y: 18 }, pointB: { x: 0, y: -22 }, stiffness: 0.8, length: 0 }),
        Matter.Constraint.create({ bodyA: torso, bodyB: leftArm, pointA: { x: -10, y: -15 }, pointB: { x: 0, y: -10 }, stiffness: 0.6, length: 0 }),
        Matter.Constraint.create({ bodyA: torso, bodyB: rightArm, pointA: { x: 10, y: -15 }, pointB: { x: 0, y: -10 }, stiffness: 0.6, length: 0 }),
        Matter.Constraint.create({ bodyA: torso, bodyB: leftLeg, pointA: { x: -7, y: 22 }, pointB: { x: 0, y: -15 }, stiffness: 0.8, length: 0 }),
        Matter.Constraint.create({ bodyA: torso, bodyB: rightLeg, pointA: { x: 7, y: 22 }, pointB: { x: 0, y: -15 }, stiffness: 0.8, length: 0 })
    ];

    const composite = Matter.Composite.create();
    Matter.Composite.add(composite, [head, torso, leftArm, rightArm, leftLeg, rightLeg, ...constraints]);
    
    // Garder le torse droit pour ne pas qu'il tombe comme une crêpe
    Matter.Events.on(engine, 'beforeUpdate', () => {
        // Force le torse à rester vertical
        Matter.Body.setAngle(torso, torso.angle * 0.8);
    });

    return { composite, mainBody: torso, head, leftArm, rightArm, leftLeg, rightLeg };
}

function handleKey(e, isDown) {
    const key = e.key.toLowerCase();
    if (key === 'z' || key === 'arrowup') KEYS.w = isDown;
    if (key === 's' || key === 'arrowdown') KEYS.s = isDown;
    if (key === 'q' || key === 'arrowleft') KEYS.a = isDown;
    if (key === 'd' || key === 'arrowright') KEYS.d = isDown;
    if (key === ' ') KEYS.space = isDown;
    if (key === 'control') KEYS.ctrl = isDown;

    if (!isHost) broadcast({ type: 'INPUT', keys: KEYS });
}

function applyInputs(id, keys) {
    const ragdoll = players[id]?.ragdoll;
    if (!ragdoll) return;
    const body = ragdoll.mainBody;
    const force = 0.005;

    // Déplacement : Appliquer une force latérale
    if (keys.a) Matter.Body.applyForce(body, body.position, { x: -force, y: 0 });
    if (keys.d) Matter.Body.applyForce(body, body.position, { x: force, y: 0 });
    
    // Saut : Appliquer une force vers le haut si on ne tombe pas trop vite
    if (keys.space && Math.abs(body.velocity.y) < 1) {
        Matter.Body.applyForce(body, body.position, { x: 0, y: -0.05 });
    }
}

function respawnPlayer(id) {
    const ragdoll = players[id].ragdoll;
    if (!ragdoll) return;

    // Réinitialiser la vélocité de tous les membres
    ragdoll.composite.bodies.forEach(b => {
        Matter.Body.setVelocity(b, { x: 0, y: 0 });
        Matter.Body.setAngularVelocity(b, 0);
    });

    // Déplacer l'ensemble du composite vers le point de spawn
    const spawnX = window.innerWidth / 2;
    const spawnY = window.innerHeight - 300;
    const offsetX = spawnX - ragdoll.mainBody.position.x;
    const offsetY = spawnY - ragdoll.mainBody.position.y;
    
    Matter.Composite.translate(ragdoll.composite, { x: offsetX, y: offsetY });
}

// L'Hôte extrait les positions de tous les membres pour les envoyer
function syncState() {
    let state = { p: {} };
    for (let id in players) {
        const r = players[id].ragdoll;
        state.p[id] = {
            c: players[id].color,
            h: { x: r.head.position.x, y: r.head.position.y, a: r.head.angle, w: 18, r: true }, // r = isRound
            t: { x: r.mainBody.position.x, y: r.mainBody.position.y, a: r.mainBody.angle, w: 15, h: 45 },
            la: { x: r.leftArm.position.x, y: r.leftArm.position.y, a: r.leftArm.angle, w: 8, h: 30 },
            ra: { x: r.rightArm.position.x, y: r.rightArm.position.y, a: r.rightArm.angle, w: 8, h: 30 },
            ll: { x: r.leftLeg.position.x, y: r.leftLeg.position.y, a: r.leftLeg.angle, w: 10, h: 35 },
            rl: { x: r.rightLeg.position.x, y: r.rightLeg.position.y, a: r.rightLeg.angle, w: 10, h: 35 }
        };
    }
    broadcast({ type: 'SYNC_STATE', state: state });
    renderGameState(state); 
}

// === RENDU GRAPHIQUE (CANVAS) ===
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

    // Décor
    ctx.fillStyle = '#ff4444'; // Lave
    ctx.fillRect(0, canvas.height - 70, canvas.width, 100);
    
    ctx.fillStyle = '#888'; // Plateforme Centrale
    ctx.fillRect(canvas.width * 0.1, canvas.height - 170, canvas.width * 0.8, 40);

    // Joueurs
    if (currentState && currentState.p) {
        for (let id in currentState.p) {
            const p = currentState.p[id];
            ctx.fillStyle = p.c; // Couleur du joueur

            // Dessiner chaque membre
            drawPart(ctx, p.t);  // Torse
            drawPart(ctx, p.la); // Bras Gauche
            drawPart(ctx, p.ra); // Bras Droit
            drawPart(ctx, p.ll); // Jambe Gauche
            drawPart(ctx, p.rl); // Jambe Droite
            drawPart(ctx, p.h);  // Tête
        }
    }

    requestAnimationFrame(renderLoop);
}

// Fonction utilitaire pour dessiner un rectangle ou un cercle pivoté
function drawPart(ctx, part) {
    ctx.save();
    ctx.translate(part.x, part.y);
    ctx.rotate(part.a);
    if (part.r) {
        // C'est la tête (cercle)
        ctx.beginPath();
        ctx.arc(0, 0, part.w, 0, 2 * Math.PI);
        ctx.fill();
    } else {
        // C'est un membre (rectangle)
        ctx.fillRect(-part.w / 2, -part.h / 2, part.w, part.h);
    }
    ctx.restore();
}