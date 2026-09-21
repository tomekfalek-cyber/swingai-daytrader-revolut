// SwingAI Bot 24/7 — Cloudflare Worker — REVOLUT X VERSION
// Multi-TF DAY TRADING (1H+15min+5min), NB+GBM+QL, SMC, PATTERNS, Kelly, ATR-TP/SL, CORR, OBI
// Market data: Revolut X public API (revx.revolut.com/api/1.0/public/*) | Execution: Revolut X (Ed25519)
// Dane i egzekucja z JEDNEJ gieldy (Revolut X) - zero rozjazdu miedzy cena analizy
// a cena wykonania, i zero kolizji limitu zapytan z botem MEXC/swing (ktory uzywa
// Krakena) dzialajacym na tym samym koncie Cloudflare.

// ═══════════════════════════════════════════════════════════════════════════
// KONFIGURACJA
// ═══════════════════════════════════════════════════════════════════════════
const PAIRS = ['XBTUSDT','ETHUSDT','SOLUSDT','XRPUSDT','PEPEUSDT'];

// FIX #1: Realna stawka taker na Revolut X to 0.09% (0.0009), NIE 0.2%.
// Poprzednia wartosc 0.002 zawyzala koszty 2.2x, co systematycznie odrzucalo
// zyskownych kandydatow (gate'y R:R, break-even SL, Kelly sizing), bo bot
// liczyl, ze transakcja musi zarobic duzo wiecej, niz realnie potrzebuje.
const FEE = 0.0009;

// FIX #2: Modelowanie poslizgu (slippage) w trybie paper. W trybie live
// slippage jest naturalnie wliczony, bo uzywamy realnej ceny fill z Revolut X.
const SLIPPAGE_PAPER = 0.0005;

// FIX #3: Minimalny oczekiwany zysk netto (po kosztach) zanim otworzymy pozycje.
const MIN_COST_COVERAGE_RATIO = 3.0;

const TIMEOUT_MS = 8 * 3600000; // 8h day trading

const CORR_GROUPS = [
  ['XBTUSDT'],
  ['ETHUSDT'],
  ['SOLUSDT','AVAXUSDT'],
  ['XRPUSDT','ADAUSDT'],
  ['DOGEUSDT'],
  ['LINKUSDT'],
  ['PEPEUSDT']
];

const PAIR_PARAMS_DEFAULT = {
  'XBTUSDT':  { minScore:66 },
  'ETHUSDT':  { minScore:64 },
  'SOLUSDT':  { minScore:62 },
  'XRPUSDT':  { minScore:62 },
  'DOGEUSDT': { minScore:64 },
  'ADAUSDT':  { minScore:62 },
  'AVAXUSDT': { minScore:62 },
  'LINKUSDT': { minScore:62 },
  'PEPEUSDT': { tp:0.035, sl:0.018, minScore:68 }
};

const REVX_BASE = 'https://revx.revolut.com/api/1.0';

