// SwingAI Bot 24/7 — Cloudflare Worker — REVOLUT X VERSION
// Multi-TF DAY TRADING (1H+15min+5min), NB+GBM+QL, SMC, PATTERNS, Kelly, ATR-TP/SL, CORR, OBI
// Market data: Kraken public API (Gate.io/Binance/Bybit blokuja CF Workers) | Execution: Revolut X (Ed25519)

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// KONFIGURACJA
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Kraken public API — nie blokuje CF Workers
// Pary Kraken: XBTUSDT, ETHUSDT itd. | Handel Revolut X: BTC/USDC — mapowanie w revxInstrument()
// Day trading: mniej par niz w wersji swingowej, bo skan jest 3x czestszy (co 3
// min zamiast 10) - trzyma budzet zapytan/dzien i limit KV w bezpiecznych granicach
// mimo wiekszej czestotliwosci. Najbardziej plynne pary, najlepsze dla intraday.
const PAIRS = ['XBTUSDT','ETHUSDT','SOLUSDT'];
const FEE   = 0.002;
const TIMEOUT_MS = 8 * 3600000; // 8h - day trading: pozycja zamykana w ramach jednej sesji, nie tygodniami jak w swingu

const CORR_GROUPS = [
  ['XBTUSDT'],
  ['ETHUSDT'],
  ['SOLUSDT','AVAXUSDT'],
  ['XRPUSDT','ADAUSDT'],
  ['DOGEUSDT'],
  ['LINKUSDT']
];

const PAIR_PARAMS_DEFAULT = {
  'XBTUSDT':  { tp:0.10, sl:0.04, minScore:62 },
  'ETHUSDT':  { tp:0.12, sl:0.05, minScore:60 },
  'SOLUSDT':  { tp:0.14, sl:0.06, minScore:58 },
  'XRPUSDT':  { tp:0.15, sl:0.06, minScore:58 },
  'DOGEUSDT': { tp:0.18, sl:0.07, minScore:60 },
  'ADAUSDT':  { tp:0.14, sl:0.06, minScore:58 },
  'AVAXUSDT': { tp:0.14, sl:0.06, minScore:58 },
  'LINKUSDT': { tp:0.14, sl:0.06, minScore:58 }
};

