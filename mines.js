// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const TOTAL_TILES = 25;           // 5x5 grid
const EDGE = 0.99;                // 1% house edge (99% RTP)

// ─── GAME STATE ───────────────────────────────────────────────────────────────
let state = {
    balance: 1000,                // fake money balance
    minesCount: 3,                // number of mines in current round
    betAmount: 10,                // current bet amount
    status: 'idle',               // idle | playing | lost | won
    tiles: [],                    // array of { el, icon, isMine, revealed }
    revealedCount: 0,             // gems revealed this round
    gamesPlayed: 0,               // lifetime stats
    gamesWon: 0,
    profit: 0,                    // net profit (positive = up, negative = down)
    currentWin: 0,                // live cash-out value for current round
};

// ─── DOM SHORTCUTS ────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const grid = $('grid');
const balanceDisplay = $('balanceDisplay');
const multiplierValue = $('multiplierValue');
const minesCount = $('minesCount');
const betAmount = $('betAmount');
const actionBtn = $('actionBtn');
const winPreview = $('winPreview');
const winAmount = $('winAmount');
const notification = $('notification');
const statGames = $('statGames');
const statWon = $('statWon');
const statRate = $('statRate');
const statProfit = $('statProfit');

let notifTimeout = null;

// ─── AUTO-PLAY STATE ──────────────────────────────────────────────────────────
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

