const http = require('http');
const axios = require('axios');
const crypto = require('crypto');

const API_KEY    = process.env.BINANCE_API_KEY    || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const PAPER_MODE = process.env.PAPER_MODE !== 'false';
const NOTIFY_URL = process.env.NOTIFY_URL || '';
const NEWS_KEY   = process.env.NEWS_KEY || '8c729e78ee7e477295c572995346f88f';
const PORT       = process.env.PORT || 3000;
const BASE_URL   = 'https://api.binance.com';

// ══════════════════════════════════════
// CAPITAL ALLOCATION — % do saldo real
// ══════════════════════════════════════
const HOLD_PCT        = 0.50; // 50% do saldo para hold
const SCALP_PCT       = 0.35; // 35% do saldo para scalp
const SENTIMENT_PCT   = 0.15; // 15% do saldo para sentimento
const SCALP_TRADE_PCT = 0.08; // cada trade scalp = 8% do capital scalp
const SENT_TRADE_PCT  = 0.15; // cada trade sentimento = 15% do capital sentimento
const PAUSE_LOSS_PCT  = 0.20; // pausa se perder 20%
const PAUSE_PROFIT_PCT= 0.65; // pausa se lucrar 65%

let liveBalance = 0; // saldo USDT real da conta Binance

async function fetchBalance() {
  try {
    const ts = Date.now();
    const qstr = `timestamp=${ts}`;
    const sig = crypto.createHmac('sha256', API_SECRET).update(qstr).digest('hex');
    const res = await axios.get(`${BASE_URL}/api/v3/account?${qstr}&signature=${sig}`, {
      headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 8000
    });

    const balances = res.data.balances.filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
    
    // Get prices for all non-USDT assets
    let totalUSD = 0;
    for (const b of balances) {
      const qty = parseFloat(b.free) + parseFloat(b.locked);
      if (qty <= 0) continue;
      if (b.asset === 'USDT') { totalUSD += qty; continue; }
      if (b.asset === 'BRL' || b.asset === 'EUR') continue;
      try {
        const price = await getPrice(b.asset + 'USDT');
        if (price) totalUSD += qty * price;
      } catch(e) {}
    }

    liveBalance = totalUSD;
    log(`Saldo total da conta: $${liveBalance.toFixed(2)} (todas as cryptos + USDT)`);
  } catch(e) {
    log(`Erro ao buscar saldo: ${e.message}`);
    if (liveBalance === 0) liveBalance = 100;
  }
  return liveBalance;
}

function getHoldCapital()   { return liveBalance * HOLD_PCT; }
function getScalpCapital()  { return liveBalance * SCALP_PCT; }
function getSentCapital()   { return liveBalance * SENTIMENT_PCT; }
function getScalpTradeAmt() { return Math.max(5, getScalpCapital() * SCALP_TRADE_PCT); }
function getSentTradeAmt()  { return Math.max(5, getSentCapital() * SENT_TRADE_PCT); }
function getHoldTradeAmt()  { return getHoldCapital() / 3; }
function getPauseLoss()     { return liveBalance * PAUSE_LOSS_PCT; }
function getPauseProfit()   { return liveBalance * PAUSE_PROFIT_PCT; }

// ══════════════════════════════════════
// ASSETS
// ══════════════════════════════════════
const HOLD_ASSETS = [
  { symbol: 'BTCUSDT', name: 'Bitcoin',  reason: 'Reserva de valor, halving 2024, ETFs institucionais' },
  { symbol: 'ETHUSDT', name: 'Ethereum', reason: 'Staking, DeFi, smart contracts líder' },
  { symbol: 'SOLUSDT', name: 'Solana',   reason: 'Alta velocidade, crescimento de apps e NFTs' },
];

const SCALP_ASSETS = [
  { symbol: 'DOGEUSDT',  name: 'Dogecoin'  },
  { symbol: 'XRPUSDT',   name: 'XRP'       },
  { symbol: 'ADAUSDT',   name: 'Cardano'   },
  { symbol: 'BNBUSDT',   name: 'BNB'       },
  { symbol: 'AVAXUSDT',  name: 'Avalanche' },
  { symbol: 'MATICUSDT', name: 'Polygon'   },
  { symbol: 'LINKUSDT',  name: 'Chainlink' },
  { symbol: 'DOTUSDT',   name: 'Polkadot'  },
  { symbol: 'UNIUSDT',   name: 'Uniswap'   },
];

