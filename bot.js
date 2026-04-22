const http   = require('http');
const axios  = require('axios');
const crypto = require('crypto');

// ── CONFIG ──────────────────────────────────────────
const API_KEY    = process.env.BINANCE_API_KEY    || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const PAPER_MODE = process.env.PAPER_MODE !== 'false';
const NOTIFY_URL = process.env.NOTIFY_URL || '';
const NEWS_KEY   = '8c729e78ee7e477295c572995346f88f';
const PORT       = process.env.PORT || 3000;
const BASE       = 'https://api.binance.com';

// ── STRATEGY ────────────────────────────────────────
const HOLD_COINS     = ['BTCUSDT','ETHUSDT','SOLUSDT'];
const HOLD_PCT       = 0.50;   // 50% of free USDT in holds
const HOLD_TP        = 40;     // sell hold at +40%
const HOLD_SL        = 25;     // sell hold at -25%

const TRADE_PCT      = 0.50;   // remaining 50% for active trading
const MAX_POSITIONS  = 6;      // max active trading positions
const TRADE_ALLOC    = 0.25;   // each trade uses 25% of trade capital
const TRADE_TP       = 8;      // take profit +8% for trending coins
const TRADE_SL       = 4;      // stop loss -4%
const PUMP_TP        = 15;     // take profit +15% for pumping coins
const PUMP_SL        = 5;      // stop loss -5% for pumping coins

const CYCLE_MS       = 8000;   // run every 8 seconds
const SCAN_SIZE      = 80;     // pairs to scan per cycle
const PAUSE_LOSS_PCT = 0.25;   // pause if lose 25%
const PAUSE_WIN_PCT  = 0.50;   // pause if gain 50%

// ── KEEP LIST (never sell these) ────────────────────
const KEEP_ASSETS = new Set([
  'USDT','BTC','ETH','SOL','BRL','EUR','GBP','BUSD','USDC'
]);

// ── STATE ────────────────────────────────────────────
let freeUSDT     = 0;
let totalBalance = 0;
let startBalance = 0;
let holdPos      = {};
let tradePos     = {};  // active trend/pump positions
let sentCache    = {};
let totalPnL     = 0;
let tradeCount   = 0;
let paused       = false;
let lastCycle    = null;
let allSymbols   = [];

// ── UTILS ────────────────────────────────────────────
const log = msg => console.log(`[${new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}] ${msg}`);

async function notify(title, body) {
  if (!NOTIFY_URL) return;
  try { await axios.post(NOTIFY_URL+'/test-send',{title,body},{timeout:5000}); } catch(e){}
}

async function apiGet(path, params={}) {
  const r = await axios.get(BASE+path, {params, timeout:8000});
  return r.data;
}

async function signedGet(path, params={}) {
  const ts  = Date.now();
  const q   = Object.entries({...params,timestamp:ts}).map(([k,v])=>`${k}=${v}`).join('&');
  const sig = crypto.createHmac('sha256',API_SECRET).update(q).digest('hex');
  const r   = await axios.get(`${BASE}${path}?${q}&signature=${sig}`, {
    headers:{'X-MBX-APIKEY':API_KEY}, timeout:8000
  });
  return r.data;
}

