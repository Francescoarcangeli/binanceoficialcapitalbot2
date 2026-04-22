const http   = require('http');
const axios  = require('axios');
const crypto = require('crypto');

// ── CONFIG ──────────────────────────────────────────
const API_KEY    = process.env.BINANCE_API_KEY    || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const PAPER_MODE = process.env.PAPER_MODE !== 'false';
const NOTIFY_URL = process.env.NOTIFY_URL || '';
const PORT       = process.env.PORT || 3000;
const BASE       = 'https://api.binance.com';

// ── COINS ────────────────────────────────────────────
const HOLD_COINS  = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const TRADE_COINS = ['XRPUSDT', 'CHIPUSDT', 'DOGEUSDT', 'BNBUSDT', 'BIAUSDT', 'NEIROUSDT', 'SPKUSDT', 'STRKUSDT'];

// ── ALLOCATION ───────────────────────────────────────
const HOLD_PCT  = 0.50;  // 50% in holds
const TREND_PCT = 0.35;  // 35% in trend following
const DIP_PCT   = 0.15;  // 15% in dip buying

// ── STRATEGY PARAMS ──────────────────────────────────
// Hold
const HOLD_SL        = 12;   // emergency stop -20%
const HOLD_TP        = 20;   // take profit +40% then rebuy

// Trend following
const TREND_BUY_CH1H = 3;    // buy if +3% in 1h
const TREND_TP       = 5;    // take profit +5%
const TREND_SL       = 3;    // stop loss -3%
const TREND_RSI_SELL = 75;   // sell if RSI > 75

// Sentiment
const SENT_POS_WORDS = ['bullish','surge','partnership','etf','adoption','launch','upgrade','record','soar','rally','elon','moon','pump','approved','listed'];
const SENT_NEG_WORDS = ['bearish','crash','ban','hack','lawsuit','fraud','dump','collapse','warning','decline','fear','sell','scam','arrest','bubble'];
const SENT_BUY_SCORE = 0.3;   // buy if score > 0.3
const SENT_TP        = 6;     // take profit +6%
const SENT_SL        = 3;     // stop loss -3%
const SENT_MAX_POS   = 2;     // max 2 sentiment positions
const NEWS_KEY       = '8c729e78ee7e477295c572995346f88f';

// Dip buying
const DIP_BUY_CH1H   = -5;   // buy if -5% in 1h
const DIP_RSI_BUY    = 35;   // buy if RSI < 35
const DIP_TP         = 4;    // take profit +4%
const DIP_SL         = 2;    // stop loss -2%

const CYCLE_MS       = 10000; // 10 second cycle
const PAUSE_LOSS_PCT = 0.25;
const PAUSE_WIN_PCT  = 0.50;

// ── STATE ────────────────────────────────────────────
let freeUSDT     = 0;
let totalBalance = 0;
let startBalance = 0;
let holdPos      = {};   // { BTCUSDT: {entryPrice, qty, usdt, ts} }
let trendPos     = {};   // active trend trades
let dipPos       = {};   // active dip trades
let oppPos       = {};   // opportunist — any coin pumping
let sentPos      = {};   // sentiment — news based
let sentCache    = {};   // cache news scores
let allSymbols   = [];   // all Binance USDT pairs
let totalPnL     = 0;
let tradeCount   = 0;
let paused       = false;
let lastCycle    = null;

// ── UTILS ────────────────────────────────────────────
const log = msg => console.log(`[${new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}] ${msg}`);

async function notify(title, body) {
  if (!NOTIFY_URL) return;
  try { await axios.post(NOTIFY_URL+'/test-send',{title,body},{timeout:5000}); } catch(e){}
}

async function apiGet(path, params={}) {
  const r = await axios.get(BASE+path,{params,timeout:8000});
  return r.data;
}

