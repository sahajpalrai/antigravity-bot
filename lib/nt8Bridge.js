const net = require('net');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE_PATH = path.join(__dirname, '../optimized_settings.json');
let clients = [];
const BRIDGE_PORT = 4000;

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
  } catch (e) {
    console.error('[NT8Bridge] Error sending optimized params:', e.message);
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
  const server = net.createServer((socket) => {
    console.log(`[NT8Bridge] New NT8 connection from ${socket.remoteAddress}:${socket.remotePort}`);
    clients.push(socket);

    // Send a welcome handshake packet
    socket.write('CONNECTED,Antigravity V1 Ready\n');
    sendParamsToNT8(socket);

    socket.on('data', (data) => {
      const msg = data.toString().trim();
      console.log(`[NT8Bridge] Received from NT8: ${msg}`);
      
      // Heartbeat handling
      if (msg === 'PING') {
        socket.write('PONG\n');
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
function sendSignalToNT8(action, symbol, qty, entryPrice, stopLoss, takeProfit, strategyName = 'Unknown') {
  if (clients.length === 0) {
    console.log('[NT8Bridge] No NT8 clients connected. Trade signal simulated locally only.');
    return;
  }

  // Format: ACTION,SYMBOL,QTY,PRICE,SL,TP,STRATEGY
  // E.g., BUY,NQ=F,2,18500.50,18400.00,18700.00,Fair Value Gap
  // E.g., CLOSE,NQ=F
  let message = '';
  if (action === 'CLOSE') {
    message = `CLOSE,${symbol}\n`;
  } else {
    message = `${action.toUpperCase()},${symbol},${qty},${entryPrice.toFixed(2)},${stopLoss.toFixed(2)},${takeProfit.toFixed(2)},${strategyName}\n`;
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
  broadcastParamsToNT8
};