async function signedPost(path, params={}) {
  const ts  = Date.now();
  const q   = Object.entries({...params,timestamp:ts}).map(([k,v])=>`${k}=${v}`).join('&');
  const sig = crypto.createHmac('sha256',API_SECRET).update(q).digest('hex');
  const r   = await axios.post(`${BASE}${path}?${q}&signature=${sig}`, null, {
    headers:{'X-MBX-APIKEY':API_KEY}, timeout:8000
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

async function getKlines(symbol, interval='5m', limit=20) {
  try {
    const d = await apiGet('/api/v3/klines',{symbol,interval,limit});
    return d.map(k=>parseFloat(k[4]));
  } catch(e) { return []; }
}

function calcRSI(prices, period=14) {
  if (prices.length < period+1) return 50;
  let g=0,l=0;
  for (let i=prices.length-period; i<prices.length; i++) {
    const d=prices[i]-prices[i-1];
    d>0?g+=d:l+=Math.abs(d);
  }
  const rs=(g/period)/((l/period)||0.001);
  return 100-(100/(1+rs));
}

// ── BALANCE ──────────────────────────────────────────
async function fetchBalance() {
  try {
    const data = await signedGet('/api/v3/account');
    let usdt=0, total=0;
    for (const b of data.balances) {
      const qty = parseFloat(b.free)+parseFloat(b.locked);
      if (qty<=0) continue;
      if (b.asset==='USDT') { usdt=parseFloat(b.free); total+=qty; continue; }
      if (['BRL','EUR','GBP','BUSD','USDC'].includes(b.asset)) continue;
      try {
        const p = await getPrice(b.asset+'USDT');
        if (p>0) total+=qty*p;
      } catch(e) {}
    }
    freeUSDT=usdt; totalBalance=total;
    log(`Saldo: total=$${total.toFixed(2)} | USDT livre=$${usdt.toFixed(2)}`);
  } catch(e) { log(`Erro saldo: ${e.message}`); }
}

// ── LOAD SYMBOLS ─────────────────────────────────────
async function loadSymbols() {
  try {
    const d = await apiGet('/api/v3/exchangeInfo');
    allSymbols = d.symbols
      .filter(s=>s.quoteAsset==='USDT' && s.status==='TRADING')
      .map(s=>s.symbol);
    log(`${allSymbols.length} pares USDT carregados`);
  } catch(e) { log(`Erro símbolos: ${e.message}`); }
}

// ── GET LOT SIZE ──────────────────────────────────────
async function getAdjQty(symbol, rawQty) {
  try {
    const info = await apiGet('/api/v3/exchangeInfo',{symbol});
    const lot  = info.symbols[0].filters.find(f=>f.filterType==='LOT_SIZE');
    const step = parseFloat(lot.stepSize);
    const minQ = parseFloat(lot.minQty);
    const adj  = parseFloat((Math.floor(rawQty/step)*step).toFixed(8));
    return adj >= minQ ? adj : 0;
  } catch(e) {
    // fallback
    if (rawQty > 1000) return Math.floor(rawQty);
    if (rawQty > 10)   return parseFloat(rawQty.toFixed(1));
    if (rawQty > 1)    return parseFloat(rawQty.toFixed(2));
    if (rawQty > 0.01) return parseFloat(rawQty.toFixed(4));
    return parseFloat(rawQty.toFixed(6));
  }
}

// ── BUY ───────────────────────────────────────────────
async function buy(symbol, usdtAmt, tag='TRADE') {
  if (!usdtAmt || usdtAmt<1 || isNaN(usdtAmt)) return null;
  if (freeUSDT < usdtAmt*0.98) {
    log(`[${tag}] Sem USDT: $${freeUSDT.toFixed(2)} < $${usdtAmt.toFixed(2)}`);
    return null;
  }
  const price = await getPrice(symbol);
  if (!price || price<=0) return null;
  const qty = await getAdjQty(symbol, usdtAmt/price);
  if (!qty || qty<=0) return null;

  log(`[${tag}][${PAPER_MODE?'SIM':'REAL'}] BUY ${qty} ${symbol} @ $${price.toFixed(6)} (~$${usdtAmt.toFixed(2)})`);

  if (!PAPER_MODE) {
    try {
      await signedPost('/api/v3/order',{symbol,side:'BUY',type:'MARKET',quantity:qty});
    } catch(e) {
      log(`Erro compra ${symbol}: ${e.response?.data?.msg||e.message}`);
      return null;
    }
  }

  freeUSDT -= usdtAmt;
  tradeCount++;
  await notify(`capital. 🟢 [${tag}]`,`${qty} ${symbol.replace('USDT','')} @ $${price.toFixed(4)} (~$${usdtAmt.toFixed(2)})`);
  return {entryPrice:price, qty, usdt:usdtAmt, ts:Date.now(), tag};
}

// ── SELL ──────────────────────────────────────────────
async function sell(symbol, pos, reason) {
  const price = await getPrice(symbol);
  if (!price) return false;
  const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
  const pnl = pos.usdt*(pct/100);
  totalPnL += pnl;
  freeUSDT += pos.usdt+pnl;

  log(`[${pos.tag||'TRADE'}][${PAPER_MODE?'SIM':'REAL'}] SELL ${symbol} @ $${price.toFixed(6)} | ${pct.toFixed(2)}% | $${pnl.toFixed(2)} | ${reason}`);

  if (!PAPER_MODE) {
    try {
      await signedPost('/api/v3/order',{symbol,side:'SELL',type:'MARKET',quantity:pos.qty});
    } catch(e) {
      log(`Erro venda ${symbol}: ${e.response?.data?.msg||e.message}`);
      return false;
    }
  }

  tradeCount++;
  const roi = startBalance>0 ? ((totalPnL/startBalance)*100).toFixed(1) : '0';
  await notify(`capital. ${pnl>=0?'📈':'📉'} [${pos.tag||'TRADE'}]`,
    `${symbol.replace('USDT','')} ${pct>=0?'+':''}${pct.toFixed(2)}% ($${pnl.toFixed(2)})\nROI: ${roi}% | PnL: $${totalPnL.toFixed(2)}`);

  if (startBalance>0) {
    if (totalPnL<=-(startBalance*PAUSE_LOSS_PCT)) { paused=true; notify('capital. ⛔ Pausado',`Perda $${Math.abs(totalPnL).toFixed(2)}`); }
    if (totalPnL>= startBalance*PAUSE_WIN_PCT)    { paused=true; notify('capital. 🏆 Meta!',`Lucro $${totalPnL.toFixed(2)}`); }
  }
  return true;
}

// ── SELL ASSET DIRECTLY (for cleanup) ─────────────────
async function sellAsset(asset, qty) {
  const symbol = asset+'USDT';
  try {
    const adjQty = await getAdjQty(symbol, qty);
    if (!adjQty || adjQty<=0) return false;
    if (!PAPER_MODE) {
      await signedPost('/api/v3/order',{symbol,side:'SELL',type:'MARKET',quantity:adjQty});
    }
    log(`[CLEANUP] Vendido ${adjQty} ${asset}`);
    return true;
  } catch(e) {
    log(`Erro cleanup ${asset}: ${e.response?.data?.msg||e.message}`);
    return false;
  }
}

// ── SCAN TOP PERFORMERS ───────────────────────────────
async function scanTopPerformers() {
  const exclude = new Set([
    ...HOLD_COINS,
    ...Object.keys(tradePos),
    'USDTUSDT'
  ]);

  const sample = allSymbols
    .filter(s=>!exclude.has(s))
    .sort(()=>Math.random()-0.5)
    .slice(0, SCAN_SIZE);

  const results = await Promise.all(sample.map(async symbol => {
    try {
      const ticker = await apiGet('/api/v3/ticker/24hr',{symbol});
      const ch1h_data = await getKlines(symbol,'1h',2);
      const ch5m_data = await getKlines(symbol,'5m',4);
      const ch24h = parseFloat(ticker.priceChangePercent);
      const ch1h  = ch1h_data.length>=2 ? ((ch1h_data[1]-ch1h_data[0])/ch1h_data[0])*100 : 0;
      const ch5m  = ch5m_data.length>=2 ? ((ch5m_data[ch5m_data.length-1]-ch5m_data[0])/ch5m_data[0])*100 : 0;
      const vol   = parseFloat(ticker.quoteVolume);
      // Score: weighted combination of timeframes
      const score = (ch5m*3) + (ch1h*2) + (ch24h*0.5);
      return {symbol, ch24h, ch1h, ch5m, vol, score};
    } catch(e) { return null; }
  }));

  return results
    .filter(r=>r && r.vol>100000 && r.ch1h>2) // min 2% in 1h + real volume
    .sort((a,b)=>b.score-a.score);
}

// ── MANAGE HOLDS ─────────────────────────────────────
async function manageHolds() {
  const holdAmt = (freeUSDT * HOLD_PCT) / HOLD_COINS.length;

  // Manage existing
  for (const symbol of [...Object.keys(holdPos)]) {
    const pos   = holdPos[symbol];
    const price = await getPrice(symbol);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    log(`[HOLD] ${symbol} ${pct>=0?'+':''}${pct.toFixed(2)}%`);
    if (pct>=HOLD_TP) {
      await sell(symbol, pos, `TP +${pct.toFixed(1)}%`);
      delete holdPos[symbol];
      // Rebuy
      await new Promise(r=>setTimeout(r,500));
      const p = await buy(symbol, (freeUSDT*HOLD_PCT)/HOLD_COINS.length, 'HOLD');
      if (p) holdPos[symbol]=p;
    } else if (pct<=-HOLD_SL) {
      await sell(symbol, pos, `SL ${pct.toFixed(1)}%`);
      delete holdPos[symbol];
    }
  }

  // Buy missing holds
  if (holdAmt>=2) {
    for (const symbol of HOLD_COINS) {
      if (!holdPos[symbol]) {
        const p = await buy(symbol, holdAmt, 'HOLD');
        if (p) holdPos[symbol]=p;
        await new Promise(r=>setTimeout(r,400));
      }
    }
  }
}

// ── MANAGE TRADE POSITIONS ────────────────────────────
async function manageTrades() {
  for (const symbol of [...Object.keys(tradePos)]) {
    const pos   = tradePos[symbol];
    const price = await getPrice(symbol);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    const tp   = pos.isPump ? PUMP_TP : TRADE_TP;
    const sl   = pos.isPump ? PUMP_SL : TRADE_SL;

    if (pct>=tp) {
      await sell(symbol, pos, `TP +${pct.toFixed(2)}%`);
      delete tradePos[symbol];
    } else if (pct<=-sl) {
      await sell(symbol, pos, `SL ${pct.toFixed(2)}%`);
      delete tradePos[symbol];
    }
  }
}

// ── BUY TOP PERFORMERS ────────────────────────────────
async function buyTopPerformers() {
  const tradeCap = freeUSDT * TRADE_PCT;
  const perTrade = Math.max(2, tradeCap * TRADE_ALLOC);
  const openCount = Object.keys(tradePos).length;

  if (openCount >= MAX_POSITIONS && freeUSDT < perTrade) return;

  const tops = await scanTopPerformers();
  if (tops.length===0) { log('Nenhum sinal forte encontrado'); return; }

  log(`Top performers: ${tops.slice(0,5).map(t=>`${t.symbol}(1h:${t.ch1h.toFixed(1)}% 5m:${t.ch5m.toFixed(1)}%)`).join(', ')}`);

  for (const top of tops) {
    if (Object.keys(tradePos).length >= MAX_POSITIONS) {
      // Check if this is better than worst current position
      let worstSym=null, worstPct=Infinity;
      for (const [sym,pos] of Object.entries(tradePos)) {
        const price = await getPrice(sym);
        if (!price) continue;
        const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
        if (pct<worstPct) { worstPct=pct; worstSym=sym; }
      }
      // Only rotate if new signal is much stronger AND worst is underperforming
      if (worstSym && worstPct<-1 && top.ch1h>10) {
        log(`[ROTATE] ${worstSym}(${worstPct.toFixed(1)}%) → ${top.symbol}(+${top.ch1h.toFixed(1)}%)`);
        await sell(worstSym, tradePos[worstSym], `Rotação para ${top.symbol}`);
        delete tradePos[worstSym];
      } else if (freeUSDT < perTrade) {
        break;
      }
    }

    if (tradePos[top.symbol]) continue;
    if (freeUSDT < perTrade) break;

    const isPump = top.ch1h > 15 || top.ch5m > 5;
    const amt    = isPump
      ? Math.min(freeUSDT*0.40, perTrade*2)  // more capital for big pumps
      : perTrade;

    const p = await buy(top.symbol, amt, isPump?'PUMP':'TREND');
    if (p) {
      tradePos[top.symbol] = {...p, isPump, score:top.score};
      if (isPump) {
        await notify(`capital. 🚀 PUMP ${top.symbol.replace('USDT','')}!`,
          `+${top.ch1h.toFixed(1)}% em 1h | +${top.ch5m.toFixed(1)}% em 5min\nComprando $${amt.toFixed(2)}`);
      }
    }
    await new Promise(r=>setTimeout(r,300));
  }
}

// ── SELL UNWANTED (cleanup) ───────────────────────────
async function sellUnwanted() {
  try {
    const data = await signedGet('/api/v3/account');
    for (const b of data.balances) {
      const qty = parseFloat(b.free);
      if (qty<=0) continue;
      if (KEEP_ASSETS.has(b.asset)) continue;
      // Check if it's a hold or trade position
      const symbol = b.asset+'USDT';
      if (holdPos[symbol] || tradePos[symbol]) continue;
      // Sell if value > $0.50
      const price = await getPrice(symbol);
      if (!price || qty*price < 0.50) continue;
      log(`[CLEANUP] Vendendo ${b.asset} ($${(qty*price).toFixed(2)})`);
      await sellAsset(b.asset, qty);
      await new Promise(r=>setTimeout(r,400));
    }
    await fetchBalance();
  } catch(e) { log(`Erro cleanup: ${e.message}`); }
}

// ── MAIN LOOP ─────────────────────────────────────────
async function runBot() {
  if (paused) { log('Bot pausado'); return; }
  lastCycle = new Date().toISOString();

  await fetchBalance();
  if (totalBalance<=0) { log('Sem saldo'); return; }

  const inUse = [...Object.values(holdPos),...Object.values(tradePos)].reduce((s,p)=>s+p.usdt,0);
  const roi   = startBalance>0 ? ((totalPnL/startBalance)*100).toFixed(1) : '0';
  log(`=== PnL:$${totalPnL.toFixed(2)}(${roi}%) | Trades:${tradeCount} | USDT:$${freeUSDT.toFixed(2)} | Hold:${Object.keys(holdPos).length} Active:${Object.keys(tradePos).length} ===`);

  await manageHolds();
  await manageTrades();
  await buyTopPerformers();
}

// ── HTTP SERVER ───────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type','application/json');

  // Status
  if (req.method==='GET') {
    return res.end(JSON.stringify({
      status:'online', mode:PAPER_MODE?'simulado':'real',
      paused, lastCycle, tradeCount,
      pnl:`$${totalPnL.toFixed(2)}`,
      roi: startBalance>0 ? `${((totalPnL/startBalance)*100).toFixed(1)}%` : '0%',
      capital:{
        total:`$${totalBalance.toFixed(2)}`,
        freeUSDT:`$${freeUSDT.toFixed(2)}`,
      },
      positions:{ hold:holdPos, active:tradePos }
    }));
  }

  // Pause/resume
  if (req.url==='/pause') {
    paused=!paused;
    log(`Bot ${paused?'PAUSADO':'RETOMADO'}`);
    return res.end(JSON.stringify({paused}));
  }

  // Force cleanup — sell everything not in holds
  if (req.url==='/cleanup') {
    log('Iniciando cleanup manual...');
    await sellUnwanted();
    return res.end(JSON.stringify({success:true, freeUSDT}));
  }

  // Rebalance — sell non-holds, buy top performers
  if (req.url==='/rebalance') {
    log('Iniciando rebalance...');
    // Sell all trade positions
    for (const [symbol,pos] of Object.entries(tradePos)) {
      await sell(symbol, pos, 'Rebalance manual');
      delete tradePos[symbol];
      await new Promise(r=>setTimeout(r,300));
    }
    // Sell unwanted assets
    await sellUnwanted();
    await fetchBalance();
    // Buy top performers with available capital
    await buyTopPerformers();
    return res.end(JSON.stringify({success:true, freeUSDT, positions:tradePos}));
  }

  // Manual buy — buy specific symbol
  if (req.url.startsWith('/buy/')) {
    const symbol = req.url.split('/buy/')[1].toUpperCase()+'USDT';
    const amt = freeUSDT * 0.30;
    const p = await buy(symbol, amt, 'MANUAL');
    if (p) tradePos[symbol]={...p};
    return res.end(JSON.stringify({success:!!p, symbol, amt}));
  }

  res.end(JSON.stringify({error:'unknown endpoint'}));
});

// ── START ─────────────────────────────────────────────
server.listen(PORT, async () => {
  log(`capital. Bot v5 | ${PAPER_MODE?'SIMULADO':'REAL'} | Ciclo:${CYCLE_MS/1000}s`);
  await loadSymbols();
  await fetchBalance();
  startBalance = totalBalance;
  log(`Capital inicial: $${startBalance.toFixed(2)}`);
  await notify('capital. 🚀 Bot v5 iniciado!', `Capital: $${startBalance.toFixed(2)}\nHold:BTC+ETH+SOL | Trading:Top performers`);
  setInterval(runBot, CYCLE_MS);
  runBot();
});
