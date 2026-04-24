const http   = require('http');
const axios  = require('axios');
const crypto = require('crypto');

const API_KEY    = process.env.BINANCE_API_KEY    || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const PAPER_MODE = process.env.PAPER_MODE !== 'false';
const NOTIFY_URL = process.env.NOTIFY_URL || '';
const NEWS_KEY   = '8c729e78ee7e477295c572995346f88f';
const PORT       = process.env.PORT || 3000;
const BASE       = 'https://api.binance.com';

// ── FIXED RULES ──────────────────────────────────────
const HOLD_COINS = ['BTCUSDT','ETHUSDT','SOLUSDT'];
const HOLD_PCT   = 0.50;  // 50% always in holds
const HOLD_TP    = 20;    // sell hold at +20%, rebuy
const HOLD_SL    = 12;    // emergency stop -12%

// ── ACTIVE TRADING (remaining 50%) ───────────────────
// Buy signals — any timeframe
const BUY_CH24H  = 8;    // buy if +8% in 24h
const BUY_CH1H   = 8;    // or +8% in 1h  
const BUY_CH1M   = 8;    // or +8% in 1min
const BUY_DIP    = -5;   // buy dip if -5% in 1h + RSI < 35
const MIN_VOL    = 50000; // min $50k volume
const MIN_TRADE  = 10;    // minimum $10 per trade

// Sell signals — any timeframe
const SELL_DROP24H = -10; // sell if -10% in 24h
const SELL_DROP1H  = -10; // sell if -10% in 1h
const SELL_DROP1M  = -10; // sell if -10% in 1min
const SELL_TP    = 8;    // take profit +8%
const SELL_SL    = 4;    // stop loss -4%
const SELL_PUMP_TP = 20; // take profit +20% for big pumps
const SELL_RSI   = 78;   // sell if RSI overbought

const CYCLE_MS   = 8000; // 8 second cycle
const SCAN_SIZE  = 120;  // pairs to scan per cycle

// ── STATE ────────────────────────────────────────────
let freeUSDT     = 0;
let totalBalance = 0;
let startBalance = 0;
let holdPos      = {};
let activePos    = {};  // all active trading positions
let allSymbols   = [];
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

