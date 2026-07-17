/**
 * 云函数单元测试
 * Mock wx-server-sdk 验证所有函数的核心业务逻辑
 *
 * 用法: node test_cloudfunctions.js
 */

const assert = require('assert');

// ========== Mock wx-server-sdk ==========

let mockCollectionData = {};
let mockCollectionIndex = {};
let mockServerDateCounter = 0;
let operationLog = [];
let mockedWXContext = { OPENID: 'mock_openid_123', APPID: 'mock_appid', UNIONID: '' };

function resetMockDb() {
  // 默认初始化项目级集合（模拟真实云环境：集合始终存在，即使数据为空）
  mockCollectionData = { rooms: [], locations: [] };
  mockCollectionIndex = {};
  operationLog.length = 0;
  mockedWXContext = { OPENID: 'mock_openid_123', APPID: 'mock_appid', UNIONID: '' };
}

const _command = {
  in: (arr) => ({ _type: 'in', value: arr }),
  lt: (val) => ({ _type: 'lt', value: val }),
  set: (val) => ({ _type: 'set', value: val }),
};

class MockQuery {
  constructor(collection, query = {}) {
    this.collection = collection;
    this.query = query;
  }

  _match(doc) {
    const q = this.query;
    if (q.$or) {
      return q.$or.some(condition => {
        return Object.entries(condition).every(([key, val]) => {
          const keys = key.split('.');
          let d = doc;
          for (const k of keys) {
            if (d === undefined || d === null) return false;
            d = d[k];
          }
          return d === val;
        });
      });
    }
    return Object.entries(q).every(([key, val]) => {
      if (val && typeof val === 'object' && val._type === 'lt') {
        const keys = key.split('.');
        let d = doc;
        for (const k of keys) {
          if (d === undefined || d === null) return false;
          d = d[k];
        }
        return d < val.value;
      }
      if (key === 'status' && val && val._type === 'in') {
        return val.value.includes(doc.status);
      }
      const keys = key.split('.');
      let d = doc;
      for (const k of keys) {
        if (d === undefined || d === null) return false;
        d = d[k];
      }
      return d === val;
    });
  }

  async get() {
    const col = mockCollectionData[this.collection];
    if (col === undefined) {
      throw new Error(`Collection ${this.collection} does not exist`);
    }
    operationLog.push({ action: 'read', collection: this.collection, query: this.query });
    const data = col.filter(doc => this._match(doc));
    return { data, errMsg: 'mock:ok' };
  }

  async remove() {
    const col = mockCollectionData[this.collection] || [];
    const before = col.length;
    mockCollectionData[this.collection] = col.filter(doc => !this._match(doc));
    const removed = before - mockCollectionData[this.collection].length;
    operationLog.push({ action: 'remove', collection: this.collection, query: this.query, removed });
    return { stats: { removed } };
  }

  async update({ data }) {
    const col = mockCollectionData[this.collection] || [];
    let updated = 0;
    for (let i = 0; i < col.length; i++) {
      if (this._match(col[i])) {
        if (data.status) col[i].status = data.status;
        if (data.updateTime) col[i].updateTime = new Date();
        if (data.userB) {
          const val = data.userB;
          if (val && val._type === 'set') {
            col[i].userB = val.value;
          } else {
            col[i].userB = val;
          }
        }
        updated++;
      }
    }
    operationLog.push({ action: 'update', collection: this.collection, query: this.query, updated });
    return { stats: { updated }, errMsg: 'mock:ok' };
  }

  where(query) {
    this.query = { ...this.query, ...query };
    return this;
  }

  doc(id) {
    return new MockDoc(this.collection, id);
  }

  orderBy() { return this; }
  limit() { return this; }

  async add({ data }) {
    operationLog.push({ action: 'add', collection: this.collection, data });
    const id = data._id || `mock_id_${Math.random().toString(36).slice(2, 10)}`;
    const doc = { ...data, _id: id };
    if (!mockCollectionData[this.collection]) mockCollectionData[this.collection] = [];
    mockCollectionData[this.collection].push(doc);
    return { _id: id, errMsg: 'mock:ok' };
  }
}

