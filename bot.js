const http   = require('http');
const axios  = require('axios');
const crypto = require('crypto');

const API_KEY    = process.env.BINANCE_API_KEY    || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const PAPER_MODE = process.env.PAPER_MODE !== 'false';
const NOTIFY_URL = process.env.NOTIFY_URL || '';
const PORT       = process.env.PORT || 3000;
const BASE       = 'https://api.binance.com';

// ── CONFIG ───────────────────────────────────────────
const HOLD_COINS   = ['BTCUSDT','ETHUSDT','SOLUSDT'];
const HOLD_PCT     = 0.50;
const HOLD_TP      = 20;
const HOLD_SL      = 12;

const TOP_N        = 5;       // always hold top 5 active trades
const MIN_VOL      = 500000;  // $500k min volume
const MIN_TRADE    = 5;       // $5 min per trade

const HARD_SL      = 3;       // sell if -3% from entry
const TRAIL_START  = 2;       // start trailing after +2% gain
const TRAIL_DROP   = 1;       // sell if drops 1% from peak
const MIN_SCORE    = 1;       // min score to buy (momentum threshold)

const PROTECT_MS   = 2000;    // check positions every 2 seconds
const RANK_MS      = 10000;   // refresh rankings every 10 seconds

const PAUSE_LOSS   = 0.20;
const PAUSE_WIN    = 0.50;

// ── STATE ────────────────────────────────────────────
let freeUSDT     = 0;
let totalBalance = 0;
let startBalance = 0;
let holdPos      = {};
let activePos    = {};
let rankings     = [];   // [{symbol, score, ch1h, ch5m, vol}]
let totalPnL     = 0;
let tradeCount   = 0;
let paused       = false;
let lastCycle    = null;
let cycleCount   = 0;

// ── UTILS ────────────────────────────────────────────
const log = msg => console.log(`[${new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}] ${msg}`);

async function notify(title, body) {
  if (!NOTIFY_URL) return;
  try { await axios.post(NOTIFY_URL+'/test-send',{title,body},{timeout:5000}); } catch(e){}
}

async function apiGet(path, params={}) {
  const r = await axios.get(BASE+path,{params,timeout:10000});
  return r.data;
}

async function signedGet(path, params={}) {
  const ts  = Date.now();
  const q   = Object.entries({...params,timestamp:ts}).map(([k,v])=>`${k}=${v}`).join('&');
  const sig = crypto.createHmac('sha256',API_SECRET).update(q).digest('hex');
  const r   = await axios.get(`${BASE}${path}?${q}&signature=${sig}`,{headers:{'X-MBX-APIKEY':API_KEY},timeout:10000});
  return r.data;
}

async function signedPost(path, params={}) {
  const ts  = Date.now();
  const q   = Object.entries({...params,timestamp:ts}).map(([k,v])=>`${k}=${v}`).join('&');
  const sig = crypto.createHmac('sha256',API_SECRET).update(q).digest('hex');
  const r   = await axios.post(`${BASE}${path}?${q}&signature=${sig}`,null,{headers:{'X-MBX-APIKEY':API_KEY},timeout:10000});
  return r.data;
}

async function getPrice(symbol) {
  try { return parseFloat((await apiGet('/api/v3/ticker/price',{symbol})).price); }
  catch(e) { return 0; }
}

async function getAdjQty(symbol, rawQty) {
  try {
    const info = await apiGet('/api/v3/exchangeInfo',{symbol});
    const lot  = info.symbols[0].filters.find(f=>f.filterType==='LOT_SIZE');
    const step = parseFloat(lot.stepSize);
    const minQ = parseFloat(lot.minQty);
    const adj  = parseFloat((Math.floor(rawQty/step)*step).toFixed(8));
    return adj >= minQ ? adj : 0;
  } catch(e) {
    if (rawQty>1000) return Math.floor(rawQty);
    if (rawQty>1)    return parseFloat(rawQty.toFixed(2));
    return parseFloat(rawQty.toFixed(5));
  }
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
      try { const p=await getPrice(b.asset+'USDT'); if(p>0) total+=qty*p; } catch(e){}
    }
    freeUSDT=usdt; totalBalance=total;
    log(`💰 Saldo: $${total.toFixed(2)} | USDT livre: $${usdt.toFixed(2)}`);
  } catch(e) { log(`Erro saldo: ${e.message}`); }
}

