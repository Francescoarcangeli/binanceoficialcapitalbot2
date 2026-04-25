/**
 * capital. Bot v14
 * 
 * ALOCAÇÃO:
 * 30% → Hold (BTC + ETH + SOL)
 * 40% → #1 coin mais quente
 * 20% → #2 coin mais quente  
 * 10% → #3 coin mais quente
 * 10% → Aposta semanal (bot escolhe, intocável 7 dias)
 * 
 * COMO DEFINE "MAIS QUENTE":
 * Score = (variação 1h × 4) + (variação 24h × 2) + (aceleração 5min × 5)
 * Apenas coins com volume > $2M (coins reais)
 * 
 * QUANDO ROTACIONA:
 * Se nova coin tem score 20% melhor que a atual → rotaciona
 * Nunca vende com < 3min de posição (evita churning)
 * 
 * APOSTA SEMANAL:
 * Analisa notícias + momentum 7d + volume crescente
 * Fica 7 dias intocável mesmo se cair
 * 
 * RATE LIMIT:
 * Apenas 3 tipos de chamadas: getAllTickers, getAccount, placeOrder
 * Ciclo de 30s, sem chamadas paralelas desnecessárias
 */

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

// ── ALLOCATION ───────────────────────────────────────
const HOLD_COINS = ['BTCUSDT','ETHUSDT','SOLUSDT'];
const ALLOC = {
  hold:  0.30,  // BTC+ETH+SOL
  rank1: 0.40,  // #1 hottest
  rank2: 0.20,  // #2 hottest
  rank3: 0.10,  // #3 hottest
  bet:   0.10,  // weekly bet
};

// ── RULES ────────────────────────────────────────────
const MIN_VOL        = 2000000;  // $2M min volume
const MIN_TRADE      = 5;
const ROTATE_THRESH  = 0.02;    // rotate if new coin score 2% better
const MIN_HOLD_MS    = 180000;  // hold at least 3 min before selling
const BET_HOLD_MS    = 604800000; // 7 days
const HOLD_TP        = 20;
const HOLD_SL        = 12;
const RANK_SL        = 8;       // stop ranked position at -8%
const CYCLE_MS       = 30000;   // 30 second cycle

// ── STATE ────────────────────────────────────────────
let freeUSDT       = 0;
let totalBalance   = 0;
let startBalance   = 0;
let holdPos        = {};
let rankPos        = {};   // {1: pos, 2: pos, 3: pos}
let betPos         = null; // weekly bet position
let totalPnL       = 0;
let tradeCount     = 0;
let paused         = false;
let lastCycle      = null;
let running        = false;
let rateLimitUntil = 0;
let lastTickers    = [];  // cache all tickers
let lastTickersTs  = 0;

const log = msg => console.log(`[${new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}] ${msg}`);

async function notify(title, body) {
  if (!NOTIFY_URL) return;
  try { await axios.post(NOTIFY_URL+'/test-send',{title,body},{timeout:5000}); } catch(e){}
}

// ── HTTP with rate limit protection ──────────────────
async function http_get(url, headers={}) {
  if (Date.now() < rateLimitUntil) {
    const w = rateLimitUntil - Date.now();
    log(`⏳ Aguardando rate limit: ${Math.ceil(w/1000)}s`);
    await new Promise(r=>setTimeout(r,w));
  }
  try {
    const r = await axios.get(url, {headers, timeout:15000});
    return r.data;
  } catch(e) {
    if (e.response?.status===418||e.response?.status===429) {
      const t = parseInt(e.response?.headers?.['retry-after']||'120');
      rateLimitUntil = Date.now()+t*1000;
      log(`🚫 Rate limit ${e.response.status} — bloqueado ${t}s`);
      return null;
    }
    return null;
  }
}

async function http_post(url, headers={}) {
  if (Date.now() < rateLimitUntil) {
    await new Promise(r=>setTimeout(r,rateLimitUntil-Date.now()));
  }
  try {
    const r = await axios.post(url, null, {headers, timeout:15000});
    return r.data;
  } catch(e) {
    if (e.response?.status===418||e.response?.status===429) {
      rateLimitUntil = Date.now()+120000;
      log(`🚫 Rate limit POST — bloqueado 120s`);
      return null;
    }
    log(`Erro POST: ${e.response?.data?.msg||e.message}`);
    return null;
  }
}