// Revolut X base URL
const REVX_BASE = 'https://revx.revolut.com/api/1.0';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GŁÓWNY HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBotCycle(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders() });

    // AUTENTYKACJA
    const AUTH_SECRET = env.AUTH_SECRET || 'swingai-revolut-2024';
    const authHeader  = request.headers.get('Authorization') || '';
    const authParam   = url.searchParams.get('auth') || '';
    const isAuth = authHeader === 'Bearer ' + AUTH_SECRET || authParam === AUTH_SECRET;
    const publicPaths = ['/', '/state-public', '/market'];
    if (!isAuth && !publicPaths.includes(url.pathname)) {
      return new Response('Unauthorized', { status: 401, headers: corsHeaders() });
    }

    // Dashboard
    if (url.pathname === '/') {
      return new Response(
        '<meta http-equiv="refresh" content="0;url=https://tomekfalek-cyber.github.io/swingai-revolut/">',
        { headers: { 'Content-Type': 'text/html', ...corsHeaders() } }
      );
    }

    // State public — dla GitHub Pages dashboard
    if (url.pathname === '/state-public') {
      const cfg   = await getConfig(env);
      const state = await getState(env);
      const pub = {
        active:       cfg.active || false,
        mode:         cfg.mode || 'paper',
        exchange:     'Revolut X',
        paperBalance: state.paperBalance || 0,
        liveBalance:  state.liveBalance || null,
        dailyPnl:     state.dailyPnl || 0,
        positions:    state.positions || [],
        trades:       (state.trades || []).slice(0, 50),
        lastSigs:     state.lastSigs || [],
        lastCycle:    state.lastCycle || null,
        iter:         state.iter || 0,
        lastFG:       state.lastFG || null,
        log:          (state.log || []).slice(0, 30),
        stats:        state.stats || null,
        ensembleW:    state.ensembleW || null,
        peakBalance:  state.peakBalance || 0,
        drawdownBlock: (state.drawdownBlock || 0) > Date.now(),
        gbmAccuracyOOS: (state.gbm && state.gbm.accuracyOOS) || null
      };
      return jsonResp(pub);
    }

    if (url.pathname === '/start-paper') {
      const cfg = defaultConfig();
      cfg.active = true; cfg.mode = 'paper'; cfg.startedAt = Date.now();
      await env.SWINGAI_REVOLUT_KV.put('config', JSON.stringify(cfg));
      await env.SWINGAI_REVOLUT_KV.put('state',  JSON.stringify(defaultState()));
      ctx.waitUntil(runBotCycle(env));
      return new Response(redirectHTML('Bot PAPER uruchomiony!'), { headers: {'Content-Type':'text/html;charset=utf-8'} });
    }

    if (url.pathname === '/start-live') {
      const p = url.searchParams;
      const cfg = defaultConfig();
      cfg.active = true; cfg.mode = 'live'; cfg.startedAt = Date.now();
      cfg.revxApiKey  = p.get('key')   || '';
      cfg.revxPrivKey = p.get('priv')  || '';
      cfg.tp    = parseFloat(p.get('tp')   || '12') / 100;
      cfg.sl    = parseFloat(p.get('sl')   || '5')  / 100;
      cfg.trail = parseFloat(p.get('trail')|| '6')  / 100;
      cfg.minScore = parseInt(p.get('score')|| '58');
      cfg.maxPos   = parseInt(p.get('maxp') || '4');
      cfg.posSize  = parseFloat(p.get('size')|| '15');
      cfg.tgToken  = p.get('tg')   || '';
      cfg.tgChat   = p.get('tgc')  || '';
      // Jeśli klucze puste - zachowaj z poprzedniej konfiguracji
      const oldCfg = await getConfig(env);
      if (!cfg.revxApiKey  && oldCfg.revxApiKey)  cfg.revxApiKey  = oldCfg.revxApiKey;
      if (!cfg.revxPrivKey && oldCfg.revxPrivKey) cfg.revxPrivKey = oldCfg.revxPrivKey;
      if (!cfg.tgToken && oldCfg.tgToken)         cfg.tgToken     = oldCfg.tgToken;
      if (!cfg.tgChat  && oldCfg.tgChat)          cfg.tgChat      = oldCfg.tgChat;
      await env.SWINGAI_REVOLUT_KV.put('config', JSON.stringify(cfg));
      // Reset stanu ale zachowaj modele AI
      const oldState = await getState(env);
      const freshState = defaultState();
      freshState.nb  = oldState.nb  || null;
      freshState.gbm = oldState.gbm || null;
      freshState.ql  = oldState.ql  || null;
      // peakBalanceMode fix: reset peak when switching to live
      freshState.peakBalance = 0;
      freshState.peakBalanceMode = 'live';
      await env.SWINGAI_REVOLUT_KV.put('state', JSON.stringify(freshState));
      ctx.waitUntil(runBotCycle(env));
      return new Response(redirectHTML('Bot LIVE (Revolut X) uruchomiony!'), { headers: {'Content-Type':'text/html;charset=utf-8'} });
    }

    if (url.pathname === '/save-config') {
      const p = url.searchParams;
      const cfg = await getConfig(env);
      // Bez tego przelacznik trybu w ustawieniach na dashboardzie nic nie robil -
      // ta sama luka co byla w swingai-bot/MEXC przed dzisiejsza poprawka.
      if (p.get('mode') === 'paper' || p.get('mode') === 'live') cfg.mode = p.get('mode');
      if (p.get('key'))   cfg.revxApiKey  = p.get('key');
      if (p.get('priv'))  cfg.revxPrivKey = p.get('priv');
      if (p.get('tg'))    cfg.tgToken     = p.get('tg');
      if (p.get('tgc'))   cfg.tgChat      = p.get('tgc');
      if (p.get('tp'))    cfg.tp       = parseFloat(p.get('tp'))    / 100;
      if (p.get('sl'))    cfg.sl       = parseFloat(p.get('sl'))    / 100;
      if (p.get('trail')) cfg.trail    = parseFloat(p.get('trail')) / 100;
      if (p.get('score')) cfg.minScore = parseInt(p.get('score'));
      if (p.get('maxp'))  cfg.maxPos   = parseInt(p.get('maxp'));
      if (p.get('size'))  cfg.posSize  = parseFloat(p.get('size'));
      await env.SWINGAI_REVOLUT_KV.put('config', JSON.stringify(cfg));
      return new Response(redirectHTML('Konfiguracja zapisana!'), { headers: {'Content-Type':'text/html;charset=utf-8'} });
    }

    if (url.pathname === '/stop') {
      const cfg = await getConfig(env);
      cfg.active = false;
      await env.SWINGAI_REVOLUT_KV.put('config', JSON.stringify(cfg));
      return new Response(redirectHTML('Bot zatrzymany'), { headers: {'Content-Type':'text/html;charset=utf-8'} });
    }

    if (url.pathname === '/run') {
      const cfg = await getConfig(env);
      if (!cfg.active)
        return new Response(redirectHTML('Bot nieaktywny — uruchom najpierw'), { headers: {'Content-Type':'text/html;charset=utf-8'} });
      ctx.waitUntil(runBotCycle(env));
      return new Response(redirectHTML('Skan uruchomiony! Wróć za 30 sekund...'), { headers: {'Content-Type':'text/html;charset=utf-8'} });
    }

    if (url.pathname === '/status') {
      const cfg   = await getConfig(env);
      const state = await getState(env);
      const safeCfg = { ...cfg, revxApiKey: cfg.revxApiKey ? '***' : '', revxPrivKey: cfg.revxPrivKey ? '***' : '', tgToken: cfg.tgToken ? '***' : '' };
      return jsonResp({ config: safeCfg, state });
    }

    if (url.pathname === '/balance') {
      const cfg = await getConfig(env);
      if (cfg.mode !== 'live' || !cfg.revxApiKey || !cfg.revxPrivKey) {
        return jsonResp({ balance: null, mode: cfg.mode });
      }
      try {
        const fresh = await revxGetBalance(cfg);
        return jsonResp({ balance: fresh, mode: 'live' });
      } catch(e) {
        return jsonResp({ balance: null, mode: 'live', error: e.message });
      }
    }

    if (url.pathname === '/tg-send') {
      if (!isAuth) return new Response('Unauthorized', { status: 401, headers: corsHeaders() });
      const cfg = await getConfig(env);
      if (!cfg.tgToken || !cfg.tgChat) return jsonResp({ ok: false, error: 'Brak tokenu Telegram' });
      let msg = '';
      try { const body = await request.json(); msg = body.text || ''; } catch(e) { msg = url.searchParams.get('text') || ''; }
      if (!msg) return jsonResp({ ok: false, error: 'Brak treści wiadomości' });
      try {
        const tgR = await fetchWithTimeout('https://api.telegram.org/bot' + cfg.tgToken + '/sendMessage', 8000, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: cfg.tgChat, text: msg, parse_mode: 'HTML' })
        });
        const tgD = await tgR.json();
        return jsonResp({ ok: tgD.ok, result: tgD });
      } catch(e) { return jsonResp({ ok: false, error: e.message }); }
    }

    if (url.pathname === '/tg-test') {
      const cfg = await getConfig(env);
      const payload = { chat_id: cfg.tgChat, text: 'SwingAI Revolut X — test', parse_mode: 'HTML' };
      const tgUrl = 'https://api.telegram.org/bot' + cfg.tgToken + '/sendMessage';
      let tgResult;
      try {
        const r = await fetchWithTimeout(tgUrl, 8000, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        tgResult = await r.json();
      } catch(e) { tgResult = { fetchError: e.message }; }
      return jsonResp({ tokenPrefix: (cfg.tgToken||'').slice(0,12)+'...', chat_id: cfg.tgChat, tgResult });
    }

    if (url.pathname === '/send-welcome') {
      const cfg = await getConfig(env);
      if (!cfg.tgToken || !cfg.tgChat) {
        return jsonResp({ ok: false, error: 'Brak tokenu Telegram w konfiguracji' });
      }
      try {
        const tgResp = await fetchWithTimeout('https://api.telegram.org/bot' + cfg.tgToken + '/sendMessage', 8000,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: cfg.tgChat,
              text: 'Witaj! SwingAI Bot 24/7 — Revolut X aktywny.\n\nPolaczenie dziala.\nPary: BTC ETH SOL XRP DOGE ADA AVAX LINK\nSkany co 1h przez Cloudflare Worker.',
              parse_mode: 'HTML'
            })
          }
        );
        const tgJson = await tgResp.json();
        return jsonResp({ ok: tgJson.ok, tg: tgJson });
      } catch(e) {
        return jsonResp({ ok: false, error: e.message });
      }
    }


    // Proxy Kraken — publiczny endpoint dla dashboard
    if (url.pathname === '/market') {
      const path = url.searchParams.get('path') || '';
      const qs   = url.searchParams.get('qs')   || '';
      if (path.includes('..') || qs.includes('..')) {
        return new Response('Forbidden', { status: 403, headers: corsHeaders() });
      }
      const allowed = ['/0/public/OHLC', '/0/public/Ticker', '/0/public/Depth'];
      if (!allowed.includes(path.split('?')[0])) {
        return new Response('Forbidden', { status: 403, headers: corsHeaders() });
      }
      try {
        const krakenUrl = 'https://api.kraken.com' + path + (qs ? '?' + qs : '');
        const r = await fetchWithTimeout(krakenUrl, 8000, { headers: { 'User-Agent': 'SwingAI/1.0' } });
        const body = await r.text();
        return new Response(body, { status: r.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
      }
    }

    // Fallback
    return new Response('SwingAI Revolut X Worker — OK', { headers: corsHeaders() });
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GŁÓWNA LOGIKA CYKLU
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function runBotCycle(env) {
  const cfg   = await getConfig(env);
  if (!cfg.active) return;
  const state = await getState(env);

  // Mutex — zapobiega równoległemu uruchomieniu dwóch cykli.
  // UWAGA: TTL musi być bezpiecznie dłuższy niż realistyczny NAJGORSZY (ale wciąż
  // normalny, nie zawieszony) czas 1 cyklu. Przy 8 parach x kilka interwałów klines
  // x timeout + sleep(700ms) między parami + podpisywanie Ed25519 dla Revolut X,
  // cykl w wolnych warunkach sieciowych może zająć kilka minut. Zbyt krótki TTL
  // (poprzednio 120s) mógł zwalniać blokadę zanim poprzedni cykl faktycznie się
  // skończył, pozwalając na nakładanie się cykli — dokładnie problem, któremu ta
  // blokada ma zapobiegać.
  const lockKey = 'bot_running_lock';
  const lockVal = await env.SWINGAI_REVOLUT_KV.get(lockKey);
  if (lockVal) {
    console.log('Bot already running, skipping cycle');
    return;
  }
  await env.SWINGAI_REVOLUT_KV.put(lockKey, '1', { expirationTtl: 480 }); // TTL 8 min auto-release
  try {

  state.iter  = (state.iter || 0) + 1;
  addLog(state, '--- Skan #' + state.iter + ' ---');

  // Daily reset
  const todayUTC = new Date().toISOString().slice(0, 10);
  if (state.dailyDate !== todayUTC) {
    state.dailyDate         = todayUTC;
    state.dailyPnl          = 0;
    state.dailyStartBalance = 0;
  }

  // Drawdown Circuit Breaker
  const currentBalance = cfg.mode === 'live'
    ? (state.liveBalance > 0 ? state.liveBalance : (cfg.paperBalance || 1000))
    : (state.paperBalance > 0 ? state.paperBalance : (cfg.paperBalance || 1000));

  // peakBalanceMode fix: nie myl paper-peak z live-peak po przełączeniu trybu
  if (state.peakBalanceMode && state.peakBalanceMode !== cfg.mode) {
    state.peakBalance = 0;
    state.peakBalanceMode = cfg.mode;
  }
  if (!state.peakBalance || state.peakBalance < currentBalance) {
    state.peakBalance = currentBalance;
    state.peakBalanceMode = cfg.mode;
  }

  const drawdown = state.peakBalance > 0 ? (state.peakBalance - currentBalance) / state.peakBalance : 0;
  const drawdownBlocked = (state.drawdownBlock || 0) > Date.now();
  if (drawdown > 0.15 && !drawdownBlocked) {
    // Day trading: 6h zamiast 24h (swing) - wciaz znaczaca pauza po powaznym
    // drawdown, ale nie blokujaca praktycznie calego nastepnego dnia handlowego.
    state.drawdownBlock = Date.now() + 6 * 3600000;
    addLog(state, 'Circuit breaker: -15% drawdown — blokada BUY 6h', 'err');
  }

  // Załaduj modele AI
  const nb  = makeNB(state.nb);
  const gbm = makeGBM(state.gbm);
  const ql  = makeQL(state.ql);
  const ew  = state.ensembleW || { score:1, nb:0.8, gbm:0.9, obi:0.3, ql:0.5 };
  const pairParams = state.pairParams || {};
  const adaptiveMinScore = state.adaptiveMinScore || cfg.minScore;

  try {
    // 1. Fear & Greed
    const fg = await getFearGreed(state);

    // 2. BTC Guard
    const btcDrop = await btcDropGuard();
    if (btcDrop) addLog(state, 'BTC Guard aktywny — brak nowych long na altcoinach', 'warn');

    // 3. Sprawdź otwarte pozycje
    await checkPositions(cfg, state, env, ql);

    // 4. Skanuj pary
    const sigs = [];
    for (const sym of PAIRS) {
      try {
        const s = await analyzeSwing(sym, cfg, state, nb, gbm, ql, ew, pairParams, adaptiveMinScore);
        sigs.push(s);
      } catch(e) {
        addLog(state, sym + ': ' + e.message, 'warn');
      }
      await sleep(700);
    }
    sigs.sort((a, b) => b.finalProb - a.finalProb);
    state.lastSigs = sigs.map(s => ({
      sym: s.sym, score: s.score, finalProb: s.finalProb,
      price: s.price, rsiD: s.rsiD, rsi4h: s.rsi4h,
      trend: s.trendD >= 1 ? 'UP' : s.trendD === 0 ? 'FLAT' : 'DN',
      buy: s.buy, why: s.why,
      patterns: (s.patterns||[]).map(p => p.name),
      aiMethod: s.aiMethod, regime: s.regime || 'neutral',
      macdHist: s.macdHist, bbPos: s.bbPos,
      volR: s.volR, vol4R: s.vol4R, mom5: s.mom5, mom10: s.mom10
    }));

    // 5. Otwórz pozycje
    const dailyBase = state.dailyStartBalance > 0 ? state.dailyStartBalance : (cfg.paperBalance || 1000);
    const dailyLossOk = (state.dailyPnl || 0) > -0.05 * dailyBase;

    if (fg.val < 15) {
      addLog(state, 'F&G=' + fg.val + ' (ekstremalna panika) — blokada BUY', 'warn');
    } else if (!dailyLossOk) {
      addLog(state, 'Dzienny limit strat przekroczony (-5% od $' + dailyBase.toFixed(0) + ')', 'err');
    } else if ((state.drawdownBlock || 0) > Date.now()) {
      addLog(state, 'Circuit breaker aktywny — brak nowych pozycji', 'warn');
    } else {
      for (const sig of sigs) {
        if ((state.positions || []).length >= cfg.maxPos) break;
        if (sig.buy) {
          await openTrade(sig, fg, btcDrop, cfg, state, env, nb, gbm, ql, ew);
        }
      }
    }

    // 6. Walk-forward retraining
    const trades = state.trades || [];
    nb.trainFromTrades(trades);

    const lastRefit = state.lastGbmRefit || 0;
    const tradesSinceRefit = trades.filter(t => {
      const tsN = typeof t.ts === 'string' ? new Date(t.ts).getTime() : (t.ts||0);
      return tsN > lastRefit;
    }).length;
    if ((tradesSinceRefit >= 50 && trades.length >= 20) || (!gbm.trained && trades.length >= 20)) {
      gbm.trainFromTrades(trades.slice(0, 200)); // FIX 7: slice(0,200) = najnowsze (trades posortowane od najnowszego)
      state.lastGbmRefit = Date.now();
      addLog(state, 'GBM walk-forward refit: ' + Math.min(trades.length,200) + ' tradów, OOS=' + gbm.accuracyOOS + '%', 'ok');
    }

    // Ensemble rebalancing co 20 tradów
    if (trades.length >= 20 && trades.length % 20 === 0) {
      const ewUpd = rebalanceEnsemble(ew, nb, gbm, trades.slice(0, 20));
      if (ewUpd) {
        Object.assign(ew, ewUpd);
        addLog(state, 'Ensemble rebalanced: nb=' + ew.nb.toFixed(2) + ' gbm=' + ew.gbm.toFixed(2), 'ok');
      }
    }

    state.nb  = nb.save();
    state.gbm = gbm.save();
    state.ql  = ql.save();
    state.ensembleW = ew;
    state.pairParams = pairParams;
    state.adaptiveMinScore = computeAdaptiveMinScore(trades, cfg.minScore);

    // Pobierz realne saldo z Revolut X
    if (cfg.mode === 'live' && cfg.revxApiKey && cfg.revxPrivKey) {
      try {
        state.liveBalance = await revxGetBalance(cfg);
      } catch(e) { /* zachowaj poprzednią wartość */ }
    }

    state.lastCycle = Date.now();
    addLog(state, 'Skan #' + state.iter + ' OK | poz: ' + (state.positions||[]).length + '/' + cfg.maxPos + ' | F&G:' + fg.val, 'ok');

  } catch(e) {
    addLog(state, 'BLAD CYKLU: ' + e.message, 'err');
  }

  await env.SWINGAI_REVOLUT_KV.put('state', JSON.stringify(state));

  } finally {
    await env.SWINGAI_REVOLUT_KV.delete(lockKey);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ANALIZA TECHNICZNA — MULTI-TF
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function calcVWAP(highs, lows, closes, volumes) {
  const n = Math.min(50, highs.length);
  let tpVol = 0, vol = 0;
  for (let i = highs.length - n; i < highs.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    tpVol += tp * volumes[i];
    vol   += volumes[i];
  }
  return vol > 0 ? tpVol / vol : closes.at(-1);
}

// ─────────────────────────────────────────────────────────────────────
// SMART MONEY CONCEPTS (SMC) — day trading
// Mechaniczna, kodowalna interpretacja koncepcji SMC. To NIE jest gwarancja
// takiej skutecznosci jak u doswiadczonego tradera SMC - to precyzyjne,
// powtarzalne reguly inspirowane tymi koncepcjami, nie ich pelne odwzorowanie
// (prawdziwa analiza SMC czesto zaklada uznaniowa interpretacje kontekstu).
// ─────────────────────────────────────────────────────────────────────

// Order Block: ostatnia swieca przeciwna do kierunku przed silnym ruchem
// impulsywnym. Bullish OB = ostatnia swieca spadkowa przed mocnym ruchem w
// gore; dziala jako strefa popytu (wsparcia) przy powrocie ceny.
function detectOrderBlocks(o, h, l, c, atrVal) {
  const blocks = [];
  const n = c.length;
  for (let i = 2; i < n - 1; i++) {
    const bodyImpulse = Math.abs(c[i+1] - o[i+1]);
    const isImpulseUp   = c[i+1] > o[i+1] && bodyImpulse > atrVal * 1.5;
    const isImpulseDown = c[i+1] < o[i+1] && bodyImpulse > atrVal * 1.5;
    const isDownCandle  = c[i] < o[i];
    const isUpCandle    = c[i] > o[i];
    if (isImpulseUp && isDownCandle) {
      blocks.push({ type:'bullish', top:h[i], bottom:l[i], idx:i });
    }
    if (isImpulseDown && isUpCandle) {
      blocks.push({ type:'bearish', top:h[i], bottom:l[i], idx:i });
    }
  }
  return blocks.slice(-6); // ostatnie 6 - najbardziej aktualne strefy
}

// Fair Value Gap (imbalance): luka miedzy swieca 1 a swieca 3 (pomijajac 2),
// ktorej rynek "nie zdazyl wycenic" - obszar czesto ponownie odwiedzany.
function detectFVG(h, l, c) {
  const gaps = [];
  const n = c.length;
  for (let i = 2; i < n; i++) {
    if (h[i-2] < l[i]) { // bullish FVG - luka w gore
      gaps.push({ type:'bullish', top:l[i], bottom:h[i-2], idx:i });
    }
    if (l[i-2] > h[i]) { // bearish FVG - luka w dol
      gaps.push({ type:'bearish', top:l[i-2], bottom:h[i], idx:i });
    }
  }
  return gaps.slice(-6);
}

// Liquidity sweep (stop hunt): cena robi knot ponizej niedawnego dolka
// (zbiera zlecenia stop-loss/liquidity), po czym szybko wraca powyzej -
// klasyczny bycz sygnal odwrocenia SMC. Analogicznie dla gornego knota.
function detectLiquiditySweep(h, l, c, lookback=20) {
  const n = c.length;
  if (n < lookback + 3) return null;
  const recentLow  = Math.min(...l.slice(-lookback-3, -3));
  const recentHigh = Math.max(...h.slice(-lookback-3, -3));
  const lastLow    = l[n-1], lastHigh = h[n-1], lastClose = c[n-1];
  if (lastLow < recentLow && lastClose > recentLow) {
    return { type:'bullish', sweptLevel: recentLow };
  }
  if (lastHigh > recentHigh && lastClose < recentHigh) {
    return { type:'bearish', sweptLevel: recentHigh };
  }
  return null;
}

// Break of Structure (BOS, kontynuacja trendu) / Change of Character (CHoCH,
// mozliwe odwrocenie) - na podstawie ostatnich pivotow swing high/low.
function detectStructure(h, l, c, lookback=30) {
  const n = c.length;
  if (n < lookback) return { trend:'range', event:null };
  const highs=[], lows=[];
  for (let i = n-lookback+2; i < n-2; i++) {
    if (h[i]>h[i-1]&&h[i]>h[i-2]&&h[i]>h[i+1]&&h[i]>h[i+2]) highs.push({v:h[i], idx:i});
    if (l[i]<l[i-1]&&l[i]<l[i-2]&&l[i]<l[i+1]&&l[i]<l[i+2]) lows.push({v:l[i], idx:i});
  }
  if (highs.length<2 || lows.length<2) return { trend:'range', event:null };
  const lastHigh = highs.at(-1), prevHigh = highs.at(-2);
  const lastLow  = lows.at(-1),  prevLow  = lows.at(-2);
  const higherHighs = lastHigh.v > prevHigh.v;
  const higherLows  = lastLow.v  > prevLow.v;
  const trend = higherHighs && higherLows ? 'up' : (!higherHighs && !higherLows ? 'down' : 'range');
  const price = c[n-1];
  let event = null;
  if (trend==='up'   && price > lastHigh.v) event = 'BOS_up';
  if (trend==='down' && price < lastLow.v)  event = 'BOS_down';
  if (trend==='up'   && price < lastLow.v)  event = 'CHoCH_down';
  if (trend==='down' && price > lastHigh.v) event = 'CHoCH_up';
  return { trend, event };
}

// Premium/Discount: pozycja ceny w niedawnym zakresie wahan (50% = punkt
// rownowagi). Ponizej 50% = strefa "discount" (atrakcyjna dla longow),
// powyzej = "premium" (atrakcyjna dla shortow/realizacji zyskow).
function premiumDiscountZone(h, l, c, lookback=30) {
  const n = c.length;
  const hh = Math.max(...h.slice(-lookback));
  const ll = Math.min(...l.slice(-lookback));
  if (hh===ll) return { zone:'equilibrium', pct:0.5 };
  const pct = (c[n-1]-ll)/(hh-ll);
  return { zone: pct<0.5?'discount':'premium', pct, rangeHigh:hh, rangeLow:ll };
}

function calcSRLevels(highs, lows, price) {
  const n = Math.min(50, highs.length);
  const start = highs.length - n;
  const pivotHighs = [], pivotLows = [];
  for (let i = start + 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2])
      pivotHighs.push(highs[i]);
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2])
      pivotLows.push(lows[i]);
  }
  const above = pivotHighs.filter(v => v > price).sort((a,b) => a-b).slice(0,3);
  const below = pivotLows.filter(v => v < price).sort((a,b) => b-a).slice(0,2);
  return { above, below, all: [...above, ...below] };
}

