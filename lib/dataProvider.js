const https = require('https');
const fs = require('fs');
const path = require('path');

// Maps standard futures to Yahoo Finance symbols
const SYMBOL_MAP = {
  'NQ': 'NQ=F', // E-mini Nasdaq-100 Future
  'ES': 'ES=F', // E-mini S&P 500 Future
  'CL': 'CL=F', // Crude Oil Future
  'GC': 'GC=F', // Gold Future
  'NQ=F': 'NQ=F',
  'ES=F': 'ES=F',
  'CL=F': 'CL=F',
  'GC=F': 'GC=F'
};

// Zero-dependency HTTPS GET client (Impersonates Chrome to bypass rate-limiting filters)
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'max-age=0',
        'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP Status ${res.statusCode}`));
          return;
        }
        resolve(data);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// Fetch 1-minute real-time/recent OHLCV candles from Yahoo Finance
async function fetchRecentCandles(symbol, interval = '1m', range = '1d') {
  const yfSymbol = SYMBOL_MAP[symbol] || symbol;
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${yfSymbol}?interval=${interval}&range=${range}`;

  try {
    const rawData = await httpsGet(url);
    const parsed = JSON.parse(rawData);
    return parseYahooFinanceData(parsed);
  } catch (err) {
    console.error(`[DataProvider] Failed to fetch candles for ${symbol}:`, err.message);
    return [];
  }
}

// Parse highly accurate local historical NinjaTrader 8 exports (comma, semicolon, or tab delimited)
function loadLocalNT8Data(symbol) {
  const baseName = symbol.replace('=F', '');
  const dataDir = path.join(__dirname, '../data');
  const possibleFiles = [
    path.join(dataDir, `${symbol}.csv`),
    path.join(dataDir, `${symbol}.txt`),
    path.join(dataDir, `${baseName}.csv`),
    path.join(dataDir, `${baseName}.txt`),
    path.join(dataDir, `${baseName.toLowerCase()}_5min_nt8.csv`),
    path.join(dataDir, `${baseName.toLowerCase()}_5min_nt8.txt`),
    path.join(dataDir, `${baseName.toUpperCase()}_5min_nt8.csv`),
    path.join(dataDir, `${baseName.toUpperCase()}_5min_nt8.txt`),
    path.join(dataDir, `${baseName.toLowerCase()}_1min_nt8.csv`),
    path.join(dataDir, `${baseName.toLowerCase()}_1min_nt8.txt`),
    path.join(dataDir, `${baseName.toUpperCase()}_1min_nt8.csv`),
    path.join(dataDir, `${baseName.toUpperCase()}_1min_nt8.txt`)
  ];

  let filePath = null;
  for (const f of possibleFiles) {
    if (fs.existsSync(f)) {
      filePath = f;
      break;
    }
  }

  if (!filePath) {
    return null;
  }

  console.log(`[DataProvider] Loading local historical NinjaTrader 8 data from ${filePath}...`);
  try {
    const rawContent = fs.readFileSync(filePath, 'utf-8');
    const lines = rawContent.split(/\r?\n/);
    const candles = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.toLowerCase().includes('time') || trimmed.toLowerCase().includes('date')) {
        continue; // Skip comments and headers
      }

      let parts = [];
      if (trimmed.includes(';')) parts = trimmed.split(';');
      else if (trimmed.includes('\t')) parts = trimmed.split('\t');
      else if (trimmed.includes(',')) parts = trimmed.split(',');
      else parts = trimmed.split(/\s+/);

      if (parts.length < 5) continue;

      const dateTimeStr = parts[0].trim();
      const open = parseFloat(parts[1]);
      const high = parseFloat(parts[2]);
      const low = parseFloat(parts[3]);
      const close = parseFloat(parts[4]);
      const volume = parts[5] ? parseFloat(parts[5]) : 0;

      if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) continue;

      let dateObj = null;
      if (dateTimeStr.includes('-') || dateTimeStr.includes('/')) {
        dateObj = new Date(dateTimeStr);
      } else if (dateTimeStr.length >= 15) {
        // Format: YYYYMMDD HHMMSS
        const y = dateTimeStr.slice(0, 4);
        const m = dateTimeStr.slice(4, 6);
        const d = dateTimeStr.slice(6, 8);
        const hh = dateTimeStr.slice(9, 11);
        const mm = dateTimeStr.slice(11, 13);
        const ss = dateTimeStr.slice(13, 15);
        dateObj = new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
      } else {
        dateObj = new Date(dateTimeStr);
      }

      if (isNaN(dateObj.getTime())) continue;

      candles.push({
        time: dateObj.toISOString(),
        open,
        high,
        low,
        close,
        volume,
        isGreen: close >= open
      });
    }

    // Sort chronologically
    candles.sort((a, b) => new Date(a.time) - new Date(b.time));

    console.log(`[DataProvider] Successfully loaded ${candles.length} historical candles from local NinjaTrader 8 file.`);
    return candles;
  } catch (err) {
    console.error(`[DataProvider] Error parsing local NinjaTrader historical file:`, err.message);
    return null;
  }
}

// Fetch 2-3 years historical daily/hourly data from Yahoo Finance for Backtesting (Local prioritized)
async function fetchHistoricalData(symbol, years = 2) {
  // 1. Try highly accurate local NinjaTrader 8 export first
  const localData = loadLocalNT8Data(symbol);
  if (localData && localData.length > 0) {
    localData.source = 'Local NinjaTrader 8 Export';
    return localData;
  }

  // 2. Online Fallback to Yahoo Finance query2
  const yfSymbol = SYMBOL_MAP[symbol] || symbol;
  const range = years === 3 ? '3y' : '2y';
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${yfSymbol}?interval=1d&range=${range}`;

  console.log(`[DataProvider] Local NT8 export not found. Downloading ${range} of Yahoo Finance historical daily data for ${symbol}...`);

  try {
    const rawData = await httpsGet(`https://query2.finance.yahoo.com/v8/finance/chart/${yfSymbol}?interval=1d&range=${range}`);
    const parsed = JSON.parse(rawData);
    const candles = parseYahooFinanceData(parsed);
    console.log(`[DataProvider] Successfully loaded ${candles.length} historical daily candles from Yahoo Finance for ${symbol}`);
    candles.source = 'Yahoo Finance (Daily API)';
    return candles;
  } catch (err) {
    console.error(`[DataProvider] Backtest download failed for ${symbol}:`, err.message);
    const empty = [];
    empty.source = 'Failed (No Data)';
    return empty;
  }
}

