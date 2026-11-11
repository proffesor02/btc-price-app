// Portfolio view. Holdings + account labels are AES-GCM encrypted in holdings.enc (key from the family passcode);
// nothing personal is in this file. Edits are kept in this device's localStorage.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const KEY = 'btc.holdings.v1';
  let DEFAULTS = null, LBL = { tfsa: 'Brokerage', btc: 'Self-custody', wallet: 'Hardware wallet', exchange: '' };
  const META = {
    mstr: { name: 'MSTR', desc: 'Strategy · NASDAQ', cur: 'USD', tv: 'NASDAQ:MSTR', acct: 'tfsa' },
    fbtc: { name: 'FBTC', desc: 'Fidelity Advantage Bitcoin ETF · TSX', cur: 'CAD', tv: 'TSX:FBTC', acct: 'tfsa' },
    btc:  { name: 'BTC', desc: 'Hardware wallet', cur: 'CAD', acct: 'btc' }
  };
  let H = null;
  function load() {
    try { const j = JSON.parse(localStorage.getItem(KEY)); if (j && j.mstr && j.fbtc && j.btc) return j; } catch (e) {}
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(H)); } catch (e) {} render(); }

  const Q = (() => { try { return JSON.parse(localStorage.getItem('btc.quotes')) || {}; } catch (e) { return {}; } })();
  let qSource = Q.source || '', qTime = Q.time || 0, fxApi = null, fxApiTime = 0;

  const f0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const f2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (n, sym = 'CA$') => (n < 0 ? '−' : '') + sym + f0.format(Math.abs(n));
  const sgn = n => n > 0 ? '+' : n < 0 ? '−' : '';
  const gainHtml = (g, c) => {
    if (c == null || !c || g == null) return '<span class="g">Cost not set</span>';
    const cls = g > 0 ? 'up' : g < 0 ? 'down' : '';
    return '<span class="g ' + cls + '">' + sgn(g) + 'CA$' + f0.format(Math.abs(g)) + ' (' + sgn(g) + Math.abs(g / c * 100).toFixed(1) + '%)</span>';
  };

  // USD->CAD: Kraken BTC/CAD ÷ BTC/USD (live), fallback open.er-api.com
  function usdcad() {
    const s = window.btcState;
    if (s && s.USD.last && s.CAD.last && Date.now() - Math.min(s.USD.ts, s.CAD.ts) < 600000) return { v: s.CAD.last / s.USD.last, src: 'Kraken BTC CAD/USD ratio' };
    if (fxApi) return { v: fxApi, src: 'open.er-api.com' };
    return null;
  }
  async function loadFx() {
    if (Date.now() - fxApiTime < 3600000) return;
    try { const j = await (await fetch('https://open.er-api.com/v6/latest/USD', { cache: 'no-store' })).json(); if (j.rates && j.rates.CAD) { fxApi = j.rates.CAD; fxApiTime = Date.now(); render(); } } catch (e) {}
  }

  // ---------- Stock quotes ----------
  const COLS = ['close', 'change', 'current_session', 'update_mode'];
  async function tvScan(market, tickers) {
    const r = await fetch('https://scanner.tradingview.com/' + market + '/scan', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, // simple request: no CORS preflight
      body: JSON.stringify({ symbols: { tickers }, columns: COLS }), cache: 'no-store'
    });
    if (!r.ok) throw new Error(r.status);
    const out = {};
    for (const row of (await r.json()).data || []) {
      const k = Object.keys(META).find(x => META[x].tv === row.s); if (!k || !(row.d[0] > 0)) continue;
      out[k] = { price: row.d[0], pct: row.d[1], session: row.d[2] };
    }
    return out;
  }
  async function loadQuotes() {
    let got = {}, src = '';
    try { got = await tvScan('global', ['NASDAQ:MSTR', 'TSX:FBTC']); src = 'TradingView (15-min delayed)'; } catch (e) {}
    if (!got.mstr || !got.fbtc) {
      try {
        const [a, c] = await Promise.allSettled([tvScan('america', ['NASDAQ:MSTR']), tvScan('canada', ['TSX:FBTC'])]);
        got = Object.assign({}, a.value || {}, c.value || {}, got);
        if (got.mstr || got.fbtc) src = 'TradingView (15-min delayed)';
      } catch (e) {}
    }
    if (!got.mstr || !got.fbtc) {
      // Fallback: snapshot written by a GitHub Action every ~15 min from Yahoo Finance.
      try {
        const j = await (await fetch('https://raw.githubusercontent.com/proffesor02/btc-price-app/quotes/quotes.json?t=' + Date.now(), { cache: 'no-store' })).json();
        for (const k of ['mstr', 'fbtc']) if (!got[k] && j[k] && j[k].price > 0) got[k] = { price: j[k].price, pct: j[k].pct, session: j[k].session || '' };
        src = (src ? src + ' + ' : '') + 'Yahoo snapshot ' + new Date(j.time * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      } catch (e) {}
    }
    if (got.mstr || got.fbtc) {
      Object.assign(Q, got); qTime = Date.now(); qSource = src; Q.time = qTime; Q.source = src;
      try { localStorage.setItem('btc.quotes', JSON.stringify(Q)); } catch (e) {}
    } else if (qTime) qSource = 'offline · showing last saved quotes';
    render();
    schedule();
  }
  function marketOpen() { return ['mstr', 'fbtc'].some(k => Q[k] && Q[k].session === 'market'); }
  let qTimer = null;
  function schedule() {
    clearTimeout(qTimer);
    if (document.hidden) return;
    const s = ['mstr', 'fbtc'].map(k => Q[k] && Q[k].session);
    const active = s.some(x => x === 'market' || x === 'pre_market' || x === 'post_market');
    qTimer = setTimeout(loadQuotes, active ? 60000 : 600000);
  }

  // ---------- Render ----------
  function calc() {
    const fx = usdcad(), s = window.btcState || { CAD: {} };
    const r = {};
    const mp = Q.mstr && Q.mstr.price, fp = Q.fbtc && Q.fbtc.price, bp = s.CAD && s.CAD.last;
    r.mstr = { price: mp, value: mp && fx ? H.mstr.qty * mp * fx.v : null, cost: fx ? H.mstr.qty * H.mstr.cost * fx.v : null, costUsd: H.mstr.qty * H.mstr.cost, valueUsd: mp ? H.mstr.qty * mp : null };
    r.fbtc = { price: fp, value: fp ? H.fbtc.qty * fp : null, cost: H.fbtc.qty * H.fbtc.cost };
    r.btc = { price: bp, value: bp ? H.btc.qty * bp : null, cost: H.btc.cost ? H.btc.qty * H.btc.cost : null };
    r.fx = fx;
    return r;
  }
  function holdHtml(k, r) {
    const m = META[k], h = H[k], x = r[k];
    const sess = Q[k] && Q[k].session;
    let pill = '';
    if (k !== 'btc' && sess) pill = sess === 'market' ? '<span class="pill open">Open</span>' : '<span class="pill">' + (sess === 'pre_market' ? 'Pre-market' : sess === 'post_market' ? 'After hours' : 'Closed') + '</span>';
    const qty = k === 'btc' ? h.qty.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') + ' BTC' : f0.format(h.qty) + (k === 'mstr' ? ' sh' : ' units');
    const sym = m.cur === 'USD' ? 'US$' : 'CA$';
    const px = x.price ? (k === 'btc' ? 'CA$' + f0.format(x.price) : sym + f2.format(x.price)) : '—';
    const day = k !== 'btc' && Q[k] && Q[k].pct != null ? ' <span class="g ' + (Q[k].pct >= 0 ? 'up' : 'down') + '">' + sgn(Q[k].pct) + Math.abs(Q[k].pct).toFixed(2) + '%</span>' : '';
    const costTxt = h.cost ? 'avg ' + (k === 'btc' ? 'CA$' + f0.format(h.cost) : sym + f2.format(h.cost)) : 'avg cost not set';
    const usdLine = k === 'mstr' && x.valueUsd ? ' · US$' + f0.format(x.valueUsd) : '';
    return '<div class="hold"><div class="r"><span class="n">' + m.name + pill + '</span><span class="val">' + (x.value != null ? money(x.value) : '—') + '</span></div>'
      + '<div class="r s"><span>' + qty + ' @ ' + px + day + '</span><span>' + gainHtml(x.value != null && x.cost != null ? x.value - x.cost : null, x.cost) + '</span></div>'
      + '<div class="s">' + m.desc + ' · ' + costTxt + usdLine + '</div></div>';
  }
  function render() {
    if (!H) return;
    const r = calc();
    $('pTfsaList').innerHTML = holdHtml('mstr', r) + holdHtml('fbtc', r);
    $('pBtcList').innerHTML = holdHtml('btc', r);
    const tv = r.mstr.value != null && r.fbtc.value != null ? r.mstr.value + r.fbtc.value : null;
    const tc = r.mstr.cost != null ? r.mstr.cost + r.fbtc.cost : null;
    $('pTfsa').innerHTML = tv != null ? money(tv) + ' · ' + gainHtml(tv - tc, tc) : '—';
    $('pBtc').innerHTML = r.btc.value != null ? money(r.btc.value) + (r.btc.cost ? ' · ' + gainHtml(r.btc.value - r.btc.cost, r.btc.cost) : '') : '—';
    const total = tv != null && r.btc.value != null ? tv + r.btc.value : null;
    $('pTotal').textContent = total != null ? f0.format(total) : '—';
    // Gain on positions with a known cost basis only
    let gv = 0, gc = 0;
    for (const k of ['mstr', 'fbtc', 'btc']) if (r[k].value != null && r[k].cost) { gv += r[k].value; gc += r[k].cost; }
    $('pGain').innerHTML = gc ? 'Gain vs cost ' + gainHtml(gv - gc, gc) + (r.btc.cost ? '' : ' <span style="opacity:.7">(excl. ' + LBL.btc + ' BTC)</span>') : '&nbsp;';
    // Day change (approx: stocks' % today + BTC 24h)
    const s = window.btcState;
    let dv = 0, ok = total != null;
    if (ok) {
      for (const k of ['mstr', 'fbtc']) { const p = Q[k] && Q[k].pct; if (p != null) dv += r[k].value - r[k].value / (1 + p / 100); }
      if (s && s.CAD.pct != null) dv += r.btc.value - r.btc.value / (1 + s.CAD.pct / 100);
      const pct = dv / (total - dv) * 100, el = $('pDay');
      el.textContent = sgn(dv) + 'CA$' + f0.format(Math.abs(dv)) + ' today';
      el.className = 'chg ' + (dv > 0 ? 'up' : dv < 0 ? 'down' : '');
      el.title = pct.toFixed(2) + '%';
    }
    $('pFx').textContent = r.fx ? 'USD/CAD ' + r.fx.v.toFixed(4) + ' · ' + r.fx.src : 'USD/CAD loading…';
    if (qTime) {
      const t = new Date(qTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
      const mins = Math.round((Date.now() - qTime) / 60000);
      $('pUpd').textContent = t + (mins >= 2 ? ' (' + mins + ' min ago)' : '') + (marketOpen() ? '' : ' · markets closed');
    }
    $('pSrc').textContent = qSource ? 'Stocks: ' + qSource : '';
  }

  // ---------- Editing ----------
  const sheet = $('sheet'), box = $('sheetBox');
  const num = v => { const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) && String(v).trim() !== '' ? n : null; };
  function open(html, onSave) {
    box.innerHTML = html + '<div class="btns"><button class="btn" type="button" id="sCancel">Cancel</button><button class="btn pri" type="button" id="sSave">Save</button></div>';
    sheet.hidden = false;
    $('sCancel').onclick = () => { sheet.hidden = true; };
    $('sSave').onclick = () => { if (onSave() !== false) { sheet.hidden = true; save(); } };
  }
  sheet.addEventListener('click', e => { if (e.target === sheet) sheet.hidden = true; });
  const inp = (id, v, ph) => '<input id="' + id + '" inputmode="decimal" value="' + (v == null ? '' : v) + '" placeholder="' + (ph || '') + '">';
  $('pEdit').onclick = () => open('<h3>Edit holdings</h3>'
    + '<fieldset><legend>' + LBL.tfsa + ' · MSTR (USD)</legend><div class="two"><div><label>Shares</label>' + inp('eMq', H.mstr.qty) + '</div><div><label>Avg cost US$</label>' + inp('eMc', H.mstr.cost) + '</div></div></fieldset>'
    + '<fieldset><legend>' + LBL.tfsa + ' · FBTC (CAD)</legend><div class="two"><div><label>Units</label>' + inp('eFq', H.fbtc.qty) + '</div><div><label>Avg cost CA$</label>' + inp('eFc', H.fbtc.cost) + '</div></div></fieldset>'
    + '<fieldset><legend>' + LBL.btc + ' · BTC</legend><div class="two"><div><label>BTC</label>' + inp('eBq', H.btc.qty) + '</div><div><label>Avg cost CA$/BTC</label>' + inp('eBc', H.btc.cost, 'optional') + '</div></div></fieldset>'
    + '<button class="btn" type="button" id="eReset" style="width:100%">Reset to defaults</button>',
    () => {
      const v = { mq: num($('eMq').value), mc: num($('eMc').value), fq: num($('eFq').value), fc: num($('eFc').value), bq: num($('eBq').value), bc: num($('eBc').value) };
      if ([v.mq, v.mc, v.fq, v.fc, v.bq].some(x => x == null || x < 0)) { alert('Please fill in every amount (BTC cost is optional).'); return false; }
      H = { mstr: { qty: v.mq, cost: v.mc }, fbtc: { qty: v.fq, cost: v.fc }, btc: { qty: v.bq, cost: v.bc && v.bc > 0 ? v.bc : null } };
    });
  box.addEventListener('click', e => { if (e.target.id === 'eReset' && confirm('Reset holdings to the defaults?')) { H = JSON.parse(JSON.stringify(DEFAULTS)); sheet.hidden = true; save(); } });
  $('pAddBuy').onclick = () => open('<h3>Add a buy</h3>'
    + '<label>What did you buy?</label><select id="bK"><option value="btc">BTC (to ' + LBL.btc + ')</option><option value="fbtc">FBTC (' + LBL.tfsa + ')</option><option value="mstr">MSTR (' + LBL.tfsa + ')</option></select>'
    + '<div class="two"><div><label id="bQl">BTC received</label>' + inp('bQ', '', '0.0042') + '</div><div><label id="bAl">Total paid CA$</label>' + inp('bA', '', '500') + '</div></div>'
    + '<div class="hint" id="bHint">Adds to your BTC amount. If no average cost is set, BTC cost basis stays blank (set it in Edit holdings).</div>',
    () => {
      const k = $('bK').value, q = num($('bQ').value), a = num($('bA').value);
      if (!(q > 0) || !(a > 0)) { alert('Enter the amount bought and the total paid.'); return false; }
      const h = H[k];
      if (k === 'btc' && !h.cost) { h.qty += q; return; } // unknown basis stays unknown
      h.cost = (h.qty * h.cost + a) / (h.qty + q); h.qty += q;
    });
  box.addEventListener('change', e => {
    if (e.target.id !== 'bK') return;
    const k = e.target.value;
    $('bQl').textContent = k === 'btc' ? 'BTC received' : k === 'mstr' ? 'Shares' : 'Units';
    $('bAl').textContent = k === 'mstr' ? 'Total paid US$' : 'Total paid CA$';
    $('bHint').textContent = k === 'btc' ? 'Adds to your BTC amount. If no average cost is set, BTC cost basis stays blank (set it in Edit holdings).' : 'Adds the units and updates your average cost.';
  });

  // ---------- Tabs ----------
  function tab(p) {
    $('viewPrice').hidden = p; $('viewPort').hidden = !p;
    $('tabPrice').classList.toggle('on', !p); $('tabPort').classList.toggle('on', p);
    try { localStorage.setItem('btc.tab', p ? 'port' : 'price'); } catch (e) {}
    if (p) render();
  }
  $('tabPrice').onclick = () => tab(false);
  $('tabPort').onclick = () => tab(true);
  tab(/portfolio/.test(location.hash) || (localStorage.getItem('btc.tab') === 'port' && !/orders=/.test(location.hash)));

  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadQuotes(); loadFx(); } else clearTimeout(qTimer); });
  setInterval(() => { if (H && !$('viewPort').hidden) render(); }, 2000); // pick up live BTC ticks
  // ---------- Passcode gate ----------
  const CRYPTO = { salt: 'fe051d09a49d3d1d6b2e4c8bdb13f8e8', iterations: 600000 };
  const hex = s => new Uint8Array(s.match(/../g).map(x => parseInt(x, 16)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function decryptHoldings(pass) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: hex(CRYPTO.salt), iterations: CRYPTO.iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const r = await fetch('holdings.enc?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) throw new Error('fetch');
    const e = await r.json();
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv) }, key, unb64(e.ct))));
  }
  function applyUnlocked(d) {
    DEFAULTS = d.holdings; Object.assign(LBL, d.labels || {});
    META.btc.desc = LBL.wallet;
    $('lblTfsa').textContent = LBL.tfsa; $('lblBtc').textContent = 'Bitcoin · ' + LBL.btc;
    if (LBL.exchange) $('ordersTitle').textContent = LBL.exchange + ' limit buys';
    H = load();
    $('pLock').hidden = true; $('pBody').hidden = false;
    render(); loadFx(); loadQuotes();
  }
  async function unlock(pass) { const d = await decryptHoldings(pass); try { localStorage.setItem('btc.pass', pass); } catch (e) {} applyUnlocked(d); }
  $('pLockForm').addEventListener('submit', async e => {
    e.preventDefault(); const pass = $('pPass').value.trim(); if (!pass) return;
    $('pLockErr').textContent = ''; $('pUnlock').disabled = true; $('pUnlock').textContent = 'Checking…';
    try { await unlock(pass); $('pPass').value = ''; }
    catch (err) { $('pLockErr').textContent = err && err.name === 'OperationError' ? 'That passcode didn\u2019t work.' : 'Couldn\u2019t load. Try again.'; }
    finally { $('pUnlock').disabled = false; $('pUnlock').textContent = 'Unlock'; }
  });
  $('pLockBtn').addEventListener('click', () => {
    if (!confirm('Lock the portfolio on this phone? Your edits stay saved here.')) return;
    try { localStorage.removeItem('btc.pass'); } catch (e) {} location.reload();
  });
  (async () => {
    let saved = null; try { saved = localStorage.getItem('btc.pass'); } catch (e) {}
    if (!saved) return;
    try { await unlock(saved); } catch (err) { if (err && err.name === 'OperationError') try { localStorage.removeItem('btc.pass'); } catch (e) {} }
  })();
})();
