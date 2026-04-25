/**
 * capital. Bot v15
 * 
 * LÓGICA:
 * A cada 5 minutos analisa TODAS as coins
 * Compra as que estão acelerando (momentum crescente)
 * Segura enquanto estiver subindo
 * Vende quando começar a cair (trailing stop)
 * Rotaciona automaticamente para coins melhores
 * 
 * ALOCAÇÃO:
 * 30% Hold BTC/ETH/SOL
 * 40% #1 coin com mais momentum
 * 20% #2 coin com mais momentum  
 * 10% #3 coin com mais momentum
 * 10% Aposta semanal (intocável 7 dias)
 */

const http   = require('http');
const axios  = require('axios');
const crypto = require('crypto');

const API_KEY    = process.env.BINANCE_API_KEY    || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const PAPER_MODE = process.env.PAPER_MODE !== 'false';
const NOTIFY_URL = process.env.NOTIFY_URL || '';
const PORT       = process.env.PORT || 3000;
const BASE       = 'https://api.binance.com';

const HOLD_COINS = ['BTCUSDT','ETHUSDT','SOLUSDT'];
const ALLOC = {hold:0.40, r1:0.30, r2:0.15, r3:0.05, bet:0.10};
const MIN_VOL       = 2000000;
const MIN_TRADE     = 5;
const HOLD_TP       = 20;
const HOLD_SL       = 12;
const RANK_SL       = 8;       // hard stop -8%
const TRAIL_START   = 4;       // trailing starts after +4%
const TRAIL_DROP    = 2;       // sell if -2% from peak
const ROTATE_PCT    = 2;       // rotate if new coin 2% better score
const MIN_HOLD_MS   = 300000;  // hold at least 5min before rotating
const BET_DAYS      = 7;
const BET_EMERGENCY = -25;     // only sell bet at -25%
const CYCLE_MS      = 300000;  // analyze every 5 minutes

// ── STATE ─────────────────────────────────────────────
let freeUSDT=0, totalBalance=0, startBalance=0;
let holdPos={}, rankPos={1:null,2:null,3:null}, betPos=null;
let totalPnL=0, tradeCount=0;
let paused=false, lastCycle=null, running=false;
let rateLimitUntil=0;

const log = msg => console.log(`[${new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}] ${msg}`);

async function notify(t,b) {
  if (!NOTIFY_URL) return;
  try { await axios.post(NOTIFY_URL+'/test-send',{title:t,body:b},{timeout:5000}); } catch(e){}
}

// ── HTTP ──────────────────────────────────────────────
async function apiGet(url, headers={}) {
  if (Date.now()<rateLimitUntil) {
    const w=rateLimitUntil-Date.now();
    log(`⏳ Rate limit ${Math.ceil(w/1000)}s`);
    await new Promise(r=>setTimeout(r,w));
  }
  try { return (await axios.get(url,{headers,timeout:15000})).data; }
  catch(e) {
    if (e.response?.status===418||e.response?.status===429) {
      const t=parseInt(e.response?.headers?.['retry-after']||'60');
      rateLimitUntil=Date.now()+t*1000;
      log(`🚫 Rate limit ${t}s`);
      return null;
    }
    return null;
  }
}

async function apiPost(url, headers={}) {
  if (Date.now()<rateLimitUntil) await new Promise(r=>setTimeout(r,rateLimitUntil-Date.now()));
  try { return (await axios.post(url,null,{headers,timeout:15000})).data; }
  catch(e) {
    if (e.response?.status===418||e.response?.status===429) { rateLimitUntil=Date.now()+60000; return null; }
    log(`Order erro: ${e.response?.data?.msg||e.message}`);
    return null;
  }
}

function sign(p={}) {
  const ts=Date.now();
  const q=Object.entries({...p,timestamp:ts}).map(([k,v])=>`${k}=${v}`).join('&');
  return q+'&signature='+crypto.createHmac('sha256',API_SECRET).update(q).digest('hex');
}

const H={'X-MBX-APIKEY':API_KEY};

