const http = require('http');
const axios = require('axios');
const crypto = require('crypto');

const API_KEY    = process.env.BINANCE_API_KEY    || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const PAPER_MODE = process.env.PAPER_MODE !== 'false';
const NOTIFY_URL = process.env.NOTIFY_URL || '';
const PORT       = process.env.PORT || 3000;
const BASE_URL   = 'https://api.binance.com';

const CAPITAL_TOTAL   = 300;
const MAX_PER_TRADE   = 30;
const MAX_POSITIONS   = 6;
const MAX_CAPITAL_USE = 0.90;
const PAUSE_LOSS      = 60;
const PAUSE_PROFIT    = 150;

const ASSETS = [
  { symbol: 'BTCUSDT',  name: 'Bitcoin',   profile: 'aggressive' },
  { symbol: 'ETHUSDT',  name: 'Ethereum',  profile: 'aggressive' },
  { symbol: 'SOLUSDT',  name: 'Solana',    profile: 'aggressive' },
  { symbol: 'XRPUSDT',  name: 'XRP',       profile: 'aggressive' },
  { symbol: 'ADAUSDT',  name: 'Cardano',   profile: 'aggressive' },
  { symbol: 'DOGEUSDT', name: 'Dogecoin',  profile: 'aggressive' },
  { symbol: 'BNBUSDT',  name: 'BNB',       profile: 'aggressive' },
  { symbol: 'AVAXUSDT', name: 'Avalanche', profile: 'aggressive' },
  { symbol: 'MATICUSDT',name: 'Polygon',   profile: 'aggressive' },
  { symbol: 'LINKUSDT', name: 'Chainlink', profile: 'aggressive' },
  { symbol: 'DOTUSDT',  name: 'Polkadot',  profile: 'aggressive' },
  { symbol: 'UNIUSDT',  name: 'Uniswap',   profile: 'aggressive' },
];

// Perfil super agressivo
const PROFILE = {
  rsiBuy: 45,      // compra quando RSI < 45 (muito mais frequente)
  rsiSell: 60,     // vende quando RSI > 60
  dropPct: 0.3,    // qualquer queda de 0.3% já dispara
  takeProfit: 0.02, // realiza lucro em +2%
  stopLoss: 0.02,   // stop em -2%
};

let positions  = {};
let totalPnL   = 0;
let paused     = false;
let lastCycle  = null;
let tradeCount = 0;

function log(msg) {
  const ts = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  console.log(`[${ts}] ${msg}`);
}

async function notify(title, body) {
  if (!NOTIFY_URL) return;
  try { await axios.post(NOTIFY_URL + '/test-send', { title, body }, { timeout: 5000 }); } catch(e) {}
}

async function apiGet(path, params = {}) {
  const res = await axios.get(BASE_URL + path, { params, timeout: 8000 });
  return res.data;
}

async function apiPost(path, params = {}) {
  const ts = Date.now();
  const qstr = Object.entries({ ...params, timestamp: ts }).map(([k,v]) => `${k}=${v}`).join('&');
  const sig = crypto.createHmac('sha256', API_SECRET).update(qstr).digest('hex');
  const res = await axios.post(`${BASE_URL}${path}?${qstr}&signature=${sig}`, null, {
    headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 8000
  });
  return res.data;
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const rs = (gains / period) / ((losses / period) || 0.001);
  return 100 - (100 / (1 + rs));
}

async function getKlines(symbol, interval = '5m', limit = 30) {
  try {
    const data = await apiGet('/api/v3/klines', { symbol, interval, limit });
    return data.map(k => parseFloat(k[4]));
  } catch(e) { return []; }
}

async function getPrice(symbol) {
  try {
    const data = await apiGet('/api/v3/ticker/price', { symbol });
    return parseFloat(data.price);
  } catch(e) { return null; }
}

async function get24hChange(symbol) {
  try {
    const data = await apiGet('/api/v3/ticker/24hr', { symbol });
    return parseFloat(data.priceChangePercent);
  } catch(e) { return 0; }
}

// Get minimum order quantity for symbol
async function getMinQty(symbol) {
  try {
    const data = await apiGet('/api/v3/exchangeInfo', { symbol });
    const filters = data.symbols[0].filters;
    const lotFilter = filters.find(f => f.filterType === 'LOT_SIZE');
    return parseFloat(lotFilter.minQty);
  } catch(e) { return 0.001; }
}

