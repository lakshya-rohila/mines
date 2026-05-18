// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const TOTAL_TILES = 25;
const EDGE = 0.99;

// ─── GAME STATE (mines-specific only) ─────────────────────────────────────────
let state = {
    minesCount: 3,
    betAmount: 10,
    status: 'idle',           // idle | playing | lost | won
    tiles: [],
    revealedCount: 0,
    currentWin: 0,
};

// ─── DOM REFS ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const grid = $('grid');
const multiplierValue = $('multiplierValue');
const minesCount = $('minesCount');
const betAmount = $('betAmount');
const actionBtn = $('actionBtn');
const winPreview = $('winPreview');
const winAmount = $('winAmount');

let autoState = {
    active: false,
    rounds: 0,
    roundsLeft: 0,
    targetMultiplier: 2,
    stopOnWin: false,
    stopOnLoss: false,
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatCurrency(n) {
    return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Multiplier = 0.99 / P(n)  where P(n) = ∏((25-m-k)/(25-k)) for k=0..n-1
function calcMultiplier(revealed) {
    let prob = 1;
    for (let i = 0; i < revealed; i++) {
        prob *= (TOTAL_TILES - state.minesCount - i) / (TOTAL_TILES - i);
    }
    return EDGE / prob;
}

// ─── GRID ─────────────────────────────────────────────────────────────────────

function buildGrid() {
    grid.innerHTML = '';
    state.tiles = [];
    for (let i = 0; i < TOTAL_TILES; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell disabled';
        cell.dataset.index = i;
        const icon = document.createElement('span');
        icon.className = 'icon';
        cell.appendChild(icon);
        grid.appendChild(cell);
        state.tiles.push({ el: cell, icon, isMine: false, revealed: false });
    }
}

function placeMines() {
    const indices = Array.from({ length: TOTAL_TILES }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    for (const idx of indices.slice(0, state.minesCount)) {
        state.tiles[idx].isMine = true;
    }
}

function resetGrid() {
    for (const t of state.tiles) {
        t.el.className = 'cell disabled';
        t.icon.textContent = '';
        t.isMine = false;
        t.revealed = false;
    }
}

// ─── CONTROLS ─────────────────────────────────────────────────────────────────

function enableControls() {
    $('minesDown').disabled = false;
    $('minesUp').disabled = false;
    for (const pb of document.querySelectorAll('.mines-presets button')) pb.style.pointerEvents = 'auto';
    betAmount.disabled = false;
    $('betHalf').disabled = false;
    $('betDouble').disabled = false;
}

// ─── TILE REVEALS ──────────────────────────────────────────────────────────────

function revealAll() {
    for (const t of state.tiles) {
        if (t.revealed) continue;
        t.revealed = true;
        t.el.className = 'cell revealed ' + (t.isMine ? 'mine' : 'gem') + ' disabled';
        t.icon.textContent = t.isMine ? '💣' : '💎';
    }
}

function revealGem(idx) {
    const t = state.tiles[idx];
    if (t.revealed) return;
    t.revealed = true;
    t.el.className = 'cell revealed gem';
    t.icon.textContent = '💎';
    state.revealedCount++;

    const mult = calcMultiplier(state.revealedCount);
    const win = state.betAmount * mult;
    state.currentWin = win;

    multiplierValue.textContent = mult.toFixed(2) + 'x';
    multiplierValue.className = 'multiplier-value active' + (mult > 3 ? ' high' : '');
    winAmount.textContent = formatCurrency(win);
    winPreview.classList.add('visible');
    actionBtn.textContent = 'Cash Out';
    actionBtn.className = 'btn-action cashout';
    actionBtn.disabled = false;

    if (state.revealedCount === TOTAL_TILES - state.minesCount) {
        setTimeout(() => cashOut(true), 300);
    }
}

function revealMine(idx) {
    state.tiles[idx].revealed = true;
    state.tiles[idx].el.className = 'cell revealed hit-mine disabled';
    state.tiles[idx].icon.textContent = '💣';
    state.status = 'lost';
    revealAll();

    App.recordLoss(state.betAmount);
    enableControls();
    actionBtn.textContent = 'Play Again';
    actionBtn.className = 'btn-action next';
    actionBtn.disabled = false;
    if (!autoState.active) App.showNotif('You hit a mine! Lost ' + formatCurrency(state.betAmount), 'lose');
    playMineSound(false);
}

// ─── CASH OUT ──────────────────────────────────────────────────────────────────

function cashOut(auto) {
    if (state.status !== 'playing') return;
    state.status = 'won';
    const win = state.currentWin;

    App.addWin(win, state.betAmount);
    revealAll();
    enableControls();
    actionBtn.textContent = 'Play Again';
    actionBtn.className = 'btn-action next';
    actionBtn.disabled = false;

    if (!auto && !autoState.active) App.showNotif('Cashed out! Won ' + formatCurrency(win), 'win');
    else if (auto && !autoState.active) App.showNotif('Full Clear! Won ' + formatCurrency(win), 'win');
    playMineSound(true);
}

// ─── PLACE BET ─────────────────────────────────────────────────────────────────

function placeBet() {
    const bet = parseFloat(betAmount.value);
    if (isNaN(bet) || bet <= 0) { App.showNotif('Enter a valid bet amount', 'info'); return; }
    if (bet > App.balance) { App.showNotif('Insufficient balance!', 'info'); return; }

    state.betAmount = bet;
    state.revealedCount = 0;
    state.currentWin = 0;
    state.status = 'playing';

    App.deductBet(bet);
    resetGrid();
    placeMines();

    for (const t of state.tiles) t.el.className = 'cell';

    actionBtn.textContent = 'Cash Out';
    actionBtn.className = 'btn-action cashout';
    actionBtn.disabled = true;
    multiplierValue.textContent = '1.00x';
    multiplierValue.className = 'multiplier-value';
    winPreview.classList.remove('visible');

    $('minesDown').disabled = true;
    $('minesUp').disabled = true;
    for (const pb of document.querySelectorAll('.mines-presets button')) pb.style.pointerEvents = 'none';
    betAmount.disabled = true;
    $('betHalf').disabled = true;
    $('betDouble').disabled = true;
}

// ─── SOUND ─────────────────────────────────────────────────────────────────────

function playMineSound(win) {
    try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.connect(gain);
        gain.connect(ac.destination);
        gain.gain.value = 0.08;
        if (win) {
            osc.frequency.value = 523.25;
            osc.type = 'sine';
            gain.gain.setValueAtTime(0.08, ac.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.3);
            osc.start(ac.currentTime);
            osc.stop(ac.currentTime + 0.3);
            const osc2 = ac.createOscillator();
            const gain2 = ac.createGain();
            osc2.connect(gain2);
            gain2.connect(ac.destination);
            gain2.gain.value = 0.06;
            osc2.frequency.value = 659.25;
            osc2.type = 'sine';
            gain2.gain.setValueAtTime(0.06, ac.currentTime + 0.15);
            gain2.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.5);
            osc2.start(ac.currentTime + 0.15);
            osc2.stop(ac.currentTime + 0.5);
            const osc3 = ac.createOscillator();
            const gain3 = ac.createGain();
            osc3.connect(gain3);
            gain3.connect(ac.destination);
            gain3.gain.value = 0.06;
            osc3.frequency.value = 783.99;
            osc3.type = 'sine';
            gain3.gain.setValueAtTime(0.06, ac.currentTime + 0.3);
            gain3.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.7);
            osc3.start(ac.currentTime + 0.3);
            osc3.stop(ac.currentTime + 0.7);
        } else {
            osc.frequency.value = 200;
            osc.type = 'sawtooth';
            gain.gain.setValueAtTime(0.1, ac.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.4);
            osc.start(ac.currentTime);
            osc.stop(ac.currentTime + 0.4);
        }
    } catch (e) {}
}