// Format a number as currency: $1,234.56
function formatCurrency(n) {
    return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/*
 * ─── MULTIPLIER MATH ───────────────────────────────────────────────────────────
 *
 * After revealing `n` gems with `m` mines on a 25-tile grid:
 *
 * The probability of surviving n consecutive reveals (no mine hit) is:
 *
 *   P(n) = ∏(k=0 → n-1)  (25 - m - k) / (25 - k)
 *
 *   = (25-m)/25  ×  (24-m)/24  ×  ...  ×  (25-m-n+1)/(25-n+1)
 *
 * This is the hypergeometric probability of drawing n gems in n draws
 * without replacement from a pool of 25 where m are mines.
 *
 * Fair multiplier = 1 / P(n)
 * Actual multiplier = 0.99 / P(n)    ← 1% house edge
 *
 * Example with 3 mines:
 *   n=1 → P = 22/25 = 0.8800    → mult = 0.99/0.88 = 1.125x
 *   n=2 → P = 22/25 × 21/24     → mult = 0.99/0.77 = 1.286x
 *   n=3 → P = 22/25 × 21/24 × 20/23 → mult = 0.99/0.67 = 1.478x
 *
 * The more mines you pick, the faster the multiplier grows (higher risk).
 * The more gems you reveal, the higher the multiplier climbs.
 */
function calcMultiplier(revealed) {
    let prob = 1;
    for (let i = 0; i < revealed; i++) {
        prob *= (TOTAL_TILES - state.minesCount - i) / (TOTAL_TILES - i);
    }
    return EDGE / prob;
}

// ─── GRID SETUP ───────────────────────────────────────────────────────────────

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

// Fisher-Yates shuffle to randomly place `minesCount` mines
function placeMines() {
    const indices = Array.from({ length: TOTAL_TILES }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const mineIndices = indices.slice(0, state.minesCount);
    for (const idx of mineIndices) {
        state.tiles[idx].isMine = true;
    }
}

function resetTiles() {
    for (const t of state.tiles) {
        t.el.className = 'cell disabled';
        t.icon.textContent = '';
        t.isMine = false;
        t.revealed = false;
    }
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────

function showNotif(msg, type) {
    if (notifTimeout) clearTimeout(notifTimeout);
    notification.textContent = msg;
    notification.className = 'notification ' + type + ' show';
    notifTimeout = setTimeout(() => { notification.classList.remove('show'); }, 2500);
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

// ─── TILE REVEAL LOGIC ──────────────────────────────────────────────────────────

// Reveal every unrevealed tile (used after game ends — win or loss)
function revealAll() {
    for (let i = 0; i < state.tiles.length; i++) {
        const t = state.tiles[i];
        if (t.revealed) continue;
        t.revealed = true;
        if (t.isMine) {
            t.el.className = 'cell revealed mine disabled';
            t.icon.textContent = '💣';
        } else {
            t.el.className = 'cell revealed gem disabled';
            t.icon.textContent = '💎';
        }
    }
}

function revealGem(idx) {
    const t = state.tiles[idx];
    if (t.revealed) return;
    t.revealed = true;
    t.el.className = 'cell revealed gem';
    t.icon.textContent = '💎';
    state.revealedCount++;

    // Update multiplier and cash-out preview
    const mult = calcMultiplier(state.revealedCount);
    const win = state.betAmount * mult;
    state.currentWin = win;
    multiplierValue.textContent = mult.toFixed(2) + 'x';
    multiplierValue.className = 'multiplier-value active' + (mult > 3 ? ' high' : '');
    winAmount.textContent = formatCurrency(win);
    winPreview.classList.add('visible');

    // Enable cash out button
    actionBtn.textContent = 'Cash Out';
    actionBtn.className = 'btn-action cashout';
    actionBtn.disabled = false;

    // Auto cash-out on full clear (all gems revealed)
    if (state.revealedCount === TOTAL_TILES - state.minesCount) {
        setTimeout(() => cashOut(true), 300);
    }
}

function revealMine(idx) {
    const hit = state.tiles[idx];
    hit.revealed = true;
    hit.el.className = 'cell revealed hit-mine disabled';
    hit.icon.textContent = '💣';
    state.status = 'lost';
    revealAll();  // show all remaining tiles

    // Balance was already deducted when bet was placed (in placeBet).
    // Only record the profit hit here.
    const loss = state.betAmount;
    state.profit -= loss;
    state.gamesPlayed++;
    saveToStorage();
    updateStats();

    enableControls();
    actionBtn.textContent = 'Play Again';
    actionBtn.className = 'btn-action next';
    actionBtn.disabled = false;
    if (!autoState.active) showNotif('You hit a mine! Lost ' + formatCurrency(loss), 'lose');
    playSound(false);
}

// ─── CASH OUT ───────────────────────────────────────────────────────────────────
/*
 * Called when the player clicks Cash Out or reaches full clear.
 * Balance flow:
 *   1. placeBet() deducted the bet: balance -= bet
 *   2. cashOut() adds the win:       balance += win = bet × multiplier
 *   3. Net change: balance += bet × (multiplier - 1)
 *      Profit change: += win - bet = bet × (multiplier - 1)
 *
 * If you reveal all 25-mines gems without hitting a mine, it auto-cashes.
 */
function cashOut(auto) {
    if (state.status !== 'playing') return;
    state.status = 'won';
    const win = state.currentWin;
    state.balance += win;
    state.profit += win - state.betAmount;
    state.gamesPlayed++;
    state.gamesWon++;
    saveToStorage();
    updateStats();

    // Reveal all remaining tiles
    for (const t of state.tiles) {
        if (t.revealed) continue;
        t.revealed = true;
        if (t.isMine) {
            t.el.className = 'cell revealed mine disabled';
            t.icon.textContent = '💣';
        } else {
            t.el.className = 'cell revealed gem disabled';
            t.icon.textContent = '💎';
        }
    }

    enableControls();
    actionBtn.textContent = 'Play Again';
    actionBtn.className = 'btn-action next';
    actionBtn.disabled = false;
    if (!auto && !autoState.active) showNotif('Cashed out! Won ' + formatCurrency(win), 'win');
    else if (auto && !autoState.active) showNotif('Full Clear! Won ' + formatCurrency(win), 'win');
    playSound(true);
}

// ─── PLACE BET ──────────────────────────────────────────────────────────────────
/*
 * Deducts the bet from balance immediately.
 * If player wins → cashOut adds the win back.
 * If player loses → balance stays deducted, profit reflects the loss.
 */
function placeBet() {
    const bet = parseFloat(betAmount.value);
    if (isNaN(bet) || bet <= 0) { showNotif('Enter a valid bet amount', 'info'); return; }
    if (bet > state.balance) { showNotif('Insufficient balance!', 'info'); return; }
    state.betAmount = bet;
    state.revealedCount = 0;
    state.currentWin = 0;
    state.status = 'playing';
    state.balance -= bet;
    saveToStorage();
    updateBalance();
    resetTiles();
    placeMines();

    for (const t of state.tiles) {
        t.el.className = 'cell';
    }

    actionBtn.textContent = 'Cash Out';
    actionBtn.className = 'btn-action cashout';
    actionBtn.disabled = true;
    multiplierValue.textContent = '1.00x';
    multiplierValue.className = 'multiplier-value';
    winPreview.classList.remove('visible');

    // Lock all game settings during play
    $('minesDown').disabled = true;
    $('minesUp').disabled = true;
    for (const pb of document.querySelectorAll('.mines-presets button')) pb.style.pointerEvents = 'none';
    betAmount.disabled = true;
    $('betHalf').disabled = true;
    $('betDouble').disabled = true;
}

// ─── UI UPDATES ────────────────────────────────────────────────────────────────

function updateBalance() {
    balanceDisplay.textContent = formatCurrency(state.balance);
}

function updateStats() {
    statGames.textContent = state.gamesPlayed;
    statWon.textContent = state.gamesWon;
    const rate = state.gamesPlayed > 0 ? (state.gamesWon / state.gamesPlayed * 100) : 0;
    statRate.textContent = rate.toFixed(1) + '%';
    statProfit.textContent = formatCurrency(Math.abs(state.profit));
    statProfit.className = 'stat-value' + (state.profit > 0 ? ' positive' : state.profit < 0 ? ' negative' : '');
}

// ─── LOCAL STORAGE ─────────────────────────────────────────────────────────────

function saveToStorage() {
    try {
        const data = { balance: state.balance, minesCount: state.minesCount, betAmount: state.betAmount, gamesPlayed: state.gamesPlayed, gamesWon: state.gamesWon, profit: state.profit };
        localStorage.setItem('mines_game_state', JSON.stringify(data));
    } catch (e) {}
}

function loadFromStorage() {
    try {
        const raw = localStorage.getItem('mines_game_state');
        if (raw) {
            const data = JSON.parse(raw);
            if (data.balance !== undefined) state.balance = data.balance;
            if (data.minesCount !== undefined) state.minesCount = Math.max(1, Math.min(24, data.minesCount));
            if (data.betAmount !== undefined) state.betAmount = data.betAmount;
            if (data.gamesPlayed !== undefined) state.gamesPlayed = data.gamesPlayed;
            if (data.gamesWon !== undefined) state.gamesWon = data.gamesWon;
            if (data.profit !== undefined) state.profit = data.profit;
        }
    } catch (e) {}
}

// ─── SOUND EFFECTS (Web Audio API) ─────────────────────────────────────────────

function playSound(win) {
    try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.connect(gain);
        gain.connect(ac.destination);
        gain.gain.value = 0.08;
        if (win) {
            // Ascending C-E-G arpeggio on win
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
            gain2.gain.value = 0.08;
            osc2.frequency.value = 659.25;
            osc2.type = 'sine';
            gain2.gain.setValueAtTime(0.08, ac.currentTime + 0.15);
            gain2.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.5);
            osc2.start(ac.currentTime + 0.15);
            osc2.stop(ac.currentTime + 0.5);
            const osc3 = ac.createOscillator();
            const gain3 = ac.createGain();
            osc3.connect(gain3);
            gain3.connect(ac.destination);
            gain3.gain.value = 0.08;
            osc3.frequency.value = 783.99;
            osc3.type = 'sine';
            gain3.gain.setValueAtTime(0.08, ac.currentTime + 0.3);
            gain3.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.7);
            osc3.start(ac.currentTime + 0.3);
            osc3.stop(ac.currentTime + 0.7);
        } else {
            // Low buzz on loss
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
        const done = autoState.rounds - autoState.roundsLeft;
        progressText.textContent = done + '/' + autoState.rounds;
    } else {
        btn.textContent = 'Start Auto';
        btn.className = 'btn-auto';
        progress.style.display = 'none';
    }
}

// Auto-play loop: place bet → reveal random tiles → cash out at target → repeat
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

        // Pick a random unrevealed tile
        const idx = parseInt(unrevealed[Math.floor(Math.random() * unrevealed.length)].el.dataset.index);
        const tile = state.tiles[idx];

        if (tile.isMine) {
            revealMine(idx);
            if (autoState.stopOnLoss && autoState.active) {
                autoState.active = false;
                updateAutoUI();
                enableControls();
                showNotif('Auto stopped after loss', 'info');
                return;
            }
        } else {
            revealGem(idx);
            const mult = calcMultiplier(state.revealedCount);
            // Cash out if we hit or exceed the target multiplier
            if (mult >= autoState.targetMultiplier && state.status === 'playing') {
                cashOut(false);
                if (autoState.stopOnWin && autoState.active) {
                    autoState.active = false;
                    updateAutoUI();
                    enableControls();
                    showNotif('Auto stopped on win target', 'info');
                    return;
                }
                break;
            }
        }
    }

    if (!autoState.active) return;

    autoState.roundsLeft--;
    updateAutoUI();

    if (autoState.roundsLeft > 0 && state.balance >= parseFloat(betAmount.value)) {
        setTimeout(() => autoPlayRound(), 600);
    } else {
        autoState.active = false;
        updateAutoUI();
        enableControls();
        if (state.balance < parseFloat(betAmount.value)) {
            showNotif('Auto stopped - insufficient balance', 'info');
        } else {
            showNotif('Auto play complete', 'info');
        }
    }
}