async function getKlines(symbol, interval='1h', limit=20) {
  try { const d=await apiGet('/api/v3/klines',{symbol,interval,limit}); return d.map(k=>parseFloat(k[4])); }
  catch(e) { return []; }
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

// ── LOAD ALL SYMBOLS ─────────────────────────────────
async function loadSymbols() {
  try {
    const d=await apiGet('/api/v3/exchangeInfo');
    allSymbols=d.symbols.filter(s=>s.quoteAsset==='USDT'&&s.status==='TRADING').map(s=>s.symbol);
    log(`${allSymbols.length} pares USDT carregados`);
  } catch(e) { log(`Erro loadSymbols: ${e.message}`); }
}

// ── BALANCE ──────────────────────────────────────────
async function fetchBalance() {
  try {
    const data=await signedGet('/api/v3/account');
    let usdt=0, total=0;
    for (const b of data.balances) {
      const qty=parseFloat(b.free)+parseFloat(b.locked);
      if (qty<=0) continue;
      if (b.asset==='USDT') { usdt=parseFloat(b.free); total+=qty; continue; }
      if (['BRL','EUR','GBP','BUSD','USDC'].includes(b.asset)) continue;
      try { const p=await getPrice(b.asset+'USDT'); if(p>0) total+=qty*p; } catch(e){}
    }
    freeUSDT=usdt; totalBalance=total;
    log(`Saldo: $${total.toFixed(2)} | USDT livre: $${usdt.toFixed(2)}`);
  } catch(e) { log(`Erro saldo: ${e.message}`); }
}

// ── SYNC EXISTING POSITIONS ───────────────────────────
// Reads actual Binance balance and registers untracked coins
async function syncPositions() {
  try {
    const data=await signedGet('/api/v3/account');
    const SKIP=new Set(['USDT','BRL','EUR','GBP','BUSD','USDC']);
    const holdAssets=new Set(HOLD_COINS.map(s=>s.replace('USDT','')));

    for (const b of data.balances) {
      const qty=parseFloat(b.free)+parseFloat(b.locked);
      if (qty<=0) continue;
      if (SKIP.has(b.asset)) continue;
      const symbol=b.asset+'USDT';

      // If it's a hold coin, register in holdPos if not tracked
      if (holdAssets.has(b.asset)) {
        if (!holdPos[symbol]) {
          const price=await getPrice(symbol);
          if (price>0) {
            holdPos[symbol]={entryPrice:price,qty,usdt:qty*price,ts:Date.now(),tag:'HOLD',synced:true};
            log(`[SYNC] Hold registrado: ${symbol} qty:${qty} @ $${price.toFixed(4)}`);
          }
        }
        continue;
      }

      // Register as active position if not tracked and value > $1
      if (!activePos[symbol]) {
        const price=await getPrice(symbol);
        if (price>0 && qty*price>1.0) {
          activePos[symbol]={entryPrice:price,qty,usdt:qty*price,ts:Date.now(),tag:'SYNC',peak:price};
          log(`[SYNC] Posição registrada: ${symbol} $${(qty*price).toFixed(2)}`);
        }
      }
    }
  } catch(e) { log(`Erro sync: ${e.message}`); }
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
  return {entryPrice:price,qty,usdt:usdtAmt,ts:Date.now(),tag,peak:price};
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
    try {
      // Get actual balance from Binance for accurate qty
      const asset = symbol.replace('USDT','');
      const acct  = await signedGet('/api/v3/account');
      const bal   = acct.balances.find(b=>b.asset===asset);
      const realQty = bal ? parseFloat(bal.free) : pos.qty;
      const adjQty  = await getAdjQty(symbol, realQty);
      if (!adjQty || adjQty<=0) { log(`Skip venda ${symbol}: qty inválida`); return false; }
      await signedPost('/api/v3/order',{symbol,side:'SELL',type:'MARKET',quantity:adjQty});
    }
    catch(e) { log(`Erro venda ${symbol}: ${e.response?.data?.msg||e.message}`); return false; }
  }
  tradeCount++;
  const roi=startBalance>0?((totalPnL/startBalance)*100).toFixed(1):'0';
  await notify(`capital. ${pnl>=0?'📈':'📉'} [${pos.tag}]`,
    `${symbol.replace('USDT','')} ${pct>=0?'+':''}${pct.toFixed(2)}% ($${pnl.toFixed(2)})\nROI: ${roi}%`);
  if (startBalance>0) {
    if (totalPnL<=-(startBalance*0.25)) { paused=true; notify('capital. ⛔ Pausado',`Perda $${Math.abs(totalPnL).toFixed(2)}`); }
    if (totalPnL>= startBalance*0.50)   { paused=true; notify('capital. 🏆 Meta!',`Lucro $${totalPnL.toFixed(2)}`); }
  }
  return true;
}

// ── MANAGE HOLDS ─────────────────────────────────────
async function manageHolds() {
  const holdTarget=(totalBalance*HOLD_PCT)/HOLD_COINS.length;

  for (const symbol of [...Object.keys(holdPos)]) {
    const pos=holdPos[symbol], price=await getPrice(symbol);
    if (!price) continue;
    const pct=((price-pos.entryPrice)/pos.entryPrice)*100;
    log(`[HOLD] ${symbol} ${pct>=0?'+':''}${pct.toFixed(2)}%`);
    if (pct>=HOLD_TP) {
      await sell(symbol,pos,`TP +${pct.toFixed(1)}%`); delete holdPos[symbol];
      await new Promise(r=>setTimeout(r,500));
      const newAmt=(totalBalance*HOLD_PCT)/HOLD_COINS.length;
      const p=await buy(symbol,Math.min(newAmt,freeUSDT*0.95),'HOLD');
      if (p) holdPos[symbol]=p;
    } else if (pct<=-HOLD_SL) {
      await sell(symbol,pos,`SL ${pct.toFixed(1)}%`); delete holdPos[symbol];
    }
  }

  // Buy missing holds
  for (const symbol of HOLD_COINS) {
    if (holdPos[symbol]) continue;
    const amt=Math.min(holdTarget, freeUSDT*0.90);
    if (amt<2) continue;
    const p=await buy(symbol,amt,'HOLD');
    if (p) holdPos[symbol]=p;
    await new Promise(r=>setTimeout(r,400));
  }
}

