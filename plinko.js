// ─── RAW MULTIPLIER SHAPES (unscaled — defines risk profile only) ─────────────
// These get auto-scaled so EV = 0.99 (1% house edge)
const RAW_MULTIPLIERS = {
    8: {
        low:   [5.0, 2.5, 1.5, 1.1, 1.0, 1.1, 1.5, 2.5, 5.0],
        med:   [10,  4,   2,   1.2, 0.5, 1.2, 2,   4,   10],
        high:  [20,  8,   3,   1.2, 0.2, 1.2, 3,   8,   20],
    },
    12: {
        low:   [8.0, 3.5, 1.8, 1.3, 1.1, 1.0, 1.0, 1.0, 1.1, 1.3, 1.8, 3.5, 8.0],
        med:   [15,  6,   2.5, 1.3, 1.0, 0.7, 0.5, 0.7, 1.0, 1.3, 2.5, 6,   15],
        high:  [40,  15,  5,   2,   1,   0.5, 0.3, 0.5, 1,   2,   5,   15,  40],
    },
    16: {
        low:   [12,  5,   2.5, 1.5, 1.2, 1.1, 1.0, 1.0, 1.0, 1.0, 1.0, 1.1, 1.2, 1.5, 2.5, 5,   12],
        med:   [25,  8,   3,   1.5, 1.2, 1.0, 0.8, 0.5, 0.5, 0.5, 0.8, 1.0, 1.2, 1.5, 3,   8,   25],
        high:  [100, 25,  8,   3,   1.5, 1.0, 0.5, 0.3, 0.3, 0.3, 0.5, 1.0, 1.5, 3,   8,   25,  100],
    },
};

// ─── BINOMIAL COEFFICIENTS ─────────────────────────────────────────────────────
// Pre-computed C(n,k) for n = 8, 12, 16
const BINOM = {
    8:  [1, 8, 28, 56, 70, 56, 28, 8, 1],
    12: [1, 12, 66, 220, 495, 792, 924, 792, 495, 220, 66, 12, 1],
    16: [1, 16, 120, 560, 1820, 4368, 8008, 11440, 12870, 11440, 8008, 4368, 1820, 560, 120, 16, 1],
};

// ─── SCALED MULTIPLIERS (lazy-computed per session) ───────────────────────────
let scaledMultipliers = {};

function getMultipliers(rows, risk) {
    const key = rows + '_' + risk;
    if (scaledMultipliers[key]) return scaledMultipliers[key];

    const raw = RAW_MULTIPLIERS[rows][risk];
    const coeff = BINOM[rows];
    const total = Math.pow(2, rows);

    // Calculate current EV = Σ P(k) × raw[k], where P(k) = C(rows,k) / 2^rows
    let ev = 0;
    for (let i = 0; i < raw.length; i++) {
        ev += (coeff[i] / total) * raw[i];
    }

    // Scale so EV = 0.99 (1% house edge → 99% RTP)
    const scale = 0.99 / ev;
    const scaled = raw.map(m => Math.round(m * scale * 100) / 100);
    scaledMultipliers[key] = scaled;
    return scaled;
}

// ─── STATE ─────────────────────────────────────────────────────────────────────
let plinko = {
    canvas: null,
    ctx: null,
    rows: 16,
    risk: 'low',
    bet: 10,
    pegs: [],
    slots: [],
    balls: [],        // each: { path, progress, duration, slotIndex, mult, win, done, startTime }
    slotHighlights: [],
    animId: null,
    lastTime: 0,
    initialized: false
};

const p$ = id => document.getElementById(id);
const plinkoBet = p$('plinkoBet');
const dropBtn = p$('dropBtn');
const plinkoResult = p$('plinkoResult');
const plinkoWin = p$('plinkoWin');
const plinkoMult = p$('plinkoMult');
const slotRow = p$('slotRow');

// ─── PEG / SLOT LAYOUT ────────────────────────────────────────────────────────

