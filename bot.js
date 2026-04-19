const http = require('http');
const axios = require('axios');
const crypto = require('crypto');

// ── CONFIG ──
const API_KEY    = process.env.BINANCE_API_KEY    || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const PAPER_MODE = process.env.PAPER_MODE !== 'false';
const NOTIFY_URL = process.env.NOTIFY_URL || '';
const NEWS_KEY   = process.env.NEWS_KEY || '8c729e78ee7e477295c572995346f88f';
const PORT       = process.env.PORT || 3000;
const BASE_URL   = 'https://api.binance.com';

// ── ALLOCATION % ──
const HOLD_PCT         = 0.50;
const SCALP_PCT        = 0.35;
const SENT_PCT         = 0.15;
const SCALP_TRADE_PCT  = 0.08;
const SENT_TRADE_PCT   = 0.15;
const HOLD_STOP_PCT    = 0.25;
const HOLD_TP_PCT      = 0.40;
const SCALP_TP_PCT     = 0.015;
const SCALP_SL_PCT     = 0.015;
const SENT_TP_PCT      = 0.05;
const SENT_SL_PCT      = 0.03;
const PAUSE_LOSS_PCT   = 0.20;
const PAUSE_PROFIT_PCT = 0.65;

// ── ASSETS ──
const HOLD_ASSETS = [
  { symbol: 'BTCUSDT', name: 'Bitcoin'  },
  { symbol: 'ETHUSDT', name: 'Ethereum' },
  { symbol: 'SOLUSDT', name: 'Solana'   },
];
const SCALP_ASSETS = [
  'DOGEUSDT','XRPUSDT','ADAUSDT','BNBUSDT',
  'AVAXUSDT','MATICUSDT','LINKUSDT','DOTUSDT','UNIUSDT'
];
const SENT_COINS = {
  'Bitcoin':'BTCUSDT','Ethereum':'ETHUSDT',
  'Solana':'SOLUSDT','XRP':'XRPUSDT','Dogecoin':'DOGEUSDT'
};

// ── STATE ──
let totalBalance    = 0;
let holdPositions   = {};
let scalpPositions  = {};
let sentPositions   = {};
let sentCache       = {};
let totalPnL        = 0;
let tradeCount      = 0;
let paused          = false;
let lastCycle       = null;

// ── UTILS ──
const log = msg => console.log(`[${new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}] ${msg}`);

async function notify(title, body) {
  if (!NOTIFY_URL) return;
  try { await axios.post(NOTIFY_URL+'/test-send', {title,body}, {timeout:5000}); } catch(e){}
}

async function apiGet(path, params={}) {
  const r = await axios.get(BASE_URL+path, {params, timeout:8000});
  return r.data;
}

async function apiPost(path, params={}) {
  const ts = Date.now();
  const q = Object.entries({...params, timestamp:ts}).map(([k,v])=>`${k}=${v}`).join('&');
  const sig = crypto.createHmac('sha256', API_SECRET).update(q).digest('hex');
  const r = await axios.post(`${BASE_URL}${path}?${q}&signature=${sig}`, null, {
    headers:{'X-MBX-APIKEY':API_KEY}, timeout:8000
  });
  return r.data;
}

// ── BALANCE ──
async function fetchTotalBalance() {
  try {
    const ts = Date.now();
    const q = `timestamp=${ts}`;
    const sig = crypto.createHmac('sha256', API_SECRET).update(q).digest('hex');
    const r = await axios.get(`${BASE_URL}/api/v3/account?${q}&signature=${sig}`, {
      headers:{'X-MBX-APIKEY':API_KEY}, timeout:8000
    });
    let total = 0;
    for (const b of r.data.balances) {
      const qty = parseFloat(b.free) + parseFloat(b.locked);
      if (qty <= 0) continue;
      if (b.asset === 'USDT') { total += qty; continue; }
      if (['BRL','EUR','GBP'].includes(b.asset)) continue;
      try {
        const p = await getPrice(b.asset+'USDT');
        if (p && p > 0) total += qty * p;
      } catch(e) {}
    }
    totalBalance = total;
    log(`Saldo total: $${totalBalance.toFixed(2)}`);
  } catch(e) {
    log(`Erro saldo: ${e.message}`);
  }
}

// ── PRICE / KLINES ──
async function getPrice(symbol) {
  try {
    const d = await apiGet('/api/v3/ticker/price', {symbol});
    return parseFloat(d.price);
  } catch(e) { return null; }
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
    const open = parseFloat(d[0][1]);
    const close = parseFloat(d[d.length-1][4]);
    return ((close-open)/open)*100;
  } catch(e) { return 0; }
}