// ── MANAGE ACTIVE POSITIONS ───────────────────────────
async function manageActive() {
  for (const symbol of [...Object.keys(activePos)]) {
    if (!activePos[symbol]) continue; // may have been deleted
    const pos=activePos[symbol];
    if (!pos || !pos.entryPrice) continue;
    const price=await getPrice(symbol);
    if (!price) continue;
    const pct=((price-pos.entryPrice)/pos.entryPrice)*100;

    // Update peak
    if (price>pos.peak) activePos[symbol].peak=price;
    const fromPeak=((price-pos.peak)/pos.peak)*100;

    // Check 24h, 1h and 1min drops — sell immediately if any drops -10%
    try {
      const [ticker, k1h, k1m] = await Promise.all([
        apiGet('/api/v3/ticker/24hr',{symbol}),
        getKlines(symbol,'1h',3),
        getKlines(symbol,'1m',3)
      ]);
      const ch24h = parseFloat(ticker.priceChangePercent);
      const ch1h  = k1h.length>=2 ? ((k1h[k1h.length-1]-k1h[k1h.length-2])/k1h[k1h.length-2])*100 : 0;
      const ch1m  = k1m.length>=2 ? ((k1m[k1m.length-1]-k1m[k1m.length-2])/k1m[k1m.length-2])*100 : 0;

      if (ch24h<=SELL_DROP24H) {
        await sell(symbol,pos,`Queda 24h: ${ch24h.toFixed(1)}%`); delete activePos[symbol]; continue;
      }
      if (ch1h<=SELL_DROP1H) {
        await sell(symbol,pos,`Queda 1h: ${ch1h.toFixed(1)}%`); delete activePos[symbol]; continue;
      }
      if (ch1m<=SELL_DROP1M) {
        await sell(symbol,pos,`Queda 1min: ${ch1m.toFixed(1)}%`); delete activePos[symbol]; continue;
      }
    } catch(e) {}

    // Big pump — use higher TP
    const isPump=pos.pumpPct && pos.pumpPct>=15;
    const tp=isPump?SELL_PUMP_TP:SELL_TP;

    if (pct>=tp) {
      await sell(symbol,pos,`TP +${pct.toFixed(2)}%`); delete activePos[symbol];
    } else if (pct<=-SELL_SL) {
      await sell(symbol,pos,`SL ${pct.toFixed(2)}%`); delete activePos[symbol];
    } else if (pct>5 && fromPeak<=-3) {
      await sell(symbol,pos,`Trailing ${pct.toFixed(2)}%`); delete activePos[symbol];
    } else {
      const k=await getKlines(symbol,'1h',16);
      const rsi=calcRSI(k);
      if (rsi>SELL_RSI&&pct>1) { await sell(symbol,pos,`RSI ${rsi.toFixed(0)}`); delete activePos[symbol]; }
    }
  }
}

// ── ROTATE WORST ─────────────────────────────────────
// If no free USDT, sell worst active position
async function rotateIfNeeded(minUSDT=2) {
  if (freeUSDT>=minUSDT) return;
  
  // Find worst 3 active positions
  const ranked=[];
  for (const [sym,pos] of Object.entries(activePos)) {
    const price=await getPrice(sym);
    if (!price) continue;
    const pct=((price-pos.entryPrice)/pos.entryPrice)*100;
    ranked.push({sym,pos,pct});
  }
  ranked.sort((a,b)=>a.pct-b.pct);
  
  for (const item of ranked.slice(0,3)) {
    if (freeUSDT>=minUSDT) break;
    if (!item.pos || item.pos.usdt<MIN_TRADE) continue; // skip tiny positions
    log(`[ROTATE] Vendendo ${item.sym} (${item.pct.toFixed(2)}%) para liberar capital`);
    const sold = await sell(item.sym,item.pos,`Rotação capital (${item.pct.toFixed(2)}%)`);
    if (sold) delete activePos[item.sym];
    await new Promise(r=>setTimeout(r,300));
  }
}