function layoutBoard() {
    const W = plinko.canvas.width;
    const H = plinko.canvas.height;
    const R = plinko.rows;
    const topPad = 35;
    const bottomPad = 55;
    const sidePad = W * 0.07;
    const usableW = W - 2 * sidePad;
    const hSpacing = usableW / (R + 1);
    const vSpacing = (H - topPad - bottomPad) / R;

    plinko.hSpacing = hSpacing;
    plinko.vSpacing = vSpacing;
    plinko.topPad = topPad;
    plinko.sidePad = sidePad;
    plinko.centerX = W / 2;

    // Pegs
    plinko.pegs = [];
    for (let r = 0; r < R; r++) {
        for (let j = 0; j <= r; j++) {
            plinko.pegs.push({ x: W / 2 - r * hSpacing / 2 + j * hSpacing, y: topPad + r * vSpacing, r: 6 });
        }
    }

    // Slots
    const slotCount = R + 1;
    const slotW = usableW / slotCount;
    plinko.slots = [];
    for (let i = 0; i < slotCount; i++) {
        plinko.slots.push({ x: sidePad + i * slotW + slotW / 2, w: slotW, index: i });
    }

    updateMultiplierDisplay();
}

function updateMultiplierDisplay() {
    const mults = getMultipliers(plinko.rows, plinko.risk);
    slotRow.innerHTML = '';
    for (const m of mults) {
        const el = document.createElement('span');
        el.className = 'slot' + (m >= 2 ? ' high-mult' : ' low-mult');
        el.textContent = m + 'x';
        slotRow.appendChild(el);
    }
}

// ─── BINOMIAL OUTCOME + PATH GENERATION ────────────────────────────────────────
/*
 * The final slot is pre-determined using the Binomial Distribution.
 * Generate N random bits (0 = left, 1 = right), one per row.
 * slotIndex = sum of bits  (number of right bounces).
 * Probability of slot k = C(N,k) / 2^N  — matches Pascal's Triangle.
 *
 * The path is then built backwards from the determined slot:
 * each row, the ball moves left or right to reach the final position.
 */
function generateBall(rows, hSpacing, vSpacing, topPad, centerX, dropX) {
    // 1. Generate N random bits to determine the path
    const bits = [];
    let rightCount = 0;
    for (let i = 0; i < rows; i++) {
        const bit = Math.random() < 0.5 ? 0 : 1;
        bits.push(bit);
        if (bit === 1) rightCount++;
    }
    const slotIndex = rightCount; // sum of bits

    // 2. Build the path positions
    // At row r (0-indexed), the ball is at peg position = cumulative rights
    // peg[r][k] = centerX - r*hSpacing/2 + k*hSpacing
    const path = [];
    let cumRights = 0;

    // Starting position (above the first peg)
    path.push({ x: dropX !== undefined ? dropX : centerX, y: topPad - 15 });

    for (let r = 0; r < rows; r++) {
        if (bits[r] === 1) cumRights++;
        const pegX = centerX - r * hSpacing / 2 + cumRights * hSpacing;
        const pegY = topPad + r * vSpacing;
        path.push({ x: pegX, y: pegY });
    }

    // Final position at the slot
    const mults = getMultipliers(rows, plinko.risk);
    const mult = mults[slotIndex];
    const win = plinko.bet * mult;

    return {
        path,
        progress: 0,
        slotIndex,
        mult,
        win,
        done: false,
        speed: 0,        // will be set per-frame
        settled: false,
        settleTime: 0,
    };
}

// ─── ANIMATION ─────────────────────────────────────────────────────────────────

function updateBalls(dt) {
    for (const ball of plinko.balls) {
        if (ball.done) {
            if (!ball.settled) {
                ball.settleTime += dt;
                if (ball.settleTime > 1.5) ball.settled = true;
            }
            continue;
        }

        ball.progress += dt * (1.0 / 0.9); // Complete path in ~0.9 seconds

        if (ball.progress >= 1) {
            ball.progress = 1;
            ball.done = true;
            handleResult(ball);
        }
    }
}