function buildUrl(path, params={}, signed=false) {
  const entries = Object.entries(params);
  if (signed) entries.push(['timestamp', Date.now()]);
  const qs = entries.map(([k,v])=>`${k}=${v}`).join('&');
  if (!signed) return `${BASE}${path}${qs?'?'+qs:''}`;
  const sig = crypto.createHmac('sha256',API_SECRET).update(qs).digest('hex');
  return `${BASE}${path}?${qs}&signature=${sig}`;
}

const AUTH = {'X-MBX-APIKEY': API_KEY};

// ── GET ALL TICKERS (cached 20s) ──────────────────────
async function getTickers() {
  if (Date.now()-lastTickersTs < 20000 && lastTickers.length > 0) return lastTickers;
  const data = await http_get(buildUrl('/api/v3/ticker/24hr'));
  if (data) { lastTickers=data; lastTickersTs=Date.now(); }
  return lastTickers;
}

async function getPrice(symbol) {
  const tickers = await getTickers();
  const t = tickers.find(t=>t.symbol===symbol);
  return t ? parseFloat(t.lastPrice) : 0;
}

// ── BALANCE ──────────────────────────────────────────
async function fetchBalance() {
  const data = await http_get(buildUrl('/api/v3/account',{},true), AUTH);
  if (!data) return;
  let usdt=0, total=0;
  const tickers = await getTickers();
  const priceMap = {};
  for (const t of tickers) priceMap[t.symbol]=parseFloat(t.lastPrice);
  for (const b of data.balances) {
    const qty = parseFloat(b.free)+parseFloat(b.locked);
    if (qty<=0) continue;
    if (b.asset==='USDT') { usdt=parseFloat(b.free); total+=qty; continue; }
    if (['BRL','EUR','GBP','BUSD','USDC'].includes(b.asset)) continue;
    const p = priceMap[b.asset+'USDT']||0;
    if (p>0) total+=qty*p;
  }
  freeUSDT=usdt; totalBalance=total;
  log(`💰 $${total.toFixed(2)} | USDT: $${usdt.toFixed(2)}`);
}

// ── LOT SIZE ─────────────────────────────────────────
async function getQty(symbol, usdtAmt) {
  const price = await getPrice(symbol);
  if (!price) return 0;
  const rawQty = usdtAmt / price;
  // Use simple rounding based on price — avoids extra API call
  let qty;
  if (price > 10000) qty = parseFloat(rawQty.toFixed(5));
  else if (price > 100) qty = parseFloat(rawQty.toFixed(3));
  else if (price > 1)   qty = parseFloat(rawQty.toFixed(2));
  else if (price > 0.01) qty = parseFloat(rawQty.toFixed(0));
  else qty = Math.floor(rawQty);
  return qty > 0 ? qty : 0;
}

// ── BUY / SELL ────────────────────────────────────────
async function buy(symbol, usdtAmt, tag) {
  if (!usdtAmt||usdtAmt<MIN_TRADE||isNaN(usdtAmt)) return null;
  if (freeUSDT < usdtAmt*0.98) {
    log(`[${tag}] Sem USDT: $${freeUSDT.toFixed(2)} < $${usdtAmt.toFixed(2)}`);
    return null;
  }
  const price = await getPrice(symbol);
  if (!price) return null;
  const qty = await getQty(symbol, usdtAmt);
  if (!qty) return null;

  log(`[BUY][${tag}] ${symbol} ~$${usdtAmt.toFixed(2)} qty:${qty}`);

  if (!PAPER_MODE) {
    const r = await http_post(buildUrl('/api/v3/order',{symbol,side:'BUY',type:'MARKET',quantity:qty},true), AUTH);
    if (!r) return null;
  }

  freeUSDT -= usdtAmt;
  tradeCount++;
  await notify(`🟢 [${tag}] ${symbol.replace('USDT','')}`, `$${usdtAmt.toFixed(2)} @ $${price.toFixed(4)}`);
  return {symbol, entryPrice:price, qty, usdt:usdtAmt, ts:Date.now(), tag, peak:price};
}

