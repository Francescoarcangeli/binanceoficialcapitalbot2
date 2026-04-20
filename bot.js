const http = require('http');
const axios = require('axios');
const crypto = require('crypto');

// ════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════
const API_KEY    = process.env.BINANCE_API_KEY    || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const PAPER_MODE = process.env.PAPER_MODE !== 'false';
const NOTIFY_URL = process.env.NOTIFY_URL || '';
const NEWS_KEY   = '8c729e78ee7e477295c572995346f88f';
const PORT       = process.env.PORT || 3000;
const BASE       = 'https://api.binance.com';

// ════════════════════════════════════════
// STRATEGY PARAMS
// ════════════════════════════════════════
const HOLD_PCT       = 0.50;  // 50% of free USDT for long-term holds
const SCALP_PCT      = 0.35;  // 35% for scalping
const SENT_PCT       = 0.15;  // 15% for sentiment

const HOLD_COINS     = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const HOLD_TP        = 0.40;  // take profit at +40%
const HOLD_SL        = 0.25;  // stop loss at -25%

const SCALP_TP       = 0.015; // +1.5%
const SCALP_SL       = 0.015; // -1.5%
const SCALP_RSI_BUY  = 35;   // buy when RSI < 35
const SCALP_RSI_SELL = 70;   // sell when RSI > 70
const SCALP_MAX_POS  = 5;    // max simultaneous scalp positions
const SCALP_TRADE_PCT = 0.10; // each scalp = 10% of scalp capital

const SENT_TP        = 0.05;  // +5%
const SENT_SL        = 0.03;  // -3%
const SENT_MAX_POS   = 2;
const SENT_TRADE_PCT = 0.20;  // each sentiment = 20% of sentiment capital

const CYCLE_MS       = 10000; // run every 10 seconds
const PAUSE_LOSS_PCT = 0.20;  // pause if lose 20%
const PAUSE_WIN_PCT  = 0.50;  // pause if gain 50%

// ════════════════════════════════════════
// STATE
// ════════════════════════════════════════
let freeUSDT      = 0;
let totalBalance  = 0;
let holdPos       = {};
let scalpPos      = {};
let sentPos       = {};
let sentCache     = {};
let totalPnL      = 0;
let startBalance  = 0;
let tradeCount    = 0;
let paused        = false;
let lastCycle     = null;
let initialized   = false;
let scalpSymbols  = []; // all available USDT pairs from Binance

// ════════════════════════════════════════
// UTILS
// ════════════════════════════════════════
const log = msg => console.log(`[${new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}] ${msg}`);

async function notify(title, body) {
  if (!NOTIFY_URL) return;
  try { await axios.post(NOTIFY_URL+'/test-send', {title,body}, {timeout:5000}); } catch(e){}
}

async function apiGet(path, params={}) {
  const r = await axios.get(BASE+path, {params, timeout:8000});
  return r.data;
}

async function apiSign(path, params={}) {
  const ts  = Date.now();
  const q   = Object.entries({...params, timestamp:ts}).map(([k,v])=>`${k}=${v}`).join('&');
  const sig = crypto.createHmac('sha256', API_SECRET).update(q).digest('hex');
  return { url:`${BASE}${path}?${q}&signature=${sig}`, headers:{'X-MBX-APIKEY':API_KEY} };
}

// ════════════════════════════════════════
// BALANCE
// ════════════════════════════════════════
async function fetchBalance() {
  try {
    const {url, headers} = await apiSign('/api/v3/account');
    const r = await axios.get(url, {headers, timeout:8000});
    let usdt = 0, total = 0;
    for (const b of r.data.balances) {
      const qty = parseFloat(b.free) + parseFloat(b.locked);
      if (qty <= 0) continue;
      if (b.asset === 'USDT') { usdt = parseFloat(b.free); total += qty; continue; }
      if (['BRL','EUR','GBP','BUSD'].includes(b.asset)) continue;
      try {
        const p = await getPrice(b.asset+'USDT');
        if (p > 0) total += qty * p;
      } catch(e) {}
    }
    freeUSDT     = usdt;
    totalBalance = total;
    log(`Saldo: total=$${totalBalance.toFixed(2)} | USDT livre=$${freeUSDT.toFixed(2)}`);
  } catch(e) { log(`Erro saldo: ${e.message}`); }
}

// ════════════════════════════════════════
// MARKET DATA
// ════════════════════════════════════════
async function getPrice(symbol) {
  try {
    const d = await apiGet('/api/v3/ticker/price', {symbol});
    return parseFloat(d.price);
  } catch(e) { return 0; }
}