function getBallPosition(ball) {
    const p = ball.progress;
    const path = ball.path;
    const totalSegments = path.length - 1;
    const segFloat = p * totalSegments;
    const segIdx = Math.min(Math.floor(segFloat), totalSegments - 1);
    const segT = segFloat - segIdx;

    // Ease in-out for smooth movement
    const eased = segT < 0.5 ? 2 * segT * segT : 1 - Math.pow(-2 * segT + 2, 2) / 2;

    const a = path[segIdx];
    const b = path[segIdx + 1];
    return {
        x: a.x + (b.x - a.x) * eased,
        y: a.y + (b.y - a.y) * eased,
    };
}

// ─── RESULT HANDLING ───────────────────────────────────────────────────────────

function handleResult(ball) {
    const mult = ball.mult;
    const win = ball.win;

    plinkoMult.textContent = mult.toFixed(2) + 'x';
    plinkoWin.textContent = (win < 0 ? '-$' : '$') + Math.abs(win).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    plinkoResult.classList.add('visible');
    plinkoMult.className = 'mult' + (mult >= 2 ? ' high-mult' : '');

    if (mult >= 1) {
        App.addWin(win, plinko.bet);
        if (mult >= 5) {
            App.showNotif('Big win! ' + (win < 0 ? '-$' : '$') + Math.abs(win).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), 'win');
        }
    } else {
        App.recordLoss(plinko.bet);
    }

    plinko.slotHighlights.push(ball.slotIndex);
    setTimeout(() => {
        plinko.slotHighlights = plinko.slotHighlights.filter(s => s !== ball.slotIndex);
    }, 1500);

    playPlinkoSound(mult >= 1);

    if (plinkoAuto.active) {
        autoPlinkoNext(mult);
    }
}

// ─── AUTO PLAY ─────────────────────────────────────────────────────────────────

const plinkoAuto = {
    active: false,
    rounds: 10,
    roundsLeft: 10,
    targetMult: 2,
    stopOnWin: false,
    stopOnLoss: false,
};

function updatePlinkoAutoUI() {
    const btn = p$('plinkoAutoStartBtn');
    const progress = p$('plinkoAutoProgress');
    const progressText = p$('plinkoAutoProgressText');
    if (plinkoAuto.active) {
        btn.textContent = 'Stop Auto';
        btn.className = 'btn-auto stop';
        progress.style.display = 'block';
        progressText.textContent = (plinkoAuto.rounds - plinkoAuto.roundsLeft) + '/' + plinkoAuto.rounds;
    } else {
        btn.textContent = 'Start Auto';
        btn.className = 'btn-auto';
        progress.style.display = 'none';
    }
}

function plinkoAutoEnableInputs(enabled) {
    p$('plinkoAutoRounds').disabled = !enabled;
    p$('plinkoAutoTarget').disabled = !enabled;
    p$('plinkoStopOnWin').disabled = !enabled;
    p$('plinkoStopOnLoss').disabled = !enabled;
}

function startPlinkoAuto() {
    const rounds = parseInt(p$('plinkoAutoRounds').value);
    const target = parseFloat(p$('plinkoAutoTarget').value);
    if (isNaN(rounds) || rounds < 1) { App.showNotif('Enter valid number of bets', 'info'); return; }
    if (isNaN(target) || target < 1.01) { App.showNotif('Enter valid target multiplier', 'info'); return; }
    if (plinko.bet > App.balance) { App.showNotif('Insufficient balance', 'info'); return; }

    plinkoAuto.active = true;
    plinkoAuto.rounds = rounds;
    plinkoAuto.roundsLeft = rounds;
    plinkoAuto.targetMult = target;
    plinkoAuto.stopOnWin = p$('plinkoStopOnWin').checked;
    plinkoAuto.stopOnLoss = p$('plinkoStopOnLoss').checked;

    plinkoAutoEnableInputs(false);
    plinko.canvas.style.pointerEvents = 'none';
    updatePlinkoAutoUI();
    autoPlinkoDrop();
}

