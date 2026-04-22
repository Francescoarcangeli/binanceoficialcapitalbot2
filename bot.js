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

// ── COINS ────────────────────────────────────────────
const HOLD_COINS  = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const TRADE_COINS = ['XRPUSDT', 'CHIPUSDT', 'DOGEUSDT', 'BNBUSDT', 'BIAUSDT', 'NEIROUSDT', 'SPKUSDT', 'STRKUSDT'];
const NEVER_SELL  = new Set(['BTC','ETH','SOL','USDT','BRL','EUR','GBP','BUSD','USDC']);

// ── ALLOCATION ───────────────────────────────────────
const HOLD_PCT   = 0.45;
const TREND_PCT  = 0.25;
const DIP_PCT    = 0.13;
const OPP_PCT    = 0.12;
const SENT_PCT   = 0.05;

// ── STRATEGY PARAMS ──────────────────────────────────
const HOLD_TP        = 20;   const HOLD_SL        = 12;
const TREND_BUY_CH1H = 3;    const TREND_TP       = 5;    const TREND_SL = 3;  const TREND_RSI_SELL = 75;
const DIP_BUY_CH1H   = -5;   const DIP_RSI_BUY    = 35;   const DIP_TP   = 4;  const DIP_SL   = 2;
const OPP_BUY_CH24H  = 10;   const OPP_BUY_CH1H   = 5;    const OPP_BUY_CH5M = 3;
const OPP_TP         = 12;   const OPP_SL         = 6;    const OPP_MAX_POS  = 5;  const OPP_MIN_VOL = 500000;
const SENT_BUY_SCORE = 0.3;  const SENT_TP        = 6;    const SENT_SL  = 3;  const SENT_MAX_POS = 2;
const SENT_POS_WORDS = ['bullish','surge','partnership','etf','adoption','launch','upgrade','record','soar','rally','elon','moon','pump','approved','listed'];
const SENT_NEG_WORDS = ['bearish','crash','ban','hack','lawsuit','fraud','dump','collapse','warning','decline','fear','sell','scam','arrest','bubble'];
const CYCLE_MS       = 10000;
const PAUSE_LOSS_PCT = 0.25;
const PAUSE_WIN_PCT  = 0.50;

// ── STATE ────────────────────────────────────────────
let freeUSDT     = 0;
let totalBalance = 0;   // excludes locked CHIP value
let chipLocked   = 0;   // current CHIP value — excluded from redistribution
let startBalance = 0;
let holdPos      = {};
let trendPos     = {};
let dipPos       = {};
let oppPos       = {};
let sentPos      = {};
let sentCache    = {};
let allSymbols   = [];
let totalPnL     = 0;
let tradeCount   = 0;
let paused       = false;
let lastCycle    = null;
let chipInitialized = false;

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
  const r   = await axios.get(`${BASE}${path}?${q}&signature=${sig}`,{headers:{'X-MBX-APIKEY':API_KEY},timeout:8000});
  return r.data;
}

async function signedPost(path, params={}) {
  const ts  = Date.now();
  const q   = Object.entries({...params,timestamp:ts}).map(([k,v])=>`${k}=${v}`).join('&');
  const sig = crypto.createHmac('sha256',API_SECRET).update(q).digest('hex');
  const r   = await axios.post(`${BASE}${path}?${q}&signature=${sig}`,null,{headers:{'X-MBX-APIKEY':API_KEY},timeout:8000});
  return r.data;
}

// ── MARKET DATA ──────────────────────────────────────
async function getPrice(symbol) {
  try { const d=await apiGet('/api/v3/ticker/price',{symbol}); return parseFloat(d.price); }
  catch(e) { return 0; }
}

async function getKlines(symbol, interval='1h', limit=3) {
  try { const d=await apiGet('/api/v3/klines',{symbol,interval,limit}); return d.map(k=>parseFloat(k[4])); }
  catch(e) { return []; }
}

async function getTicker(symbol) {
  try { return await apiGet('/api/v3/ticker/24hr',{symbol}); }
  catch(e) { return null; }
}

function calcRSI(prices, period=14) {
  if (prices.length<period+1) return 50;
  let g=0,l=0;
  for (let i=prices.length-period;i<prices.length;i++) {
    const d=prices[i]-prices[i-1]; d>0?g+=d:l+=Math.abs(d);
  }
  const rs=(g/period)/((l/period)||0.001);
  return 100-(100/(1+rs));
}