async function getKlines(symbol, interval='5m', limit=20) {
  try {
    const d = await apiGet('/api/v3/klines', {symbol, interval, limit});
    return d.map(k => parseFloat(k[4]));
  } catch(e) { return []; }
}

async function get1hChange(symbol) {
  try {
    const d = await apiGet('/api/v3/klines', {symbol, interval:'1h', limit:2});
    const o = parseFloat(d[0][1]), c = parseFloat(d[1][4]);
    return ((c-o)/o)*100;
  } catch(e) { return 0; }
}

function calcRSI(prices, period=14) {
  if (prices.length < period+1) return 50;
  let g=0, l=0;
  for (let i=prices.length-period; i<prices.length; i++) {
    const d=prices[i]-prices[i-1];
    d>0 ? g+=d : l+=Math.abs(d);
  }
  const rs=(g/period)/((l/period)||0.001);
  return 100-(100/(1+rs));
}

// Load all USDT trading pairs from Binance
async function loadSymbols() {
  try {
    const d = await apiGet('/api/v3/exchangeInfo');
    scalpSymbols = d.symbols
      .filter(s => s.quoteAsset==='USDT' && s.status==='TRADING' && !HOLD_COINS.includes(s.symbol))
      .map(s => s.symbol);
    log(`Carregados ${scalpSymbols.length} pares USDT para scalp`);
  } catch(e) { log(`Erro ao carregar símbolos: ${e.message}`); }
}

// ════════════════════════════════════════
// SELL ALL — liquidate everything
// ════════════════════════════════════════
async function sellAll() {
  log('=== VENDENDO TUDO ===');
  try {
    const {url, headers} = await apiSign('/api/v3/account');
    const r = await axios.get(url, {headers, timeout:8000});
    for (const b of r.data.balances) {
      const qty = parseFloat(b.free);
      if (qty <= 0) continue;
      if (['USDT','BRL','EUR','GBP','BUSD'].includes(b.asset)) continue;
      const symbol = b.asset+'USDT';
      try {
        // Get lot size
        const info = await apiGet('/api/v3/exchangeInfo', {symbol});
        const lot  = info.symbols[0].filters.find(f=>f.filterType==='LOT_SIZE');
        const step = parseFloat(lot.stepSize);
        const minQ = parseFloat(lot.minQty);
        const adjQ = Math.floor(qty/step)*step;
        const adjQR = parseFloat(adjQ.toFixed(8));
        if (adjQR < minQ) { log(`Skip ${symbol}: qty ${adjQR} < minQty ${minQ}`); continue; }
        if (!PAPER_MODE) {
          const {url:oUrl, headers:oH} = await apiSign('/api/v3/order', {
            symbol, side:'SELL', type:'MARKET', quantity:adjQR
          });
          await axios.post(oUrl, null, {headers:oH, timeout:8000});
        }
        log(`[SELL ALL] ${adjQR} ${b.asset}`);
        await new Promise(r=>setTimeout(r,300));
      } catch(e) { log(`Erro vendendo ${b.asset}: ${e.response?.data?.msg||e.message}`); }
    }
    holdPos  = {};
    scalpPos = {};
    sentPos  = {};
    log('=== TUDO VENDIDO ===');
    await fetchBalance();
  } catch(e) { log(`Erro sellAll: ${e.message}`); }
}

// ════════════════════════════════════════
// BUY / SELL
// ════════════════════════════════════════
async function execBuy(symbol, usdtAmt, type) {
  if (!usdtAmt || usdtAmt < 1 || isNaN(usdtAmt)) return null;
  if (freeUSDT < usdtAmt * 0.95) {
    log(`[${type}] USDT insuficiente: $${freeUSDT.toFixed(2)} < $${usdtAmt.toFixed(2)}`);
    return null;
  }

  const price = await getPrice(symbol);
  if (!price || price <= 0) return null;

  // Get lot size from exchange
  let qty = usdtAmt / price;
  try {
    const info = await apiGet('/api/v3/exchangeInfo', {symbol});
    const lot  = info.symbols[0].filters.find(f=>f.filterType==='LOT_SIZE');
    const step = parseFloat(lot.stepSize);
    const minQ = parseFloat(lot.minQty);
    qty = Math.floor(qty/step)*step;
    qty = parseFloat(qty.toFixed(8));
    if (qty < minQ) { log(`[${type}] qty ${qty} < minQty ${minQ} para ${symbol}`); return null; }
  } catch(e) {
    // fallback rounding
    if (price > 10000) qty = parseFloat(qty.toFixed(5));
    else if (price > 100) qty = parseFloat(qty.toFixed(3));
    else if (price > 1)   qty = parseFloat(qty.toFixed(2));
    else                  qty = parseFloat(qty.toFixed(0));
  }

  if (!qty || qty <= 0) return null;

  log(`[${type}][${PAPER_MODE?'SIM':'REAL'}] BUY ${qty} ${symbol} @ $${price.toFixed(4)} (~$${usdtAmt.toFixed(2)})`);

  if (!PAPER_MODE) {
    try {
      const {url, headers} = await apiSign('/api/v3/order', {symbol, side:'BUY', type:'MARKET', quantity:qty});
      await axios.post(url, null, {headers, timeout:8000});
    } catch(e) {
      log(`Erro compra ${symbol}: ${e.response?.data?.msg||e.message}`);
      return null;
    }
  }

  freeUSDT  -= usdtAmt;
  tradeCount++;
  await notify(`capital. 🟢 [${type}]`, `Comprou ${qty} ${symbol.replace('USDT','')} @ $${price.toFixed(4)}`);
  return {entryPrice:price, qty, usdt:usdtAmt, ts:Date.now()};
}