// ── CORE: SCORE MOMENTUM ──────────────────────────────
// Gets 12 candles of 5min = last hour
// Calculates acceleration, trend consistency, recent spike
async function scoreMomentum(symbol) {
  try {
    const k=await apiGet(`${BASE}/api/v3/klines?symbol=${symbol}&interval=5m&limit=12`);
    if (!k||k.length<6) return null;

    const closes=k.map(c=>parseFloat(c[4]));
    const vols=k.map(c=>parseFloat(c[5]));
    const n=closes.length;

    // 5min change (last candle)
    const ch5m=((closes[n-1]-closes[n-2])/closes[n-2])*100;
    // 10min change
    const ch10m=((closes[n-1]-closes[n-3])/closes[n-3])*100;
    // 30min change
    const ch30m=((closes[n-1]-closes[n-7])/closes[n-7])*100;
    // 60min change
    const ch60m=((closes[n-1]-closes[0])/closes[0])*100;

    // Consistency: how many of last 6 candles were green
    let greenCount=0;
    for (let i=n-6;i<n;i++) { if(closes[i]>closes[i-1]) greenCount++; }
    const consistency=greenCount/6; // 0 to 1

    // Volume acceleration: is volume increasing?
    const avgVolEarly=(vols[0]+vols[1]+vols[2])/3;
    const avgVolRecent=(vols[n-3]+vols[n-2]+vols[n-1])/3;
    const volAccel=avgVolRecent/avgVolEarly; // >1 means increasing

    // SCORE: weight recent momentum most
    // Coins going up slowly but consistently score well
    // Coins spiking recently also score well
    const score = (ch5m*5) + (ch10m*3) + (ch30m*1.5) + (ch60m*0.5)
                + (consistency*10)  // bonus for consistent uptrend
                + (Math.min(volAccel,3)*3); // bonus for volume growth, max 3x

    return {symbol, score, ch5m, ch10m, ch30m, ch60m, consistency, volAccel};
  } catch(e) { return null; }
}

// ── FIND TOP COINS ────────────────────────────────────
async function findTopCoins() {
  log('🔍 Analisando mercado...');

  // Step 1: get all tickers, filter by volume and positive 24h
  const tickers=await apiGet(`${BASE}/api/v3/ticker/24hr`);
  if (!tickers) return [];

  const exclude=new Set([...HOLD_COINS, betPos?.symbol].filter(Boolean));

  const candidates=tickers
    .filter(t=>
      t.symbol.endsWith('USDT') &&
      !exclude.has(t.symbol) &&
      parseFloat(t.quoteVolume)>=MIN_VOL &&
      parseFloat(t.priceChangePercent)>0 &&
      parseFloat(t.priceChangePercent)<500
    )
    .sort((a,b)=>parseFloat(b.priceChangePercent)-parseFloat(a.priceChangePercent))
    .slice(0,40); // analyze top 40 by 24h

  // Step 2: score each by momentum (5min candles)
  log(`Calculando momentum de ${candidates.length} coins...`);
  const scored=[];
  for (const t of candidates) {
    await new Promise(r=>setTimeout(r,150)); // 150ms between calls
    const s=await scoreMomentum(t.symbol);
    if (s && s.score>0) scored.push({
      ...s,
      ch24h:parseFloat(t.priceChangePercent),
      vol:parseFloat(t.quoteVolume)
    });
  }

  // Sort by score descending
  scored.sort((a,b)=>b.score-a.score);

  if (scored.length>0) {
    log(`🔥 Top momentum:`);
    for (const c of scored.slice(0,5)) {
      log(`  ${c.symbol.replace('USDT','')}: score=${c.score.toFixed(1)} 5m=${c.ch5m>=0?'+':''}${c.ch5m.toFixed(2)}% 30m=${c.ch30m>=0?'+':''}${c.ch30m.toFixed(2)}% consist=${(c.consistency*100).toFixed(0)}%`);
    }
  }

  return scored;
}