// ─── AUTO PLAY ─────────────────────────────────────────────────────────────────

function updateAutoUI() {
    const btn = $('autoStartBtn');
    const progress = $('autoProgress');
    const progressText = $('autoProgressText');
    if (autoState.active) {
        btn.textContent = 'Stop Auto';
        btn.className = 'btn-auto stop';
        progress.style.display = 'block';
        progressText.textContent = (autoState.rounds - autoState.roundsLeft) + '/' + autoState.rounds;
    } else {
        btn.textContent = 'Start Auto';
        btn.className = 'btn-auto';
        progress.style.display = 'none';
    }
}

async function autoPlayRound() {
    if (!autoState.active) return;
    placeBet();
    if (state.status !== 'playing') return;
    updateAutoUI();

    while (state.status === 'playing' && autoState.active) {
        await delay(400);
        if (!autoState.active || state.status !== 'playing') break;

        const unrevealed = state.tiles.filter(t => !t.revealed);
        if (unrevealed.length === 0) break;

        const idx = parseInt(unrevealed[Math.floor(Math.random() * unrevealed.length)].el.dataset.index);
        if (state.tiles[idx].isMine) {
            revealMine(idx);
            if (autoState.stopOnLoss && autoState.active) {
                autoState.active = false;
                updateAutoUI();
                enableControls();
                App.showNotif('Auto stopped after loss', 'info');
                return;
            }
        } else {
            revealGem(idx);
            if (calcMultiplier(state.revealedCount) >= autoState.targetMultiplier && state.status === 'playing') {
                cashOut(false);
                if (autoState.stopOnWin && autoState.active) {
                    autoState.active = false;
                    updateAutoUI();
                    enableControls();
                    App.showNotif('Auto stopped on win target', 'info');
                    return;
                }
                break;
            }
        }
    }

    if (!autoState.active) return;
    autoState.roundsLeft--;
    updateAutoUI();

    if (autoState.roundsLeft > 0 && App.balance >= parseFloat(betAmount.value)) {
        setTimeout(() => autoPlayRound(), 600);
    } else {
        autoState.active = false;
        updateAutoUI();
        enableControls();
        App.showNotif(App.balance < parseFloat(betAmount.value) ? 'Auto stopped - insufficient balance' : 'Auto play complete', 'info');
    }
}