function detectRegime(closes, atrD, ema50, ema200) {
  const price = closes.at(-1);
  const atrPct = atrD / price;
  if (atrPct > 0.035) return 'volatile';
  if (Math.abs(ema50/ema200 - 1) < 0.005 && atrPct < 0.02) return 'sideways';
  if (price > ema50 && ema50 > ema200) return 'bull_trend';
  if (price < ema50 && ema50 < ema200) return 'bear_trend';
  return 'neutral';
}

function calcStats(trades) {
  if (!trades || trades.length < 5) return { sharpe:0, sortino:0, maxDD:0, winRate:0 };
  const rets = trades.map(t => t.pnlPct / 100);
  const avg = rets.reduce((a,b) => a+b, 0) / rets.length;
  const std = Math.sqrt(rets.reduce((a,b) => a + (b-avg)**2, 0) / rets.length);
  const sharpe = std > 0 ? +(avg / std * Math.sqrt(252)).toFixed(2) : 0;
  const downRets = rets.filter(r => r < 0);
  const downAvg  = downRets.length > 0 ? downRets.reduce((a,b) => a+b, 0) / downRets.length : 0;
  const downStd  = downRets.length > 0 ? Math.sqrt(downRets.reduce((a,b) => a + (b-downAvg)**2, 0) / downRets.length) : 0;
  const sortino = downStd > 0 ? +(avg / downStd * Math.sqrt(252)).toFixed(2) : 0;
  let peak = 1, equity = 1, maxDD = 0;
  for (const r of rets) { equity *= (1 + r); if (equity > peak) peak = equity; const dd = (peak - equity)/peak; if (dd > maxDD) maxDD = dd; }
  const winRate = +(rets.filter(r => r > 0).length / rets.length * 100).toFixed(1);
  return { sharpe, sortino, maxDD: +(maxDD * 100).toFixed(1), winRate };
}

