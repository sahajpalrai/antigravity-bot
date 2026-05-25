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

// Hook the decision engine — called every BAR received once we have ≥220 candles.
// Set via setOnBarCallback() so server.js can wire in the model + executor.
let _onBarCallback = null;
function setOnBarCallback(fn) { _onBarCallback = fn; }

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
            const { updateAccountNumber } = require('./paperEngine');
            const success = updateAccountNumber(symbol, accountNumber);
            if (success) {
              console.log(`[NT8Bridge] Dynamically updated account number for ${symbol} to ${accountNumber} from NT8 chart!`);
            } else {
              console.log(`[NT8Bridge] Failed to update account number for ${symbol} (symbol not recognized).`);
            }
          }
        }
        // BAR push from NT8 chart strategy — populates the candle buffer
        // and notifies the registered onBar callback so the decision engine
        // can produce a signal.
        // Format: BAR,SYMBOL,time,open,high,low,close,volume
        else if (msg.startsWith('BAR,')) {
          const parts = msg.split(',');
          if (parts.length >= 8) {
            const symbol = parts[1].trim();
            const candle = {
              time: parts[2].trim(),
              open: parseFloat(parts[3]),
              high: parseFloat(parts[4]),
              low: parseFloat(parts[5]),
              close: parseFloat(parts[6]),
              volume: parseFloat(parts[7]) || 0
            };
            if (!isNaN(candle.close)) {
              _pushCandle(symbol, candle);
              if (_onBarCallback) {
                try { _onBarCallback(symbol, candleBuffers[symbol]); }
                catch (e) { console.error('[NT8Bridge] onBar callback error:', e.message); }
              }
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

module.exports = {
  startNT8BridgeServer,
  sendSignalToNT8,
  broadcastParamsToNT8,
  getCandles,
  setOnBarCallback
};
