const net = require('net');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE_PATH = path.join(__dirname, '../optimized_settings.json');
let clients = [];
// Configurable bridge port — set NT8_BRIDGE_PORT=0 to skip binding entirely
// (useful for previewing the dashboard without an NT8 client and without
// colliding with another v2 server already holding the default port).
const BRIDGE_PORT = parseInt(process.env.NT8_BRIDGE_PORT || '4000', 10);

// In-memory rolling candle buffer per symbol, populated by NT8 BAR pushes.
// The decision engine reads from this — replaces the dead Yahoo dataProvider.
const CANDLE_BUFFER_SIZE = 500;
const candleBuffers = {
  'NQ=F': [], 'ES=F': [], 'CL=F': [], 'GC=F': []
};

function _pushCandle(symbol, candle) {
  if (!candleBuffers[symbol]) candleBuffers[symbol] = [];
  const buf = candleBuffers[symbol];
  // Skip duplicate timestamps
  if (buf.length > 0 && buf[buf.length - 1].time === candle.time) return;
  buf.push(candle);
  if (buf.length > CANDLE_BUFFER_SIZE) buf.shift();
}

function getCandles(symbol) {
  return candleBuffers[symbol] || [];
}

// ── NT8 LINKED SYMBOL TRACKER ───────────────────────────────────────────
// When NT8 charts connect, each sends ACCOUNT,SYMBOL,ACCOUNTNAME naming
// the instrument the chart is attached to. We track this per family so
// the bot can detect MINI/MICRO mismatch (e.g., bot in MICRO mode wants
// to fire MNQ=F but the NT8 chart is on NQ=F mini) and refuse to send
// signals that NT8 will reject (its strategy filters by symbol on line
// 1338 of AntigravityBotBridge.cs).
const _nt8LinkedSymbols = {};   // family -> reported symbol (latest)
const _nt8LastSeen = {};        // family -> timestamp of last message
function _registerNT8Symbol(symbol) {
  if (!symbol) return;
  const family = symbol.replace('=F', '').replace(/^M(NQ|ES|CL|GC)$/, '$1');
  _nt8LinkedSymbols[family] = symbol;
  _nt8LastSeen[family] = Date.now();
}
function getLinkedSymbols() {
  // Returns { NQ: 'NQ=F', ES: 'ES=F', CL: 'CL=F', GC: 'GC=F' } or whichever
  // are currently connected. Stale (> 5 min since last message) entries
  // are filtered out — the user disconnected that chart.
  const out = {};
  const STALE_MS = 5 * 60 * 1000;
  const now = Date.now();
  for (const f of Object.keys(_nt8LinkedSymbols)) {
    if (now - (_nt8LastSeen[f] || 0) < STALE_MS) {
      out[f] = _nt8LinkedSymbols[f];
    }
  }
  return out;
}

// Hook the decision engine — called every BAR received once we have ≥220 candles.
// Set via setOnBarCallback() so server.js can wire in the model + executor.
let _onBarCallback = null;
function setOnBarCallback(fn) { _onBarCallback = fn; }

// ─────────────────────────────────────────────────────────────────────────────
// 5-MINUTE AGGREGATOR — bridges live NT8 1-min charts to 5-min-trained models.
//
// Problem this solves: the models in models/*.json were trained on 5-minute
// CSV bars, but most NT8 users keep charts on 1-minute timeframe. If we feed
// 1-min bars directly into the decision engine, features (RSI/MACD/BB/ADX)
// look completely different than what the model expects.
//
// Solution: roll incoming bars (any timeframe) into 5-minute windows server-
// side. When a window completes, emit ONE aggregated 5-min bar to:
//   • the in-memory candleBuffer (drives live decisions)
//   • the training CSV (auto-refresh — replaces manual export)
//   • the registered onBar callback (triggers the decision engine)
//
// Works for any NT8 chart timeframe ≤ 5 minutes (1m, 2m, 3m, 5m). If the
// chart is already 5-min, each bar gets its own slot → passes through.
// ─────────────────────────────────────────────────────────────────────────────
const _pending5Min   = {};   // per-symbol pending 5-min bar
const _last5MinSlot  = {};   // per-symbol slot key of the pending bar