// Parsers Yahoo Finance JSON structure into standard clean candle array
function parseYahooFinanceData(json) {
  try {
    const chart = json.chart;
    if (!chart || !chart.result || chart.result.length === 0) return [];
    
    const result = chart.result[0];
    const timestamps = result.timestamp;
    const quote = result.indicators.quote[0];
    
    if (!timestamps || !quote) return [];

    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      const open = quote.open[i];
      const high = quote.high[i];
      const low = quote.low[i];
      const close = quote.close[i];
      const volume = quote.volume[i] || 0;

      // Filter out null values (Yahoo sometimes returns nulls for market halt intervals)
      if (open !== null && high !== null && low !== null && close !== null) {
        candles.push({
          time: new Date(timestamps[i] * 1000).toISOString(),
          open,
          high,
          low,
          close,
          volume,
          isGreen: close >= open
        });
      }
    }

    return candles;
  } catch (e) {
    console.error('[DataProvider] Parsing error:', e.message);
    return [];
  }
}

// A lightweight Tastytrade API Client stub
// Stores authentication state and allows future live extension
class TastytradeClient {
  constructor() {
    this.baseUrl = process.env.TASTYTRADE_BASE_URL || 'https://api.tastyworks.com';
    this.clientId = process.env.TASTYTRADE_CLIENT_ID;
    this.clientSecret = process.env.TASTYTRADE_CLIENT_SECRET;
    this.authToken = null;
    this.authenticated = false;
  }

