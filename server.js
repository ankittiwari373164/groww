
/**
 * TradeBot v15 — Groww Trade API Edition
 * ══════════════════════════════════════════════════════════════
 * Data Source:  Groww Trade API (official, real-time)
 * Historical:   Groww /v1/historical/candle/range (1-min, 5-min, day)
 * Live:         Groww /v1/live-data/quote + /v1/live-data/ohlc (up to 50 at once)
 * Prediction:   Multi-factor AI engine:
 *               1. Opening 10-min momentum (9:15 vs 9:25) ← THE CORE
 *               2. Previous 5-day candle pattern analysis
 *               3. VWAP deviation
 *               4. RSI(14) from 5-min candles
 *               5. EMA stack (9/21/50)
 *               6. Buy/Sell depth pressure from live quote
 *               7. Day change % momentum
 * Stocks:       Groww most-traded (scraped) + base watchlist
 * Feedback:     EOD self-evaluation loop — adjusts factor weights daily
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const cron    = require('node-cron');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════
const GROWW_TOKEN = process.env.GROWW_ACCESS_TOKEN || '';
const PORT        = process.env.PORT || 3001;

if (!GROWW_TOKEN) {
  console.error('❌ GROWW_ACCESS_TOKEN not set in .env — set it and restart');
  process.exit(1);
}

// Groww API headers
const GHDRS = {
  'Authorization':  `Bearer ${GROWW_TOKEN}`,
  'X-API-VERSION':  '1.0',
  'Accept':         'application/json',
  'Content-Type':   'application/json',
};
const GROWW_BASE = 'https://api.groww.in/v1';

// ══════════════════════════════════════════════════════════════
// FEEDBACK LOOP — ADAPTIVE WEIGHT SYSTEM
// ══════════════════════════════════════════════════════════════
//
// Architecture:
//   weights.json  — persisted factor weights (survives restarts)
//   eodHistory[]  — rolling 30-day record of daily outcomes
//   eodToday[]    — today's prediction outcomes (built at 15:30)
//
// Learning algorithm:
//   For each completed trading day:
//     1. Fetch EOD prices for all predicted stocks
//     2. Determine actual outcome: TARGET_HIT / STOP_HIT / PARTIAL / FLAT
//     3. For each prediction, check which factors voted correctly vs wrongly
//     4. Accumulate factor_correct_votes and factor_total_votes over 30 days
//     5. Compute accuracy_rate per factor
//     6. Nudge weights: if accuracy < 50% → shrink weight by DECAY_RATE
//                       if accuracy > 70% → grow weight by GROW_RATE
//     7. Clamp weights within [MIN_W, MAX_W] and re-normalize to sum=100
//     8. Save updated weights to weights.json

const WEIGHTS_FILE = path.join(__dirname, 'weights.json');
const EOD_LOG_FILE = path.join(__dirname, 'eod_history.json');

// Default baseline weights (sum = 100)
const DEFAULT_WEIGHTS = {
  dev10:   35,
  vwap:    20,
  rsi:     15,
  ema:     12,
  candle:  10,
  depth:    8,
  // meta
  version: 1,
  lastUpdated: null,
  totalDaysLearned: 0,
};

const WEIGHT_CONSTRAINTS = {
  dev10:  { min: 15, max: 50 },
  vwap:   { min:  8, max: 30 },
  rsi:    { min:  5, max: 25 },
  ema:    { min:  4, max: 20 },
  candle: { min:  3, max: 18 },
  depth:  { min:  2, max: 15 },
};

const LEARN_RATE  = 0.08;  // ±8% nudge per evaluation cycle
const MIN_SAMPLES = 3;      // need at least 3 predictions to learn from

// Load weights from disk or use defaults
function loadWeights() {
  try {
    if (fs.existsSync(WEIGHTS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8'));
      // Merge with defaults to handle new factors added in future
      return { ...DEFAULT_WEIGHTS, ...raw };
    }
  } catch(e) { console.error('[Weights] Load error:', e.message); }
  return { ...DEFAULT_WEIGHTS };
}

function saveWeights(w) {
  try {
    fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(w, null, 2));
  } catch(e) { console.error('[Weights] Save error:', e.message); }
}

function loadEodHistory() {
  try {
    if (fs.existsSync(EOD_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(EOD_LOG_FILE, 'utf8'));
    }
  } catch(e) { console.error('[EOD] History load error:', e.message); }
  return [];
}

function saveEodHistory(h) {
  try {
    // Keep only last 60 days
    const trimmed = h.slice(-60);
    fs.writeFileSync(EOD_LOG_FILE, JSON.stringify(trimmed, null, 2));
  } catch(e) { console.error('[EOD] History save error:', e.message); }
}

// Live adaptive weights (used by buildPrediction)
let W = loadWeights();
let eodHistory = loadEodHistory();

// Today's raw outcome records (populated at 15:25 before reset)
let eodToday = [];

// ── EOD OUTCOME CAPTURE ──
// Called at 15:25 IST (before the 15:30 reset)
async function captureEodOutcomes() {
  if (!lockedPredictions.length) {
    console.log('[EOD] No predictions to evaluate today');
    return;
  }

  console.log(`\n[EOD] ═══ Evaluating ${lockedPredictions.filter(p=>p.action!=='HOLD').length} active predictions ═══`);

  const syms   = lockedPredictions.filter(p=>p.action!=='HOLD').map(p=>p.symbol);
  const ltpMap = await growwLTP(syms);

  const todayRecords = [];

  for (const pred of lockedPredictions) {
    if (pred.action === 'HOLD') continue;

    const key    = `NSE_${pred.symbol}`;
    const eodLtp = ltpMap[key] || pred.currentPrice || 0;
    if (!eodLtp || !pred.open915Price) continue;

    const actualMove = pred.open915Price > 0
      ? +((eodLtp - pred.open915Price) / pred.open915Price * 100).toFixed(2)
      : 0;

    // Outcome classification
    const isBuy  = pred.action === 'BUY';
    const movedCorrectly = isBuy ? actualMove > 0 : actualMove < 0;
    const hitTarget      = isBuy ? eodLtp >= (pred.targetPrice||Infinity)
                                 : eodLtp <= (pred.targetPrice||0);
    const hitStop        = isBuy ? eodLtp <= (pred.stopLossPrice||0)
                                 : eodLtp >= (pred.stopLossPrice||Infinity);

    let outcome;
    if (hitTarget)             outcome = 'TARGET_HIT';
    else if (hitStop)          outcome = 'STOP_HIT';
    else if (movedCorrectly)   outcome = 'PARTIAL_WIN';
    else                       outcome = 'WRONG';

    // Determine which factors were "active" (voted) for this prediction
    // and whether their vote direction matched the actual outcome
    const factorVotes = {};

    // Factor: dev10 — did 10-min momentum point in the right direction?
    if (Math.abs(pred.dev10 || 0) > 0.3) {
      const f1Correct = isBuy ? pred.dev10 > 0 : pred.dev10 < 0;
      factorVotes.dev10 = movedCorrectly ? (f1Correct ? 1 : 0) : (f1Correct ? 0 : 1);
    }

    // Factor: vwap — did VWAP signal match outcome?
    if (pred.vwap && pred.vwap > 0) {
      const f2Correct = isBuy ? pred.aboveVWAP : !pred.aboveVWAP;
      factorVotes.vwap = movedCorrectly ? (f2Correct ? 1 : 0) : (f2Correct ? 0 : 1);
    }

    // Factor: rsi — did RSI signal match outcome?
    if (pred.rsi && pred.rsi !== 50) {
      const rsiBull = pred.rsi >= 60 && pred.rsi < 75;
      const rsiBear = pred.rsi <= 40 && pred.rsi > 25;
      if (rsiBull || rsiBear) {
        const f3Correct = isBuy ? rsiBull : rsiBear;
        factorVotes.rsi = movedCorrectly ? (f3Correct ? 1 : 0) : (f3Correct ? 0 : 1);
      }
    }

    // Factor: ema — did EMA stack direction match outcome?
    if (pred.emaStack && pred.emaStack !== 'MIXED') {
      const emaBull = pred.emaStack === 'BULL';
      const f4Correct = isBuy ? emaBull : !emaBull;
      factorVotes.ema = movedCorrectly ? (f4Correct ? 1 : 0) : (f4Correct ? 0 : 1);
    }

    // Factor: candle — did prev-day candle pattern match?
    if (pred.candleSignal && pred.candleSignal !== 0) {
      const candleBull = pred.candleSignal > 0;
      const f5Correct  = isBuy ? candleBull : !candleBull;
      factorVotes.candle = movedCorrectly ? (f5Correct ? 1 : 0) : (f5Correct ? 0 : 1);
    }

    // Factor: depth — did buy pressure match?
    if (pred.buyPressure && pred.buyPressure !== 50) {
      const depthBull = pred.buyPressure > 60;
      const depthBear = pred.buyPressure < 40;
      if (depthBull || depthBear) {
        const f6Correct = isBuy ? depthBull : depthBear;
        factorVotes.depth = movedCorrectly ? (f6Correct ? 1 : 0) : (f6Correct ? 0 : 1);
      }
    }

    const record = {
      symbol:       pred.symbol,
      date:         dateStr(0),
      action:       pred.action,
      confidence:   pred.confidence,
      dev10:        pred.dev10,
      open915:      pred.open915Price,
      targetPrice:  pred.targetPrice,
      stopPrice:    pred.stopLossPrice,
      eodPrice:     +eodLtp.toFixed(2),
      actualMove:   actualMove,
      targetPct:    pred.targetPct,
      outcome,
      movedCorrectly,
      hitTarget,
      hitStop,
      factorVotes,
      // snapshot of weights used today
      weightsUsed: { dev10: W.dev10, vwap: W.vwap, rsi: W.rsi, ema: W.ema, candle: W.candle, depth: W.depth },
    };

    todayRecords.push(record);

    const icon = hitTarget?'✅':hitStop?'⛔':movedCorrectly?'📊':'❌';
    console.log(`  ${icon} ${pred.symbol.padEnd(14)} ${pred.action} | predicted ${pred.targetPct>0?'+':''}${pred.targetPct}% | actual ${actualMove>0?'+':''}${actualMove}% | ${outcome}`);
  }

  eodToday = todayRecords;
  eodHistory.push({ date: dateStr(0), records: todayRecords, weightsBefore: { ...W } });
  saveEodHistory(eodHistory);

  // Now run the learning step
  await runLearningStep();
}

// ── LEARNING STEP ──
// Aggregates factor accuracy over last 30 days and nudges weights
async function runLearningStep() {
  // Flatten all records from last 30 days
  const recentDays  = eodHistory.slice(-30);
  const allRecords  = recentDays.flatMap(d => d.records || []);
  const activeRecs  = allRecords.filter(r => r.action !== 'HOLD');

  if (activeRecs.length < MIN_SAMPLES) {
    console.log(`[Learn] Not enough samples yet (${activeRecs.length}/${MIN_SAMPLES}) — skipping weight adjustment`);
    return;
  }

  console.log(`\n[Learn] ═══ Running learning step on ${activeRecs.length} records (${recentDays.length} days) ═══`);

  // Aggregate accuracy per factor
  const factorStats = {};
  const factors = ['dev10', 'vwap', 'rsi', 'ema', 'candle', 'depth'];

  for (const f of factors) {
    factorStats[f] = { correct: 0, total: 0, accuracy: 0.5 };
  }

  for (const rec of activeRecs) {
    for (const f of factors) {
      if (rec.factorVotes && rec.factorVotes[f] !== undefined) {
        factorStats[f].total++;
        factorStats[f].correct += rec.factorVotes[f];
      }
    }
  }

  // Compute accuracy rates
  for (const f of factors) {
    if (factorStats[f].total > 0) {
      factorStats[f].accuracy = +(factorStats[f].correct / factorStats[f].total).toFixed(3);
    }
  }

  // Overall accuracy (% predictions that moved correctly)
  const overallCorrect = activeRecs.filter(r => r.movedCorrectly).length;
  const overallAcc     = +(overallCorrect / activeRecs.length).toFixed(3);
  const targetHitRate  = +(activeRecs.filter(r=>r.hitTarget).length / activeRecs.length).toFixed(3);

  console.log(`[Learn] Overall accuracy: ${(overallAcc*100).toFixed(1)}% | Target hit rate: ${(targetHitRate*100).toFixed(1)}%`);

  // Print factor stats
  for (const f of factors) {
    const s = factorStats[f];
    const icon = s.accuracy >= 0.7 ? '⬆️' : s.accuracy <= 0.5 ? '⬇️' : '➡️';
    console.log(`  ${icon}  ${f.padEnd(8)} acc:${(s.accuracy*100).toFixed(1)}% (${s.correct}/${s.total}) | weight: ${W[f]} → ?`);
  }

  // Adjust weights based on accuracy
  const oldWeights = { ...W };
  let changed = false;

  for (const f of factors) {
    const s   = factorStats[f];
    if (s.total < MIN_SAMPLES) continue; // not enough data for this factor

    const constraint = WEIGHT_CONSTRAINTS[f];
    let newWeight    = W[f];

    if (s.accuracy > 0.70) {
      // Factor is reliable — grow its weight
      newWeight = W[f] * (1 + LEARN_RATE);
    } else if (s.accuracy < 0.50) {
      // Factor is hurting accuracy — shrink it
      newWeight = W[f] * (1 - LEARN_RATE);
    } else if (s.accuracy < 0.55) {
      // Slight underperformance — small shrink
      newWeight = W[f] * (1 - LEARN_RATE * 0.4);
    }
    // 0.55-0.70 zone → no change

    // Clamp to constraints
    newWeight = Math.max(constraint.min, Math.min(constraint.max, newWeight));
    newWeight = +newWeight.toFixed(2);

    if (newWeight !== W[f]) {
      changed = true;
      W[f] = newWeight;
    }
  }

  if (changed) {
    // Re-normalize weights so they still sum to 100
    const rawSum = factors.reduce((s, f) => s + W[f], 0);
    const scale  = 100 / rawSum;
    for (const f of factors) {
      W[f] = +(W[f] * scale).toFixed(2);
      // Re-clamp after normalization (scaling can push outside bounds)
      const c = WEIGHT_CONSTRAINTS[f];
      W[f] = Math.max(c.min, Math.min(c.max, W[f]));
    }

    W.lastUpdated     = new Date().toISOString();
    W.totalDaysLearned = (W.totalDaysLearned || 0) + 1;
    W.version         = (W.version || 1) + 1;

    // Log changes
    for (const f of factors) {
      const delta = +(W[f] - oldWeights[f]).toFixed(2);
      if (Math.abs(delta) >= 0.1) {
        const icon = delta > 0 ? '⬆️' : '⬇️';
        console.log(`  ${icon}  ${f.padEnd(8)} ${oldWeights[f].toFixed(2)} → ${W[f].toFixed(2)} (${delta>0?'+':''}${delta})`);
      }
    }

    saveWeights(W);
    console.log(`[Learn] ✅ Weights updated (v${W.version}) and saved to weights.json`);
  } else {
    console.log('[Learn] ➡️  Weights unchanged — all factors within acceptable accuracy range');
  }

  // Tag the history entry with post-learning weights
  if (eodHistory.length > 0) {
    eodHistory[eodHistory.length-1].weightsAfter = { ...W };
    eodHistory[eodHistory.length-1].factorStats  = factorStats;
    eodHistory[eodHistory.length-1].overallAcc   = overallAcc;
    eodHistory[eodHistory.length-1].targetHitRate = targetHitRate;
    saveEodHistory(eodHistory);
  }
}

// ── HELPER: compute factor stats across all stored history ──
function computeFeedbackSummary() {
  const recentDays = eodHistory.slice(-30);
  const allRecs    = recentDays.flatMap(d => d.records || []).filter(r => r.action !== 'HOLD');
  const factors    = ['dev10', 'vwap', 'rsi', 'ema', 'candle', 'depth'];

  const factorStats = {};
  for (const f of factors) factorStats[f] = { correct: 0, total: 0, accuracy: null };

  for (const rec of allRecs) {
    for (const f of factors) {
      if (rec.factorVotes?.[f] !== undefined) {
        factorStats[f].total++;
        factorStats[f].correct += rec.factorVotes[f];
      }
    }
  }
  for (const f of factors) {
    const s = factorStats[f];
    s.accuracy = s.total > 0 ? +(s.correct/s.total*100).toFixed(1) : null;
  }

  const totalPreds   = allRecs.length;
  const correct      = allRecs.filter(r=>r.movedCorrectly).length;
  const targetHits   = allRecs.filter(r=>r.hitTarget).length;
  const stopHits     = allRecs.filter(r=>r.hitStop).length;
  const partialWins  = allRecs.filter(r=>r.outcome==='PARTIAL_WIN').length;
  const wrongs       = allRecs.filter(r=>r.outcome==='WRONG').length;

  // Per-day accuracy series for chart
  const dailySeries = recentDays.map(d => {
    const recs = (d.records||[]).filter(r=>r.action!=='HOLD');
    const acc  = recs.length > 0 ? +(recs.filter(r=>r.movedCorrectly).length/recs.length*100).toFixed(1) : null;
    return { date: d.date, accuracy: acc, total: recs.length,
             targetHits: recs.filter(r=>r.hitTarget).length };
  }).filter(d => d.total > 0);

  return {
    totalPredictions: totalPreds,
    correct, targetHits, stopHits, partialWins, wrongs,
    overallAccuracy:    totalPreds > 0 ? +(correct/totalPreds*100).toFixed(1) : null,
    targetHitRate:      totalPreds > 0 ? +(targetHits/totalPreds*100).toFixed(1) : null,
    factorStats,
    currentWeights: { dev10:W.dev10, vwap:W.vwap, rsi:W.rsi, ema:W.ema, candle:W.candle, depth:W.depth },
    defaultWeights: { dev10:DEFAULT_WEIGHTS.dev10, vwap:DEFAULT_WEIGHTS.vwap, rsi:DEFAULT_WEIGHTS.rsi,
                      ema:DEFAULT_WEIGHTS.ema, candle:DEFAULT_WEIGHTS.candle, depth:DEFAULT_WEIGHTS.depth },
    weightsVersion:   W.version,
    daysLearned:      W.totalDaysLearned || 0,
    lastUpdated:      W.lastUpdated,
    dailySeries,
    todayRecords:     eodToday,
  };
}

// Watchlist — Groww most-traded (NSE CASH)
const BASE_STOCKS = [
  'RELIANCE','TCS','INFY','HDFCBANK','ICICIBANK',
  'SBIN','WIPRO','BAJFINANCE','TATAMOTORS','ETERNAL',
  'HCLTECH','TECHM','MAZDOCK','RVNL','IDFCFIRSTB',
  'ADANIENT','HINDCOPPER','NATCOPHARM','MOREPENLAB','IRFC',
  'AXISBANK','KOTAKBANK','LT','MARUTI','SUNPHARMA',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════
// TIME HELPERS
// ══════════════════════════════════════════════════════════════
function getIST() {
  const ist = new Date(Date.now() + 5.5 * 3600000);
  const h = ist.getUTCHours(), m = ist.getUTCMinutes(), s = ist.getUTCSeconds();
  const totalMins = h * 60 + m;
  const day = ist.getUTCDay();
  return { h, m, s, totalMins, day, ist };
}
function isWeekday() { const {day} = getIST(); return day >= 1 && day <= 5; }
function marketPhase() {
  const { totalMins, day } = getIST();
  if (day<1||day>5)        return 'WEEKEND';
  if (totalMins<9*60)      return 'PRE_OPEN';
  if (totalMins<9*60+15)   return 'PRE_MARKET';
  if (totalMins<9*60+25)   return 'OPENING';
  if (totalMins<11*60)     return 'EARLY';
  if (totalMins<13*60)     return 'MID';
  if (totalMins<15*60)     return 'LATE';
  if (totalMins<15*60+15)  return 'MIS_EXIT';
  if (totalMins<15*60+30)  return 'CLOSING';
  return 'CLOSED';
}
function isOpen() {
  return ['OPENING','EARLY','MID','LATE','MIS_EXIT'].includes(marketPhase());
}
function istStr() {
  const {h,m} = getIST();
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} IST`;
}
function dateStr(d=0) {
  // Returns yyyy-mm-dd offset by d days
  const dt = new Date(Date.now() + 5.5*3600000 + d*86400000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
}

// ══════════════════════════════════════════════════════════════
// GROWW API WRAPPERS
// ══════════════════════════════════════════════════════════════

// Live quote for one symbol (full depth + OHLC)
async function growwQuote(symbol) {
  try {
    const r = await axios.get(`${GROWW_BASE}/live-data/quote`, {
      params: { exchange:'NSE', segment:'CASH', trading_symbol:symbol },
      headers: GHDRS, timeout: 8000,
    });
    if (r.data?.status !== 'SUCCESS') return null;
    return r.data.payload;
  } catch(e) {
    console.error(`[Quote] ${symbol}: ${e.message?.slice(0,40)}`);
    return null;
  }
}

// Batch LTP for up to 50 symbols at once
async function growwLTP(symbols) {
  if (!symbols.length) return {};
  const exchangeSymbols = symbols.map(s=>`NSE_${s}`).join(',');
  try {
    const r = await axios.get(`${GROWW_BASE}/live-data/ltp`, {
      params: { segment:'CASH', exchange_symbols:exchangeSymbols },
      headers: GHDRS, timeout: 8000,
    });
    if (r.data?.status !== 'SUCCESS') return {};
    return r.data.payload || {};
  } catch(e) {
    console.error(`[LTP] batch: ${e.message?.slice(0,40)}`);
    return {};
  }
}

// Batch OHLC for up to 50 symbols at once
async function growwOHLC(symbols) {
  if (!symbols.length) return {};
  const exchangeSymbols = symbols.map(s=>`NSE_${s}`).join(',');
  try {
    const r = await axios.get(`${GROWW_BASE}/live-data/ohlc`, {
      params: { segment:'CASH', exchange_symbols:exchangeSymbols },
      headers: GHDRS, timeout: 8000,
    });
    if (r.data?.status !== 'SUCCESS') return {};
    return r.data.payload || {};
  } catch(e) {
    console.error(`[OHLC] batch: ${e.message?.slice(0,40)}`);
    return {};
  }
}

// Historical candles (interval_in_minutes: 1,5,10,60,1440)
async function growwCandles(symbol, intervalMins, startTime, endTime) {
  try {
    const r = await axios.get(`${GROWW_BASE}/historical/candle/range`, {
      params: {
        exchange:'NSE', segment:'CASH',
        trading_symbol:symbol,
        start_time: startTime,
        end_time:   endTime,
        interval_in_minutes: intervalMins,
      },
      headers: GHDRS, timeout: 12000,
    });
    if (r.data?.status !== 'SUCCESS') return [];
    // Each candle: [timestamp, open, high, low, close, volume]
    return r.data.payload?.candles || [];
  } catch(e) {
    console.error(`[Candles] ${symbol} ${intervalMins}m: ${e.message?.slice(0,40)}`);
    return [];
  }
}

// Fetch last N days of daily candles
async function fetchDailyHistory(symbol, days=10) {
  const end   = dateStr(0) + ' 15:30:00';
  const start = dateStr(-days) + ' 09:15:00';
  return growwCandles(symbol, 1440, start, end);
}

// Fetch today's 5-min candles
async function fetchToday5min(symbol) {
  const today = dateStr(0);
  return growwCandles(symbol, 5, `${today} 09:15:00`, `${today} 15:30:00`);
}

// Fetch today's 1-min candles
async function fetchToday1min(symbol) {
  const today = dateStr(0);
  return growwCandles(symbol, 1, `${today} 09:15:00`, `${today} 15:30:00`);
}

// ══════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS
// ══════════════════════════════════════════════════════════════
function calcEMA(closes, p) {
  if (!closes || closes.length < p) return null;
  const k = 2 / (p + 1);
  let v = closes.slice(0, p).reduce((s,x) => s+x, 0) / p;
  for (let i = p; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
  return +v.toFixed(2);
}

function calcRSI(closes, p=14) {
  if (!closes || closes.length < p+1) return 50;
  let g=0, l=0;
  for (let i=1; i<=p; i++) {
    const d = closes[i]-closes[i-1];
    if (d>0) g+=d; else l-=d;
  }
  let ag=g/p, al=l/p;
  for (let i=p+1; i<closes.length; i++) {
    const d = closes[i]-closes[i-1];
    ag=(ag*(p-1)+Math.max(0,d))/p;
    al=(al*(p-1)+Math.max(0,-d))/p;
  }
  return al===0 ? 100 : +(100-100/(1+ag/al)).toFixed(1);
}

function calcVWAP(candles) {
  // candle = [ts, open, high, low, close, volume]
  let pv=0, vol=0;
  for (const c of candles) {
    const tp = (c[2]+c[3]+c[4])/3; // (high+low+close)/3
    pv += tp * c[5]; vol += c[5];
  }
  return vol>0 ? +(pv/vol).toFixed(2) : 0;
}

function calcATR(dailyCandles, p=14) {
  // dailyCandles: [ts, open, high, low, close, vol]
  if (dailyCandles.length < p+1) return 0;
  const trs = dailyCandles.slice(1).map((c,i)=>Math.max(
    c[2]-c[3],
    Math.abs(c[2]-dailyCandles[i][4]),
    Math.abs(c[3]-dailyCandles[i][4])
  ));
  return +(trs.slice(-p).reduce((s,v)=>s+v,0)/p).toFixed(2);
}

function pivotPoints(high, low, close) {
  const pp = (high+low+close)/3;
  return {
    pp: +pp.toFixed(2),
    r1: +(2*pp-low).toFixed(2),  r2: +(pp+high-low).toFixed(2),
    s1: +(2*pp-high).toFixed(2), s2: +(pp-high+low).toFixed(2),
  };
}

// ══════════════════════════════════════════════════════════════
// RUNTIME STATE
// ══════════════════════════════════════════════════════════════

// Opening snapshots — the WORKING engine from v4
const openingSnaps = {};  // { SYM: { t915, t925, open } }
let snapshotStatus  = 'waiting';

// Locked predictions (set at 9:25, updated with live prices)
let lockedPredictions = [];

// Historical cache
const histCache = {};     // { SYM: { daily:[], m5:[], m1:[] } }
const liveQuotes= {};     // { SYM: full quote payload }

let dataStore = {
  quotes: {}, news: [], lastUpdated: null,
};
let mtfStocks = [];
const companyNames = {};

// ══════════════════════════════════════════════════════════════
// GROWW MOST-TRADED SCRAPE
// ══════════════════════════════════════════════════════════════
async function fetchGrowwMostTraded() {
  try {
    const r = await axios.get('https://groww.in/v1/api/stocks_data/v1/web/header/volume_shakers?size=20', {
      timeout:10000,
      headers:{
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':'application/json','Accept-Language':'en-IN,en;q=0.9',
        'Origin':'https://groww.in','Referer':'https://groww.in/',
      },
    });
    const items = r.data?.items || r.data?.data || [];
    const stocks = [];
    for (const item of items) {
      const sym = item.nseScriptCode || item.bseScriptCode || item.symbol;
      if (!sym) continue;
      if (item.companyShortName) companyNames[sym] = item.companyShortName;
      else if (item.companyName) companyNames[sym] = item.companyName;
      stocks.push({ symbol:sym, companyName:companyNames[sym]||sym,
        slug:item.slug||sym.toLowerCase(), haircut:item.haircut||0 });
    }
    return stocks;
  } catch(e) {
    console.error('[MTF]', e.message?.slice(0,50));
    return [];
  }
}

function getAllSymbols() {
  const mtfSyms = mtfStocks.map(s=>s.symbol);
  return [...new Set([...mtfSyms, ...BASE_STOCKS])].slice(0,40);
}

function growwUrl(sym) {
  const mtf = mtfStocks.find(s=>s.symbol===sym);
  const slug = mtf?.slug || sym.toLowerCase();
  return `https://groww.in/stocks/${slug}`;
}

// ══════════════════════════════════════════════════════════════
// HISTORICAL DATA FETCH (pre-market prep)
// ══════════════════════════════════════════════════════════════
async function loadHistoryForSym(sym) {
  const [daily, m5] = await Promise.all([
    fetchDailyHistory(sym, 30),
    isOpen() ? fetchToday5min(sym) : Promise.resolve([]),
  ]);
  histCache[sym] = { daily, m5, loadedAt: Date.now() };
  return histCache[sym];
}

async function loadAllHistory() {
  const syms = getAllSymbols();
  console.log(`[Hist] Loading history for ${syms.length} stocks...`);
  for (let i=0; i<syms.length; i+=3) {
    await Promise.all(syms.slice(i,i+3).map(loadHistoryForSym));
    await sleep(400);
  }
  console.log('[Hist] ✅ Done');
}

// ══════════════════════════════════════════════════════════════
// LIVE QUOTES — batch fetch all symbols
// ══════════════════════════════════════════════════════════════
async function fetchAllLiveData() {
  const syms = getAllSymbols();
  const quotes = {};

  // Batch LTP (50 at a time)
  for (let i=0; i<syms.length; i+=50) {
    const batch  = syms.slice(i,i+50);
    const ltpMap = await growwLTP(batch);
    for (const sym of batch) {
      const key = `NSE_${sym}`;
      if (ltpMap[key]) quotes[sym] = { symbol:sym, ltp: ltpMap[key] };
    }
    if (i+50 < syms.length) await sleep(300);
  }

  // Batch OHLC (50 at a time)
  for (let i=0; i<syms.length; i+=50) {
    const batch   = syms.slice(i,i+50);
    const ohlcMap = await growwOHLC(batch);
    for (const sym of batch) {
      const key = `NSE_${sym}`;
      if (ohlcMap[key]) {
        const o = ohlcMap[key];
        quotes[sym] = {
          ...quotes[sym], symbol:sym,
          open:o.open, high:o.high, low:o.low, prevClose:o.close,
          ltp: quotes[sym]?.ltp || o.close,
        };
      }
    }
    if (i+50 < syms.length) await sleep(300);
  }

  // Compute derived values
  for (const [sym, q] of Object.entries(quotes)) {
    const ltp  = q.ltp || 0;
    const open = q.open || ltp;
    const prev = q.prevClose || ltp;
    q.change    = +(ltp - prev).toFixed(2);
    q.changePct = prev>0 ? +((ltp-prev)/prev*100).toFixed(2) : 0;
    q.devOpen   = open>0 ? +((ltp-open)/open*100).toFixed(2) : 0;
    q.growwUrl  = growwUrl(sym);
    q.name      = companyNames[sym] || sym;
  }

  return quotes;
}

// Full quote for a single symbol (includes market depth for pressure)
async function fetchFullQuote(sym) {
  const q = await growwQuote(sym);
  if (!q) return null;
  liveQuotes[sym] = q;
  return q;
}

// ══════════════════════════════════════════════════════════════
// ★★★ AI PREDICTION ENGINE ★★★
// Multi-factor analysis using Groww historical + live data
// ══════════════════════════════════════════════════════════════

function buildPrediction(sym, snap, liveQ, histData) {
  const { t915, t925, open } = snap;
  const daily = histData?.daily || [];
  const m5    = histData?.m5    || [];

  // ── FACTOR 1: Opening 10-min momentum (THE CORE, from v4) ──
  const dev10  = t915>0 ? +((t925-t915)/t915*100).toFixed(2) : 0;
  const devDay = open>0 && liveQ ? +((liveQ.ltp-open)/open*100).toFixed(2) : dev10;

  // ── FACTOR 2: 5-min VWAP ──
  const vwap = m5.length ? calcVWAP(m5) : 0;
  const ltp  = liveQ?.ltp || t925;
  const vwapDev = vwap>0 ? +((ltp-vwap)/vwap*100).toFixed(2) : 0;
  const aboveVWAP = ltp > vwap;

  // ── FACTOR 3: RSI from 5-min closes ──
  const m5closes = m5.map(c=>c[4]);
  const rsi5m = m5closes.length >= 15 ? calcRSI(m5closes) : 50;

  // ── FACTOR 4: EMA stack from daily closes ──
  const dayCloses = daily.map(c=>c[4]);
  const ema9   = calcEMA(dayCloses, 9);
  const ema21  = calcEMA(dayCloses, 21);
  const ema50  = calcEMA(dayCloses, 50);
  const emaStack = ema9&&ema21&&ema50 ? (ema9>ema21&&ema21>ema50?'BULL':ema9<ema21&&ema21<ema50?'BEAR':'MIXED') : 'MIXED';

  // ── FACTOR 5: Prev day candle pattern ──
  const prevDayCandle = daily.length>=2 ? daily[daily.length-2] : null;
  let candleSignal = 0; // positive=bullish, negative=bearish
  if (prevDayCandle) {
    const [,po,ph,pl,pc] = prevDayCandle;
    const range = ph-pl, body=Math.abs(pc-po);
    const isBull = pc>po;
    const closePos = range>0?(pc-pl)/range:0.5;
    const bodyRatio= range>0?body/range:0;
    if (isBull && bodyRatio>0.6 && closePos>0.65)      candleSignal=+2;
    else if (!isBull && bodyRatio>0.6 && closePos<0.35) candleSignal=-2;
    else if (isBull)                                     candleSignal=+1;
    else                                                 candleSignal=-1;
  }

  // ── FACTOR 6: Buy/Sell depth pressure (from full quote) ──
  let buyPressure = 50; // default 50%
  if (liveQ?.total_buy_quantity && liveQ?.total_sell_quantity) {
    const total = liveQ.total_buy_quantity + liveQ.total_sell_quantity;
    buyPressure = total>0 ? Math.round(liveQ.total_buy_quantity/total*100) : 50;
  }
  const depthSignal = buyPressure>60?1:buyPressure<40?-1:0;

  // ── FACTOR 7: ATR volatility ──
  const atr = calcATR(daily);

  // ── FACTOR 8: Pivot points (from previous day) ──
  let pivots = null;
  if (prevDayCandle) {
    pivots = pivotPoints(prevDayCandle[2], prevDayCandle[3], prevDayCandle[4]);
  }

  // ── COMPOSITE SCORING — uses adaptive weights from W (feedback loop) ──
  let bullScore = 0, bearScore = 0;
  const reasons = [];

  // Factor 1: Dev10 (adaptive weight: W.dev10, baseline 35)
  const wD = W.dev10;
  if (dev10 > 2.0)        { bullScore += wD;          reasons.push(`📈 Strong open +${dev10}% in 10 min [w${wD.toFixed(0)}]`); }
  else if (dev10 > 1.0)   { bullScore += wD*0.63;     reasons.push(`📈 Bullish open +${dev10}% [w${wD.toFixed(0)}]`); }
  else if (dev10 > 0.3)   { bullScore += wD*0.34;     reasons.push(`📈 Mild open +${dev10}% [w${wD.toFixed(0)}]`); }
  else if (dev10 < -2.0)  { bearScore += wD;          reasons.push(`📉 Strong drop ${dev10}% at open [w${wD.toFixed(0)}]`); }
  else if (dev10 < -1.0)  { bearScore += wD*0.63;     reasons.push(`📉 Bearish open ${dev10}% [w${wD.toFixed(0)}]`); }
  else if (dev10 < -0.3)  { bearScore += wD*0.34;     reasons.push(`📉 Mild drop ${dev10}% [w${wD.toFixed(0)}]`); }
  else                     { reasons.push(`⚖️ Flat open (${dev10}%)`); }

  // Factor 2: VWAP (adaptive weight: W.vwap, baseline 20)
  const wV = W.vwap;
  if (aboveVWAP && vwap>0)       { bullScore += wV; reasons.push(`✅ Above VWAP ₹${vwap} (+${vwapDev.toFixed(2)}%) [w${wV.toFixed(0)}]`); }
  else if (!aboveVWAP && vwap>0) { bearScore += wV; reasons.push(`🔴 Below VWAP ₹${vwap} (${vwapDev.toFixed(2)}%) [w${wV.toFixed(0)}]`); }

  // Factor 3: RSI (adaptive weight: W.rsi, baseline 15)
  const wR = W.rsi;
  if (rsi5m >= 60 && rsi5m < 75)      { bullScore += wR;       reasons.push(`✅ RSI ${rsi5m} — bullish momentum [w${wR.toFixed(0)}]`); }
  else if (rsi5m <= 40 && rsi5m > 25) { bearScore += wR;       reasons.push(`🔴 RSI ${rsi5m} — bearish momentum [w${wR.toFixed(0)}]`); }
  else if (rsi5m >= 75)               { bearScore += wR*0.53;  reasons.push(`⚠️ RSI ${rsi5m} overbought [w${wR.toFixed(0)}]`); }
  else if (rsi5m <= 25)               { bullScore += wR*0.53;  reasons.push(`⚠️ RSI ${rsi5m} oversold — bounce [w${wR.toFixed(0)}]`); }
  else                                { reasons.push(`RSI ${rsi5m} neutral`); }

  // Factor 4: EMA stack (adaptive weight: W.ema, baseline 12)
  const wE = W.ema;
  if (emaStack==='BULL')        { bullScore += wE; reasons.push(`✅ EMA9>EMA21>EMA50 bull stack [w${wE.toFixed(0)}]`); }
  else if (emaStack==='BEAR')   { bearScore += wE; reasons.push(`🔴 EMA9<EMA21<EMA50 bear stack [w${wE.toFixed(0)}]`); }

  // Factor 5: Candle pattern (adaptive weight: W.candle, baseline 10)
  const wC = W.candle;
  if (candleSignal >= 2)        { bullScore += wC;       reasons.push(`✅ Strong bull candle yesterday [w${wC.toFixed(0)}]`); }
  else if (candleSignal === 1)  { bullScore += wC*0.5;   reasons.push(`📈 Bullish candle yesterday [w${wC.toFixed(0)}]`); }
  else if (candleSignal <= -2)  { bearScore += wC;       reasons.push(`🔴 Strong bear candle yesterday [w${wC.toFixed(0)}]`); }
  else if (candleSignal === -1) { bearScore += wC*0.5;   reasons.push(`📉 Bearish candle yesterday [w${wC.toFixed(0)}]`); }

  // Factor 6: Depth pressure (adaptive weight: W.depth, baseline 8)
  const wDp = W.depth;
  if (depthSignal === 1)        { bullScore += wDp; reasons.push(`✅ ${buyPressure}% buy pressure in depth [w${wDp.toFixed(0)}]`); }
  else if (depthSignal === -1)  { bearScore += wDp; reasons.push(`🔴 ${100-buyPressure}% sell pressure in depth [w${wDp.toFixed(0)}]`); }

  // ── ACTION & CONFIDENCE ──
  const total = bullScore + bearScore;
  const bullPct = total>0 ? bullScore/total : 0.5;
  const confidence = Math.min(90, Math.round(Math.abs(bullPct-0.5)*200));
  let action = 'HOLD';
  if (bullScore > bearScore + 15 && bullPct > 0.55)  action = 'BUY';
  if (bearScore > bullScore + 15 && bullPct < 0.45)  action = 'SELL';

  // ── TARGETS & STOP LOSS (from core v4 formula + pivot refinement) ──
  const absMove = Math.abs(dev10);
  const targetMultiplier = absMove<0.5?1.2:absMove<1?1.4:absMove<1.5?1.6:absMove<2?1.8:absMove<3?2.2:2.5;
  const stopMultiplier   = absMove<0.5?0.3:absMove<1?0.5:absMove<2?0.7:absMove<3?1.0:1.5;

  let targetPct   = action==='BUY'  ?  +(dev10*targetMultiplier).toFixed(2)
                  : action==='SELL' ? -(absMove*targetMultiplier).toFixed(2) : 0;
  let stopPct     = action==='BUY'  ? -stopMultiplier : action==='SELL' ? stopMultiplier : 0;

  // Override with pivot levels if available
  if (pivots && action === 'BUY' && pivots.r1 > t915) {
    const pivotTarget = +((pivots.r1-t915)/t915*100).toFixed(2);
    if (pivotTarget > 0) targetPct = Math.max(targetPct, pivotTarget*0.8); // blend
    stopPct = Math.min(stopPct, -+((t915-pivots.s1)/t915*100).toFixed(2));
  } else if (pivots && action === 'SELL' && pivots.s1 < t915) {
    const pivotTarget = +((t915-pivots.s1)/t915*100).toFixed(2);
    if (pivotTarget > 0) targetPct = Math.min(targetPct, -pivotTarget*0.8);
  }

  const targetPrice   = action!=='HOLD' ? +(t915*(1+targetPct/100)).toFixed(2) : 0;
  const stopLossPrice = action!=='HOLD' ? +(t915*(1+stopPct/100)).toFixed(2) : 0;
  const rr = stopPct!==0 ? +(Math.abs(targetPct)/Math.abs(stopPct)).toFixed(1) : 0;

  // ── FULL DAY PREDICTION TEXT ──
  const name = companyNames[sym] || sym;
  let prediction;
  if (action === 'BUY') {
    prediction = `📈 ${name} EXPECTED TO RISE ~${targetPct.toFixed(1)}% today. ` +
      `Open ₹${t915} → Target ₹${targetPrice} (+${targetPct}%) | Stop ₹${stopLossPrice}. R:R=${rr}:1. ` +
      (rsi5m>50?`RSI ${rsi5m}. `:'') + (aboveVWAP?'Above VWAP. ':'') +
      `Based on +${dev10}% in first 10 min (${emaStack} EMA).`;
  } else if (action === 'SELL') {
    prediction = `📉 ${name} EXPECTED TO FALL ~${Math.abs(targetPct).toFixed(1)}% today. ` +
      `Open ₹${t915} → Target ₹${targetPrice} (${targetPct}%) | Stop ₹${stopLossPrice}. R:R=${rr}:1. ` +
      (rsi5m<50?`RSI ${rsi5m}. `:'') + (!aboveVWAP?'Below VWAP. ':'') +
      `Based on ${dev10}% in first 10 min (${emaStack} EMA).`;
  } else {
    prediction = `⚖️ ${name} — no clear direction. Open ${dev10>=0?'+':''}${dev10}% | RSI ${rsi5m} | ${emaStack} EMA. Wait for 10:00 AM confirmation.`;
  }

  const gUrl = growwUrl(sym);

  return {
    symbol:sym, name, action, confidence,
    prediction, bullScore, bearScore, buyPressure,
    // Prices
    open915Price: t915, lockedAtPrice: t925,
    currentPrice: ltp, targetPrice, stopLossPrice,
    targetPct: +targetPct.toFixed(2), stopPct: +stopPct.toFixed(2),
    riskReward: rr,
    // Deviation
    dev10, devDay, devFromOpen: devDay,
    // Indicators
    rsi: rsi5m, vwap, vwapDev, aboveVWAP,
    ema9, ema21, ema50, emaStack, atr,
    pivots, candleSignal,
    // Depth
    totalBuyQty:  liveQ?.total_buy_quantity  || 0,
    totalSellQty: liveQ?.total_sell_quantity || 0,
    reasons: reasons.slice(0,5),
    // Status (live updated)
    currentStatus: 'LOCKED 🔒',
    progressPct: 0,
    // Groww MIS links
    growwUrl: gUrl,
    growwBuyUrl:  `${gUrl}?action=buy`,
    growwSellUrl: `${gUrl}?action=sell`,
    lockedAt: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════
// SNAPSHOT CAPTURE (v4 exact timing)
// ══════════════════════════════════════════════════════════════
async function capture915Snapshot() {
  console.log('\n[9:15] 📸 Capturing opening prices...');
  const syms = getAllSymbols();

  // Use batch OHLC for speed
  const ohlcMap = await growwOHLC(syms);
  const ltpMap  = await growwLTP(syms);

  for (const sym of syms) {
    const ohlcKey = `NSE_${sym}`;
    const ohlc    = ohlcMap[ohlcKey];
    const ltp     = ltpMap[ohlcKey] || 0;
    if (ohlc) {
      openingSnaps[sym] = {
        t915: ltp || ohlc.open || ohlc.close,
        open: ohlc.open,
      };
    }
  }
  snapshotStatus = 't915_done';
  console.log(`[9:15] ✅ Captured ${Object.keys(openingSnaps).length} opening prices`);
}

async function capture925AndLock() {
  console.log('\n[9:25] 📸 Capturing 10-min prices + generating predictions...');
  const syms = getAllSymbols();
  const ltpMap = await growwLTP(syms);

  for (const sym of syms) {
    const key = `NSE_${sym}`;
    const ltp = ltpMap[key];
    if (ltp && openingSnaps[sym]) {
      openingSnaps[sym].t925 = ltp;
    } else if (!openingSnaps[sym] && ltp) {
      // Server started late — use current price for both
      openingSnaps[sym] = { t915: ltp, t925: ltp, open: ltp };
    }
  }

  // Fetch full quotes for top stocks (for depth analysis)
  const top15 = syms.slice(0,15);
  for (const sym of top15) {
    await fetchFullQuote(sym);
    await sleep(100);
  }

  // Also load 5-min candles for indicators
  for (let i=0; i<top15.length; i+=3) {
    const batch = top15.slice(i,i+3);
    await Promise.all(batch.map(async s => {
      if (!histCache[s]) histCache[s] = {};
      histCache[s].m5 = await fetchToday5min(s);
    }));
    await sleep(300);
  }

  // Build predictions for all symbols with snapshots
  lockedPredictions = Object.entries(openingSnaps)
    .filter(([,snap]) => snap.t915>0)
    .map(([sym, snap]) => {
      const liveQ = liveQuotes[sym] || null;
      const hist  = histCache[sym]  || {};
      return buildPrediction(sym, snap, liveQ, hist);
    })
    .filter(Boolean);

  snapshotStatus = 'locked';
  const buy  = lockedPredictions.filter(p=>p.action==='BUY').length;
  const sell = lockedPredictions.filter(p=>p.action==='SELL').length;
  console.log(`\n[9:25] ✅ ${lockedPredictions.length} predictions locked | ${buy} BUY | ${sell} SELL`);
  lockedPredictions.filter(p=>p.action!=='HOLD').forEach(p =>
    console.log(`  ${p.action} ${p.symbol.padEnd(14)} conf:${p.confidence}% | dev10:${p.dev10}% | ${p.reasons[0]||''}`)
  );
}

// ══════════════════════════════════════════════════════════════
// LIVE PRICE UPDATE (every 3 min after lock)
// ══════════════════════════════════════════════════════════════
async function updateLivePrices() {
  if (!lockedPredictions.length) return;
  const syms   = lockedPredictions.map(p=>p.symbol);
  const ltpMap = await growwLTP(syms);

  lockedPredictions = lockedPredictions.map(p => {
    const key = `NSE_${p.symbol}`;
    const ltp = ltpMap[key] || p.currentPrice;
    if (!ltp) return p;

    const currentDev = p.open915Price>0
      ? +((ltp-p.open915Price)/p.open915Price*100).toFixed(2)
      : p.devFromOpen;

    const progressPct = p.targetPct!==0
      ? Math.min(100, Math.max(0, Math.round(Math.abs(currentDev)/Math.abs(p.targetPct)*100)))
      : 0;

    const isBuy = p.action==='BUY';
    let currentStatus;
    if (p.action==='HOLD') { currentStatus='WATCHING 👁️'; }
    else if (isBuy) {
      if (p.targetPrice && ltp>=p.targetPrice)           currentStatus='TARGET HIT ✅';
      else if (p.stopLossPrice && ltp<=p.stopLossPrice)  currentStatus='STOP HIT ⛔';
      else if (currentDev<-0.5)                          currentStatus='PULLBACK ⚠️';
      else if (progressPct>=80)                          currentStatus='NEAR TARGET 🎯';
      else                                               currentStatus='ON TRACK 📈';
    } else {
      if (p.targetPrice && ltp<=p.targetPrice)           currentStatus='TARGET HIT ✅';
      else if (p.stopLossPrice && ltp>=p.stopLossPrice)  currentStatus='STOP HIT ⛔';
      else if (currentDev>0.5)                           currentStatus='BOUNCE ⚠️';
      else if (progressPct>=80)                          currentStatus='NEAR TARGET 🎯';
      else                                               currentStatus='ON TRACK 📉';
    }

    const remaining = isBuy
      ? +(p.targetPct-currentDev).toFixed(2)
      : +(currentDev-p.targetPct).toFixed(2);

    // Rebuild live prediction text
    let prediction = p.prediction;
    if (p.action!=='HOLD') {
      const dir = isBuy?'📈 RISE':'📉 FALL';
      prediction = `${dir} ~${Math.abs(p.targetPct).toFixed(1)}% today. `+
        `Open ₹${p.open915Price} → Target ₹${p.targetPrice} | Stop ₹${p.stopLossPrice}. R:R=${p.riskReward}:1. `+
        (remaining>0?`~${remaining.toFixed(1)}% ${isBuy?'more to go':'more to fall'}. `:'TARGET ZONE! ')+
        `[Live ₹${ltp.toFixed(1)} | ${currentDev>=0?'+':''}${currentDev.toFixed(2)}% from open]`;
    }

    return { ...p, currentPrice:+ltp.toFixed(2), devFromOpen:currentDev, progressPct, currentStatus, prediction };
  });
}

// Fallback when server started late
function generateFallbackFromLive(quotes) {
  console.log('[Fallback] Building predictions from current open prices...');
  const preds = [];
  for (const [sym, q] of Object.entries(quotes)) {
    const open = q.open || q.ltp;
    const ltp  = q.ltp || open;
    if (!open || !ltp) continue;
    openingSnaps[sym] = { t915:open, t925:ltp, open };
    const hist = histCache[sym] || {};
    const pred = buildPrediction(sym, { t915:open, t925:ltp, open }, null, hist);
    if (pred) preds.push(pred);
  }
  lockedPredictions = preds;
  snapshotStatus    = 'fallback';
  console.log(`[Fallback] ${preds.filter(p=>p.action!=='HOLD').length} active predictions`);
}

// ══════════════════════════════════════════════════════════════
// MAIN LOOP
// ══════════════════════════════════════════════════════════════
async function mainRefresh() {
  console.log(`\n[Bot] ─── ${istStr()} | ${marketPhase()} ───`);
  try {
    const quotes = await fetchAllLiveData();
    dataStore.quotes     = quotes;
    dataStore.lastUpdated = new Date().toISOString();

    const { totalMins, day } = getIST();
    const pastOpen = day>=1&&day<=5&&totalMins>=9*60+25&&totalMins<15*60+30;

    // Late start — generate from current open
    if (pastOpen && !lockedPredictions.length) {
      generateFallbackFromLive(quotes);
    }

    // Update live prices in locked predictions
    if (lockedPredictions.length) {
      await updateLivePrices();
    }

    const active = lockedPredictions.filter(p=>p.action!=='HOLD');
    console.log(`[Bot] ✅ quotes:${Object.keys(quotes).length} | preds:${active.length} | status:${snapshotStatus}`);
  } catch(e) {
    console.error('[Bot] Refresh error:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════
// API ENDPOINTS
// ══════════════════════════════════════════════════════════════
app.get('/api/status', (_, res) => {
  const ph = marketPhase();
  const { h, m } = getIST();
  const pad = n => String(n).padStart(2,'0');
  res.json({
    phase: ph, isOpen: isOpen(),
    istTime: `${pad(h)}:${pad(m)} IST`,
    snapshotStatus,
    activePredictions: lockedPredictions.filter(p=>p.action!=='HOLD').length,
    totalPredictions:  lockedPredictions.length,
    watchlist:         getAllSymbols().length,
    mtfStocks:         mtfStocks.length,
    lastUpdated:       dataStore.lastUpdated,
  });
});

app.get('/api/quotes', (_, res) => res.json({ quotes:dataStore.quotes, lastUpdated:dataStore.lastUpdated }));

// ★ MAIN PREDICTION ENDPOINT
app.get('/api/mtf/live', (req, res) => {
  const { action, limit=50 } = req.query;
  let preds = [...lockedPredictions];

  if (action) preds = preds.filter(p=>p.action===action.toUpperCase());

  // Sort: active signals first, then by |dev10| desc, then by confidence desc
  preds.sort((a,b) => {
    const r={BUY:0,SELL:1,HOLD:2};
    if (r[a.action]!==r[b.action]) return r[a.action]-r[b.action];
    return Math.abs(b.dev10)-Math.abs(a.dev10)||b.confidence-a.confidence;
  });
  preds = preds.slice(0, parseInt(limit));

  res.json({
    predictions: preds,
    summary: {
      total:       preds.length,
      buy:         preds.filter(p=>p.action==='BUY').length,
      sell:        preds.filter(p=>p.action==='SELL').length,
      hold:        preds.filter(p=>p.action==='HOLD').length,
      targetsHit:  preds.filter(p=>p.currentStatus?.includes('TARGET HIT')).length,
      onTrack:     preds.filter(p=>p.currentStatus?.includes('ON TRACK')).length,
    },
    snapshotStatus, phase: marketPhase(),
    updatedAt: new Date().toISOString(),
  });
});

app.get('/api/mtf/predictions', (req,res) =>
  res.redirect(`/api/mtf/live${req.query.action?'?action='+req.query.action:''}`)
);

// Full analysis for one stock
app.get('/api/analyze/:sym', async (req,res) => {
  const sym   = req.params.sym.toUpperCase();
  const quote = await growwQuote(sym);
  if (!histCache[sym]) await loadHistoryForSym(sym);
  const hist  = histCache[sym] || {};
  const snap  = openingSnaps[sym] || { t915:quote?.last_price||0, t925:quote?.last_price||0 };
  const pred  = buildPrediction(sym, snap, quote, hist);
  res.json({ symbol:sym, quote, prediction:pred, indicators:{
    rsi:pred?.rsi, vwap:pred?.vwap, ema9:pred?.ema9, ema21:pred?.ema21, pivots:pred?.pivots,
  }});
});

// Historical candles endpoint (for frontend chart)
app.get('/api/candles/:sym', async (req,res) => {
  const sym = req.params.sym.toUpperCase();
  const tf  = parseInt(req.query.interval||'5');
  const days= parseInt(req.query.days||'1');
  const end  = dateStr(0)  + ' 15:30:00';
  const start= dateStr(-days) + ' 09:15:00';
  const candles = await growwCandles(sym, tf, start, end);
  res.json({ symbol:sym, interval:tf, candles });
});

// Debug
app.get('/api/debug', (_,res) => res.json({
  snapshotStatus, phase:marketPhase(),
  snapshots: Object.fromEntries(
    Object.entries(openingSnaps).slice(0,10).map(([k,v])=>[k,{t915:v.t915,t925:v.t925}])
  ),
  activePredictions: lockedPredictions.filter(p=>p.action!=='HOLD').length,
}));

app.post('/api/refresh', async(_,res) => {
  await mainRefresh();
  res.json({ success:true, predictions:lockedPredictions.filter(p=>p.action!=='HOLD').length });
});
app.post('/api/reset', (_,res) => {
  Object.keys(openingSnaps).forEach(k=>delete openingSnaps[k]);
  lockedPredictions = [];
  snapshotStatus    = 'waiting';
  res.json({ success:true });
});
app.post('/api/load-history', async(_,res) => {
  await loadAllHistory();
  res.json({ success:true, symbols:Object.keys(histCache).length });
});

// ── FEEDBACK LOOP API ──
// Full feedback summary (weights, accuracy, factor stats, daily series)
app.get('/api/feedback', (_,res) => res.json(computeFeedbackSummary()));

// Today's EOD records (available after 15:25 capture)
app.get('/api/feedback/today', (_,res) => res.json({ date: dateStr(0), records: eodToday }));

// Full raw history (last 60 days)
app.get('/api/feedback/history', (_,res) => res.json(eodHistory.slice(-30)));

// Current weights
app.get('/api/feedback/weights', (_,res) => res.json({
  current: { dev10:W.dev10, vwap:W.vwap, rsi:W.rsi, ema:W.ema, candle:W.candle, depth:W.depth },
  defaults: { dev10:DEFAULT_WEIGHTS.dev10, vwap:DEFAULT_WEIGHTS.vwap, rsi:DEFAULT_WEIGHTS.rsi,
               ema:DEFAULT_WEIGHTS.ema, candle:DEFAULT_WEIGHTS.candle, depth:DEFAULT_WEIGHTS.depth },
  version: W.version, daysLearned: W.totalDaysLearned, lastUpdated: W.lastUpdated,
}));

// Manual trigger — run EOD capture + learning now (for testing / manual invocation)
app.post('/api/feedback/run-eod', async(_,res) => {
  await captureEodOutcomes();
  res.json({ success:true, summary: computeFeedbackSummary() });
});

// Reset weights to defaults
app.post('/api/feedback/reset-weights', (_,res) => {
  W = { ...DEFAULT_WEIGHTS };
  saveWeights(W);
  res.json({ success:true, weights: W });
});

// ══════════════════════════════════════════════════════════════
// CRON JOBS
// ══════════════════════════════════════════════════════════════
// Pre-market history load at 8:30 IST = 3:00 UTC
cron.schedule('0 3 * * 1-5', async() => {
  console.log('[Cron] 8:30 IST — pre-market history load');
  await loadAllHistory();
}, { timezone:'UTC' });

// 9:15 IST = 3:45 UTC — capture opening prices
cron.schedule('45 3 * * 1-5', async() => {
  console.log('[Cron] 9:15 IST — capturing opening snapshot');
  await capture915Snapshot();
}, { timezone:'UTC' });

// 9:25 IST = 3:55 UTC — lock predictions
cron.schedule('55 3 * * 1-5', async() => {
  console.log('[Cron] 9:25 IST — locking predictions');
  await capture925AndLock();
}, { timezone:'UTC' });

// Every 3 min during market hours
cron.schedule('*/3 3-10 * * 1-5', mainRefresh, { timezone:'UTC' });

