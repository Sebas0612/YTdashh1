// =============================================================
// Hidden Supabase auth + full-dashboard app_state sync.
// Normal pages never render login UI. Use sync.html to sign in/out.
// =============================================================
(function () {
  'use strict';

  const SUPABASE_URL = 'https://ehitbmberirrmivdwchr.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVoaXRibWJlcmlycm1pdmR3Y2hyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NDIxNDYsImV4cCI6MjA5NjUxODE0Nn0.tkkyTjsrO22feA7HElTAIziYutfQAKH0fdCo21FZNQo';
  const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

  const APP_KEYS = ['home', 'health', 'water', 'finance', 'gym', 'editing'];
  const APP_STORAGE = {
    home: {
      exact: ['goal_streak_v1'],
      prefixes: ['goals:']
    },
    health: {
      exact: ['stack:items', 'stack:version', 'stack:low'],
      prefixes: ['stack:taken:']
    },
    water: {
      exact: ['po_water_v1'],
      prefixes: []
    },
    finance: {
      exact: [
        'finance_active_tab',
        'nw_currency',
        'nw:bank',
        'nw:stocks',
        'nw:crypto',
        'nw:other',
        'nw:activity',
        'nw:history',
        'subs',
        'wishlist',
        'incoming_orders',
        'vinted_resell_v1',
        'bux_portfolio_v1'
      ],
      prefixes: []
    },
    gym: {
      exact: ['gym_tracker_v2', 'po_coach_v1', 'po_coach_workout_done', 'po_coach_weights', 'po_coach_photos'],
      prefixes: []
    },
    editing: {
      exact: ['editing_income_v1'],
      prefixes: []
    }
  };

  let client = null;
  let clientPromise = null;
  let sdkPromise = null;
  let booted = false;
  let suppressStorageSync = false;
  let statusEl = null;
  let statusTimer = null;
  const META_KEY = 'dashboard-sync-meta-v2';
  let meta;
  try { meta = JSON.parse(localStorage.getItem(META_KEY)) || {}; } catch (_) { meta = {}; }
  meta.apps = meta.apps || {};
  const revisions = {};
  const running = {};
  const timers = {};
  const retryTimers = {};

  const storageProto = Object.getPrototypeOf(localStorage);
  const nativeSetItem = storageProto && storageProto.setItem ? storageProto.setItem : localStorage.setItem;
  const nativeRemoveItem = storageProto && storageProto.removeItem ? storageProto.removeItem : localStorage.removeItem;
  const originalSetItem = function (key, value) { nativeSetItem.call(localStorage, key, value); };
  const originalRemoveItem = function (key) { nativeRemoveItem.call(localStorage, key); };
  function saveMeta() {
    try { originalSetItem(META_KEY, JSON.stringify(meta)); }
    catch (err) { warnSync('Could not persist sync queue.', err); }
  }
  function appMeta(appKey) {
    return meta.apps[appKey] || (meta.apps[appKey] = { base: null, version: null, pending: false, conflict: null });
  }

  function isConfigured() {
    return !!SUPABASE_URL &&
      !!SUPABASE_ANON_KEY &&
      SUPABASE_URL.indexOf('PASTE-') !== 0 &&
      SUPABASE_ANON_KEY.indexOf('PASTE-') !== 0;
  }

  function loadSupabaseSdk() {
    if (window.supabase) return Promise.resolve(window.supabase);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-dashboard-supabase-sdk]');
      if (existing) {
        existing.addEventListener('load', () => resolve(window.supabase), { once: true });
        existing.addEventListener('error', reject, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = SUPABASE_CDN;
      script.async = true;
      script.dataset.dashboardSupabaseSdk = 'true';
      script.onload = () => resolve(window.supabase);
      script.onerror = reject;
      document.head.appendChild(script);
    }).catch(err => { sdkPromise = null; throw err; });
    return sdkPromise;
  }

  function isStandalonePwa() {
    return !!(
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      (window.navigator && window.navigator.standalone === true)
    );
  }

  async function getSupabaseClient() {
    if (!isConfigured()) return null;
    if (client) return client;
    if (!clientPromise) clientPromise = loadSupabaseSdk().then(supabaseGlobal => {
      if (!supabaseGlobal) return null;
      client = supabaseGlobal.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      return client;
    }).catch(err => { clientPromise = null; throw err; });
    return clientPromise;
  }

  async function getCurrentUser() {
    const supa = await getSupabaseClient();
    if (!supa) return null;
    const { data, error } = await supa.auth.getUser();
    if (error) {
      if (!navigator.onLine || error.name === 'AuthRetryableFetchError' || error.status === 0) {
        const cached = await supa.auth.getSession();
        return cached.data && cached.data.session ? cached.data.session.user : null;
      }
      return null;
    }
    return data && data.user ? data.user : null;
  }

  async function signInWithPassword(email, password) {
    const supa = await getSupabaseClient();
    if (!supa) throw new Error('Supabase is not configured.');
    return supa.auth.signInWithPassword({ email, password });
  }

  async function signInWithEmail(email, password) {
    return signInWithPassword(email, password);
  }

  async function sendPasswordRecovery(email) {
    const supa = await getSupabaseClient();
    if (!supa) throw new Error('Supabase is not configured.');
    return supa.auth.resetPasswordForEmail(email, {
      redirectTo: new URL('sync.html', window.location.href).href
    });
  }

  async function updatePassword(password) {
    const supa = await getSupabaseClient();
    if (!supa) throw new Error('Supabase is not configured.');
    return supa.auth.updateUser({ password });
  }

  async function createAccount(email, password) {
    const supa = await getSupabaseClient();
    if (!supa) throw new Error('Supabase is not configured.');
    return supa.auth.signUp({ email, password });
  }

  async function signOut() {
    const supa = await getSupabaseClient();
    if (!supa) return;
    return supa.auth.signOut();
  }

  async function loadAppRow(appKey) {
    const supa = await getSupabaseClient();
    const user = await getCurrentUser();
    if (!supa || !user) throw new Error('Not signed in.');
    const { data, error } = await supa
      .from('app_state')
      .select('id,data,updated_at')
      .eq('user_id', user.id)
      .eq('app_key', appKey)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function loadAppState(appKey) {
    const row = await loadAppRow(appKey);
    return row ? row.data || null : null;
  }

  async function saveAppRow(appKey, data, previous) {
    const supa = await getSupabaseClient();
    const user = await getCurrentUser();
    if (!supa || !user) throw new Error('Not signed in.');

    const previousTime = previous && previous.updated_at ? Date.parse(previous.updated_at) : 0;
    const now = new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
    if (previous && previous.id) {
      const result = await supa
        .from('app_state')
        .update({ data, updated_at: now })
        .eq('id', previous.id)
        .eq('updated_at', previous.updated_at)
        .select('id,updated_at')
        .maybeSingle();
      if (result.error) throw result.error;
      if (!result.data) return null; // Another device wrote first; re-read and merge.
      return result.data;
    }

    const result = await supa
      .from('app_state')
      .insert({
        user_id: user.id,
        app_key: appKey,
        data,
        updated_at: now
      })
      .select('id,updated_at')
      .maybeSingle();
    if (result.error) throw result.error;
    return result.data;
  }

  async function saveAppState(appKey, data) {
    if (!isUsefulAppState(appKey, data)) throw new Error('Refusing to upload an empty dashboard state.');
    const previous = await loadAppRow(appKey);
    const saved = await saveAppRow(appKey, data, previous);
    if (!saved) throw new Error('Cloud changed during upload; retry the sync.');
    return { data: saved, error: null };
  }

  function parseStoredValue(key) {
    const raw = localStorage.getItem(key);
    if (raw == null) return undefined;
    try { return JSON.parse(raw); }
    catch (_) { return raw; }
  }

  function allLocalKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    return keys;
  }

  function keyBelongsToApp(key, appKey) {
    const cfg = APP_STORAGE[appKey];
    if (!cfg || !key) return false;
    if (cfg.exact.indexOf(key) !== -1) return true;
    return cfg.prefixes.some(prefix => key.indexOf(prefix) === 0);
  }

  function appForStorageKey(key) {
    return APP_KEYS.find(appKey => keyBelongsToApp(key, appKey)) || null;
  }

  function collectAppState(appKey) {
    const out = {};
    allLocalKeys().forEach(key => {
      if (keyBelongsToApp(key, appKey)) out[key] = parseStoredValue(key);
    });
    return out;
  }

  function warnSync(message, error) {
    if (error) console.warn('[dashboard-sync] ' + message, error);
    else console.warn('[dashboard-sync] ' + message);
  }

  function debugSync() {
    if (!window.DASHBOARD_SYNC_DEBUG) return;
    const args = Array.prototype.slice.call(arguments);
    args.unshift('[dashboard-sync]');
    console.log.apply(console, args);
  }

  function shouldShowStatus() {
    const path = (window.location.pathname || '').split('/').pop() || 'index.html';
    return path !== 'sync.html';
  }

  function ensureStatusIndicator() {
    if (!shouldShowStatus() || statusEl || !document.body) return statusEl;
    const el = document.createElement('div');
    el.id = 'dashboardSyncStatus';
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = [
      'position:fixed',
      'right:10px',
      'bottom:max(10px, env(safe-area-inset-bottom))',
      'z-index:30',
      'padding:5px 8px',
      'border:1px solid rgba(255,255,255,0.08)',
      'border-radius:999px',
      'background:rgba(10,10,11,0.72)',
      'color:rgba(255,255,255,0.46)',
      'font:700 10px/1 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,sans-serif',
      'letter-spacing:0.08em',
      'text-transform:uppercase',
      'pointer-events:none',
      'backdrop-filter:blur(10px)'
    ].join(';');
    document.body.appendChild(el);
    statusEl = el;
    return statusEl;
  }

  function setSyncStatus(text) {
    const el = ensureStatusIndicator();
    if (!el) return;
    el.textContent = text;
    clearTimeout(statusTimer);
    if (text === 'Synced') {
      statusTimer = setTimeout(() => {
        if (statusEl && statusEl.textContent === 'Synced') statusEl.textContent = '';
      }, 2500);
    }
  }

  function isUsefulAppState(appKey, data) {
    if (!data || typeof data !== 'object') return false;
    return Object.keys(data).some(key => keyBelongsToApp(key, appKey) && data[key] != null);
  }

  function applyAppState(appKey, data, options) {
    const mode = options && options.mode === 'replace' ? 'replace' : 'merge';
    if (!data || typeof data !== 'object') return false;
    if (mode !== 'replace' && !isUsefulAppState(appKey, data)) return false;
    const keysToManage = allLocalKeys().filter(key => keyBelongsToApp(key, appKey));
    let changed = false;
    suppressStorageSync = true;
    try {
      if (mode === 'replace') {
        keysToManage.forEach(key => {
          if (!(key in data)) {
            originalRemoveItem(key);
            changed = true;
          }
        });
      }
      Object.keys(data).forEach(key => {
        if (!keyBelongsToApp(key, appKey)) return;
        const incoming = JSON.stringify(data[key]);
        if (localStorage.getItem(key) !== incoming) {
          originalSetItem(key, incoming);
          changed = true;
        }
      });
    } finally {
      suppressStorageSync = false;
    }
    if (changed) {
      window.dispatchEvent(new CustomEvent('dashboard-sync-local-applied', { detail: { appKey } }));
    }
    return changed;
  }

  function collectAllAppStates() {
    const out = {};
    APP_KEYS.forEach(appKey => { out[appKey] = collectAppState(appKey); });
    return out;
  }

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

  function fingerprint(value) {
    if (value === undefined) return 'missing';
    const raw = JSON.stringify(value);
    let a = 2166136261, b = 5381;
    for (let i = 0; i < raw.length; i++) {
      a = Math.imul(a ^ raw.charCodeAt(i), 16777619);
      b = Math.imul(b, 33) ^ raw.charCodeAt(i);
    }
    return raw.length + ':' + (a >>> 0).toString(16) + ':' + (b >>> 0).toString(16);
  }

  function recordBaseline(info, data) {
    info.fingerprints = {};
    info.base = {};
    Object.keys(data).forEach(key => {
      info.fingerprints[key] = fingerprint(data[key]);
      if (key.indexOf('goals:') === 0 || key === 'gym_tracker_v2') info.base[key] = data[key];
    });
  }

  function mergeRecords(local, cloud, base, field) {
    const byId = list => {
      const counts = {};
      return new Map((Array.isArray(list) ? list : []).map((item, index) => {
        const text = String(item.text || '').trim().toLowerCase();
        counts[text] = (counts[text] || 0) + 1;
        return [String(field === 'goals' && !base ? text + ':' + counts[text] : (item.id || (field === 'goals' ? text + ':' + counts[text] : index))), item];
      }));
    };
    const l = byId(local), c = byId(cloud), b = byId(base);
    const ids = new Set([...l.keys(), ...c.keys(), ...b.keys()]);
    const merged = [];
    let conflict = false;
    ids.forEach(id => {
      const lv = l.get(id), cv = c.get(id), bv = b.get(id);
      let chosen;
      if (same(lv, cv)) chosen = lv;
      else if (field === 'goals' && !base && lv && cv &&
        lv.text === cv.text && !!lv.done === !!cv.done && !!lv.queued === !!cv.queued) chosen = lv;
      else if (same(lv, bv)) chosen = cv;
      else if (same(cv, bv)) chosen = lv;
      else if (!b.has(id) && !l.has(id)) chosen = cv;
      else if (!b.has(id) && !c.has(id)) chosen = lv;
      else { conflict = true; chosen = lv; }
      if (chosen !== undefined) merged.push(chosen);
    });
    return { data: merged, conflict };
  }

  function mergeSpecial(key, local, cloud, base) {
    if (key.indexOf('goals:') === 0 && Array.isArray(local) && Array.isArray(cloud))
      return mergeRecords(local, cloud, base, 'goals');
    if (key === 'gym_tracker_v2' && local && cloud && typeof local === 'object' && typeof cloud === 'object') {
      const workouts = mergeRecords(local.workouts, cloud.workouts, base && base.workouts, 'workouts');
      const exercises = mergeRecords(local.exercises, cloud.exercises, base && base.exercises, 'exercises');
      return { data: { ...cloud, ...local, workouts: workouts.data, exercises: exercises.data }, conflict: workouts.conflict || exercises.conflict };
    }
    return null;
  }

  function isDefaultValue(key, value) {
    if (value == null || value === '') return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value !== 'object') return false;
    if (!Object.keys(value).length) return true;
    if (key === 'goal_streak_v1') return !value.count && !value.lastProcessedDate;
    if (key === 'po_water_v1') return !Object.keys(value.logs || {}).length && !(value.substances || []).length;
    return false;
  }

  function mergeApp(appKey, local, cloud, info) {
    const merged = {};
    const conflicts = [];
    const known = info.fingerprints;
    const base = info.base || {};
    new Set([...Object.keys(local || {}), ...Object.keys(cloud || {}), ...Object.keys(known || {})]).forEach(key => {
      if (!keyBelongsToApp(key, appKey)) return;
      const lv = local && local[key], cv = cloud && cloud[key], bv = base && base[key];
      let choice;
      if (same(lv, cv)) choice = lv;
      else if (known && fingerprint(lv) === (known[key] || 'missing')) choice = cv;
      else if (known && fingerprint(cv) === (known[key] || 'missing')) choice = lv;
      else if (!known && isDefaultValue(key, lv)) choice = cv;
      else if (!known && isDefaultValue(key, cv)) choice = lv;
      else if (!known && !has(local, key)) choice = cv;
      else if (!known && !has(cloud, key)) choice = lv;
      else {
        const special = mergeSpecial(key, lv, cv, bv);
        if (special) {
          choice = special.data;
          if (special.conflict) conflicts.push(key);
        } else {
          choice = lv;
          conflicts.push(key);
        }
      }
      if (key === 'gym_tracker_v2' && choice && lv && typeof choice === 'object' && typeof lv === 'object') {
        // The workout editor's open screen and selected date belong to this device.
        choice = { ...choice, uiMode: lv.uiMode, activeWorkoutId: lv.activeWorkoutId,
          detailWorkoutId: lv.detailWorkoutId, selectedDate: lv.selectedDate };
      }
      if (choice !== undefined) merged[key] = choice;
    });
    return { data: merged, conflicts };
  }

  function editingCurrentApp(appKey) {
    if (currentPageAppKey() !== appKey) return false;
    if (document.querySelector('.modal-bg.show, .po-modal-bg.show, .wt-overlay.show, .wt-viewer.show, .picker.show')) return true;
    const active = document.activeElement;
    if (active && active !== document.body && active.matches && active.getClientRects().length && active.matches('input, textarea, select, [contenteditable="true"]')) return true;
    if (appKey === 'gym') {
      const editor = document.getElementById('workoutScreen');
      const picker = document.getElementById('exercisePicker');
      const detail = document.getElementById('detailScreen');
      if ((editor && !editor.hidden) || (detail && !detail.hidden) || (picker && picker.classList.contains('show'))) return true;
    }
    return false;
  }

  function refreshSyncStatus() {
    const apps = APP_KEYS.map(appMeta);
    if (apps.some(a => a.conflict)) setSyncStatus('Sync conflict');
    else if (!navigator.onLine) setSyncStatus(apps.some(a => a.pending || a.failed) ? 'Offline · pending' : 'Offline');
    else if (apps.some(a => a.failed)) setSyncStatus('Sync failed');
    else if (apps.some(a => a.pending)) setSyncStatus('Pending sync');
    else setSyncStatus('Synced');
  }

  function getConflicts() {
    return APP_KEYS.filter(key => appMeta(key).conflict).map(key => ({ appKey: key, keys: appMeta(key).conflict }));
  }

  async function getConflictCopies(appKey) {
    if (!appMeta(appKey).conflict) throw new Error('There is no conflict for this app.');
    const row = await loadAppRow(appKey);
    return { local: collectAppState(appKey), cloud: row ? row.data : {} };
  }

  async function resolveConflict(appKey, choice) {
    const info = appMeta(appKey);
    if (!info.conflict || (choice !== 'local' && choice !== 'cloud')) throw new Error('Choose a listed conflict and which copy to keep.');
    const row = await loadAppRow(appKey);
    const cloud = row && isUsefulAppState(appKey, row.data) ? row.data : {};
    if (fingerprint(cloud) !== info.conflictCloudFingerprint) throw new Error('Cloud data changed again. Refresh the conflict before choosing.');
    const local = collectAppState(appKey);
    if (choice === 'cloud') {
      applyAppState(appKey, cloud, { mode: 'replace' });
      recordBaseline(info, cloud);
      info.version = row && row.updated_at;
    } else {
      if (!isUsefulAppState(appKey, local)) throw new Error('Refusing to replace cloud data with an empty local state.');
      const saved = await saveAppRow(appKey, local, row);
      if (!saved) throw new Error('Cloud data changed again. Refresh the conflict before choosing.');
      recordBaseline(info, local);
      info.version = saved.updated_at;
    }
    info.conflict = null;
    delete info.conflictCloudFingerprint;
    info.pending = false;
    info.failed = false;
    saveMeta();
    refreshSyncStatus();
    return { ok: true };
  }

  async function syncOnce(appKey) {
    const user = await getCurrentUser();
    if (!user) { setSyncStatus(navigator.onLine ? 'Local only' : 'Offline · pending'); return { ok: false, reason: 'not-signed-in' }; }
    const info = appMeta(appKey);
    if (meta.userId && meta.userId !== user.id) {
      info.conflict = ['account'];
      saveMeta(); refreshSyncStatus();
      return { ok: false, reason: 'account-conflict' };
    }
    meta.userId = user.id;
    setSyncStatus('Syncing...');
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision = revisions[appKey] || 0;
      const row = await loadAppRow(appKey);
      if (revision !== (revisions[appKey] || 0)) continue;
      const local = collectAppState(appKey);
      const cloud = row && isUsefulAppState(appKey, row.data) ? row.data : {};
      const merged = mergeApp(appKey, local, cloud, info);
      if (merged.conflicts.length) {
        info.conflict = merged.conflicts;
        info.conflictCloudFingerprint = fingerprint(cloud);
        info.failed = false;
        info.pending = true;
        saveMeta(); refreshSyncStatus();
        return { ok: false, reason: 'conflict', keys: merged.conflicts };
      }
      info.conflict = null;
      delete info.conflictCloudFingerprint;
      const changedLocal = !same(local, merged.data);
      const changedCloud = !same(cloud, merged.data);
      if (changedCloud && !isUsefulAppState(appKey, merged.data) && isUsefulAppState(appKey, cloud)) {
        info.conflict = ['empty-local-state'];
        info.conflictCloudFingerprint = fingerprint(cloud);
        info.pending = true;
        saveMeta(); refreshSyncStatus();
        return { ok: false, reason: 'conflict', keys: info.conflict };
      }
      if (changedLocal && editingCurrentApp(appKey)) {
        info.pending = true;
        saveMeta(); refreshSyncStatus();
        return { ok: false, reason: 'editing' };
      }
      if (changedCloud && isUsefulAppState(appKey, merged.data)) {
        const saved = await saveAppRow(appKey, merged.data, row);
        if (!saved) continue;
        if (revision !== (revisions[appKey] || 0)) {
          recordBaseline(info, merged.data);
          info.version = saved.updated_at;
          info.pending = true;
          saveMeta(); refreshSyncStatus();
          return { ok: false, reason: 'new-local-change' };
        }
        info.version = saved.updated_at;
      } else info.version = row && row.updated_at;
      if (changedLocal) applyAppState(appKey, merged.data, { mode: 'replace' });
      recordBaseline(info, merged.data);
      info.pending = false;
      info.failed = false;
      saveMeta(); refreshSyncStatus();
      return { ok: true, changed: changedLocal || changedCloud };
    }
    throw new Error('Cloud changed repeatedly during synchronization.');
  }

  function runSync(appKey) {
    if (!APP_STORAGE[appKey]) return Promise.resolve({ ok: false, reason: 'unknown-app' });
    if (running[appKey]) return running[appKey];
    const startRevision = revisions[appKey] || 0;
    running[appKey] = syncOnce(appKey).catch(err => {
      const info = appMeta(appKey);
      info.pending = true;
      info.failed = true;
      saveMeta(); refreshSyncStatus();
      warnSync('Could not sync ' + appKey + '. Local data remains saved.', err);
      return { ok: false, reason: 'supabase-error', error: err };
    }).finally(() => {
      running[appKey] = null;
      if ((revisions[appKey] || 0) !== startRevision && appMeta(appKey).pending) {
        clearTimeout(timers[appKey]);
        timers[appKey] = setTimeout(() => runSync(appKey), 800);
      }
    });
    return running[appKey];
  }

  async function pushAppToCloud(appKey) { return runSync(appKey); }
  async function pullAppFromCloud(appKey) { return runSync(appKey); }

  async function pushAllToCloud() { return pullAllFromCloud(); }
  async function pullAllFromCloud() {
    const user = await getCurrentUser();
    if (!user) return { ok: false, reason: 'not-signed-in' };
    const results = [];
    for (const appKey of APP_KEYS) results.push(await runSync(appKey));
    return results.every(r => r.ok) ? { ok: true } : { ok: false, results };
  }

  function schedulePush(appKey) {
    if (!appKey || suppressStorageSync || !isConfigured()) return;
    revisions[appKey] = (revisions[appKey] || 0) + 1;
    const info = appMeta(appKey);
    info.pending = true;
    info.failed = false;
    saveMeta();
    setSyncStatus('Saving locally');
    clearTimeout(timers[appKey]);
    timers[appKey] = setTimeout(() => runSync(appKey), 800);
  }

  function scheduleAutoSync(appKey) {
    schedulePush(appKey);
  }

  function patchLocalStorage() {
    if (window.__dashboardSyncPatched) return;
    const patchedSetItem = function (key, value) {
      nativeSetItem.call(this, key, value);
      if (this === localStorage) {
        const appKey = appForStorageKey(String(key));
        debugSync('localStorage key changed', String(key), appKey || 'unmapped');
        schedulePush(appKey);
      }
    };
    const patchedRemoveItem = function (key) {
      nativeRemoveItem.call(this, key);
      if (this === localStorage) {
        const appKey = appForStorageKey(String(key));
        debugSync('localStorage key changed', String(key), appKey || 'unmapped');
        schedulePush(appKey);
      }
    };
    try {
      if (!storageProto) throw new Error('Storage prototype is not available.');
      Object.defineProperty(storageProto, 'setItem', {
        value: patchedSetItem,
        configurable: true,
        writable: true
      });
      Object.defineProperty(storageProto, 'removeItem', {
        value: patchedRemoveItem,
        configurable: true,
        writable: true
      });
    } catch (_) {
      try {
        localStorage.setItem = patchedSetItem.bind(localStorage);
        localStorage.removeItem = patchedRemoveItem.bind(localStorage);
      } catch (err) {
        warnSync('Could not patch localStorage for automatic sync.', err);
      }
    }
    window.__dashboardSyncPatched = true;
    debugSync('localStorage auto-sync hook installed');
  }

  function currentPageAppKey() {
    const path = (window.location.pathname || '').split('/').pop() || 'index.html';
    if (path === 'index.html' || path === '') return 'home';
    if (path === 'health.html') return 'health';
    if (path === 'po-water.html') return 'water';
    if (path === 'finance.html') return 'finance';
    if (path === 'gym.html') return 'gym';
    if (path === 'editing.html') return 'editing';
    return null;
  }

  function removeLegacyServiceWorkers() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.getRegistrations().then(registrations => {
      if (!registrations.length) {
        debugSync('no service worker registrations found');
        return;
      }
      registrations.forEach(registration => {
        debugSync('removing legacy service worker; this static app does not register one');
        registration.unregister().catch(err => {
          warnSync('Could not remove an existing service worker registration.', err);
        });
      });
    }).catch(err => {
      warnSync('Could not inspect service worker registrations.', err);
    });
  }

  async function bootBackgroundSync() {
    if (booted) return;
    booted = true;
    if (!isConfigured()) {
      setSyncStatus('Local only');
      return;
    }
    try {
      debugSync('PWA standalone mode detected', isStandalonePwa() ? 'yes' : 'no');
      removeLegacyServiceWorkers();
      const supa = await getSupabaseClient();
      if (!supa) return;
      supa.auth.onAuthStateChange((event, session) => {
        debugSync('auth state changed', session && session.user ? 'user is logged in' : 'user is logged out');
        window.dispatchEvent(new CustomEvent('dashboard-sync-auth-changed'));
        if (session && session.user && event === 'SIGNED_IN') setTimeout(() => pullAllFromCloud(), 0);
      });
      const user = await getCurrentUser();
      debugSync('user is logged in', !!user);
      if (user) {
        refreshSyncStatus();
        pullAllFromCloud();
      } else {
        setSyncStatus('Local only');
        if (isStandalonePwa() && navigator.onLine && currentPageAppKey()) {
          window.location.replace('sync.html?return=' + encodeURIComponent(window.location.pathname.split('/').pop() || 'index.html'));
        }
      }
    } catch (err) {
      setSyncStatus('Local only');
      warnSync('Background sync did not start. LocalStorage remains active.', err);
    }
  }

  function installPageFallbackTriggers() {
    const appKey = currentPageAppKey();
    if (!appKey) return;
    const refresh = () => { if (navigator.onLine && !document.hidden) pullAllFromCloud(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', () => { refreshSyncStatus(); refresh(); });
    window.addEventListener('offline', refreshSyncStatus);
    window.addEventListener('storage', event => {
      const changedApp = event.key && appForStorageKey(event.key);
      if (changedApp) runSync(changedApp);
    });
    document.addEventListener('visibilitychange', refresh);
    document.addEventListener('focusout', () => setTimeout(() => {
      if (appMeta(appKey).pending) runSync(appKey);
    }, 0));
    setInterval(refresh, 60000);
  }

  const api = {
    APP_KEYS,
    APP_STORAGE,
    isConfigured,
    isStandalonePwa,
    getSupabaseClient,
    getCurrentUser,
    signInWithPassword,
    signInWithEmail,
    sendPasswordRecovery,
    updatePassword,
    createAccount,
    signOut,
    loadAppState,
    saveAppState,
    collectAppState,
    collectAllAppStates,
    applyAppState,
    scheduleAutoSync,
    pushAppToCloud,
    pullAppFromCloud,
    pushAllToCloud,
    pullAllFromCloud,
    getConflicts,
    getConflictCopies,
    resolveConflict,
    bootBackgroundSync
  };

  window.DashboardSync = api;
  window.getSupabaseClient = getSupabaseClient;
  window.getCurrentUser = getCurrentUser;
  window.signInWithPassword = signInWithPassword;
  window.signInWithEmail = signInWithEmail;
  window.createAccount = createAccount;
  window.signOut = signOut;
  window.loadAppState = loadAppState;
  window.saveAppState = saveAppState;
  window.scheduleAutoSync = scheduleAutoSync;

  patchLocalStorage();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      installPageFallbackTriggers();
      bootBackgroundSync();
    }, { once: true });
  } else {
    installPageFallbackTriggers();
    bootBackgroundSync();
  }
})();