async function signedGet(path, params={}) {
  const ts  = Date.now();
  const q   = Object.entries({...params,timestamp:ts}).map(([k,v])=>`${k}=${v}`).join('&');
  const sig = crypto.createHmac('sha256',API_SECRET).update(q).digest('hex');
  const r   = await axios.get(`${BASE}${path}?${q}&signature=${sig}`,{
    headers:{'X-MBX-APIKEY':API_KEY},timeout:8000
  });
  return r.data;
}

async function signedPost(path, params={}) {
  const ts  = Date.now();
  const q   = Object.entries({...params,timestamp:ts}).map(([k,v])=>`${k}=${v}`).join('&');
  const sig = crypto.createHmac('sha256',API_SECRET).update(q).digest('hex');
  const r   = await axios.post(`${BASE}${path}?${q}&signature=${sig}`,null,{
    headers:{'X-MBX-APIKEY':API_KEY},timeout:8000
  });
  return r.data;
}

// ── MARKET DATA ──────────────────────────────────────
async function getPrice(symbol) {
  try {
    const d = await apiGet('/api/v3/ticker/price',{symbol});
    return parseFloat(d.price);
  } catch(e) { return 0; }
}

async function getKlines(symbol, interval='1h', limit=3) {
  try {
    const d = await apiGet('/api/v3/klines',{symbol,interval,limit});
    return d.map(k=>parseFloat(k[4]));
  } catch(e) { return []; }
}

async function getTicker(symbol) {
  try {
    return await apiGet('/api/v3/ticker/24hr',{symbol});
  } catch(e) { return null; }
}

function calcRSI(prices, period=14) {
  if (prices.length<period+1) return 50;
  let g=0,l=0;
  for (let i=prices.length-period;i<prices.length;i++) {
    const d=prices[i]-prices[i-1];
    d>0?g+=d:l+=Math.abs(d);
  }
  const rs=(g/period)/((l/period)||0.001);
  return 100-(100/(1+rs));
}

function ch1h(klines) {
  if (klines.length<2) return 0;
  return ((klines[klines.length-1]-klines[klines.length-2])/klines[klines.length-2])*100;
}

// ── BALANCE ──────────────────────────────────────────
async function fetchBalance() {
  try {
    const data = await signedGet('/api/v3/account');
    let usdt=0, total=0;
    for (const b of data.balances) {
      const qty=parseFloat(b.free)+parseFloat(b.locked);
      if (qty<=0) continue;
      if (b.asset==='USDT') { usdt=parseFloat(b.free); total+=qty; continue; }
      if (['BRL','EUR','GBP','BUSD','USDC'].includes(b.asset)) continue;
      try {
        const p=await getPrice(b.asset+'USDT');
        if (p>0) total+=qty*p;
      } catch(e) {}
    }
    freeUSDT=usdt; totalBalance=total;
    log(`Saldo: total=$${total.toFixed(2)} | USDT livre=$${usdt.toFixed(2)}`);
  } catch(e) { log(`Erro saldo: ${e.message}`); }
}

// ── LOAD ALL SYMBOLS ─────────────────────────────────
async function loadSymbols() {
  try {
    const d = await apiGet('/api/v3/exchangeInfo');
    allSymbols = d.symbols
      .filter(s=>s.quoteAsset==='USDT' && s.status==='TRADING')
      .map(s=>s.symbol);
    log(`${allSymbols.length} pares USDT carregados`);
  } catch(e) { 
    log(`Erro loadSymbols: ${e.message}`);
    allSymbols = [];
  }
}

// ── GET LOT SIZE ─────────────────────────────────────
async function getAdjQty(symbol, rawQty) {
  try {
    const info=await apiGet('/api/v3/exchangeInfo',{symbol});
    const lot =info.symbols[0].filters.find(f=>f.filterType==='LOT_SIZE');
    const step=parseFloat(lot.stepSize);
    const minQ=parseFloat(lot.minQty);
    const adj =parseFloat((Math.floor(rawQty/step)*step).toFixed(8));
    return adj>=minQ ? adj : 0;
  } catch(e) {
    if (rawQty>1000) return Math.floor(rawQty);
    if (rawQty>1)    return parseFloat(rawQty.toFixed(2));
    return parseFloat(rawQty.toFixed(5));
  }
}