function stopPlinkoAuto() {
    plinkoAuto.active = false;
    updatePlinkoAutoUI();
    plinkoAutoEnableInputs(true);
    plinko.canvas.style.pointerEvents = '';
    App.showNotif('Auto play stopped', 'info');
}

function autoPlinkoDrop() {
    if (!plinkoAuto.active) return;
    if (plinko.bet > App.balance) {
        plinkoAuto.active = false;
        updatePlinkoAutoUI();
        plinkoAutoEnableInputs(true);
        plinko.canvas.style.pointerEvents = '';
        App.showNotif('Auto stopped - insufficient balance', 'info');
        return;
    }
    dropBall();
}

function autoPlinkoNext(mult) {
    if (!plinkoAuto.active) return;
    plinkoAuto.roundsLeft--;
    updatePlinkoAutoUI();

    if (plinkoAuto.stopOnLoss && mult < 1) {
        stopPlinkoAuto();
        App.showNotif('Auto stopped after loss', 'info');
        return;
    }
    if (plinkoAuto.stopOnWin && mult >= plinkoAuto.targetMult) {
        stopPlinkoAuto();
        App.showNotif('Auto stopped on win target', 'info');
        return;
    }

    if (plinkoAuto.roundsLeft > 0 && plinko.bet <= App.balance) {
        setTimeout(() => autoPlinkoDrop(), 400);
    } else {
        plinkoAuto.active = false;
        updatePlinkoAutoUI();
        plinkoAutoEnableInputs(true);
        plinko.canvas.style.pointerEvents = '';
        App.showNotif(plinko.bet > App.balance ? 'Auto stopped - insufficient balance' : 'Auto play complete', 'info');
    }
}

// ─── DRAW ──────────────────────────────────────────────────────────────────────