// ── RANKING — score all coins by momentum ─────────────
async function updateRankings() {
  try {
    const exclude = new Set(HOLD_COINS);
    const tickers = await apiGet('/api/v3/ticker/24hr');

    // Filter valid coins
    const valid = tickers.filter(t =>
      t.symbol.endsWith('USDT') &&
      !exclude.has(t.symbol) &&
      parseFloat(t.quoteVolume) >= MIN_VOL &&
      parseFloat(t.priceChangePercent) < 500 &&
      parseFloat(t.priceChangePercent) > -50
    );

    // Take top 60 by 24h to calculate 1h and 5m momentum
    const top60 = valid
      .sort((a,b) => parseFloat(b.priceChangePercent)-parseFloat(a.priceChangePercent))
      .slice(0, 60);

    const scored = await Promise.all(top60.map(async t => {
      try {
        const [k1h, k5m] = await Promise.all([
          apiGet('/api/v3/klines',{symbol:t.symbol,interval:'1h',limit:2}),
          apiGet('/api/v3/klines',{symbol:t.symbol,interval:'5m',limit:3})
        ]);
        const ch1h = k1h.length>=2 ? ((parseFloat(k1h[1][4])-parseFloat(k1h[0][4]))/parseFloat(k1h[0][4]))*100 : 0;
        const ch5m = k5m.length>=2 ? ((parseFloat(k5m[k5m.length-1][4])-parseFloat(k5m[0][4]))/parseFloat(k5m[0][4]))*100 : 0;
        const ch24h = parseFloat(t.priceChangePercent);

        // Score: 5min momentum matters most (real-time), then 1h, then 24h
        const score = (ch5m * 5) + (ch1h * 3) + (ch24h * 0.5);

        return { symbol:t.symbol, score, ch1h, ch5m, ch24h, vol:parseFloat(t.quoteVolume) };
      } catch(e) { return null; }
    }));

    rankings = scored
      .filter(r => r && r.score >= MIN_SCORE && r.ch5m >= 0) // only coins with positive 5m momentum
      .sort((a,b) => b.score-a.score);

    log(`📊 Rankings: ${rankings.slice(0,5).map(r=>`${r.symbol.replace('USDT','')}(5m:${r.ch5m>=0?'+':''}${r.ch5m.toFixed(1)}% 1h:${r.ch1h>=0?'+':''}${r.ch1h.toFixed(1)}%)`).join(' | ')}`);
  } catch(e) { log(`Erro rankings: ${e.message}`); }
}

// ── BUY ──────────────────────────────────────────────
async function buy(symbol, usdtAmt, tag) {
  if (!usdtAmt || usdtAmt<MIN_TRADE || isNaN(usdtAmt)) return null;
  if (freeUSDT < usdtAmt*0.98) return null;
  const price = await getPrice(symbol);
  if (!price || price<=0) return null;
  const qty = await getAdjQty(symbol, usdtAmt/price);
  if (!qty || qty<=0) return null;

  log(`[BUY] ${symbol} qty:${qty} @ $${price.toFixed(6)} (~$${usdtAmt.toFixed(2)}) [${tag}]`);
  if (!PAPER_MODE) {
    try { await signedPost('/api/v3/order',{symbol,side:'BUY',type:'MARKET',quantity:qty}); }
    catch(e) { log(`Erro compra ${symbol}: ${e.response?.data?.msg||e.message}`); return null; }
  }
  freeUSDT -= usdtAmt;
  tradeCount++;
  return { entryPrice:price, qty, usdt:usdtAmt, ts:Date.now(), tag, peak:price };
}