// ── BUY ──────────────────────────────────────────────
async function buy(symbol, usdtAmt, tag) {
  if (!usdtAmt||usdtAmt<1||isNaN(usdtAmt)) return null;
  if (freeUSDT<usdtAmt*0.98) {
    log(`[${tag}] Sem USDT: $${freeUSDT.toFixed(2)} < $${usdtAmt.toFixed(2)}`);
    return null;
  }
  const price=await getPrice(symbol);
  if (!price||price<=0) return null;
  const qty=await getAdjQty(symbol,usdtAmt/price);
  if (!qty||qty<=0) return null;

  log(`[${tag}][${PAPER_MODE?'SIM':'REAL'}] BUY ${qty} ${symbol} @ $${price.toFixed(6)} (~$${usdtAmt.toFixed(2)})`);

  if (!PAPER_MODE) {
    try {
      await signedPost('/api/v3/order',{symbol,side:'BUY',type:'MARKET',quantity:qty});
    } catch(e) {
      log(`Erro compra ${symbol}: ${e.response?.data?.msg||e.message}`);
      return null;
    }
  }

  freeUSDT-=usdtAmt;
  tradeCount++;
  await notify(`capital. 🟢 [${tag}]`,`${symbol.replace('USDT','')} @ $${price.toFixed(4)} (~$${usdtAmt.toFixed(2)})`);
  return {entryPrice:price, qty, usdt:usdtAmt, ts:Date.now(), tag};
}

// ── SELL ─────────────────────────────────────────────
async function sell(symbol, pos, reason) {
  const price=await getPrice(symbol);
  if (!price) return false;
  const pct=((price-pos.entryPrice)/pos.entryPrice)*100;
  const pnl=pos.usdt*(pct/100);
  totalPnL+=pnl;
  freeUSDT+=pos.usdt+pnl;

  log(`[${pos.tag}][${PAPER_MODE?'SIM':'REAL'}] SELL ${symbol} @ $${price.toFixed(6)} | ${pct.toFixed(2)}% | $${pnl.toFixed(2)} | ${reason}`);

  if (!PAPER_MODE) {
    try {
      await signedPost('/api/v3/order',{symbol,side:'SELL',type:'MARKET',quantity:pos.qty});
    } catch(e) {
      log(`Erro venda ${symbol}: ${e.response?.data?.msg||e.message}`);
      return false;
    }
  }

  tradeCount++;
  const roi=startBalance>0?((totalPnL/startBalance)*100).toFixed(1):'0';
  await notify(`capital. ${pnl>=0?'📈':'📉'} [${pos.tag}]`,
    `${symbol.replace('USDT','')} ${pct>=0?'+':''}${pct.toFixed(2)}% ($${pnl.toFixed(2)})\nROI: ${roi}%`);

  if (startBalance>0) {
    if (totalPnL<=-(startBalance*PAUSE_LOSS_PCT)) { paused=true; notify('capital. ⛔ Pausado',`Perda $${Math.abs(totalPnL).toFixed(2)}`); }
    if (totalPnL>= startBalance*PAUSE_WIN_PCT)    { paused=true; notify('capital. 🏆 Meta!',`Lucro $${totalPnL.toFixed(2)}`); }
  }
  return true;
}

// ── REBALANCE CHECK ───────────────────────────────────
// Called every cycle to ensure allocations stay correct
async function checkRebalance() {
  const holdInUse  = Object.values(holdPos).reduce((s,p)=>s+p.usdt,0);
  const trendInUse = Object.values(trendPos).reduce((s,p)=>s+p.usdt,0);
  const dipInUse   = Object.values(dipPos).reduce((s,p)=>s+p.usdt,0);
  const totalInUse = holdInUse+trendInUse+dipInUse+freeUSDT;

  const targetHold  = totalInUse*HOLD_PCT;
  const targetTrend = totalInUse*TREND_PCT;
  const targetDip   = totalInUse*DIP_PCT;

  log(`Alocação: Hold=$${holdInUse.toFixed(2)}/$${targetHold.toFixed(2)} | Trend=$${trendInUse.toFixed(2)}/$${targetTrend.toFixed(2)} | Dip=$${dipInUse.toFixed(2)}/$${targetDip.toFixed(2)}`);
}