async function execSell(symbol, pos, reason, type) {
  const price = await getPrice(symbol);
  if (!price) return;
  const pct  = ((price-pos.entryPrice)/pos.entryPrice)*100;
  const pnl  = pos.usdt*(pct/100);
  totalPnL  += pnl;
  freeUSDT  += pos.usdt + pnl;

  log(`[${type}][${PAPER_MODE?'SIM':'REAL'}] SELL ${symbol} @ $${price.toFixed(4)} | ${pct.toFixed(2)}% | $${pnl.toFixed(2)} | ${reason}`);

  if (!PAPER_MODE) {
    try {
      const {url, headers} = await apiSign('/api/v3/order', {symbol, side:'SELL', type:'MARKET', quantity:pos.qty});
      await axios.post(url, null, {headers, timeout:8000});
    } catch(e) { log(`Erro venda ${symbol}: ${e.response?.data?.msg||e.message}`); return; }
  }

  tradeCount++;
  const roi = startBalance > 0 ? ((totalPnL/startBalance)*100).toFixed(1) : '0';
  await notify(`capital. ${pnl>=0?'📈':'📉'} [${type}]`,
    `${symbol.replace('USDT','')} ${pct>=0?'+':''}${pct.toFixed(2)}% ($${pnl.toFixed(2)})\nROI total: ${roi}%`);

  if (startBalance > 0) {
    if (totalPnL <= -(startBalance*PAUSE_LOSS_PCT)) { paused=true; await notify('capital. ⛔ Pausado', `Perda de $${Math.abs(totalPnL).toFixed(2)} (${(PAUSE_LOSS_PCT*100).toFixed(0)}%)`); }
    if (totalPnL >= startBalance*PAUSE_WIN_PCT)     { paused=true; await notify('capital. 🏆 Meta!',    `Lucro de $${totalPnL.toFixed(2)} (${(PAUSE_WIN_PCT*100).toFixed(0)}%)`); }
  }
}

// ════════════════════════════════════════
// STRATEGY 1: HOLD
// ════════════════════════════════════════
async function runHold() {
  const holdCap    = freeUSDT * HOLD_PCT;
  const perCoin    = holdCap / HOLD_COINS.length;

  // Manage existing
  for (const symbol of Object.keys(holdPos)) {
    const pos = holdPos[symbol];
    const price = await getPrice(symbol);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    log(`[HOLD] ${symbol} ${pct>=0?'+':''}${pct.toFixed(2)}%`);
    if (pct >= HOLD_TP*100) {
      await execSell(symbol, pos, `TP +${pct.toFixed(2)}%`, 'HOLD');
      delete holdPos[symbol];
      await new Promise(r=>setTimeout(r,500));
      const newPos = await execBuy(symbol, freeUSDT*HOLD_PCT/HOLD_COINS.length, 'HOLD');
      if (newPos) holdPos[symbol] = newPos;
    } else if (pct <= -(HOLD_SL*100)) {
      await execSell(symbol, pos, `SL ${pct.toFixed(2)}%`, 'HOLD');
      delete holdPos[symbol];
    }
  }

  // Buy missing holds
  for (const symbol of HOLD_COINS) {
    if (holdPos[symbol]) continue;
    if (perCoin < 1) { log(`[HOLD] Capital insuficiente: $${perCoin.toFixed(2)}`); continue; }
    const pos = await execBuy(symbol, perCoin, 'HOLD');
    if (pos) holdPos[symbol] = pos;
    await new Promise(r=>setTimeout(r,500));
  }
}