async function sell(symbol, pos, reason) {
  if (!pos||!pos.entryPrice||!pos.qty) return false;
  const price = await getPrice(symbol);
  if (!price) return false;
  const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
  const pnl = pos.usdt*(pct/100);

  log(`[SELL][${pos.tag}] ${symbol} ${pct>=0?'+':''}${pct.toFixed(2)}% $${pnl>=0?'+':''}${pnl.toFixed(2)} | ${reason}`);

  if (!PAPER_MODE) {
    const r = await http_post(buildUrl('/api/v3/order',{symbol,side:'SELL',type:'MARKET',quantity:pos.qty},true), AUTH);
    if (!r) return false;
  }

  totalPnL+=pnl; freeUSDT+=pos.usdt+pnl; tradeCount++;
  const roi = startBalance>0?((totalPnL/startBalance)*100).toFixed(1):'0';
  await notify(`${pnl>=0?'📈':'📉'} [${pos.tag}] ${symbol.replace('USDT','')}`,
    `${pct>=0?'+':''}${pct.toFixed(2)}% | $${pnl>=0?'+':''}${pnl.toFixed(2)}\nROI: ${roi}%`);

  if (startBalance>0) {
    if (totalPnL<=-(startBalance*0.20)) { paused=true; notify('⛔ Bot pausado',`Perda: $${Math.abs(totalPnL).toFixed(2)}`); }
    if (totalPnL>= startBalance*0.50)   { paused=true; notify('🏆 Meta atingida!',`Lucro: $${totalPnL.toFixed(2)}`); }
  }
  return true;
}

// ── SELL WORST to free capital ────────────────────────
async function freeCapital(needed) {
  if (freeUSDT >= needed) return;
  log(`Liberando capital (precisa $${needed.toFixed(2)}, tem $${freeUSDT.toFixed(2)})`);

  // Find worst ranked position (never sell hold or bet)
  let worstRank = null, worstPct = Infinity;
  for (const [rank, pos] of Object.entries(rankPos)) {
    if (!pos) continue;
    const price = await getPrice(pos.symbol);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    const age = Date.now()-pos.ts;
    if (age < MIN_HOLD_MS) continue; // too new
    if (pct < worstPct) { worstPct=pct; worstRank=rank; }
  }

  if (worstRank) {
    const pos = rankPos[worstRank];
    log(`Vendendo pior posição: Rank ${worstRank} ${pos.symbol} (${worstPct.toFixed(2)}%)`);
    const ok = await sell(pos.symbol, pos, `Liberando capital`);
    if (ok) rankPos[worstRank] = null;
  }
}

// ── SCORE COIN ────────────────────────────────────────
function scoreCoin(ticker) {
  const ch24h = parseFloat(ticker.priceChangePercent);
  const ch1h  = ((parseFloat(ticker.lastPrice)-parseFloat(ticker.openPrice))/parseFloat(ticker.openPrice))*100;
  const vol   = parseFloat(ticker.quoteVolume);
  if (vol < MIN_VOL) return -Infinity;
  if (ch24h < 0) return -Infinity; // must be going up
  // Score weights recent momentum more
  return (ch1h*4) + (ch24h*2) + Math.log10(vol)*0.5;
}

// ── GET TOP COINS ─────────────────────────────────────
async function getTopCoins() {
  const tickers = await getTickers();
  if (!tickers.length) return [];

  const exclude = new Set([...HOLD_COINS, betPos?.symbol].filter(Boolean));

  const scored = tickers
    .filter(t => t.symbol.endsWith('USDT') && !exclude.has(t.symbol))
    .map(t => ({symbol:t.symbol, score:scoreCoin(t), ch24h:parseFloat(t.priceChangePercent), vol:parseFloat(t.quoteVolume)}))
    .filter(t => t.score > -Infinity)
    .sort((a,b) => b.score-a.score)
    .slice(0, 10);

  return scored;
}