function startAuto() {
    const rounds = parseInt($('autoRounds').value);
    const target = parseFloat($('autoTarget').value);
    if (isNaN(rounds) || rounds < 1) { showNotif('Enter valid number of bets', 'info'); return; }
    if (isNaN(target) || target < 1.01) { showNotif('Enter valid target multiplier', 'info'); return; }
    if (parseFloat(betAmount.value) > state.balance) { showNotif('Insufficient balance', 'info'); return; }

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
    showNotif('Auto play stopped', 'info');
}

// ─── INITIALIZATION ────────────────────────────────────────────────────────────

function changeMines(delta) {
    if (state.status !== 'idle') return;
    let m = state.minesCount + delta;
    m = Math.max(1, Math.min(24, m));
    state.minesCount = m;
    minesCount.textContent = m;
    document.querySelectorAll('.mines-presets button').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.mines) === m);
    });
}

function initGame() {
    loadFromStorage();
    buildGrid();
    updateBalance();
    updateStats();
    minesCount.textContent = state.minesCount;
    betAmount.value = state.betAmount;
    enableControls();

    // Main action button: Place Bet / Cash Out / Play Again
    actionBtn.addEventListener('click', () => {
        if (state.status === 'idle' || state.status === 'lost' || state.status === 'won') {
            if (state.balance <= 0) { showNotif('Out of funds! Reset your balance.', 'info'); return; }
            placeBet();
        } else if (state.status === 'playing') {
            cashOut(false);
        }
    });

    // Manual tile click
    grid.addEventListener('click', e => {
        const cell = e.target.closest('.cell');
        if (!cell || state.status !== 'playing') return;
        const idx = parseInt(cell.dataset.index);
        const t = state.tiles[idx];
        if (t.revealed) return;
        if (t.isMine) revealMine(idx);
        else revealGem(idx);
    });

    // Mine selector
    $('minesDown').addEventListener('click', () => changeMines(-1));
    $('minesUp').addEventListener('click', () => changeMines(1));
    document.querySelectorAll('.mines-presets button').forEach(b => {
        b.addEventListener('click', () => {
            if (state.status !== 'idle') return;
            const m = parseInt(b.dataset.mines);
            state.minesCount = m;
            minesCount.textContent = m;
            document.querySelectorAll('.mines-presets button').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
        });
    });

    // Bet controls
    $('betHalf').addEventListener('click', () => {
        if (state.status !== 'idle') return;
        const v = parseFloat(betAmount.value) || 0;
        betAmount.value = Math.max(0.01, v / 2);
        state.betAmount = parseFloat(betAmount.value);
    });
    $('betDouble').addEventListener('click', () => {
        if (state.status !== 'idle') return;
        const v = parseFloat(betAmount.value) || 0;
        betAmount.value = Math.min(state.balance, v * 2 || 1);
        state.betAmount = parseFloat(betAmount.value);
    });

    // Reset balance button
    $('resetBtn').addEventListener('click', () => {
        if (state.status === 'playing') return;
        state.balance = 1000;
        state.profit = 0;
        state.gamesPlayed = 0;
        state.gamesWon = 0;
        saveToStorage();
        updateBalance();
        updateStats();
        showNotif('Balance reset to $1,000.00', 'info');
    });

    // Auto-play toggle
    $('autoToggle').addEventListener('click', () => {
        const body = $('autoBody');
        const toggle = $('autoToggle');
        if (body.style.display === 'none') {
            body.style.display = 'flex';
            toggle.textContent = 'Hide';
        } else {
            body.style.display = 'none';
            toggle.textContent = 'Show';
        }
    });
    $('autoStartBtn').addEventListener('click', () => {
        if (autoState.active) stopAuto();
        else startAuto();
    });

    // Keyboard shortcut: Enter/Space triggers the action button
    document.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            actionBtn.click();
        }
    });
}

initGame();