// 15:25 IST = 09:55 UTC — capture EOD outcomes + run learning step (BEFORE reset)
cron.schedule('55 9 * * 1-5', async() => {
  console.log('[Cron] 15:25 IST — EOD outcome capture + learning step');
  await captureEodOutcomes();
}, { timezone:'UTC' });

// Reset at 16:00 IST = 10:30 UTC
cron.schedule('30 10 * * 1-5', () => {
  Object.keys(openingSnaps).forEach(k=>delete openingSnaps[k]);
  lockedPredictions=[];
  snapshotStatus='waiting';
  console.log('[Cron] Reset for next day');
}, { timezone:'UTC' });

// ══════════════════════════════════════════════════════════════
// STARTUP
// ══════════════════════════════════════════════════════════════
async function init() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  ⚡ TradeBot v15 — Groww Trade API Edition               ║
║  http://localhost:${PORT}                                    ║
╠══════════════════════════════════════════════════════════╣
║  Data:     Groww API (official, real OHLC + historical)  ║
║  Engine:   9:15 vs 9:25 momentum + 7 technical factors   ║
║  Targets:  Pivot-adjusted, R:R based stop loss           ║
║  Links:    Groww MIS direct buy/sell                     ║
╚══════════════════════════════════════════════════════════╝`);

  // Load MTF stocks
  console.log('[Init] Loading Groww most-traded...');
  mtfStocks = await fetchGrowwMostTraded();
  console.log(`[Init] ${mtfStocks.length} MTF stocks, ${getAllSymbols().length} total watchlist`);

  // Load history
  await loadAllHistory();

  // Check if market is currently open
  const { totalMins, day } = getIST();
  const phase = marketPhase();
  console.log(`[Init] Phase: ${phase}`);

  if (day>=1&&day<=5&&totalMins>=9*60+25&&totalMins<15*60+30) {
    // Market is open past 9:25 — run full refresh + fallback
    console.log('[Init] Market open past 9:25 — running immediate refresh + fallback predictions');
    await mainRefresh();
  } else {
    await mainRefresh();
  }

  console.log(`\n[Ready] ✅ ${istStr()} | ${phase} | ${lockedPredictions.filter(p=>p.action!=='HOLD').length} active predictions`);
}

app.listen(PORT, init);