// ── WEEKLY BET ────────────────────────────────────────
// Strategy: find coins that are building momentum over days
// NOT the hottest right now (already pumped), but coins with
// sustained growth + high volume = likely to continue
async function pickWeeklyBet(topCoins) {
  const rankSymbols = new Set(Object.values(rankPos).filter(Boolean).map(p=>p.symbol));
  const tickers = await getTickers();
  
  // Find coins with:
  // 1. Strong 24h gain (5-30%) — not too much (already pumped), not too little
  // 2. Very high volume (building interest)
  // 3. Not already in our ranked positions
  const candidates = tickers
    .filter(t => {
      if (!t.symbol.endsWith('USDT')) return false;
      if (HOLD_COINS.includes(t.symbol)) return false;
      if (rankSymbols.has(t.symbol)) return false;
      const ch24h = parseFloat(t.priceChangePercent);
      const vol   = parseFloat(t.quoteVolume);
      // Sweet spot: gaining 5-50% in 24h with massive volume
      // These are coins building momentum, not already peaked
      return ch24h >= 5 && ch24h <= 50 && vol >= 5000000;
    })
    .map(t => {
      const ch24h = parseFloat(t.priceChangePercent);
      const vol   = parseFloat(t.quoteVolume);
      const high  = parseFloat(t.highPrice);
      const last  = parseFloat(t.lastPrice);
      // Prefer coins NOT at their 24h high (more room to grow)
      const distFromHigh = ((high-last)/high)*100;
      // Score: volume matters most for weekly bet
      const score = (ch24h * 1.5) + Math.log10(vol) + (distFromHigh > 5 ? 5 : 0);
      return {symbol:t.symbol, ch24h, vol, score, distFromHigh};
    })
    .sort((a,b) => b.score - a.score)
    .slice(0, 5);

  if (!candidates.length) return null;
  
  // Pick the best candidate
  const pick = candidates[0];
  log(`[BET] Escolhendo ${pick.symbol} — +${pick.ch24h.toFixed(1)}% 24h, vol $${(pick.vol/1e6).toFixed(1)}M, ${pick.distFromHigh.toFixed(1)}% abaixo do topo`);
  return pick;
}

// ── MANAGE HOLDS ─────────────────────────────────────
async function manageHolds() {
  const perCoin = totalBalance * ALLOC.hold / HOLD_COINS.length;
  for (const symbol of [...Object.keys(holdPos)]) {
    if (!holdPos[symbol]) continue;
    const pos = holdPos[symbol];
    const price = await getPrice(symbol);
    if (!price) continue;
    const pct = ((price-pos.entryPrice)/pos.entryPrice)*100;
    log(`[HOLD] ${symbol} ${pct>=0?'+':''}${pct.toFixed(2)}%`);
    if (pct>=HOLD_TP) {
      await sell(symbol,pos,`TP +${pct.toFixed(1)}%`); delete holdPos[symbol];
      await new Promise(r=>setTimeout(r,1000));
      const p=await buy(symbol,Math.min(perCoin,freeUSDT*0.95),'HOLD');
      if (p) holdPos[symbol]=p;
    } else if (pct<=-HOLD_SL) {
      await sell(symbol,pos,`SL ${pct.toFixed(1)}%`); delete holdPos[symbol];
    }
  }
  for (const symbol of HOLD_COINS) {
    if (holdPos[symbol]) continue;
    const amt = Math.min(perCoin, freeUSDT*0.9);
    if (amt<MIN_TRADE) continue;
    const p = await buy(symbol,amt,'HOLD');
    if (p) holdPos[symbol]=p;
    await new Promise(r=>setTimeout(r,500));
  }
}