// ── STRATEGY 1: HOLD ──────────────────────────────────
async function manageHolds() {
  const totalCapital = totalBalance;
  const targetPerCoin = (totalCapital * HOLD_PCT) / HOLD_COINS.length;

  // Manage existing holds
  for (const symbol of [...Object.keys(holdPos)]) {
    const pos=holdPos[symbol];
    const price=await getPrice(symbol);
    if (!price) continue;
    const pct=((price-pos.entryPrice)/pos.entryPrice)*100;
    log(`[HOLD] ${symbol} ${pct>=0?'+':''}${pct.toFixed(2)}%`);

    if (pct>=HOLD_TP) {
      await sell(symbol,pos,`TP +${pct.toFixed(1)}%`);
      delete holdPos[symbol];
      await new Promise(r=>setTimeout(r,500));
      const p=await buy(symbol,(totalBalance*HOLD_PCT)/HOLD_COINS.length,'HOLD');
      if (p) holdPos[symbol]=p;
    } else if (pct<=-HOLD_SL) {
      await sell(symbol,pos,`SL emergência ${pct.toFixed(1)}%`);
      delete holdPos[symbol];
    }
  }

  // Buy missing holds if we have enough free USDT
  for (const symbol of HOLD_COINS) {
    if (holdPos[symbol]) continue;
    const amt=Math.min(targetPerCoin, freeUSDT*0.95);
    if (amt<2) continue;
    const p=await buy(symbol,amt,'HOLD');
    if (p) holdPos[symbol]=p;
    await new Promise(r=>setTimeout(r,400));
  }
}

// ── STRATEGY 2: TREND FOLLOWING ───────────────────────
async function manageTrend() {
  const trendCap = totalBalance * TREND_PCT;
  const trendInUse = Object.values(trendPos).reduce((s,p)=>s+p.usdt,0);

  // Manage existing trend positions
  for (const symbol of [...Object.keys(trendPos)]) {
    const pos=trendPos[symbol];
    const price=await getPrice(symbol);
    if (!price) continue;
    const pct=((price-pos.entryPrice)/pos.entryPrice)*100;

    if (pct>=TREND_TP) {
      await sell(symbol,pos,`Trend TP +${pct.toFixed(2)}%`);
      delete trendPos[symbol];
    } else if (pct<=-TREND_SL) {
      await sell(symbol,pos,`Trend SL ${pct.toFixed(2)}%`);
      delete trendPos[symbol];
    } else {
      const k=await getKlines(symbol,'1h',16);
      if (calcRSI(k)>TREND_RSI_SELL && pct>1) {
        await sell(symbol,pos,`RSI alto ${calcRSI(k).toFixed(0)}`);
        delete trendPos[symbol];
      }
    }
  }

  if (trendInUse>=trendCap*0.95) return;
  if (freeUSDT<2) return;

  // Scan TRADE_COINS for trend signals
  const signals = await Promise.all(TRADE_COINS.map(async symbol => {
    if (trendPos[symbol]) return null;
    try {
      const [k1h, k5m] = await Promise.all([
        getKlines(symbol,'1h',3),
        getKlines(symbol,'5m',4)
      ]);
      const change1h = ch1h(k1h);
      const change5m = ch1h(k5m);
      const rsi = calcRSI(k1h);
      const ticker = await getTicker(symbol);
      const vol = ticker ? parseFloat(ticker.quoteVolume) : 0;
      return {symbol, change1h, change5m, rsi, vol};
    } catch(e) { return null; }
  }));

  // Sort by 1h performance, buy the best
  const valid = signals
    .filter(s=>s && s.change1h>=TREND_BUY_CH1H && s.vol>50000 && s.rsi<80)
    .sort((a,b)=>b.change1h-a.change1h);

  for (const sig of valid) {
    if (freeUSDT<2) break;
    const available = trendCap-trendInUse;
    if (available<2) break;

    // More capital for stronger trends
    const strength = Math.min(sig.change1h/TREND_BUY_CH1H, 3);
    const amt = Math.min(available, Math.max(2, (trendCap/TRADE_COINS.length)*strength));

    log(`[TREND] ${sig.symbol} +${sig.change1h.toFixed(1)}% 1h | RSI:${sig.rsi.toFixed(0)} | $${amt.toFixed(2)}`);
    const p=await buy(sig.symbol, amt, 'TREND');
    if (p) trendPos[sig.symbol]=p;
    await new Promise(r=>setTimeout(r,300));
  }
}