class MockDoc {
  constructor(collection, id) {
    this.collection = collection;
    this.id = id;
  }

  async get() {
    const col = mockCollectionData[this.collection] || [];
    const doc = col.find(d => d._id === this.id || d.roomId === this.id);
    operationLog.push({ action: 'read_doc', collection: this.collection, id: this.id });
    return { data: doc || null, errMsg: 'mock:ok' };
  }

  async update({ data }) {
    const col = mockCollectionData[this.collection] || [];
    const doc = col.find(d => d._id === this.id || d.roomId === this.id);
    if (doc) {
      Object.assign(doc, data);
    }
    operationLog.push({ action: 'update_doc', collection: this.collection, id: this.id });
    return { stats: { updated: doc ? 1 : 0 }, errMsg: 'mock:ok' };
  }
}

const mockSdk = {
  version: '3.0.4',
  DYNAMIC_CURRENT_ENV: 'mock-env',
  init: () => {},
  database: () => ({
    collection: (name) => new MockQuery(name),
    command: _command,
    serverDate: () => {
      mockServerDateCounter++;
      return new Date(Date.now() + mockServerDateCounter);
    },
  }),
  getWXContext: () => ({ ...mockedWXContext }),
};

// ========== 测试工具 ==========

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  resetMockDb();
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