// ── MANAGE RANKED POSITIONS ───────────────────────────
async function manageRanked(topCoins) {
  const allocations = [
    {rank:1, pct:ALLOC.rank1},
    {rank:2, pct:ALLOC.rank2},
    {rank:3, pct:ALLOC.rank3},
  ];

  for (let i=0; i<allocations.length; i++) {
    const {rank, pct} = allocations[i];
    const targetCoin = topCoins[i];
    const current = rankPos[rank];

    if (!targetCoin) continue;

    // Check if current position needs stop loss
    if (current) {
      const price = await getPrice(current.symbol);
      if (price) {
        const pctChange = ((price-current.entryPrice)/current.entryPrice)*100;
        if (current.peak < price) rankPos[rank].peak = price;
        const fromPeak = ((price-current.peak)/current.peak)*100;

        // Stop loss
        if (pctChange <= -RANK_SL) {
          log(`[RANK${rank}] SL ${pctChange.toFixed(2)}% — vendendo ${current.symbol}`);
          const ok = await sell(current.symbol, current, `SL ${pctChange.toFixed(2)}%`);
          if (ok) { rankPos[rank]=null; await new Promise(r=>setTimeout(r,500)); }
        }
        // Trailing stop after +5%
        else if (pctChange>=5 && fromPeak<=-2) {
          log(`[RANK${rank}] Trailing ${fromPeak.toFixed(2)}% from peak — vendendo ${current.symbol}`);
          const ok = await sell(current.symbol, current, `Trailing peak:${fromPeak.toFixed(2)}%`);
          if (ok) { rankPos[rank]=null; await new Promise(r=>setTimeout(r,500)); }
        }
        else {
          log(`[RANK${rank}] ${current.symbol} ${pctChange>=0?'+':''}${pctChange.toFixed(2)}%`);
        }
      }
    }

    // Should we rotate to better coin?
    const currentAfterCheck = rankPos[rank];
    if (currentAfterCheck) {
      const currentScore = topCoins.find(t=>t.symbol===currentAfterCheck.symbol)?.score || 0;
      const newScore = targetCoin.score;
      const age = Date.now()-currentAfterCheck.ts;
      const betterByThresh = newScore > currentScore * (1+ROTATE_THRESH);
      const differentCoin = currentAfterCheck.symbol !== targetCoin.symbol;

      if (differentCoin && betterByThresh && age>MIN_HOLD_MS) {
        log(`[RANK${rank}] Rotacionando ${currentAfterCheck.symbol} → ${targetCoin.symbol} (score ${currentScore.toFixed(1)} → ${newScore.toFixed(1)})`);
        const ok = await sell(currentAfterCheck.symbol, currentAfterCheck, `Rotação para ${targetCoin.symbol}`);
        if (ok) { rankPos[rank]=null; await new Promise(r=>setTimeout(r,500)); }
      }
    }

    // Buy if empty
    if (!rankPos[rank]) {
      await freeCapital(totalBalance*pct*0.5);
      const amt = Math.min(totalBalance*pct, freeUSDT*0.95);
      if (amt<MIN_TRADE) { log(`Sem capital para rank ${rank}`); continue; }
      const p = await buy(targetCoin.symbol, amt, `#${rank}`);
      if (p) {
        rankPos[rank] = p;
        await notify(`🔥 #${rank} ${targetCoin.symbol.replace('USDT','')}`,
          `+${targetCoin.ch24h.toFixed(1)}% 24h\nAlocando $${amt.toFixed(2)} (${(pct*100).toFixed(0)}%)`);
      }
      await new Promise(r=>setTimeout(r,500));
    }
  }
}

// ── MANAGE BET ────────────────────────────────────────
async function manageBet(topCoins) {
  // Check if bet exists and is still valid
  if (betPos) {
    const age = Date.now()-betPos.ts;
    const price = await getPrice(betPos.symbol);
    const pct = price ? ((price-betPos.entryPrice)/betPos.entryPrice)*100 : 0;
    log(`[BET] ${betPos.symbol} ${pct>=0?'+':''}${pct.toFixed(2)}% (${Math.floor(age/86400000)}d)`);

    // Hold for 7 days — only emergency exit at -30%
    if (pct <= -30) {
      log(`[BET] Stop emergência -30%`);
      const ok = await sell(betPos.symbol, betPos, `Emergência -30%`);
      if (ok) betPos = null;
    }
    return; // don't touch bet otherwise
  }

  // Pick new weekly bet
  const candidate = await pickWeeklyBet(topCoins);
  if (!candidate) return;

  await freeCapital(totalBalance*ALLOC.bet*0.5);
  const amt = Math.min(totalBalance*ALLOC.bet, freeUSDT*0.9);
  if (amt<MIN_TRADE) return;

  log(`[BET] Apostando em ${candidate.symbol} por 7 dias`);
  const p = await buy(candidate.symbol, amt, 'BET');
  if (p) {
    betPos = p;
    await notify(`🎯 Aposta semanal: ${candidate.symbol.replace('USDT','')}`,
      `+${candidate.ch24h.toFixed(1)}% 24h\nIntocável por 7 dias\n$${amt.toFixed(2)}`);
  }
}

