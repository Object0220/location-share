/**
 * Mock 微信云开发 SDK - 用于本地测试
 *
 * 这是一个可以直接作为 wx-server-sdk mock 的模块。
 * 所有云函数通过 require('wx-server-sdk') 获取同一个 mock 实例。
 *
 * 测试文件中通过 require('./mock-cloud') 获取 dbStore / resetStore / setCurrentUser。
 */

// ---- 共享数据库存储 ----
const dbStore = {};
function ensureStore(name) {
  if (!dbStore[name]) dbStore[name] = new Map();
  return dbStore[name];
}

function resetStore() {
  Object.keys(dbStore).forEach(k => dbStore[k].clear());
}

// ---- 当前用户身份 ----
let currentUserId = 'user_A';
function setCurrentUser(openid) {
  currentUserId = openid;
}

// ---- 数据库操作辅助 ----

function getNestedValue(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function matchesConditions(data, conditions) {
  if (!conditions || Object.keys(conditions).length === 0) return true;
  if (conditions.$or) {
    for (const c of conditions.$or) if (matchesConditions(data, c)) return true;
    return false;
  }
  if (conditions.$and) return conditions.$and.every(c => matchesConditions(data, c));
  for (const [field, cond] of Object.entries(conditions)) {
    if (field === '$or' || field === '$and') continue;
    const val = getNestedValue(data, field);
    if (cond && typeof cond === 'object' && '$in' in cond) {
      if (!cond.$in.includes(val)) return false;
    } else if (cond && typeof cond === 'object' && '$lt' in cond) {
      if (!(val < cond.$lt)) return false;
    } else if (val !== cond) {
      return false;
    }
  }
  return true;
}

function resolveCommands(updateData) {
  const r = {};
  for (const [k, v] of Object.entries(updateData)) {
    r[k] = (v && typeof v === 'object' && '__set_cmd__' in v) ? v.__set_cmd__ : v;
  }
  return r;
}

class MockDocRef {
  constructor(store, id) {
    this.store = store;
    this.id = id;
  }
  async get() {
    return { data: this.store.get(this.id) || null, errMsg: 'document.get:ok' };
  }
  async update({ data }) {
    const existing = this.store.get(this.id);
    if (!existing) return { stats: { updated: 0 } };
    this.store.set(this.id, { ...existing, ...resolveCommands(data) });
    return { stats: { updated: 1 } };
  }
  async set({ data }) {
    this.store.set(this.id, { ...data, _id: this.id });
    return { _id: this.id, errMsg: 'document.set:ok' };
  }
  async remove() {
    const had = this.store.has(this.id);
    this.store.delete(this.id);
    return { stats: { removed: had ? 1 : 0 } };
  }
}

class MockQuery {
  constructor(store, conditions = {}) {
    this.store = store;
    this.conditions = conditions;
  }
  _results() {
    const out = [];
    for (const [id, data] of this.store) {
      if (matchesConditions(data, this.conditions)) {
        out.push({ ...data, _id: id, id });
      }
    }
    return out;
  }
  async get() {
    return { data: this._results(), errMsg: 'collection.get:ok' };
  }
  async update({ data }) {
    let c = 0;
    const resolved = resolveCommands(data);
    for (const record of this._results()) {
      this.store.set(record._id, { ...this.store.get(record._id), ...resolved });
      c++;
    }
    return { stats: { updated: c } };
  }
  async remove() {
    let c = 0;
    for (const record of this._results()) {
      this.store.delete(record._id);
      c++;
    }
    return { stats: { removed: c } };
  }
  where(conditions) {
    return new MockQuery(this.store, conditions);
  }
  orderBy() { return this; }
  limit() { return this; }
  skip() { return this; }
}

class MockCollectionRef {
  constructor(store) { this.store = store; }
  doc(id) { return new MockDocRef(this.store, id); }
  where(conditions) { return new MockQuery(this.store, conditions); }
  async add({ data }) {
    const id = data._id || 'mock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    this.store.set(id, { ...data, _id: id });
    return { _id: id, errMsg: 'collection.add:ok' };
  }
  limit(n) { return new MockQuery(this.store, {}); }
}

// ---- 构建 mock SDK ----
const mockCloud = {
  init: (opts) => {},
  DYNAMIC_CURRENT_ENV: '__dynamic__',

  database: () => ({
    collection: (name) => new MockCollectionRef(ensureStore(name)),
    serverDate: () => new Date(),
    command: {
      in: (arr) => ({ $in: arr }),
      lt: (val) => ({ $lt: val }),
      set: (val) => ({ __set_cmd__: val }),
    },
  }),

  getWXContext: () => ({
    OPENID: currentUserId,
    APPID: 'mock_appid',
    UNIONID: '',
  }),
};

module.exports = mockCloud;
module.exports.dbStore = dbStore;
module.exports.resetStore = resetStore;
module.exports.setCurrentUser = setCurrentUser;