function ch1h(klines) {
  if (klines.length<2) return 0;
  return ((klines[klines.length-1]-klines[klines.length-2])/klines[klines.length-2])*100;
}

// ── LOAD SYMBOLS ─────────────────────────────────────
async function loadSymbols() {
  try {
    const d=await apiGet('/api/v3/exchangeInfo');
    allSymbols=d.symbols.filter(s=>s.quoteAsset==='USDT'&&s.status==='TRADING').map(s=>s.symbol);
    log(`${allSymbols.length} pares carregados`);
  } catch(e) { log(`Erro loadSymbols: ${e.message}`); }
}

// ── BALANCE ──────────────────────────────────────────
async function fetchBalance() {
  try {
    const data = await signedGet('/api/v3/account');
    let usdt=0, total=0, chipVal=0;
    for (const b of data.balances) {
      const qty=parseFloat(b.free)+parseFloat(b.locked);
      if (qty<=0) continue;
      if (b.asset==='USDT') { usdt=parseFloat(b.free); total+=qty; continue; }
      if (['BRL','EUR','GBP','BUSD','USDC'].includes(b.asset)) continue;
      try {
        const p=await getPrice(b.asset+'USDT');
        if (p>0) {
          const val=qty*p;
          total+=val;
          if (b.asset==='CHIP') chipVal=val;
        }
      } catch(e) {}
    }

    // First time: lock current CHIP value
    if (!chipInitialized) {
      chipLocked=chipVal;
      chipInitialized=true;
      log(`CHIP locked: $${chipLocked.toFixed(2)} — excluído da redistribuição`);
    }

    freeUSDT=usdt;
    totalBalance=total-chipLocked; // exclude locked CHIP from redistributable capital
    log(`Saldo: total=$${total.toFixed(2)} | CHIP(locked)=$${chipLocked.toFixed(2)} | redistribuível=$${totalBalance.toFixed(2)} | USDT=$${usdt.toFixed(2)}`);
  } catch(e) { log(`Erro saldo: ${e.message}`); }
}

// ── GET LOT SIZE ─────────────────────────────────────
async function getAdjQty(symbol, rawQty) {
  try {
    const info=await apiGet('/api/v3/exchangeInfo',{symbol});
    const lot=info.symbols[0].filters.find(f=>f.filterType==='LOT_SIZE');
    const step=parseFloat(lot.stepSize), minQ=parseFloat(lot.minQty);
    const adj=parseFloat((Math.floor(rawQty/step)*step).toFixed(8));
    return adj>=minQ?adj:0;
  } catch(e) {
    if (rawQty>1000) return Math.floor(rawQty);
    if (rawQty>1)    return parseFloat(rawQty.toFixed(2));
    return parseFloat(rawQty.toFixed(5));
  }
}

// ── BUY ──────────────────────────────────────────────
async function buy(symbol, usdtAmt, tag) {
  if (!usdtAmt||usdtAmt<1||isNaN(usdtAmt)) return null;
  if (freeUSDT<usdtAmt*0.98) { log(`[${tag}] Sem USDT: $${freeUSDT.toFixed(2)} < $${usdtAmt.toFixed(2)}`); return null; }
  const price=await getPrice(symbol);
  if (!price||price<=0) return null;
  const qty=await getAdjQty(symbol,usdtAmt/price);
  if (!qty||qty<=0) return null;
  log(`[${tag}][${PAPER_MODE?'SIM':'REAL'}] BUY ${qty} ${symbol} @ $${price.toFixed(6)} (~$${usdtAmt.toFixed(2)})`);
  if (!PAPER_MODE) {
    try { await signedPost('/api/v3/order',{symbol,side:'BUY',type:'MARKET',quantity:qty}); }
    catch(e) { log(`Erro compra ${symbol}: ${e.response?.data?.msg||e.message}`); return null; }
  }
  freeUSDT-=usdtAmt; tradeCount++;
  await notify(`capital. 🟢 [${tag}]`,`${symbol.replace('USDT','')} @ $${price.toFixed(4)} (~$${usdtAmt.toFixed(2)})`);
  return {entryPrice:price,qty,usdt:usdtAmt,ts:Date.now(),tag};
}

