// =============================================================
// Hidden Supabase auth + full-dashboard app_state sync.
// Normal pages never render login UI. Use sync.html to sign in/out.
// =============================================================
(function () {
  'use strict';

  const SUPABASE_URL = 'https://ehitbmberirrmivdwchr.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVoaXRibWJlcmlycm1pdmR3Y2hyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NDIxNDYsImV4cCI6MjA5NjUxODE0Nn0.tkkyTjsrO22feA7HElTAIziYutfQAKH0fdCo21FZNQo';
  const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

  const APP_KEYS = ['home', 'health', 'water', 'finance', 'gym'];
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
        'vinted_resell_v1'
      ],
      prefixes: []
    },
    gym: {
      exact: ['gym_tracker_v2', 'po_coach_v1', 'po_coach_workout_done', 'po_coach_weights', 'po_coach_photos'],
      prefixes: []
    }
  };

  let client = null;
  let sdkPromise = null;
  let booted = false;
  let suppressStorageSync = false;
  const timers = {};

  const originalSetItem = localStorage.setItem.bind(localStorage);
  const originalRemoveItem = localStorage.removeItem.bind(localStorage);

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

  async function getSupabaseClient() {
    if (!isConfigured()) return null;
    if (client) return client;
    const supabaseGlobal = await loadSupabaseSdk();
    if (!supabaseGlobal) return null;
    client = supabaseGlobal.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
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

  function applyAppState(appKey, data) {
    if (!data || typeof data !== 'object') return false;
    const keysToManage = allLocalKeys().filter(key => keyBelongsToApp(key, appKey));
    let changed = false;
    suppressStorageSync = true;
    try {
      keysToManage.forEach(key => {
        if (!(key in data)) {
          originalRemoveItem(key);
          changed = true;
        }
      });
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
    const user = await getCurrentUser();
    if (!user) return null;
    return saveAppState(appKey, collectAppState(appKey));
  }

  async function pullAppFromCloud(appKey) {
    const user = await getCurrentUser();
    if (!user) return null;
    const data = await loadAppState(appKey);
    if (!data) return null;
    return applyAppState(appKey, data);
  }

  async function pushAllToCloud() {
    const user = await getCurrentUser();
    if (!user) return { ok: false, reason: 'not-signed-in' };
    for (const appKey of APP_KEYS) await saveAppState(appKey, collectAppState(appKey));
    return { ok: true };
  }

  async function pullAllFromCloud() {
    const user = await getCurrentUser();
    if (!user) return { ok: false, reason: 'not-signed-in' };
    for (const appKey of APP_KEYS) {
      const data = await loadAppState(appKey);
      if (data) applyAppState(appKey, data);
    }
    return { ok: true };
  }

  function schedulePush(appKey) {
    if (!appKey || suppressStorageSync || !isConfigured()) return;
    clearTimeout(timers[appKey]);
    timers[appKey] = setTimeout(() => {
      pushAppToCloud(appKey).catch(() => {});
    }, 600);
  }

  function patchLocalStorage() {
    if (localStorage.__dashboardSyncPatched) return;
    localStorage.setItem = function (key, value) {
      originalSetItem(key, value);
      schedulePush(appForStorageKey(key));
    };
    localStorage.removeItem = function (key) {
      originalRemoveItem(key);
      schedulePush(appForStorageKey(key));
    };
    try {
      Object.defineProperty(localStorage, '__dashboardSyncPatched', { value: true });
    } catch (_) {}
  }

  function currentPageAppKey() {
    const path = (window.location.pathname || '').split('/').pop() || 'index.html';
    if (path === 'index.html' || path === '') return 'home';
    if (path === 'health.html') return 'health';
    if (path === 'po-water.html') return 'water';
    if (path === 'finance.html') return 'finance';
    if (path === 'gym.html') return 'gym';
    return null;
  }

  async function bootBackgroundSync() {
    if (booted || !isConfigured()) return;
    booted = true;
    patchLocalStorage();
    try {
      const supa = await getSupabaseClient();
      if (!supa) return;
      supa.auth.onAuthStateChange((_event, session) => {
        window.dispatchEvent(new CustomEvent('dashboard-sync-auth-changed'));
        if (session && session.user) {
          pullAllFromCloud().catch(() => {});
        }
      });
      const user = await getCurrentUser();
      if (user) {
        const appKey = currentPageAppKey();
        if (appKey) {
          const data = await loadAppState(appKey);
          const hash = data ? JSON.stringify(data) : '';
          const changed = data ? applyAppState(appKey, data) : false;
          const reloadKey = 'dashboard-sync-reloaded:' + appKey + ':' + window.location.pathname + ':' + hash;
          if (changed && hash && !sessionStorage.getItem(reloadKey)) {
            sessionStorage.setItem(reloadKey, '1');
            window.location.reload();
            return;
          }
        }
        pullAllFromCloud().catch(() => {});
      }
    } catch (_) {}
  }

  const api = {
    APP_KEYS,
    APP_STORAGE,
    isConfigured,
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootBackgroundSync, { once: true });
  } else {
    bootBackgroundSync();
  }
})();