// ── STRATEGY 3: DIP BUYING ────────────────────────────
async function manageDips() {
  const dipCap = totalBalance * DIP_PCT;
  const dipInUse = Object.values(dipPos).reduce((s,p)=>s+p.usdt,0);

  // Manage existing dip positions
  for (const symbol of [...Object.keys(dipPos)]) {
    const pos=dipPos[symbol];
    const price=await getPrice(symbol);
    if (!price) continue;
    const pct=((price-pos.entryPrice)/pos.entryPrice)*100;

    if (pct>=DIP_TP) {
      await sell(symbol,pos,`Dip TP +${pct.toFixed(2)}%`);
      delete dipPos[symbol];
    } else if (pct<=-DIP_SL) {
      await sell(symbol,pos,`Dip SL ${pct.toFixed(2)}%`);
      delete dipPos[symbol];
    }
  }

  if (dipInUse>=dipCap*0.95) return;
  if (freeUSDT<2) return;

  // Scan for dips
  const signals = await Promise.all(TRADE_COINS.map(async symbol => {
    if (dipPos[symbol]) return null;
    try {
      const k1h = await getKlines(symbol,'1h',16);
      const change1h = ch1h(k1h);
      const rsi = calcRSI(k1h);
      return {symbol, change1h, rsi};
    } catch(e) { return null; }
  }));

  const dips = signals
    .filter(s=>s && s.change1h<=DIP_BUY_CH1H && s.rsi<=DIP_RSI_BUY)
    .sort((a,b)=>a.change1h-b.change1h); // biggest dip first

  for (const dip of dips) {
    if (freeUSDT<2) break;
    const available = dipCap-dipInUse;
    if (available<2) break;

    const amt = Math.min(available, dipCap/TRADE_COINS.length);
    log(`[DIP] ${dip.symbol} ${dip.change1h.toFixed(1)}% 1h | RSI:${dip.rsi.toFixed(0)} | $${amt.toFixed(2)}`);
    const p=await buy(dip.symbol, amt, 'DIP');
    if (p) dipPos[dip.symbol]=p;
    await new Promise(r=>setTimeout(r,300));
  }
}

// ── STRATEGY 5: SENTIMENT (NEWS) ─────────────────────
const SENT_COINS = {
  'Bitcoin':  'BTCUSDT',
  'Ethereum': 'ETHUSDT',
  'Solana':   'SOLUSDT',
  'XRP':      'XRPUSDT',
  'Dogecoin': 'DOGEUSDT',
  'BNB':      'BNBUSDT',
  'CHIP':     'CHIPUSDT',
  'Elon':     'DOGEUSDT', // Elon mentions often affect DOGE
};