function drawBoard() {
    const ctx = plinko.ctx;
    const W = plinko.canvas.width;
    const H = plinko.canvas.height;
    const R = plinko.rows;
    const bottomY = H - 50;
    const mults = getMultipliers(R, plinko.risk);

    ctx.clearRect(0, 0, W, H);

    // Background
    const bg = ctx.createRadialGradient(W / 2, H * 0.3, 0, W / 2, H * 0.3, W * 0.7);
    bg.addColorStop(0, '#1a2a3a');
    bg.addColorStop(1, '#080c14');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Slot backgrounds
    for (let i = 0; i < plinko.slots.length; i++) {
        const s = plinko.slots[i];
        const hw = s.w / 2 - 1;
        const m = mults[i];
        const isHit = plinko.slotHighlights.includes(i);

        if (isHit) {
            ctx.fillStyle = 'rgba(240,185,11,0.2)';
            ctx.fillRect(s.x - hw, bottomY - 6, hw * 2, 56);
            ctx.strokeStyle = 'rgba(240,185,11,0.5)';
            ctx.lineWidth = 2;
            ctx.strokeRect(s.x - hw, bottomY - 6, hw * 2, 56);
        } else {
            ctx.fillStyle = m >= 5 ? 'rgba(0,230,118,0.06)' : m < 1 ? 'rgba(255,23,68,0.06)' : 'rgba(255,255,255,0.02)';
            ctx.fillRect(s.x - hw, bottomY - 6, hw * 2, 52);
        }

        ctx.fillStyle = isHit ? '#f0b90b' : (m >= 3 ? '#00e676' : m < 1 ? '#ff1744' : '#9ca3af');
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(m + 'x', s.x, bottomY + 38);
    }

    // Separator
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, bottomY - 6);
    ctx.lineTo(W, bottomY - 6);
    ctx.stroke();

    // Pegs
    for (const peg of plinko.pegs) {
        const glow = ctx.createRadialGradient(peg.x, peg.y, 0, peg.x, peg.y, peg.r * 2.5);
        glow.addColorStop(0, 'rgba(180,200,220,0.2)');
        glow.addColorStop(1, 'rgba(180,200,220,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(peg.x, peg.y, peg.r * 2.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#6a7a8a';
        ctx.beginPath();
        ctx.arc(peg.x, peg.y, peg.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 0.5;
        ctx.stroke();
    }

    // Balls
    for (const ball of plinko.balls) {
        if (ball.settled) {
            if (plinko.slotHighlights.includes(ball.slotIndex)) {
                const s = plinko.slots[ball.slotIndex];
                ctx.fillStyle = '#00e676';
                ctx.beginPath();
                ctx.arc(s.x, bottomY + 12, 7, 0, Math.PI * 2);
                ctx.fill();
            }
            continue;
        }

        const pos = getBallPosition(ball);

        // Trail (last few path points)
        const drawnPath = ball.path.slice(0, Math.floor(ball.progress * ball.path.length) + 1);
        if (drawnPath.length > 2) {
            ctx.strokeStyle = 'rgba(0,230,118,0.08)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(drawnPath[0].x, drawnPath[0].y);
            for (let i = 1; i < drawnPath.length; i++) ctx.lineTo(drawnPath[i].x, drawnPath[i].y);
            ctx.stroke();
            // Smooth trail from actual position
            ctx.strokeStyle = 'rgba(0,230,118,0.12)';
            ctx.lineWidth = 1.5;
            const trailLen = Math.min(8, drawnPath.length - 1);
            const trailStart = Math.max(0, drawnPath.length - 1 - trailLen);
            ctx.beginPath();
            ctx.moveTo(drawnPath[trailStart].x, drawnPath[trailStart].y);
            for (let i = trailStart + 1; i < drawnPath.length; i++) ctx.lineTo(drawnPath[i].x, drawnPath[i].y);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
        }

        // Glow
        const g2 = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, 25);
        g2.addColorStop(0, 'rgba(0,230,118,0.25)');
        g2.addColorStop(1, 'rgba(0,230,118,0)');
        ctx.fillStyle = g2;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 25, 0, Math.PI * 2);
        ctx.fill();

        // Ball
        const bg2 = ctx.createRadialGradient(pos.x - 3, pos.y - 3, 0, pos.x, pos.y, 9);
        bg2.addColorStop(0, '#88ffc8');
        bg2.addColorStop(0.4, '#00e676');
        bg2.addColorStop(1, '#006b2a');
        ctx.fillStyle = bg2;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 0.5;
        ctx.stroke();
    }

    // Drop zone hint
    if (plinko.balls.length === 0) {
        ctx.fillStyle = 'rgba(240,185,11,0.06)';
        ctx.fillRect(0, 0, W, 18);
    }
}

// ─── GAME LOOP ─────────────────────────────────────────────────────────────────

function gameLoop(timestamp) {
    const dt = plinko.lastTime ? Math.min((timestamp - plinko.lastTime) / 1000, 0.05) : 0.016;
    plinko.lastTime = timestamp;

    updateBalls(dt);
    drawBoard();

    const hasActive = plinko.balls.some(b => !b.settled);
    if (hasActive) {
        plinko.animId = requestAnimationFrame(gameLoop);
    } else {
        plinko.animId = null;
        plinko.lastTime = 0;
        // Clean up fully settled balls (keep last 15)
        const settled = plinko.balls.filter(b => b.settled);
        if (settled.length > 15) {
            plinko.balls = plinko.balls.filter(b => !b.settled);
        }
    }
}

// ─── DROP ──────────────────────────────────────────────────────────────────────

function dropBall(dropX) {
    if (App.balance < plinko.bet) { App.showNotif('Insufficient balance!', 'info'); return; }

    App.deductBet(plinko.bet);
    const ball = generateBall(
        plinko.rows,
        plinko.hSpacing,
        plinko.vSpacing,
        plinko.topPad,
        plinko.centerX,
        dropX
    );
    plinko.balls.push(ball);

    if (!plinko.animId) {
        plinko.lastTime = 0;
        plinko.animId = requestAnimationFrame(gameLoop);
    }
}

// ─── CANVAS ────────────────────────────────────────────────────────────────────

