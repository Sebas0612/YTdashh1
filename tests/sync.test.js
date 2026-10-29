const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'supabase-sync.js'), 'utf8');

function dashboard(page = 'index.html') {
  class Storage {
    constructor() { this.values = new Map(); }
    get length() { return this.values.size; }
    key(i) { return [...this.values.keys()][i] || null; }
    getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
    setItem(key, value) { this.values.set(String(key), String(value)); }
    removeItem(key) { this.values.delete(String(key)); }
  }
  const localStorage = new Storage();
  const rows = new Map();
  let failRead = false;
  let readGate = null;
  let beforeUpdate = null;
  let counter = 0;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1', email: 'test@example.com' } }, error: null }),
      getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
    },
    from(table) {
      assert.equal(table, 'app_state');
      const query = { action: 'read', conditions: {} };
      const chain = {
        select() { return chain; },
        eq(key, value) { query.conditions[key] = value; return chain; },
        order() { return chain; },
        limit() { return chain; },
        update(data) { query.action = 'update'; query.data = data; return chain; },
        insert(data) { query.action = 'insert'; query.data = data; return chain; },
        async maybeSingle() {
          if (query.action === 'read') {
            if (readGate) await readGate;
            if (failRead) { failRead = false; return { data: null, error: new Error('offline') }; }
            return { data: clone(rows.get(query.conditions.app_key) || null), error: null };
          }
          if (query.action === 'insert') {
            const row = { id: String(++counter), ...clone(query.data) };
            rows.set(row.app_key, row);
            return { data: clone(row), error: null };
          }
          if (beforeUpdate) { const action = beforeUpdate; beforeUpdate = null; action(rows); }
          const row = [...rows.values()].find(r => r.id === query.conditions.id);
          if (!row || row.updated_at !== query.conditions.updated_at) return { data: null, error: null };
          Object.assign(row, clone(query.data));
          return { data: clone(row), error: null };
        }
      };
      return chain;
    }
  };
  const elements = {
    workoutScreen: { hidden: true },
    exercisePicker: { classList: { contains: () => false } }
  };
  const document = {
    readyState: 'loading', body: null, activeElement: null,
    addEventListener() {}, querySelector: () => null,
    getElementById: id => elements[id] || null
  };
  const window = {
    supabase: { createClient: () => client },
    location: { pathname: '/' + page },
    dispatchEvent() {},
    matchMedia: () => ({ matches: false }),
    navigator: { standalone: false }
  };
  const context = { window, document, localStorage, navigator: { onLine: true, standalone: false },
    console: { log() {}, warn() {} }, setTimeout, clearTimeout, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    Event: class { constructor(type) { this.type = type; } }, URL };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { api: window.DashboardSync, localStorage, rows, elements,
    setFailRead() { failRead = true; }, setReadGate(gate) { readGate = gate; },
    beforeUpdate(action) { beforeUpdate = action; },
    seed(appKey, data) { rows.set(appKey, { id: String(++counter), user_id: 'user-1', app_key: appKey, data: clone(data), updated_at: '2026-01-01T00:00:00.000Z' }); }
  };
}

const goals = (...items) => ({ 'goals:2026-10-29': items });
const goal = (id, text) => ({ id, text, done: false });

test('merges distinct goals and confirms the combined snapshot', async () => {
  const d = dashboard();
  d.seed('home', goals(goal('cloud', 'Cloud task')));
  d.localStorage.setItem('goals:2026-10-29', JSON.stringify([goal('local', 'Local task')]));
  const result = await d.api.pushAppToCloud('home');
  assert.equal(result.ok, true);
  assert.deepEqual(d.rows.get('home').data['goals:2026-10-29'].map(x => x.text), ['Local task', 'Cloud task']);
  assert.deepEqual(JSON.parse(d.localStorage.getItem('goals:2026-10-29')).map(x => x.text), ['Local task', 'Cloud task']);
});

test('same legacy goal is not duplicated by an initial merge', async () => {
  const d = dashboard();
  d.seed('home', goals({ text: 'Same task', done: false }));
  d.localStorage.setItem('goals:2026-10-29', JSON.stringify([goal('new-id', 'Same task')]));
  assert.equal((await d.api.pushAppToCloud('home')).ok, true);
  assert.equal(d.rows.get('home').data['goals:2026-10-29'].length, 1);
});