// ── SELL ─────────────────────────────────────────────
async function sell(symbol, pos, reason) {
  const price=await getPrice(symbol);
  if (!price) return false;
  const pct=((price-pos.entryPrice)/pos.entryPrice)*100;
  const pnl=pos.usdt*(pct/100);
  totalPnL+=pnl; freeUSDT+=pos.usdt+pnl;
  log(`[${pos.tag}][${PAPER_MODE?'SIM':'REAL'}] SELL ${symbol} @ $${price.toFixed(6)} | ${pct.toFixed(2)}% | $${pnl.toFixed(2)} | ${reason}`);
  if (!PAPER_MODE) {
    try { await signedPost('/api/v3/order',{symbol,side:'SELL',type:'MARKET',quantity:pos.qty}); }
    catch(e) { log(`Erro venda ${symbol}: ${e.response?.data?.msg||e.message}`); return false; }
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

// ── FREE CAPITAL ─────────────────────────────────────
async function freeCapitalIfNeeded() {
  if (freeUSDT>=2) return;
  log('[CAPITAL] USDT insuficiente — vendendo 3 piores posições...');

  const all=[];
  for (const [s,p] of Object.entries(trendPos)) { const pr=await getPrice(s); if(pr) all.push({s,p,pct:((pr-p.entryPrice)/p.entryPrice)*100,type:'trend'}); }
  for (const [s,p] of Object.entries(dipPos))   { const pr=await getPrice(s); if(pr) all.push({s,p,pct:((pr-p.entryPrice)/p.entryPrice)*100,type:'dip'}); }
  for (const [s,p] of Object.entries(oppPos))   { const pr=await getPrice(s); if(pr) all.push({s,p,pct:((pr-p.entryPrice)/p.entryPrice)*100,type:'opp'}); }
  for (const [s,p] of Object.entries(sentPos))  { const pr=await getPrice(s); if(pr) all.push({s,p,pct:((pr-p.entryPrice)/p.entryPrice)*100,type:'sent'}); }

  all.sort((a,b)=>a.pct-b.pct);
  for (const item of all.slice(0,3)) {
    await sell(item.s,item.p,`Liberando capital (${item.pct.toFixed(2)}%)`);
    if (item.type==='trend') delete trendPos[item.s];
    if (item.type==='dip')   delete dipPos[item.s];
    if (item.type==='opp')   delete oppPos[item.s];
    if (item.type==='sent')  delete sentPos[item.s];
    await new Promise(r=>setTimeout(r,300));
  }

  // If still no USDT, sell worst untracked coin from Binance (except NEVER_SELL)
  if (freeUSDT<2) {
    try {
      const data=await signedGet('/api/v3/account');
      let worst=null, worstCh=-Infinity, worstQty=0;
      for (const b of data.balances) {
        const qty=parseFloat(b.free);
        if (qty<=0||NEVER_SELL.has(b.asset)) continue;
        const sym=b.asset+'USDT';
        const ticker=await getTicker(sym);
        if (!ticker) continue;
        const ch=parseFloat(ticker.priceChangePercent);
        const val=qty*parseFloat(ticker.lastPrice);
        if (val<0.5) continue;
        if (ch<worstCh) { worstCh=ch; worst=b.asset; worstQty=qty; }
      }
      if (worst) {
        const sym=worst+'USDT';
        const qty=await getAdjQty(sym,worstQty);
        if (qty>0&&!PAPER_MODE) {
          await signedPost('/api/v3/order',{symbol:sym,side:'SELL',type:'MARKET',quantity:qty});
          log(`[CAPITAL] Vendido ${worst} (24h:${worstCh.toFixed(1)}%)`);
        }
      }
    } catch(e) { log(`Erro freeCapital: ${e.message}`); }
  }
  await fetchBalance();
}

// ── INITIAL REBALANCE ────────────────────────────────
async function initialRebalance() {
  log('=== REBALANCE INICIAL: vendendo tudo (exceto CHIP/BTC/ETH/SOL) ===');
  try {
    const data=await signedGet('/api/v3/account');
    for (const b of data.balances) {
      const qty=parseFloat(b.free);
      if (qty<=0||NEVER_SELL.has(b.asset)) continue;
      const sym=b.asset+'USDT';
      try {
        const adjQ=await getAdjQty(sym,qty);
        if (adjQ<=0) continue;
        const price=await getPrice(sym);
        if (!price||qty*price<0.5) continue;
        if (!PAPER_MODE) await signedPost('/api/v3/order',{symbol:sym,side:'SELL',type:'MARKET',quantity:adjQ});
        log(`[REBALANCE] Vendido ${adjQ} ${b.asset}`);
        await new Promise(r=>setTimeout(r,400));
      } catch(e) { log(`Erro vendendo ${b.asset}: ${e.response?.data?.msg||e.message}`); }
    }
  } catch(e) { log(`Erro rebalance: ${e.message}`); }
  await fetchBalance();
  log(`Capital após rebalance: $${totalBalance.toFixed(2)} (USDT: $${freeUSDT.toFixed(2)})`);
}

// ── STRATEGY 1: HOLD ──────────────────────────────────
async function manageHolds() {
  const target=(totalBalance*HOLD_PCT)/HOLD_COINS.length;
  for (const symbol of [...Object.keys(holdPos)]) {
    const pos=holdPos[symbol], price=await getPrice(symbol);
    if (!price) continue;
    const pct=((price-pos.entryPrice)/pos.entryPrice)*100;
    log(`[HOLD] ${symbol} ${pct>=0?'+':''}${pct.toFixed(2)}%`);
    if (pct>=HOLD_TP) {
      await sell(symbol,pos,`TP +${pct.toFixed(1)}%`); delete holdPos[symbol];
      await new Promise(r=>setTimeout(r,500));
      const p=await buy(symbol,(totalBalance*HOLD_PCT)/HOLD_COINS.length,'HOLD');
      if (p) holdPos[symbol]=p;
    } else if (pct<=-HOLD_SL) {
      await sell(symbol,pos,`SL ${pct.toFixed(1)}%`); delete holdPos[symbol];
    }
  }
  for (const symbol of HOLD_COINS) {
    if (holdPos[symbol]) continue;
    const amt=Math.min(target,freeUSDT*0.95);
    if (amt<2) continue;
    const p=await buy(symbol,amt,'HOLD');
    if (p) holdPos[symbol]=p;
    await new Promise(r=>setTimeout(r,400));
  }
}

// ── STRATEGY 2: TREND ────────────────────────────────
async function manageTrend() {
  const trendCap=totalBalance*TREND_PCT;
  const trendInUse=Object.values(trendPos).reduce((s,p)=>s+p.usdt,0);
  for (const symbol of [...Object.keys(trendPos)]) {
    const pos=trendPos[symbol], price=await getPrice(symbol);
    if (!price) continue;
    const pct=((price-pos.entryPrice)/pos.entryPrice)*100;
    if (pct>=TREND_TP) { await sell(symbol,pos,`Trend TP +${pct.toFixed(2)}%`); delete trendPos[symbol]; }
    else if (pct<=-TREND_SL) { await sell(symbol,pos,`Trend SL ${pct.toFixed(2)}%`); delete trendPos[symbol]; }
    else { const k=await getKlines(symbol,'1h',16); if (calcRSI(k)>TREND_RSI_SELL&&pct>1) { await sell(symbol,pos,`RSI alto`); delete trendPos[symbol]; } }
  }
  if (trendInUse>=trendCap*0.95||freeUSDT<2) return;
  const signals=await Promise.all(TRADE_COINS.map(async symbol=>{
    if (trendPos[symbol]) return null;
    try {
      const [k1h,k5m]=await Promise.all([getKlines(symbol,'1h',3),getKlines(symbol,'5m',4)]);
      const c1h=ch1h(k1h), rsi=calcRSI(k1h);
      const ticker=await getTicker(symbol);
      const vol=ticker?parseFloat(ticker.quoteVolume):0;
      return {symbol,c1h,rsi,vol};
    } catch(e) { return null; }
  }));
  const valid=signals.filter(s=>s&&s.c1h>=TREND_BUY_CH1H&&s.vol>50000&&s.rsi<80).sort((a,b)=>b.c1h-a.c1h);
  for (const sig of valid) {
    if (freeUSDT<2) break;
    const strength=Math.min(sig.c1h/TREND_BUY_CH1H,3);
    const amt=Math.min(trendCap-trendInUse,Math.max(2,(trendCap/TRADE_COINS.length)*strength));
    log(`[TREND] ${sig.symbol} +${sig.c1h.toFixed(1)}% RSI:${sig.rsi.toFixed(0)}`);
    const p=await buy(sig.symbol,amt,'TREND');
    if (p) trendPos[sig.symbol]=p;
    await new Promise(r=>setTimeout(r,300));
  }
}

// ── STRATEGY 3: DIP ──────────────────────────────────
async function manageDips() {
  const dipCap=totalBalance*DIP_PCT;
  const dipInUse=Object.values(dipPos).reduce((s,p)=>s+p.usdt,0);
  for (const symbol of [...Object.keys(dipPos)]) {
    const pos=dipPos[symbol], price=await getPrice(symbol);
    if (!price) continue;
    const pct=((price-pos.entryPrice)/pos.entryPrice)*100;
    if (pct>=DIP_TP) { await sell(symbol,pos,`Dip TP +${pct.toFixed(2)}%`); delete dipPos[symbol]; }
    else if (pct<=-DIP_SL) { await sell(symbol,pos,`Dip SL ${pct.toFixed(2)}%`); delete dipPos[symbol]; }
  }
  if (dipInUse>=dipCap*0.95||freeUSDT<2) return;
  const signals=await Promise.all(TRADE_COINS.map(async symbol=>{
    if (dipPos[symbol]) return null;
    try { const k=await getKlines(symbol,'1h',16); return {symbol,c1h:ch1h(k),rsi:calcRSI(k)}; }
    catch(e) { return null; }
  }));
  const dips=signals.filter(s=>s&&s.c1h<=DIP_BUY_CH1H&&s.rsi<=DIP_RSI_BUY).sort((a,b)=>a.c1h-b.c1h);
  for (const dip of dips) {
    if (freeUSDT<2) break;
    const amt=Math.min(dipCap-dipInUse,dipCap/TRADE_COINS.length);
    log(`[DIP] ${dip.symbol} ${dip.c1h.toFixed(1)}% RSI:${dip.rsi.toFixed(0)}`);
    const p=await buy(dip.symbol,amt,'DIP');
    if (p) dipPos[dip.symbol]=p;
    await new Promise(r=>setTimeout(r,300));
  }
}

// ── STRATEGY 4: OPPORTUNIST ──────────────────────────
async function manageOpp() {
  const oppCap=totalBalance*OPP_PCT;
  const oppInUse=Object.values(oppPos).reduce((s,p)=>s+p.usdt,0);
  for (const symbol of [...Object.keys(oppPos)]) {
    const pos=oppPos[symbol], price=await getPrice(symbol);
    if (!price) continue;
    const pct=((price-pos.entryPrice)/pos.entryPrice)*100;
    if (!oppPos[symbol]) continue;
    if (pct>=OPP_TP) { await sell(symbol,pos,`Opp TP +${pct.toFixed(2)}%`); delete oppPos[symbol]; }
    else if (pct<=-OPP_SL) { await sell(symbol,pos,`Opp SL ${pct.toFixed(2)}%`); delete oppPos[symbol]; }
    else if (pct>5) { if (pos.peak&&price<pos.peak*0.97) { await sell(symbol,pos,`Trailing ${pct.toFixed(2)}%`); delete oppPos[symbol]; continue; } }
    if (oppPos[symbol]) { const p2=await getPrice(symbol); if(p2&&(!oppPos[symbol].peak||p2>oppPos[symbol].peak)) oppPos[symbol].peak=p2; }
  }
  if (Object.keys(oppPos).length>=OPP_MAX_POS||oppInUse>=oppCap||freeUSDT<2) return;
  const exclude=new Set([...HOLD_COINS,...Object.keys(oppPos),...Object.keys(trendPos),...Object.keys(dipPos)]);
  const sample=allSymbols.filter(s=>!exclude.has(s)).sort(()=>Math.random()-0.5).slice(0,100);
  const pumps=await Promise.all(sample.map(async symbol=>{
    try {
      const [ticker,k1h,k5m]=await Promise.all([getTicker(symbol),getKlines(symbol,'1h',3),getKlines(symbol,'5m',4)]);
      if (!ticker) return null;
      const vol=parseFloat(ticker.quoteVolume);
      if (vol<OPP_MIN_VOL) return null;
      const c24h=parseFloat(ticker.priceChangePercent), c1h=ch1h(k1h), c5m=ch1h(k5m), rsi=calcRSI(k1h);
      if (rsi>85) return null;
      if (c24h>=OPP_BUY_CH24H||c1h>=OPP_BUY_CH1H||c5m>=OPP_BUY_CH5M)
        return {symbol,c24h,c1h,c5m,vol,rsi,score:c24h+c1h*2+c5m*3};
      return null;
    } catch(e) { return null; }
  }));
  const valid=pumps.filter(Boolean).sort((a,b)=>b.score-a.score);
  for (const pump of valid.slice(0,2)) {
    if (Object.keys(oppPos).length>=OPP_MAX_POS||freeUSDT<2) break;
    const amt=Math.min(freeUSDT*0.40,oppCap/OPP_MAX_POS);
    log(`[OPP] 🚀 ${pump.symbol} 24h:+${pump.c24h.toFixed(1)}% 1h:+${pump.c1h.toFixed(1)}%`);
    const p=await buy(pump.symbol,amt,'OPP');
    if (p) {
      oppPos[pump.symbol]={...p,peak:p.entryPrice};
      await notify(`capital. 🚀 PUMP!`,`${pump.symbol.replace('USDT','')} +${pump.c24h.toFixed(1)}% 24h\n$${amt.toFixed(2)}`);
    }
    await new Promise(r=>setTimeout(r,300));
  }
}

// ── STRATEGY 5: SENTIMENT ────────────────────────────
const SENT_COINS={'Bitcoin':'BTCUSDT','Ethereum':'ETHUSDT','Solana':'SOLUSDT','XRP':'XRPUSDT','Dogecoin':'DOGEUSDT','BNB':'BNBUSDT','Elon':'DOGEUSDT'};

async function fetchSentiment(coin) {
  const cached=sentCache[coin];
  if (cached&&Date.now()-cached.ts<600000) return cached.score;
  try {
    const r=await axios.get(`https://newsapi.org/v2/everything?q=${encodeURIComponent(coin+' crypto')}&language=en&sortBy=publishedAt&pageSize=15&apiKey=${NEWS_KEY}`,{timeout:8000});
    let score=0;
    (r.data.articles||[]).forEach(a=>{
      const txt=((a.title||'')+(a.description||'')).toLowerCase();
      SENT_POS_WORDS.forEach(w=>{if(txt.includes(w))score+=0.1;});
      SENT_NEG_WORDS.forEach(w=>{if(txt.includes(w))score-=0.1;});
    });
    score=Math.max(-1,Math.min(1,parseFloat(score.toFixed(2))));
    sentCache[coin]={score,ts:Date.now()};
    log(`[SENT] ${coin} score:${score}`);
    return score;
  } catch(e) { return 0; }
}

async function manageSentiment() {
  const sentCap=totalBalance*SENT_PCT;
  const sentInUse=Object.values(sentPos).reduce((s,p)=>s+p.usdt,0);
  for (const symbol of [...Object.keys(sentPos)]) {
    const pos=sentPos[symbol], price=await getPrice(symbol);
    if (!price) continue;
    const pct=((price-pos.entryPrice)/pos.entryPrice)*100;
    if (pct>=SENT_TP) { await sell(symbol,pos,`Sent TP +${pct.toFixed(2)}%`); delete sentPos[symbol]; }
    else if (pct<=-SENT_SL) { await sell(symbol,pos,`Sent SL ${pct.toFixed(2)}%`); delete sentPos[symbol]; }
  }
  if (Object.keys(sentPos).length>=SENT_MAX_POS||freeUSDT<1) return;
  const coins=Object.keys(SENT_COINS);
  const coin=coins[Math.floor(Date.now()/120000)%coins.length];
  const symbol=SENT_COINS[coin];
  if (sentPos[symbol]) return;
  const score=await fetchSentiment(coin);
  if (score>=SENT_BUY_SCORE) {
    const amt=Math.min(freeUSDT*0.50,sentCap/SENT_MAX_POS);
    if (amt<1) return;
    const p=await buy(symbol,amt,'SENT');
    if (p) { sentPos[symbol]={...p,score,coin}; await notify(`capital. 📰 Sentiment!`,`${coin} score:+${score}\n${symbol.replace('USDT','')} $${amt.toFixed(2)}`); }
  } else if (score<=-SENT_BUY_SCORE&&trendPos[symbol]) {
    await sell(symbol,trendPos[symbol],`Notícia negativa score:${score}`);
    delete trendPos[symbol];
  }
}

// ── MAIN LOOP ─────────────────────────────────────────
async function runBot() {
  if (paused) { log('Bot pausado'); return; }
  lastCycle=new Date().toISOString();
  await fetchBalance();
  if (totalBalance<=0) { log('Sem saldo'); return; }
  if (freeUSDT<2) await freeCapitalIfNeeded();
  const hi=Object.values(holdPos).reduce((s,p)=>s+p.usdt,0);
  const ti=Object.values(trendPos).reduce((s,p)=>s+p.usdt,0);
  const di=Object.values(dipPos).reduce((s,p)=>s+p.usdt,0);
  const oi=Object.values(oppPos).reduce((s,p)=>s+p.usdt,0);
  const si=Object.values(sentPos).reduce((s,p)=>s+p.usdt,0);
  const roi=startBalance>0?((totalPnL/startBalance)*100).toFixed(1):'0';
  log(`=== PnL:$${totalPnL.toFixed(2)}(${roi}%) | USDT:$${freeUSDT.toFixed(2)} | H:$${hi.toFixed(0)} T:$${ti.toFixed(0)} D:$${di.toFixed(0)} O:$${oi.toFixed(0)} S:$${si.toFixed(0)} ===`);
  await manageHolds();
  await manageTrend();
  await manageDips();
  await Promise.all([manageOpp(), manageSentiment()]);
}

// ── HTTP SERVER ───────────────────────────────────────
const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if (req.url==='/pause')   { paused=true;  log('PAUSADO');  return res.end(JSON.stringify({paused:true})); }
  if (req.url==='/resume')  { paused=false; log('RETOMADO'); return res.end(JSON.stringify({paused:false})); }
  if (req.url==='/rebalance') {
    log('Rebalance manual iniciado...');
    await initialRebalance();
    return res.end(JSON.stringify({success:true,freeUSDT,totalBalance}));
  }
  const hi=Object.values(holdPos).reduce((s,p)=>s+p.usdt,0);
  const ti=Object.values(trendPos).reduce((s,p)=>s+p.usdt,0);
  const di=Object.values(dipPos).reduce((s,p)=>s+p.usdt,0);
  const oi=Object.values(oppPos).reduce((s,p)=>s+p.usdt,0);
  const si=Object.values(sentPos).reduce((s,p)=>s+p.usdt,0);
  res.end(JSON.stringify({
    status:'online', mode:PAPER_MODE?'simulado':'real',
    paused, lastCycle, tradeCount,
    pnl:`$${totalPnL.toFixed(2)}`,
    roi:startBalance>0?`${((totalPnL/startBalance)*100).toFixed(1)}%`:'0%',
    capital:{
      total:`$${totalBalance.toFixed(2)}`,
      chipLocked:`$${chipLocked.toFixed(2)}`,
      freeUSDT:`$${freeUSDT.toFixed(2)}`,
      holdTarget:`$${(totalBalance*HOLD_PCT).toFixed(2)} (45%)`,
      trendTarget:`$${(totalBalance*TREND_PCT).toFixed(2)} (25%)`,
      dipTarget:`$${(totalBalance*DIP_PCT).toFixed(2)} (13%)`,
      oppTarget:`$${(totalBalance*OPP_PCT).toFixed(2)} (12%)`,
      sentTarget:`$${(totalBalance*SENT_PCT).toFixed(2)} (5%)`,
      holdInUse:`$${hi.toFixed(2)}`, trendInUse:`$${ti.toFixed(2)}`,
      dipInUse:`$${di.toFixed(2)}`, oppInUse:`$${oi.toFixed(2)}`, sentInUse:`$${si.toFixed(2)}`,
    },
    positions:{hold:holdPos,trend:trendPos,dip:dipPos,opportunist:oppPos,sentiment:sentPos},
    coins:{holds:HOLD_COINS,trades:TRADE_COINS}
  }));
});

// ── START ─────────────────────────────────────────────
server.listen(PORT, async()=>{
  log(`capital. Bot v7 | ${PAPER_MODE?'SIMULADO':'REAL'} | Ciclo:10s`);
  log(`Hold:45% | Trend:25% | Dip:13% | Opp:12% | Sent:5%`);
  log(`CHIP: valor atual bloqueado, bot opera a partir de agora`);
  await loadSymbols();
  await fetchBalance();
  startBalance=totalBalance;
  log(`Capital inicial (sem CHIP): $${startBalance.toFixed(2)}`);
  await notify('capital. 🚀 Bot v7!',`Capital redistribuível: $${startBalance.toFixed(2)}\nCHIP locked: $${chipLocked.toFixed(2)}`);
  setInterval(runBot,CYCLE_MS);
  runBot();
});