// ════════════════════════════════════════
// STRATEGY 2: SCALP — any Binance pair
// ════════════════════════════════════════
async function runScalp() {
  const scalpCap   = freeUSDT * SCALP_PCT;
  const perTrade   = Math.max(1, scalpCap * SCALP_TRADE_PCT);
  const scalpInUse = Object.values(scalpPos).reduce((s,p)=>s+p.usdt, 0);

  // Manage open positions
  for (const symbol of [...Object.keys(scalpPos)]) {
    const pos   = scalpPos[symbol];
    const price = await getPrice(symbol);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    if (pct >= SCALP_TP*100) {
      await execSell(symbol, pos, `TP +${pct.toFixed(2)}%`, 'SCALP');
      delete scalpPos[symbol];
    } else if (pct <= -(SCALP_SL*100)) {
      await execSell(symbol, pos, `SL ${pct.toFixed(2)}%`, 'SCALP');
      delete scalpPos[symbol];
    } else {
      const closes = await getKlines(symbol, '1m', 20);
      if (calcRSI(closes) > SCALP_RSI_SELL && pct > 0.3) {
        await execSell(symbol, pos, `RSI alto`, 'SCALP');
        delete scalpPos[symbol];
      }
    }
  }

  if (Object.keys(scalpPos).length >= SCALP_MAX_POS) return;
  if (freeUSDT < perTrade) return;

  // Pick random sample of symbols to scan (avoid scanning all 400+ pairs)
  const candidates = scalpSymbols
    .filter(s => !scalpPos[s] && !HOLD_COINS.includes(s))
    .sort(() => Math.random()-0.5)
    .slice(0, 30);

  const results = await Promise.all(candidates.map(async symbol => {
    try {
      const [c1m, c5m, ch] = await Promise.all([
        getKlines(symbol,'1m',20),
        getKlines(symbol,'5m',20),
        get1hChange(symbol)
      ]);
      const rsi1 = calcRSI(c1m);
      const rsi5 = calcRSI(c5m);
      const drop = c1m.length > 3 ? ((c1m[c1m.length-1]-c1m[c1m.length-4])/c1m[c1m.length-4])*100 : 0;
      return {symbol, rsi1, rsi5, drop, ch};
    } catch(e) { return null; }
  }));

  for (const r of results) {
    if (!r || scalpPos[r.symbol]) continue;
    if (Object.keys(scalpPos).length >= SCALP_MAX_POS) break;
    const oversold  = r.rsi1 < SCALP_RSI_BUY && r.rsi5 < 45 && r.drop <= -0.1;
    const momentum  = r.ch > 3 && r.rsi1 < 65 && r.rsi1 > 40;
    if (oversold || momentum) {
      log(`[SCALP] SINAL ${r.symbol} RSI:${r.rsi1.toFixed(1)} drop:${r.drop.toFixed(2)}% 1h:${r.ch.toFixed(2)}%`);
      const pos = await execBuy(r.symbol, perTrade, 'SCALP');
      if (pos) scalpPos[r.symbol] = pos;
    }
  }
}

// ════════════════════════════════════════
// STRATEGY 3: SENTIMENT
// ════════════════════════════════════════
const POS = ['bullish','surge','gains','rally','adoption','etf','launch','record','soar','rise','partnership','upgrade'];
const NEG = ['bearish','crash','ban','hack','lawsuit','fraud','dump','collapse','plunge','warning','decline','fear'];

async function getSentiment(coin) {
  const cached = sentCache[coin];
  if (cached && Date.now()-cached.ts < 600000) return cached.score;
  try {
    const r = await axios.get(`https://newsapi.org/v2/everything?q=${encodeURIComponent(coin+' crypto')}&language=en&sortBy=publishedAt&pageSize=10&apiKey=${NEWS_KEY}`, {timeout:8000});
    let score = 0;
    (r.data.articles||[]).forEach(a => {
      const txt = ((a.title||'')+(a.description||'')).toLowerCase();
      POS.forEach(w => { if(txt.includes(w)) score+=0.1; });
      NEG.forEach(w => { if(txt.includes(w)) score-=0.1; });
    });
    score = Math.max(-1, Math.min(1, score));
    sentCache[coin] = {score, ts:Date.now()};
    log(`[SENT] ${coin} score:${score.toFixed(2)}`);
    return score;
  } catch(e) { return 0; }
}

