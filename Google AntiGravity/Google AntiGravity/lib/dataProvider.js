const https = require('https');

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

// Zero-dependency HTTPS GET client
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yfSymbol}?interval=${interval}&range=${range}`;

  try {
    const rawData = await httpsGet(url);
    const parsed = JSON.parse(rawData);
    return parseYahooFinanceData(parsed);
  } catch (err) {
    console.error(`[DataProvider] Failed to fetch candles for ${symbol}:`, err.message);
    return [];
  }
}

// Fetch 2-3 years historical daily/hourly data from Yahoo Finance for Backtesting
async function fetchHistoricalData(symbol, years = 2) {
  const yfSymbol = SYMBOL_MAP[symbol] || symbol;
  const range = years === 3 ? '3y' : '2y';
  // Standard daily interval for long history backtesting
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yfSymbol}?interval=1d&range=${range}`;

  console.log(`[DataProvider] Downloading ${range} of historical daily data for ${symbol}...`);

  try {
    const rawData = await httpsGet(url);
    const parsed = JSON.parse(rawData);
    const candles = parseYahooFinanceData(parsed);
    console.log(`[DataProvider] Successfully loaded ${candles.length} historical daily candles for ${symbol}`);
    return candles;
  } catch (err) {
    console.error(`[DataProvider] Backtest download failed for ${symbol}:`, err.message);
    return [];
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

module.exports = {
  fetchRecentCandles,
  fetchHistoricalData,
  TastytradeClient,
  SYMBOL_MAP
};