async function buy(symbol) {
  const price = await getPrice(symbol);
  if (!price) return;
  const usdtAmount = MAX_PER_TRADE;
  let qty = usdtAmount / price;
  
  // Round quantity properly
  const minQty = await getMinQty(symbol);
  const precision = minQty < 1 ? Math.ceil(-Math.log10(minQty)) : 0;
  qty = parseFloat(qty.toFixed(precision));
  
  if (qty <= 0) return;
  
  log(`${PAPER_MODE?'[SIM]':'[REAL]'} COMPRANDO ${qty} ${symbol} @ $${price.toFixed(6)} (~$${usdtAmount})`);

  if (!PAPER_MODE) {
    try {
      await apiPost('/api/v3/order', { symbol, side: 'BUY', type: 'MARKET', quantity: qty });
    } catch(e) {
      log(`Erro compra ${symbol}: ${e.response?.data?.msg || e.message}`);
      return;
    }
  }

  positions[symbol] = { entryPrice: price, qty, usdt: usdtAmount, ts: Date.now() };
  tradeCount++;
  log(`Posicao aberta: ${symbol} | Total trades: ${tradeCount}`);
  await notify('capital. — Compra!', `${PAPER_MODE?'[SIM] ':''}${qty} ${symbol.replace('USDT','')} @ $${price.toFixed(4)}`);
}

async function sell(symbol, reason) {
  const pos = positions[symbol];
  if (!pos) return;
  const price = await getPrice(symbol);
  if (!price) return;

  const pnlPct  = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  const pnlUsdt = pos.usdt * (pnlPct / 100);
  totalPnL += pnlUsdt;

  log(`${PAPER_MODE?'[SIM]':'[REAL]'} VENDENDO ${symbol} @ $${price.toFixed(6)} | ${pnlPct.toFixed(3)}% | R$${pnlUsdt.toFixed(2)} | ${reason}`);

  if (!PAPER_MODE) {
    try {
      await apiPost('/api/v3/order', { symbol, side: 'SELL', type: 'MARKET', quantity: pos.qty });
    } catch(e) {
      log(`Erro venda ${symbol}: ${e.response?.data?.msg || e.message}`);
      return;
    }
  }

  delete positions[symbol];
  tradeCount++;
  
  const emoji = pnlUsdt >= 0 ? '📈' : '📉';
  await notify(
    `capital. ${emoji} ${pnlUsdt>=0?'Lucro':'Stop'}`,
    `${symbol.replace('USDT','')} ${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}% (R$${pnlUsdt>=0?'+':''}${pnlUsdt.toFixed(2)}) | PnL total: R$${totalPnL.toFixed(2)}`
  );

  if (totalPnL <= -PAUSE_LOSS)  { paused=true; log('BOT PAUSADO - perda limite'); await notify('capital. — Pausado', `Perda de R$${Math.abs(totalPnL).toFixed(2)} atingiu o limite.`); }
  if (totalPnL >= PAUSE_PROFIT) { paused=true; log('BOT PAUSADO - meta atingida'); await notify('capital. — Meta!', `Lucro de R$${totalPnL.toFixed(2)}!`); }
}

async function managePositions() {
  for (const symbol of Object.keys(positions)) {
    const pos   = positions[symbol];
    const price = await getPrice(symbol);
    if (!price) continue;

    const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;

    if (pnlPct >= PROFILE.takeProfit * 100) {
      await sell(symbol, `TP +${pnlPct.toFixed(3)}%`);
    } else if (pnlPct <= -(PROFILE.stopLoss * 100)) {
      await sell(symbol, `SL ${pnlPct.toFixed(3)}%`);
    } else {
      // RSI sell signal on 5m chart
      const closes = await getKlines(symbol, '5m', 20);
      const rsi = calculateRSI(closes);
      if (rsi > PROFILE.rsiSell && pnlPct > 0.5) {
        await sell(symbol, `RSI ${rsi.toFixed(1)} + lucro ${pnlPct.toFixed(2)}%`);
      }
    }
  }
}