function calcRSI(prices, period=14) {
  if (prices.length < period+1) return 50;
  let g=0, l=0;
  for (let i=prices.length-period; i<prices.length; i++) {
    const d = prices[i]-prices[i-1];
    if (d>0) g+=d; else l+=Math.abs(d);
  }
  const rs = (g/period)/((l/period)||0.001);
  return 100-(100/(1+rs));
}

// ── BUY / SELL ──
async function execBuy(symbol, usdtAmt, type) {
  if (!usdtAmt || isNaN(usdtAmt) || usdtAmt < 1) {
    log(`[${type}] Valor invalido: ${usdtAmt}`);
    return null;
  }
  const price = await getPrice(symbol);
  if (!price || price <= 0) return null;

  let qty = usdtAmt / price;
  if (price > 10000) qty = parseFloat(qty.toFixed(6));
  else if (price > 100) qty = parseFloat(qty.toFixed(4));
  else if (price > 1)   qty = parseFloat(qty.toFixed(2));
  else                  qty = parseFloat(qty.toFixed(0));

  if (!qty || qty <= 0 || isNaN(qty)) return null;

  log(`[${type}][${PAPER_MODE?'SIM':'REAL'}] BUY ${qty} ${symbol} @ $${price.toFixed(4)} (~$${usdtAmt.toFixed(2)})`);

  if (!PAPER_MODE) {
    try {
      await apiPost('/api/v3/order', {symbol, side:'BUY', type:'MARKET', quantity:qty});
    } catch(e) {
      log(`Erro compra ${symbol}: ${e.response?.data?.msg||e.message}`);
      return null;
    }
  }

  tradeCount++;
  await notify(`capital. — [${type}] Compra!`, `${qty} ${symbol.replace('USDT','')} @ $${price.toFixed(4)} (~$${usdtAmt.toFixed(2)})`);
  return { entryPrice:price, qty, usdt:usdtAmt, ts:Date.now() };
}

async function execSell(symbol, pos, reason, type) {
  const price = await getPrice(symbol);
  if (!price) return;
  const pct  = ((price-pos.entryPrice)/pos.entryPrice)*100;
  const pnl  = pos.usdt*(pct/100);
  totalPnL  += pnl;
  log(`[${type}][${PAPER_MODE?'SIM':'REAL'}] SELL ${symbol} @ $${price.toFixed(4)} | ${pct.toFixed(2)}% | $${pnl.toFixed(2)} | ${reason}`);

  if (!PAPER_MODE) {
    try {
      await apiPost('/api/v3/order', {symbol, side:'SELL', type:'MARKET', quantity:pos.qty});
    } catch(e) { log(`Erro venda ${symbol}: ${e.response?.data?.msg||e.message}`); return; }
  }

  tradeCount++;
  await notify(`capital. ${pnl>=0?'📈 Lucro':'📉 Stop'} [${type}]`,
    `${symbol.replace('USDT','')} ${pct>=0?'+':''}${pct.toFixed(2)}% ($${pnl.toFixed(2)}) | PnL total: $${totalPnL.toFixed(2)}`);

  if (totalPnL <= -(totalBalance*PAUSE_LOSS_PCT))   { paused=true; await notify('capital. — Pausado!', `Perda de $${Math.abs(totalPnL).toFixed(2)}`); }
  if (totalPnL >= totalBalance*PAUSE_PROFIT_PCT)    { paused=true; await notify('capital. — Meta!', `Lucro de $${totalPnL.toFixed(2)}`); }
}

// ── STRATEGY 1: HOLD ──
async function runHold() {
  if (totalBalance <= 0) return;
  const holdAmt = (totalBalance * HOLD_PCT) / HOLD_ASSETS.length;
  if (holdAmt < 5) { log(`Hold amount baixo: $${holdAmt.toFixed(2)}`); return; }

  // Buy missing holds
  for (const asset of HOLD_ASSETS) {
    if (!holdPositions[asset.symbol]) {
      log(`[HOLD] Iniciando posicao em ${asset.symbol} ($${holdAmt.toFixed(2)})`);
      const pos = await execBuy(asset.symbol, holdAmt, 'HOLD');
      if (pos) holdPositions[asset.symbol] = pos;
      await new Promise(r=>setTimeout(r,500));
    }
  }

  // Manage existing holds
  for (const symbol of Object.keys(holdPositions)) {
    const pos   = holdPositions[symbol];
    const price = await getPrice(symbol);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    log(`[HOLD] ${symbol} PnL:${pct.toFixed(2)}%`);
    if (pct >= HOLD_TP_PCT*100) {
      await execSell(symbol, pos, `TP +${pct.toFixed(2)}%`, 'HOLD');
      delete holdPositions[symbol];
      // Rebuy immediately
      const newPos = await execBuy(symbol, (totalBalance*HOLD_PCT)/HOLD_ASSETS.length, 'HOLD');
      if (newPos) holdPositions[symbol] = newPos;
    } else if (pct <= -(HOLD_STOP_PCT*100)) {
      await execSell(symbol, pos, `SL ${pct.toFixed(2)}%`, 'HOLD');
      delete holdPositions[symbol];
    }
  }
}

