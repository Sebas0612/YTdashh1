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
  let sdkPromise = null;
  let booted = false;
  let suppressStorageSync = false;
  let statusEl = null;
  let statusTimer = null;
  const pendingLocalChanges = {};
  const timers = {};

  const storageProto = Object.getPrototypeOf(localStorage);
  const nativeSetItem = storageProto && storageProto.setItem ? storageProto.setItem : localStorage.setItem;
  const nativeRemoveItem = storageProto && storageProto.removeItem ? storageProto.removeItem : localStorage.removeItem;
  const originalSetItem = function (key, value) { nativeSetItem.call(localStorage, key, value); };
  const originalRemoveItem = function (key) { nativeRemoveItem.call(localStorage, key); };

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
    });
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
    const supabaseGlobal = await loadSupabaseSdk();
    if (!supabaseGlobal) return null;
    client = supabaseGlobal.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
    return client;
  }

  async function getCurrentUser() {
    const supa = await getSupabaseClient();
    if (!supa) return null;
    const { data, error } = await supa.auth.getUser();
    if (error) return null;
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

  async function loadAppState(appKey) {
    const supa = await getSupabaseClient();
    const user = await getCurrentUser();
    if (!supa || !user) return null;
    const { data, error } = await supa
      .from('app_state')
      .select('id,data,updated_at')
      .eq('app_key', appKey)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return data.data || null;
  }

  async function saveAppState(appKey, data) {
    const supa = await getSupabaseClient();
    const user = await getCurrentUser();
    if (!supa || !user) return null;

    const now = new Date().toISOString();
    const existing = await supa
      .from('app_state')
      .select('id')
      .eq('app_key', appKey)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing.data && existing.data.id) {
      return supa
        .from('app_state')
        .update({ data, updated_at: now })
        .eq('id', existing.data.id);
    }

    return supa
      .from('app_state')
      .insert({
        user_id: user.id,
        app_key: appKey,
        data,
        updated_at: now
      });
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
      window.dispatchEvent(new Event('storage'));
    }
    return changed;
  }

  function collectAllAppStates() {
    const out = {};
    APP_KEYS.forEach(appKey => { out[appKey] = collectAppState(appKey); });
    return out;
  }

  async function pushAppToCloud(appKey) {
    try {
      const user = await getCurrentUser();
      if (!user) {
        setSyncStatus('Local only');
        debugSync('sync skipped because no user', appKey);
        return null;
      }
      setSyncStatus('Syncing...');
      debugSync('app_key sync saving to Supabase', appKey);
      const result = await saveAppState(appKey, collectAppState(appKey));
      if (result && result.error) throw result.error;
      pendingLocalChanges[appKey] = false;
      setSyncStatus('Synced');
      debugSync('app_key saved to Supabase', appKey);
      return result;
    } catch (err) {
      setSyncStatus('Local only');
      warnSync('Could not push ' + appKey + ' to Supabase. LocalStorage is still saved.', err);
      return null;
    }
  }

  async function pullAppFromCloud(appKey, options) {
    const mode = options && options.mode === 'replace' ? 'replace' : 'merge';
    const force = !!(options && options.force);
    try {
      if (!force && pendingLocalChanges[appKey]) {
        debugSync('skipped pull; local changes pending', appKey);
        return null;
      }
      const user = await getCurrentUser();
      if (!user) {
        debugSync('sync skipped because no user', appKey);
        return null;
      }
      const data = await loadAppState(appKey);
      if (!isUsefulAppState(appKey, data)) {
        debugSync('skipped pull; no useful cloud data', appKey);
        if (Object.keys(collectAppState(appKey)).length) schedulePush(appKey);
        return null;
      }
      debugSync('loaded app_state', appKey);
      return applyAppState(appKey, data, { mode });
    } catch (err) {
      warnSync('Could not pull ' + appKey + ' from Supabase. LocalStorage was left untouched.', err);
      return null;
    }
  }

  async function pushAllToCloud() {
    try {
      const user = await getCurrentUser();
      if (!user) return { ok: false, reason: 'not-signed-in' };
      for (const appKey of APP_KEYS) await saveAppState(appKey, collectAppState(appKey));
      return { ok: true };
    } catch (err) {
      warnSync('Could not upload all app state to Supabase. LocalStorage is still saved.', err);
      return { ok: false, reason: 'supabase-error', error: err };
    }
  }

  async function pullAllFromCloud(options) {
    const mode = options && options.mode === 'replace' ? 'replace' : 'merge';
    try {
      const user = await getCurrentUser();
      if (!user) return { ok: false, reason: 'not-signed-in' };
      for (const appKey of APP_KEYS) {
        const data = await loadAppState(appKey);
        if (isUsefulAppState(appKey, data)) applyAppState(appKey, data, { mode });
        else if (mode !== 'replace' && Object.keys(collectAppState(appKey)).length) schedulePush(appKey);
      }
      return { ok: true };
    } catch (err) {
      warnSync('Could not load cloud data. LocalStorage was left untouched.', err);
      return { ok: false, reason: 'supabase-error', error: err };
    }
  }

  function schedulePush(appKey) {
    if (!appKey) {
      debugSync('sync skipped; unknown localStorage key');
      return;
    }
    if (suppressStorageSync) {
      debugSync('sync skipped; applying cloud data', appKey);
      return;
    }
    if (!isConfigured()) {
      debugSync('sync skipped; Supabase not configured', appKey);
      return;
    }
    pendingLocalChanges[appKey] = true;
    debugSync('app_key sync scheduled', appKey);
    setSyncStatus('Syncing...');
    clearTimeout(timers[appKey]);
    timers[appKey] = setTimeout(() => {
      timers[appKey] = null;
      pushAppToCloud(appKey).catch(err => {
        setSyncStatus('Local only');
        warnSync('Could not sync ' + appKey + ' after a local change.', err);
      });
    }, 800);
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

  function refreshExistingServiceWorkers() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.getRegistrations().then(registrations => {
      if (!registrations.length) {
        debugSync('no service worker registrations found');
        return;
      }
      registrations.forEach(registration => {
        debugSync('service worker registration found; requesting update');
        registration.update().catch(err => {
          warnSync('Could not update an existing service worker registration.', err);
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
      refreshExistingServiceWorkers();
      const supa = await getSupabaseClient();
      if (!supa) return;
      supa.auth.onAuthStateChange((_event, session) => {
        debugSync('auth state changed', session && session.user ? 'user is logged in' : 'user is logged out');
        window.dispatchEvent(new CustomEvent('dashboard-sync-auth-changed'));
        if (session && session.user) {
          pullAllFromCloud({ mode: 'merge' }).catch(err => {
            warnSync('Could not merge cloud data after sign-in.', err);
          });
        }
      });
      const user = await getCurrentUser();
      debugSync('user is logged in', !!user);
      if (user) {
        setSyncStatus('Synced');
        const appKey = currentPageAppKey();
        if (appKey) {
          const data = await loadAppState(appKey);
          const hash = isUsefulAppState(appKey, data) ? JSON.stringify(data) : '';
          const changed = hash ? applyAppState(appKey, data, { mode: 'merge' }) : false;
          if (!hash && Object.keys(collectAppState(appKey)).length) schedulePush(appKey);
          const reloadKey = 'dashboard-sync-reloaded:' + appKey + ':' + window.location.pathname + ':' + hash;
          if (changed && hash && !sessionStorage.getItem(reloadKey)) {
            sessionStorage.setItem(reloadKey, '1');
            window.location.reload();
            return;
          }
        }
        pullAllFromCloud({ mode: 'merge' }).catch(err => {
          warnSync('Could not merge cloud data on page load.', err);
        });
      } else {
        setSyncStatus('Local only');
      }
    } catch (err) {
      setSyncStatus('Local only');
      warnSync('Background sync did not start. LocalStorage remains active.', err);
    }
  }

  function installPageFallbackTriggers() {
    const appKey = currentPageAppKey();
    if (!appKey || appKey === 'sync') return;
    ['input', 'change', 'click', 'submit'].forEach(eventName => {
      document.addEventListener(eventName, () => {
        schedulePush(appKey);
      }, true);
    });
    window.addEventListener('focus', () => {
      pullAppFromCloud(appKey, { mode: 'merge' }).catch(err => {
        warnSync('Could not refresh ' + appKey + ' on focus.', err);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        pullAppFromCloud(appKey, { mode: 'merge' }).catch(err => {
          warnSync('Could not refresh ' + appKey + ' after visibility change.', err);
        });
      }
    });
    setInterval(() => {
      if (!document.hidden) {
        pullAppFromCloud(appKey, { mode: 'merge' }).catch(err => {
          warnSync('Could not refresh ' + appKey + ' on interval.', err);
        });
      }
    }, 15000);
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