function _slotKey(d) {
  // Identifies a unique 5-min window: YYYY-MM-DD-HH-{slotIdx 0..11}
  const slotIdx = Math.floor(d.getMinutes() / 5);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${slotIdx}`;
}

function _slotStartTime(d) {
  // Truncate to start of the 5-min window (e.g. 21:03 → 21:00)
  const start = new Date(d);
  start.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  return start;
}

function _formatCsvTimestamp(d) {
  // Match the existing CSV format: "2026-05-25 21:00:00-07:00"
  const pad = (n) => String(n).padStart(2, '0');
  const off = d.getTimezoneOffset();                // minutes WEST of UTC (PT=+420)
  const sign = off > 0 ? '-' : '+';
  const aoff = Math.abs(off);
  const tz = `${sign}${pad(Math.floor(aoff / 60))}:${pad(aoff % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tz}`;
}

function _appendCsvRow(symbol, candle) {
  const baseName = symbol.replace('=F', '').toLowerCase();
  const file = path.join(__dirname, '..', 'data', `${baseName}_5min_nt8.csv`);
  try {
    const t = new Date(candle.time);
    if (isNaN(t.getTime())) return;
    // Use the START of the slot as the row timestamp (matches training CSV convention)
    const slotStart = _slotStartTime(t);
    const dt = _formatCsvTimestamp(slotStart);
    const row = `${dt},${candle.open},${candle.high},${candle.low},${candle.close},${Math.round(candle.volume || 0)}\n`;
    fs.appendFileSync(file, row, 'utf-8');
  } catch (e) {
    console.error(`[NT8Bridge] CSV auto-append failed for ${symbol}: ${e.message}`);
  }
}

// Mini ↔ micro mapping for routing — micro charts (MNQ/MES/MCL/MGC)
// send bars that should be merged into the SAME buffer as their mini
// counterpart (NQ/ES/CL/GC) because they're the same underlying
// instrument at the same price. Bug 2026-05-26: when user switched chart
// from NQ → MNQ, live bars piled up in candleBuffers['MNQ=F'] (empty)
// while the bootstrapped 250 bars sat in candleBuffers['NQ=F']. The
// processBarUpdate callback got <220 candles → early-returned silently.
function _familyMiniKey(symbol) {
  if (!symbol) return symbol;
  if (symbol.startsWith('MNQ')) return 'NQ=F';
  if (symbol.startsWith('MES')) return 'ES=F';
  if (symbol.startsWith('MCL')) return 'CL=F';
  if (symbol.startsWith('MGC')) return 'GC=F';
  return symbol;
}

function _flushPending(symbol) {
  const completed = _pending5Min[symbol];
  if (!completed) {
    console.log(`[NT8Bridge] _flushPending(${symbol}) — no pending bar, skip`);
    return;
  }
  // Route to the family-mini buffer so micro charts contribute to the
  // same time series as their mini counterpart (they're the same instrument).
  const bufKey = _familyMiniKey(symbol);
  _pushCandle(bufKey, completed);          // feeds in-memory decision buffer
  _appendCsvRow(bufKey, completed);        // keeps training data fresh
  console.log(`[NT8Bridge] _flushPending(${symbol}) → bufKey=${bufKey}, buf.length=${(candleBuffers[bufKey] || []).length}, hasCallback=${!!_onBarCallback}`);
  if (_onBarCallback) {
    try {
      _onBarCallback(bufKey, candleBuffers[bufKey]);
      console.log(`[NT8Bridge] _onBarCallback(${bufKey}) returned OK`);
    } catch (e) {
      console.error('[NT8Bridge] onBar callback error:', e.message, e.stack);
    }
  }
}

function _aggregateBar(symbol, rawCandle) {
  const t = new Date(rawCandle.time);
  if (isNaN(t.getTime())) return;
  const slot = _slotKey(t);

  // Same slot as the pending bar → just update aggregates (high/low/close/vol)
  if (_last5MinSlot[symbol] === slot && _pending5Min[symbol]) {
    const p = _pending5Min[symbol];
    p.high   = Math.max(p.high, rawCandle.high);
    p.low    = Math.min(p.low,  rawCandle.low);
    p.close  = rawCandle.close;
    p.volume = (p.volume || 0) + (rawCandle.volume || 0);
    return;
  }

  // Slot changed → flush the previous 5-min bar (if any) and start a new one.
  // The flush triggers decision-engine inference + CSV append + onBar callback.
  _flushPending(symbol);
  _pending5Min[symbol] = {
    time:   _formatCsvTimestamp(_slotStartTime(t)),
    open:   rawCandle.open,
    high:   rawCandle.high,
    low:    rawCandle.low,
    close:  rawCandle.close,
    volume: rawCandle.volume || 0
  };
  _last5MinSlot[symbol] = slot;
}

// Bootstrap buffers from local NT8 CSVs on server boot so the decision engine
// can fire on the FIRST live bar instead of waiting ~18 hours for 220 bars to
// accumulate. Loads last 250 bars per family from data/{sym}_5min_nt8.csv.
function bootstrapBuffersFromCsv() {
  const dataDir = path.join(__dirname, '..', 'data');
  const families = [
    { sym: 'NQ=F', file: 'nq_5min_nt8.csv' },
    { sym: 'ES=F', file: 'es_5min_nt8.csv' },
    { sym: 'CL=F', file: 'cl_5min_nt8.csv' },
    { sym: 'GC=F', file: 'gc_5min_nt8.csv' }
  ];
  const SEED_BARS = 250;  // enough headroom over the 220-bar feature window
  let totalLoaded = 0;
  for (const { sym, file } of families) {
    const filePath = path.join(dataDir, file);
    if (!fs.existsSync(filePath)) {
      console.warn(`[NT8Bridge] Bootstrap: ${file} not found — ${sym} will wait for live bars to fill buffer.`);
      continue;
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
      const lines = text.split(/\r?\n/);
      const bars = [];
      // Read backwards from EOF until we have SEED_BARS valid rows
      for (let i = lines.length - 1; i >= 1 && bars.length < SEED_BARS; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split(',');
        if (parts.length < 6) continue;
        const time = parts[0];
        const open = parseFloat(parts[1]);
        const high = parseFloat(parts[2]);
        const low  = parseFloat(parts[3]);
        const close = parseFloat(parts[4]);
        const volume = parseFloat(parts[5]);
        if (isNaN(open) || isNaN(close)) continue;
        bars.unshift({ time, open, high, low, close, volume });
      }
      candleBuffers[sym] = bars;
      totalLoaded += bars.length;
      console.log(`[NT8Bridge] Bootstrap: seeded ${bars.length} bars for ${sym} (last bar: ${bars[bars.length - 1]?.time || 'none'}).`);
    } catch (e) {
      console.error(`[NT8Bridge] Bootstrap failed for ${sym}:`, e.message);
    }
  }
  console.log(`[NT8Bridge] Bootstrap complete: ${totalLoaded} total bars loaded across 4 families. Engine ready to fire on first live NT8 bar push.`);
}

function sendParamsToNT8(socket) {
  if (!fs.existsSync(SETTINGS_FILE_PATH)) return;
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8'));
    const symbols = ['NQ=F', 'ES=F', 'CL=F', 'GC=F'];
    for (const sym of symbols) {
      const symSettings = settings[sym];
      if (symSettings) {
        const rth = symSettings.RTH || { emaFast: 8, emaSlow: 20 };
        const eth = symSettings.ETH || { bbStdDev: 2.2, rsiOversold: 33, rsiOverbought: 67 };
        const msg = `PARAMS,${sym},${rth.emaFast},${rth.emaSlow},${eth.bbStdDev},${eth.rsiOversold},${eth.rsiOverbought}\n`;
        socket.write(msg);
      }
    }

    // Sync active enabled state to NT8
    const { getPortfolioState } = require('./paperEngine');
    const state = getPortfolioState();
    for (const sym of symbols) {
      const acc = state.accounts[sym];
      if (acc) {
        const msg = `STATUS,${sym},${acc.enabled ? 1 : 0}\n`;
        socket.write(msg);
      }
    }
  } catch (e) {
    console.error('[NT8Bridge] Error sending optimized params and status:', e.message);
  }
}

function broadcastParamsToNT8() {
  if (clients.length === 0) return;
  if (!fs.existsSync(SETTINGS_FILE_PATH)) return;
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8'));
    const symbols = ['NQ=F', 'ES=F', 'CL=F', 'GC=F'];
    for (const sym of symbols) {
      const symSettings = settings[sym];
      if (symSettings) {
        const rth = symSettings.RTH || { emaFast: 8, emaSlow: 20 };
        const eth = symSettings.ETH || { bbStdDev: 2.2, rsiOversold: 33, rsiOverbought: 67 };
        const msg = `PARAMS,${sym},${rth.emaFast},${rth.emaSlow},${eth.bbStdDev},${eth.rsiOversold},${eth.rsiOverbought}\n`;
        clients.forEach((socket) => {
          try { socket.write(msg); } catch (e) {}
        });
      }
    }
  } catch (e) {
    console.error('[NT8Bridge] Error broadcasting params:', e.message);
  }
}

function startNT8BridgeServer() {
  if (BRIDGE_PORT === 0) {
    console.log('[NT8Bridge] Disabled (NT8_BRIDGE_PORT=0) — no TCP listener bound.');
    return;
  }
  const server = net.createServer((socket) => {
    console.log(`[NT8Bridge] New NT8 connection from ${socket.remoteAddress}:${socket.remotePort}`);
    clients.push(socket);

    // Send a welcome handshake packet
    socket.write('CONNECTED,Antigravity V1 Ready\n');
    sendParamsToNT8(socket);

    // Replay the most recent brain state for each family so the chart's
    // brain panel populates immediately instead of waiting up to 5 min
    // for the next bar flush. Fix 2026-05-26: server warmup broadcasts
    // ran BEFORE this listener accepted connections — they were skipped
    // with clients.length=0. The strategy filter accepts the first
    // matching-family packet; off-family packets are silently ignored.
    setTimeout(() => {
      try {
        for (const fam of Object.keys(_lastBrainStateByFamily)) {
          const cachedState = _lastBrainStateByFamily[fam];
          if (!cachedState) continue;
          const msg = 'BRAIN\t' + JSON.stringify(cachedState) + '\n';
          try {
            socket.write(Buffer.from(msg, 'utf8'));
            console.log(`[NT8Bridge] Replayed cached brain state (${fam}) to new client`);
          } catch (e) {
            console.error(`[NT8Bridge] Replay write failed: ${e.message}`);
          }
        }
      } catch (e) { /* non-fatal */ }
    }, 500);   // 500ms delay so client has read the welcome handshake first

    socket.on('data', (data) => {
      const lines = data.toString().split(/\r?\n/);
      for (const rawLine of lines) {
        const msg = rawLine.trim();
        if (!msg) continue;
        console.log(`[NT8Bridge] Received from NT8: ${msg}`);
        
        // Heartbeat handling
        if (msg === 'PING') {
          try { socket.write('PONG\n'); } catch (e) {}
        } 
        // Account mapping from NT8 chart strategy
        else if (msg.startsWith('ACCOUNT,')) {
          const parts = msg.split(',');
          if (parts.length >= 3) {
            const symbol = parts[1].trim();
            const accountNumber = parts[2].trim();
            _registerNT8Symbol(symbol);
            const { updateAccountNumber } = require('./paperEngine');
            const success = updateAccountNumber(symbol, accountNumber);
            if (success) {
              console.log(`[NT8Bridge] Dynamically updated account number for ${symbol} to ${accountNumber} from NT8 chart!`);
            } else {
              console.log(`[NT8Bridge] Failed to update account number for ${symbol} (symbol not recognized).`);
            }
          }
        }
        // BAR push from NT8 chart strategy — feeds the 5-min aggregator which
        // rolls incoming bars (any timeframe ≤ 5min) into 5-min windows to
        // match the model training timeframe, then drives the decision engine
        // and auto-appends to the training CSV.
        // Format: BAR,SYMBOL,time,open,high,low,close,volume
        else if (msg.startsWith('BAR,')) {
          const parts = msg.split(',');
          if (parts.length >= 8) {
            const symbol = parts[1].trim();
            // BAR proves the chart is alive — refresh the liveness timestamp so
            // getLinkedSymbols() doesn't evict this entry after 5 min. (ACCOUNT
            // is only sent once at connect; without this the stale-check wrongly
            // reports no chart and blocks all live signals after 5 minutes.)
            // Also register the symbol if ACCOUNT was never received (edge case:
            // server restarted mid-session, chart never re-sent ACCOUNT).
            _registerNT8Symbol(symbol);
            const candle = {
              time: parts[2].trim(),
              open: parseFloat(parts[3]),
              high: parseFloat(parts[4]),
              low: parseFloat(parts[5]),
              close: parseFloat(parts[6]),
              volume: parseFloat(parts[7]) || 0
            };
            if (!isNaN(candle.close)) {
              _aggregateBar(symbol, candle);
            }
          }
        }
        // Metrics sync from NT8 chart strategy
        // Format v1: METRICS,symbol,balance,realized,unrealized
        // Format v2: METRICS,symbol,balance,realized,unrealized,marketPosition,qty,avgPrice
        //   marketPosition: Long|Short|Flat (authoritative direction — fixes
        //   the legacy "direction from sign of P&L" bug)
        else if (msg.startsWith('METRICS,')) {
          const parts = msg.split(',');
          if (parts.length >= 5) {
            const symbol = parts[1].trim();
            // METRICS proves chart liveness — keep the linked-symbol entry fresh
            _registerNT8Symbol(symbol);
            const balance = parseFloat(parts[2]);
            const realized = parseFloat(parts[3]);
            const unrealized = parseFloat(parts[4]);
            let positionInfo = null;
            if (parts.length >= 8) {
              positionInfo = {
                marketPosition: parts[5].trim(),
                qty: parseInt(parts[6], 10) || 0,
                avgPrice: parseFloat(parts[7]) || 0
              };
            }
            const { updateLiveMetricsFromNT8 } = require('./paperEngine');
            updateLiveMetricsFromNT8(symbol, balance, realized, unrealized, positionInfo);
            // Seed daily P&L guard from NT8 realized PnL on first METRICS
            // update after a server restart. Bridges the loss-cap gap when a
            // previous session already incurred losses today.
            try {
              const { seedDailyPnLFromNt8 } = require('./decisionEngine');
              seedDailyPnLFromNt8(symbol, realized);
            } catch (e) { /* non-fatal */ }
          }
        }
      }
    });

    socket.on('close', () => {
      console.log('[NT8Bridge] NT8 connection closed.');
      clients = clients.filter(c => c !== socket);
    });

    socket.on('error', (err) => {
      console.error('[NT8Bridge] Socket error:', err.message);
      clients = clients.filter(c => c !== socket);
    });
  });

  server.listen(BRIDGE_PORT, '0.0.0.0', () => {
    console.log(`[NT8Bridge] TCP Bridge server running. Listening on 0.0.0.0:${BRIDGE_PORT} for NT8 connections...`);
    console.log(`[NT8Bridge] Share this machine's IP (e.g., http://<YOUR_MAC_IP>:4000) with NinjaTrader 8 on Windows.`);
  });
}