function resizeCanvas() {
    const wrap = plinko.canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    const w = rect.width - 24;
    const aspect = 1.45;
    plinko.canvas.width = w;
    plinko.canvas.height = w * aspect;
    plinko.ctx = plinko.canvas.getContext('2d');
    layoutBoard();
    drawBoard();
}

// ─── INIT ──────────────────────────────────────────────────────────────────────

function plinkoInit() {
    if (!plinko.initialized) {
        plinko.canvas = document.getElementById('plinkoCanvas');
        plinko.ctx = plinko.canvas.getContext('2d');

        plinko.canvas.addEventListener('click', e => {
            const rect = plinko.canvas.getBoundingClientRect();
            const x = (e.clientX - rect.left) * (plinko.canvas.width / rect.width);
            if (x > 0 && x < plinko.canvas.width) dropBall(x);
        });

        window.addEventListener('resize', resizeCanvas);

        document.querySelectorAll('.risk-btn').forEach(b => {
            b.addEventListener('click', () => {
                document.querySelectorAll('.risk-btn').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                plinko.risk = b.dataset.risk;
                scaledMultipliers = {}; // clear cache
                updateMultiplierDisplay();
                if (!plinko.animId) drawBoard();
            });
        });

        document.querySelectorAll('.rows-btn').forEach(b => {
            b.addEventListener('click', () => {
                document.querySelectorAll('.rows-btn').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                plinko.rows = parseInt(b.dataset.rows);
                scaledMultipliers = {}; // clear cache
                layoutBoard();
                if (!plinko.animId) drawBoard();
            });
        });

        dropBtn.addEventListener('click', () => {
            const x = plinko.canvas.width / 2 + (Math.random() - 0.5) * plinko.canvas.width * 0.35;
            dropBall(x);
        });

        p$('plinkoBetHalf').addEventListener('click', () => {
            const v = parseFloat(plinkoBet.value) || 0;
            plinkoBet.value = Math.max(0.01, v / 2);
            plinko.bet = parseFloat(plinkoBet.value);
        });
        p$('plinkoBetDouble').addEventListener('click', () => {
            const v = parseFloat(plinkoBet.value) || 0;
            plinkoBet.value = Math.min(App.balance, v * 2 || 1);
            plinko.bet = parseFloat(plinkoBet.value);
        });
        plinkoBet.addEventListener('input', () => {
            plinko.bet = parseFloat(plinkoBet.value) || 0;
        });

        p$('plinkoAutoToggle').addEventListener('click', () => {
            const body = p$('plinkoAutoBody');
            body.style.display = body.style.display === 'none' ? 'flex' : 'none';
            p$('plinkoAutoToggle').textContent = body.style.display === 'none' ? 'Show' : 'Hide';
        });
        p$('plinkoAutoStartBtn').addEventListener('click', () => {
            if (plinkoAuto.active) stopPlinkoAuto();
            else startPlinkoAuto();
        });

        plinko.initialized = true;
    }

    plinko.bet = parseFloat(plinkoBet.value) || 10;
    plinko.balls = [];
    plinko.slotHighlights = [];
    if (plinko.animId) { cancelAnimationFrame(plinko.animId); plinko.animId = null; }
    plinko.lastTime = 0;
    plinkoResult.classList.remove('visible');
    dropBtn.disabled = false;
    dropBtn.textContent = 'Drop Ball';
    resizeCanvas();
}

function playPlinkoSound(win) {
    try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.connect(gain);
        gain.connect(ac.destination);
        gain.gain.value = 0.05;
        if (win) {
            osc.frequency.value = 660;
            osc.type = 'sine';
            gain.gain.setValueAtTime(0.05, ac.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.15);
            osc.start(ac.currentTime);
            osc.stop(ac.currentTime + 0.15);
        } else {
            osc.frequency.value = 180;
            osc.type = 'sawtooth';
            gain.gain.setValueAtTime(0.06, ac.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.25);
            osc.start(ac.currentTime);
            osc.stop(ac.currentTime + 0.25);
        }
    } catch (e) {}
}