async function scanBuySignals() {
  const capitalInUse = Object.values(positions).reduce((s,p)=>s+p.usdt, 0);
  if (Object.keys(positions).length >= MAX_POSITIONS) return;
  if (capitalInUse >= CAPITAL_TOTAL * MAX_CAPITAL_USE) return;
  if (CAPITAL_TOTAL - capitalInUse < MAX_PER_TRADE) return;

  // Scan all assets in parallel for speed
  const checks = ASSETS
    .filter(a => !positions[a.symbol])
    .map(async (asset) => {
      try {
        const [closes, change24h] = await Promise.all([
          getKlines(asset.symbol, '5m', 20),
          get24hChange(asset.symbol)
        ]);
        if (closes.length < 15) return null;
        const rsi = calculateRSI(closes);
        const recentDrop = ((closes[closes.length-1] - closes[closes.length-4]) / closes[closes.length-4]) * 100;
        return { asset, rsi, recentDrop, change24h };
      } catch(e) { return null; }
    });

  const results = await Promise.all(checks);
  
  for (const r of results) {
    if (!r) continue;
    const { asset, rsi, recentDrop } = r;
    log(`${asset.symbol} RSI:${rsi.toFixed(1)} drop:${recentDrop.toFixed(3)}%`);
    
    if (rsi < PROFILE.rsiBuy && recentDrop <= -PROFILE.dropPct) {
      if (!positions[asset.symbol]) {
        log(`SINAL: ${asset.symbol} RSI=${rsi.toFixed(1)} drop=${recentDrop.toFixed(3)}%`);
        await buy(asset.symbol);
      }
    }
  }
}

async function runBot() {
  if (paused) return;
  const capitalInUse = Object.values(positions).reduce((s,p)=>s+p.usdt, 0);
  lastCycle = new Date().toISOString();
  log(`Ciclo | PnL:R$${totalPnL.toFixed(2)} | Pos:${Object.keys(positions).length}/${MAX_POSITIONS} | Uso:R$${capitalInUse.toFixed(0)} | Trades:${tradeCount}`);
  await Promise.all([managePositions(), scanBuySignals()]);
}

// Run every 30 seconds
setInterval(runBot, 30000);

// HTTP server
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'POST' && req.url === '/force-buy') {
    // Force buy smallest amount of DOGE for testing
    try {
      const price = await getPrice('DOGEUSDT');
      if (!price) { res.writeHead(500); res.end(JSON.stringify({error:'price fetch failed'})); return; }
      // Buy minimum $5 worth
      const usdtAmount = 5;
      let qty = usdtAmount / price;
      qty = parseFloat(qty.toFixed(0)); // DOGE uses whole numbers
      if (qty < 1) qty = 1;
      log(`[FORCE-BUY] Comprando ${qty} DOGE @ $${price} (~$${usdtAmount})`);
      if (!PAPER_MODE) {
        await apiPost('/api/v3/order', { symbol: 'DOGEUSDT', side: 'BUY', type: 'MARKET', quantity: qty });
      }
      positions['DOGEUSDT_TEST'] = { entryPrice: price, qty, usdt: usdtAmount, profile: 'aggressive' };
      tradeCount++;
      await notify('capital. — Compra TESTE!', `${qty} DOGE @ $${price.toFixed(4)} (~$${usdtAmount})`);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, symbol: 'DOGEUSDT', qty, price, usdtAmount, mode: PAPER_MODE ? 'simulado' : 'real' }));
    } catch(e) {
      log(`Force buy error: ${e.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/pause') {
    paused = !paused;
    res.writeHead(200);
    res.end(JSON.stringify({ paused }));
    return;
  }

  const status = {
    status: 'online',
    mode: PAPER_MODE ? 'simulado' : 'real',
    pnl: `R$${totalPnL.toFixed(2)}`,
    positions: Object.keys(positions).length,
    positionsDetail: positions,
    tradeCount,
    paused,
    lastCycle,
    capital: {
      total: CAPITAL_TOTAL,
      inUse: Object.values(positions).reduce((s,p)=>s+p.usdt, 0),
      available: CAPITAL_TOTAL - Object.values(positions).reduce((s,p)=>s+p.usdt, 0)
    }
  };
  res.writeHead(200);
  res.end(JSON.stringify(status));
});

server.listen(PORT, () => {
  log(`HTTP server porta ${PORT}`);
  log(`capital. Bot AGRESSIVO — ${PAPER_MODE?'SIMULADO':'REAL'}`);
  log(`Ativos: ${ASSETS.length} | Ciclo: 30s | RSI buy:<${PROFILE.rsiBuy} | TP:+${PROFILE.takeProfit*100}% | SL:-${PROFILE.stopLoss*100}%`);
  runBot();
});