// ── ALWAYS SELL WORST, BUY BEST ──────────────────────
async function sellWorstBuyBest() {
  // Find worst active position
  let worstSym=null, worstPct=Infinity, worstPos=null;
  for (const [sym,pos] of Object.entries(activePos)) {
    const price=await getPrice(sym);
    if (!price) continue;
    const pct=((price-pos.entryPrice)/pos.entryPrice)*100;
    if (pct<worstPct) { worstPct=pct; worstSym=sym; worstPos=pos; }
  }

  // Sell worst if it's underperforming AND worth at least $0.50
  const worstPrice = worstSym ? await getPrice(worstSym) : 0;
  const worstVal   = worstPos ? (worstPos.qty||0)*(worstPrice||0) : 0;
  if (worstSym && worstVal>=0.50 && (worstPct<-1 || (Date.now()-worstPos.ts>1800000 && worstPct<1))) {
    log(`[ROTATE] Vendendo pior: ${worstSym} (${worstPct.toFixed(2)}%)`);
    await sell(worstSym,worstPos,`Rotação: pior posição ${worstPct.toFixed(2)}%`);
    delete activePos[worstSym];
    await fetchBalance();
  }
}

// ── SCAN & BUY BEST OPPORTUNITIES ────────────────────
async function scanAndBuy() {
  const activeCap=totalBalance*0.50;
  
  if (freeUSDT<2) return;

  // Scan random sample of all symbols
  const exclude=new Set([...HOLD_COINS,...Object.keys(activePos)]);
  const sample=allSymbols
    .filter(s=>!exclude.has(s))
    .sort(()=>Math.random()-0.5)
    .slice(0,SCAN_SIZE);

  const results=await Promise.all(sample.map(async symbol=>{
    try {
      const [ticker,k1h]=await Promise.all([
        apiGet('/api/v3/ticker/24hr',{symbol}),
        getKlines(symbol,'1h',3)
      ]);
      const ch24h=parseFloat(ticker.priceChangePercent);
      const ch1h=k1h.length>=2?((k1h[k1h.length-1]-k1h[k1h.length-2])/k1h[k1h.length-2])*100:0;
      const vol=parseFloat(ticker.quoteVolume);
      const rsi=calcRSI(k1h);
      if (vol<MIN_VOL) return null;

      // 1min change
      const k1m=await getKlines(symbol,'1m',3);
      const ch1m=k1m.length>=2?((k1m[k1m.length-1]-k1m[k1m.length-2])/k1m[k1m.length-2])*100:0;

      // Pump signal — coin must be clearly pumping with good volume
      const isPumping = (ch24h>=BUY_CH24H || ch1h>=BUY_CH1H || ch1m>=BUY_CH1M);
      if (isPumping && ch24h > -5) { // must not be crashing on 24h even if 1h pumps
        if (rsi>88) return null; // already overbought
        return {symbol,ch24h,ch1h,ch1m,vol,rsi,score:ch24h*0.5+ch1h*2+ch1m*3,type:'pump'};
      }
      // Dip signal
      if (ch1h<=BUY_DIP&&rsi<=35&&ch24h>-20) {
        return {symbol,ch24h,ch1h,vol,rsi,score:-ch1h,type:'dip'};
      }
      return null;
    } catch(e) { return null; }
  }));

  const opportunities=results.filter(Boolean).sort((a,b)=>b.score-a.score);
  if (opportunities.length===0) return;

  log(`Oportunidades: ${opportunities.slice(0,5).map(o=>`${o.symbol}(${o.type}:${o.ch1h.toFixed(1)}%)`).join(', ')}`);

  for (const opp of opportunities) {
    if (freeUSDT<2) break;
    if (activePos[opp.symbol]) continue;

    // Calculate how much to invest
    // Big pump → more capital, up to 80% of free USDT
    let amt;
    if (opp.type==='pump') {
      const strength=Math.min(opp.ch24h/BUY_CH24H, 5); // 1-5x
      amt=Math.min(freeUSDT*0.80, Math.max(MIN_TRADE, freeUSDT*0.20*strength));
    } else {
      amt=Math.min(freeUSDT*0.40, Math.max(MIN_TRADE, activeCap*0.15));
    }
    if (amt < MIN_TRADE) { log(`[SKIP] ${opp.symbol}: valor $${amt.toFixed(2)} abaixo do mínimo`); continue; }

    const p=await buy(opp.symbol,amt,opp.type==='pump'?'PUMP':'DIP');
    if (p) {
      activePos[opp.symbol]={...p,pumpPct:opp.ch24h};
      if (opp.type==='pump'&&opp.ch24h>=15) {
        await notify(`capital. 🚀 PUMP ${opp.symbol.replace('USDT','')}!`,
          `+${opp.ch24h.toFixed(1)}% 24h | +${opp.ch1h.toFixed(1)}% 1h\nComprando $${amt.toFixed(2)}`);
      }
    }
    await new Promise(r=>setTimeout(r,300));
  }
}