function startAuto() {
    const rounds = parseInt($('autoRounds').value);
    const target = parseFloat($('autoTarget').value);
    if (isNaN(rounds) || rounds < 1) { App.showNotif('Enter valid number of bets', 'info'); return; }
    if (isNaN(target) || target < 1.01) { App.showNotif('Enter valid target multiplier', 'info'); return; }
    if (parseFloat(betAmount.value) > App.balance) { App.showNotif('Insufficient balance', 'info'); return; }

    autoState.active = true;
    autoState.rounds = rounds;
    autoState.roundsLeft = rounds;
    autoState.targetMultiplier = target;
    autoState.stopOnWin = $('stopOnWin').checked;
    autoState.stopOnLoss = $('stopOnLoss').checked;

    $('autoRounds').disabled = true;
    $('autoTarget').disabled = true;
    $('stopOnWin').disabled = true;
    $('stopOnLoss').disabled = true;
    updateAutoUI();
    autoPlayRound();
}

function stopAuto() {
    autoState.active = false;
    updateAutoUI();
    enableControls();
    $('autoRounds').disabled = false;
    $('autoTarget').disabled = false;
    $('stopOnWin').disabled = false;
    $('stopOnLoss').disabled = false;
    App.showNotif('Auto play stopped', 'info');
}

// ─── INIT ──────────────────────────────────────────────────────────────────────

function changeMines(delta) {
    if (state.status !== 'idle') return;
    let m = Math.max(1, Math.min(24, state.minesCount + delta));
    state.minesCount = m;
    minesCount.textContent = m;
    document.querySelectorAll('.mines-presets button').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.mines) === m);
    });
}

function minesInit() {
    const wasInitialized = state.tiles.length > 0;
    if (!wasInitialized) {
        buildGrid();
        state.betAmount = 10;
        minesCount.textContent = state.minesCount;
        betAmount.value = state.betAmount;

        actionBtn.addEventListener('click', () => {
            if (state.status === 'idle' || state.status === 'lost' || state.status === 'won') {
                if (App.balance <= 0) { App.showNotif('Out of funds! Reset your balance.', 'info'); return; }
                placeBet();
            } else if (state.status === 'playing') {
                cashOut(false);
            }
        });

        grid.addEventListener('click', e => {
            const cell = e.target.closest('.cell');
            if (!cell || state.status !== 'playing') return;
            const idx = parseInt(cell.dataset.index);
            const t = state.tiles[idx];
            if (t.revealed) return;
            if (t.isMine) revealMine(idx);
            else revealGem(idx);
        });

        $('minesDown').addEventListener('click', () => changeMines(-1));
        $('minesUp').addEventListener('click', () => changeMines(1));
        document.querySelectorAll('.mines-presets button').forEach(b => {
            b.addEventListener('click', () => {
                if (state.status !== 'idle') return;
                state.minesCount = parseInt(b.dataset.mines);
                minesCount.textContent = state.minesCount;
                document.querySelectorAll('.mines-presets button').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
            });
        });

        $('betHalf').addEventListener('click', () => {
            if (state.status !== 'idle') return;
            betAmount.value = Math.max(0.01, (parseFloat(betAmount.value) || 0) / 2);
            state.betAmount = parseFloat(betAmount.value);
        });
        $('betDouble').addEventListener('click', () => {
            if (state.status !== 'idle') return;
            betAmount.value = Math.min(App.balance, (parseFloat(betAmount.value) || 0) * 2 || 1);
            state.betAmount = parseFloat(betAmount.value);
        });

        $('autoToggle').addEventListener('click', () => {
            const body = $('autoBody');
            body.style.display = body.style.display === 'none' ? 'flex' : 'none';
            $('autoToggle').textContent = body.style.display === 'none' ? 'Show' : 'Hide';
        });
        $('autoStartBtn').addEventListener('click', () => {
            if (autoState.active) stopAuto();
            else startAuto();
        });

        document.addEventListener('keydown', e => {
            if ((e.key === 'Enter' || e.key === ' ') && document.getElementById('screenMines').classList.contains('active')) {
                e.preventDefault();
                actionBtn.click();
            }
        });
    }

    state.status = 'idle';
    enableControls();
    resetGrid();
    actionBtn.textContent = 'Place Bet';
    actionBtn.className = 'btn-action place';
    actionBtn.disabled = false;
    multiplierValue.textContent = '1.00x';
    multiplierValue.className = 'multiplier-value';
    winPreview.classList.remove('visible');
    betAmount.value = state.betAmount;
    App.updateUI();
}