// ── SELL ─────────────────────────────────────────────
async function sell(symbol, pos, reason) {
  if (!pos || !pos.entryPrice) return false;
  const price = await getPrice(symbol);
  if (!price) return false;
  const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
  const pnl = pos.usdt*(pct/100);
  totalPnL += pnl;
  freeUSDT += pos.usdt + pnl;

  const emoji = pnl>=0 ? '📈' : '📉';
  log(`[SELL] ${symbol} @ $${price.toFixed(6)} | ${pct>=0?'+':''}${pct.toFixed(2)}% | $${pnl>=0?'+':''}${pnl.toFixed(2)} | ${reason}`);

  if (!PAPER_MODE) {
    try { await signedPost('/api/v3/order',{symbol,side:'SELL',type:'MARKET',quantity:pos.qty}); }
    catch(e) { log(`Erro venda ${symbol}: ${e.response?.data?.msg||e.message}`); return false; }
  }
  tradeCount++;
  const roi = startBalance>0 ? ((totalPnL/startBalance)*100).toFixed(1) : '0';
  await notify(`capital. ${emoji} ${symbol.replace('USDT','')}`,
    `${pct>=0?'+':''}${pct.toFixed(2)}% | $${pnl>=0?'+':''}${pnl.toFixed(2)}\nPnL total: $${totalPnL.toFixed(2)} (${roi}%)`);

  if (startBalance>0) {
    if (totalPnL <= -(startBalance*PAUSE_LOSS)) { paused=true; notify('capital. ⛔ PAUSADO',`Perda: $${Math.abs(totalPnL).toFixed(2)}`); }
    if (totalPnL >=  startBalance*PAUSE_WIN)    { paused=true; notify('capital. 🏆 META!',`Lucro: $${totalPnL.toFixed(2)}`); }
  }
  return true;
}

// ── MANAGE HOLDS ─────────────────────────────────────
async function manageHolds() {
  const perCoin = (totalBalance*HOLD_PCT)/HOLD_COINS.length;

  for (const symbol of [...Object.keys(holdPos)]) {
    if (!holdPos[symbol]) continue;
    const pos   = holdPos[symbol];
    const price = await getPrice(symbol);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    log(`[HOLD] ${symbol} ${pct>=0?'+':''}${pct.toFixed(2)}%`);

    if (pct >= HOLD_TP) {
      await sell(symbol, pos, `TP +${pct.toFixed(1)}%`);
      delete holdPos[symbol];
      await new Promise(r=>setTimeout(r,500));
      const p = await buy(symbol, Math.min((totalBalance*HOLD_PCT)/HOLD_COINS.length, freeUSDT*0.9), 'HOLD');
      if (p) holdPos[symbol] = p;
    } else if (pct <= -HOLD_SL) {
      await sell(symbol, pos, `SL ${pct.toFixed(1)}%`);
      delete holdPos[symbol];
    }
  }

  for (const symbol of HOLD_COINS) {
    if (holdPos[symbol]) continue;
    const amt = Math.min(perCoin, freeUSDT*0.9);
    if (amt < MIN_TRADE) continue;
    const p = await buy(symbol, amt, 'HOLD');
    if (p) holdPos[symbol] = p;
    await new Promise(r=>setTimeout(r,400));
  }
}