// ── MAIN LOOP ─────────────────────────────────────────
async function runBot() {
  if (paused) { log('Bot pausado'); return; }
  lastCycle=new Date().toISOString();

  await fetchBalance();
  if (totalBalance<=0) { log('Sem saldo'); return; }

  const holdInUse=Object.values(holdPos).reduce((s,p)=>s+p.usdt,0);
  const activeInUse=Object.values(activePos).reduce((s,p)=>s+p.usdt,0);
  const roi=startBalance>0?((totalPnL/startBalance)*100).toFixed(1):'0';
  log(`=== PnL:$${totalPnL.toFixed(2)}(${roi}%) | USDT:$${freeUSDT.toFixed(2)} | Hold:$${holdInUse.toFixed(0)} Active:$${activeInUse.toFixed(0)}(${Object.keys(activePos).length}pos) ===`);

  // Sync any untracked positions from Binance
  await syncPositions();

  // Manage existing positions
  await manageHolds();
  await manageActive();

  // Free capital if needed
  if (freeUSDT<2) await rotateIfNeeded(2);

  // Always rotate: sell worst, buy best
  await sellWorstBuyBest();
  
  // Scan and buy best opportunities
  await scanAndBuy();
}

// ── HTTP SERVER ───────────────────────────────────────
const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');

  if (req.url==='/pause')  { paused=true;  return res.end(JSON.stringify({paused:true})); }
  if (req.url==='/resume') { paused=false; return res.end(JSON.stringify({paused:false})); }

  if (req.url==='/rebalance') {
    log('Rebalance: zerando posições ativas e redistribuindo...');
    // Sell all active (non-hold) positions
    for (const [sym,pos] of Object.entries(activePos)) {
      await sell(sym,pos,'Rebalance'); delete activePos[sym];
      await new Promise(r=>setTimeout(r,300));
    }
    await fetchBalance();
    await manageHolds();
    return res.end(JSON.stringify({success:true,freeUSDT,totalBalance}));
  }

  const holdInUse=Object.values(holdPos).reduce((s,p)=>s+p.usdt,0);
  const activeInUse=Object.values(activePos).reduce((s,p)=>s+p.usdt,0);
  res.end(JSON.stringify({
    status:'online', mode:PAPER_MODE?'simulado':'real',
    paused, lastCycle, tradeCount,
    pnl:`$${totalPnL.toFixed(2)}`,
    roi:startBalance>0?`${((totalPnL/startBalance)*100).toFixed(1)}%`:'0%',
    capital:{
      total:`$${totalBalance.toFixed(2)}`,
      freeUSDT:`$${freeUSDT.toFixed(2)}`,
      holdTarget:`$${(totalBalance*HOLD_PCT).toFixed(2)} (50%)`,
      activeTarget:`$${(totalBalance*0.50).toFixed(2)} (50%)`,
      holdInUse:`$${holdInUse.toFixed(2)}`,
      activeInUse:`$${activeInUse.toFixed(2)}`,
    },
    positions:{hold:holdPos, active:activePos},
    activeCount:Object.keys(activePos).length
  }));
});

server.listen(PORT, async()=>{
  log(`capital. Bot v8 | ${PAPER_MODE?'SIMULADO':'REAL'} | Ciclo:${CYCLE_MS/1000}s`);
  log(`Hold 50%: BTC+ETH+SOL | Active 50%: qualquer coin`);
  await loadSymbols();
  await fetchBalance();
  await syncPositions(); // register existing coins
  startBalance=totalBalance;
  log(`Capital inicial: $${startBalance.toFixed(2)}`);
  await notify('capital. 🚀 Bot v8!',`Capital: $${startBalance.toFixed(2)}\nHold 50% + Active 50% livre`);
  setInterval(runBot,CYCLE_MS);
  runBot();
});
