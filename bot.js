const http = require('http');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');

const API_KEY    = process.env.BINANCE_API_KEY    || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const PAPER_MODE = process.env.PAPER_MODE !== 'false';
const NOTIFY_URL = process.env.NOTIFY_URL || '';
const PORT       = process.env.PORT || 3000;
const BASE_URL   = 'https://api.binance.com';

const CAPITAL_TOTAL   = 300;
const MAX_PER_TRADE   = 50;
const MAX_POSITIONS   = 4;
const MAX_CAPITAL_USE = 0.60;
const PAUSE_LOSS      = 60;
const PAUSE_PROFIT    = 150;

const ASSETS = [
  { symbol: 'BTCUSDT',  name: 'Bitcoin',  profile: 'conservative' },
  { symbol: 'ETHUSDT',  name: 'Ethereum', profile: 'conservative' },
  { symbol: 'SOLUSDT',  name: 'Solana',   profile: 'moderate'     },
  { symbol: 'XRPUSDT',  name: 'XRP',      profile: 'moderate'     },
  { symbol: 'ADAUSDT',  name: 'Cardano',  profile: 'moderate'     },
  { symbol: 'DOGEUSDT', name: 'Dogecoin', profile: 'aggressive'   },
];

const PROFILES = {
  conservative: { rsiBuy: 32, rsiSell: 72, dropPct: 3, takeProfit: 0.15, stopLoss: 0.08 },
  moderate:     { rsiBuy: 30, rsiSell: 70, dropPct: 4, takeProfit: 0.20, stopLoss: 0.10 },
  aggressive:   { rsiBuy: 28, rsiSell: 68, dropPct: 5, takeProfit: 0.30, stopLoss: 0.12 },
};

let positions = {};
let totalPnL  = 0;
let paused    = false;
let lastCycle = null;

function log(msg) {
  const ts = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  console.log(`[${ts}] ${msg}`);
}

async function notify(title, body) {
  if (!NOTIFY_URL) return;
  try { await axios.post(NOTIFY_URL + '/test-send', { title, body }, { timeout: 5000 }); } catch(e) {}
}

async function apiGet(path, params = {}) {
  const res = await axios.get(BASE_URL + path, { params, timeout: 10000 });
  return res.data;
}