// ── MANAGE ACTIVE ─────────────────────────────────────
async function manageActive() {
  const topSymbols = new Set(rankings.slice(0, 20).map(r=>r.symbol));

  // STEP 1: Check all open positions — sell if needed
  for (const symbol of [...Object.keys(activePos)]) {
    if (!activePos[symbol]) continue;
    const pos = activePos[symbol];
    if (!pos || !pos.entryPrice) { delete activePos[symbol]; continue; }

    const price = await getPrice(symbol);
    if (!price) continue;

    // Update peak
    if (price > pos.peak) activePos[symbol].peak = price;

    const pct      = ((price-pos.entryPrice)/pos.entryPrice)*100;
    const fromPeak = ((price-pos.peak)/pos.peak)*100;
    const age      = Date.now()-pos.ts;

    let reason = null;

    // Hard stop loss
    if (pct <= -HARD_SL) {
      reason = `🛑 Hard SL ${pct.toFixed(2)}%`;
    }
    // Trailing stop — activated after TRAIL_START% gain
    else if (pct >= TRAIL_START && fromPeak <= -TRAIL_DROP) {
      reason = `📉 Trailing stop (lucro:${pct.toFixed(2)}% queda_do_topo:${fromPeak.toFixed(2)}%)`;
    }
    // Out of top 20 and negative after 2min
    else if (!topSymbols.has(symbol) && age > 120000 && pct < 0) {
      reason = `Saiu do ranking negativo ${pct.toFixed(2)}%`;
    }

    if (reason) {
      const ok = await sell(symbol, pos, reason);
      if (ok) delete activePos[symbol];
      await new Promise(r=>setTimeout(r,200));
    } else {
      log(`[ACTIVE] ${symbol} ${pct>=0?'+':''}${pct.toFixed(2)}% (peak:${fromPeak.toFixed(2)}%)`);
    }
  }

  // STEP 2: Buy top ranked coins we don't have
  const activeCap = totalBalance * (1-HOLD_PCT);
  const perPos    = Math.max(MIN_TRADE, activeCap/TOP_N);

  for (const coin of rankings.slice(0, TOP_N)) {
    if (activePos[coin.symbol]) continue;
    if (freeUSDT < MIN_TRADE) break;

    const amt = Math.min(perPos, freeUSDT*0.85);
    if (amt < MIN_TRADE) break;

    log(`[BUY] ${coin.symbol} score:${coin.score.toFixed(1)} 5m:${coin.ch5m>=0?'+':''}${coin.ch5m.toFixed(1)}% 1h:${coin.ch1h>=0?'+':''}${coin.ch1h.toFixed(1)}%`);
    const p = await buy(coin.symbol, amt, 'TREND');
    if (p) {
      activePos[coin.symbol] = { ...p, score:coin.score };
      if (coin.ch1h >= 5) {
        await notify(`capital. 🚀 ${coin.symbol.replace('USDT','')}`,
          `5m:+${coin.ch5m.toFixed(1)}% 1h:+${coin.ch1h.toFixed(1)}%\nComprando $${amt.toFixed(2)}`);
      }
    }
    await new Promise(r=>setTimeout(r,300));
  }
}

// ── FAST LOOP: protect positions every 2s ─────────────
let protecting = false;
async function protectPositions() {
  if (paused || protecting) return;
  protecting = true;
  lastCycle = new Date().toISOString();
  try {
    // Check all active positions for stop loss / trailing stop
    for (const symbol of [...Object.keys(activePos)]) {
      if (!activePos[symbol]) continue;
      const pos = activePos[symbol];
      if (!pos || !pos.entryPrice) { delete activePos[symbol]; continue; }

      const price = await getPrice(symbol);
      if (!price) continue;

      if (price > pos.peak) activePos[symbol].peak = price;

      const pct      = ((price-pos.entryPrice)/pos.entryPrice)*100;
      const fromPeak = ((price-pos.peak)/pos.peak)*100;
      const age      = Date.now()-pos.ts;

      let reason = null;
      if (pct <= -HARD_SL) {
        reason = `🛑 SL ${pct.toFixed(2)}%`;
      } else if (pct >= TRAIL_START && fromPeak <= -TRAIL_DROP) {
        reason = `📉 Trailing (lucro:${pct.toFixed(2)}% queda:${fromPeak.toFixed(2)}%)`;
      }

      if (reason) {
        const ok = await sell(symbol, pos, reason);
        if (ok) delete activePos[symbol];
      }
    }

    // Check holds too
    for (const symbol of [...Object.keys(holdPos)]) {
      if (!holdPos[symbol]) continue;
      const pos   = holdPos[symbol];
      const price = await getPrice(symbol);
      if (!price) continue;
      const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
      if (pct >= HOLD_TP) {
        await sell(symbol,pos,`TP +${pct.toFixed(1)}%`); delete holdPos[symbol];
        await new Promise(r=>setTimeout(r,500));
        const p=await buy(symbol,Math.min((totalBalance*HOLD_PCT)/HOLD_COINS.length,freeUSDT*0.9),'HOLD');
        if (p) holdPos[symbol]=p;
      } else if (pct <= -HOLD_SL) {
        await sell(symbol,pos,`SL ${pct.toFixed(1)}%`); delete holdPos[symbol];
      }
    }
  } catch(e) { log(`Erro protect: ${e.message}`); }
  protecting = false;
}