// ══════════════════════════════════════
// STATE
// ══════════════════════════════════════
let holdPositions     = {}; // long-term holds
let scalpPositions    = {}; // scalp trades
let sentimentPositions = {}; // sentiment trades
let totalPnL          = 0;
let paused            = false;
let tradeCount        = 0;
let lastCycle         = null;
let sentimentCache    = {}; // cache news sentiment per symbol


// ══════════════════════════════════════
// UTILS
// ══════════════════════════════════════
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

function calcRSI(prices, period = 14) {
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

async function get1hChange(symbol) {
  try {
    const data = await apiGet('/api/v3/klines', { symbol, interval: '1h', limit: 2 });
    const open  = parseFloat(data[0][1]);
    const close = parseFloat(data[data.length - 1][4]);
    return ((close - open) / open) * 100;
  } catch(e) { return 0; }
}

async function execBuy(symbol, usdtAmount, type) {
  const price = await getPrice(symbol);
  if (!price) return null;
  let qty = usdtAmount / price;

  // Round based on price magnitude
  if (price > 1000) qty = parseFloat(qty.toFixed(5));
  else if (price > 1) qty = parseFloat(qty.toFixed(2));
  else qty = parseFloat(qty.toFixed(0));
  if (qty <= 0) return null;

  log(`[${type.toUpperCase()}][${PAPER_MODE?'SIM':'REAL'}] BUY ${qty} ${symbol} @ $${price.toFixed(6)} (~$${usdtAmount})`);

  if (!PAPER_MODE) {
    try {
      await apiPost('/api/v3/order', { symbol, side: 'BUY', type: 'MARKET', quantity: qty });
    } catch(e) {
      log(`Erro compra ${symbol}: ${e.response?.data?.msg || e.message}`);
      return null;
    }
  }
  tradeCount++;
  return { entryPrice: price, qty, usdt: usdtAmount, ts: Date.now() };
}

async function execSell(symbol, pos, reason, type) {
  const price = await getPrice(symbol);
  if (!price) return;
  const pnlPct  = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  const pnlUsdt = pos.usdt * (pnlPct / 100);
  totalPnL += pnlUsdt;
  log(`[${type.toUpperCase()}][${PAPER_MODE?'SIM':'REAL'}] SELL ${symbol} @ $${price.toFixed(6)} | ${pnlPct.toFixed(3)}% | $${pnlUsdt.toFixed(2)} | ${reason}`);

  if (!PAPER_MODE) {
    try {
      await apiPost('/api/v3/order', { symbol, side: 'SELL', type: 'MARKET', quantity: pos.qty });
    } catch(e) { log(`Erro venda ${symbol}: ${e.response?.data?.msg || e.message}`); return; }
  }
  tradeCount++;
  const emoji = pnlUsdt >= 0 ? '📈' : '📉';
  await notify(
    `capital. ${emoji} [${type}] ${pnlUsdt>=0?'Lucro':'Stop'}`,
    `${symbol.replace('USDT','')} ${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}% ($${pnlUsdt>=0?'+':''}${pnlUsdt.toFixed(2)}) | PnL: $${totalPnL.toFixed(2)}\n${reason}`
  );
  if (totalPnL <= -getPauseLoss())   { paused=true; await notify('capital. — Pausado', `Perda de $${Math.abs(totalPnL).toFixed(2)} atingiu limite (${(PAUSE_LOSS_PCT*100).toFixed(0)}%).`); }
  if (totalPnL >= getPauseProfit())  { paused=true; await notify('capital. — Meta!', `Lucro de $${totalPnL.toFixed(2)} (${(PAUSE_PROFIT_PCT*100).toFixed(0)}% do capital)!`); }
}

// ══════════════════════════════════════
// STRATEGY 1 — LONG TERM HOLD
// ══════════════════════════════════════
async function initHolds() {
  const holdUSDT = Object.values(holdPositions).reduce((s,p)=>s+p.usdt, 0);
  if (Object.keys(holdPositions).length >= HOLD_ASSETS.length) return;
  log('=== Verificando posicoes HOLD ===');
  for (const asset of HOLD_ASSETS) {
    if (!holdPositions[asset.symbol]) {
      const pos = await execBuy(asset.symbol, asset.allocation, 'HOLD');
      if (pos) {
        holdPositions[asset.symbol] = { ...pos, reason: asset.reason };
        await notify(
          'capital. — Hold iniciado!',
          `${asset.name} comprado para longo prazo ($${asset.allocation})\n${asset.reason}`
        );
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }
  if(Object.keys(holdPositions).length > 0) log('Holds ativos: ' + Object.keys(holdPositions).join(', '));
}

async function manageHolds() {
  for (const symbol of Object.keys(holdPositions)) {
    const pos   = holdPositions[symbol];
    const price = await getPrice(symbol);
    if (!price) continue;
    const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    log(`[HOLD] ${symbol} | Entry:$${pos.entryPrice.toFixed(4)} | Now:$${price.toFixed(4)} | PnL:${pnlPct.toFixed(2)}%`);

    if (pnlPct >= 40) {
      // Take profit at +40%
      await execSell(symbol, pos, 'Take Profit longo prazo +40%', 'HOLD');
      delete holdPositions[symbol];
      // Rebuy immediately to maintain position
      await new Promise(r => setTimeout(r, 1000));
      const newPos = await execBuy(symbol, getHoldTradeAmt(), 'HOLD');
      if (newPos) holdPositions[symbol] = { ...newPos, reason: pos.reason };
    } else if (pnlPct <= -25) {
      // Stop loss at -25% — serious market crash
      await execSell(symbol, pos, 'Stop Loss emergência -25%', 'HOLD');
      delete holdPositions[symbol];
      await notify('capital. — ALERTA HOLD', `${symbol.replace('USDT','')} caiu -25%! Posição fechada.`);
    }
  }
}

// ══════════════════════════════════════
// STRATEGY 2 — SCALPING AGRESSIVO
// ══════════════════════════════════════
async function runScalping() {
  const scalpInUse = Object.values(scalpPositions).reduce((s,p)=>s+p.usdt, 0);

  // Manage open scalp positions
  for (const symbol of Object.keys(scalpPositions)) {
    const pos   = scalpPositions[symbol];
    const price = await getPrice(symbol);
    if (!price) continue;
    const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;

    if (pnlPct >= 1.5) {
      await execSell(symbol, pos, `Scalp TP +${pnlPct.toFixed(2)}%`, 'SCALP');
      delete scalpPositions[symbol];
    } else if (pnlPct <= -1.5) {
      await execSell(symbol, pos, `Scalp SL ${pnlPct.toFixed(2)}%`, 'SCALP');
      delete scalpPositions[symbol];
    } else {
      // RSI exit
      const closes = await getKlines(symbol, '1m', 20);
      const rsi = calcRSI(closes);
      if (rsi > 70 && pnlPct > 0.3) {
        await execSell(symbol, pos, `RSI ${rsi.toFixed(1)} + lucro`, 'SCALP');
        delete scalpPositions[symbol];
      }
    }
  }

  // Scan for new scalp opportunities
  if (Object.keys(scalpPositions).length >= 5) return;
  if (scalpInUse >= getScalpCapital()) return;

  const perTrade = getScalpTradeAmt();
  const checks = SCALP_ASSETS
    .filter(a => !scalpPositions[a.symbol])
    .map(async (asset) => {
      try {
        const [closes1m, closes5m, change1h] = await Promise.all([
          getKlines(asset.symbol, '1m', 20),
          getKlines(asset.symbol, '5m', 20),
          get1hChange(asset.symbol)
        ]);
        const rsi1m = calcRSI(closes1m);
        const rsi5m = calcRSI(closes5m);
        const drop  = closes1m.length > 3 ? ((closes1m[closes1m.length-1] - closes1m[closes1m.length-4]) / closes1m[closes1m.length-4]) * 100 : 0;
        return { asset, rsi1m, rsi5m, drop, change1h };
      } catch(e) { return null; }
    });

  const results = await Promise.all(checks);
  for (const r of results) {
    if (!r || scalpPositions[r.asset.symbol]) continue;
    const { asset, rsi1m, rsi5m, drop, change1h } = r;

    // Buy signal: RSI oversold on both timeframes + any drop
    const buySig = rsi1m < 40 && rsi5m < 50 && drop <= -0.1;
    // Momentum: price surging on 1h
    const momentumSig = change1h > 2 && rsi1m < 65;

    if (buySig || momentumSig) {
      const reason = buySig ? `RSI ${rsi1m.toFixed(1)}/drop ${drop.toFixed(2)}%` : `Momentum +${change1h.toFixed(2)}%`;
      log(`[SCALP] SINAL ${asset.symbol} — ${reason}`);
      const pos = await execBuy(asset.symbol, perTrade, 'SCALP');
      if (pos) {
        scalpPositions[asset.symbol] = pos;
        await notify('capital. — Scalp!', `${asset.name} comprado\n${reason}`);
      }
    }
    log(`[SCALP] ${asset.symbol} RSI:${rsi1m.toFixed(1)} drop:${drop.toFixed(2)}% 1h:${change1h.toFixed(2)}%`);
  }
}

// ══════════════════════════════════════
// STRATEGY 3 — SENTIMENT
// ══════════════════════════════════════
const POSITIVE_WORDS = ['bullish','surge','gains','rally','adoption','partnership','etf','upgrade','launch','record','pump','moon','breakthrough','soar','rise'];
const NEGATIVE_WORDS = ['bearish','crash','ban','hack','lawsuit','fraud','dump','selloff','collapse','plunge','bubble','fear','warning','risk','decline'];

async function fetchSentiment(coin) {
  try {
    const q = encodeURIComponent(`${coin} crypto`);
    const r = await axios.get(`https://newsapi.org/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=10&apiKey=${NEWS_KEY}`, { timeout: 8000 });
    const articles = r.data.articles || [];
    let score = 0;
    articles.forEach(a => {
      const text = ((a.title || '') + ' ' + (a.description || '')).toLowerCase();
      POSITIVE_WORDS.forEach(w => { if (text.includes(w)) score += 0.1; });
      NEGATIVE_WORDS.forEach(w => { if (text.includes(w)) score -= 0.1; });
    });
    score = Math.max(-1, Math.min(1, score));
    sentimentCache[coin] = { score, ts: Date.now(), articles: articles.length };
    log(`[SENTIMENT] ${coin} score: ${score.toFixed(2)} (${articles.length} articles)`);
    return score;
  } catch(e) { return 0; }
}

async function runSentiment() {
  const sentInUse = Object.values(sentimentPositions).reduce((s,p)=>s+p.usdt, 0);
  const sentAssets = ['Bitcoin','Ethereum','Solana','XRP','Dogecoin'];
  const sentSymbols = { 'Bitcoin':'BTCUSDT','Ethereum':'ETHUSDT','Solana':'SOLUSDT','XRP':'XRPUSDT','Dogecoin':'DOGEUSDT' };

  // Manage open sentiment positions
  for (const symbol of Object.keys(sentimentPositions)) {
    const pos   = sentimentPositions[symbol];
    const price = await getPrice(symbol);
    if (!price) continue;
    const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    if (pnlPct >= 5) {
      await execSell(symbol, pos, `Sentiment TP +${pnlPct.toFixed(2)}%`, 'SENT');
      delete sentimentPositions[symbol];
    } else if (pnlPct <= -3) {
      await execSell(symbol, pos, `Sentiment SL ${pnlPct.toFixed(2)}%`, 'SENT');
      delete sentimentPositions[symbol];
    }
  }

  if (Object.keys(sentimentPositions).length >= 2) return;
  if (sentInUse >= getSentCapital()) return;

  // Fetch sentiment for one asset at a time (rate limit)
  const coin = sentAssets[Math.floor(Date.now() / 60000) % sentAssets.length];
  const symbol = sentSymbols[coin];
  if (!symbol || sentimentPositions[symbol]) return;

  // Use cache if fresh (< 10 min)
  let score;
  if (sentimentCache[coin] && Date.now() - sentimentCache[coin].ts < 600000) {
    score = sentimentCache[coin].score;
  } else {
    score = await fetchSentiment(coin);
  }

  if (score > 0.3) {
    log(`[SENTIMENT] Comprando ${symbol} — score positivo ${score.toFixed(2)}`);
    const pos = await execBuy(symbol, getSentTradeAmt(), 'SENT');
    if (pos) {
      sentimentPositions[symbol] = { ...pos, sentimentScore: score };
      await notify('capital. — Sentimento!', `${coin} score: +${score.toFixed(2)}\nNotícias positivas detectadas`);
    }
  } else if (score < -0.3) {
    log(`[SENTIMENT] Sentimento negativo ${symbol}: ${score.toFixed(2)} — evitando`);
  }
}

// ══════════════════════════════════════
// MAIN LOOP
// ══════════════════════════════════════
async function runBot() {
  if (paused) { log('Bot pausado'); return; }
  lastCycle = new Date().toISOString();

  // Fetch live balance every cycle
  await fetchBalance();

  const totalInUse = [
    ...Object.values(holdPositions),
    ...Object.values(scalpPositions),
    ...Object.values(sentimentPositions)
  ].reduce((s,p)=>s+p.usdt, 0);

  log(`=== Ciclo | PnL:$${totalPnL.toFixed(2)} | Trades:${tradeCount} | InUse:$${totalInUse.toFixed(0)} | Hold:${Object.keys(holdPositions).length} Scalp:${Object.keys(scalpPositions).length} Sent:${Object.keys(sentimentPositions).length} ===`);

  // Always ensure holds are initialized
  await initHolds();
  await manageHolds();

  // Run scalping and sentiment in parallel
  await Promise.all([runScalping(), runSentiment()]);
}

// Run every 15 seconds
setInterval(runBot, 15000);

// ══════════════════════════════════════
// HTTP SERVER
// ══════════════════════════════════════
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'POST' && req.url === '/force-hold') {
    holdPositions = {};
    await initHolds();
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, holds: holdPositions }));
    return;
  }

  if (req.method === 'POST' && req.url === '/pause') {
    paused = !paused;
    log(`Bot ${paused?'PAUSADO':'RETOMADO'} via API`);
    res.writeHead(200); res.end(JSON.stringify({ paused })); return;
  }

  if (req.method === 'POST' && req.url === '/force-buy') {
    try {
      const pos = await execBuy('DOGEUSDT', getScalpTradeAmt(), 'TEST');
      if (pos) {
        scalpPositions['DOGEUSDT_TEST'] = pos;
        res.writeHead(200); res.end(JSON.stringify({ success: true, ...pos, mode: PAPER_MODE?'sim':'real' }));
      } else {
        res.writeHead(500); res.end(JSON.stringify({ error: 'buy failed' }));
      }
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  const status = {
    status: 'online',
    mode: PAPER_MODE ? 'simulado' : 'real',
    pnl: `$${totalPnL.toFixed(2)}`,
    tradeCount,
    paused,
    lastCycle,
    capital: {
      liveBalance: `$${liveBalance.toFixed(2)}`,
      holdAlloc: `$${getHoldCapital().toFixed(2)} (50%)`,
      scalpAlloc: `$${getScalpCapital().toFixed(2)} (35%)`,
      sentAlloc: `$${getSentCapital().toFixed(2)} (15%)`,
      holdInUse: Object.values(holdPositions).reduce((s,p)=>s+p.usdt,0).toFixed(2),
      scalpInUse: Object.values(scalpPositions).reduce((s,p)=>s+p.usdt,0).toFixed(2),
      sentInUse: Object.values(sentimentPositions).reduce((s,p)=>s+p.usdt,0).toFixed(2),
    },
    positions: {
      hold: holdPositions,
      scalp: scalpPositions,
      sentiment: sentimentPositions
    },
    sentimentCache
  };
  res.writeHead(200); res.end(JSON.stringify(status));
});

server.listen(PORT, () => {
  log(`capital. Bot v2 — HOLD + SCALP + SENTIMENT`);
  log(`${PAPER_MODE?'MODO SIMULADO':'MODO REAL'} | Ciclo: 15s`);
  log(`Alocacao: Hold 50% | Scalp 35% | Sentiment 15% — baseado no saldo real da conta`);
  runBot();
});