async function runSentiment() {
  const sentCap    = freeUSDT * SENT_PCT;
  const perTrade   = Math.max(1, sentCap * SENT_TRADE_PCT);
  const sentInUse  = Object.values(sentPos).reduce((s,p)=>s+p.usdt, 0);

  // Manage open
  for (const symbol of [...Object.keys(sentPos)]) {
    const pos   = sentPos[symbol];
    const price = await getPrice(symbol);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    if      (pct >=  SENT_TP*100) { await execSell(symbol,pos,`TP +${pct.toFixed(2)}%`,'SENT'); delete sentPos[symbol]; }
    else if (pct <= -SENT_SL*100) { await execSell(symbol,pos,`SL ${pct.toFixed(2)}%`,'SENT'); delete sentPos[symbol]; }
  }

  if (Object.keys(sentPos).length >= SENT_MAX_POS) return;
  if (freeUSDT < perTrade) return;

  const coins = {'Bitcoin':'BTCUSDT','Ethereum':'ETHUSDT','Solana':'SOLUSDT','XRP':'XRPUSDT','Dogecoin':'DOGEUSDT'};
  const coin  = Object.keys(coins)[Math.floor(Date.now()/60000) % Object.keys(coins).length];
  const symbol = coins[coin];
  if (sentPos[symbol]) return;

  const score = await getSentiment(coin);
  if (score > 0.3) {
    const pos = await execBuy(symbol, perTrade, 'SENT');
    if (pos) sentPos[symbol] = {...pos, score};
  }
}

// ════════════════════════════════════════
// MAIN LOOP
// ════════════════════════════════════════
async function runBot() {
  if (paused) { log('Bot pausado'); return; }
  lastCycle = new Date().toISOString();

  await fetchBalance();
  if (freeUSDT <= 0 && Object.keys(holdPos).length === 0) {
    log('Sem USDT disponível');
    return;
  }

  const inUse = [...Object.values(holdPos),...Object.values(scalpPos),...Object.values(sentPos)].reduce((s,p)=>s+p.usdt,0);
  const roi   = startBalance > 0 ? ((totalPnL/startBalance)*100).toFixed(1) : '0';
  log(`=== PnL:$${totalPnL.toFixed(2)} (${roi}%) | Trades:${tradeCount} | USDT:$${freeUSDT.toFixed(2)} | Hold:${Object.keys(holdPos).length} Scalp:${Object.keys(scalpPos).length} Sent:${Object.keys(sentPos).length} ===`);

  await runHold();
  await Promise.all([runScalp(), runSentiment()]);
}

// ════════════════════════════════════════
// HTTP SERVER
// ════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method==='POST' && req.url==='/sell-all') {
    await sellAll();
    initialized = false;
    res.writeHead(200); res.end(JSON.stringify({success:true, freeUSDT})); return;
  }

  if (req.method==='POST' && req.url==='/pause') {
    paused = !paused;
    log(`Bot ${paused?'PAUSADO':'RETOMADO'}`);
    res.writeHead(200); res.end(JSON.stringify({paused})); return;
  }

  if (req.method==='POST' && req.url==='/resume') {
    paused = false;
    res.writeHead(200); res.end(JSON.stringify({paused})); return;
  }

  res.writeHead(200); res.end(JSON.stringify({
    status: 'online',
    mode:   PAPER_MODE ? 'simulado' : 'real',
    paused, lastCycle, tradeCount,
    pnl:    `$${totalPnL.toFixed(2)}`,
    roi:    startBalance > 0 ? `${((totalPnL/startBalance)*100).toFixed(1)}%` : '0%',
    capital: {
      total:    `$${totalBalance.toFixed(2)}`,
      freeUSDT: `$${freeUSDT.toFixed(2)}`,
      holdAlloc:  `$${(freeUSDT*HOLD_PCT).toFixed(2)} (50%)`,
      scalpAlloc: `$${(freeUSDT*SCALP_PCT).toFixed(2)} (35%)`,
      sentAlloc:  `$${(freeUSDT*SENT_PCT).toFixed(2)} (15%)`,
    },
    positions: { hold:holdPos, scalp:scalpPos, sentiment:sentPos },
    sentCache
  }));
});

server.listen(PORT, async () => {
  log(`capital. Bot v4 | ${PAPER_MODE?'SIMULADO':'REAL'} | Ciclo:${CYCLE_MS/1000}s`);
  log(`Hold:50% | Scalp:35% (qualquer par) | Sentimento:15%`);

  // Load all available symbols
  await loadSymbols();

  // Sell everything and start fresh
  await sellAll();
  await fetchBalance();
  startBalance = freeUSDT;
  log(`Capital inicial: $${startBalance.toFixed(2)}`);
  await notify('capital. 🚀 Bot iniciado!', `Capital: $${startBalance.toFixed(2)}\nHold:50% | Scalp:35% | Sent:15%`);

  // Start main loop
  setInterval(runBot, CYCLE_MS);
  runBot();
});