// ── RANKING LOOP: find best coins every 10s ────────────
let ranking = false;
async function rankAndBuy() {
  if (paused || ranking) return;
  ranking = true;
  try {
    await fetchBalance();
    if (totalBalance <= 0) { ranking=false; return; }

    await updateRankings();
    await manageHolds();
    await manageActive();

    const hi  = Object.values(holdPos).reduce((s,p)=>s+p.usdt,0);
    const ai  = Object.values(activePos).reduce((s,p)=>s+p.usdt,0);
    const roi = startBalance>0 ? ((totalPnL/startBalance)*100).toFixed(1) : '0';
    log(`=== PnL:$${totalPnL.toFixed(2)}(${roi}%) | USDT:$${freeUSDT.toFixed(2)} | Hold:$${hi.toFixed(0)} Active:$${ai.toFixed(0)}(${Object.keys(activePos).length}) ===`);
  } catch(e) { log(`Erro rankAndBuy: ${e.message}`); }
  ranking = false;
}

// ── HTTP SERVER ───────────────────────────────────────
const server = http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');

  if (req.url==='/pause')  { paused=true;  log('PAUSADO');  return res.end(JSON.stringify({paused:true})); }
  if (req.url==='/resume') { paused=false; log('RETOMADO'); return res.end(JSON.stringify({paused:false})); }

  if (req.url==='/rebalance') {
    for (const [s,p] of Object.entries(activePos)) {
      await sell(s,p,'Rebalance'); delete activePos[s];
      await new Promise(r=>setTimeout(r,300));
    }
    await fetchBalance();
    return res.end(JSON.stringify({success:true, freeUSDT, totalBalance}));
  }

  const hi = Object.values(holdPos).reduce((s,p)=>s+p.usdt,0);
  const ai = Object.values(activePos).reduce((s,p)=>s+p.usdt,0);
  res.end(JSON.stringify({
    status:'online',
    mode: PAPER_MODE?'simulado':'real',
    paused, lastCycle, tradeCount,
    pnl:  `$${totalPnL.toFixed(2)}`,
    roi:  startBalance>0 ? `${((totalPnL/startBalance)*100).toFixed(1)}%` : '0%',
    capital: {
      total:      `$${totalBalance.toFixed(2)}`,
      freeUSDT:   `$${freeUSDT.toFixed(2)}`,
      holdInUse:  `$${hi.toFixed(2)}`,
      activeInUse:`$${ai.toFixed(2)}`,
    },
    top5: rankings.slice(0,5).map(r=>({
      coin: r.symbol.replace('USDT',''),
      score: r.score.toFixed(1),
      '5m': `${r.ch5m>=0?'+':''}${r.ch5m.toFixed(1)}%`,
      '1h': `${r.ch1h>=0?'+':''}${r.ch1h.toFixed(1)}%`,
    })),
    positions: { hold:holdPos, active:activePos }
  }));
});

// ── START ─────────────────────────────────────────────
server.listen(PORT, async()=>{
  log(`capital. Bot v11 | ${PAPER_MODE?'SIMULADO':'REAL'} | ${CYCLE_MS/1000}s ciclo`);
  log(`Hold 50%: BTC+ETH+SOL | Active 50%: top ${TOP_N} momentum`);
  log(`Trailing stop: +${TRAIL_START}% trigger, -${TRAIL_DROP}% do topo`);
  await fetchBalance();
  startBalance = totalBalance;
  log(`Capital inicial: $${startBalance.toFixed(2)}`);
  await updateRankings();
  await notify('capital. 🚀 Bot v11 ativo!',
    `Capital: $${startBalance.toFixed(2)}\nCompra top ${TOP_N} momentum\nTrailing stop ativo`);
  // Fast loop: protect positions every 2 seconds
  setInterval(protectPositions, PROTECT_MS);
  
  // Ranking loop: find best coins every 10 seconds
  setInterval(rankAndBuy, RANK_MS);
  
  // Run both immediately
  await protectPositions();
  await rankAndBuy();
});