// ── FIND WEEKLY BET ───────────────────────────────────
async function findWeeklyBet(topCoins) {
  // Bet on a coin that is:
  // - NOT in top 3 (those are already pumping)
  // - Has strong volume growth (building interest)
  // - Gaining steadily (not spiked and dropping)
  // - Between 5-40% gains in 24h (not overheated)
  const rankSymbols=new Set(Object.values(rankPos).filter(Boolean).map(p=>p.symbol));

  const tickers=await apiGet(`${BASE}/api/v3/ticker/24hr`);
  if (!tickers) return null;

  const bets=tickers
    .filter(t=>{
      if (!t.symbol.endsWith('USDT')) return false;
      if (HOLD_COINS.includes(t.symbol)) return false;
      if (rankSymbols.has(t.symbol)) return false;
      const ch=parseFloat(t.priceChangePercent);
      const vol=parseFloat(t.quoteVolume);
      // Sweet spot: 5-40% gain, $5M+ volume
      return ch>=5 && ch<=40 && vol>=5000000;
    })
    .map(t=>{
      const ch24h=parseFloat(t.priceChangePercent);
      const vol=parseFloat(t.quoteVolume);
      const last=parseFloat(t.lastPrice);
      const high=parseFloat(t.highPrice);
      const distFromHigh=((high-last)/high)*100;
      // Score: prefer coins NOT at peak (room to grow) + high volume
      const score=(ch24h)+(distFromHigh>10?8:0)+(Math.log10(vol)*2);
      return {symbol:t.symbol, ch24h, vol, distFromHigh, score};
    })
    .sort((a,b)=>b.score-a.score)
    .slice(0,3);

  if (!bets.length) return null;
  const pick=bets[0];
  log(`[BET] Escolhendo ${pick.symbol} — +${pick.ch24h.toFixed(1)}% 24h, ${pick.distFromHigh.toFixed(1)}% abaixo do topo, vol $${(pick.vol/1e6).toFixed(0)}M`);
  return pick;
}

// ── BALANCE ───────────────────────────────────────────
async function fetchBalance() {
  const d=await apiGet(`${BASE}/api/v3/account?${sign()}`,H);
  if (!d) return;
  let usdt=0,total=0;
  const prices={};
  for (const t of (await apiGet(`${BASE}/api/v3/ticker/price`)||[])) prices[t.symbol]=parseFloat(t.price);
  for (const b of d.balances) {
    const qty=parseFloat(b.free)+parseFloat(b.locked);
    if (qty<=0) continue;
    if (b.asset==='USDT') { usdt=parseFloat(b.free); total+=qty; continue; }
    if (['BRL','EUR','GBP','BUSD','USDC'].includes(b.asset)) continue;
    const p=prices[b.asset+'USDT']||0;
    if (p>0) total+=qty*p;
  }
  freeUSDT=usdt; totalBalance=total;
  log(`💰 $${total.toFixed(2)} | USDT: $${usdt.toFixed(2)}`);
}

async function getPrice(symbol) {
  const d=await apiGet(`${BASE}/api/v3/ticker/price?symbol=${symbol}`);
  return d?parseFloat(d.price):0;
}

async function getQty(symbol, usdtAmt) {
  const p=await getPrice(symbol);
  if (!p) return 0;
  const raw=usdtAmt/p;
  if (p>10000) return parseFloat(raw.toFixed(5));
  if (p>1000)  return parseFloat(raw.toFixed(4));
  if (p>100)   return parseFloat(raw.toFixed(3));
  if (p>10)    return parseFloat(raw.toFixed(2));
  if (p>1)     return parseFloat(raw.toFixed(1));
  return Math.floor(raw);
}

// ── BUY ───────────────────────────────────────────────
async function buy(symbol, amt, tag) {
  if (!amt||amt<MIN_TRADE||freeUSDT<amt*0.98) return null;
  const qty=await getQty(symbol,amt);
  if (!qty||qty<=0) return null;
  const price=await getPrice(symbol);
  log(`[BUY][${tag}] ${symbol} ~$${amt.toFixed(2)}`);
  if (!PAPER_MODE) {
    const r=await apiPost(`${BASE}/api/v3/order?${sign({symbol,side:'BUY',type:'MARKET',quantity:qty})}`,H);
    if (!r) return null;
  }
  freeUSDT-=amt; tradeCount++;
  await notify(`🟢 [${tag}] ${symbol.replace('USDT','')}`,`$${amt.toFixed(2)} @ $${price.toFixed(4)}`);
  return {symbol,entryPrice:price,qty,usdt:amt,ts:Date.now(),tag,peak:price};
}

