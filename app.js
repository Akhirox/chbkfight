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

// === CONFIGURATION DU JEU ===
const MAX_PLAYERS = 5;
const V_WIDTH = 1600;  // Résolution virtuelle (Largeur)
const V_HEIGHT = 900;  // Résolution virtuelle (Hauteur)

// === ÉTATS DU JEU ===
let peer;
let connections = []; 
let hostConnection; 
let isHost = false;
let myId = '';
let players = {}; 
let currentState = null; // L'état global du jeu reçu par tous
const KEYS = { w: false, a: false, s: false, d: false, space: false, ctrl: false };

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
        players[myId] = { name: username, color: '#ff0000', isReady: false, inputs: { ...KEYS } };
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

    if (isHost) {
        startGameBtn.disabled = !(playerCount > 1 && allReady);
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
        players[peerId] = { name: data.name, color: data.color, isReady: false, inputs: { ...KEYS } };
        broadcast({ type: 'UPDATE_LOBBY', players: players });
        updateLobbyUI();
    } else if (data.type === 'UPDATE_LOBBY') {
        players[peerId].isReady = data.players[peerId].isReady;
        players[peerId].color = data.players[peerId].color;
        broadcast({ type: 'UPDATE_LOBBY', players: players });
        updateLobbyUI();
    } else if (data.type === 'INPUT') {
        players[peerId].inputs = data.keys; // Stocker les inputs de l'invité
    }
}

function listenToHost() {
    hostConnection.on('data', (data) => {
        if (data.type === 'UPDATE_LOBBY') {
            players = data.players;
            updateLobbyUI();
        } else if (data.type === 'START') {
            initGameEngine(); // Lancer le moteur visuel côté invité
        } else if (data.type === 'SYNC_STATE') {
            currentState = data.state; // Mettre à jour l'état visuel
        }
    });
}

// === MOTEUR PHYSIQUE ET JEU (MATTER.JS - HÔTE SEULEMENT) ===
startGameBtn.addEventListener('click', () => {
    if (isHost) {
        broadcast({ type: 'START' });
        initGameEngine();
    }
});

let engine, world;

function initGameEngine() {
    uiContainer.classList.add('hidden');
    gameContainer.classList.remove('hidden');

    if (isHost) {
        engine = Matter.Engine.create();
        world = engine.world;
        engine.gravity.y = 1.2; 

        // 1. La grande plateforme centrale
        const platformWidth = V_WIDTH * 0.7; // 70% de la largeur
        const mainPlatform = Matter.Bodies.rectangle(V_WIDTH / 2, V_HEIGHT - 100, platformWidth, 40, { 
            isStatic: true, 
            friction: 0.8,
            label: 'GROUND' 
        });

        // 2. La Lave (Sensor en bas couvrant toute la largeur)
        const lava = Matter.Bodies.rectangle(V_WIDTH / 2, V_HEIGHT - 20, V_WIDTH, 100, { 
            isStatic: true, 
            isSensor: true, 
            label: 'LAVA' 
        });

        Matter.Composite.add(world, [mainPlatform, lava]);

        // Créer les joueurs (Ragdolls)
        let startX = (V_WIDTH / 2) - ((Object.keys(players).length * 100) / 2);
        for (let id in players) {
            players[id].ragdoll = createRagdoll(startX, V_HEIGHT - 300, id);
            Matter.Composite.add(world, players[id].ragdoll.composite);
            startX += 100;
        }

        // Gestion des collisions mortelles (Lave)
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

        // Main Loop du Serveur
        setInterval(() => {
            Matter.Engine.update(engine, 1000 / 60);
            
            // Appliquer les inputs pour chaque joueur
            for (let id in players) {
                const pKeys = (id === myId) ? KEYS : players[id].inputs;
                applyInputs(id, pKeys); 
            }
            
            syncState(); 
        }, 1000 / 60);
    }

    // Gestion des touches pour tous
    window.addEventListener('keydown', (e) => handleKey(e, true));
    window.addEventListener('keyup', (e) => handleKey(e, false));
    
    // Démarrer la boucle d'affichage
    requestAnimationFrame(renderLoop);
}