// ═══════════════════════════════════════════════════════════════════════════
// GŁÓWNY HANDLER
// ═══════════════════════════════════════════════════════════════════════════
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBotCycle(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const PIN_PATHS = ['/verify-pin', '/change-pin', '/session-check', '/clear-stats', '/journal'];
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: PIN_PATHS.includes(url.pathname) ? pinCorsHeaders(request) : corsHeaders() });

    const AUTH_SECRET = env.AUTH_SECRET || null;
    const authHeader  = request.headers.get('Authorization') || '';
    const authParam   = url.searchParams.get('auth') || '';
    const isAuth = !!AUTH_SECRET && (authHeader === 'Bearer ' + AUTH_SECRET || authParam === AUTH_SECRET);
    const publicPaths = ['/', '/state-public', '/market', ...PIN_PATHS];
    if (!isAuth && !publicPaths.includes(url.pathname)) {
      return new Response('Unauthorized', { status: 401, headers: corsHeaders() });
    }

    if (url.pathname === '/verify-pin' && request.method === 'POST') {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rl = await checkPinRateLimit(env, ip);
      if (rl.blocked) return pinJsonResp({ ok:false, error:'Za wiele nieudanych prob. Sprobuj za 15 minut.' }, 429, request);
      let pin = '';
      try { const body = await request.json(); pin = String(body.pin || ''); } catch(e) {}
      const storedHash = await env.SWINGAI_REVOLUT_KV.get('pinHash');
      const inputHash  = await sha256Hex(pin);
      if (!storedHash || inputHash !== storedHash) {
        await recordPinFail(env, rl.key);
        return pinJsonResp({ ok:false, error:'Nieprawidlowy PIN' }, 401, request);
      }
      await clearPinFail(env, rl.key);
      const sid = randomToken(32);
      await env.SWINGAI_REVOLUT_KV.put('sess_' + sid, '1', { expirationTtl: 30 * 24 * 3600 });
      const headers = Object.assign({ 'Content-Type': 'application/json' }, pinCorsHeaders(request));
      headers['Set-Cookie'] = 'swingai_sess=' + sid + '; Path=/; Max-Age=' + (30*24*3600) + '; HttpOnly; Secure; SameSite=None';
      return new Response(JSON.stringify({ ok:true }), { headers });
    }

    if (url.pathname === '/session-check') {
      const ok = await isValidSession(env, request);
      return pinJsonResp({ ok }, 200, request);
    }

    if (url.pathname === '/change-pin' && request.method === 'POST') {
      const sessionOk = await isValidSession(env, request);
      if (!sessionOk) return pinJsonResp({ ok:false, error:'Sesja wygasla — zaloguj sie ponownie' }, 401, request);
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rl = await checkPinRateLimit(env, ip);
      if (rl.blocked) return pinJsonResp({ ok:false, error:'Za wiele nieudanych prob. Sprobuj za 15 minut.' }, 429, request);
      let oldPin = '', newPin = '';
      try { const body = await request.json(); oldPin = String(body.oldPin || ''); newPin = String(body.newPin || ''); } catch(e) {}
      if (!/^\d{8}$/.test(newPin)) return pinJsonResp({ ok:false, error:'Nowy PIN musi miec 8 cyfr' }, 400, request);
      const storedHash = await env.SWINGAI_REVOLUT_KV.get('pinHash');
      const oldHash    = await sha256Hex(oldPin);
      if (!storedHash || oldHash !== storedHash) {
        await recordPinFail(env, rl.key);
        return pinJsonResp({ ok:false, error:'Aktualny PIN nieprawidlowy' }, 401, request);
      }
      await clearPinFail(env, rl.key);
      const newHash = await sha256Hex(newPin);
      await env.SWINGAI_REVOLUT_KV.put('pinHash', newHash);
      return pinJsonResp({ ok:true }, 200, request);
    }

    if (url.pathname === '/clear-stats' && request.method === 'POST') {
      const sessionOk = await isValidSession(env, request);
      if (!sessionOk) return pinJsonResp({ ok:false, error:'Sesja wygasla — zaloguj sie ponownie' }, 401, request);
      const cfg = await getConfig(env);
      const state = await getState(env);
      state.trades = [];
      state.stats = null;
      state.nb = null;
      state.gbm = null;
      state.ql = null;
      state.ensembleW = null;
      state.pairParams = {};
      state.adaptiveMinScore = cfg.minScore;
      state.dailyPnl = 0;
      state.dailyStartBalance = 0;
      state.peakBalance = 0;
      state.drawdownBlock = 0;
      state.consLoss = 0;
      state.cooldown = {};
      state.globalBlockUntil = 0;
      state.lastGbmRefit = 0;
      // BUG FIX #1: reset markera ensemble rebalansowania razem z calym state
      state.lastEnsembleRebalance = 0;
      addLog(state, 'Statystyki i modele AI wyczyszczone recznie (pozycje i config bez zmian)', 'warn');
      await env.SWINGAI_REVOLUT_KV.put('state', JSON.stringify(state));
      return pinJsonResp({ ok:true }, 200, request);
    }

    if (url.pathname === '/journal') {
      const state = await getState(env);
      const limit = parseInt(url.searchParams.get('limit') || '100');
      const entries = (state.journal || []).slice(0, limit);
      const fmt = url.searchParams.get('format');
      if (fmt === 'text') {
        return new Response(entries.map(e => formatJournalForText(e)).join('\n\n'), {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', ...pinCorsHeaders(request) }
        });
      }
      return pinJsonResp({ ok:true, count: entries.length, entries }, 200, request);
    }

    if (url.pathname === '/') {
      return new Response(
        '<meta http-equiv="refresh" content="0;url=https://tomekfalek-cyber.github.io/swingai-revolut/">',
        { headers: { 'Content-Type': 'text/html', ...corsHeaders() } }
      );
    }

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
        gbmAccuracyOOS: (state.gbm && state.gbm.accuracyOOS) || null,
        journalRecent: (state.journal || []).slice(0, 20)
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
      if (request.method !== 'POST') return new Response('Method Not Allowed - uzyj POST z JSON body', { status: 405, headers: corsHeaders() });
      let p = {};
      try { p = await request.json(); } catch(e) {}
      const cfg = defaultConfig();
      cfg.active = true; cfg.mode = 'live'; cfg.startedAt = Date.now();
      cfg.revxApiKey  = p.key   || '';
      cfg.revxPrivKey = p.priv  || '';
      cfg.tp    = parseFloat(p.tp   ?? 2) / 100;
      cfg.sl    = parseFloat(p.sl   ?? 1)  / 100;
      cfg.trail = parseFloat(p.trail ?? 0.8)  / 100;
      cfg.minScore = parseInt(p.score ?? 58);
      cfg.maxPos   = parseInt(p.maxp  ?? 4);
      cfg.posSize  = parseFloat(p.size ?? 15);
      cfg.riskPct  = parseFloat(p.riskPct ?? 2);
      cfg.fgMin    = parseInt(p.fgMin ?? 20);
      cfg.tgToken  = p.tg   || '';
      cfg.tgChat   = p.tgc  || '';
      const oldCfg = await getConfig(env);
      if (!cfg.revxApiKey  && oldCfg.revxApiKey)  cfg.revxApiKey  = oldCfg.revxApiKey;
      if (!cfg.revxPrivKey && oldCfg.revxPrivKey) cfg.revxPrivKey = oldCfg.revxPrivKey;
      if (!cfg.tgToken && oldCfg.tgToken)         cfg.tgToken     = oldCfg.tgToken;
      if (!cfg.tgChat  && oldCfg.tgChat)          cfg.tgChat      = oldCfg.tgChat;
      await env.SWINGAI_REVOLUT_KV.put('config', JSON.stringify(cfg));
      const oldState = await getState(env);
      const freshState = defaultState();
      freshState.nb  = oldState.nb  || null;
      freshState.gbm = oldState.gbm || null;
      freshState.ql  = oldState.ql  || null;
      freshState.peakBalance = 0;
      freshState.peakBalanceMode = 'live';
      await env.SWINGAI_REVOLUT_KV.put('state', JSON.stringify(freshState));
      ctx.waitUntil(runBotCycle(env));
      return new Response(redirectHTML('Bot LIVE (Revolut X) uruchomiony!'), { headers: {'Content-Type':'text/html;charset=utf-8'} });
    }

    if (url.pathname === '/save-config') {
      if (request.method !== 'POST') return new Response('Method Not Allowed - uzyj POST z JSON body', { status: 405, headers: corsHeaders() });
      let p = {};
      try { p = await request.json(); } catch(e) {}
      const cfg = await getConfig(env);
      if (p.mode === 'paper' || p.mode === 'live') cfg.mode = p.mode;
      if (p.key)   cfg.revxApiKey  = p.key;
      if (p.priv)  cfg.revxPrivKey = p.priv;
      if (p.tg)    cfg.tgToken     = p.tg;
      if (p.tgc)   cfg.tgChat      = p.tgc;
      if (p.tp    !== undefined) cfg.tp       = parseFloat(p.tp)    / 100;
      if (p.sl    !== undefined) cfg.sl       = parseFloat(p.sl)    / 100;
      if (p.trail !== undefined) cfg.trail    = parseFloat(p.trail) / 100;
      if (p.score !== undefined) cfg.minScore = parseInt(p.score);
      if (p.maxp  !== undefined) cfg.maxPos   = parseInt(p.maxp);
      if (p.size  !== undefined) cfg.posSize  = parseFloat(p.size);
      if (p.riskPct !== undefined) cfg.riskPct = parseFloat(p.riskPct);
      if (p.fgMin   !== undefined) cfg.fgMin   = parseInt(p.fgMin);
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
              text: 'Witaj! SwingAI Bot 24/7 — Revolut X aktywny.\n\nPolaczenie dziala.\nPary: BTC ETH SOL XRP PEPE\nSkany co 3 min przez Cloudflare Worker.',
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

    if (url.pathname === '/market') {
      const path = url.searchParams.get('path') || '';
      const qs   = url.searchParams.get('qs')   || '';
      if (path.includes('..') || qs.includes('..')) {
        return new Response('Forbidden', { status: 403, headers: corsHeaders() });
      }
      const qsParams = new URLSearchParams(qs);
      try {
        if (path.startsWith('/1.0/public/candles/')) {
          const symPart = path.slice('/1.0/public/candles/'.length);
          const base = (symPart.split('/')[0] || 'BTC').toUpperCase();
          const bybSym = base + 'USDT';
          const ivMin = qsParams.get('interval') || '5';
          const bybUrl = `${BYBIT_BASE}/v5/market/kline?category=spot&symbol=${bybSym}&interval=${ivMin}&limit=200`;
          const r = await fetchWithTimeout(bybUrl, 8000, { headers: { 'User-Agent': 'SwingAI/1.0' } });
          const d = await r.json();
          const list = (d.result && d.result.list) || [];
          const rows = list.slice().reverse().map(k => ({ start: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
          return new Response(JSON.stringify({ data: rows }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
        }
        if (path.startsWith('/1.0/public/tickers')) {
          const symParam = qsParams.get('symbols') || 'BTC/USDC';
          const base = (symParam.split('/')[0] || 'BTC').toUpperCase();
          const bybSym = base + 'USDT';
          const bybUrl = `${BYBIT_BASE}/v5/market/tickers?category=spot&symbol=${bybSym}`;
          const r = await fetchWithTimeout(bybUrl, 8000, { headers: { 'User-Agent': 'SwingAI/1.0' } });
          const d = await r.json();
          const t = (d.result && d.result.list && d.result.list[0]) || null;
          if (!t) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
          const last = +t.lastPrice;
          const chgPct = +(t.price24hPcnt || 0) * 100;
          const priceChange24h = last - (last / (1 + chgPct / 100));
          return new Response(JSON.stringify({ data: [{ symbol: symParam, bid: t.bid1Price, ask: t.ask1Price, mid: last, last_price: last, low_24h: t.lowPrice24h, high_24h: t.highPrice24h, price_change_24h: priceChange24h, volume_24h: t.volume24h }] }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
        }
        if (path.startsWith('/2.0/public/order-book/')) {
          const symPart = path.slice('/2.0/public/order-book/'.length);
          const base = (symPart.split('/')[0] || 'BTC').toUpperCase();
          const bybSym = base + 'USDT';
          const limit = qsParams.get('limit') || '20';
          const bybUrl = `${BYBIT_BASE}/v5/market/orderbook?category=spot&symbol=${bybSym}&limit=${limit}`;
          const r = await fetchWithTimeout(bybUrl, 8000, { headers: { 'User-Agent': 'SwingAI/1.0' } });
          const d = await r.json();
          const bk = d.result || {};
          const bids = (bk.b || []).map(x => ({ price: x[0], quantity: x[1] }));
          const asks = (bk.a || []).map(x => ({ price: x[0], quantity: x[1] }));
          return new Response(JSON.stringify({ data: { bids, asks } }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
        }
        return new Response('Forbidden', { status: 403, headers: corsHeaders() });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
      }
    }

    return new Response('SwingAI Revolut X Worker — OK', { headers: corsHeaders() });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GŁÓWNA LOGIKA CYKLU
// ═══════════════════════════════════════════════════════════════════════════
async function runBotCycle(env) {
  const cfg   = await getConfig(env);
  if (!cfg.active) return;
  const state = await getState(env);

  const lockKey = 'bot_running_lock';
  const lockVal = await env.SWINGAI_REVOLUT_KV.get(lockKey);
  if (lockVal) {
    console.log('Bot already running, skipping cycle');
    return;
  }
  await env.SWINGAI_REVOLUT_KV.put(lockKey, '1', { expirationTtl: 480 });
  try {

  state.iter  = (state.iter || 0) + 1;
  addLog(state, '--- Skan #' + state.iter + ' ---');

  const todayUTC = new Date().toISOString().slice(0, 10);
  if (state.dailyDate !== todayUTC) {
    state.dailyDate         = todayUTC;
    state.dailyPnl          = 0;
    state.dailyStartBalance = 0;
  }

  const currentBalance = cfg.mode === 'live'
    ? (state.liveBalance > 0 ? state.liveBalance : (cfg.paperBalance || 1000))
    : (state.paperBalance > 0 ? state.paperBalance : (cfg.paperBalance || 1000));

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
    state.drawdownBlock = Date.now() + 6 * 3600000;
    addLog(state, 'Circuit breaker: -15% drawdown — blokada BUY 6h', 'err');
  }

  const nb  = makeNB(state.nb);
  const gbm = makeGBM(state.gbm);
  const ql  = makeQL(state.ql);
  const ew  = state.ensembleW || { score:1, nb:0.8, gbm:0.9, obi:0.3, ql:0.5 };
  const pairParams = state.pairParams || {};
  const adaptiveMinScore = state.adaptiveMinScore || cfg.minScore;

  try {
    const fg = await getFearGreed(state);

    const btcInfo = await btcDropGuard();
    const btcDrop = btcInfo.drop;
    if (btcDrop) addLog(state, 'BTC Guard aktywny — brak nowych long na altcoinach', 'warn');
    if (btcInfo.pump) addLog(state, 'BTC Guard (pump) aktywny — brak nowych SHORT na altcoinach', 'warn');

    await checkPositions(cfg, state, env, ql);

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
      buy: s.buy, shortSignal: s.shortSignal, why: s.why,
      patterns: (s.patterns||[]).map(p => p.name),
      aiMethod: s.aiMethod, regime: s.regime || 'neutral',
      macdHist: s.macdHist, bbPos: s.bbPos,
      volR: s.volR, vol4R: s.vol4R, mom5: s.mom5, mom10: s.mom10
    }));

    const dailyBase = state.dailyStartBalance > 0 ? state.dailyStartBalance : (cfg.paperBalance || 1000);
    const dailyLossOk = (state.dailyPnl || 0) > -0.05 * dailyBase;

    const blockReason = fg.val < 15 ? 'F&G=' + fg.val + ' ekstremalna panika'
      : !dailyLossOk ? 'dzienny limit strat -5%'
      : (state.drawdownBlock || 0) > Date.now() ? 'circuit breaker'
      : null;

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
      for (const sig of sigs) {
        if ((state.positions || []).length >= cfg.maxPos) break;
        if (sig.shortSignal) {
          await openShort(sig, fg, btcInfo, cfg, state, env, nb, gbm, ql, ew);
        }
      }
    }

    const trades = state.trades || [];
    nb.trainFromTrades(trades);

    const lastRefit = state.lastGbmRefit || 0;
    const tradesSinceRefit = trades.filter(t => {
      const tsN = typeof t.ts === 'string' ? new Date(t.ts).getTime() : (t.ts||0);
      return tsN > lastRefit;
    }).length;
    if ((tradesSinceRefit >= 50 && trades.length >= 20) || (!gbm.trained && trades.length >= 20)) {
      gbm.trainFromTrades(trades.slice(0, 200));
      state.lastGbmRefit = Date.now();
      addLog(state, 'GBM walk-forward refit: ' + Math.min(trades.length,200) + ' tradów, OOS=' + gbm.accuracyOOS + '%', 'ok');
    }

   // FIX: Ensemble rebalance częściej (co 25 trade'ów) + lepsza elastyczność
const milestone = Math.floor(trades.length / 25) * 25;
if (trades.length >= 25 && milestone > (state.lastEnsembleRebalance || 0)) {
  const ewUpd = rebalanceEnsemble(ew, nb, gbm, trades.slice(0, 25));
  if (ewUpd) {
    Object.assign(ew, ewUpd);
    state.lastEnsembleRebalance = milestone;
    addLog(state, 'Ensemble rebalanced @' + milestone + ' tradów: nb=' + ew.nb.toFixed(2) + ' gbm=' + ew.gbm.toFixed(2), 'ok');
  }
}


    state.nb  = nb.save();
    state.gbm = gbm.save();
    state.ql  = ql.save();
    state.ensembleW = ew;

    // BUG FIX #6: pairParams bylo martwym no-opem (nic go nie aktualizowalo).
    // Teraz realnie dostosowuje minScore per-para na podstawie win-rate ostatnich
    // 30 tradow na danej parze. Clamp ±6 punktow od defaultu, zeby pojedyncze
    // serie nie rozchwialy progow w nieskonczonosc.
    const learnedPairParams = {};
    for (const sym of PAIRS) {
      const symTrades = trades.filter(t => t.sym === sym).slice(0, 30);
      const base = (PAIR_PARAMS_DEFAULT[sym] && PAIR_PARAMS_DEFAULT[sym].minScore) || 62;
      if (symTrades.length < 10) {
        learnedPairParams[sym] = PAIR_PARAMS_DEFAULT[sym] || { minScore: base };
        continue;
      }
      const wr = symTrades.filter(t => t.pnl > 0).length / symTrades.length;
      // wr=0.50 → adj=0; wr=0.30 → +4; wr=0.70 → -4
      const adj = Math.round((0.5 - wr) * 20);
      const newMin = Math.max(base - 6, Math.min(base + 6, base + adj));
      learnedPairParams[sym] = Object.assign({}, PAIR_PARAMS_DEFAULT[sym] || {}, { minScore: newMin });
    }
    state.pairParams = learnedPairParams;
    state.adaptiveMinScore = computeAdaptiveMinScore(trades, cfg.minScore);

    if (cfg.mode === 'live' && cfg.revxApiKey && cfg.revxPrivKey) {
      try {
        state.liveBalance = await revxGetBalance(cfg);
      } catch(e) { /* zachowaj poprzednią wartość */ }
    }

    const cycleJournal = buildCycleJournalEntry({
      iter: state.iter, fg, btcInfo, sigs,
      positions: state.positions || [],
      balance: currentBalance, dailyPnl: state.dailyPnl || 0,
      blockReason
    });
    addJournalEntry(state, cycleJournal);

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

// ═══════════════════════════════════════════════════════════════════════════
// ANALIZA TECHNICZNA — MULTI-TF
// ═══════════════════════════════════════════════════════════════════════════
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
  return blocks.slice(-6);
}

function detectFVG(h, l, c) {
  const gaps = [];
  const n = c.length;
  for (let i = 2; i < n; i++) {
    if (h[i-2] < l[i]) {
      gaps.push({ type:'bullish', top:l[i], bottom:h[i-2], idx:i });
    }
    if (l[i-2] > h[i]) {
      gaps.push({ type:'bearish', top:l[i-2], bottom:h[i], idx:i });
    }
  }
  return gaps.slice(-6);
}

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

function detectRegime(closes, atrD, ema20, ema50) {
  const price = closes.at(-1);
  // Dodajemy sprawdzenie dla price
  const atrPct = (atrD && price && price > 0) ? atrD / price : 0.01;
  
  if (atrPct > 0.035) return 'volatile';
  if (Math.abs(ema20/ema50 - 1) < 0.005 && atrPct < 0.02) return 'sideways';
  if (price > ema20 && ema20 > ema50) return 'bull_trend';
  if (price < ema20 && ema20 < ema50) return 'bear_trend';
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

// ═══════════════════════════════════════════════════════════════════════════
// FILTR KONTEKST(1H) → SETUP(15m) → TRIGGER(5m) — dodatkowy twardy gate
// nakladany NA scoring/SMC powyzej (nie zastepuje go). dir = 'LONG'|'SHORT'.
// ═══════════════════════════════════════════════════════════════════════════
function buildContextGate(trendD, dir) {
  if (dir === 'LONG') {
    if (trendD >= 1) return { pass: true, reason: null };
    return { pass: false, reason: 'KONTEKST 1H: brak wyraznego trendu bull (trendD=' + trendD + ')' };
  }
  if (trendD <= -1) return { pass: true, reason: null };
  return { pass: false, reason: 'KONTEKST 1H: brak wyraznego trendu bear (trendD=' + trendD + ')' };
}

function buildSetupGate(tf, dir) {
  const price  = tf.c.at(-1);
  const ema20  = emaLast(tf.c, 20);
  const ema50  = emaLast(tf.c, 50);
  const rsiTf  = rsi(tf.c, 14);
  const atrTf  = atr(tf.h, tf.l, tf.c, 14);
  const atrPct = price > 0 ? (atrTf / price) * 100 : 1;
  const distEma20 = Math.abs(price/ema20 - 1) * 100;
  const distEma50 = Math.abs(price/ema50 - 1) * 100;
  // Prog odleglosci skalowany zmiennoscia zamiast sztywnych 1.2%/1.5%. Sztywny
  // prog byl za ciasny w dni z duzymi ruchami - cena naturalnie oddala sie wtedy
  // od EMA, wiec gate odrzucal WSZYSTKO dokladnie w sesjach o najwiekszym
  // potencjale. Widelki 1.2-4.0% trzymaja go rozsadnym takze przy skrajnym ATR.
  const emaTol20 = Math.min(4.0, Math.max(1.2, atrPct * 1.5));
  const emaTol50 = Math.min(4.5, Math.max(1.5, atrPct * 1.8));
  const nearEma = distEma20 < emaTol20 || distEma50 < emaTol50;

  if (dir === 'LONG') {
    // SCIEZKA A - pullback do EMA w trendzie wzrostowym (klasyczny setup)
    const rsiOk      = rsiTf >= 35 && rsiTf <= 58;
    const notOverext = price <= ema20 * (1 + Math.max(0.03, atrPct/100 * 2.5));
    if (nearEma && rsiOk && notOverext) return { pass: true, reason: null, rsi: rsiTf, mode: 'pullback' };
    // SCIEZKA B - WYBICIE / kontynuacja momentum. Cena nad rosnacymi EMA, RSI w
    // strefie sily (ale nie skrajnie wykupionej). Bez tej sciezki bot ignorowal
    // dni silnych, jednokierunkowych ruchow, bo nigdy nie bylo "cofki" do EMA.
    const stacked   = price > ema20 && ema20 > ema50;
    const rsiMomOk  = rsiTf >= 52 && rsiTf <= 80; // sufit 74 odcinal wiekszosc realnych trendow (test: 14% vs 38% pokrycia)
    const notBlowoff = price <= ema20 * (1 + Math.max(0.05, atrPct/100 * 4));
    if (stacked && rsiMomOk && notBlowoff) return { pass: true, reason: null, rsi: rsiTf, mode: 'breakout' };
    const reason = !nearEma && !stacked ? 'SETUP 15m: brak pullbacku do EMA i brak ukladu wybicia'
      : !rsiOk && !rsiMomOk ? 'SETUP 15m: RSI ' + rsiTf.toFixed(0) + ' poza strefa korekty i poza strefa momentum'
      : 'SETUP 15m: cena zbyt rozciagnieta nad EMA20 (blow-off)';
    return { pass: false, reason, rsi: rsiTf };
  }

  // SCIEZKA A - odbicie do EMA w trendzie spadkowym
  const rsiOk      = rsiTf <= 65 && rsiTf >= 42;
  const notOverext = price >= ema20 * (1 - Math.max(0.03, atrPct/100 * 2.5));
  if (nearEma && rsiOk && notOverext) return { pass: true, reason: null, rsi: rsiTf, mode: 'pullback' };
  // SCIEZKA B - zalamanie / kontynuacja spadku (lustrzana do wybicia)
  const stackedDn  = price < ema20 && ema20 < ema50;
  const rsiMomOk   = rsiTf >= 20 && rsiTf <= 48; // lustrzanie do sufitu 80 po stronie long
  const notBlowoff = price >= ema20 * (1 - Math.max(0.05, atrPct/100 * 4));
  if (stackedDn && rsiMomOk && notBlowoff) return { pass: true, reason: null, rsi: rsiTf, mode: 'breakdown' };
  const reason = !nearEma && !stackedDn ? 'SETUP 15m: brak odbicia do EMA i brak ukladu zalamania'
    : !rsiOk && !rsiMomOk ? 'SETUP 15m: RSI ' + rsiTf.toFixed(0) + ' poza strefa odbicia i poza strefa momentum'
    : 'SETUP 15m: cena zbyt rozciagnieta pod EMA20 (blow-off)';
  return { pass: false, reason, rsi: rsiTf };
}

function buildTriggerGate(tf, dir) {
  const o = tf.o.at(-1), h = tf.h.at(-1), l = tf.l.at(-1), c = tf.c.at(-1);
  const vSum = tf.v.slice(-20).reduce((a,b)=>a+b,0);
  const volXR = vSum > 0 ? tf.v.at(-1) / (vSum/20) : 1;
  const goodVolume = volXR >= 1.15;
  const macdTf = macdFull(tf.c);
  const rsiTf  = rsi(tf.c, 14);
  const body   = Math.abs(c - o);

  if (dir === 'LONG') {
    const bullish = c > o;
    const upperWick = h - Math.max(o, c);
    const okWick = upperWick < body * 0.9 + 1e-9;
    const momentum = macdTf.hist > 0 || rsiTf > 45;
    if (bullish && goodVolume && momentum && okWick) return { pass: true, reason: null, volXR };
    const reason = !bullish ? 'TRIGGER 5m: ostatnia swieca spadkowa — brak triggera'
      : !goodVolume ? 'TRIGGER 5m: wolumen za niski (' + volXR.toFixed(2) + 'x)'
      : !momentum ? 'TRIGGER 5m: momentum nie potwierdza (RSI ' + rsiTf.toFixed(0) + ')'
      : 'TRIGGER 5m: za duzy gorny knot — odrzucenie wzrostu';
    return { pass: false, reason, volXR };
  }

  const bearish = c < o;
  const lowerWick = Math.min(o, c) - l;
  const okWick = lowerWick < body * 0.9 + 1e-9;
  const momentum = macdTf.hist < 0 || rsiTf < 55;
  if (bearish && goodVolume && momentum && okWick) return { pass: true, reason: null, volXR };
  const reason = !bearish ? 'TRIGGER 5m: ostatnia swieca wzrostowa — brak triggera'
    : !goodVolume ? 'TRIGGER 5m: wolumen za niski (' + volXR.toFixed(2) + 'x)'
    : !momentum ? 'TRIGGER 5m: momentum nie potwierdza (RSI ' + rsiTf.toFixed(0) + ')'
    : 'TRIGGER 5m: za duzy dolny knot — odrzucenie spadku';
  return { pass: false, reason, volXR };
}

async function analyzeSwing(sym, cfg, state, nb, gbm, ql, ew, pairParams, adaptiveMinScore) {
  const kd      = await getKlines(sym, '60',  200);
  await sleep(400);
  const k4h     = await getKlines(sym, '15',  100);
  await sleep(400);
  const k1h     = await getKlines(sym, '5',   50);
  await sleep(400);
  const obiData = await getOrderbook(sym);

  const pk = k => ({
    c: k.map(x => +x[4]),
    h: k.map(x => +x[2]),
    l: k.map(x => +x[3]),
    o: k.map(x => +x[1]),
    v: k.map(x => +x[5])
  });
  const d = pk(kd), h4 = pk(k4h), h1 = pk(k1h);
  const price = d.c.at(-1);

  const rsiD   = rsi(d.c, 14);
  const macdD  = macdFull(d.c);
  const bbD    = bband(d.c, 20);
  const ema20  = emaLast(d.c, 20);
  const ema50  = emaLast(d.c, 50);
  const atrD   = atr(d.h, d.l, d.c, 14);
  const vwap4h = calcVWAP(h4.h, h4.l, h4.c, h4.v);
  const srLevels = calcSRLevels(d.h, d.l, price);
  const regime = detectRegime(d.c, atrD, ema20, ema50);

  const rsi4h  = rsi(h4.c, 14);
  const macd4h = macdFull(h4.c);

  const rsi1h  = rsi(h1.c, 14);
  const macd1h = macdFull(h1.c);
  const confirm1h = macd1h.hist > 0 && rsi1h < 55;

  const rsiArrD  = rsiArray(d.c.slice(-40),  14);
  const rsiArr4h = rsiArray(h4.c.slice(-30), 14);
  const divD  = rsiDivergence(d.c.slice(-40),  rsiArrD,  38);
  const div4h = rsiDivergence(h4.c.slice(-30), rsiArr4h, 28);

  const trendD = price > ema50 ? (price > ema20 ? 2 : 1) : (price > ema20 ? 0 : -1);

  const _vSum20 = d.v.length >= 20 ? d.v.slice(-20).reduce((a,b)=>a+b,0) : 0;
  const volR  = (_vSum20 > 0) ? d.v.at(-1) / (_vSum20/20) : 1;
  const _v4Sum20 = h4.v.length >= 20 ? h4.v.slice(-20).reduce((a,b)=>a+b,0) : 0;
  const vol4R = (_v4Sum20 > 0) ? h4.v.at(-1) / (_v4Sum20/20) : 1;

  const mom5 = d.c.length > 5 ? (price / d.c.at(-6) - 1) * 100 : 0;
const mom10 = d.c.length > 10 ? (price / d.c.at(-11) - 1) * 100 : 0;

// === NOWY KOD: WYKRYWANIE REŻIMU RYNKU ===
function detectRegime(closes, atrD, ema20, ema50) {
  const price = closes.at(-1);
  // Dodajemy sprawdzenie dla atrD i price
  const atrPct = (atrD && price && price > 0) ? atrD / price : 0.01;
  
  if (atrPct > 0.035) return 'volatile';
  if (Math.abs(ema20/ema50 - 1) < 0.005 && atrPct < 0.02) return 'sideways';
  if (price > ema20 && ema20 > ema50) return 'bull_trend';
  if (price < ema20 && ema20 < ema50) return 'bear_trend';
  return 'neutral';
}

const marketRegime = detectMarketRegime(btcInfo.change24h, rsiD, macdD.hist, atrD/price);
// ==========================================

let score = 0; const why = [];

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

  if      (trendD === 2)  { score += 12; why.push('Ponad EMA20+50 — bull'); }
  else if (trendD === 1)  { score += 8;  why.push('Ponad EMA50'); }
  else if (trendD === 0)  { score += 3; }
  else                    { score -= 20; why.push('Ponizej EMA50 — bessa'); }

  if      (mom5 > 0 && mom10 < 0)    { score += 8; why.push('Momentum odwrocenie'); }
  else if (mom5 < -5 && mom10 < -10) { score += 5; why.push('Oversold momentum'); }
  else if (mom5 > 8)                  { score -= 5; why.push('Zbyt szybki wzrost'); }

  const structure   = detectStructure(d.h, d.l, d.c);
  const orderBlocks = detectOrderBlocks(h1.o, h1.h, h1.l, h1.c, atr(h1.h, h1.l, h1.c, 14));
  const fvgs        = detectFVG(h1.h, h1.l, h1.c);
  const liqSweep    = detectLiquiditySweep(h1.h, h1.l, h1.c);
  const premDisc    = premiumDiscountZone(d.h, d.l, d.c);

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

  const bearBias = trendD === -1 && rsiD > 50;
const bullBias = trendD === 2 && rsiD < 50;
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
  // +18 sumowalo sie z podniesionymi progami (np. XBT 66+18=84) i robilo z tego
  // wylacznik, a nie utrudnienie - przy finalProb>=0.84 ani long, ani short (<=0.16)
  // nie mial realnych szans. +6 nadal zniecheca do chopu, ale nie zamyka drzwi.
  if (regime === 'sideways')   { regimeMinScoreAdj = 6; }
  if (regime === 'bull_trend') { score += 5; why.push('Rezim: bull trend'); }
  if (regime === 'bear_trend') { score -= 15; why.push('Rezim: bear trend'); }
  if (regime === 'volatile')   { score -= 8;  why.push('Rezim: volatile'); }
  score = Math.max(0, Math.min(100, score));

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

  const obiScore = calcOBI(obiData);
  if (obiScore > 0) { score = Math.min(100, score + obiScore); why.push('OBI bycze'); }
  if (obiScore < 0) { score = Math.max(0,   score + obiScore); why.push('OBI niedzwiedzie'); }

  // BUG FIX #2: macdHist w jednostkach absolutnych (USD) dziala na BTC/ETH,
  // ale na XRP (~0.5) i PEPE (~0.000005) jest 100-10000x mniejszy i zawsze
  // wpada do binu neutralnego (1) w NB. Normalizujemy przez ATR (bezwymiarowe).
  // Prog 0.15 = "silny sygnal", prog -0.15 = "silny niedzwiedzi".
  const macdHistNorm = atrD > 0 ? macdD.hist / atrD : 0;
  const nbFeatures  = nb.discretize({ rsiD, macdHist: macdHistNorm, bbPos: bbD.pos, trendD, mom5, confirm1h });
  const bodyRatio  = Math.abs(d.c.at(-1) - d.o.at(-1)) / (d.h.at(-1) - d.l.at(-1) + 0.001);
  const atrPctFeat = Math.min(1, atrD / price / 0.1);
  const emaSlopeD  = Math.max(-1, Math.min(1, (ema20/ema50 - 1) * 10));
  const gbmFeatures = [rsiD/100, macdD.hist>0?1:0, bbD.pos, (trendD+1)/3, mom5/20, mom10/20, confirm1h?1:0, volR/3, obiData.ratio||0.5, bodyRatio, atrPctFeat, emaSlopeD];

  const nbPred  = nb.predict({ rsiD, macdHist: macdHistNorm, bbPos: bbD.pos, trendD, mom5, confirm1h });
  const gbmProb = gbm.predict(gbmFeatures);

  const qlSig   = { rsiD, macdHist: macdHistNorm, trendD, bbPos: bbD.pos, obiRatio: obiData.ratio || 0.5 };
  const qlSugg  = ql.suggests(qlSig);
  let qlBonus = 0;
  if (qlSugg) {
    if (qlSugg.action === 'BUY'  && qlSugg.confidence > 0.05) { qlBonus =  8; why.push('QL: BUY'); }
    if (qlSugg.action === 'HOLD' && qlSugg.confidence > 0.05) { qlBonus = -10; why.push('QL: czekac'); }
    score = Math.max(0, Math.min(100, score + qlBonus));
  }

  llet finalProb = score / 100;
let aiMethod  = 'Score';
const obiNorm = ((obiData.ratio || 0.5) - 0.3) / 0.4;

// === NOWY KOD: DYNAMICZNE WAGOWANIE W ZALEŻNOŚCI OD REŻIMU ===
let dynamicEw = { ...ew };

if (marketRegime === 'strong_bull' || marketRegime === 'strong_bear') {
  // W silnych trendach bardziej ufaj wskaźnikom technicznym niż modelom AI
  dynamicEw.score = Math.min(1.3, ew.score * 1.2);
  dynamicEw.nb = Math.max(0.3, ew.nb * 0.7);
  dynamicEw.gbm = Math.max(0.3, ew.gbm * 0.7);
} else if (marketRegime === 'sideways') {
  // W range'u bardziej ufaj modelom AI
  dynamicEw.score = Math.max(0.3, ew.score * 0.7);
  dynamicEw.nb = Math.min(1.3, ew.nb * 1.2);
  dynamicEw.gbm = Math.min(1.3, ew.gbm * 1.2);
}
// ============================================================

if (nb.trained && gbm.trained) {
  const wSum = (dynamicEw.score + dynamicEw.nb + dynamicEw.gbm + dynamicEw.obi + dynamicEw.ql) || 1;
  finalProb = Math.max(0, Math.min(1,
    (score/100 * dynamicEw.score + nbPred.prob * dynamicEw.nb + gbmProb * dynamicEw.gbm +
     Math.max(0, Math.min(1, obiNorm)) * dynamicEw.obi +
     (qlSugg && qlSugg.action==='BUY' ? 1 : 0) * dynamicEw.ql) / wSum));
  aiMethod = 'Ensemble(Score+NB+GBM+OBI+QL)';
  if (nbPred.label === 'SKIP' && gbmProb < 0.4) why.push('AI odradza wejscie');
} else if (nb.trained) {
  const wSum = (dynamicEw.score + dynamicEw.nb + dynamicEw.obi) || 1;
  finalProb = (score/100 * dynamicEw.score + nbPred.prob * dynamicEw.nb + Math.max(0,Math.min(1,obiNorm)) * dynamicEw.obi) / wSum;
  aiMethod = 'Score+NB+OBI';
}
    if (nbPred.label === 'SKIP' && gbmProb < 0.4) why.push('AI odradza wejscie');
  } else if (nb.trained) {
    const wSum = (ew.score + ew.nb + ew.obi) || 1;
    finalProb = (score/100 * ew.score + nbPred.prob * ew.nb + Math.max(0,Math.min(1,obiNorm)) * ew.obi) / wSum;
    aiMethod  = 'Score+NB+OBI';
  }

  const pp       = pairParams[sym] || PAIR_PARAMS_DEFAULT[sym] || null;
  const minScore = (pp ? pp.minScore : adaptiveMinScore) + regimeMinScoreAdj;

  const confluence = [
    trendD >= 1,
    (rsiD <= 40 || bbD.pos < 0.20 || divD.bull || div4h.bull),
    (structure.event === 'BOS_up' || structure.event === 'CHoCH_up' || nearBullOB || (liqSweep && liqSweep.type === 'bullish')),
    (volR > 1.3 || vol4R > 1.3)
  ].filter(Boolean).length;
  if (finalProb >= minScore / 100 && confluence < 1) {
    why.push('Score OK, ale brak confluence (' + confluence + '/4 rodzin sygnalow) — wejscie odrzucone');
  }

  // === NOWY KOD: ODDZIELNA LOGIKA DLA LONG I SHORT ===
  let scoreBuy = false, scoreShort = false;

  // STRATEGIA DLA LONG (TRENDOWANIE W GÓRĘ)
  if (trendD >= 1) {
    // W silnym trendzie byczym, wymagaj Mniej konfluencji dla LONG
    const longConfluence = [rsiD <= 45, bbD.pos < 0.30, divD.bull, volR > 1.2].filter(Boolean).length;
    const longThreshold = marketRegime === 'strong_bull' ? minScore * 0.92 / 100 : minScore / 100;
    scoreBuy = finalProb >= longThreshold && longConfluence >= (marketRegime === 'strong_bull' ? 1 : 2) && !bearBias;
  } 
// STRATEGIA DLA SHORT (TYLKO W KOREKTACH TRENDU)
else if (trendD >= 1 && rsiD > 60 && bbD.pos > 0.75 && !bullBias) {
  // Tylko w korektach silnego trendu
  const shortConfluence = [divD.bear, volR > 1.3, structure.event === 'CHoCH_down'].filter(Boolean).length;
  scoreShort = finalProb <= (100 - minScore) / 100 && shortConfluence >= 2 && !bullBias;
} 
// STRATEGIA DLA SHORT (TRENDOWANIE W DÓŁ)
else if (trendD <= -1) {
  const shortConfluence = [rsiD >= 55, bbD.pos > 0.70, divD.bear, volR > 1.2].filter(Boolean).length;
  const shortThreshold = marketRegime === 'strong_bear' ? ((100 - minScore) * 0.92) / 100 : (100 - minScore) / 100;
  scoreShort = finalProb <= shortThreshold && shortConfluence >= (marketRegime === 'strong_bear' ? 1 : 2) && !bullBias;
}
  // ==================================================== // obniżony próg konfluencji

  const shortThreshold = (100 - minScore) / 100;
  const bearConfluence = [
    trendD <= -1,
    (rsiD >= 60 || bbD.pos > 0.80 || divD.bear || div4h.bear),
    (structure.event === 'BOS_down' || structure.event === 'CHoCH_down' || nearBearOB || (liqSweep && liqSweep.type === 'bearish')),
    (volR > 1.3 || vol4R > 1.3)
  ].filter(Boolean).length;
  const scoreShort = finalProb <= shortThreshold && bearConfluence >= 1 && !bullBias; // obniżony próg konfluencji dla shortów

  // Dodatkowy "twardy" filtr wejscia: KONTEKST(1H) -> SETUP(15m pullback/odbicie)
  // -> TRIGGER(5m swieca zapalajaca). Score+SMC powyzej wybiera KANDYDATA, ale
  // to ten filtr decyduje o TIMINGU - odcina sygnaly, gdzie kontekst/pullback/
  // swieca nie sa jednoczesnie spelnione, nawet przy wysokim score.
  const ctxLong     = buildContextGate(trendD, 'LONG');
  const setupLong   = ctxLong.pass   ? buildSetupGate(h4, 'LONG')   : { pass:false, reason:null };
  const triggerLong = (ctxLong.pass && setupLong.pass) ? buildTriggerGate(h1, 'LONG') : { pass:false, reason:null };
  const stagedLong  = ctxLong.pass && setupLong.pass && triggerLong.pass;
  if (scoreBuy && !stagedLong) {
    why.push((!ctxLong.pass ? ctxLong.reason : !setupLong.pass ? setupLong.reason : triggerLong.reason) || 'Filtr KONTEKST/SETUP/TRIGGER: odrzucone');
  }

  const ctxShort     = buildContextGate(trendD, 'SHORT');
  const setupShort   = ctxShort.pass   ? buildSetupGate(h4, 'SHORT')   : { pass:false, reason:null };
  const triggerShort = (ctxShort.pass && setupShort.pass) ? buildTriggerGate(h1, 'SHORT') : { pass:false, reason:null };
  const stagedShort  = ctxShort.pass && setupShort.pass && triggerShort.pass;
  if (scoreShort && !stagedShort) {
    why.push((!ctxShort.pass ? ctxShort.reason : !setupShort.pass ? setupShort.reason : triggerShort.reason) || 'Filtr KONTEKST/SETUP/TRIGGER: odrzucone');
  }

  const buy         = scoreBuy && stagedLong;
  const shortSignal = scoreShort && stagedShort;
  const shortLevels = shortSignal ? {
    tp: price * (1 - Math.max(cfg.tp, atrD/price*3.0)),
    sl: price * (1 + Math.max(cfg.sl, atrD/price*1.5)),
    rr: (Math.max(cfg.tp, atrD/price*3.0) / Math.max(cfg.sl, atrD/price*1.5)).toFixed(1)
  } : null;

  return {
    sym, price,
    rsiD: +rsiD.toFixed(1), rsi4h: +rsi4h.toFixed(1), rsi1h: +rsi1h.toFixed(1), confirm1h,
    macdHist: macdD.hist, macdLine: macdD.line,
    bbPos: bbD.pos, trendD, ema20, ema50, atrD,
    score, finalProb: +finalProb.toFixed(3), buy, shortSignal, shortLevels,
    scoreBuy, scoreShort,
    gates: { ctxLong: ctxLong.pass, setupLong: setupLong.pass, triggerLong: triggerLong.pass,
              ctxShort: ctxShort.pass, setupShort: setupShort.pass, triggerShort: triggerShort.pass },
    nbPred, gbmProb: +gbmProb.toFixed(3), qlSugg, aiMethod,
    obiRatio: obiData.ratio || 0.5, obiScore, spreadPct: obiData.spreadPct,
    patterns: patResult.patterns,
    srLevels, vwap4h, regime,
    why, nbFeatures, gbmFeatures, qlSig,
    volR: +volR.toFixed(2), vol4R: +vol4R.toFixed(2),
    mom5: +mom5.toFixed(2), mom10: +mom10.toFixed(2),
    smc: {
      structure: structure.trend, event: structure.event,
      orderBlocks: orderBlocks.slice(-3), fvgs: fvgs.slice(-3),
      liqSweep, premiumDiscount: premDisc.zone, pdPct: +premDisc.pct.toFixed(3)
    },
    levels: calcDynamicLevels(price, atrD, cfg, pp, obiData.spreadPct)
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ZARZĄDZANIE POZYCJAMI
// ═══════════════════════════════════════════════════════════════════════════
async function checkPositions(cfg, state, env, ql) {
  const updated = [];
  for (const pos of (state.positions || [])) {
    if (pos.closing) { updated.push(pos); continue; }

    // BUG FIX #4: partialSelling moze zawisnac na true jesli Worker zostanie
    // ubity w trakcie await revxMarketSell (dlugi sleep 1500*3 + timeout 10s).
    // Auto-reset po 90s zamiast blokady na zawsze.
    if (pos.partialSelling && Date.now() - (pos.partialSellingAt || 0) > 90 * 1000) {
      addLog(state, 'Reset zawieszonej flagi partialSelling na ' + pos.sym, 'warn');
      pos.partialSelling = false;
    }

    try {
      const price = await getLastPrice(pos.sym);
      pos.cp = price;
      const isShort = pos.side === 'SHORT';

      if (isShort) {
        // SHORT (PAPER-only): zysk gdy cena SPADA, wiec kierunki TP/SL/trailing
        // sa odwrocone wzgledem LONG. lowP zamiast highP.
        if (!isFinite(pos.lowP) || price < pos.lowP) pos.lowP = price;

        const pnlPct = (pos.entry - price) / pos.entry * 100;
        const ageMs  = Date.now() - pos.entryTs;
        const nearTimeout  = ageMs > TIMEOUT_MS * 0.75;
        const effTrailDist = (nearTimeout && pnlPct > 0) ? pos.trailDist * 0.5 : pos.trailDist;
        const trail = pos.lowP * (1 + effTrailDist);
        let reason = null;

        if (ageMs > TIMEOUT_MS)                                    reason = 'TIMEOUT 8h';
        else if (price <= (pos.tp > 0 ? pos.tp : pos.entry * (1 - cfg.tp))) reason = 'TAKE PROFIT';
        else if (price >= (pos.partialClosed ? pos.sl : (pos.sl > 0 ? pos.sl : pos.entry * (1 + cfg.sl)))) reason = 'STOP LOSS';
        else if (price >= trail && pnlPct > 1.5)                   reason = 'TRAILING STOP';

        const _tpPct = pos.tp > 0 ? (pos.entry - pos.tp) / pos.entry * 100 : cfg.tp * 100;
        if (!reason && pnlPct >= _tpPct * 0.65 && !pos.partialClosed && !pos.partialSelling) {
          pos.partialSellingAt = Date.now();
          pos.partialSelling = true;
          try {
            const fillQty  = pos.qty / 2;
            const fillPrice = price * (1 + SLIPPAGE_PAPER); // odkupujemy (buy-to-cover) — plac za nas
            const partialFeeCost = (pos.entry * fillQty) * FEE + (fillPrice * fillQty) * FEE;
            const realizedPnl = (pos.entry - fillPrice) * fillQty - partialFeeCost;
            const closedSize  = pos.size * (fillQty / pos.qty);
            pos.qty  = pos.qty - fillQty;
            pos.size = pos.size - closedSize;
            pos.partialClosed = true;
            pos.partialSelling = false;
            pos.sl = pos.entry * (1 - FEE * 2);
            // SHORT jest zawsze paper (patrz komentarz przy openShort), wiec
            // zawsze rozliczamy przez paperBalance niezaleznie od cfg.mode.
            state.paperBalance = (state.paperBalance || 0) + closedSize + realizedPnl;
            addLog(state, 'PARTIAL TP SHORT(paper) ' + pos.sym + ' +$' + realizedPnl.toFixed(2) + ' (' + pnlPct.toFixed(1) + '%) — reszta jedzie dalej', 'ok');
          } catch(e) {
            pos.partialSelling = false;
            addLog(state, 'Partial TP (short) error: ' + e.message, 'err');
          }
        }

        if (reason) {
          pos.closing = true;
          const closed = await closePosition(pos, price, reason, cfg, state, ql);
          if (closed === false) { pos.closing = false; updated.push(pos); }
        } else {
          updated.push(pos);
        }
        await sleep(150);
        continue;
      }

      if (price > pos.highP) pos.highP = price;

      const pnlPct = (price - pos.entry) / pos.entry * 100;
      const ageMs  = Date.now() - pos.entryTs;
      const nearTimeout   = ageMs > TIMEOUT_MS * 0.75;
      const effTrailDist  = (nearTimeout && pnlPct > 0) ? pos.trailDist * 0.5 : pos.trailDist;
      const trail  = pos.highP * (1 - effTrailDist);
      let reason = null;

      if (ageMs > TIMEOUT_MS)                                reason = 'TIMEOUT 8h';
      else if (price >= (pos.tp > 0 ? pos.tp : pos.entry * (1 + cfg.tp))) reason = 'TAKE PROFIT';
      else if (price <= (pos.partialClosed ? pos.sl : (pos.sl > 0 ? pos.sl : pos.entry * (1 - cfg.sl)))) reason = 'STOP LOSS';
      else if (price <= trail && pnlPct > 1.5)               reason = 'TRAILING STOP';

      const _tpPct = pos.tp > 0 ? (pos.tp - pos.entry) / pos.entry * 100 : cfg.tp * 100;
      if (!reason && pnlPct >= _tpPct * 0.65 && !pos.partialClosed && !pos.partialSelling) {
        pos.partialSellingAt = Date.now();
        pos.partialSelling = true;
        const halfQtyReq = pos.qty / 2;
        let fillPrice = price, fillQty = halfQtyReq;
        try {
          if (cfg.mode === 'live' && cfg.revxApiKey && cfg.revxPrivKey) {
            const res = await revxMarketSell(pos.sym, halfQtyReq, cfg);
            fillPrice = res.price;
            fillQty   = res.qty;
          } else {
            fillPrice = price * (1 - SLIPPAGE_PAPER);
          }
          const partialFeeCost = (pos.entry * fillQty) * FEE + (fillPrice * fillQty) * FEE;
          const realizedPnl = (fillPrice - pos.entry) * fillQty - partialFeeCost;
          const closedSize  = pos.size * (fillQty / pos.qty);
          pos.qty  = pos.qty - fillQty;
          pos.size = pos.size - closedSize;
          pos.partialClosed = true;
          pos.partialSelling = false;
          pos.sl = pos.entry * (1 + FEE * 2);
          if (cfg.mode === 'paper') {
            state.paperBalance = (state.paperBalance || 0) + closedSize + realizedPnl;
          }
          addLog(state, 'PARTIAL TP ' + pos.sym + ' +$' + realizedPnl.toFixed(2) + ' (' + pnlPct.toFixed(1) + '%) — reszta jedzie dalej', 'ok');
        } catch(e) {
          pos.partialSelling = false;
          addLog(state, 'Partial TP SELL error: ' + e.message, 'err');
        }
      }

      if (reason) {
        pos.closing = true;
        const closed = await closePosition(pos, price, reason, cfg, state, ql);
        if (closed === false) {
          pos.closing = false;
          updated.push(pos);
        }
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
  const pp0 = (state.pairParams||{})[sig.sym] || PAIR_PARAMS_DEFAULT[sig.sym];
  const effMinScore = pp0 ? pp0.minScore : (state.adaptiveMinScore || cfg.minScore);
  const pumpReason = isPumpDump(sig);
  if (pumpReason) { addLog(state, 'Pump/dump guard (' + pumpReason + '): ' + sig.sym + ' — pomijam', 'warn'); return; }
  if (isVolumeAnomaly(sig, effMinScore)) { addLog(state, 'Vol anomaly: ' + sig.sym + ' vol=' + sig.volR.toFixed(2) + 'x — pomijam', 'warn'); return; }
  if (isDeadHour()) { addLog(state, 'Dead hour (02-05 UTC): ' + sig.sym + ' — pomijam', 'warn'); return; }

  if (btcDrop && sig.sym !== 'XBTUSDT') {
    addLog(state, 'BTC Guard: pomijam ' + sig.sym, 'warn'); return;
  }

  if (corrBlocked(sig.sym, state)) return;

  let adjSig = sig;
  if (fg.val < cfg.fgMin) {
    const newProb = Math.max(0, sig.finalProb - 0.10);
    adjSig = Object.assign({}, sig, { finalProb: newProb, score: Math.max(0, sig.score - 10) });
    if (adjSig.finalProb < effMinScore / 100) {
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
    if (portfolioHeat > 0.08) {
      addLog(state, 'Portfolio heat >8% — blokada (' + (portfolioHeat*100).toFixed(1) + '%)', 'warn');
      return;
    }
  }

  const pp     = pp0;
  const levels = calcDynamicLevels(adjSig.price, adjSig.atrD, cfg, pp, adjSig.spreadPct);
  const slPct  = (adjSig.price - levels.sl) / adjSig.price;

  const totalRoundTripCost = FEE * 2 + SLIPPAGE_PAPER * 2;
  const tpOffsetActual = (levels.tp - adjSig.price) / adjSig.price;
  if (tpOffsetActual < totalRoundTripCost * MIN_COST_COVERAGE_RATIO) {
    addLog(state, 'Trade ' + sig.sym + ' odrzucony: TP=' + (tpOffsetActual*100).toFixed(2) +
      '% < ' + (totalRoundTripCost * MIN_COST_COVERAGE_RATIO * 100).toFixed(2) +
      '% (koszt rundy x' + MIN_COST_COVERAGE_RATIO + ')', 'warn');
    return;
  }

  let posSize = kellySize(cfg, state, total, slPct);

  const st = state.stats;
  if (st && (state.trades || []).length >= 15 && (st.sharpe < 0 || st.maxDD > 20)) {
    posSize = Math.max(5, Math.round(posSize * 0.5 * 100) / 100);
    addLog(state, 'Throttle ryzyka (Sharpe=' + st.sharpe + ' maxDD=' + st.maxDD + '%) — rozmiar x0.5', 'warn');
  }

  const minSize = micro ? 1 : 10;
  if (posSize < minSize) {
    addLog(state, 'Za mala pozycja (' + posSize.toFixed(2) + '$) — pomijam ' + sig.sym, 'warn'); return;
  }

  addLog(state,
    'BUY ' + adjSig.sym + ' @ ' + fmtPrice(adjSig.price) +
    ' | score=' + adjSig.score + ' finalProb=' + (adjSig.finalProb*100).toFixed(1) + '%' +
    ' | $' + posSize.toFixed(2) + ' TP=' + fmtPrice(levels.tp) +
    ' SL=' + fmtPrice(levels.sl) + ' R:R=' + levels.rr +
    ' | ' + adjSig.aiMethod + ' | ' + cfg.mode.toUpperCase(), 'ok');

  if (!Array.isArray(state.positions)) state.positions = [];

  let newPos = null;
  if (cfg.mode === 'live' && cfg.revxApiKey && cfg.revxPrivKey) {
    try {
      const res = await revxMarketBuy(adjSig.sym, posSize, cfg);
      const execP = res.price || adjSig.price;
      const el    = calcDynamicLevels(execP, adjSig.atrD, cfg, pp, adjSig.spreadPct);
      newPos = buildPosition(adjSig, execP, res.qty, el, posSize, ql, 'LONG');
      state.positions.push(newPos);
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
    const paperExecPrice = adjSig.price * (1 + SLIPPAGE_PAPER);
    const qty = posSize / paperExecPrice;
    const paperLevels = calcDynamicLevels(paperExecPrice, adjSig.atrD, cfg, pp, adjSig.spreadPct);
    newPos = buildPosition(adjSig, paperExecPrice, qty, paperLevels, posSize, ql, 'LONG');
    state.positions.push(newPos);
    if (cfg.mode === 'paper') {
      state.paperBalance = Math.max(0, (state.paperBalance || paperBal) - posSize);
    }
    if (!state.dailyStartBalance || state.dailyStartBalance <= 0) {
      state.dailyStartBalance = paperBal;
    }
  }
  if (newPos) addJournalEntry(state, buildEntryJournalEntry(adjSig, newPos, cfg));

  const _pairName = adjSig.sym.replace('XBT','BTC').replace('USDT','').replace('USDC','');
  const _modeLabel = cfg.mode === 'live' ? 'LIVE (Revolut X)' : 'PAPER (symulacja)';
  await tgSend(cfg,
    'SYGNAL KUPNA — ' + _pairName + '\n\n' +
    'Cena wejscia: $' + fmtPrice(adjSig.price) + '\n' +
    'Rozmiar pozycji: $' + posSize.toFixed(2) + ' (Kelly)\n' +
    'Take Profit: $' + fmtPrice(levels.tp) + '\n' +
    'Stop Loss: $' + fmtPrice(levels.sl) + '\n' +
    'Zysk/Ryzyko: ' + levels.rr + '\n\n' +
    'Wynik AI: ' + adjSig.score + '/100 | Pewnosc: ' + (adjSig.finalProb*100).toFixed(1) + '%\n' +
    'Metoda: ' + adjSig.aiMethod + '\n' +
    'Powody: ' + adjSig.why.slice(0,4).join(', ') + '\n\n' +
    'Tryb: ' + _modeLabel);
}

// SHORT jest wykonywany WYLACZNIE w PAPER — Revolut X (spot) nie oferuje
// realnego short-sellingu. Nawet gdy cfg.mode==='live', ta funkcja NIGDY nie
// wysyla zadnego zlecenia na Revolut X — tylko symuluje pozycje w state.
async function openShort(sig, fg, btcInfo, cfg, state, env, nb, gbm, ql, ew) {
  if ((state.positions||[]).some(p => p.sym === sig.sym)) return;
  if (((state.cooldown || {})[sig.sym] || 0) > Date.now()) {
    addLog(state, 'Cooldown ' + sig.sym, 'warn'); return;
  }
  if ((state.globalBlockUntil||0) > Date.now()) {
    addLog(state, 'Globalna blokada aktywna', 'warn'); return;
  }
  const pp0 = (state.pairParams||{})[sig.sym] || PAIR_PARAMS_DEFAULT[sig.sym];
  const effMinScore = pp0 ? pp0.minScore : (state.adaptiveMinScore || cfg.minScore);
  const pumpReason = isPumpDump(sig);
  if (pumpReason) { addLog(state, 'Pump/dump guard (' + pumpReason + '): ' + sig.sym + ' — pomijam SHORT', 'warn'); return; }
  if (isVolumeAnomaly(sig, effMinScore)) { addLog(state, 'Vol anomaly: ' + sig.sym + ' vol=' + sig.volR.toFixed(2) + 'x — pomijam SHORT', 'warn'); return; }
  if (isDeadHour()) { addLog(state, 'Dead hour (02-05 UTC): ' + sig.sym + ' — pomijam SHORT', 'warn'); return; }

  if (btcInfo.pump && sig.sym !== 'XBTUSDT') {
    addLog(state, 'BTC Guard (pump): pomijam SHORT ' + sig.sym, 'warn'); return;
  }
  if (corrBlocked(sig.sym, state)) return;

  let adjSig = sig;
  const fgGreedThresh = 100 - cfg.fgMin;
  if (fg.val > fgGreedThresh) {
    const newProb = Math.max(0, sig.finalProb - 0.10);
    adjSig = Object.assign({}, sig, { finalProb: newProb, score: Math.max(0, sig.score - 10) });
    if (adjSig.finalProb < effMinScore / 100) {
      addLog(state, 'F&G=' + fg.val + ' (chciwosc) — po karze za slaby score pomijam SHORT ' + sig.sym, 'warn'); return;
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
      const slPct = p.partialClosed ? 0 : (p.entry > 0 ? Math.abs((p.sl || 0) - p.entry) / p.entry : cfg.sl);
      return s + (p.size||0) * slPct;
    }, 0);
    const portfolioHeat = totalRisk / (total > 0 ? total : 1);
    if (portfolioHeat > 0.08) {
      addLog(state, 'Portfolio heat >8% — blokada SHORT (' + (portfolioHeat*100).toFixed(1) + '%)', 'warn');
      return;
    }
  }

  const sl = adjSig.shortLevels.sl, tp = adjSig.shortLevels.tp, rr = adjSig.shortLevels.rr;
  const slPct = (sl - adjSig.price) / adjSig.price;

  const totalRoundTripCost = FEE * 2 + SLIPPAGE_PAPER * 2;
  const tpOffsetActual = (adjSig.price - tp) / adjSig.price;
  if (tpOffsetActual < totalRoundTripCost * MIN_COST_COVERAGE_RATIO) {
    addLog(state, 'SHORT ' + sig.sym + ' odrzucony: TP=' + (tpOffsetActual*100).toFixed(2) +
      '% < ' + (totalRoundTripCost * MIN_COST_COVERAGE_RATIO * 100).toFixed(2) +
      '% (koszt rundy x' + MIN_COST_COVERAGE_RATIO + ')', 'warn');
    return;
  }

  let posSize = kellySize(cfg, state, total, slPct);

  const st = state.stats;
  if (st && (state.trades || []).length >= 15 && (st.sharpe < 0 || st.maxDD > 20)) {
    posSize = Math.max(5, Math.round(posSize * 0.5 * 100) / 100);
    addLog(state, 'Throttle ryzyka (Sharpe=' + st.sharpe + ' maxDD=' + st.maxDD + '%) — rozmiar SHORT x0.5', 'warn');
  }

  const minSize = micro ? 1 : 10;
  if (posSize < minSize) {
    addLog(state, 'Za mala pozycja (' + posSize.toFixed(2) + '$) — pomijam SHORT ' + sig.sym, 'warn'); return;
  }

  addLog(state,
    'SHORT(paper) ' + adjSig.sym + ' @ ' + fmtPrice(adjSig.price) +
    ' | score=' + adjSig.score + ' finalProb=' + (adjSig.finalProb*100).toFixed(1) + '%' +
    ' | $' + posSize.toFixed(2) + ' TP=' + fmtPrice(tp) + ' SL=' + fmtPrice(sl) + ' R:R=' + rr +
    ' | ' + adjSig.aiMethod, 'ok');

  if (!Array.isArray(state.positions)) state.positions = [];

  const atrPctS = adjSig.atrD / adjSig.price;
  const paperExecPrice = adjSig.price * (1 - SLIPPAGE_PAPER);
  const qty = posSize / paperExecPrice;
  const levels = { tp, sl, trail: Math.max(cfg.trail, atrPctS * 1.2), rr };
  const newPos = buildPosition(adjSig, paperExecPrice, qty, levels, posSize, ql, 'SHORT');
  state.positions.push(newPos);

  // SHORT jest zawsze paper (patrz komentarz nad funkcja) — margin rezerwujemy
  // z paperBalance niezaleznie od cfg.mode.
  state.paperBalance = Math.max(0, (state.paperBalance || paperBal) - posSize);
  if (!state.dailyStartBalance || state.dailyStartBalance <= 0) {
    state.dailyStartBalance = paperBal;
  }

  addJournalEntry(state, buildEntryJournalEntry(adjSig, newPos, cfg));

  const _pairName = adjSig.sym.replace('XBT','BTC').replace('USDT','').replace('USDC','');
  await tgSend(cfg,
    'SYGNAL SHORT (PAPER) — ' + _pairName + '\n\n' +
    'Cena wejscia: $' + fmtPrice(adjSig.price) + '\n' +
    'Rozmiar pozycji: $' + posSize.toFixed(2) + ' (Kelly)\n' +
    'Take Profit: $' + fmtPrice(tp) + '\n' +
    'Stop Loss: $' + fmtPrice(sl) + '\n' +
    'Zysk/Ryzyko: ' + rr + '\n\n' +
    'Wynik AI: ' + adjSig.score + '/100 | Pewnosc: ' + (adjSig.finalProb*100).toFixed(1) + '%\n' +
    'Metoda: ' + adjSig.aiMethod + '\n' +
    'Powody: ' + adjSig.why.slice(0,4).join(', ') + '\n\n' +
    'Tryb: PAPER (symulacja — Revolut X nie wspiera realnych shortow)');
}

function buildPosition(sig, price, qty, levels, size, ql, side) {
  side = side || 'LONG';
  return {
    sym: sig.sym, side, entry: price, qty,
    cp: price, highP: price, lowP: price,
    sl: levels.sl, tp: levels.tp, trailDist: levels.trail,
    entryTs: Date.now(), score: sig.score, finalProb: sig.finalProb,
    aiMethod: sig.aiMethod, nbFeatures: sig.nbFeatures, gbmFeatures: sig.gbmFeatures,
    qlSig: sig.qlSig, gbmProb: sig.gbmProb, nbLabel: sig.nbPred ? sig.nbPred.label : 'NEUTRAL',
    why: sig.why.join(', '), size, rr: levels.rr
  };
}

async function closePosition(pos, price, reason, cfg, state, ql) {
  const isShort = pos.side === 'SHORT';
  let execPrice = price;

  if (isShort) {
    // SHORT jest zawsze paper — odkupujemy (buy-to-cover) w symulacji, nigdy
    // realne zlecenie na Revolut X (nie wspiera short-sellingu na spot).
    execPrice = price * (1 + SLIPPAGE_PAPER);
  } else if (cfg.mode === 'live' && cfg.revxApiKey && cfg.revxPrivKey) {
    try {
      const res = await revxMarketSell(pos.sym, pos.qty, cfg);
      execPrice = res.price || price;
    } catch(e) {
      addLog(state, 'SELL FAILED ' + pos.sym + ': ' + e.message, 'err');
      return false;
    }
  } else {
    execPrice = price * (1 - SLIPPAGE_PAPER);
  }

  const grossPnl = isShort ? (pos.entry - execPrice) * pos.qty : (execPrice - pos.entry) * pos.qty;
  const feeCost  = pos.size * FEE + (pos.size + grossPnl) * FEE;
  const pnl      = grossPnl - feeCost;
  const pnlPct   = pnl / pos.size * 100;
  const durH     = ((Date.now() - pos.entryTs) / 3600000).toFixed(1);

  // BUG FIX #5: to mierzy exec - signalPrice (Revolut X fill vs Bybit mid), co
  // zawiera basis miedzygiełdowy + prawdziwy slippage. Prawdziwy slippage
  // wymagalby mid z Revolut X w momencie decyzji (endpoint niedostepny publicznie).
  const execVsSignalPricePct = price > 0
    ? +(((execPrice - price) / price) * 100).toFixed(3)
    : 0;

  if (isShort || cfg.mode === 'paper') {
    state.paperBalance = (state.paperBalance || 0) + pos.size + pnl;
  }

  state.dailyPnl = (state.dailyPnl || 0) + pnl;
  if (pnl < 0) {
    state.consLoss = (state.consLoss || 0) + 1;
    if (!state.cooldown || typeof state.cooldown !== 'object') state.cooldown = {};
    state.cooldown[pos.sym] = Date.now() + 60 * 60000;
    if (state.consLoss >= 3) {
      state.globalBlockUntil = Date.now() + 90 * 60000;
      addLog(state, '3 straty z rzedu — blokada 90 min', 'err');
    }
  } else {
    state.consLoss = 0;
  }

  // QL zna tylko akcje BUY/HOLD (semantyka "long-only") — nie aktualizujemy go
  // wynikami SHORT, zeby nie zaburzyc modelu uzywanego do sygnalow LONG.
  if (pos.qlSig && ql && !isShort) {
    const reward = Math.max(-1, Math.min(1, pnlPct / 10));
    ql.update(pos.qlSig, 'BUY', reward, null);
  }

  const trade = {
    sym: pos.sym, side: pos.side || 'LONG', entry: pos.entry, exit: execPrice, qty: pos.qty,
    pnl: +pnl.toFixed(4), pnlPct: +pnlPct.toFixed(2),
    execVsSignalPricePct,
    durH, reason, score: pos.score, finalProb: pos.finalProb,
    aiMethod: pos.aiMethod, nbFeatures: pos.nbFeatures, gbmFeatures: pos.gbmFeatures,
    nbLabel: pos.nbLabel || 'NEUTRAL', gbmProb: pos.gbmProb, ts: Date.now()
  };
  state.trades = [trade, ...(state.trades || [])].slice(0, 300);
  state.stats = calcStats(state.trades);

  const _closeIcon = pnl >= 0 ? '[+]' : '[-]';
  const _closeSym = pos.sym.replace('XBT','BTC').replace('USDT','').replace('USDC','');
  addLog(state,
    _closeIcon + ' ' + (isShort ? 'SHORT(paper) ' : '') + pos.sym + ' ' + reason +
    ' P/L: ' + (pnl>=0?'+':'') + '$' + pnl.toFixed(2) +
    ' (' + pnlPct.toFixed(2) + '%) | ' + durH + 'h | R:R=' + (pos.rr||'?') +
    ' | exec-signal=' + execVsSignalPricePct.toFixed(3) + '%',
    pnl >= 0 ? 'ok' : 'err');

  addJournalEntry(state, buildExitJournalEntry(pos, { exitPrice: execPrice, pnl, pnlPct, reason, durH }));

  const _reasonPL = reason === 'TAKE PROFIT' ? 'REALIZACJA ZYSKU' :
    reason === 'STOP LOSS' ? 'STOP LOSS AKTYWOWANY' :
    reason === 'TRAILING STOP' ? 'STOP KROCZACY' :
    reason === 'TIMEOUT 8h' ? 'KONIEC CZASU (8h)' : reason;
  await tgSend(cfg,
    (pnl>=0?'[+]':'[-]') + ' ' + (isShort ? 'SHORT(paper) ' : '') + _reasonPL + ' — ' + _closeSym + '\n\n' +
    'Wynik: ' + (pnl>=0?'+':'') + '$' + pnl.toFixed(2) + ' (' + pnlPct.toFixed(2) + '%)\n' +
    'Czas trwania: ' + durH + 'h\n' +
    'Score wejscia: ' + pos.score + '/100\n' +
    'Tryb: ' + (isShort ? 'PAPER (short)' : (cfg.mode === 'live' ? 'LIVE (Revolut X)' : 'PAPER')));
}

// ═══════════════════════════════════════════════════════════════════════════
// DZIENNIK — bot sam wypelnia (cykl / wejscie / wyjscie / post-mortem)
// ═══════════════════════════════════════════════════════════════════════════
function addJournalEntry(state, entry) {
  if (!state.journal) state.journal = [];
  state.journal = [entry, ...state.journal].slice(0, 500);
}

function fmtSignedPct(n) {
  if (!isFinite(n)) return String(n);
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

function describeMarketRegime(btcInfo, fg) {
  const btc = btcInfo.change24h || 0;
  const fgv = fg.val;
  let tone;
  if (btc > 2 && fgv > 55) tone = 'bycza euforia';
  else if (btc > 1) tone = 'lekko byczo';
  else if (btc < -2 && fgv < 40) tone = 'strach na rynku';
  else if (btc < -1) tone = 'lekko niedzwiedzio';
  else tone = 'neutralnie';
  const fgLabel = fgv < 25 ? 'strach' : fgv < 45 ? 'ostroznosc' : fgv < 55 ? 'neutralnie' : fgv < 75 ? 'chciwosc' : 'euforia';
  return tone + ' (BTC 24h ' + fmtSignedPct(btc) + '%, F&G ' + fgv + ' — ' + fgLabel + ')';
}

function describeExitReason(reason) {
  const map = {
    'TAKE PROFIT': 'Take Profit — cel osiagniety',
    'STOP LOSS': 'Stop Loss — struktura zepsuta',
    'TRAILING STOP': 'Trailing Stop — cena sie odwrocila',
    'TIMEOUT 8h': 'Timeout — brak potwierdzenia w 8h'
  };
  return map[reason] || reason;
}

function analyzeThesisOutcome(pos, exitPrice, reason) {
  const notes = [];
  let verdict = '';
  const isShort = pos.side === 'SHORT';
  const wasProfit = isShort ? exitPrice < pos.entry : exitPrice > pos.entry;
  const tpReached = isShort ? exitPrice <= pos.tp : exitPrice >= pos.tp;

  if (reason === 'TAKE PROFIT' || tpReached) {
    verdict = 'Teza zrealizowana w pelni — cena doszla do celu.';
    notes.push('Cel osiagniety zgodnie z planem, wykonanie bez uwag.');
  } else if (reason === 'TRAILING STOP' && wasProfit) {
    const totalMove = Math.abs(pos.tp - pos.entry);
    const gotMove   = Math.abs(exitPrice - pos.entry);
    const pctOfTarget = totalMove > 0 ? (gotMove / totalMove * 100).toFixed(0) : '0';
    verdict = 'Teza zrealizowana czesciowo — trailing zabezpieczyl ' + pctOfTarget + '% drogi do celu.';
    if (pctOfTarget >= 80) notes.push('Trailing zadzialal prawidlowo — cena sie odwrocila, ochrona zadzialala.');
    else if (pctOfTarget >= 50) notes.push('Trailing zamknal pozycje w polowie drogi — mozna rozwazyc szerszy trailing.');
    else notes.push('Trailing zamknal za wczesnie — cena nie miala miejsca na oddech.');
  } else if (reason === 'STOP LOSS' || reason === 'TIMEOUT 8h') {
    verdict = 'Teza nie zrealizowala sie — cena poszla w druga strone.';
    notes.push('Setup nie zadzialal — to czesc procesu, nie kazdy trade wygrywa.');
    if (reason === 'TIMEOUT 8h') notes.push('Pozycja stala w miejscu — brak momentum w oknie 8h.');
    else notes.push('Stop zadzialal zgodnie z planem — strata pod kontrola.');
  } else {
    verdict = 'Zamkniete z powodu: ' + reason;
  }
  return { verdict, notes };
}

function buildEntryJournalEntry(sig, pos, cfg) {
  const now = new Date();
  const sym = pos.sym.replace('XBT','BTC').replace('USDT','').replace('USDC','');
  const isShort = pos.side === 'SHORT';
  const lines = [];

  lines.push((isShort ? '⚡ OTWARCIE SHORT (PAPER): ' : '⚡ OTWARCIE LONG: ') + sym);
  lines.push('Czas: ' + now.toISOString().replace('T',' ').slice(0,19) + ' UTC');
  lines.push('Cena wejscia: $' + fmtPrice(pos.entry));
  lines.push('Rozmiar: $' + pos.size.toFixed(2) + ' (Kelly)');
  lines.push('Take Profit: $' + fmtPrice(pos.tp) + ' | Stop Loss: $' + fmtPrice(pos.sl) + ' | R:R ' + pos.rr);
  lines.push('Score: ' + sig.score + '/100 | Pewnosc: ' + (sig.finalProb*100).toFixed(1) + '% | Metoda: ' + sig.aiMethod);
  lines.push('');
  lines.push('POWODY WEJSCIA:');
  for (const w of (sig.why || []).slice(0, 8)) lines.push('  • ' + w);
  lines.push('');
  lines.push('FILTR KONTEKST/SETUP/TRIGGER:');
  const g = sig.gates || {};
  if (isShort) {
    lines.push('  • KONTEKST 1H: ' + (g.ctxShort ? 'OK (trend bear)' : 'brak'));
    lines.push('  • SETUP 15m: ' + (g.setupShort ? 'OK (odbicie do EMA)' : 'brak'));
    lines.push('  • TRIGGER 5m: ' + (g.triggerShort ? 'OK (swieca spadkowa + wolumen)' : 'brak'));
  } else {
    lines.push('  • KONTEKST 1H: ' + (g.ctxLong ? 'OK (trend bull)' : 'brak'));
    lines.push('  • SETUP 15m: ' + (g.setupLong ? 'OK (pullback do EMA)' : 'brak'));
    lines.push('  • TRIGGER 5m: ' + (g.triggerLong ? 'OK (swieca wzrostowa + wolumen)' : 'brak'));
  }
  lines.push('');
  lines.push('INWALIDACJA TEZY:');
  if (isShort) {
    lines.push('  • Zamkniecie 1H powyzej $' + fmtPrice(pos.sl) + ' — struktura bear sie psuje');
  } else {
    lines.push('  • Zamkniecie 1H ponizej $' + fmtPrice(pos.sl) + ' — struktura bull sie psuje');
  }
  lines.push('  • Cena nie potwierdza w ciagu 8h — wychodze (TIMEOUT)');

  return {
    ts: now.getTime(), tsISO: now.toISOString(), type: 'entry',
    sym: pos.sym, side: pos.side, entry: pos.entry, tp: pos.tp, sl: pos.sl,
    size: pos.size, rr: pos.rr, mode: isShort ? 'paper (short)' : cfg.mode,
    title: (isShort ? 'OTWARCIE SHORT (PAPER) ' : 'OTWARCIE LONG ') + sym + ' @ $' + fmtPrice(pos.entry),
    summary: 'Score ' + sig.score + '/100, ' + sig.aiMethod,
    lines, severity: 'entry'
  };
}

function buildExitJournalEntry(pos, closeInfo) {
  const now = new Date();
  const sym = pos.sym.replace('XBT','BTC').replace('USDT','').replace('USDC','');
  const { exitPrice, pnl, pnlPct, reason, durH } = closeInfo;
  const isShort = pos.side === 'SHORT';
  const lines = [];

  const emoji = pnl >= 0 ? '✓' : '✗';
  lines.push(emoji + ' ZAMKNIECIE ' + (isShort ? 'SHORT (PAPER)' : 'LONG') + ': ' + sym);
  lines.push('Czas: ' + now.toISOString().replace('T',' ').slice(0,19) + ' UTC');
  lines.push('Powod: ' + describeExitReason(reason));
  lines.push('Cena wejscia: $' + fmtPrice(pos.entry) + ' → wyjscia: $' + fmtPrice(exitPrice));
  lines.push('Wynik: ' + fmtSignedPct(pnl) + '$ (' + fmtSignedPct(pnlPct) + '%)');
  lines.push('Czas trwania: ' + durH + 'h');
  lines.push('');
  lines.push('POST-MORTEM:');
  const thesis = analyzeThesisOutcome(pos, exitPrice, reason);
  lines.push('  • ' + thesis.verdict);
  for (const n of thesis.notes) lines.push('  • ' + n);

  return {
    ts: now.getTime(), tsISO: now.toISOString(), type: 'exit',
    sym: pos.sym, side: pos.side, entry: pos.entry, exit: exitPrice,
    pnl, pnlPct, reason, durH,
    title: emoji + ' ZAMKNIECIE ' + (isShort?'SHORT ':'LONG ') + sym + ' ' + fmtSignedPct(pnlPct) + '%',
    summary: describeExitReason(reason),
    lines, severity: pnl >= 0 ? 'ok' : 'err'
  };
}

function buildCycleJournalEntry(data) {
  const { iter, fg, btcInfo, sigs, positions, balance, dailyPnl, blockReason } = data;
  const now = new Date();
  const lines = [];

  lines.push('Rezim rynku: ' + describeMarketRegime(btcInfo, fg));
  lines.push('Kapital: $' + balance.toFixed(2) + ' | P&L dzis: ' + fmtSignedPct(dailyPnl) + '$');
  if (blockReason) lines.push('⛔ BLOKADA WEJSC: ' + blockReason);

  if (positions.length > 0) {
    lines.push('');
    lines.push('Otwarte pozycje (' + positions.length + '):');
    for (const p of positions) {
      const sideTag = p.side === 'SHORT' ? 'SHORT(paper)' : 'LONG';
      const pnlPct = p.cp ? (p.side === 'SHORT'
        ? ((p.entry - p.cp) / p.entry * 100)
        : ((p.cp - p.entry) / p.entry * 100)) : 0;
      lines.push('  • [' + sideTag + '] ' + p.sym.replace('XBT','BTC').replace('USDT','') + ' @ ' + fmtPrice(p.entry) + ' (PnL: ' + fmtSignedPct(pnlPct) + '%)');
    }
  }

  const passedGate = sigs.filter(s => s.buy || s.shortSignal);
  if (passedGate.length > 0) {
    lines.push('');
    lines.push('Sygnaly, ktore przeszly score+SMC+KONTEKST/SETUP/TRIGGER:');
    for (const s of passedGate) {
      const dir = s.buy ? 'LONG' : 'SHORT(paper)';
      lines.push('  • ' + s.sym.replace('XBT','BTC').replace('USDT','') + ': ' + dir + ' — score ' + s.score + '/100');
    }
  }

  const nearMiss = sigs.filter(s => (s.scoreBuy && !s.buy) || (s.scoreShort && !s.shortSignal));
  if (nearMiss.length > 0) {
    lines.push('');
    lines.push('Wysoki score, ale odrzucone przez filtr KONTEKST/SETUP/TRIGGER:');
    for (const s of nearMiss.slice(0, 5)) {
      const reasonLine = (s.why || []).find(w => w.startsWith('KONTEKST') || w.startsWith('SETUP') || w.startsWith('TRIGGER'));
      lines.push('  • ' + s.sym.replace('XBT','BTC').replace('USDT','') + ': ' + (reasonLine || 'filtr timing odrzucil'));
    }
  }

  if (sigs.length === 0) lines.push('', 'Brak danych z rynku w tym cyklu.');

  return {
    ts: now.getTime(), tsISO: now.toISOString(), type: 'cycle', iter,
    title: 'Skan #' + iter,
    summary: describeMarketRegime(btcInfo, fg),
    lines, severity: blockReason ? 'warn' : 'info'
  };
}

function formatJournalForText(entry) {
  const header = '═══ ' + (entry.title || entry.type.toUpperCase()) + ' — ' + (entry.tsISO || '').slice(0,16).replace('T',' ') + ' ═══';
  return header + '\n' + entry.lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// GUARDS
// ═══════════════════════════════════════════════════════════════════════════
function isPumpDump(sig) {
  const atrPct = (sig.atrD && sig.price) ? (sig.atrD / sig.price) * 100 : 0.5;
  const vol4Thresh  = 4.0;
  const mom5Thresh  = Math.max(4, atrPct * Math.sqrt(5)  * 3.5);
  const mom10Thresh = Math.max(6, atrPct * Math.sqrt(10) * 3.5);
  if (sig.vol4R > vol4Thresh)  return 'vol4R=' + sig.vol4R.toFixed(1) + 'x';
  if (sig.mom5  > mom5Thresh)  return 'mom5=' + sig.mom5.toFixed(1) + '%/5h (prog ' + mom5Thresh.toFixed(1) + '%, ATR-relative)';
  if (sig.mom10 > mom10Thresh) return 'mom10=' + sig.mom10.toFixed(1) + '%/10h (prog ' + mom10Thresh.toFixed(1) + '%, ATR-relative)';
  return null;
}

function isVolumeAnomaly(sig, effMinScore) {
  if (sig.volR < 0.35) return true;
  if (sig.score >= (effMinScore || 62) && sig.vol4R < 0.3) return true;
  return false;
}

function isDeadHour() {
  const h = new Date().getUTCHours();
  return h >= 2 && h < 5;
}

async function btcDropGuard() {
  try {
    const r = await fetchWithTimeout(`${BYBIT_BASE}/v5/market/tickers?category=spot&symbol=BTCUSDT`);
    const d = await r.json();
    const t = (d.result && d.result.list && d.result.list[0]) || null;
    if (!t) return { drop: false, pump: false, change24h: 0 };
    const pct = +(t.price24hPcnt || 0) * 100;
    return { drop: pct < -4, pump: pct > 4, change24h: pct };
  } catch(e) { return { drop: false, pump: false, change24h: 0 }; }
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

// ═══════════════════════════════════════════════════════════════════════════
// RISK MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
function isMicroAccount(total) { return (isFinite(total) && total > 0 && total < 100); }

function kellySize(cfg, state, total, slPct) {
  const safeTotal = (isFinite(total) && total > 0) ? total : 100;
  if (isMicroAccount(safeTotal)) return Math.max(1, Math.round(safeTotal * 0.90 * 100) / 100);
  const fixedSize = cfg.posSize || 15;
  const trades = (state.trades || []).slice(0, 40);
  let sz;
  if (trades.length < 8) {
    sz = Math.min(fixedSize, Math.max(10, safeTotal * (cfg.riskPct || 2) / 100));
  } else {
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    let p = wins.length / trades.length;
    const avgW = wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length / 100 : cfg.tp;
    const avgL = losses.length ? Math.abs(losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length) / 100 : cfg.sl;
    const b = avgW / (avgL > 0 ? avgL : cfg.sl || 0.04);
    if (!isFinite(b) || b <= 0) {
      sz = Math.min(fixedSize, Math.max(10, safeTotal * (cfg.riskPct || 2) / 100));
    } else {
      // Silniejszy shrinkage przy małej próbce
      const shrinkage = Math.min(1, trades.length / 50);
      p = 0.5 + (p - 0.5) * shrinkage;
      let kelly = (b * p - (1 - p)) / b;
      if (kelly <= 0) {
        sz = Math.min(fixedSize, Math.max(5, safeTotal * 0.015));
      } else {
        kelly = Math.min(0.055, kelly * 0.55); // bardziej aktywny, ale bezpieczny Kelly
        sz = Math.max(5, Math.round(safeTotal * kelly * 100) / 100);
      }
    }
  }
  sz = Math.min(fixedSize, sz, safeTotal * 0.18);
  if (isFinite(slPct) && slPct > 0) {
    const baselineSl = cfg.sl || 0.01;
    const normFactor = Math.min(1.4, Math.max(0.5, baselineSl / slPct));
    sz = Math.max(5, Math.round(sz * normFactor * 100) / 100);
    sz = Math.min(fixedSize, sz, safeTotal * 0.18);
  }
  return sz;
}



const SPREAD_BUFFER_MIN     = 0.0008;
const SPREAD_BUFFER_MAX     = 0.006;
const SPREAD_BUFFER_DEFAULT = 0.0015;

function effectiveSpreadBuffer(spreadPct) {
  if (spreadPct == null || !isFinite(spreadPct) || spreadPct <= 0) return SPREAD_BUFFER_DEFAULT;
  return Math.max(SPREAD_BUFFER_MIN, Math.min(SPREAD_BUFFER_MAX, spreadPct * 1.5));
}

function calcDynamicLevels(price, atrD, cfg, pp, spreadPct) {
  const atrPct    = atrD / price;
  const cfgTp     = (pp && pp.tp != null) ? pp.tp : cfg.tp;
  const cfgSl     = (pp && pp.sl != null) ? pp.sl : cfg.sl;
  const spreadBuf = effectiveSpreadBuffer(spreadPct);
  // 2.5x ATR dawalo po kosztach (0.28% round-trip) realne R:R ~1.25:1 i prog
  // oplacalnosci ~44% trafien. 3.0x podnosi to do ~1.6:1 i prog do ~38%.
  const tpOffset  = Math.max(cfgTp,   atrPct * 3.0) + spreadBuf;
  const slOffset  = Math.max(cfgSl,   atrPct * 1.5) + spreadBuf;
  const trail     = Math.max(cfg.trail, atrPct * 1.2);
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

// ═══════════════════════════════════════════════════════════════════════════
// FORMACJE ŚWIECOWE
// ═══════════════════════════════════════════════════════════════════════════
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

    const lowerSh = isUp(i) ? o[i]-l[i] : c[i]-l[i];
    const upperSh = isUp(i) ? h[i]-c[i] : h[i]-o[i];
    if (body(i) < atrVal*0.3 && lowerSh > body(i)*2 && upperSh < body(i)*0.5 && isDown(i-1)) {
      patterns.push({ name:'Hammer', type:'bullish', strength:75, desc:'Silne odrzucenie w dol' });
    }
    if (isDown(i-1) && isUp(i) && o[i]<c[i-1] && c[i]>o[i-1] && body(i)>body(i-1)*1.1) {
      patterns.push({ name:'Bullish Engulfing', type:'bullish', strength:82, desc:'Popyt przytloczyl podaz' });
    }
    if (n>=3 && isDown(i-2) && body(i-1)<atrVal*0.25 && isUp(i) && c[i]>(o[i-2]+c[i-2])/2) {
      patterns.push({ name:'Morning Star', type:'bullish', strength:85, desc:'Odwrocenie trendu spadkowego' });
    }
    if (body(i) < atrVal*0.1 && range(i) > atrVal*0.3) {
      const t = (isDown(i-1)||isDown(i-2)) ? 'bullish' : 'neutral';
      patterns.push({ name:'Doji', type:t, strength:55, desc:'Rynek niezdecydowany' });
    }
    if (isDown(i-1) && isUp(i) && o[i]<l[i-1] && c[i]>(o[i-1]+c[i-1])/2 && c[i]<o[i-1]) {
      patterns.push({ name:'Piercing Line', type:'bullish', strength:70, desc:'Kupujacy weszli po bessie' });
    }
    if (n>=3 && isUp(i) && isUp(i-1) && isUp(i-2) && c[i]>c[i-1] && c[i-1]>c[i-2] && body(i)>atrVal*0.4 && body(i-1)>atrVal*0.4) {
      patterns.push({ name:'Three White Soldiers', type:'bullish', strength:80, desc:'Silny trend wzrostowy' });
    }
    const upperSh2 = isUp(i) ? h[i]-c[i] : h[i]-o[i];
    const lowerSh2 = isUp(i) ? o[i]-l[i] : c[i]-l[i];
    if (body(i)<atrVal*0.3 && upperSh2>body(i)*2 && lowerSh2<body(i)*0.5 && isUp(i-1)) {
      patterns.push({ name:'Shooting Star', type:'bearish', strength:72, desc:'Ostrzezenie przed korekta' });
    }
    if (isUp(i-1) && isDown(i) && o[i]>c[i-1] && c[i]<o[i-1] && body(i)>body(i-1)*1.1) {
      patterns.push({ name:'Bearish Engulfing', type:'bearish', strength:78, desc:'Podaz przejela kontrole' });
    }

    const bullish = patterns.filter(p=>p.type==='bullish').length;
    const bearish = patterns.filter(p=>p.type==='bearish').length;
    const score   = patterns.reduce((s,p)=>s+(p.type==='bullish'?p.strength:-p.strength),0);
    return { patterns, score, bullish, bearish };
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// MODUŁY AI/ML
// ═══════════════════════════════════════════════════════════════════════════
function rebalanceEnsemble(ew, nb, gbm, recentTrades) {
  if (!recentTrades || recentTrades.length < 8) return null;
const newEw = { score: ew.score, nb: ew.nb, gbm: ew.gbm, obi: ew.obi, ql: ew.ql };

function expectancyFactor(matchFn) {
  const matched = recentTrades.filter(matchFn);
  if (matched.length < 4) return 1;
  const avgPnlPct = matched.reduce((s, t) => s + (t.pnlPct || 0), 0) / matched.length;
  // Mniej agresywna regularyzacja – lepsza adaptacja do rynku
  return Math.max(0.6, Math.min(1.3, 1 + avgPnlPct / 15));
}

let nbCorrect = 0, nbTotal = 0;
recentTrades.forEach(t => {
  if (!t.nbLabel) return;
  nbTotal++;
  if ((t.nbLabel === 'BUY' && t.pnl > 0) || (t.nbLabel !== 'BUY' && t.pnl <= 0)) nbCorrect++;
});
if (nbTotal >= 8) {
  const nbAcc = nbCorrect / nbTotal;
  const nbExp = expectancyFactor(t => t.nbLabel === 'BUY');
  // Shrinkage w stronę 0.7 z mniejszym mnożnikiem
  let raw = nbAcc * 1.4 * nbExp;
  newEw.nb = +Math.max(0.4, Math.min(1.3, 0.7 + (raw - 0.7) * 0.7)).toFixed(2);
}

  const gbmAcc = gbm.accuracyOOS > 0 ? gbm.accuracyOOS / 100 : 0.5;
  const gbmExp = expectancyFactor(t => typeof t.gbmProb === 'number' && t.gbmProb >= 0.5);
  let rawGbm = gbmAcc * 1.6 * gbmExp;
  newEw.gbm = +Math.max(0.4, Math.min(1.3, 0.9 + (rawGbm - 0.9) * 0.55)).toFixed(2);

  const SCORE_BUY_THRESHOLD = 60;
  let scoreCorrect = 0, scoreTotal = 0;
  recentTrades.forEach(t => {
    if (typeof t.score !== 'number') return;
    scoreTotal++;
    if ((t.score >= SCORE_BUY_THRESHOLD && t.pnl > 0) || (t.score < SCORE_BUY_THRESHOLD && t.pnl <= 0)) scoreCorrect++;
  });
  if (scoreTotal >= 8) {
    const scoreAcc = scoreCorrect / scoreTotal;
    const scoreExp = expectancyFactor(t => typeof t.score === 'number' && t.score >= SCORE_BUY_THRESHOLD);
    let rawScore = scoreAcc * 1.6 * scoreExp;
    newEw.score = +Math.max(0.4, Math.min(1.3, 1.0 + (rawScore - 1.0) * 0.5)).toFixed(2);
  }

  newEw.obi = 0.3;
  return newEw;
}



function makeNB(saved) {
  const nb = {
    model: null, trained: false, trainCount: 0,
    discretize(f) {
      return [
        f.rsiD <= 30 ? 0 : f.rsiD <= 45 ? 1 : f.rsiD <= 60 ? 2 : 3,
        f.macdHist > 0.15 ? 2 : f.macdHist > -0.15 ? 1 : 0,
        f.bbPos < 0.2 ? 0 : f.bbPos < 0.5 ? 1 : f.bbPos < 0.8 ? 2 : 3,
        f.trendD + 1,
        f.mom5 < -5 ? 0 : f.mom5 < 0 ? 1 : f.mom5 < 5 ? 2 : 3,
        f.confirm1h ? 1 : 0
      ];
    },
    trainFromTrades(trades) {
      if (trades.length < 8) return false; // niższe minimum
const bins = [4, 3, 4, 4, 4, 2];
const nF = 6;
const counts = { 0: {}, 1: {} };
const cc = { 0: 0, 1: 0 };
// Łagodniejsze wygładzanie Laplace'a (start od 1.3 zamiast 2)
[0, 1].forEach(cl => {
  for (let f = 0; f < nF; f++) for (let b = 0; b < bins[f]; b++) counts[cl][f + '_' + b] = 1.3;
});
trades.forEach(t => {
  if (!t.nbFeatures) return;
  const lbl = t.pnl > 0 ? 1 : 0;
  cc[lbl]++;
  t.nbFeatures.forEach((bin, f) => {
    counts[lbl][f + '_' + bin] = (counts[lbl][f + '_' + bin] || 0) + 1;
  });
});
const total = cc[0] + cc[1];
if (total < 8) return false;
this.model = { counts, cc, total, bins, nF };
this.trained = true;
this.trainCount = total;
return true;
    },
    predict(features) {
      if (!this.trained || !this.model) return { prob: 0.5, confidence: 'low', label: 'NEUTRAL' };
      const m = this.model;
      const bins = this.discretize(features);
      const lp = {};
      [0, 1].forEach(cl => {
        let p = Math.log((m.cc[cl] + 2) / (m.total + 4));
        for (let f = 0; f < m.nF; f++) {
          const k = f + '_' + bins[f];
          const cnt = m.counts[cl][k] || 2;
          const tot = Object.keys(m.counts[cl])
            .filter(k2 => k2.startsWith(f + '_'))
            .reduce((s, k2) => s + (m.counts[cl][k2] || 0), 0);
          p += Math.log(cnt / Math.max(tot, 1));
        }
        lp[cl] = p;
      });
      const mx = Math.max(lp[0], lp[1]);
      const e0 = Math.exp(lp[0] - mx), e1 = Math.exp(lp[1] - mx);
      const prob = e1 / (e0 + e1);
      const conf = prob > 0.7 || prob < 0.3 ? 'high' : prob > 0.6 || prob < 0.4 ? 'medium' : 'low';
      return {
        prob: +prob.toFixed(3),
        confidence: conf,
        label: prob > 0.55 ? 'BUY' : prob < 0.45 ? 'SKIP' : 'NEUTRAL'
      };
    },
    save() {
      return { model: this.model, trained: this.trained, trainCount: this.trainCount };
    }
  };
  if (saved) {
    nb.model = saved.model;
    nb.trained = saved.trained;
    nb.trainCount = saved.trainCount || 0;
  }
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
      const si = Math.floor(X.length*0.3);
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

// ═══════════════════════════════════════════════════════════════════════════
// WSKAŹNIKI TECHNICZNE
// ═══════════════════════════════════════════════════════════════════════════
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
  let a = trs.slice(0,p).reduce((x,y)=>x+y,0)/p;
  for (let i=p;i<trs.length;i++) a = (a*(p-1)+trs[i])/p;
  return a;
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKET DATA — BYBIT V5
// ═══════════════════════════════════════════════════════════════════════════
const BYBIT_BASE = 'https://api.bybit.com';
function bybitSymbol(sym) { return sym.replace('XBT', 'BTC'); }

function fetchWithTimeout(url, ms, opts) {
  ms = ms || 8000;
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  const options = { signal: ctrl.signal, ...(opts || {}) };
  return fetch(url, options).finally(() => clearTimeout(tid));
}

async function fetchBybitWithRetry(url, tries) {
  tries = tries || 3;
  const delays = [500, 1500, 3000];
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const r = await fetchWithTimeout(url, 8000);
      const d = await r.json();
      if (d.retCode === 10006 || d.retCode === 10018) { lastErr = new Error('Bybit: rate limit (' + d.retCode + ')'); }
      else if (d.retCode !== 0) { lastErr = new Error('Bybit: ' + d.retMsg + ' (' + d.retCode + ')'); }
      else { return d; }
    } catch(e) { lastErr = e; }
    if (attempt < tries - 1) await sleep(delays[attempt] || 3000);
  }
  throw lastErr || new Error('Bybit: nieznany blad');
}

async function getKlines(sym, interval, limit) {
  const bsym = bybitSymbol(sym);
  const d = await fetchBybitWithRetry(
    `${BYBIT_BASE}/v5/market/kline?category=spot&symbol=${bsym}&interval=${interval}&limit=${limit}`
  );
  const list = (d.result && d.result.list) || [];
  if (!list.length) throw new Error('getKlines: pusta lista ' + sym);
  return list.slice().reverse().map(k => [+k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
}

async function getLastPrice(sym) {
  const bsym = bybitSymbol(sym);
  const d = await fetchBybitWithRetry(`${BYBIT_BASE}/v5/market/tickers?category=spot&symbol=${bsym}`);
  const t = (d.result && d.result.list && d.result.list[0]) || null;
  if (!t) throw new Error('getPrice: brak danych ' + sym);
  return +t.lastPrice;
}

async function getOrderbook(sym) {
  try {
    const bsym = bybitSymbol(sym);
    const d = await fetchBybitWithRetry(`${BYBIT_BASE}/v5/market/orderbook?category=spot&symbol=${bsym}&limit=20`, 2);
    const book = d.result || {};
    const bidsArr = book.b || [], asksArr = book.a || [];
    const bids = bidsArr.reduce((s, x) => s + +x[1], 0);
    const asks = asksArr.reduce((s, x) => s + +x[1], 0);
    const total = bids + asks;
    let spreadPct = null;
    if (bidsArr.length && asksArr.length) {
      const bestBid = +bidsArr[0][0], bestAsk = +asksArr[0][0];
      const mid = (bestBid + bestAsk) / 2;
      if (mid > 0 && bestAsk >= bestBid) spreadPct = (bestAsk - bestBid) / mid;
    }
    return { ratio: total > 0 ? bids / total : 0.5, bids, asks, spreadPct };
  } catch(e) { return { ratio: 0.5, spreadPct: null }; }
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

// ═══════════════════════════════════════════════════════════════════════════
// REVOLUT X TRADING — Ed25519 signing
// ═══════════════════════════════════════════════════════════════════════════
function revxInstrument(sym) {
  return sym.replace('XBT','BTC').replace('USDT','/USDC');
}

async function revxImportKey(privKeyB64OrPem) {
  let pem = privKeyB64OrPem;
  if (!pem.includes('-----BEGIN')) {
    pem = '-----BEGIN PRIVATE KEY-----\n' + pem + '\n-----END PRIVATE KEY-----';
  }
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

async function revxSign(message, privKey) {
  const msgBuf = new TextEncoder().encode(message);
  const sigBuf = await crypto.subtle.sign({ name: 'Ed25519' }, privKey, msgBuf);
  return btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
}

// BUG FIX #3: poprzedni komentarz sugerowal format z kropkami ("${ts}.${method}.${path}")
// ale kod concatenuje bez separatorow - sprzeczne. Dokumentacja Revolut X wymaga
// RAW concatenation BEZ separatorow. Z kropkami dostaje sie HTTP 401 "Invalid signature".
async function revxRequest(method, path, body, cfg) {
  const timestamp = String(Date.now());
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

async function revxGetBalance(cfg) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const accounts = await revxRequest('GET', '/accounts', null, cfg);
      if (!Array.isArray(accounts)) throw new Error('Revolut X balance: nieprawidlowa odpowiedz');
      const usdc = accounts.find(a => a.currency === 'USDC');
      return usdc ? +usdc.balance : 0;
    } catch(e) { lastErr = e; if (attempt === 0) await sleep(800); }
  }
  throw lastErr;
}

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

  let details = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(1500);
    try {
      const d = await revxRequest('GET', '/orders/' + order.id, null, cfg);
      details = d;
      if (d && d.average_price && d.filled_base_size) break;
    } catch(e) { /* sprobuj ponownie */ }
  }

  const avgPrice  = details && details.average_price ? +details.average_price : 0;
  const filledQty = details && details.filled_base_size ? +details.filled_base_size : 0;
  if (!avgPrice || !filledQty) {
    await tgSend(cfg, '[KRYTYCZNE] Zlecenie BUY ' + order.id + ' (' + sym + ') zlozone na Revolut X, ale bot nie otrzymal average_price/filled_base_size po 3 probach — SPRAWDZ RECZNIE na Revolut X! Pozycja NIE jest sledzona przez bota.');
    throw new Error('Revolut X buy: zlecenie ' + order.id + ' zlozone, ale brak average_price/filled_base_size po 3 probach — pozycja NIE zapisana (sprawdz recznie!)');
  }
  return { price: avgPrice, qty: filledQty, orderId: order.id };
}

async function revxMarketSell(sym, baseQty, cfg) {
  const instrument_code = revxInstrument(sym);
  const baseSizeStr = baseQty.toFixed(8).replace(/\.?0+$/, '') || '0';
  const body = {
    instrument_code,
    side: 'SELL',
    type: 'MARKET',
    base_size: baseSizeStr
  };
  const order = await revxRequest('POST', '/orders', body, cfg);
  if (!order.id) throw new Error('Revolut X sell: brak order.id — ' + JSON.stringify(order));

  let details = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(1500);
    try {
      const d = await revxRequest('GET', '/orders/' + order.id, null, cfg);
      details = d;
      if (d && d.average_price && d.filled_base_size) break;
    } catch(e) { /* sprobuj ponownie */ }
  }

  const avgPrice  = details && details.average_price ? +details.average_price : 0;
  const filledQty = details && details.filled_base_size ? +details.filled_base_size : 0;
  if (!avgPrice || !filledQty) {
    await tgSend(cfg, '[KRYTYCZNE] Zlecenie SELL ' + order.id + ' (' + sym + ') zlozone na Revolut X, ale bot nie otrzymal average_price/filled_base_size po 3 probach — SPRAWDZ RECZNIE na Revolut X! Pozycja NADAL sledzona przez bota jako otwarta.');
    throw new Error('Revolut X sell: zlecenie ' + order.id + ' zlozone, ale brak average_price/filled_base_size po 3 probach — pozycja NIE zamknieta (sprawdz recznie!)');
  }
  return { price: avgPrice, qty: filledQty, orderId: order.id };
}

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAM
// ═══════════════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════════
// PIN GATE — HELPERY
// ═══════════════════════════════════════════════════════════════════════════
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomToken(len) {
  const bytes = new Uint8Array(len || 32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}
async function isValidSession(env, request) {
  const sid = getCookie(request, 'swingai_sess');
  if (!sid) return false;
  const v = await env.SWINGAI_REVOLUT_KV.get('sess_' + sid);
  return !!v;
}
async function checkPinRateLimit(env, ip) {
  const key = 'pinfail_' + ip;
  const raw = await env.SWINGAI_REVOLUT_KV.get(key);
  const count = raw ? (parseInt(raw, 10) || 0) : 0;
  return { blocked: count >= 5, key };
}
async function recordPinFail(env, key) {
  const raw = await env.SWINGAI_REVOLUT_KV.get(key);
  const count = (raw ? (parseInt(raw, 10) || 0) : 0) + 1;
  await env.SWINGAI_REVOLUT_KV.put(key, String(count), { expirationTtl: 900 });
}
async function clearPinFail(env, key) {
  try { await env.SWINGAI_REVOLUT_KV.delete(key); } catch(e) {}
}
function pinCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = origin.endsWith('.github.io') || origin === 'https://tomekfalek-cyber.github.io';
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'https://tomekfalek-cyber.github.io',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Credentials': 'true'
  };
}
function pinJsonResp(data, status, request) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, pinCorsHeaders(request)) });
}

// ═══════════════════════════════════════════════════════════════════════════
// KV HELPERS
// ═══════════════════════════════════════════════════════════════════════════
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
    tp: 0.02, sl: 0.01, trail: 0.008,
    maxPos: 4, posSize: 15, riskPct: 2,
    paperBalance: 1000, minScore: 62, fgMin: 20,
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
    pairParams: {}, adaptiveMinScore: 62,
    peakBalance: 0, peakBalanceMode: 'paper',
    drawdownBlock: 0, stats: null,
    lastGbmRefit: 0,
    // BUG FIX #1: marker ostatniego progu ensemble (20, 40, 60...) na ktorym
    // rebalans sie odbyl - bez tego kazdy cykl przez cala godzine spamowal.
    lastEnsembleRebalance: 0,
    journal: []
  };
}

function addLog(state, msg, type='info') {
  state.log = [{ ts: new Date().toISOString(), msg, type }, ...(state.log||[])].slice(0, 60);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtPrice(p) {
  if (!isFinite(p)) return String(p);
  if (p >= 1000) return p.toFixed(1);
  if (p >= 1)    return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(6);
  return p.toFixed(8);
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════
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