// ── SELL ──────────────────────────────────────────────
async function sell(symbol, pos, reason) {
  if (!pos?.entryPrice||!pos?.qty) return false;
  const price=await getPrice(symbol);
  if (!price) return false;
  const pct=((price-pos.entryPrice)/pos.entryPrice)*100;
  const pnl=pos.usdt*(pct/100);
  log(`[SELL][${pos.tag}] ${symbol} ${pct>=0?'+':''}${pct.toFixed(2)}% $${pnl>=0?'+':''}${pnl.toFixed(2)} | ${reason}`);
  if (!PAPER_MODE) {
    const r=await apiPost(`${BASE}/api/v3/order?${sign({symbol,side:'SELL',type:'MARKET',quantity:pos.qty})}`,H);
    if (!r) return false;
  }
  totalPnL+=pnl; freeUSDT+=pos.usdt+pnl; tradeCount++;
  const roi=startBalance>0?((totalPnL/startBalance)*100).toFixed(1):'0';
  await notify(`${pnl>=0?'📈':'📉'} [${pos.tag}] ${symbol.replace('USDT','')}`,
    `${pct>=0?'+':''}${pct.toFixed(2)}% | $${pnl>=0?'+':''}${pnl.toFixed(2)}\nROI: ${roi}%`);
  if (startBalance>0) {
    if (totalPnL<=-(startBalance*0.20)) { paused=true; notify('⛔ Bot pausado',`Perda $${Math.abs(totalPnL).toFixed(2)}`); }
    if (totalPnL>= startBalance*0.50)   { paused=true; notify('🏆 Meta!',`Lucro $${totalPnL.toFixed(2)}`); }
  }
  return true;
}

// ── FREE CAPITAL ──────────────────────────────────────
async function freeCapital() {
  if (freeUSDT>=MIN_TRADE*2) return;
  log(`Sem capital ($${freeUSDT.toFixed(2)}) — vendendo pior posição...`);

  // Rank all positions by performance (worst first)
  const all=[];
  for (const [rank,pos] of Object.entries(rankPos)) {
    if (!pos) continue;
    const price=await getPrice(pos.symbol);
    if (!price) continue;
    const pct=((price-pos.entryPrice)/pos.entryPrice)*100;
    all.push({rank,pos,pct});
  }
  all.sort((a,b)=>a.pct-b.pct);

  // Try to sell worst until we have capital
  for (const item of all) {
    if (freeUSDT>=MIN_TRADE*2) break;
    log(`Vendendo rank ${item.rank} ${item.pos.symbol} (${item.pct.toFixed(2)}%)`);
    const ok=await sell(item.pos.symbol,item.pos,`Liberando capital`);
    if (ok) { rankPos[item.rank]=null; await fetchBalance(); }
    await new Promise(r=>setTimeout(r,500));
  }
}