// ── STRATEGY 2: SCALP ──
async function runScalp() {
  if (totalBalance <= 0) return;
  const scalpCap   = totalBalance * SCALP_PCT;
  const perTrade   = Math.max(5, scalpCap * SCALP_TRADE_PCT);
  const scalpInUse = Object.values(scalpPositions).reduce((s,p)=>s+p.usdt,0);

  // Manage open positions
  for (const symbol of Object.keys(scalpPositions)) {
    const pos   = scalpPositions[symbol];
    const price = await getPrice(symbol);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    if      (pct >=  SCALP_TP_PCT*100) { await execSell(symbol,pos,`TP +${pct.toFixed(2)}%`,'SCALP'); delete scalpPositions[symbol]; }
    else if (pct <= -SCALP_SL_PCT*100) { await execSell(symbol,pos,`SL ${pct.toFixed(2)}%`,'SCALP'); delete scalpPositions[symbol]; }
    else {
      const closes = await getKlines(symbol,'1m',20);
      if (calcRSI(closes) > 70 && pct > 0.3) { await execSell(symbol,pos,'RSI alto','SCALP'); delete scalpPositions[symbol]; }
    }
  }

  if (Object.keys(scalpPositions).length >= 5) return;
  if (scalpInUse >= scalpCap) return;

  // Scan for buys
  const checks = SCALP_ASSETS
    .filter(s => !scalpPositions[s])
    .map(async symbol => {
      try {
        const [c1m, c5m, ch] = await Promise.all([
          getKlines(symbol,'1m',20),
          getKlines(symbol,'5m',20),
          get1hChange(symbol)
        ]);
        const rsi1 = calcRSI(c1m);
        const rsi5 = calcRSI(c5m);
        const drop = c1m.length>3 ? ((c1m[c1m.length-1]-c1m[c1m.length-4])/c1m[c1m.length-4])*100 : 0;
        return {symbol, rsi1, rsi5, drop, ch};
      } catch(e) { return null; }
    });

  const results = await Promise.all(checks);
  for (const r of results) {
    if (!r || scalpPositions[r.symbol]) continue;
    log(`[SCALP] ${r.symbol} RSI:${r.rsi1.toFixed(1)} drop:${r.drop.toFixed(2)}% 1h:${r.ch.toFixed(2)}%`);
    const buySig = r.rsi1 < 40 && r.rsi5 < 50 && r.drop <= -0.1;
    const momSig = r.ch > 2 && r.rsi1 < 65;
    if (buySig || momSig) {
      const pos = await execBuy(r.symbol, perTrade, 'SCALP');
      if (pos) scalpPositions[r.symbol] = pos;
    }
  }
}

// ── STRATEGY 3: SENTIMENT ──
const POS_WORDS = ['bullish','surge','gains','rally','adoption','etf','launch','record','soar','rise','partnership'];
const NEG_WORDS = ['bearish','crash','ban','hack','lawsuit','fraud','dump','collapse','plunge','warning','decline'];

async function fetchSentiment(coin) {
  try {
    const q = encodeURIComponent(`${coin} crypto`);
    const r = await axios.get(`https://newsapi.org/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=10&apiKey=${NEWS_KEY}`, {timeout:8000});
    let score = 0;
    (r.data.articles||[]).forEach(a => {
      const txt = ((a.title||'')+(a.description||'')).toLowerCase();
      POS_WORDS.forEach(w => { if(txt.includes(w)) score+=0.1; });
      NEG_WORDS.forEach(w => { if(txt.includes(w)) score-=0.1; });
    });
    score = Math.max(-1, Math.min(1, score));
    sentCache[coin] = {score, ts:Date.now()};
    log(`[SENT] ${coin} score:${score.toFixed(2)}`);
    return score;
  } catch(e) { return 0; }
}