function assertDeepEq(actual, expected, msg) {
  try {
    assert.deepStrictEqual(actual, expected);
  } catch (e) {
    throw new Error(msg ? `${msg}\n  ${e.message}` : e.message);
  }
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${expected}, got ${actual}`);
  }
}

function assertTruthy(val, msg) {
  if (!val) throw new Error(msg || `Expected truthy, got ${val}`);
}

// ========== 加载云函数（需要 mock 后重新 require）==========

function loadFunction(name) {
  const fnPath = require('path').join(__dirname, name, 'index.js');
  delete require.cache[require.resolve(fnPath)];
  const Module = require('module');
  const originalResolve = Module._resolveFilename;
  const originalLoad = Module._load;
  const mockModules = { 'wx-server-sdk': mockSdk };

  Module._resolveFilename = (request, parent) => {
    if (mockModules[request]) return request;
    return originalResolve(request, parent);
  };
  Module._load = (request, parent) => {
    if (mockModules[request]) return mockModules[request];
    return originalLoad(request, parent);
  };

  const fn = require(fnPath);

  Module._resolveFilename = originalResolve;
  Module._load = originalLoad;

  return fn.main;
}

// ========== 测试用例 ==========

async function runTests() {

console.log('\n🧪 ===== login 测试 =====\n');

await test('login 返回用户身份信息', async () => {
  mockedWXContext = { OPENID: 'u_test', APPID: 'app_test', UNIONID: 'union_test' };
  const fn = loadFunction('login');
  const result = await fn({});
  assertDeepEq(result, { openid: 'u_test', unionid: 'union_test', appid: 'app_test' });
});

console.log('\n🧪 ===== createRoom 测试 =====\n');

await test('createRoom 成功创建房间', async () => {
  const fn = loadFunction('createRoom');
  const result = await fn({ roomId: 'room_001', shareCode: '1234', userA: { nickName: '司机小王' } });
  assertEq(result.code, 0, 'code should be 0');
  assertEq(result.shareCode, '1234');
  assertTruthy(result.roomId);
  const rooms = mockCollectionData['rooms'];
  assertEq(rooms.length, 1);
  assertEq(rooms[0]._id, 'room_001');
  assertEq(rooms[0].status, 'waiting');
  assertEq(rooms[0].userA.userId, 'mock_openid_123');
  assertEq(rooms[0].userA.nickName, '司机小王');
});

await test('createRoom 复用已有的房间（无残留配对方）', async () => {
  mockCollectionData['rooms'] = [{
    _id: 'room_existing', roomId: 'room_existing', shareCode: '9999',
    userA: { userId: 'mock_openid_123', nickName: '司机' },
    userB: {},  // 上一轮没有配对方
    status: 'waiting',
  }];
  const fn = loadFunction('createRoom');
  const result = await fn({ roomId: 'room_new', shareCode: '8888', userA: {} });
  assertEq(result.code, 0);
  assertEq(result.roomId, 'room_existing', '应该复用已有房间');
  assertEq(result.shareCode, '9999', '无残留时保持原共享码');
});

await test('createRoom 复用房间时清理残留配对方', async () => {
  // 模拟上一轮残留：room 有 userB（客户已加入但没正常结束）
  mockCollectionData['rooms'] = [{
    _id: 'room_stale', roomId: 'room_stale', shareCode: '1111',
    userA: { userId: 'mock_openid_123', nickName: '司机' },
    userB: { userId: 'old_client', nickName: '旧客户' },
    status: 'active',
  }];
  const fn = loadFunction('createRoom');
  const result = await fn({ roomId: 'room_new', shareCode: '6666', userA: {} });
  assertEq(result.code, 0);
  assertEq(result.roomId, 'room_stale', '复用旧房间');
  assertEq(result.shareCode, '6666', '应使用新的共享码');
  // 验证数据库已重置
  const updated = mockCollectionData['rooms'][0];
  assertEq(updated.status, 'waiting', '状态已重置为 waiting');
  assertEq(updated.userB.userId, undefined, 'userB 已清空');
  assertEq(updated.shareCode, '6666', '共享码已更新');
  console.log('    ✅ 残留配对方已清理，状态已重置');
});

await test('createRoom 共享码冲突时自动重试生成新码', async () => {
  mockCollectionData['rooms'] = [{
    _id: 'room_occupied', roomId: 'room_occupied', shareCode: '1234',
    userA: { userId: 'someone_else_1' },
    userB: {},
    status: 'waiting',
  }];
  const fn = loadFunction('createRoom');
  const result = await fn({ roomId: 'room_002', shareCode: '1234', userA: {} });
  assertEq(result.code, 0);
  assertTruthy(result.shareCode !== '1234', '共享码应已变更');
  console.log(`    重试后新码: ${result.shareCode}`);
});

console.log('\n🧪 ===== joinRoom 测试 =====\n');

await test('joinRoom 通过共享码成功加入房间', async () => {
  mockCollectionData['rooms'] = [{
    _id: 'room_join', roomId: 'room_join', shareCode: '2468',
    userA: { userId: 'driver_001', nickName: '司机', avatarUrl: '' },
    userB: {},
    status: 'waiting',
    createTime: new Date(),
  }];
  const fn = loadFunction('joinRoom');
  const result = await fn({ shareCode: '2468', userB: { nickName: '客户张三' } });
  assertEq(result.code, 0);
  assertEq(result.roomId, 'room_join');
  assertEq(result.partnerInfo.nickName, '司机');
  const room = mockCollectionData['rooms'][0];
  assertEq(room.status, 'active');
  assertEq(room.userB.userId, 'mock_openid_123');
  assertEq(room.userB.nickName, '客户张三');
});

await test('joinRoom 不能加入自己的房间', async () => {
  mockCollectionData['rooms'] = [{
    _id: 'room_self', roomId: 'room_self', shareCode: '1111',
    userA: { userId: 'mock_openid_123', nickName: '我自己' },
    userB: {},
    status: 'waiting',
  }];
  const fn = loadFunction('joinRoom');
  const result = await fn({ shareCode: '1111', userB: {} });
  assertEq(result.code, -1);
  assertEq(result.message, '不能加入自己创建的房间');
});

await test('joinRoom 房间已被别人加入时条件更新失败', async () => {
  mockCollectionData['rooms'] = [{
    _id: 'room_race', roomId: 'room_race', shareCode: '3333',
    userA: { userId: 'driver_002' },
    userB: {},
    status: 'active',
  }];
  const fn = loadFunction('joinRoom');
  const result = await fn({ shareCode: '3333', userB: { nickName: '来晚了' } });
  assertEq(result.code, -1);
  assertEq(result.message, '共享码无效或房间已过期');
});

await test('joinRoom 无效共享码', async () => {
  const fn = loadFunction('joinRoom');
  const result = await fn({ shareCode: '0000', userB: {} });
  assertEq(result.code, -1);
  assertEq(result.message, '共享码无效或房间已过期');
});

console.log('\n🧪 ===== getRoomInfo 测试 =====\n');

await test('getRoomInfo 非成员访问被拒', async () => {
  mockCollectionData['rooms'] = [{
    _id: 'room_001', roomId: 'room_001', shareCode: '1234',
    userA: { userId: 'someone_else' },
    userB: {},
    status: 'active',
  }];
  const fn = loadFunction('getRoomInfo');
  const result = await fn({ roomId: 'room_001' });
  assertEq(result.code, -1);
  assertEq(result.message, '您不是该房间的成员');
});

await test('getRoomInfo 成员获取房间信息及位置', async () => {
  mockCollectionData['rooms'] = [{
    _id: 'room_info', roomId: 'room_info', shareCode: '5555',
    userA: { userId: 'mock_openid_123', nickName: '我' },
    userB: { userId: 'partner_001', nickName: '对方' },
    status: 'active',
    createTime: new Date('2026-01-01'),
  }];
  mockCollectionData['locations'] = [
    { _id: 'room_info_partner_001', roomId: 'room_info', userId: 'partner_001',
      latitude: 39.9042, longitude: 116.4074, timestamp: new Date() },
    { _id: 'room_info_mock_openid_123', roomId: 'room_info', userId: 'mock_openid_123',
      latitude: 31.2304, longitude: 121.4737, timestamp: new Date() },
  ];
  const fn = loadFunction('getRoomInfo');
  const result = await fn({ roomId: 'room_info' });
  assertEq(result.code, 0);
  assertEq(result.roomData.shareCode, '5555');
  assertEq(result.partnerInfo.userId, 'partner_001');
  assertEq(result.partnerLocation.latitude, 39.9042);
  assertEq(result.partnerLocation.longitude, 116.4074);
  assertEq(result.myLocation.latitude, 31.2304);
});

await test('getRoomInfo B 尚未加入时 partnerLocation 为 null', async () => {
  mockCollectionData['rooms'] = [{
    _id: 'room_waiting', roomId: 'room_waiting', shareCode: '6666',
    userA: { userId: 'mock_openid_123', nickName: '我' },
    userB: {},  // B 尚未加入，userB 是空对象
    status: 'waiting',
    createTime: new Date(),
  }];
  const fn = loadFunction('getRoomInfo');
  const result = await fn({ roomId: 'room_waiting' });
  assertEq(result.code, 0);
  // userB 是 {}（空对象），partnerInfo 不会是 null，但 partnerInfo.userId 未定义
  assertEq(result.partnerInfo.userId, undefined, 'B 没加入时 partnerInfo.userId 应为 undefined');
  assertEq(result.partnerLocation, null, 'B 没加入时 partnerLocation 应为 null');
});

await test('getRoomInfo B 加入但无位置数据时不查 DB', async () => {
  mockCollectionData['rooms'] = [{
    _id: 'room_no_loc', roomId: 'room_no_loc', shareCode: '7777',
    userA: { userId: 'mock_openid_123', nickName: '我' },
    userB: { userId: '', nickName: '', avatarUrl: '' },
    status: 'active',
    createTime: new Date(),
  }];
  const fn = loadFunction('getRoomInfo');
  const result = await fn({ roomId: 'room_no_loc' });
  assertEq(result.code, 0);
  assertEq(result.partnerLocation, null, '空用户ID时不应该查位置');
});

console.log('\n🧪 ===== leaveRoom 测试 =====\n');

await test('leaveRoom 非成员操作被拒绝', async () => {
  mockCollectionData['rooms'] = [{
    _id: 'room_end', roomId: 'room_end',
    userA: { userId: 'stranger' },
    userB: {},
    status: 'active',
  }];
  const fn = loadFunction('leaveRoom');
  const result = await fn({ roomId: 'room_end' });
  assertEq(result.code, -1);
  assertEq(result.message, '您不是该房间的成员');
});

await test('leaveRoom 房间成员成功结束', async () => {
  mockCollectionData['rooms'] = [{
    _id: 'room_end_ok', roomId: 'room_end_ok',
    userA: { userId: 'mock_openid_123' },
    userB: { userId: 'partner' },
    status: 'active',
  }];
  mockCollectionData['locations'] = [
    { _id: 'room_end_ok_mock_openid_123', roomId: 'room_end_ok', userId: 'mock_openid_123' },
    { _id: 'room_end_ok_partner', roomId: 'room_end_ok', userId: 'partner' },
  ];
  const fn = loadFunction('leaveRoom');
  const result = await fn({ roomId: 'room_end_ok' });
  assertEq(result.code, 0);
  assertEq(result.message, '已结束共享');
  assertEq(mockCollectionData['rooms'][0].status, 'ended');
  assertEq(mockCollectionData['locations'].length, 0, '位置数据应被清理');
});

await test('leaveRoom 已结束的房间幂等', async () => {
  mockCollectionData['rooms'] = [{
    _id: 'room_already_ended', roomId: 'room_already_ended',
    userA: { userId: 'mock_openid_123' },
    userB: {},
    status: 'ended',
  }];
  const fn = loadFunction('leaveRoom');
  const result = await fn({ roomId: 'room_already_ended' });
  assertEq(result.code, 0);
  assertEq(result.message, '房间已结束');
  const updates = operationLog.filter(o => o.action === 'update' || o.action === 'update_doc');
  assertEq(updates.length, 0, '已结束的房间不应再执行更新');
});

console.log('\n🧪 ===== cleanExpiredLocations 测试 =====\n');

await test('cleanExpiredLocations 清理过期位置和房间', async () => {
  mockCollectionData['locations'] = [
    { _id: 'loc1', roomId: 'r1', timestamp: new Date(Date.now() - 10 * 60 * 1000) },
    { _id: 'loc2', roomId: 'r1', timestamp: new Date() },
  ];
  mockCollectionData['rooms'] = [
    { _id: 'r1', roomId: 'r1', status: 'waiting', createTime: new Date(Date.now() - 60 * 60 * 1000) },
  ];
  const fn = loadFunction('cleanExpiredLocations');
  const result = await fn({});
  assertEq(result.code, 0);
  assertEq(result.cleaned, 1, '应该清理 1 条过期位置');
  assertEq(result.cleanedRooms, 1, '应该关闭 1 个过期房间');
  assertEq(mockCollectionData['locations'].length, 1, '位置还剩 1 条');
  assertEq(mockCollectionData['rooms'][0].status, 'ended');
});

console.log('\n🧪 ===== initDatabase 测试 =====\n');

await test('initDatabase 检测到缺少集合', async () => {
  // 模拟 rooms 集合被删除
  delete mockCollectionData['rooms'];
  const fn = loadFunction('initDatabase');
  const result = await fn();
  assertEq(result.code, -1, '缺少集合应返回 -1');
  assertEq(result.results.find(r => r.name === 'rooms').status, 'not_exists');
  assertEq(result.results.find(r => r.name === 'locations').status, 'exists');
});

}

// ========== 输出结果 ==========

runTests().then(() => {
  console.log(`\n${'='.repeat(40)}`);
  console.log(`📊 总计: ${passed + failed}  通过: ${passed}  失败: ${failed}`);

  if (failures.length > 0) {
    console.log(`\n❌ 失败详情:`);
    failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
    process.exit(1);
  } else {
    console.log('\n🎉 全部通过！');
  }
});
