/* =====================================================================
   RoboStore — 11th Committee Robotics Club store ledger
   All data lives in Supabase. Every write goes through a database function
   that re-checks the rules, so the browser can never corrupt the ledger.
   ===================================================================== */
(() => {
  'use strict';

  const cfg = window.ROBOSTORE_CONFIG;
  const CACHE_KEY = 'robostore-cache-v1';
  const VIEW_KEY = 'robostore-view';
  const PAGE = 1000; // PostgREST returns at most 1000 rows per request

  if (!window.supabase || !cfg) {
    document.getElementById('boot').innerHTML =
      '<p class="p-8 text-center font-bold text-red-700">The app failed to load. Refresh the page.</p>';
    return;
  }

  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'robostore-auth' },
  });

  // ─────────────────────────── State ───────────────────────────
  const state = {
    components: [],   // rows of component_stock
    issues: [],       // rows of issues
    view: readPref(VIEW_KEY, 'stock'),
    logFilter: 'all',
    search: '',
    online: true,     // false => showing cached data, writes disabled
    lastSync: null,
    session: null,
    channel: null,
  };

  // ─────────────────────────── DOM helpers ───────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const show = (el, on = true) => el.classList.toggle('hidden-section', !on);

  /** Build an element safely: text is always set via textContent (no HTML injection). */
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function readPref(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
  }
  function writePref(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
  }

  // ─────────────────────────── Dates ───────────────────────────
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  /** '2026-11-05' -> '05 Nov 2026' (no timezone shifting) */
  function fmtDate(s) {
    if (!s) return '';
    const [y, m, d] = s.slice(0, 10).split('-').map(Number);
    return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
  }
  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // ─────────────────────────── Toasts & errors ───────────────────────────
  function toast(msg, type = 'ok', ms = 4000) {
    const t = el('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status', text: msg });
    const box = $('#toasts');
    box.append(t);
    while (box.children.length > 3) box.firstElementChild.remove();
    setTimeout(() => t.remove(), type === 'error' ? Math.max(ms, 7000) : ms);
  }

  function isNetworkError(e) {
    const m = String(e?.message || e || '');
    return e instanceof TypeError || /Failed to fetch|NetworkError|Load failed|network|fetch failed/i.test(m);
  }

  function errMsg(e) {
    if (!e) return 'Something went wrong.';
    if (isNetworkError(e)) return "Couldn't reach the server. Nothing was saved — check your internet and try again.";
    const m = String(e.message || e);
    if (/JWT|token is expired|PGRST30[0-3]/i.test(m + (e.code || ''))) return 'Your session expired. Please log in again.';
    if (e.code === '23505') return 'That already exists.';
    if (e.code === '57014') return 'The server took too long. Nothing was saved — try again.';
    if (e.code === '55P03' || /lock timeout/i.test(m)) return 'Someone else is updating this item right now. Try again in a moment.';
    return m;
  }

  // ─────────────────────────── Data loading ───────────────────────────
  async function fetchAll(makeQuery) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await makeQuery().range(from, from + PAGE - 1);
      if (error) throw error;
      rows.push(...data);
      if (data.length < PAGE) return rows;
    }
  }

  let loading = null;
  let reloadAgain = false;
  async function load() {
    if (loading) { reloadAgain = true; return loading; }
    loading = (async () => {
      try {
        const [components, issues] = await Promise.all([
          fetchAll(() => sb.from('component_stock').select('*').order('name').order('id')),
          fetchAll(() => sb.from('issues')
            .select('id, component_id, units, borrower_name, roll_number, issued_on, returned_on, binned_at, created_at')
            .order('issued_on', { ascending: false }).order('id', { ascending: false })),
        ]);
        state.components = components;
        state.issues = issues;
        state.lastSync = new Date();
        setOnline(true);
        saveCache();
      } catch (e) {
        if (!isNetworkError(e) && /JWT|PGRST30/i.test(String(e.message) + (e.code || ''))) {
          toast('Your session expired. Please log in again.', 'error');
          await sb.auth.signOut();
          return;
        }
        if (!restoreCache()) toast(errMsg(e), 'error');
        setOnline(false);
      } finally {
        render();
      }
    })();
    try { await loading; } finally {
      loading = null;
      if (reloadAgain) { reloadAgain = false; load(); }
    }
  }

  let reloadTimer = null;
  function scheduleReload(delay = 250) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, delay);
  }

  function saveCache() {
    writePref(CACHE_KEY, JSON.stringify({ at: state.lastSync.toISOString(), components: state.components, issues: state.issues }));
  }
  function restoreCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (!c) return false;
      state.components = c.components || [];
      state.issues = c.issues || [];
      state.lastSync = new Date(c.at);
      return true;
    } catch { return false; }
  }
  function clearCache() {
    try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
  }

  function setOnline(on) {
    state.online = on;
    document.body.classList.toggle('read-only', !on);
    const banner = $('#conn-banner');
    if (on) { show(banner, false); return; }
    banner.textContent = state.lastSync
      ? `Offline — showing data saved at ${fmtDateTime(state.lastSync)}. Changes are disabled until the connection returns.`
      : 'Offline — cannot reach the server. Changes are disabled until the connection returns.';
    show(banner, true);
    setLive('offline');
  }

  // ─────────────────────────── Realtime ───────────────────────────
  function setLive(status) {
    const s = $('#live-status');
    s.classList.remove('live', 'reconnecting', 'offline');
    const label = { live: 'Live', reconnecting: 'Reconnecting', offline: 'Offline' }[status] || 'Connecting';
    if (status) s.classList.add(status);
    $('.label', s).textContent = label;
    s.title = status === 'live' ? 'Changes from other devices appear automatically' : 'Connection status';
  }

  function subscribe() {
    unsubscribe();
    state.channel = sb.channel('robostore-db')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'components' }, () => scheduleReload())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_entries' }, () => scheduleReload())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'issues' }, () => scheduleReload())
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') { setLive(state.online ? 'live' : 'offline'); scheduleReload(0); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setLive('reconnecting');
      });
  }
  function unsubscribe() {
    if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
  }

  // Fallbacks in case a realtime message is missed.
  setInterval(() => { if (state.session && document.visibilityState === 'visible') load(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (state.session && document.visibilityState === 'visible') load(); });
  window.addEventListener('online', () => { if (state.session) load(); });
  window.addEventListener('offline', () => { if (state.session) setOnline(false); });

  // ─────────────────────────── Auth ───────────────────────────
  function showScreen(name) {
    show($('#boot'), name === 'boot');
    show($('#login-page'), name === 'login');
    show($('#app'), name === 'app');
  }

  async function enterApp(session) {
    state.session = session;
    showScreen('app');
    restoreCache() && render();
    await load();
    subscribe();
  }

  function leaveApp() {
    state.session = null;
    unsubscribe();
    clearCache();
    state.components = [];
    state.issues = [];
    closeAllModals();
    showScreen('login');
    $('#password').value = '';
    $('#username').focus();
  }

  sb.auth.onAuthStateChange((event, session) => {
    // Never await Supabase calls inside this callback (supabase-js deadlock); defer instead.
    setTimeout(() => {
      if (event === 'INITIAL_SESSION') session ? enterApp(session) : leaveApp();
      else if (event === 'SIGNED_OUT') leaveApp();
      else if (event === 'TOKEN_REFRESHED' && session) state.session = session;
    }, 0);
  });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    const btn = $('#login-submit');
    const username = $('#username').value.trim().toLowerCase();
    const password = $('#password').value;
    show(err, false);
    if (!username || !password) { err.textContent = 'Enter your username and password.'; show(err); return; }

    btn.disabled = true; btn.textContent = 'Verifying…';
    try {
      const { data, error } = await sb.auth.signInWithPassword({ email: `${username}@${cfg.loginDomain}`, password });
      if (error) throw error;
      const { data: staff, error: sErr } = await sb.from('staff').select('user_id').eq('user_id', data.user.id).maybeSingle();
      if (sErr) throw sErr;
      if (!staff) {
        await sb.auth.signOut();
        throw new Error('This account does not have access to the store.');
      }
      enterApp(data.session);
    } catch (ex) {
      err.textContent = /invalid login credentials/i.test(ex.message || '')
        ? 'Authentication failed. Please verify credentials.'
        : errMsg(ex);
      show(err);
    } finally {
      btn.disabled = false; btn.textContent = 'Initialize Session';
    }
  });

  $('#toggle-password').addEventListener('click', (e) => {
    const p = $('#password');
    p.type = p.type === 'password' ? 'text' : 'password';
    e.currentTarget.textContent = p.type === 'password' ? 'Show' : 'Hide';
  });

  $('#logout-btn').addEventListener('click', async () => {
    const { error } = await sb.auth.signOut();
    if (error) { await sb.auth.signOut({ scope: 'local' }); }
    leaveApp();
  });

  // ─────────────────────────── Rendering ───────────────────────────
  const componentById = () => new Map(state.components.map((c) => [c.id, c]));
  const matches = (q, ...fields) => !q || fields.some((f) => String(f || '').toLowerCase().includes(q));

  function render() {
    const q = state.search.trim().toLowerCase();
    const byId = componentById();
    const active = state.components.filter((c) => !c.binned_at);
    const binnedComponents = state.components.filter((c) => c.binned_at);
    const liveIssues = state.issues.filter((i) => !i.binned_at);
    const binnedIssues = state.issues.filter((i) => i.binned_at);

    // Summary
    $('#stat-components').textContent = active.length;
    $('#stat-available').textContent = active.reduce((s, c) => s + c.available_units, 0);
    $('#stat-loaned').textContent = active.reduce((s, c) => s + c.loaned_units, 0);
    const binTotal = binnedComponents.length + binnedIssues.length;
    $('#bin-count').textContent = binTotal;
    show($('#bin-count'), binTotal > 0);

    // Tabs
    for (const t of $$('.view-tab')) t.classList.toggle('active', t.dataset.view === state.view);
    for (const t of $$('.filter-tab')) t.classList.toggle('active', t.dataset.filter === state.logFilter);
    show($('#view-stock'), state.view === 'stock');
    show($('#view-logs'), state.view === 'logs');
    show($('#view-bin'), state.view === 'bin');

    renderStock(active.filter((c) => matches(q, c.name)), active.length);
    renderLogs(liveIssues.filter((i) => {
      if (state.logFilter === 'active' && i.returned_on) return false;
      if (state.logFilter === 'returned' && !i.returned_on) return false;
      return matches(q, i.borrower_name, i.roll_number, byId.get(i.component_id)?.name);
    }), byId, liveIssues.length);
    renderBin(
      binnedComponents.filter((c) => matches(q, c.name)),
      binnedIssues.filter((i) => matches(q, i.borrower_name, i.roll_number, byId.get(i.component_id)?.name)),
      byId,
    );

    // Datalist for the add form
    const dl = $('#component-names');
    dl.replaceChildren(...active.map((c) => el('option', { value: c.name })));

    $('#last-sync').textContent = state.lastSync ? `Last synced ${fmtDateTime(state.lastSync)}` : '';
  }

  function emptyMsg(node, shown, total, noun) {
    node.textContent = total === 0 ? `No ${noun} yet.` : 'Nothing matches your search.';
    show(node, shown === 0);
  }

  function renderStock(rows, total) {
    const body = $('#stock-body');
    body.replaceChildren(...rows.map((c) => el('tr', {},
      el('td', { class: 'font-bold text-gray-950', text: c.name }),
      el('td', { class: 'tech-font text-gray-600 whitespace-nowrap', text: fmtDate(c.date_added) }),
      el('td', { class: 'text-center tech-font text-gray-600', text: c.total_units }),
      el('td', { class: 'text-center' },
        el('span', { class: `pill ${c.available_units > 0 ? 'pill-ok' : 'pill-none'}`, text: `${c.available_units} Units` })),
      el('td', { class: 'text-center tech-font text-gray-600', text: c.loaned_units }),
      el('td', { class: 'text-right write-only' },
        el('div', { class: 'flex gap-2 justify-end' },
          el('button', { class: 'act act-issue', text: 'Issue', disabled: c.available_units < 1, onclick: () => openIssue(c.id) }),
          el('button', { class: 'act act-bin', text: 'Move to bin', onclick: () => binComponent(c) }),
          el('button', { class: 'act act-delete', text: 'Delete permanently', onclick: () => deleteComponent(c) }),
        )),
    )));
    emptyMsg($('#stock-empty'), rows.length, total, 'components — use “+ New Entry” to add one');
  }

  function borrowerCell(i) {
    return el('td', { class: 'whitespace-nowrap' },
      el('div', { class: 'font-bold text-gray-950', text: i.borrower_name }),
      el('div', { class: 'tech-font text-xs text-gray-500', text: i.roll_number }));
  }
  function componentCell(i, byId) {
    const c = byId.get(i.component_id);
    return el('td', { class: 'font-bold text-gray-900' },
      c ? c.name : 'Unknown component',
      c?.binned_at ? el('span', { class: 'text-xs text-gray-500 font-normal', text: ' (in bin)' }) : null,
      ' / ', el('span', { class: 'tech-font', text: `${i.units} Unit${i.units === 1 ? '' : 's'}` }));
  }

  function renderLogs(rows, byId, total) {
    $('#logs-body').replaceChildren(...rows.map((i) => el('tr', {},
      el('td', { class: 'tech-font font-bold text-gray-600 whitespace-nowrap', text: fmtDate(i.issued_on) }),
      borrowerCell(i),
      componentCell(i, byId),
      el('td', { class: 'text-center whitespace-nowrap' },
        i.returned_on
          ? el('span', { class: 'pill pill-returned', text: `Returned ${fmtDate(i.returned_on)}` })
          : el('span', { class: 'pill bg-amber-50 text-amber-800 border border-amber-200', text: 'On loan' })),
      el('td', { class: 'text-right write-only' },
        el('div', { class: 'flex gap-2 justify-end' },
          i.returned_on ? null : el('button', { class: 'act act-return', text: 'Return', onclick: () => openReturn(i) }),
          el('button', { class: 'act act-bin', text: 'Move to bin', onclick: () => binIssue(i, byId) }),
          el('button', { class: 'act act-delete', text: 'Delete permanently', onclick: () => deleteIssue(i, byId) }),
        )),
    )));
    emptyMsg($('#logs-empty'), rows.length, total, 'issue records');
  }

  function renderBin(comps, issues, byId) {
    $('#bin-components-body').replaceChildren(...comps.map((c) => el('tr', {},
      el('td', { class: 'font-bold text-gray-950', text: c.name }),
      el('td', { class: 'text-center tech-font text-gray-600', text: c.total_units }),
      el('td', { class: 'tech-font text-gray-600 whitespace-nowrap', text: fmtDateTime(c.binned_at) }),
      el('td', { class: 'text-right write-only' },
        el('div', { class: 'flex gap-2 justify-end' },
          el('button', { class: 'act act-restore', text: 'Restore', onclick: (e) => restore('component', c.id, c.name, e.currentTarget) }),
          el('button', { class: 'act act-delete', text: 'Delete permanently', onclick: () => deleteComponent(c) }),
        )),
    )));
    show($('#bin-components-empty'), comps.length === 0);

    $('#bin-issues-body').replaceChildren(...issues.map((i) => el('tr', {},
      el('td', { class: 'tech-font font-bold text-gray-600 whitespace-nowrap', text: fmtDate(i.issued_on) }),
      borrowerCell(i),
      componentCell(i, byId),
      el('td', { class: 'tech-font text-gray-600 whitespace-nowrap', text: fmtDateTime(i.binned_at) }),
      el('td', { class: 'text-right write-only' },
        el('div', { class: 'flex gap-2 justify-end' },
          el('button', { class: 'act act-restore', text: 'Restore', onclick: (e) => restore('issue', i.id, `${i.borrower_name}'s record`, e.currentTarget) }),
          el('button', { class: 'act act-delete', text: 'Delete permanently', onclick: () => deleteIssue(i, byId) }),
        )),
    )));
    show($('#bin-issues-empty'), issues.length === 0);
  }

  // ─────────────────────────── View controls ───────────────────────────
  for (const t of $$('.view-tab')) {
    t.addEventListener('click', () => { state.view = t.dataset.view; writePref(VIEW_KEY, state.view); render(); });
  }
  for (const t of $$('.filter-tab')) {
    t.addEventListener('click', () => { state.logFilter = t.dataset.filter; render(); });
  }
  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = e.target.value; render(); }, 120);
  });
  if (!['stock', 'logs', 'bin'].includes(state.view)) state.view = 'stock';

  // ─────────────────────────── Modals ───────────────────────────
  let lastFocus = null;
  function openModal(id) {
    lastFocus = document.activeElement;
    const m = $(`#${id}`);
    show(m, true);
    document.body.classList.add('overflow-hidden');
    const first = m.querySelector('input:not([type=hidden]):not(.hidden-section), select, textarea');
    setTimeout(() => (first || m.querySelector('button'))?.focus(), 30);
  }
  function closeModal(id) {
    show($(`#${id}`), false);
    if (!$$('.modal').some((m) => !m.classList.contains('hidden-section'))) document.body.classList.remove('overflow-hidden');
    lastFocus?.focus?.();
  }
  function closeAllModals() { for (const m of $$('.modal')) closeModal(m.id); }

  for (const m of $$('.modal')) {
    m.addEventListener('mousedown', (e) => { if (e.target === m) m.dataset.downOnBackdrop = '1'; });
    m.addEventListener('click', (e) => {
      if (e.target === m && m.dataset.downOnBackdrop === '1') closeModal(m.id);
      delete m.dataset.downOnBackdrop;
    });
    for (const b of $$('[data-close]', m)) b.addEventListener('click', () => closeModal(m.id));
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = $$('.modal').filter((m) => !m.classList.contains('hidden-section')).pop();
    if (open) closeModal(open.id);
    else show($('#export-menu'), false);
  });

  function formError(form, msg) {
    const p = $('.form-error', form);
    p.textContent = msg || '';
    show(p, !!msg);
  }

  /** Runs a write. Disables the button, shows errors, refreshes data on success. */
  async function mutate(button, fn, { form, success } = {}) {
    if (!state.online) { toast('You are offline. Changes are disabled until the connection returns.', 'error'); return false; }
    const label = button?.textContent;
    if (button) { button.disabled = true; button.textContent = 'Saving…'; }
    if (form) formError(form, '');
    try {
      const { error } = await fn();
      if (error) throw error;
      if (success) toast(success);
      await load();
      return true;
    } catch (e) {
      const msg = errMsg(e);
      if (form) formError(form, msg); else toast(msg, 'error');
      return false;
    } finally {
      if (button) { button.disabled = false; button.textContent = label; }
    }
  }

  // ─── Date fields: "today" quick button or a custom date ───
  function dateField(name) {
    const root = $(`[data-date-field="${name}"]`);
    const input = $('input[type=date]', root);
    const preview = $('.date-preview', root);
    let mode = 'today';
    const api = {
      reset() { input.value = ''; api.setMode('today'); },
      setMode(m) {
        mode = m;
        for (const b of $$('.date-mode', root)) b.classList.toggle('active', b.dataset.mode === m);
        show(input, m === 'custom');
        input.max = todayStr();
        if (m === 'custom') { if (!input.value) input.value = todayStr(); input.focus(); }
        api.update();
      },
      update() { preview.textContent = api.value() ? fmtDate(api.value()) : ''; },
      value() { return mode === 'today' ? todayStr() : input.value; },
      setMin(min) { input.min = min || ''; },
    };
    for (const b of $$('.date-mode', root)) b.addEventListener('click', () => api.setMode(b.dataset.mode));
    input.addEventListener('input', api.update);
    return api;
  }
  const addDate = dateField('add');
  const issueDate = dateField('issue');
  const returnDate = dateField('return');

  function checkDate(value, label, min) {
    if (!value) return `${label} is required.`;
    if (value > todayStr()) return `${label} can't be in the future.`;
    if (min && value < min) return `${label} can't be before ${fmtDate(min)}.`;
    return null;
  }

  // ─── New entry ───
  let addRequestId = null;
  $('#open-add').addEventListener('click', () => {
    const f = $('#form-add');
    f.reset(); formError(f, ''); addDate.reset(); updateAddHint();
    addRequestId = crypto.randomUUID();
    openModal('modal-add');
  });
  function updateAddHint() {
    const name = $('#add-name').value.trim().replace(/\s+/g, ' ').toLowerCase();
    const existing = state.components.find((c) => c.name.toLowerCase() === name);
    $('#add-name-hint').textContent = !name ? '' : existing
      ? existing.binned_at
        ? `"${existing.name}" is in the bin — restore it from the Bin page instead.`
        : `Adds to existing stock of "${existing.name}" (currently ${existing.total_units}).`
      : 'New component.';
  }
  $('#add-name').addEventListener('input', updateAddHint);

  $('#form-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const name = $('#add-name').value.trim().replace(/\s+/g, ' ');
    const units = Number($('#add-units').value);
    const date = addDate.value();
    if (!name) return formError(f, 'Component name is required.');
    if (!Number.isInteger(units) || units < 1) return formError(f, 'Units must be a whole number of at least 1.');
    if (units > 100000) return formError(f, 'Units must be 100000 or less.');
    const dErr = checkDate(date, 'Date added'); if (dErr) return formError(f, dErr);

    const existing = state.components.find((c) => !c.binned_at && c.name.toLowerCase() === name.toLowerCase());
    const ok = await mutate($('button[type=submit]', f),
      () => sb.rpc('add_stock', { p_name: name, p_units: units, p_added_on: date, p_request_id: addRequestId }),
      { form: f, success: `Added ${units} × ${existing ? existing.name : name}` });
    if (ok) { addRequestId = null; closeModal('modal-add'); }
  });

  // ─── Issue ───
  let issueRequestId = null;
  function fillIssueSelect(preselect) {
    const sel = $('#issue-component');
    const avail = state.components.filter((c) => !c.binned_at && c.available_units > 0);
    const prev = preselect ?? Number(sel.value);
    sel.replaceChildren(
      el('option', { value: '', text: avail.length ? 'Select a component…' : 'Nothing available' }),
      ...avail.map((c) => el('option', { value: c.id, text: `${c.name} — ${c.available_units} available` })),
    );
    if (avail.some((c) => c.id === prev)) sel.value = String(prev);
    show($('#issue-none'), avail.length === 0);
    updateIssueUnits();
  }
  function updateIssueUnits() {
    const c = state.components.find((x) => x.id === Number($('#issue-component').value));
    const u = $('#issue-units');
    u.max = c ? c.available_units : '';
    $('#issue-units-hint').textContent = c ? `${c.available_units} available` : '';
  }
  function openIssue(componentId) {
    const f = $('#form-issue');
    f.reset(); formError(f, ''); issueDate.reset();
    $('#issue-roll-hint').textContent = '';
    delete f.dataset.rollConfirmed;
    fillIssueSelect(componentId);
    issueRequestId = crypto.randomUUID();
    openModal('modal-issue');
    if (componentId) setTimeout(() => $('#issue-units').focus(), 40);
  }
  $('#open-issue').addEventListener('click', () => openIssue());
  $('#issue-component').addEventListener('change', updateIssueUnits);
  $('#issue-roll').addEventListener('input', () => { delete $('#form-issue').dataset.rollConfirmed; $('#issue-roll-hint').textContent = ''; });

  const ROLL_RE = /^\d{3}[A-Z]{3}\d{3}$/;
  $('#form-issue').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const componentId = Number($('#issue-component').value);
    const c = state.components.find((x) => x.id === componentId);
    const units = Number($('#issue-units').value);
    const name = $('#issue-name').value.trim().replace(/\s+/g, ' ');
    const roll = $('#issue-roll').value.replace(/\s+/g, '').toUpperCase();
    const date = issueDate.value();

    if (!c) return formError(f, 'Choose a component.');
    if (!Number.isInteger(units) || units < 1) return formError(f, 'Units must be a whole number of at least 1.');
    if (units > c.available_units) return formError(f, `Only ${c.available_units} unit(s) of "${c.name}" available.`);
    if (!name) return formError(f, "Borrower's full name is required.");
    if (!roll) return formError(f, "Borrower's roll number is required.");
    const dErr = checkDate(date, 'Issue date'); if (dErr) return formError(f, dErr);
    if (!ROLL_RE.test(roll) && !f.dataset.rollConfirmed) {
      $('#issue-roll-hint').textContent = `"${roll}" doesn't look like a roll number (e.g. 080BEI013). Press "Log Transaction" again to save it anyway.`;
      f.dataset.rollConfirmed = '1';
      return;
    }

    const ok = await mutate($('button[type=submit]', f),
      () => sb.rpc('issue_component', {
        p_component_id: componentId, p_units: units, p_borrower_name: name,
        p_roll_number: roll, p_issued_on: date, p_request_id: issueRequestId,
      }),
      { form: f, success: `Issued ${units} × ${c.name} to ${name}` });
    if (ok) { issueRequestId = null; closeModal('modal-issue'); }
  });

  // ─── Return ───
  let returning = null;
  function openReturn(issue) {
    returning = issue;
    const c = state.components.find((x) => x.id === issue.component_id);
    const f = $('#form-return');
    formError(f, ''); returnDate.reset(); returnDate.setMin(issue.issued_on);
    $('#return-summary').replaceChildren(
      el('strong', { text: issue.borrower_name }), ` (${issue.roll_number}) is returning `,
      el('strong', { text: `${issue.units} × ${c ? c.name : 'component'}` }),
      `, issued on ${fmtDate(issue.issued_on)}.`);
    openModal('modal-return');
  }
  $('#form-return').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const date = returnDate.value();
    const dErr = checkDate(date, 'Return date', returning.issued_on); if (dErr) return formError(f, dErr);
    const ok = await mutate($('button[type=submit]', f),
      () => sb.rpc('return_issue', { p_issue_id: returning.id, p_returned_on: date }),
      { form: f, success: `Marked returned: ${returning.borrower_name}` });
    if (ok) closeModal('modal-return');
  });

  // ─── Confirm dialog ───
  function confirmDialog({ title, body, ok, danger }) {
    return new Promise((resolve) => {
      const m = $('#modal-confirm');
      $('#confirm-title').textContent = title;
      $('#confirm-body').replaceChildren(...[].concat(body).map((b) => (b instanceof Node ? b : el('p', { text: b }))));
      const btn = $('#confirm-ok');
      btn.textContent = ok;
      btn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
      const done = (v) => {
        btn.removeEventListener('click', onOk);
        observer.disconnect();
        resolve(v);
      };
      const onOk = () => { done(true); closeModal('modal-confirm'); };
      const observer = new MutationObserver(() => { if (m.classList.contains('hidden-section')) done(false); });
      btn.addEventListener('click', onOk);
      openModal('modal-confirm');
      observer.observe(m, { attributes: true, attributeFilter: ['class'] });
      setTimeout(() => $('[data-close].btn', m)?.focus(), 40);
    });
  }

  // ─── Bin / restore / delete ───
  async function binComponent(c) {
    if (c.loaned_units > 0) {
      toast(`"${c.name}" still has ${c.loaned_units} unit(s) out on loan. Mark them returned (or bin those records) first.`, 'error');
      return;
    }
    if (!await confirmDialog({
      title: 'Move to bin?',
      body: [`"${c.name}" (${c.total_units} units) will be hidden from the stock list. You can restore it from the Bin.`],
      ok: 'Move to bin',
    })) return;
    await mutate(null, () => sb.rpc('move_to_bin', { p_kind: 'component', p_id: c.id }), { success: `Moved "${c.name}" to the bin` });
  }

  async function binIssue(i, byId) {
    const c = byId.get(i.component_id);
    if (!await confirmDialog({
      title: 'Move record to bin?',
      body: [
        `${i.borrower_name}'s record (${i.units} × ${c ? c.name : 'component'}, ${fmtDate(i.issued_on)}) will be hidden from the logs. You can restore it from the Bin.`,
        i.returned_on ? '' : 'This item is still on loan — binning the record puts its units back in stock.',
      ].filter(Boolean),
      ok: 'Move to bin',
    })) return;
    await mutate(null, () => sb.rpc('move_to_bin', { p_kind: 'issue', p_id: i.id }), { success: 'Record moved to the bin' });
  }

  async function restore(kind, id, label, button) {
    await mutate(button, () => sb.rpc('restore_from_bin', { p_kind: kind, p_id: id }), { success: `Restored ${label}` });
  }

  async function deleteComponent(c) {
    if (c.loaned_units > 0) {
      toast(`"${c.name}" still has ${c.loaned_units} unit(s) out on loan. Mark them returned first.`, 'error');
      return;
    }
    const records = state.issues.filter((i) => i.component_id === c.id).length;
    if (!await confirmDialog({
      title: 'Delete permanently?',
      body: [
        el('p', {}, 'This permanently deletes ', el('strong', { text: `"${c.name}"` }),
          records ? ` and its ${records} issue record${records === 1 ? '' : 's'}.` : '.'),
        'It cannot be undone from the site. (Nightly backups keep older copies.)',
      ],
      ok: 'Delete permanently', danger: true,
    })) return;
    await mutate(null, () => sb.rpc('delete_permanently', { p_kind: 'component', p_id: c.id }), { success: `Deleted "${c.name}"` });
  }

  async function deleteIssue(i, byId) {
    const c = byId.get(i.component_id);
    if (!await confirmDialog({
      title: 'Delete record permanently?',
      body: [
        `${i.borrower_name} (${i.roll_number}) — ${i.units} × ${c ? c.name : 'component'}, issued ${fmtDate(i.issued_on)}.`,
        i.returned_on || i.binned_at ? '' : 'This item is still on loan — deleting the record puts its units back in stock.',
        'It cannot be undone from the site. (Nightly backups keep older copies.)',
      ].filter(Boolean),
      ok: 'Delete permanently', danger: true,
    })) return;
    await mutate(null, () => sb.rpc('delete_permanently', { p_kind: 'issue', p_id: i.id }), { success: 'Record deleted' });
  }

  // ─────────────────────────── Export ───────────────────────────
  $('#export-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#export-menu');
    show(menu, menu.classList.contains('hidden-section'));
    e.currentTarget.setAttribute('aria-expanded', String(!menu.classList.contains('hidden-section')));
  });
  document.addEventListener('click', () => show($('#export-menu'), false));
  for (const b of $$('[data-export]')) b.addEventListener('click', () => exportData(b.dataset.export));

  function download(blob, filename) {
    const a = el('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = el('script', { src });
      s.onload = resolve; s.onerror = () => reject(new Error('Could not load the Excel exporter.'));
      document.head.append(s);
    });
  }

  async function exportData(kind) {
    show($('#export-menu'), false);
    const stamp = todayStr();
    const byId = componentById();
    if (kind === 'json') {
      const payload = { exported_at: new Date().toISOString(), components: state.components, issues: state.issues };
      download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `robostore-${stamp}.json`);
      return;
    }
    try {
      if (!window.XLSX) await loadScript('vendor/xlsx-0.18.5.full.min.js');
      const X = window.XLSX;
      const stock = state.components.filter((c) => !c.binned_at).map((c) => ({
        Component: c.name, 'Date added': c.date_added, Total: c.total_units, Available: c.available_units, 'On loan': c.loaned_units,
      }));
      const log = state.issues.filter((i) => !i.binned_at).map((i) => ({
        'Issued on': i.issued_on, Borrower: i.borrower_name, 'Roll number': i.roll_number,
        Component: byId.get(i.component_id)?.name || '', Units: i.units,
        Status: i.returned_on ? 'Returned' : 'On loan', 'Returned on': i.returned_on || '',
      }));
      const bin = [
        ...state.components.filter((c) => c.binned_at).map((c) => ({ Type: 'Component', Detail: c.name, Units: c.total_units, 'Moved to bin': c.binned_at })),
        ...state.issues.filter((i) => i.binned_at).map((i) => ({
          Type: 'Issue record', Detail: `${i.borrower_name} (${i.roll_number}) — ${byId.get(i.component_id)?.name || ''}, issued ${i.issued_on}`,
          Units: i.units, 'Moved to bin': i.binned_at,
        })),
      ];
      const wb = X.utils.book_new();
      const add = (rows, name, header) => {
        const ws = X.utils.json_to_sheet(rows, { header });
        ws['!cols'] = header.map((h) => ({ wch: Math.max(h.length, ...rows.map((r) => String(r[h] ?? '').length)) + 2 }));
        X.utils.book_append_sheet(wb, ws, name);
      };
      add(stock, 'Stock', ['Component', 'Date added', 'Total', 'Available', 'On loan']);
      add(log, 'Issue log', ['Issued on', 'Borrower', 'Roll number', 'Component', 'Units', 'Status', 'Returned on']);
      add(bin, 'Bin', ['Type', 'Detail', 'Units', 'Moved to bin']);
      X.writeFile(wb, `robostore-${stamp}.xlsx`);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }
})();