// Broadcasts a JSON brain-state snapshot to all NT8 clients after each closed bar.
// The .cs parses this into the on-chart Brain Panel overlay.
// Format: BRAIN<TAB><json>\n
// Using TAB instead of comma because the JSON payload contains commas.
//
// DIAGNOSTIC: temporary verbose logging to track brain delivery to NT8.
// Added 2026-05-26 to debug why brain panels stayed empty on user's
// charts despite the server-side broadcast call firing.
// Cache the most recent brain state per family so newly-connecting NT8
// clients can get an immediate snapshot (instead of waiting up to 5 min
// for the next bar flush).
const _lastBrainStateByFamily = {};
let _brainBroadcastCount = 0;

function getLastBrainStates() { return _lastBrainStateByFamily; }

function broadcastBrainState(state) {
  _brainBroadcastCount++;
  // Cache for replay on new connections
  if (state && state.family) {
    _lastBrainStateByFamily[state.family] = state;
  }
  if (clients.length === 0) {
    console.log(`[NT8Bridge] BRAIN broadcast #${_brainBroadcastCount} SKIPPED — clients.length=0 (NT8 not connected yet)`);
    return;
  }
  try {
    const msg = 'BRAIN\t' + JSON.stringify(state) + '\n';
    const buf = Buffer.from(msg, 'utf8');
    let okCount = 0, failCount = 0;
    clients.forEach((c, idx) => {
      try {
        const ok = c.write(buf);
        if (ok) okCount++;
        else failCount++;
      } catch (e) {
        failCount++;
        console.log(`[NT8Bridge] BRAIN write to client[${idx}] FAILED: ${e.message}`);
      }
    });
    // TEMP DIAG — log EVERY broadcast until we pin down the missing-data issue
    console.log(`[NT8Bridge] BRAIN broadcast #${_brainBroadcastCount} → ${state.symbol} (${buf.length}B) | ok=${okCount} fail=${failCount} clients=${clients.length}`);
  } catch (e) {
    console.error('[NT8Bridge] broadcastBrainState error:', e.message);
  }
}