test('a local edit during a cloud read is included before upload', async () => {
  const d = dashboard();
  d.seed('home', goals(goal('a', 'A')));
  let release;
  d.setReadGate(new Promise(resolve => { release = resolve; }));
  d.localStorage.setItem('goals:2026-10-29', JSON.stringify([goal('a', 'A'), goal('b', 'B')]));
  const pending = d.api.pushAppToCloud('home');
  await new Promise(resolve => setTimeout(resolve, 0));
  d.localStorage.setItem('goals:2026-10-29', JSON.stringify([goal('a', 'A'), goal('b', 'B'), goal('c', 'C')]));
  release();
  assert.equal((await pending).ok, true);
  assert.equal(d.rows.get('home').data['goals:2026-10-29'].length, 3);
});

test('failed cloud read keeps pending local data for a later retry', async () => {
  const d = dashboard();
  d.localStorage.setItem('goals:2026-10-29', JSON.stringify([goal('a', 'A')]));
  d.setFailRead();
  assert.equal((await d.api.pushAppToCloud('home')).ok, false);
  assert.equal(JSON.parse(d.localStorage.getItem('goals:2026-10-29')).length, 1);
  assert.equal((await d.api.pushAppToCloud('home')).ok, true);
  assert.equal(d.rows.get('home').data['goals:2026-10-29'].length, 1);
});

test('active workout editor defers cloud hydration', async () => {
  const d = dashboard('gym.html');
  const state = workouts => ({ version: 2, workouts, exercises: [], uiMode: 'workout-editor' });
  d.seed('gym', { gym_tracker_v2: state([{ id: 'remote', status: 'draft' }]) });
  d.localStorage.setItem('gym_tracker_v2', JSON.stringify(state([{ id: 'local', status: 'draft' }])));
  d.elements.workoutScreen.hidden = false;
  assert.equal((await d.api.pullAppFromCloud('gym')).reason, 'editing');
  assert.equal(JSON.parse(d.localStorage.getItem('gym_tracker_v2')).workouts.length, 1);
  d.elements.workoutScreen.hidden = true;
  assert.equal((await d.api.pullAppFromCloud('gym')).ok, true);
  assert.equal(JSON.parse(d.localStorage.getItem('gym_tracker_v2')).workouts.length, 2);
});

test('an empty new device imports populated cloud data without uploading emptiness', async () => {
  const d = dashboard();
  d.seed('home', goals(goal('cloud', 'Existing data')));
  assert.equal((await d.api.pullAppFromCloud('home')).ok, true);
  assert.equal(d.rows.get('home').data['goals:2026-10-29'][0].text, 'Existing data');
  assert.equal(JSON.parse(d.localStorage.getItem('goals:2026-10-29'))[0].text, 'Existing data');
});

test('unmergeable concurrent values stop and preserve both copies', async () => {
  const d = dashboard();
  d.seed('finance', { nw_currency: 'USD' });
  d.localStorage.setItem('nw_currency', JSON.stringify('EUR'));
  const result = await d.api.pushAppToCloud('finance');
  assert.equal(result.reason, 'conflict');
  assert.equal(d.rows.get('finance').data.nw_currency, 'USD');
  assert.equal(JSON.parse(d.localStorage.getItem('nw_currency')), 'EUR');
  assert.equal(d.api.getConflicts()[0].appKey, 'finance');
  assert.equal((await d.api.resolveConflict('finance', 'cloud')).ok, true);
  assert.equal(JSON.parse(d.localStorage.getItem('nw_currency')), 'USD');
  assert.equal(d.api.getConflicts().length, 0);
});

test('compare and swap retries after another device writes first', async () => {
  const d = dashboard();
  d.seed('home', goals(goal('cloud', 'Cloud')));
  d.localStorage.setItem('goals:2026-10-29', JSON.stringify([goal('local', 'Local')]));
  d.beforeUpdate(rows => {
    const row = rows.get('home');
    row.data = goals(goal('cloud', 'Cloud'), goal('other', 'Other device'));
    row.updated_at = '2026-01-02T00:00:00.000Z';
  });
  assert.equal((await d.api.pushAppToCloud('home')).ok, true);
  assert.deepEqual(d.rows.get('home').data['goals:2026-10-29'].map(x => x.text), ['Local', 'Cloud', 'Other device']);
});

test('a fully empty local state cannot replace populated cloud data', async () => {
  const d = dashboard();
  d.seed('home', goals(goal('saved', 'Keep me')));
  assert.equal((await d.api.pullAppFromCloud('home')).ok, true);
  d.localStorage.removeItem('goals:2026-10-29');
  assert.equal((await d.api.pushAppToCloud('home')).reason, 'conflict');
  assert.equal(d.rows.get('home').data['goals:2026-10-29'][0].text, 'Keep me');
});