async function analyzeSwing(sym, cfg, state, nb, gbm, ql, ew, pairParams, adaptiveMinScore) {
  // DAY TRADING: interwaly intraday zamiast swingowych D/4H/1H.
  // kd -> 1H (struktura/bias, dawniej Daily), k4h -> 15min (trend, dawniej 4H),
  // k1h -> 5min (precyzyjne wejscie, dawniej 1H). Zmienne nazwy zostaly bez zmian
  // celowo - caly scoring nizej (RSI/MACD/BB na kazdym TF) dziala identycznie,
  // tylko dostaje dane z krotszych, wlasciwych dla intraday okien czasowych.
  const kd      = await getKlines(sym, '60',  200);
  await sleep(200);
  const k4h     = await getKlines(sym, '15',  100);
  await sleep(200);
  const k1h     = await getKlines(sym, '5',   50);
  await sleep(200);
  const obiData = await getOrderbook(sym);

  // Gate.io format: [timestamp_ms, open, high, low, close, volume] po mapowaniu w getKlines
  // getKlines zwraca: [ts, o, h, l, c, v]
  const pk = k => ({
    c: k.map(x => +x[4]),
    h: k.map(x => +x[2]),
    l: k.map(x => +x[3]),
    o: k.map(x => +x[1]),
    v: k.map(x => +x[5])
  });
  const d = pk(kd), h4 = pk(k4h), h1 = pk(k1h);
  const price = d.c.at(-1);

  // Wskaźniki 1H
  const rsiD   = rsi(d.c, 14);
  const macdD  = macdFull(d.c);
  const bbD    = bband(d.c, 20);
  const ema50  = emaLast(d.c, 50);
  const ema200 = emaLast(d.c, 200);
  const atrD   = atr(d.h, d.l, d.c, 14);
  const vwap4h = calcVWAP(h4.h, h4.l, h4.c, h4.v);
  const srLevels = calcSRLevels(d.h, d.l, price);
  const regime = detectRegime(d.c, atrD, ema50, ema200);

  // Wskaźniki 4H
  const rsi4h  = rsi(h4.c, 14);
  const macd4h = macdFull(h4.c);

  // Wskaźniki 1H
  const rsi1h  = rsi(h1.c, 14);
  const macd1h = macdFull(h1.c);
  const confirm1h = macd1h.hist > 0 && rsi1h < 55;

  // RSI Divergence
  const rsiArrD  = rsiArray(d.c.slice(-40),  14);
  const rsiArr4h = rsiArray(h4.c.slice(-30), 14);
  const divD  = rsiDivergence(d.c.slice(-40),  rsiArrD,  38);
  const div4h = rsiDivergence(h4.c.slice(-30), rsiArr4h, 28);

  // Trend
  const trendD = price > ema200 ? (price > ema50 ? 2 : 1) : (price > ema50 ? 0 : -1);

  // Volume
  const _vSum20 = d.v.length >= 20 ? d.v.slice(-20).reduce((a,b)=>a+b,0) : 0;
  const volR  = (_vSum20 > 0) ? d.v.at(-1) / (_vSum20/20) : 1;
  const _v4Sum20 = h4.v.length >= 20 ? h4.v.slice(-20).reduce((a,b)=>a+b,0) : 0;
  const vol4R = (_v4Sum20 > 0) ? h4.v.at(-1) / (_v4Sum20/20) : 1;

  // Momentum
  const mom5  = d.c.length > 5  ? (price / d.c.at(-6)  - 1) * 100 : 0;
  const mom10 = d.c.length > 10 ? (price / d.c.at(-11) - 1) * 100 : 0;

  // Scoring
  let score = 0;
  const why = [];

  if      (rsiD <= 25) { score += 30; why.push('RSI-D=' + rsiD.toFixed(0) + ' (extreme OS)'); }
  else if (rsiD <= 32) { score += 24; why.push('RSI-D oversold (' + rsiD.toFixed(0) + ')'); }
  else if (rsiD <= 40) { score += 16; why.push('RSI-D low (' + rsiD.toFixed(0) + ')'); }
  else if (rsiD <= 48) { score += 8; }
  else if (rsiD >= 70) { score -= 15; why.push('RSI-D wykupiony'); }

  if      (rsi4h <= 30) { score += 15; why.push('RSI-4H oversold'); }
  else if (rsi4h <= 40) { score += 10; why.push('RSI-4H low'); }
  else if (rsi4h <= 50) { score += 5; }
  else if (rsi4h >= 70) { score -= 10; why.push('RSI-4H wykupiony'); }

  if      (macdD.hist > 0 && macdD.line < 0) { score += 20; why.push('MACD cross up 1H'); }
  else if (macdD.hist > 0)                    { score += 12; why.push('MACD hist+ 1H'); }
  else if (macdD.hist > -atrD * 0.005)        { score += 4; }
  else                                         { score -= 5; }

  if      (bbD.pos < 0.08) { score += 18; why.push('Cena przy dolnej BB'); }
  else if (bbD.pos < 0.20) { score += 13; why.push('BB dolna strefa'); }
  else if (bbD.pos < 0.35) { score += 6; }
  else if (bbD.pos > 0.85) { score -= 10; why.push('BB gorna — ryzyko'); }

  if      (trendD === 2)  { score += 12; why.push('Ponad EMA50+200 — bull'); }
  else if (trendD === 1)  { score += 8;  why.push('Ponad EMA200'); }
  else if (trendD === 0)  { score += 3; }
  else                    { score -= 20; why.push('Ponizej EMA200 — bessa'); }

  if      (mom5 > 0 && mom10 < 0)    { score += 8; why.push('Momentum odwrocenie'); }
  else if (mom5 < -5 && mom10 < -10) { score += 5; why.push('Oversold momentum'); }
  else if (mom5 > 8)                  { score -= 5; why.push('Zbyt szybki wzrost'); }

  // ── SMART MONEY CONCEPTS ──────────────────────────────────────────
  // Struktura rynku liczona na 1H (d, wyzszy TF = bias/kontekst), order blocks/
  // FVG/liquidity sweep na 5min (h1, najnizszy TF = precyzja wejscia). To zgodne
  // z typowym podejsciem SMC: wyzszy TF daje kierunek, nizszy TF daje moment wejscia.
  const structure   = detectStructure(d.h, d.l, d.c);
  const orderBlocks = detectOrderBlocks(h1.o, h1.h, h1.l, h1.c, atr(h1.h, h1.l, h1.c, 14));
  const fvgs        = detectFVG(h1.h, h1.l, h1.c);
  const liqSweep    = detectLiquiditySweep(h1.h, h1.l, h1.c);
  const premDisc     = premiumDiscountZone(d.h, d.l, d.c);

  if (structure.event === 'BOS_up')        { score += 15; why.push('SMC: Break of Structure (bull)'); }
  else if (structure.event === 'CHoCH_up') { score += 12; why.push('SMC: Change of Character (bull odwrocenie)'); }
  else if (structure.event === 'BOS_down') { score -= 15; why.push('SMC: Break of Structure (bear)'); }
  else if (structure.event === 'CHoCH_down'){ score -= 10; why.push('SMC: Change of Character (bear odwrocenie)'); }

  if (liqSweep && liqSweep.type === 'bullish') { score += 14; why.push('SMC: Liquidity sweep (stop hunt) + odbicie'); }
  if (liqSweep && liqSweep.type === 'bearish') { score -= 10; why.push('SMC: Liquidity sweep gorny'); }

  const nearBullOB = orderBlocks.filter(b=>b.type==='bullish').some(b => price >= b.bottom*0.998 && price <= b.top*1.01);
  const nearBearOB = orderBlocks.filter(b=>b.type==='bearish').some(b => price >= b.bottom*0.99 && price <= b.top*1.002);
  if (nearBullOB) { score += 10; why.push('SMC: Cena przy bull Order Block'); }
  if (nearBearOB) { score -= 8;  why.push('SMC: Cena przy bear Order Block'); }

  const nearBullFVG = fvgs.filter(g=>g.type==='bullish').some(g => price >= g.bottom && price <= g.top);
  if (nearBullFVG) { score += 6; why.push('SMC: Cena wypelnia bull FVG'); }

  if (premDisc.zone === 'discount') { score += 6; why.push('SMC: Strefa discount (' + (premDisc.pct*100).toFixed(0) + '%)'); }
  else                                { score -= 4; why.push('SMC: Strefa premium (' + (premDisc.pct*100).toFixed(0) + '%) - mniej atrakcyjne dla longa'); }

  if (volR > 1.8 || vol4R > 2.0) { score += 5; why.push('Vol spike x' + Math.max(volR,vol4R).toFixed(1)); }
  else if (volR < 0.4)            { score -= 8; why.push('Niski wolumen'); }

  if (macd4h.hist > 0 && macdD.hist > 0) { score += 5; why.push('MACD 4H+D zgodnosc'); }
  if (confirm1h)  { score += 5; why.push('1H potwierdza'); }
  else            { score -= 3; }

  if      (divD.bull && div4h.bull) { score += 20; why.push('RSI dywergencja bycza D+4H'); }
  else if (divD.bull)               { score += 14; why.push('RSI dywergencja bycza 1H'); }
  else if (div4h.bull)              { score += 8;  why.push('RSI dywergencja bycza 4H'); }
  if (divD.bear)  { score -= 12; why.push('RSI dywergen. niedzwiedzia 1H'); }
  if (div4h.bear) { score -= 7;  why.push('RSI dywergen. niedzwiedzia 4H'); }

  if (trendD === -1 && rsiD > 50) { score = Math.min(score, 15); why.push('BESSA: brak long'); }
  score = Math.max(0, Math.min(100, Math.round(score)));

  if (price > vwap4h) { score += 8;  why.push('Ponad VWAP'); }
  else                { score -= 5;  why.push('Ponizej VWAP'); }
  score = Math.max(0, Math.min(100, score));

  const srSupport    = srLevels.below.find(s => Math.abs(price/s - 1) <= 0.015);
  const srResistance = srLevels.above.find(r => price > r * 0.985);
  if (srSupport)    { score += 12; why.push('S/R support'); }
  if (srResistance) { score -= 10; why.push('Pod oporem S/R'); }
  score = Math.max(0, Math.min(100, score));

  let regimeMinScoreAdj = 0;
  if (regime === 'sideways')   { regimeMinScoreAdj = 8; }
  if (regime === 'bull_trend') { score += 5; why.push('Rezim: bull trend'); }
  if (regime === 'bear_trend') { score -= 15; why.push('Rezim: bear trend'); }
  if (regime === 'volatile')   { score -= 8;  why.push('Rezim: volatile'); }
  score = Math.max(0, Math.min(100, score));

  // Candlestick Patterns
  const patResult = PATTERNS.detect(d.c, d.o, d.h, d.l);
  if (patResult.bullish > 0) {
    const volOk = volR >= 1.3;
    const eff   = volOk ? patResult.bullish : Math.floor(patResult.bullish * 0.5);
    score = Math.min(100, score + Math.min(15, eff * 6));
    patResult.patterns.filter(p=>p.type==='bullish').forEach(p=>why.push(p.name + (volOk?'':' (slaby vol)')));
  }
  if (patResult.bearish > 0) {
    score = Math.max(0, score - Math.min(12, patResult.bearish * 5));
    patResult.patterns.filter(p=>p.type==='bearish').forEach(p=>why.push('! ' + p.name));
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  // OBI
  const obiScore = calcOBI(obiData);
  if (obiScore > 0) { score = Math.min(100, score + obiScore); why.push('OBI bycze'); }
  if (obiScore < 0) { score = Math.max(0,   score + obiScore); why.push('OBI niedzwiedzie'); }

  // ML Predictions
  const nbFeatures  = nb.discretize({ rsiD, macdHist: macdD.hist, bbPos: bbD.pos, trendD, mom5, confirm1h });
  const bodyRatio  = Math.abs(d.c.at(-1) - d.o.at(-1)) / (d.h.at(-1) - d.l.at(-1) + 0.001);
  const atrPctFeat = Math.min(1, atrD / price / 0.1);
  const emaSlopeD  = Math.max(-1, Math.min(1, (ema50/ema200 - 1) * 10));
  const gbmFeatures = [rsiD/100, macdD.hist>0?1:0, bbD.pos, (trendD+1)/3, mom5/20, mom10/20, confirm1h?1:0, volR/3, obiData.ratio||0.5, bodyRatio, atrPctFeat, emaSlopeD];

  const nbPred  = nb.predict({ rsiD, macdHist: macdD.hist, bbPos: bbD.pos, trendD, mom5, confirm1h });
  const gbmProb = gbm.predict(gbmFeatures);

  const qlSig   = { rsiD, macdHist: macdD.hist, trendD, bbPos: bbD.pos, obiRatio: obiData.ratio || 0.5 };
  const qlSugg  = ql.suggests(qlSig);
  let qlBonus = 0;
  if (qlSugg) {
    if (qlSugg.action === 'BUY' && qlSugg.confidence > 0.05) { qlBonus = 8; why.push('QL: BUY'); }
    score = Math.max(0, Math.min(100, score + qlBonus));
  }

  // Ensemble
  let finalProb = score / 100;
  let aiMethod  = 'Score';
  const obiNorm = ((obiData.ratio || 0.5) - 0.3) / 0.4;

  if (nb.trained && gbm.trained) {
    const wSum = (ew.score + ew.nb + ew.gbm + ew.obi + ew.ql) || 1;
    finalProb = Math.max(0, Math.min(1,
      (score/100 * ew.score + nbPred.prob * ew.nb + gbmProb * ew.gbm +
       Math.max(0, Math.min(1, obiNorm)) * ew.obi +
       (qlSugg && qlSugg.action==='BUY' ? 1 : 0) * ew.ql) / wSum));
    aiMethod = 'Ensemble(Score+NB+GBM+OBI+QL)';
    if (nbPred.label === 'SKIP' && gbmProb < 0.4) why.push('AI odradza wejscie');
  } else if (nb.trained) {
    const wSum = (ew.score + ew.nb + ew.obi) || 1;
    finalProb = (score/100 * ew.score + nbPred.prob * ew.nb + Math.max(0,Math.min(1,obiNorm)) * ew.obi) / wSum;
    aiMethod  = 'Score+NB+OBI';
  }

  const pp       = pairParams[sym] || PAIR_PARAMS_DEFAULT[sym] || null;
  const minScore = (pp ? pp.minScore : adaptiveMinScore) + regimeMinScoreAdj;
  const buy      = finalProb >= minScore / 100;
  // Sygnal SHORT - wylacznie informacyjny (Revolut X nie obsluguje marginu/shortow,
  // wiec bot NIGDY nie wykonuje realnej krotkiej sprzedazy). Wymaga symetrycznie
  // niskiego finalProb ORAZ potwierdzenia niedzwiedziej struktury SMC - samo niskie
  // prawdopodobienstwo bez potwierdzenia struktury to za slaby sygnal do pokazania.
  const shortSignal = finalProb <= (1 - minScore/100)
    && (structure.event === 'BOS_down' || structure.event === 'CHoCH_down' || liqSweep && liqSweep.type === 'bearish');
  const shortLevels = shortSignal ? {
    tp: price * (1 - Math.max(cfg.tp, atrD/price*2.5)),
    sl: price * (1 + Math.max(cfg.sl, atrD/price*1.5)),
    rr: (Math.max(cfg.tp, atrD/price*2.5) / Math.max(cfg.sl, atrD/price*1.5)).toFixed(1)
  } : null;

  return {
    sym, price,
    rsiD: +rsiD.toFixed(1), rsi4h: +rsi4h.toFixed(1), rsi1h: +rsi1h.toFixed(1), confirm1h,
    macdHist: macdD.hist, macdLine: macdD.line,
    bbPos: bbD.pos, trendD, ema50, ema200, atrD,
    score, finalProb: +finalProb.toFixed(3), buy, shortSignal, shortLevels,
    nbPred, gbmProb: +gbmProb.toFixed(3), qlSugg, aiMethod,
    obiRatio: obiData.ratio || 0.5, obiScore,
    patterns: patResult.patterns,
    srLevels, vwap4h, regime,
    why, nbFeatures, gbmFeatures, qlSig,
    volR: +volR.toFixed(2), vol4R: +vol4R.toFixed(2),
    mom5: +mom5.toFixed(2), mom10: +mom10.toFixed(2),
    // Dane SMC + strefy TP/SL do wizualizacji na wykresie (dashboard)
    smc: {
      structure: structure.trend, event: structure.event,
      orderBlocks: orderBlocks.slice(-3), fvgs: fvgs.slice(-3),
      liqSweep, premiumDiscount: premDisc.zone, pdPct: +premDisc.pct.toFixed(3)
    },
    levels: calcDynamicLevels(price, atrD, cfg)
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ZARZĄDZANIE POZYCJAMI
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function checkPositions(cfg, state, env, ql) {
  const updated = [];
  for (const pos of (state.positions || [])) {
    // FIX 6: jeśli pozycja jest już w trakcie zamykania — nie wysyłaj kolejnego SELL
    if (pos.closing) { updated.push(pos); continue; }
    try {
      const price = await getLastPrice(pos.sym);
      pos.cp = price;
      if (price > pos.highP) pos.highP = price;

      const pnlPct = (price - pos.entry) / pos.entry * 100;
      const trail  = pos.highP * (1 - pos.trailDist);
      let reason = null;

      if (Date.now() - pos.entryTs > TIMEOUT_MS)             reason = 'TIMEOUT 8h';
      else if (price >= (pos.tp > 0 ? pos.tp : pos.entry * (1 + cfg.tp))) reason = 'TAKE PROFIT';
      else if (price <= (pos.partialClosed ? pos.sl : (pos.sl > 0 ? pos.sl : pos.entry * (1 - cfg.sl)))) reason = 'STOP LOSS';
      else if (price <= trail && pnlPct > 1.5)               reason = 'TRAILING STOP';

      // Partial TP (50% pozycji przy połowie TP)
      const _tpPct = pos.tp > 0 ? (pos.tp - pos.entry) / pos.entry * 100 : cfg.tp * 100;
      if (!reason && pnlPct >= _tpPct * 0.5 && !pos.partialClosed && !pos.partialSelling) {
        pos.partialSelling = true;
        const halfQty = pos.qty / 2;
        const halfPnl = (price - pos.entry) * halfQty;
        const halfSize = pos.size / 2;
        try {
          if (cfg.mode === 'live' && cfg.revxApiKey && cfg.revxPrivKey) {
            await revxMarketSell(pos.sym, halfQty, cfg);
          }
          pos.qty = halfQty;
          pos.size = halfSize;
          pos.partialClosed = true;
          pos.partialSelling = false;
          pos.sl = pos.entry * (1 + FEE * 2);
          if (cfg.mode === 'paper') {
            state.paperBalance = (state.paperBalance || 0) + halfSize + halfPnl;
          }
          addLog(state, 'PARTIAL TP ' + pos.sym + ' +$' + halfPnl.toFixed(2) + ' (' + pnlPct.toFixed(1) + '%) — reszta jedzie dalej', 'ok');
        } catch(e) {
          pos.partialSelling = false;
          addLog(state, 'Partial TP SELL error: ' + e.message, 'err');
        }
      }

      if (reason) {
        // FIX 6: ustaw flagę closing przed wywołaniem closePosition
        pos.closing = true;
        const closed = await closePosition(pos, price, reason, cfg, state, ql);
        if (closed === false) {
          pos.closing = false; // reset przy błędzie
          updated.push(pos);
        }
        // sukces — nie wracaj pozycji do listy
      } else {
        updated.push(pos);
      }
    } catch(e) {
      addLog(state, 'checkPos ' + pos.sym + ': ' + e.message, 'err');
      pos.closing = false;
      updated.push(pos);
    }
    await sleep(150);
  }
  state.positions = updated;
}

async function openTrade(sig, fg, btcDrop, cfg, state, env, nb, gbm, ql, ew) {
  if ((state.positions||[]).some(p => p.sym === sig.sym)) return;
  if (((state.cooldown || {})[sig.sym] || 0) > Date.now()) {
    addLog(state, 'Cooldown ' + sig.sym, 'warn'); return;
  }
  if ((state.globalBlockUntil||0) > Date.now()) {
    addLog(state, 'Globalna blokada aktywna', 'warn'); return;
  }
  if (isPumpDump(sig)) return;
  if (isVolumeAnomaly(sig)) { addLog(state, 'Vol anomaly: ' + sig.sym + ' vol=' + sig.volR.toFixed(2) + 'x — pomijam', 'warn'); return; }
  if (isDeadHour()) { addLog(state, 'Dead hour (01-05 UTC): ' + sig.sym + ' — pomijam', 'warn'); return; }

  if (btcDrop && sig.sym !== 'XBTUSDT') {
    addLog(state, 'BTC Guard: pomijam ' + sig.sym, 'warn'); return;
  }

  if (corrBlocked(sig.sym, state)) return;

  // Fear & Greed penalty
  let adjSig = sig;
  if (fg.val < cfg.fgMin) {
    const newProb = Math.max(0, sig.finalProb - 0.10);
    adjSig = Object.assign({}, sig, { finalProb: newProb, score: Math.max(0, sig.score - 10) });
    const pp = (state.pairParams||{})[sig.sym] || PAIR_PARAMS_DEFAULT[sig.sym];
    const minSc = pp ? pp.minScore : (state.adaptiveMinScore || cfg.minScore);
    if (adjSig.finalProb < minSc / 100) {
      addLog(state, 'F&G=' + fg.val + ' — po karze za slaby score pomijam ' + sig.sym, 'warn'); return;
    }
  }

  const paperBal = state.paperBalance > 0 ? state.paperBalance : (cfg.paperBalance || 1000);
  const total    = cfg.mode === 'live' ? (state.liveBalance > 0 ? state.liveBalance : paperBal) : paperBal;
  const micro    = isMicroAccount(total);

  if (micro && (state.positions || []).length >= 1) {
    addLog(state, 'Micro konto — czekam na zamkniecie obecnej pozycji', 'warn'); return;
  }

  if (!micro) {
    const totalRisk = (state.positions || []).reduce((s, p) => {
      const slPct = p.partialClosed
        ? 0
        : (p.entry > 0 ? Math.abs((p.sl || 0) - p.entry) / p.entry : cfg.sl);
      return s + (p.size||0) * slPct;
    }, 0);
    const portfolioHeat = totalRisk / (total > 0 ? total : 1);
    if (portfolioHeat > 0.10) {
      addLog(state, 'Portfolio heat >10% — blokada (' + (portfolioHeat*100).toFixed(1) + '%)', 'warn');
      return;
    }
  }

  const posSize = kellySize(cfg, state, total);
  const minSize = micro ? 1 : 10;
  if (posSize < minSize) {
    addLog(state, 'Za mala pozycja (' + posSize.toFixed(2) + '$) — pomijam ' + sig.sym, 'warn'); return;
  }
  const levels = calcDynamicLevels(adjSig.price, adjSig.atrD, cfg);

  addLog(state,
    'BUY ' + adjSig.sym + ' @ ' + adjSig.price.toFixed(4) +
    ' | score=' + adjSig.score + ' finalProb=' + (adjSig.finalProb*100).toFixed(1) + '%' +
    ' | $' + posSize.toFixed(2) + ' TP=' + levels.tp.toFixed(4) +
    ' SL=' + levels.sl.toFixed(4) + ' R:R=' + levels.rr +
    ' | ' + adjSig.aiMethod + ' | ' + cfg.mode.toUpperCase(), 'ok');

  if (!Array.isArray(state.positions)) state.positions = [];

  if (cfg.mode === 'live' && cfg.revxApiKey && cfg.revxPrivKey) {
    try {
      const res = await revxMarketBuy(adjSig.sym, posSize, cfg);
      const execP = res.price || adjSig.price;
      const el    = calcDynamicLevels(execP, adjSig.atrD, cfg);
      state.positions.push(buildPosition(adjSig, execP, res.qty, el, posSize, ql));
      if (!state.dailyStartBalance || state.dailyStartBalance <= 0) {
        try {
          const liveBal = await revxGetBalance(cfg);
          state.dailyStartBalance = (typeof liveBal === 'number' && liveBal > 0) ? liveBal : posSize * (cfg.maxPos || 4);
        } catch(_) {
          state.dailyStartBalance = posSize * (cfg.maxPos || 4);
        }
      }
    } catch(e) {
      addLog(state, 'BUY FAILED ' + adjSig.sym + ': ' + e.message, 'err');
      return;
    }
  } else {
    const qty = posSize / adjSig.price;
    state.positions.push(buildPosition(adjSig, adjSig.price, qty, levels, posSize, ql));
    if (cfg.mode === 'paper') {
      state.paperBalance = Math.max(0, (state.paperBalance || paperBal) - posSize);
    }
    if (!state.dailyStartBalance || state.dailyStartBalance <= 0) {
      state.dailyStartBalance = paperBal;
    }
  }

  const _pairName = adjSig.sym.replace('XBT','BTC').replace('USDT','').replace('USDC','');
  const _modeLabel = cfg.mode === 'live' ? 'LIVE (Revolut X)' : 'PAPER (symulacja)';
  await tgSend(cfg,
    'SYGNAL KUPNA — ' + _pairName + '\n\n' +
    'Cena wejscia: $' + adjSig.price.toFixed(4) + '\n' +
    'Rozmiar pozycji: $' + posSize.toFixed(2) + ' (Kelly)\n' +
    'Take Profit: $' + levels.tp.toFixed(4) + '\n' +
    'Stop Loss: $' + levels.sl.toFixed(4) + '\n' +
    'Zysk/Ryzyko: ' + levels.rr + '\n\n' +
    'Wynik AI: ' + adjSig.score + '/100 | Pewnosc: ' + (adjSig.finalProb*100).toFixed(1) + '%\n' +
    'Metoda: ' + adjSig.aiMethod + '\n' +
    'Powody: ' + adjSig.why.slice(0,4).join(', ') + '\n\n' +
    'Tryb: ' + _modeLabel);
}

function buildPosition(sig, price, qty, levels, size, ql) {
  return {
    sym: sig.sym, entry: price, qty, cp: price, highP: price,
    sl: levels.sl, tp: levels.tp, trailDist: levels.trail,
    entryTs: Date.now(), score: sig.score, finalProb: sig.finalProb,
    aiMethod: sig.aiMethod, nbFeatures: sig.nbFeatures, gbmFeatures: sig.gbmFeatures,
    qlSig: sig.qlSig, gbmProb: sig.gbmProb, nbLabel: sig.nbPred ? sig.nbPred.label : 'NEUTRAL',
    why: sig.why.join(', '), size, rr: levels.rr
  };
}

async function closePosition(pos, price, reason, cfg, state, ql) {
  const grossPnl = (price - pos.entry) * pos.qty;
  const feeCost  = pos.size * FEE + (pos.size + grossPnl) * FEE;
  const pnl      = grossPnl - feeCost;
  const pnlPct   = pnl / pos.size * 100;
  const durH     = ((Date.now() - pos.entryTs) / 3600000).toFixed(1);

  if (cfg.mode === 'live' && cfg.revxApiKey && cfg.revxPrivKey) {
    try {
      await revxMarketSell(pos.sym, pos.qty, cfg);
    } catch(e) {
      addLog(state, 'SELL FAILED ' + pos.sym + ': ' + e.message, 'err');
      return false;
    }
  } else if (cfg.mode === 'paper') {
    state.paperBalance = (state.paperBalance || 0) + pos.size + pnl;
  }

  state.dailyPnl = (state.dailyPnl || 0) + pnl;
  if (pnl < 0) {
    state.consLoss = (state.consLoss || 0) + 1;
    if (!state.cooldown || typeof state.cooldown !== 'object') state.cooldown = {};
    // Day trading: 45 min zamiast 12h (swing) - 12h cooldown przy 3-minutowym
    // cyklu skanu oznaczaloby efektywnie "nie handluj ta para do jutra", co
    // przeczy idei day tradingu w ramach jednej sesji.
    state.cooldown[pos.sym] = Date.now() + 45 * 60000;
    if (state.consLoss >= 4) {
      state.globalBlockUntil = Date.now() + 60 * 60000; // 1h zamiast 3h (swing)
      addLog(state, '4 straty z rzedu — blokada 1h', 'err');
    }
  } else {
    state.consLoss = 0;
  }

  if (pos.qlSig && ql) {
    const reward = Math.max(-1, Math.min(1, pnlPct / 10));
    ql.update(pos.qlSig, 'BUY', reward, null);
  }

  const trade = {
    sym: pos.sym, entry: pos.entry, exit: price, qty: pos.qty,
    pnl: +pnl.toFixed(4), pnlPct: +pnlPct.toFixed(2),
    durH, reason, score: pos.score, finalProb: pos.finalProb,
    aiMethod: pos.aiMethod, nbFeatures: pos.nbFeatures, gbmFeatures: pos.gbmFeatures,
    nbLabel: pos.nbLabel || 'NEUTRAL', ts: Date.now()
  };
  state.trades = [trade, ...(state.trades || [])].slice(0, 300);
  state.stats = calcStats(state.trades);

  const _closeIcon = pnl >= 0 ? '[+]' : '[-]';
  const _closeSym = pos.sym.replace('XBT','BTC').replace('USDT','').replace('USDC','');
  addLog(state,
    _closeIcon + ' ' + pos.sym + ' ' + reason +
    ' P/L: ' + (pnl>=0?'+':'') + '$' + pnl.toFixed(2) +
    ' (' + pnlPct.toFixed(2) + '%) | ' + durH + 'h | R:R=' + (pos.rr||'?'),
    pnl >= 0 ? 'ok' : 'err');

  const _reasonPL = reason === 'TAKE PROFIT' ? 'REALIZACJA ZYSKU' :
    reason === 'STOP LOSS' ? 'STOP LOSS AKTYWOWANY' :
    reason === 'TRAILING STOP' ? 'STOP KROCZACY' :
    reason === 'TIMEOUT 7d' ? 'KONIEC CZASU (7 dni)' : reason;
  await tgSend(cfg,
    (pnl>=0?'[+]':'[-]') + ' ' + _reasonPL + ' — ' + _closeSym + '\n\n' +
    'Wynik: ' + (pnl>=0?'+':'') + '$' + pnl.toFixed(2) + ' (' + pnlPct.toFixed(2) + '%)\n' +
    'Czas trwania: ' + durH + 'h\n' +
    'Score wejscia: ' + pos.score + '/100\n' +
    'Tryb: ' + (cfg.mode === 'live' ? 'LIVE (Revolut X)' : 'PAPER'));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GUARDS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function isPumpDump(sig) {
  if (sig.vol4R > 4.0) return true;
  if (sig.mom5  > 15)  return true;
  return false;
}

function isVolumeAnomaly(sig) {
  if (sig.volR < 0.35) return true;
  if (sig.score >= 62 && sig.vol4R < 0.3) return true;
  return false;
}

function isDeadHour() {
  const h = new Date().getUTCHours();
  return h >= 1 && h < 5;
}

async function btcDropGuard() {
  try {
    const r = await fetchWithTimeout('https://api.kraken.com/0/public/Ticker?pair=XBTUSDT');
    const d = await r.json();
    if (d.error && d.error.length > 0) return false;
    const key = Object.keys(d.result || {})[0];
    if (!key) return false;
    const t = d.result[key];
    const open24h = +t.o;
    const last    = +t.c[0];
    if (!open24h) return false;
    return (last - open24h) / open24h * 100 < -5;
  } catch(e) { return false; }
}

function corrBlocked(sym, state) {
  let group = -1;
  for (let i = 0; i < CORR_GROUPS.length; i++) {
    if (CORR_GROUPS[i].indexOf(sym) !== -1) { group = i; break; }
  }
  if (group < 0) return false;
  const openInGroup = (state.positions || []).filter(p => {
    for (let i = 0; i < CORR_GROUPS.length; i++)
      if (CORR_GROUPS[i].indexOf(p.sym) !== -1 && i === group) return true;
    return false;
  }).length;
  return openInGroup >= 1;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RISK MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function isMicroAccount(total) { return (isFinite(total) && total > 0 && total < 100); }

function kellySize(cfg, state, total) {
  const safeTotal = (isFinite(total) && total > 0) ? total : 100;

  if (isMicroAccount(safeTotal)) {
    return Math.max(1, Math.round(safeTotal * 0.90 * 100) / 100);
  }

  const fixedSize = cfg.posSize || 15;
  const trades    = (state.trades || []).slice(0, 30); // FIX 7: slice(0,30) = najnowsze 30 tradów
  if (trades.length < 5) {
    return Math.min(fixedSize, Math.max(10, safeTotal * (cfg.riskPct || 2) / 100));
  }
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const p    = wins.length / trades.length;
  const avgW = wins.length   ? wins.reduce((a,t)=>a+t.pnlPct,0)/wins.length/100   : cfg.tp;
  const avgL = losses.length ? Math.abs(losses.reduce((a,t)=>a+t.pnlPct,0)/losses.length)/100 : cfg.sl;
  const b    = avgW / (avgL > 0 ? avgL : cfg.sl || 0.04);
  if (!isFinite(b) || b <= 0) return Math.min(fixedSize, Math.max(10, safeTotal * (cfg.riskPct||2)/100));
  let kelly = (b * p - (1 - p)) / b;
  if (kelly <= 0) return Math.min(fixedSize, Math.max(5, safeTotal * 0.02));
  kelly = Math.min(0.05, kelly * 0.5);
  const sz = Math.max(5, Math.round(safeTotal * kelly * 100) / 100);
  return Math.min(fixedSize, sz, safeTotal * 0.20);
}

function calcDynamicLevels(price, atrD, cfg) {
  const atrPct   = atrD / price;
  const tpOffset = Math.max(cfg.tp,   atrPct * 2.5);
  const slOffset = Math.max(cfg.sl,   atrPct * 1.5);
  const trail    = Math.max(cfg.trail, atrPct * 1.2);
  const tp    = price * (1 + tpOffset);
  const sl    = price * (1 - slOffset);
  const rr    = ((tp - price) / (price - sl)).toFixed(1);
  return { tp, sl, trail, rr, atrPct: (atrPct*100).toFixed(2) };
}

function computeAdaptiveMinScore(trades, baseMin) {
  if (!trades || trades.length < 10) return baseMin;
  const recent = trades.slice(0, 20);
  const winRate = recent.filter(t => t.pnl > 0).length / recent.length;
  if (winRate < 0.4) return Math.min(75, baseMin + 5);
  if (winRate > 0.65) return Math.max(50, baseMin - 3);
  return baseMin;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FORMACJE ŚWIECOWE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const PATTERNS = {
  detect(closes, opens, highs, lows) {
    const n = closes.length;
    if (n < 5) return { patterns:[], score:0, bullish:0, bearish:0 };
    const o=opens, h=highs, l=lows, c=closes;
    const i = n - 1;
    const patterns = [];

    const body  = j => Math.abs(c[j]-o[j]);
    const range = j => h[j]-l[j];
    const isUp   = j => c[j] > o[j];
    const isDown = j => c[j] < o[j];
    const atrVal = (range(i)+range(i-1)+range(i-2))/3 || 1;

    // HAMMER
    const lowerSh = isUp(i) ? o[i]-l[i] : c[i]-l[i];
    const upperSh = isUp(i) ? h[i]-c[i] : h[i]-o[i];
    if (body(i) < atrVal*0.3 && lowerSh > body(i)*2 && upperSh < body(i)*0.5 && isDown(i-1)) {
      patterns.push({ name:'Hammer', type:'bullish', strength:75, desc:'Silne odrzucenie w dol' });
    }
    // BULLISH ENGULFING
    if (isDown(i-1) && isUp(i) && o[i]<c[i-1] && c[i]>o[i-1] && body(i)>body(i-1)*1.1) {
      patterns.push({ name:'Bullish Engulfing', type:'bullish', strength:82, desc:'Popyt przytloczyl podaz' });
    }
    // MORNING STAR
    if (n>=3 && isDown(i-2) && body(i-1)<atrVal*0.25 && isUp(i) && c[i]>(o[i-2]+c[i-2])/2) {
      patterns.push({ name:'Morning Star', type:'bullish', strength:85, desc:'Odwrocenie trendu spadkowego' });
    }
    // DOJI
    if (body(i) < atrVal*0.1 && range(i) > atrVal*0.3) {
      const t = (isDown(i-1)||isDown(i-2)) ? 'bullish' : 'neutral';
      patterns.push({ name:'Doji', type:t, strength:55, desc:'Rynek niezdecydowany' });
    }
    // PIERCING LINE
    if (isDown(i-1) && isUp(i) && o[i]<l[i-1] && c[i]>(o[i-1]+c[i-1])/2 && c[i]<o[i-1]) {
      patterns.push({ name:'Piercing Line', type:'bullish', strength:70, desc:'Kupujacy weszli po bessie' });
    }
    // THREE WHITE SOLDIERS
    if (n>=3 && isUp(i) && isUp(i-1) && isUp(i-2) && c[i]>c[i-1] && c[i-1]>c[i-2] && body(i)>atrVal*0.4 && body(i-1)>atrVal*0.4) {
      patterns.push({ name:'Three White Soldiers', type:'bullish', strength:80, desc:'Silny trend wzrostowy' });
    }
    // SHOOTING STAR
    const upperSh2 = isUp(i) ? h[i]-c[i] : h[i]-o[i];
    const lowerSh2 = isUp(i) ? o[i]-l[i] : c[i]-l[i];
    if (body(i)<atrVal*0.3 && upperSh2>body(i)*2 && lowerSh2<body(i)*0.5 && isUp(i-1)) {
      patterns.push({ name:'Shooting Star', type:'bearish', strength:72, desc:'Ostrzezenie przed korekta' });
    }
    // BEARISH ENGULFING
    if (isUp(i-1) && isDown(i) && o[i]>c[i-1] && c[i]<o[i-1] && body(i)>body(i-1)*1.1) {
      patterns.push({ name:'Bearish Engulfing', type:'bearish', strength:78, desc:'Podaz przejela kontrole' });
    }

    const bullish = patterns.filter(p=>p.type==='bullish').length;
    const bearish = patterns.filter(p=>p.type==='bearish').length;
    const score   = patterns.reduce((s,p)=>s+(p.type==='bullish'?p.strength:-p.strength),0);
    return { patterns, score, bullish, bearish };
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MODUŁY AI/ML
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function rebalanceEnsemble(ew, nb, gbm, recentTrades) {
  if (!recentTrades || recentTrades.length < 10) return null;
  const newEw = { score: ew.score, nb: ew.nb, gbm: ew.gbm, obi: ew.obi, ql: ew.ql };

  let nbCorrect = 0, nbTotal = 0;
  recentTrades.forEach(t => {
    if (!t.nbLabel) return;
    nbTotal++;
    if ((t.nbLabel === 'BUY' && t.pnl > 0) || (t.nbLabel !== 'BUY' && t.pnl <= 0)) nbCorrect++;
  });
  if (nbTotal >= 5) {
    const nbAcc = nbCorrect / nbTotal;
    newEw.nb = +Math.max(0.3, Math.min(1.5, nbAcc * 2)).toFixed(2);
  }

  const gbmAcc = gbm.accuracyOOS > 0 ? gbm.accuracyOOS / 100 : 0.5;
  newEw.gbm = +Math.max(0.3, Math.min(1.5, gbmAcc * 2)).toFixed(2);
  newEw.score = 1.0;
  newEw.obi = 0.3;
  return newEw;
}

function makeNB(saved) {
  const nb = {
    model: null, trained: false, trainCount: 0,

    discretize(f) {
      return [
        f.rsiD<=30?0:f.rsiD<=45?1:f.rsiD<=60?2:3,
        f.macdHist>0.001?2:f.macdHist>-0.001?1:0,
        f.bbPos<0.2?0:f.bbPos<0.5?1:f.bbPos<0.8?2:3,
        f.trendD+1,
        f.mom5<-5?0:f.mom5<0?1:f.mom5<5?2:3,
        f.confirm1h?1:0
      ];
    },

    trainFromTrades(trades) {
      if (trades.length < 10) return false;
      const bins = [4,3,4,4,4,2];
      const nF   = 6;
      const counts = { 0:{}, 1:{} };
      const cc     = { 0:0, 1:0 };
      [0,1].forEach(cl => {
        for (let f=0;f<nF;f++) for (let b=0;b<bins[f];b++) counts[cl][f+'_'+b]=1;
      });
      trades.forEach(t => {
        if (!t.nbFeatures) return;
        const lbl = t.pnl > 0 ? 1 : 0;
        cc[lbl]++;
        t.nbFeatures.forEach((bin,f) => { counts[lbl][f+'_'+bin] = (counts[lbl][f+'_'+bin]||0)+1; });
      });
      const total = cc[0]+cc[1];
      if (total < 5) return false;
      this.model = { counts, cc, total, bins, nF };
      this.trained = true; this.trainCount = total;
      return true;
    },

    predict(features) {
      if (!this.trained || !this.model) return { prob:0.5, confidence:'low', label:'NEUTRAL' };
      const m = this.model;
      const bins = this.discretize(features);
      const lp = {};
      [0,1].forEach(cl => {
        let p = Math.log((m.cc[cl]+1)/(m.total+2));
        for (let f=0;f<m.nF;f++) {
          const k = f+'_'+bins[f];
          const cnt = m.counts[cl][k]||1;
          const tot = Object.keys(m.counts[cl]).filter(k2=>k2.startsWith(f+'_')).reduce((s,k2)=>s+(m.counts[cl][k2]||0),0);
          p += Math.log(cnt/Math.max(tot,1));
        }
        lp[cl] = p;
      });
      const mx = Math.max(lp[0],lp[1]);
      const e0=Math.exp(lp[0]-mx), e1=Math.exp(lp[1]-mx);
      const prob = e1/(e0+e1);
      const conf = prob>0.7||prob<0.3?'high':prob>0.6||prob<0.4?'medium':'low';
      return { prob:+prob.toFixed(3), confidence:conf, label:prob>0.55?'BUY':prob<0.45?'SKIP':'NEUTRAL' };
    },

    save() { return { model:this.model, trained:this.trained, trainCount:this.trainCount }; }
  };
  if (saved) { nb.model=saved.model; nb.trained=saved.trained; nb.trainCount=saved.trainCount||0; }
  return nb;
}

function predictFromTrees(trees, lr, x) {
  let F = 0.5;
  trees.forEach(t => { F += lr * (x[t.fi] <= t.th ? t.lVal : t.rVal); });
  return Math.max(0, Math.min(1, F));
}

function makeGBM(saved) {
  const gbm = {
    trees: [], lr: 0.1, trained: false, accuracy: 0, accuracyOOS: 0,

    buildStump(X, residuals) {
      const nF = X[0].length;
      let bestGain=-Infinity, best=null;
      for (let fi=0;fi<nF;fi++) {
        const vals = X.map(x=>x[fi]).sort((a,b)=>a-b);
        for (let ti=1;ti<5;ti++) {
          const th = vals[Math.floor(ti*vals.length/5)];
          const left=[], right=[];
          X.forEach((x,i) => (x[fi]<=th?left:right).push(residuals[i]));
          if (!left.length||!right.length) continue;
          const lM=left.reduce((a,b)=>a+b,0)/left.length;
          const rM=right.reduce((a,b)=>a+b,0)/right.length;
          const gain=left.length*lM*lM+right.length*rM*rM;
          if (gain>bestGain) { bestGain=gain; best={fi,th,lVal:lM,rVal:rM}; }
        }
      }
      return best;
    },

    trainFromTrades(trades) {
      if (trades.length < 20) return false;
      const X=[], y=[];
      trades.forEach(t => { if (t.gbmFeatures&&t.gbmFeatures.length===12) { X.push(t.gbmFeatures); y.push(t.pnl>0?1:0); } });
      if (X.length < 20) return false;
      const si = Math.floor(X.length*0.7);
      // train = najstarsze 70% (chronologicznie pierwsze), OOS = najnowsze 30% (nieznane podczas treningu)
      // trades posortowane najnowszy→najstarszy, więc X[0]=najnowszy → slice(si) = stare, slice(0,si) = nowe
      const Xt=X.slice(si), yt=y.slice(si);
      const Xoos=X.slice(0,si), yoos=y.slice(0,si);
      this.trees=[];
      let F = new Array(Xt.length).fill(0.5);
      for (let t=0;t<20;t++) {
        const res = yt.map((yi,i)=>yi-F[i]);
        const tree = this.buildStump(Xt, res);
        if (!tree) break;
        this.trees.push(tree);
        F = F.map((fi,i)=>fi+this.lr*(Xt[i][tree.fi]<=tree.th?tree.lVal:tree.rVal));
      }
      const ok = F.filter((f,i)=>(f>0.5?1:0)===yt[i]).length;
      this.accuracy = +(ok/Xt.length*100).toFixed(1);
      let oosOk = 0;
      for (let i = 0; i < Xoos.length; i++) {
        const pred = predictFromTrees(this.trees, this.lr, Xoos[i]);
        if ((pred > 0.5 ? 1 : 0) === yoos[i]) oosOk++;
      }
      this.accuracyOOS = Xoos.length > 0 ? +(oosOk / Xoos.length * 100).toFixed(1) : 0;
      this.trained = true;
      return true;
    },

    predict(x) {
      if (!this.trained||!this.trees.length) return 0.5;
      let F=0.5;
      this.trees.forEach(t => { F+=this.lr*(x[t.fi]<=t.th?t.lVal:t.rVal); });
      return Math.max(0,Math.min(1,F));
    },

    save() { return { trees:this.trees, trained:this.trained, accuracy:this.accuracy, accuracyOOS:this.accuracyOOS||0 }; }
  };
  if (saved) { gbm.trees=saved.trees||[]; gbm.trained=saved.trained||false; gbm.accuracy=saved.accuracy||0; gbm.accuracyOOS=saved.accuracyOOS||0; }
  return gbm;
}

function makeQL(saved) {
  const ql = {
    Q: {}, alpha:0.15, gamma:0.90, epsilon:0.10, trained:false, updates:0,

    stateKey(sig) {
      const r = sig.rsiD<=30?0:sig.rsiD<=45?1:sig.rsiD<=60?2:3;
      const m = sig.macdHist>0?1:0;
      const t = sig.trendD+1;
      const o = sig.obiRatio ? (sig.obiRatio>=0.58?2:sig.obiRatio<=0.42?0:1) : 1;
      const b = sig.bbPos<0.25?0:sig.bbPos<0.5?1:2;
      return r+'_'+m+'_'+t+'_'+o+'_'+b;
    },

    initState(k) { if (!this.Q[k]) this.Q[k]={BUY:0,HOLD:0}; },

    update(sig, action, reward, nextSig) {
      if (!sig) return;
      const k = this.stateKey(sig);
      this.initState(k);
      const old = this.Q[k][action];
      let maxN;
      if (nextSig) {
        const nk=this.stateKey(nextSig); this.initState(nk);
        maxN=Math.max(this.Q[nk].BUY,this.Q[nk].HOLD);
      } else {
        maxN=Math.max(this.Q[k].BUY,this.Q[k].HOLD);
      }
      this.Q[k][action]=old+this.alpha*(reward+this.gamma*maxN-old);
      this.updates++;
      this.trained=this.updates>=10;
      this.epsilon=Math.max(0.10,0.30-this.updates*0.001);
    },

    suggests(sig) {
      if (!this.trained) return null;
      const k=this.stateKey(sig); this.initState(k);
      const diff=this.Q[k].BUY-this.Q[k].HOLD;
      return { action:diff>0?'BUY':'HOLD', confidence:Math.abs(diff), qBuy:+this.Q[k].BUY.toFixed(4), qHold:+this.Q[k].HOLD.toFixed(4) };
    },

    save() { return { Q:this.Q, updates:this.updates, epsilon:this.epsilon }; }
  };
  if (saved) { ql.Q=saved.Q||{}; ql.updates=saved.updates||0; ql.epsilon=saved.epsilon||0.10; ql.trained=ql.updates>=10; }
  return ql;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WSKAŹNIKI TECHNICZNE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function emaArr(arr, p) {
  if (!arr||!arr.length) return [0];
  const k=2/(p+1);
  if (arr.length<p) { const sma=arr.reduce((a,b)=>a+b,0)/arr.length; return arr.map(()=>sma); }
  let prev=arr.slice(0,p).reduce((a,b)=>a+b,0)/p;
  const o=new Array(p).fill(prev);
  for (let i=p;i<arr.length;i++) { prev=arr[i]*k+prev*(1-k); o.push(prev); }
  return o;
}
function emaLast(arr, p) { const a=emaArr(arr,p); return a.length?a.at(-1):0; }

function rsi(c, p=14) {
  if (c.length<p+1) return 50;
  let avgG=0,avgL=0;
  for (let i=1;i<=p;i++) { const d=c[i]-c[i-1]; if(d>0)avgG+=d; else avgL-=d; }
  avgG/=p; avgL/=p;
  for (let i=p+1;i<c.length;i++) {
    const d=c[i]-c[i-1];
    if(d>0){avgG=(avgG*(p-1)+d)/p;avgL=avgL*(p-1)/p;}
    else{avgG=avgG*(p-1)/p;avgL=(avgL*(p-1)-d)/p;}
  }
  if (avgL===0) return avgG>0?100:50;
  const ratio=avgG/avgL;
  if (!isFinite(ratio)) return 50;
  return 100-100/(1+ratio);
}

function rsiArray(closes, period=14) {
  const n=closes.length, result=new Array(n).fill(50);
  if (n<period+1) return result;
  let avgG=0,avgL=0;
  for (let i=1;i<=period;i++){const d=closes[i]-closes[i-1];if(d>0)avgG+=d;else avgL-=d;}
  avgG/=period; avgL/=period;
  const rv=avgL===0?(avgG>0?100:50):100-100/(1+avgG/avgL);
  result[period]=isFinite(rv)?rv:50;
  for (let j=period+1;j<n;j++){
    const dj=closes[j]-closes[j-1];
    if(dj>0){avgG=(avgG*(period-1)+dj)/period;avgL=avgL*(period-1)/period;}
    else{avgG=avgG*(period-1)/period;avgL=(avgL*(period-1)-dj)/period;}
    const rv2=avgL===0?(avgG>0?100:50):100-100/(1+avgG/avgL);
    result[j]=isFinite(rv2)?rv2:50;
  }
  return result;
}

function rsiDivergence(prices, rsiArr, lookback=20) {
  const n = prices.length;
  if (n < lookback) return { bull: false, bear: false };
  const pS = prices.slice(-lookback), rS = rsiArr.slice(-lookback);
  const len = pS.length;
  const localMins = [], localMaxs = [];
  for (let i = 1; i < len - 1; i++) {
    if (pS[i] < pS[i-1] && pS[i] < pS[i+1]) localMins.push(i);
    if (pS[i] > pS[i-1] && pS[i] > pS[i+1]) localMaxs.push(i);
  }
  let bull = false, bear = false;
  if (localMins.length >= 2) {
    const i1 = localMins[localMins.length - 2];
    const i2 = localMins[localMins.length - 1];
    if (pS[i2] < pS[i1] * 0.999 && rS[i2] > rS[i1] + 3) bull = true;
  }
  if (localMaxs.length >= 2) {
    const i1 = localMaxs[localMaxs.length - 2];
    const i2 = localMaxs[localMaxs.length - 1];
    if (pS[i2] > pS[i1] * 1.001 && rS[i2] < rS[i1] - 3) bear = true;
  }
  return { bull, bear };
}

function macdFull(c) {
  if (c.length<35) return {line:0,signal:0,hist:0};
  const e12=emaArr(c,12), e26=emaArr(c,26);
  const ml=e12.map((v,i)=>i<26?0:v-e26[i]);
  const sl=emaArr(ml.slice(26),9);
  const n=ml.length-1, sn=sl.length-1;
  return {line:ml[n], signal:sn>=0?sl[sn]:0, hist:ml[n]-(sn>=0?sl[sn]:0)};
}

function bband(c, p=20) {
  if (!c||!c.length) return {upper:0,mid:0,lower:0,pos:0.5};
  if (c.length<p) {const v=c.at(-1)||0;return{upper:v*1.02,mid:v,lower:v*0.98,pos:0.5};}
  const sl=c.slice(-p), m=sl.reduce((a,b)=>a+b,0)/p;
  // Standardowa definicja Bollinger Bands uzywa odchylenia POPULACYJNEGO (dzielenie
  // przez p), nie probkowego (p-1). Ta sama poprawka co w swingai-bot/MEXC.
  const std=Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/p);
  const up=m+2*std, lo=m-2*std;
  const pos=up===lo?0.5:Math.max(0,Math.min(1,(c.at(-1)-lo)/(up-lo)));
  return {upper:up,mid:m,lower:lo,pos,range:up-lo};
}

function atr(h, l, c, p=14) {
  if (h.length<p+1) return 0;
  const trs=[];
  for (let i=1;i<h.length;i++) trs.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
  if (trs.length<p) return trs.reduce((a,b)=>a+b,0)/(trs.length||1);
  // Kanoniczne wygladzanie Wildera zamiast prostej sredniej kroczacej - ta sama
  // poprawka co w swingai-bot/MEXC (wplywa na obliczane TP/SL/trailing).
  let a = trs.slice(0,p).reduce((x,y)=>x+y,0)/p;
  for (let i=p;i<trs.length;i++) a = (a*(p-1)+trs[i])/p;
  return a;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MARKET DATA — GATE.IO (public, no auth)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function fetchWithTimeout(url, ms, opts) {
  ms = ms || 8000;
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  const options = { signal: ctrl.signal, ...(opts || {}) };
  return fetch(url, options).finally(() => clearTimeout(tid));
}

async function getKlines(sym, interval, limit) {
  // Kraken public API — nie blokuje CF Workers
  const ivMap = { 'D':'1440', '240':'240', '60':'60', '30':'30', '15':'15', '5':'5', '1':'1' };
  const iv = ivMap[interval] || '1440';
  const r = await fetchWithTimeout(
    `https://api.kraken.com/0/public/OHLC?pair=${sym}&interval=${iv}&count=${limit}`
  );
  if (!r.ok) throw new Error('getKlines HTTP ' + r.status + ' ' + sym);
  const d = await r.json();
  if (d.error && d.error.length > 0) throw new Error('getKlines Kraken: ' + d.error[0] + ' ' + sym);
  const key = Object.keys(d.result || {}).find(k => k !== 'last');
  if (!key) throw new Error('getKlines: brak danych ' + sym);
  const list = d.result[key];
  if (!Array.isArray(list) || list.length === 0) throw new Error('getKlines: pusta lista ' + sym);
  // Kraken: [time, open, high, low, close, vwap, volume, count]
  return list.map(k => [+k[0]*1000, +k[1], +k[2], +k[3], +k[4], +k[6]]);
}

async function getLastPrice(sym) {
  const r = await fetchWithTimeout(`https://api.kraken.com/0/public/Ticker?pair=${sym}`);
  if (!r.ok) throw new Error('getPrice HTTP ' + r.status);
  const d = await r.json();
  if (d.error && d.error.length > 0) throw new Error('getPrice Kraken: ' + d.error[0]);
  const key = Object.keys(d.result || {})[0];
  if (!key) throw new Error('getPrice: brak danych ' + sym);
  return +d.result[key].c[0];
}

async function getOrderbook(sym) {
  try {
    const r = await fetchWithTimeout(`https://api.kraken.com/0/public/Depth?pair=${sym}&count=20`);
    if (!r.ok) return { ratio: 0.5 };
    const d = await r.json();
    if (d.error && d.error.length > 0) return { ratio: 0.5 };
    const key = Object.keys(d.result || {})[0];
    if (!key) return { ratio: 0.5 };
    const bids = d.result[key].bids.reduce((s, x) => s + +x[1], 0);
    const asks = d.result[key].asks.reduce((s, x) => s + +x[1], 0);
    const total = bids + asks;
    return { ratio: total > 0 ? bids / total : 0.5, bids, asks };
  } catch(e) { return { ratio: 0.5 }; }
}

function calcOBI(obiData) {
  const r = obiData.ratio || 0.5;
  if (r >= 0.65) return 4;
  if (r >= 0.58) return 2;
  if (r <= 0.35) return -4;
  if (r <= 0.42) return -2;
  return 0;
}

async function getFearGreed(state) {
  const cache = state.lastFG || { val: 50, label: 'Neutral', ts: 0 };
  if (Date.now() - (cache.ts || 0) < 3600000) return cache;
  try {
    const r = await fetchWithTimeout('https://api.alternative.me/fng/?limit=1', 5000);
    const d = await r.json();
    if (!d.data || !d.data[0]) return cache;
    const val = +d.data[0].value;
    if (!isFinite(val)) return cache;
    const fg = { val, label: d.data[0].value_classification || 'Neutral', ts: Date.now() };
    state.lastFG = fg;
    return fg;
  } catch(e) { return cache; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REVOLUT X TRADING — Ed25519 signing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Mapuj XBTUSDT (Kraken) → BTC/USDC (format Revolut X handel)
function revxInstrument(sym) {
  return sym.replace('XBT','BTC').replace('USDT','/USDC');
}

// Wczytaj Ed25519 PKCS8 PEM klucz prywatny
async function revxImportKey(privKeyB64OrPem) {
  let pem = privKeyB64OrPem;
  // Jeśli to base64 bez nagłówka PEM — dodaj nagłówek
  if (!pem.includes('-----BEGIN')) {
    pem = '-----BEGIN PRIVATE KEY-----\n' + pem + '\n-----END PRIVATE KEY-----';
  }
  // Usuń nagłówki i whitespace, zdekoduj base64 → ArrayBuffer
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey(
    'pkcs8',
    buf.buffer,
    { name: 'Ed25519' },
    false,
    ['sign']
  );
}

// Podpisz wiadomość Ed25519, zwróć base64
async function revxSign(message, privKey) {
  const msgBuf = new TextEncoder().encode(message);
  const sigBuf = await crypto.subtle.sign({ name: 'Ed25519' }, privKey, msgBuf);
  return btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
}

// Wykonaj zapytanie do Revolut X API z odpowiednimi nagłówkami
async function revxRequest(method, path, body, cfg) {
  const timestamp = String(Date.now());
  // Signature message: "${timestamp}.${METHOD}.${path}${body ? '.' + JSON.stringify(body) : ''}"
  const sigMsg = timestamp + method + path + (body ? JSON.stringify(body) : '');

  let privKey;
  try {
    privKey = await revxImportKey(cfg.revxPrivKey);
  } catch(e) {
    throw new Error('Revolut X: nieprawidlowy klucz prywatny — ' + e.message);
  }

  const signature = await revxSign(sigMsg, privKey);

  const headers = {
    'Content-Type':     'application/json',
    'X-Revx-API-Key':   cfg.revxApiKey,
    'X-Revx-Timestamp': timestamp,
    'X-Revx-Signature': signature
  };

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const r = await fetchWithTimeout(REVX_BASE + path, 10000, opts);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { data = text; }
  if (!r.ok) {
    throw new Error('Revolut X ' + method + ' ' + path + ' HTTP ' + r.status + ': ' + (typeof data === 'object' ? JSON.stringify(data) : text).slice(0, 200));
  }
  return data;
}

// Pobierz saldo USDC z Revolut X
async function revxGetBalance(cfg) {
  const accounts = await revxRequest('GET', '/accounts', null, cfg);
  if (!Array.isArray(accounts)) throw new Error('Revolut X balance: nieprawidlowa odpowiedz');
  const usdc = accounts.find(a => a.currency === 'USDC');
  return usdc ? +usdc.balance : 0;
}

// Market BUY — kupuje za quoteSize USDC
async function revxMarketBuy(sym, quoteSize, cfg) {
  const instrument_code = revxInstrument(sym);
  const body = {
    instrument_code,
    side: 'BUY',
    type: 'MARKET',
    quote_size: quoteSize.toFixed(2)
  };
  const order = await revxRequest('POST', '/orders', body, cfg);
  if (!order.id) throw new Error('Revolut X buy: brak order.id — ' + JSON.stringify(order));

  // Poczekaj chwilę, pobierz szczegóły zlecenia
  await sleep(1500);
  let details;
  try {
    details = await revxRequest('GET', '/orders/' + order.id, null, cfg);
  } catch(e) {
    // Jeśli pobranie szczegółów się nie powiodło — użyj danych z odpowiedzi create
    details = order;
  }

  const avgPrice = details.average_price ? +details.average_price : 0;
  const filledQty = details.filled_base_size ? +details.filled_base_size : (quoteSize / (avgPrice || 1));
  return { price: avgPrice, qty: filledQty, orderId: order.id };
}

// Market SELL — sprzedaje baseSize jednostek (np. BTC)
async function revxMarketSell(sym, baseQty, cfg) {
  const instrument_code = revxInstrument(sym);
  // Revolut X wymaga precyzji — ogranicz do rozsądnej liczby miejsc po przecinku
  const baseSizeStr = baseQty.toFixed(8).replace(/\.?0+$/, '') || '0';
  const body = {
    instrument_code,
    side: 'SELL',
    type: 'MARKET',
    base_size: baseSizeStr
  };
  const order = await revxRequest('POST', '/orders', body, cfg);
  if (!order.id) throw new Error('Revolut X sell: brak order.id — ' + JSON.stringify(order));
  return true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TELEGRAM
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function tgSend(cfg, msg) {
  if (!cfg.tgToken || !cfg.tgChat) return;
  try {
    await fetchWithTimeout(`https://api.telegram.org/bot${cfg.tgToken}/sendMessage`, 8000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.tgChat, text: msg, parse_mode: 'HTML' })
    });
  } catch(e) {}
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// KV HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function getConfig(env) {
  try { const c = await env.SWINGAI_REVOLUT_KV.get('config'); return c ? JSON.parse(c) : defaultConfig(); }
  catch(e) { return defaultConfig(); }
}
async function getState(env) {
  try { const s = await env.SWINGAI_REVOLUT_KV.get('state'); return s ? JSON.parse(s) : defaultState(); }
  catch(e) { return defaultState(); }
}

function defaultConfig() {
  return {
    active: false, mode: 'paper',
    // Day trading: dużo ciaśniejsze poziomy niż w wersji swingowej (tam 12%/5%/6%) -
    // pozycje trzymane w ciągu jednego dnia, nie tygodni, więc oczekiwany ruch ceny
    // jest odpowiednio mniejszy. Wartości startowe, do kalibracji na realnych danych.
    tp: 0.02, sl: 0.01, trail: 0.008,
    maxPos: 4, posSize: 15, riskPct: 2,
    paperBalance: 1000, minScore: 58, fgMin: 20,
    revxApiKey: '', revxPrivKey: '',
    tgToken: '', tgChat: ''
  };
}

function defaultState() {
  return {
    positions: [], trades: [], log: [], iter: 0,
    dailyPnl: 0, dailyStartBalance: 0, dailyDate: '',
    paperBalance: 1000, liveBalance: null,
    consLoss: 0, globalBlockUntil: 0, cooldown: {},
    lastCycle: null, lastFG: { val: 50, label: 'Neutral', ts: 0 },
    lastSigs: [],
    nb: null, gbm: null, ql: null, ensembleW: null,
    pairParams: {}, adaptiveMinScore: 58,
    peakBalance: 0, peakBalanceMode: 'paper',
    drawdownBlock: 0, stats: null,
    lastGbmRefit: 0
  };
}

function addLog(state, msg, type='info') {
  state.log = [{ ts: new Date().toISOString(), msg, type }, ...(state.log||[])].slice(0, 60);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  };
}

function jsonResp(data, status=200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function redirectHTML(msg) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="2;url=/">
<style>body{background:#020810;color:#00e5a0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:1.4em;flex-direction:column;gap:12px;}</style>
</head><body><div>${msg}</div><div style="color:#334d74;font-size:0.5em">Przekierowanie za 2 sekundy...</div></body></html>`;
}