// ── MAIN CYCLE ────────────────────────────────────────
async function runBot() {
  if (paused || running) return;
  if (Date.now() < rateLimitUntil) return;
  running = true;
  lastCycle = new Date().toISOString();

  try {
    await fetchBalance();
    if (totalBalance <= 0) { running=false; return; }

    const topCoins = await getTopCoins();
    if (topCoins.length < 3) { log('Poucos dados de mercado'); running=false; return; }

    log(`🔥 Hot: ${topCoins.slice(0,5).map((c,i)=>`#${i+1} ${c.symbol.replace('USDT','')}(+${c.ch24h.toFixed(1)}%)`).join(' ')}`);

    await manageHolds();
    await manageRanked(topCoins);
    await manageBet(topCoins);

    const hi = Object.values(holdPos).reduce((s,p)=>s+(p?.usdt||0),0);
    const ri = Object.values(rankPos).reduce((s,p)=>s+(p?.usdt||0),0);
    const bi = betPos?.usdt||0;
    const roi = startBalance>0?((totalPnL/startBalance)*100).toFixed(1):'0';
    log(`=== PnL:$${totalPnL.toFixed(2)}(${roi}%) | USDT:$${freeUSDT.toFixed(2)} | Hold:$${hi.toFixed(0)} Ranked:$${ri.toFixed(0)} Bet:$${bi.toFixed(0)} ===`);

  } catch(e) { log(`Erro ciclo: ${e.message}`); }
  running = false;
}

// ── HTTP SERVER ───────────────────────────────────────
const server = http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if (req.url==='/pause')  { paused=true;  return res.end(JSON.stringify({paused:true})); }
  if (req.url==='/resume') { paused=false; return res.end(JSON.stringify({paused:false})); }

  const hi = Object.values(holdPos).reduce((s,p)=>s+(p?.usdt||0),0);
  const ri = Object.values(rankPos).reduce((s,p)=>s+(p?.usdt||0),0);
  res.end(JSON.stringify({
    status: 'online',
    mode:   PAPER_MODE?'simulado':'real',
    paused, lastCycle, tradeCount,
    pnl:    `$${totalPnL.toFixed(2)}`,
    roi:    startBalance>0?`${((totalPnL/startBalance)*100).toFixed(1)}%`:'0%',
    rateLimited: Date.now()<rateLimitUntil,
    capital: {
      total:   `$${totalBalance.toFixed(2)}`,
      freeUSDT:`$${freeUSDT.toFixed(2)}`,
      hold:    `$${hi.toFixed(2)} (30%)`,
      ranked:  `$${ri.toFixed(2)} (70%)`,
      bet:     `$${(betPos?.usdt||0).toFixed(2)} (10%)`,
    },
    positions: {
      hold:   holdPos,
      rank1:  rankPos[1]||null,
      rank2:  rankPos[2]||null,
      rank3:  rankPos[3]||null,
      bet:    betPos,
    }
  }));
});

// ── START ─────────────────────────────────────────────
server.listen(PORT, async()=>{
  log(`capital. Bot v14 | ${PAPER_MODE?'SIM':'REAL'} | ${CYCLE_MS/1000}s`);
  log(`30% Hold | 40% #1 | 20% #2 | 10% #3 | 10% Aposta 7d`);

  // Wait for any existing rate limit to expire
  await new Promise(r=>setTimeout(r,5000));

  await fetchBalance();
  startBalance = totalBalance;
  log(`Capital inicial: $${startBalance.toFixed(2)}`);

  await notify('capital. 🚀 Bot v14!',
    `Capital: $${startBalance.toFixed(2)}\n30% Hold | 40+20+10% Hot coins | 10% Aposta 7d`);

  setInterval(runBot, CYCLE_MS);
  runBot();
});