async function apiPost(path, params = {}) {
  const ts = Date.now();
  const qstr = Object.entries({ ...params, timestamp: ts }).map(([k,v]) => `${k}=${v}`).join('&');
  const sig = crypto.createHmac('sha256', API_SECRET).update(qstr).digest('hex');
  const res = await axios.post(`${BASE_URL}${path}?${qstr}&signature=${sig}`, null, {
    headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 10000
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

async function getKlines(symbol) {
  try {
    const data = await apiGet('/api/v3/klines', { symbol, interval: '1h', limit: 50 });
    return data.map(k => parseFloat(k[4]));
  } catch(e) { log(`Erro klines ${symbol}: ${e.message}`); return []; }
}

async function getPrice(symbol) {
  try {
    const data = await apiGet('/api/v3/ticker/price', { symbol });
    return parseFloat(data.price);
  } catch(e) { log(`Erro price ${symbol}: ${e.message}`); return null; }
}

async function getPriceChange4h(symbol) {
  try {
    const data = await apiGet('/api/v3/klines', { symbol, interval: '1h', limit: 5 });
    const open  = parseFloat(data[0][1]);
    const close = parseFloat(data[data.length - 1][4]);
    return ((close - open) / open) * 100;
  } catch(e) { return 0; }
}

async function buy(symbol, usdtAmount, profile) {
  const price = await getPrice(symbol);
  if (!price) return;
  const qty = (usdtAmount / price).toFixed(6);
  log(`${PAPER_MODE?'[SIM]':'[REAL]'} COMPRANDO ${qty} ${symbol} @ $${price}`);
  if (!PAPER_MODE) {
    try { await apiPost('/api/v3/order', { symbol, side: 'BUY', type: 'MARKET', quantity: qty }); }
    catch(e) { log(`Erro compra: ${e.message}`); return; }
  }
  positions[symbol] = { entryPrice: price, qty: parseFloat(qty), usdt: usdtAmount, profile };
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
  log(`${PAPER_MODE?'[SIM]':'[REAL]'} VENDENDO ${symbol} @ $${price} | ${pnlPct.toFixed(2)}% | ${reason}`);
  if (!PAPER_MODE) {
    try { await apiPost('/api/v3/order', { symbol, side: 'SELL', type: 'MARKET', quantity: pos.qty.toFixed(6) }); }
    catch(e) { log(`Erro venda: ${e.message}`); return; }
  }
  delete positions[symbol];
  await notify(`capital. — ${pnlUsdt>=0?'Lucro':'Stop'}`, `${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}% ${symbol.replace('USDT','')} (R$${pnlUsdt.toFixed(2)})`);
  if (totalPnL <= -PAUSE_LOSS)  { paused=true; await notify('capital. — Pausado', `Perda de R$${Math.abs(totalPnL).toFixed(2)} atingiu o limite.`); }
  if (totalPnL >= PAUSE_PROFIT) { paused=true; await notify('capital. — Meta!', `Lucro de R$${totalPnL.toFixed(2)}!`); }
}

async function managePositions() {
  for (const symbol of Object.keys(positions)) {
    const pos   = positions[symbol];
    const price = await getPrice(symbol);
    if (!price) continue;
    const cfg    = PROFILES[pos.profile];
    const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    if      (pnlPct >=  cfg.takeProfit * 100) await sell(symbol, `Take Profit +${pnlPct.toFixed(2)}%`);
    else if (pnlPct <= -cfg.stopLoss   * 100) await sell(symbol, `Stop Loss ${pnlPct.toFixed(2)}%`);
    else {
      const closes = await getKlines(symbol);
      if (calculateRSI(closes) > cfg.rsiSell) await sell(symbol, `RSI alto`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
}

async function scanBuySignals() {
  const capitalInUse = Object.values(positions).reduce((s,p)=>s+p.usdt, 0);
  if (Object.keys(positions).length >= MAX_POSITIONS) return;
  if (capitalInUse >= CAPITAL_TOTAL * MAX_CAPITAL_USE) return;
  if (CAPITAL_TOTAL - capitalInUse < MAX_PER_TRADE) return;
  for (const asset of ASSETS) {
    if (positions[asset.symbol]) continue;
    const cfg    = PROFILES[asset.profile];
    const closes = await getKlines(asset.symbol);
    if (closes.length < 15) continue;
    const rsi    = calculateRSI(closes);
    const drop4h = await getPriceChange4h(asset.symbol);
    log(`${asset.symbol} RSI:${rsi.toFixed(1)} 4h:${drop4h.toFixed(2)}%`);
    if (rsi < cfg.rsiBuy && drop4h <= -cfg.dropPct) {
      log(`SINAL DE COMPRA: ${asset.symbol}`);
      await buy(asset.symbol, MAX_PER_TRADE, asset.profile);
    }
    await new Promise(r => setTimeout(r, 400));
  }
}

async function runBot() {
  if (paused) { log('Bot pausado'); return; }
  const capitalInUse = Object.values(positions).reduce((s,p)=>s+p.usdt, 0);
  log(`=== Ciclo | PnL:R$${totalPnL.toFixed(2)} | Pos:${Object.keys(positions).length} | Uso:R$${capitalInUse.toFixed(2)} | ${PAPER_MODE?'SIM':'REAL'} ===`);
  lastCycle = new Date().toISOString();
  await managePositions();
  await scanBuySignals();
}

// HTTP server (required by Render)
const server = http.createServer((req, res) => {
  const status = {
    status: 'online',
    mode: PAPER_MODE ? 'simulado' : 'real',
    pnl: `R$${totalPnL.toFixed(2)}`,
    positions: Object.keys(positions).length,
    paused,
    lastCycle
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(status));
});
server.listen(PORT, () => log(`HTTP server na porta ${PORT}`));

cron.schedule('*/30 * * * *', runBot);

log(`capital. Bot — ${PAPER_MODE?'SIMULADO':'REAL'}`);
log(`Ativos: ${ASSETS.map(a=>a.symbol).join(', ')}`);
if (!API_KEY) log('AVISO: API keys nao configuradas!');
runBot();