  async authenticate() {
    if (!this.clientId || !this.clientSecret) {
      console.log('[Tastytrade] Credentials missing in .env, running in Yahoo Finance fallback mode.');
      return false;
    }

    console.log('[Tastytrade] Connecting to Tastyworks API...');
    
    // Stub HTTP call for authorization session
    // Since we want standard portability, we write a skeleton that handles authorization
    const payload = JSON.stringify({
      login: this.clientId,
      password: this.clientSecret
    });

    const options = {
      hostname: 'api.tastyworks.com',
      port: 443,
      path: '/sessions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    return new Promise((resolve) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 201 || res.statusCode === 200) {
            try {
              const response = JSON.parse(data);
              this.authToken = response.data['session-token'];
              this.authenticated = true;
              console.log('[Tastytrade] Successfully authenticated!');
              resolve(true);
            } catch (e) {
              resolve(false);
            }
          } else {
            console.log(`[Tastytrade] Failed to authenticate. Status: ${res.statusCode}. Falling back to Yahoo Finance.`);
            resolve(false);
          }
        });
      });

      req.on('error', (err) => {
        console.error('[Tastytrade] Authentication request error:', err.message);
        resolve(false);
      });

      req.write(payload);
      req.end();
    });
  }
}

// Unified data retriever: attempts Tastytrade first, falls back to Yahoo Finance query2 (Local prioritized)
async function fetchCandlesWithFallback(symbol, interval = '5m', range = '1mo') {
  console.log(`[DataProvider] Fetching ${range} of ${interval} candles for ${symbol}...`);
  
  // 1. Try highly accurate local NinjaTrader 8 export first
  const localData = loadLocalNT8Data(symbol);
  if (localData && localData.length > 0) {
    // Slice only the most recent wicks matching the requested range
    // For '1mo' of 5m candles, we want about 7000 candles to cover the 30-day window
    const targetCount = range === '1mo' ? 7000 : (range === '5d' ? 1200 : localData.length);
    let sliced;
    if (localData.length > targetCount) {
      console.log(`[DataProvider] Slicing last ${targetCount} candles from local export to match range '${range}'`);
      sliced = localData.slice(-targetCount);
    } else {
      console.log(`[DataProvider] Successfully loaded ${localData.length} candles from local NinjaTrader 8 file.`);
      sliced = localData;
    }
    sliced.source = 'Local NinjaTrader 8 Export';
    return sliced;
  }

  // 2. Try Tastytrade API
  const ttClient = new TastytradeClient();
  let ttAuth = false;
  
  try {
    ttAuth = await ttClient.authenticate();
  } catch (err) {
    console.warn(`[DataProvider] Tastytrade authentication check encountered an error: ${err.message}`);
  }
  
  if (ttAuth) {
    console.log(`[DataProvider] Attempting to retrieve historical candles from Tastytrade API for ${symbol}...`);
    try {
      // Tastytrade historical futures candles require live dxFeed subscription tokens and active socket connections.
      // Since specific custom dxFeed sub endpoints are not configured, we throw to trigger the Yahoo fallback.
      throw new Error("Tastytrade historical candle endpoint requires active dxFeed subscription token");
    } catch (err) {
      console.warn(`[DataProvider] Tastytrade candle fetch failed/unimplemented: ${err.message}. Falling back to Yahoo Finance...`);
    }
  } else {
    console.log(`[DataProvider] Tastytrade not configured or auth skipped. Falling back to Yahoo Finance...`);
  }

  // 3. Fallback to Yahoo Finance query2
  const candles = await fetchRecentCandles(symbol, interval, range);
  if (candles && candles.length > 0) {
    console.log(`[DataProvider] Successfully loaded ${candles.length} candles from Yahoo Finance.`);
    candles.source = 'Yahoo Finance (Live API)';
    return candles;
  }
  
  console.error(`[DataProvider] Failed to retrieve any candle data for ${symbol}.`);
  const empty = [];
  empty.source = 'Failed (No Data)';
  return empty;
}

module.exports = {
  fetchRecentCandles,
  fetchHistoricalData,
  fetchCandlesWithFallback,
  TastytradeClient,
  SYMBOL_MAP
};