async function runSentiment() {
  if (totalBalance <= 0) return;
  const sentCap  = totalBalance * SENT_PCT;
  const perTrade = Math.max(5, sentCap * SENT_TRADE_PCT);
  const sentInUse = Object.values(sentPositions).reduce((s,p)=>s+p.usdt,0);

  // Manage open
  for (const symbol of Object.keys(sentPositions)) {
    const pos   = sentPositions[symbol];
    const price = await getPrice(symbol);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    if      (pct >=  SENT_TP_PCT*100) { await execSell(symbol,pos,`TP +${pct.toFixed(2)}%`,'SENT'); delete sentPositions[symbol]; }
    else if (pct <= -SENT_SL_PCT*100) { await execSell(symbol,pos,`SL ${pct.toFixed(2)}%`,'SENT'); delete sentPositions[symbol]; }
  }

  if (Object.keys(sentPositions).length >= 2) return;
  if (sentInUse >= sentCap) return;

  // Pick one coin to analyze per cycle
  const coins = Object.keys(SENT_COINS);
  const coin  = coins[Math.floor(Date.now()/60000) % coins.length];
  const symbol = SENT_COINS[coin];
  if (sentPositions[symbol]) return;

  const cached = sentCache[coin];
  const score = (cached && Date.now()-cached.ts < 600000) ? cached.score : await fetchSentiment(coin);

  if (score > 0.3) {
    const pos = await execBuy(symbol, perTrade, 'SENT');
    if (pos) sentPositions[symbol] = {...pos, score};
  }
}

// ── MAIN LOOP ──
async function runBot() {
  if (paused) { log('Bot pausado'); return; }
  lastCycle = new Date().toISOString();

  await fetchTotalBalance();
  if (!totalBalance || totalBalance <= 0) { log('Saldo zero, aguardando...'); return; }

  const inUse = [
    ...Object.values(holdPositions),
    ...Object.values(scalpPositions),
    ...Object.values(sentPositions)
  ].reduce((s,p)=>s+p.usdt,0);

  log(`=== PnL:$${totalPnL.toFixed(2)} | Trades:${tradeCount} | InUse:$${inUse.toFixed(0)} | Hold:${Object.keys(holdPositions).length} Scalp:${Object.keys(scalpPositions).length} Sent:${Object.keys(sentPositions).length} ===`);

  await runHold();
  await Promise.all([runScalp(), runSentiment()]);
}

setInterval(runBot, 15000);

// ── HTTP SERVER ──
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method==='POST' && req.url==='/pause') {
    paused = !paused;
    res.writeHead(200); res.end(JSON.stringify({paused})); return;
  }

  if (req.method==='POST' && req.url==='/force-hold') {
    holdPositions = {};
    await fetchTotalBalance();
    await runHold();
    res.writeHead(200); res.end(JSON.stringify({success:true, holds:holdPositions, balance:totalBalance})); return;
  }

  if (req.method==='POST' && req.url==='/force-buy') {
    await fetchTotalBalance();
    const amt = Math.max(5, (totalBalance*SCALP_PCT*SCALP_TRADE_PCT));
    const pos = await execBuy('DOGEUSDT', amt, 'TEST');
    res.writeHead(200); res.end(JSON.stringify({success:!!pos, pos, mode:PAPER_MODE?'sim':'real'})); return;
  }

  const holdInUse  = Object.values(holdPositions).reduce((s,p)=>s+p.usdt,0);
  const scalpInUse = Object.values(scalpPositions).reduce((s,p)=>s+p.usdt,0);
  const sentInUse  = Object.values(sentPositions).reduce((s,p)=>s+p.usdt,0);

  res.writeHead(200); res.end(JSON.stringify({
    status:'online', mode:PAPER_MODE?'simulado':'real',
    pnl:`$${totalPnL.toFixed(2)}`, tradeCount, paused, lastCycle,
    capital:{
      total:`$${totalBalance.toFixed(2)}`,
      holdAlloc:`$${(totalBalance*HOLD_PCT).toFixed(2)} (50%)`,
      scalpAlloc:`$${(totalBalance*SCALP_PCT).toFixed(2)} (35%)`,
      sentAlloc:`$${(totalBalance*SENT_PCT).toFixed(2)} (15%)`,
      holdInUse:`$${holdInUse.toFixed(2)}`,
      scalpInUse:`$${scalpInUse.toFixed(2)}`,
      sentInUse:`$${sentInUse.toFixed(2)}`,
    },
    positions:{ hold:holdPositions, scalp:scalpPositions, sentiment:sentPositions },
    sentCache
  }));
});

server.listen(PORT, () => {
  log(`capital. Bot v3 | ${PAPER_MODE?'SIMULADO':'REAL'} | Ciclo:15s`);
  log(`Hold:50% | Scalp:35% | Sentimento:15%`);
  runBot();
});