// ── MAIN CYCLE ────────────────────────────────────────
async function runBot() {
  if (paused||running) return;
  running=true;
  lastCycle=new Date().toISOString();
  log(`\n${'═'.repeat(60)}`);
  log(`Ciclo iniciado`);

  try {
    await fetchBalance();
    if (totalBalance<=0) { running=false; return; }

    // ── HOLDS ──────────────────────────────────────────
    const perHold=totalBalance*ALLOC.hold/HOLD_COINS.length;
    for (const sym of [...Object.keys(holdPos)]) {
      if (!holdPos[sym]) continue;
      const price=await getPrice(sym);
      if (!price) continue;
      const pct=((price-holdPos[sym].entryPrice)/holdPos[sym].entryPrice)*100;
      log(`[HOLD] ${sym} ${pct>=0?'+':''}${pct.toFixed(2)}%`);
      if (pct>=HOLD_TP) { await sell(sym,holdPos[sym],`TP +${pct.toFixed(1)}%`); delete holdPos[sym]; }
      else if (pct<=-HOLD_SL) { await sell(sym,holdPos[sym],`SL ${pct.toFixed(1)}%`); delete holdPos[sym]; }
    }
    for (const sym of HOLD_COINS) {
      if (holdPos[sym]) continue;
      const amt=Math.min(perHold,freeUSDT*0.9);
      if (amt<MIN_TRADE) continue;
      const p=await buy(sym,amt,'HOLD');
      if (p) holdPos[sym]=p;
    }

    // ── FIND TOP COINS ─────────────────────────────────
    const top=await findTopCoins();
    if (!top.length) { running=false; return; }

    // ── CHECK EXISTING RANKED POSITIONS ────────────────
    for (const [rank,pos] of Object.entries(rankPos)) {
      if (!pos) continue;
      const price=await getPrice(pos.symbol);
      if (!price) continue;

      // Update peak
      if (price>pos.peak) rankPos[rank].peak=price;
      const pct=((price-pos.entryPrice)/pos.entryPrice)*100;
      const fromPeak=((price-pos.peak)/pos.peak)*100;
      const age=Date.now()-pos.ts;

      log(`[#${rank}] ${pos.symbol} ${pct>=0?'+':''}${pct.toFixed(2)}% peak:${fromPeak.toFixed(2)}%`);

      let sellReason=null;
      if (pct<=-RANK_SL) sellReason=`SL ${pct.toFixed(2)}%`;
      else if (pct>=TRAIL_START&&fromPeak<=-TRAIL_DROP) sellReason=`Trailing +${pct.toFixed(2)}% peak:${fromPeak.toFixed(2)}%`;

      if (sellReason) {
        const ok=await sell(pos.symbol,pos,sellReason);
        if (ok) rankPos[rank]=null;
        continue;
      }

      // Rotate if better coin available
      const newCoin=top[parseInt(rank)-1];
      if (!newCoin) continue;
      if (newCoin.symbol===pos.symbol) continue;
      if (age<MIN_HOLD_MS) continue;

      const currentScore=top.find(t=>t.symbol===pos.symbol)?.score||0;
      const improvement=(newCoin.score-currentScore)/Math.abs(currentScore||1)*100;

      if (improvement>=ROTATE_PCT) {
        log(`[ROTATE] #${rank}: ${pos.symbol}(${currentScore.toFixed(0)}) → ${newCoin.symbol}(${newCoin.score.toFixed(0)}) +${improvement.toFixed(1)}%`);
        const ok=await sell(pos.symbol,pos,`Rotação → ${newCoin.symbol}`);
        if (ok) { rankPos[rank]=null; await new Promise(r=>setTimeout(r,500)); }
      }
    }

    // ── BUY RANKED POSITIONS ───────────────────────────
    const rankAllocs=[
      {rank:'1',pct:ALLOC.r1,coin:top[0]},
      {rank:'2',pct:ALLOC.r2,coin:top[1]},
      {rank:'3',pct:ALLOC.r3,coin:top[2]},
    ];

    for (const {rank,pct,coin} of rankAllocs) {
      if (!coin) continue;
      if (rankPos[rank]) continue;
      await freeCapital();
      const amt=Math.min(totalBalance*pct, freeUSDT*0.95);
      if (amt<MIN_TRADE) continue;
      const p=await buy(coin.symbol,amt,`#${rank}`);
      if (p) {
        rankPos[rank]={...p,score:coin.score};
        await notify(`🔥 #${rank} ${coin.symbol.replace('USDT','')}`,
          `Score: ${coin.score.toFixed(0)} | 5m:${coin.ch5m>=0?'+':''}${coin.ch5m.toFixed(1)}% 30m:${coin.ch30m>=0?'+':''}${coin.ch30m.toFixed(1)}%\n$${amt.toFixed(2)} alocado`);
      }
      await new Promise(r=>setTimeout(r,500));
    }

    // ── WEEKLY BET ─────────────────────────────────────
    if (!betPos) {
      const bet=await findWeeklyBet(top);
      if (bet) {
        await freeCapital();
        const amt=Math.min(totalBalance*ALLOC.bet,freeUSDT*0.9);
        if (amt>=MIN_TRADE) {
          const p=await buy(bet.symbol,amt,'BET');
          if (p) {
            betPos=p;
            await notify(`🎯 Aposta 7d: ${bet.symbol.replace('USDT','')}`,
              `+${bet.ch24h.toFixed(1)}% 24h | ${bet.distFromHigh.toFixed(1)}% abaixo do topo\nIntocável 7 dias | $${amt.toFixed(2)}`);
          }
        }
      }
    } else {
      // Check bet emergency stop only
      const price=await getPrice(betPos.symbol);
      if (price) {
        const pct=((price-betPos.entryPrice)/betPos.entryPrice)*100;
        const age=Date.now()-betPos.ts;
        log(`[BET] ${betPos.symbol} ${pct>=0?'+':''}${pct.toFixed(2)}% (${Math.floor(age/86400000)}d/${BET_DAYS}d)`);
        if (pct<=BET_EMERGENCY) {
          const ok=await sell(betPos.symbol,betPos,`Emergência ${pct.toFixed(2)}%`);
          if (ok) betPos=null;
        } else if (age>=BET_DAYS*86400000) {
          // 7 days up — sell and pick new bet
          const ok=await sell(betPos.symbol,betPos,`7 dias concluídos`);
          if (ok) betPos=null;
        }
      }
    }

    // ── SUMMARY ────────────────────────────────────────
    const hi=Object.values(holdPos).reduce((s,p)=>s+(p?.usdt||0),0);
    const ri=Object.values(rankPos).reduce((s,p)=>s+(p?.usdt||0),0);
    const bi=betPos?.usdt||0;
    const roi=startBalance>0?((totalPnL/startBalance)*100).toFixed(1):'0';
    log(`PnL: $${totalPnL.toFixed(2)} (${roi}%) | Hold:$${hi.toFixed(0)} Rank:$${ri.toFixed(0)} Bet:$${bi.toFixed(0)} USDT:$${freeUSDT.toFixed(2)}`);

  } catch(e) { log(`Erro: ${e.message}`); }
  running=false;
}