// Construction du Ragdoll
function createRagdoll(x, y, id) {
    const group = Matter.Body.nextGroup(true); 
    const opt = { friction: 0.8, restitution: 0.1, collisionFilter: { group: group }, label: `PLAYER_${id}` };
    const headOpt = { friction: 0.5, restitution: 0.4, collisionFilter: { group: group }, label: `HEAD_${id}` };

    const head = Matter.Bodies.circle(x, y - 40, 20, headOpt);
    const torso = Matter.Bodies.rectangle(x, y, 15, 50, opt);
    const leftArm = Matter.Bodies.rectangle(x - 15, y - 10, 8, 30, opt);
    const rightArm = Matter.Bodies.rectangle(x + 15, y - 10, 8, 30, opt);
    const leftLeg = Matter.Bodies.rectangle(x - 8, y + 35, 10, 35, opt);
    const rightLeg = Matter.Bodies.rectangle(x + 8, y + 35, 10, 35, opt);

    const constraints = [
        Matter.Constraint.create({ bodyA: head, bodyB: torso, pointA: { x: 0, y: 20 }, pointB: { x: 0, y: -25 }, stiffness: 0.8, length: 0 }),
        Matter.Constraint.create({ bodyA: torso, bodyB: leftArm, pointA: { x: -10, y: -20 }, pointB: { x: 0, y: -10 }, stiffness: 0.6, length: 0 }),
        Matter.Constraint.create({ bodyA: torso, bodyB: rightArm, pointA: { x: 10, y: -20 }, pointB: { x: 0, y: -10 }, stiffness: 0.6, length: 0 }),
        Matter.Constraint.create({ bodyA: torso, bodyB: leftLeg, pointA: { x: -7, y: 25 }, pointB: { x: 0, y: -15 }, stiffness: 0.8, length: 0 }),
        Matter.Constraint.create({ bodyA: torso, bodyB: rightLeg, pointA: { x: 7, y: 25 }, pointB: { x: 0, y: -15 }, stiffness: 0.8, length: 0 })
    ];

    const composite = Matter.Composite.create();
    Matter.Composite.add(composite, [head, torso, leftArm, rightArm, leftLeg, rightLeg, ...constraints]);
    
    // Maintenir le joueur droit
    Matter.Events.on(engine, 'beforeUpdate', () => {
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
    const moveForce = 0.008;

    // Déplacement global (Torse)
    if (keys.a) Matter.Body.applyForce(body, body.position, { x: -moveForce, y: 0 });
    if (keys.d) Matter.Body.applyForce(body, body.position, { x: moveForce, y: 0 });
    
    // Animation procédurale de course (Mouvement des jambes)
    if (keys.a || keys.d) {
        const time = Date.now() * 0.015; // Fréquence de course
        const legForce = 0.003;
        
        // Pousser les jambes en opposition avec un sinus
        Matter.Body.applyForce(ragdoll.leftLeg, ragdoll.leftLeg.position, { 
            x: Math.sin(time) * legForce, y: 0 
        });
        Matter.Body.applyForce(ragdoll.rightLeg, ragdoll.rightLeg.position, { 
            x: -Math.sin(time) * legForce, y: 0 
        });
    }

    // Saut
    if (keys.space && Math.abs(body.velocity.y) < 1) {
        Matter.Body.applyForce(body, body.position, { x: 0, y: -0.06 });
    }
}

function respawnPlayer(id) {
    const ragdoll = players[id].ragdoll;
    if (!ragdoll) return;

    ragdoll.composite.bodies.forEach(b => {
        Matter.Body.setVelocity(b, { x: 0, y: 0 });
        Matter.Body.setAngularVelocity(b, 0);
    });

    const offsetX = (V_WIDTH / 2) - ragdoll.mainBody.position.x;
    const offsetY = (V_HEIGHT - 400) - ragdoll.mainBody.position.y;
    
    Matter.Composite.translate(ragdoll.composite, { x: offsetX, y: offsetY });
}

// Compilateur d'état de l'Hôte
function syncState() {
    let state = { p: {} };
    for (let id in players) {
        const r = players[id].ragdoll;
        if(r) {
            state.p[id] = {
                c: players[id].color,
                h: { x: r.head.position.x, y: r.head.position.y, a: r.head.angle, w: 20, r: true }, 
                t: { x: r.mainBody.position.x, y: r.mainBody.position.y, a: r.mainBody.angle, w: 15, h: 50 },
                la: { x: r.leftArm.position.x, y: r.leftArm.position.y, a: r.leftArm.angle, w: 8, h: 30 },
                ra: { x: r.rightArm.position.x, y: r.rightArm.position.y, a: r.rightArm.angle, w: 8, h: 30 },
                ll: { x: r.leftLeg.position.x, y: r.leftLeg.position.y, a: r.leftLeg.angle, w: 10, h: 35 },
                rl: { x: r.rightLeg.position.x, y: r.rightLeg.position.y, a: r.rightLeg.angle, w: 10, h: 35 }
            };
        }
    }
    broadcast({ type: 'SYNC_STATE', state: state });
    currentState = state; // L'Hôte se met à jour lui-même
}

// === RENDU GRAPHIQUE (CANVAS - COMMUN À TOUS) ===
function renderLoop() {
    const canvas = document.getElementById('game-canvas');
    const ctx = canvas.getContext('2d');
    
    // Adaptation à la taille de l'écran en conservant le ratio
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const scale = Math.min(canvas.width / V_WIDTH, canvas.height / V_HEIGHT);
    const offsetX = (canvas.width - (V_WIDTH * scale)) / 2;
    const offsetY = (canvas.height - (V_HEIGHT * scale)) / 2;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale); 

    // Dessin du décor (Utilisation des coordonnées virtuelles V_WIDTH / V_HEIGHT)
    ctx.fillStyle = '#ff4444'; // Lave
    ctx.fillRect(0, V_HEIGHT - 70, V_WIDTH, 100);
    
    ctx.fillStyle = '#888'; // Plateforme
    ctx.fillRect(V_WIDTH * 0.15, V_HEIGHT - 120, V_WIDTH * 0.7, 40);

    // Dessin des joueurs
    if (currentState && currentState.p) {
        for (let id in currentState.p) {
            const p = currentState.p[id];
            if (!p || !p.t) continue; // Sécurité si le chargement n'est pas complet

            ctx.fillStyle = p.c; 

            drawPart(ctx, p.t);  
            drawPart(ctx, p.la); 
            drawPart(ctx, p.ra); 
            drawPart(ctx, p.ll); 
            drawPart(ctx, p.rl); 
            drawPart(ctx, p.h);  
        }
    }

    ctx.restore();
    requestAnimationFrame(renderLoop);
}

function drawPart(ctx, part) {
    if(!part) return;
    ctx.save();
    ctx.translate(part.x, part.y);
    ctx.rotate(part.a);
    if (part.r) {
        ctx.beginPath();
        ctx.arc(0, 0, part.w, 0, 2 * Math.PI);
        ctx.fill();
    } else {
        ctx.fillRect(-part.w / 2, -part.h / 2, part.w, part.h);
    }
    ctx.restore();
}