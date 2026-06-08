// =============================================================
// Shared Supabase auth + app_state helpers.
// Paste your public Supabase project URL and anon key below.
// These are browser-safe public values. Never use a service_role key here.
// =============================================================
(function () {
  'use strict';

  const SUPABASE_URL = 'https://ehitbmberirrmivdwchr.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVoaXRibWJlcmlycm1pdmR3Y2hyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NDIxNDYsImV4cCI6MjA5NjUxODE0Nn0.tkkyTjsrO22feA7HElTAIziYutfQAKH0fdCo21FZNQo';
  const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

  let client = null;
  let sdkPromise = null;

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

  function startBackgroundAuthListener() {
    if (!isConfigured()) return;
    getSupabaseClient().then((supa) => {
      if (!supa) return;
      supa.auth.onAuthStateChange(() => {
        window.dispatchEvent(new CustomEvent('dashboard-sync-auth-changed'));
      });
    }).catch(() => {});
  }

  function bootAuthUi() {
    if (!isConfigured()) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startBackgroundAuthListener, { once: true });
    } else {
      startBackgroundAuthListener();
    }
  }

  const api = {
    isConfigured,
    getSupabaseClient,
    getCurrentUser,
    signInWithPassword,
    signInWithEmail,
    createAccount,
    signOut,
    loadAppState,
    saveAppState
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

  bootAuthUi();
})();