// ── HTTP SERVER ───────────────────────────────────────
http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if (req.url==='/pause')  { paused=true;  return res.end(JSON.stringify({paused:true})); }
  if (req.url==='/resume') { paused=false; return res.end(JSON.stringify({paused:false})); }
  if (req.url==='/rebalance') {
    for (const [r,p] of Object.entries(rankPos)) { if(p){await sell(p.symbol,p,'Rebalance');rankPos[r]=null;} }
    await fetchBalance();
    return res.end(JSON.stringify({ok:true,freeUSDT}));
  }

  // Sync existing Binance positions into bot tracking
  if (req.url==='/sync') {
    holdPos={}; rankPos={1:null,2:null,3:null}; betPos=null;
    const d=await apiGet(`${BASE}/api/v3/account?${sign()}`,H);
    if (d) {
      const prices={};
      const tickers=await apiGet(`${BASE}/api/v3/ticker/price`);
      if (tickers) for (const t of tickers) prices[t.symbol]=parseFloat(t.price);
      const holdAssets=new Set(HOLD_COINS.map(s=>s.replace('USDT','')));
      let rankIdx=1;
      for (const b of d.balances) {
        const qty=parseFloat(b.free)+parseFloat(b.locked);
        if (qty<=0) continue;
        if (['USDT','BRL','EUR','GBP','BUSD','USDC'].includes(b.asset)) continue;
        const sym=b.asset+'USDT';
        const price=prices[sym]||0;
        if (!price||qty*price<1) continue;
        const pos={symbol:sym,entryPrice:price,qty,usdt:qty*price,ts:Date.now(),tag:'SYNC',peak:price};
        if (holdAssets.has(b.asset)) {
          holdPos[sym]=pos;
          log(`[SYNC] Hold: ${sym} $${(qty*price).toFixed(2)}`);
        } else if (rankIdx<=3) {
          rankPos[rankIdx]=pos;
          log(`[SYNC] Rank${rankIdx}: ${sym} $${(qty*price).toFixed(2)}`);
          rankIdx++;
        }
      }
      await fetchBalance();
    }
    return res.end(JSON.stringify({ok:true,holdPos,rankPos,betPos,freeUSDT}));
  }
  const roi=startBalance>0?((totalPnL/startBalance)*100).toFixed(1):'0';
  res.end(JSON.stringify({
    status:'online', mode:PAPER_MODE?'sim':'real',
    paused, lastCycle, tradeCount,
    pnl:`$${totalPnL.toFixed(2)}`, roi:`${roi}%`,
    rateLimited:Date.now()<rateLimitUntil,
    capital:{total:`$${totalBalance.toFixed(2)}`,freeUSDT:`$${freeUSDT.toFixed(2)}`},
    positions:{hold:holdPos, rank1:rankPos[1], rank2:rankPos[2], rank3:rankPos[3], bet:betPos}
  }));
}).listen(PORT, async()=>{
  log(`capital. Bot v15 | ${PAPER_MODE?'SIM':'REAL'}`);
  log(`Ciclo: ${CYCLE_MS/60000} min | 30% Hold | 40/20/10% Momentum | 10% Bet 7d`);
  await new Promise(r=>setTimeout(r,3000));
  await fetchBalance();
  startBalance=totalBalance;
  log(`Capital: $${startBalance.toFixed(2)}`);
  await notify('capital. 🚀 Bot v15!',`Capital: $${startBalance.toFixed(2)}\nAnálise a cada 5min`);
  setInterval(runBot, CYCLE_MS);
  runBot();
});