// Sends a trade execution signal to all connected NinjaTrader 8 clients over TCP
function sendSignalToNT8(action, symbol, qty, entryPrice, stopLoss, takeProfit, strategyName = 'Unknown', breakevenPrice = 0, trailingPrice = 0) {
  if (clients.length === 0) {
    console.log('[NT8Bridge] No NT8 clients connected. Trade signal simulated locally only.');
    return;
  }

  // Format: ACTION,SYMBOL,QTY,PRICE,SL,TP,STRATEGY,BREAKEVEN,TRAILING
  // E.g., BUY,NQ=F,2,18500.50,18400.00,18700.00,Fair Value Gap,18550.00,18600.00
  // E.g., CLOSE,NQ=F
  // E.g., STATUS,NQ=F,0
  let message = '';
  if (action === 'CLOSE') {
    message = `CLOSE,${symbol}\n`;
  } else if (action === 'STATUS') {
    message = `STATUS,${symbol},${qty}\n`; // We pass status 1/0 in qty argument
  } else {
    message = `${action.toUpperCase()},${symbol},${qty},${entryPrice.toFixed(2)},${stopLoss.toFixed(2)},${takeProfit.toFixed(2)},${strategyName},${breakevenPrice.toFixed(2)},${trailingPrice.toFixed(2)}\n`;
  }

  console.log(`[NT8Bridge] Broadcasting execution signal to connected NT8 clients: ${message.trim()}`);

  clients.forEach((client) => {
    try {
      client.write(message);
    } catch (err) {
      console.error('[NT8Bridge] Failed to write signal to client:', err.message);
    }
  });
}

// Returns true if at least one NT8 chart is connected over the TCP bridge.
// Used by /api/fire and /api/close to give the operator a clear error instead
// of silently accepting the command and never delivering it to NinjaTrader.
function isNT8Connected() {
  return clients.length > 0;
}

module.exports = {
  startNT8BridgeServer,
  sendSignalToNT8,
  broadcastParamsToNT8,
  broadcastBrainState,
  getCandles,
  setOnBarCallback,
  bootstrapBuffersFromCsv,
  getLinkedSymbols,
  isNT8Connected
};