async function fetchSentiment(query) {
  const cached = sentCache[query];
  if (cached && Date.now()-cached.ts < 600000) return cached.score; // 10min cache
  try {
    const r = await axios.get(
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(query+' crypto')}&language=en&sortBy=publishedAt&pageSize=15&apiKey=${NEWS_KEY}`,
      {timeout:8000}
    );
    let score = 0;
    const articles = r.data.articles || [];
    articles.forEach(a => {
      const txt = ((a.title||'')+(a.description||'')).toLowerCase();
      SENT_POS_WORDS.forEach(w => { if(txt.includes(w)) score+=0.1; });
      SENT_NEG_WORDS.forEach(w => { if(txt.includes(w)) score-=0.1; });
    });
    score = Math.max(-1, Math.min(1, parseFloat(score.toFixed(2))));
    sentCache[query] = {score, ts:Date.now(), articles:articles.length};
    log(`[SENT] ${query} score:${score} (${articles.length} artigos)`);
    return score;
  } catch(e) { return 0; }
}

async function manageSentiment() {
  const sentCap   = totalBalance * SENT_PCT;
  const sentInUse = Object.values(sentPos).reduce((s,p)=>s+p.usdt,0);

  // Manage existing sentiment positions
  for (const symbol of [...Object.keys(sentPos)]) {
    const pos   = sentPos[symbol];
    const price = await getPrice(symbol);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    if (pct>=SENT_TP) {
      await sell(symbol,pos,`Sent TP +${pct.toFixed(2)}%`);
      delete sentPos[symbol];
    } else if (pct<=-SENT_SL) {
      await sell(symbol,pos,`Sent SL ${pct.toFixed(2)}%`);
      delete sentPos[symbol];
    }
  }

  if (Object.keys(sentPos).length>=SENT_MAX_POS) return;
  if (freeUSDT<1) return;

  // Rotate through coins to analyze
  const coins = Object.keys(SENT_COINS);
  const coin  = coins[Math.floor(Date.now()/120000) % coins.length]; // change every 2 min
  const symbol = SENT_COINS[coin];
  if (sentPos[symbol]) return;

  const score = await fetchSentiment(coin);

  if (score>=SENT_BUY_SCORE) {
    const amt = Math.min(freeUSDT*0.50, sentCap/SENT_MAX_POS);
    if (amt<1) return;
    log(`[SENT] Comprando ${symbol} — score:${score} (notícias positivas sobre ${coin})`);
    const p = await buy(symbol, amt, 'SENT');
    if (p) {
      sentPos[symbol] = {...p, score, coin};
      await notify(`capital. 📰 Sentiment!`,
        `${coin} score: +${score}
Notícias positivas detectadas
Comprando ${symbol.replace('USDT','')} $${amt.toFixed(2)}`);
    }
  } else if (score<=-SENT_BUY_SCORE) {
    // Negative news — sell if holding
    if (sentPos[symbol]) {
      await sell(symbol,sentPos[symbol],`Notícia negativa score:${score}`);
      delete sentPos[symbol];
      await notify(`capital. 📰 Notícia negativa!`,`${coin} score:${score}
Vendendo posição`);
    }
    // Also sell trend/dip if very negative
    if (score<-0.6 && trendPos[symbol]) {
      await sell(symbol,trendPos[symbol],`Notícia urgente negativa score:${score}`);
      delete trendPos[symbol];
    }
  }
}

// ── FREE CAPITAL ─────────────────────────────────────
async function freeCapitalIfNeeded() {
  if (freeUSDT >= 2) return; // enough to trade
  
  log('[CAPITAL] USDT insuficiente — procurando pior posição para vender...');

  // Check all non-hold positions for worst performer
  let worstSymbol = null;
  let worstPct    = 0;
  let worstPos    = null;
  let worstType   = null;

  for (const [sym, pos] of Object.entries(trendPos)) {
    const price = await getPrice(sym);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    if (pct < worstPct) { worstPct=pct; worstSymbol=sym; worstPos=pos; worstType='trend'; }
  }
  for (const [sym, pos] of Object.entries(dipPos)) {
    const price = await getPrice(sym);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    if (pct < worstPct) { worstPct=pct; worstSymbol=sym; worstPos=pos; worstType='dip'; }
  }
  for (const [sym, pos] of Object.entries(oppPos)) {
    const price = await getPrice(sym);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    if (pct < worstPct) { worstPct=pct; worstSymbol=sym; worstPos=pos; worstType='opp'; }
  }
  for (const [sym, pos] of Object.entries(sentPos)) {
    const price = await getPrice(sym);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    if (pct < worstPct) { worstPct=pct; worstSymbol=sym; worstPos=pos; worstType='sent'; }
  }

  // Collect ALL non-hold positions with their performance
  const allPositions = [];
  for (const [sym,pos] of Object.entries(trendPos)) {
    const price = await getPrice(sym);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    allPositions.push({sym, pos, pct, type:'trend'});
  }
  for (const [sym,pos] of Object.entries(dipPos)) {
    const price = await getPrice(sym);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    allPositions.push({sym, pos, pct, type:'dip'});
  }
  for (const [sym,pos] of Object.entries(oppPos)) {
    const price = await getPrice(sym);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    allPositions.push({sym, pos, pct, type:'opp'});
  }
  for (const [sym,pos] of Object.entries(sentPos)) {
    const price = await getPrice(sym);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    allPositions.push({sym, pos, pct, type:'sent'});
  }

  // Sort by worst performance and sell bottom 3
  allPositions.sort((a,b)=>a.pct-b.pct);
  const toSell = allPositions.slice(0, 3);

  if (toSell.length > 0) {
    for (const item of toSell) {
      log(`[CAPITAL] Vendendo ${item.sym} (${item.pct.toFixed(2)}%)`);
      await sell(item.sym, item.pos, `Liberando capital (${item.pct.toFixed(2)}%)`);
      if (item.type==='trend') delete trendPos[item.sym];
      if (item.type==='dip')   delete dipPos[item.sym];
      if (item.type==='opp')   delete oppPos[item.sym];
      if (item.type==='sent')  delete sentPos[item.sym];
      await new Promise(r=>setTimeout(r,300));
    }
    await fetchBalance();
    return;
  }

  // If no tracked positions, check actual Binance balance for untracked coins
  try {
    const data = await signedGet('/api/v3/account');
    let worstAsset=null, worstVal=Infinity, worstQty=0;
    const NEVER_SELL = new Set(['BTC','ETH','SOL','USDT','BRL','EUR','GBP','BUSD','USDC']);
    
    for (const b of data.balances) {
      const qty = parseFloat(b.free);
      if (qty<=0) continue;
      if (NEVER_SELL.has(b.asset)) continue;
      const symbol = b.asset+'USDT';
      const price  = await getPrice(symbol);
      if (!price || qty*price<0.5) continue;
      // Check 24h performance
      const ticker = await getTicker(symbol);
      if (!ticker) continue;
      const ch24h = parseFloat(ticker.priceChangePercent);
      if (ch24h < worstVal) { worstVal=ch24h; worstAsset=b.asset; worstQty=qty; }
    }

    if (worstAsset) {
      log(`[CAPITAL] Vendendo ${worstAsset} não rastreado (24h: ${worstVal.toFixed(1)}%)`);
      const symbol = worstAsset+'USDT';
      const qty    = await getAdjQty(symbol, worstQty);
      if (qty>0 && !PAPER_MODE) {
        await signedPost('/api/v3/order',{symbol,side:'SELL',type:'MARKET',quantity:qty});
        log(`[CAPITAL] Vendido ${qty} ${worstAsset}`);
      }
      await fetchBalance();
    }
  } catch(e) { log(`Erro freeCapital: ${e.message}`); }
}

// ── MAIN LOOP ─────────────────────────────────────────
async function runBot() {
  if (paused) { log('Bot pausado — use /resume para retomar'); return; }
  lastCycle = new Date().toISOString();

  await fetchBalance();
  if (totalBalance<=0) { log('Sem saldo'); return; }
  
  // Free up capital if needed
  if (freeUSDT < 2) await freeCapitalIfNeeded();

  const holdInUse  = Object.values(holdPos).reduce((s,p)=>s+p.usdt,0);
  const trendInUse = Object.values(trendPos).reduce((s,p)=>s+p.usdt,0);
  const dipInUse   = Object.values(dipPos).reduce((s,p)=>s+p.usdt,0);
  const roi = startBalance>0?((totalPnL/startBalance)*100).toFixed(1):'0';

  log(`=== PnL:$${totalPnL.toFixed(2)}(${roi}%) | USDT:$${freeUSDT.toFixed(2)} | Hold:$${holdInUse.toFixed(0)} Trend:$${trendInUse.toFixed(0)} Dip:$${dipInUse.toFixed(0)} ===`);

  await checkRebalance();
  await manageHolds();
  await manageTrend();
  await manageDips();
}

// ── HTTP SERVER ───────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type','application/json');

  if (req.url==='/pause') {
    paused=true;
    log('Bot PAUSADO');
    await notify('capital. ⛔ Bot pausado','Use /resume para retomar');
    return res.end(JSON.stringify({paused:true}));
  }

  if (req.url==='/resume') {
    paused=false;
    log('Bot RETOMADO');
    await notify('capital. ▶️ Bot retomado','Bot voltou a operar!');
    return res.end(JSON.stringify({paused:false}));
  }

  if (req.url==='/status'||req.method==='GET') {
    const holdInUse  = Object.values(holdPos).reduce((s,p)=>s+p.usdt,0);
    const trendInUse = Object.values(trendPos).reduce((s,p)=>s+p.usdt,0);
    const dipInUse   = Object.values(dipPos).reduce((s,p)=>s+p.usdt,0);
    return res.end(JSON.stringify({
      status:'online', mode:PAPER_MODE?'simulado':'real',
      paused, lastCycle, tradeCount,
      pnl:`$${totalPnL.toFixed(2)}`,
      roi:startBalance>0?`${((totalPnL/startBalance)*100).toFixed(1)}%`:'0%',
      capital:{
        total:`$${totalBalance.toFixed(2)}`,
        freeUSDT:`$${freeUSDT.toFixed(2)}`,
        holdTarget:`$${(totalBalance*HOLD_PCT).toFixed(2)} (50%)`,
        trendTarget:`$${(totalBalance*TREND_PCT).toFixed(2)} (35%)`,
        dipTarget:`$${(totalBalance*DIP_PCT).toFixed(2)} (15%)`,
        holdInUse:`$${holdInUse.toFixed(2)}`,
        trendInUse:`$${trendInUse.toFixed(2)}`,
        dipInUse:`$${dipInUse.toFixed(2)}`,
      },
      positions:{ hold:holdPos, trend:trendPos, dip:dipPos, opportunist:oppPos, sentiment:sentPos },
      coins:{ holds:HOLD_COINS, trades:TRADE_COINS }
    }));
  }

  res.end(JSON.stringify({error:'unknown endpoint'}));
});

// ── START ─────────────────────────────────────────────
server.listen(PORT, async () => {
  log(`capital. Bot v6 | ${PAPER_MODE?'SIMULADO':'REAL'} | Ciclo:${CYCLE_MS/1000}s`);
  log(`Holds: ${HOLD_COINS.join(', ')}`);
  log(`Trades: ${TRADE_COINS.join(', ')}`);
  log(`Alocação: Hold 45% | Trend 25% | Dip 13% | Opp 12% | Sent 5%`);
  await loadSymbols();
  await fetchBalance();
  startBalance=totalBalance;
  log(`Capital inicial: $${startBalance.toFixed(2)}`);
  await notify('capital. 🚀 Bot v6!',
    `Capital: $${startBalance.toFixed(2)}\nHold 50%: BTC+ETH+SOL\nTrend 35%: XRP+CHIP+DOGE+BNB+BIA\nDip 15%: compra nas quedas`);
  setInterval(runBot, CYCLE_MS);
  runBot();
});
