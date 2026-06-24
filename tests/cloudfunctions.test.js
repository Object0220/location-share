/**
 * 服务端云函数逻辑测试
 *
 * 测试全部 6 个云函数的核心业务逻辑：
 *   login, createRoom, joinRoom, getRoomInfo, leaveRoom, cleanExpiredLocations
 *
 * 通过 moduleNameMapper 将 wx-server-sdk 重定向到 mock-cloud.js。
 * 云函数内部 require('wx-server-sdk') 拿到的是同一个 mock 实例，
 * 共享 dbStore 数据库状态。
 */

const { dbStore, resetStore, setCurrentUser } = require('./mock-cloud');

// 云函数内部通过 require('wx-server-sdk') 拿到的就是我们的 mock
const login = require('../cloudfunctions/login/index');
const createRoom = require('../cloudfunctions/createRoom/index');
const joinRoom = require('../cloudfunctions/joinRoom/index');
const getRoomInfo = require('../cloudfunctions/getRoomInfo/index');
const leaveRoom = require('../cloudfunctions/leaveRoom/index');
const cleanExpiredLocations = require('../cloudfunctions/cleanExpiredLocations/index');

// 快捷获取 mock database（用于测试中直接写数据）
function mockDb() {
  const cloud = require('wx-server-sdk');
  return cloud.database();
}

describe('🔐 login', () => {
  beforeEach(() => resetStore());

  test('应返回当前用户的 openid', async () => {
    setCurrentUser('test_user_001');
    const res = await login.main({});
    expect(res.openid).toBe('test_user_001');
    expect(res.appid).toBe('mock_appid');
    expect(res.unionid).toBeDefined();
  });
});

describe('🏠 createRoom', () => {
  beforeEach(() => resetStore());

  test('应成功创建等待中的房间', async () => {
    setCurrentUser('user_A');
    const res = await createRoom.main({
      roomId: 'room_001',
      shareCode: '1234',
      userA: { nickName: 'Alice' },
    });

    expect(res.code).toBe(0);
    // 云函数将 roomId 作为 _id 写入，add 返回 _id
    expect(res.roomId).toBe('room_001');
    expect(res.shareCode).toBe('1234');

    const room = dbStore.rooms.get('room_001');
    expect(room).toBeTruthy();
    expect(room.status).toBe('waiting');
    expect(room.userA.userId).toBe('user_A');
    expect(room.userA.nickName).toBe('Alice');
    expect(room.userB).toEqual({});
  });

  test('参数不完整时应返回错误', async () => {
    const res = await createRoom.main({ roomId: '', shareCode: '' });
    expect(res.code).toBe(-1);
    expect(res.message).toBe('参数不完整');
  });

  test('用户已有活跃房间时应复用', async () => {
    setCurrentUser('user_A');
    const res1 = await createRoom.main({
      roomId: 'room_001',
      shareCode: '1234',
      userA: { nickName: 'Alice' },
    });
    expect(res1.code).toBe(0);

    // 再次创建（不同 roomId），应该复用原房间
    const res2 = await createRoom.main({
      roomId: 'room_999',
      shareCode: '9999',
      userA: { nickName: 'Alice' },
    });
    expect(res2.code).toBe(0);
    // 因为用户已有活跃房间，复用 room_001
    expect(res2.roomId).toBe('room_001');
    expect(res2.shareCode).toBe('1234');
    expect(dbStore.rooms.size).toBe(1);
  });

  test('共享码冲突时应自动重新生成', async () => {
    setCurrentUser('user_A');
    await createRoom.main({ roomId: 'room_001', shareCode: '1234', userA: { nickName: 'Alice' } });

    setCurrentUser('user_B');
    const res = await createRoom.main({ roomId: 'room_B', shareCode: '1234', userA: { nickName: 'Bob' } });
    expect(res.code).toBe(0);
    expect(res.shareCode).not.toBe('1234');
    expect(dbStore.rooms.size).toBe(2);
  });
});

describe('🔗 joinRoom', () => {
  beforeEach(() => resetStore());

  test('通过共享码加入房间应成功', async () => {
    setCurrentUser('user_A');
    await createRoom.main({ roomId: 'room_001', shareCode: '1234', userA: { nickName: 'Alice' } });

    setCurrentUser('user_B');
    const res = await joinRoom.main({ shareCode: '1234', userB: { nickName: 'Bob' } });
    expect(res.code).toBe(0);
    expect(res.roomId).toBe('room_001');
    expect(res.partnerInfo.nickName).toBe('Alice');

    const room = dbStore.rooms.get('room_001');
    expect(room.status).toBe('active');
    expect(room.userB.userId).toBe('user_B');
  });

  test('无效共享码应返回错误', async () => {
    const res = await joinRoom.main({ shareCode: '0000', userB: {} });
    expect(res.code).toBe(-1);
    expect(res.message).toBe('共享码无效或房间已过期');
  });

  test('空共享码应返回错误', async () => {
    const res = await joinRoom.main({ shareCode: '', userB: {} });
    expect(res.code).toBe(-1);
    expect(res.message).toBe('请输入共享码');
  });

  test('不能加入自己的房间', async () => {
    setCurrentUser('user_A');
    await createRoom.main({ roomId: 'room_001', shareCode: '1234', userA: { nickName: 'Alice' } });

    const res = await joinRoom.main({ shareCode: '1234', userB: { nickName: 'Alice' } });
    expect(res.code).toBe(-1);
    expect(res.message).toBe('不能加入自己创建的房间');
  });

  test('用户在其他活跃房间时应自动退出旧房间', async () => {
    setCurrentUser('user_A');
    await createRoom.main({ roomId: 'room_001', shareCode: '1111', userA: { nickName: 'Alice' } });
    setCurrentUser('user_B');
    await joinRoom.main({ shareCode: '1111', userB: { nickName: 'Bob' } });

    // C 创建新房间
    setCurrentUser('user_C');
    await createRoom.main({ roomId: 'room_002', shareCode: '2222', userA: { nickName: 'Carol' } });

    // B 加入 C 的房间
    setCurrentUser('user_B');
    const res = await joinRoom.main({ shareCode: '2222', userB: { nickName: 'Bob' } });
    expect(res.code).toBe(0);

    // B 离开后 room_001 应已 ended
    expect(dbStore.rooms.get('room_001').status).toBe('ended');
    // room_002 应 active
    expect(dbStore.rooms.get('room_002').status).toBe('active');
  });

  test('两人同时加入同一房间时只一人成功（乐观锁）', async () => {
    setCurrentUser('user_A');
    await createRoom.main({ roomId: 'room_001', shareCode: '1234', userA: { nickName: 'Alice' } });

    setCurrentUser('user_B1');
    const res1 = await joinRoom.main({ shareCode: '1234', userB: { nickName: 'Bob1' } });

    // 第二次加入时房间状态已变为 active，不会再匹配到 waiting 房间
    setCurrentUser('user_B2');
    const res2 = await joinRoom.main({ shareCode: '1234', userB: { nickName: 'Bob2' } });

    expect(res1.code).toBe(0);
    expect(res2.code).toBe(-1);
  });
});

describe('📡 getRoomInfo', () => {
  beforeEach(() => resetStore());

  test('房间成员应能获取对方信息及位置', async () => {
    setCurrentUser('user_A');
    await createRoom.main({ roomId: 'room_001', shareCode: '1234', userA: { nickName: 'Alice' } });
    setCurrentUser('user_B');
    await joinRoom.main({ shareCode: '1234', userB: { nickName: 'Bob' } });

    // 写位置数据（使用云函数真实的文档 ID 格式：roomId_userId）
    const db = mockDb();
    await db.collection('locations').doc('room_001_user_A').set({
      data: { roomId: 'room_001', userId: 'user_A', latitude: 39.9042, longitude: 116.4074, heading: 0, accuracy: 10, timestamp: new Date() },
    });
    await db.collection('locations').doc('room_001_user_B').set({
      data: { roomId: 'room_001', userId: 'user_B', latitude: 39.9142, longitude: 116.4174, heading: 90, accuracy: 8, timestamp: new Date() },
    });

    // A 查看房间信息
    setCurrentUser('user_A');
    const res = await getRoomInfo.main({ roomId: 'room_001' });
    expect(res.code).toBe(0);
    expect(res.partnerInfo.nickName).toBe('Bob');
    expect(res.partnerLocation).toBeTruthy();
    expect(res.partnerLocation.latitude).toBe(39.9142);
    expect(res.partnerLocation.longitude).toBe(116.4174);
    expect(res.myLocation.latitude).toBe(39.9042);
  });

  test('非房间成员应被拒绝', async () => {
    setCurrentUser('user_A');
    await createRoom.main({ roomId: 'room_001', shareCode: '1234', userA: { nickName: 'Alice' } });
    setCurrentUser('user_B');
    await joinRoom.main({ shareCode: '1234', userB: { nickName: 'Bob' } });

    // 外人 C 尝试获取
    setCurrentUser('user_C');
    const res = await getRoomInfo.main({ roomId: 'room_001' });
    expect(res.code).toBe(-1);
    expect(res.message).toBe('您不是该房间的成员');
  });

  test('对方尚无位置时应为 null', async () => {
    setCurrentUser('user_A');
    await createRoom.main({ roomId: 'room_001', shareCode: '1234', userA: { nickName: 'Alice' } });
    setCurrentUser('user_B');
    await joinRoom.main({ shareCode: '1234', userB: { nickName: 'Bob' } });

    // A 查看，双方都还没上报位置
    setCurrentUser('user_A');
    const res = await getRoomInfo.main({ roomId: 'room_001' });
    expect(res.code).toBe(0);
    expect(res.partnerLocation).toBeNull();
    expect(res.myLocation).toBeNull();
  });

  test('参数不完整时返回错误', async () => {
    const res = await getRoomInfo.main({ roomId: '' });
    expect(res.code).toBe(-1);
    expect(res.message).toBe('参数不完整');
  });
});

describe('🚪 leaveRoom', () => {
  beforeEach(() => resetStore());

  test('离开房间后状态变为 ended 并清理位置数据', async () => {
    setCurrentUser('user_A');
    await createRoom.main({ roomId: 'room_001', shareCode: '1234', userA: { nickName: 'Alice' } });
    setCurrentUser('user_B');
    await joinRoom.main({ shareCode: '1234', userB: { nickName: 'Bob' } });

    // 写入位置数据
    const db = mockDb();
    await db.collection('locations').doc('room_001_user_A').set({
      data: { roomId: 'room_001', userId: 'user_A', latitude: 39.9, longitude: 116.4, timestamp: new Date() },
    });
    await db.collection('locations').doc('room_001_user_B').set({
      data: { roomId: 'room_001', userId: 'user_B', latitude: 39.91, longitude: 116.41, timestamp: new Date() },
    });
    expect(dbStore.locations.size).toBe(2);

    // A 离开房间
    const res = await leaveRoom.main({ roomId: 'room_001' });
    expect(res.code).toBe(0);

    expect(dbStore.rooms.get('room_001').status).toBe('ended');
    expect(dbStore.locations.size).toBe(0);
  });

  test('不存在的房间应返回错误', async () => {
    const res = await leaveRoom.main({ roomId: 'nonexistent' });
    expect(res.code).toBe(-1);
    expect(res.message).toBe('房间不存在');
  });

  test('空 roomId 应返回错误', async () => {
    const res = await leaveRoom.main({ roomId: '' });
    expect(res.code).toBe(-1);
    expect(res.message).toBe('参数不完整');
  });
});

describe('🧹 cleanExpiredLocations', () => {
  beforeEach(() => resetStore());

  test('应清理超时位置数据（>5分钟）', async () => {
    const db = mockDb();
    const oldTime = new Date(Date.now() - 10 * 60 * 1000);
    const recentTime = new Date(Date.now() - 1 * 60 * 1000);

    await db.collection('locations').doc('loc_expired').set({
      data: { roomId: 'r1', userId: 'u1', latitude: 39.9, longitude: 116.4, timestamp: oldTime },
    });
    await db.collection('locations').doc('loc_recent').set({
      data: { roomId: 'r2', userId: 'u2', latitude: 39.9, longitude: 116.4, timestamp: recentTime },
    });
    expect(dbStore.locations.size).toBe(2);

    const res = await cleanExpiredLocations.main({});
    expect(res.code).toBe(0);
    expect(res.cleaned).toBe(1); // 只清掉老数据
    expect(dbStore.locations.size).toBe(1);
  });

  test('应关闭超时 waiting 房间（>30分钟）', async () => {
    // 直接写一个超时 waiting 房间（约40分钟前）
    dbStore.rooms.set('room_old', {
      _id: 'room_old', roomId: 'room_old', shareCode: '0001',
      userA: { userId: 'old_user' }, userB: {},
      status: 'waiting', createTime: new Date(Date.now() - 40 * 60 * 1000),
    });
    // 较新的 waiting 房间（约5分钟前）
    dbStore.rooms.set('room_new', {
      _id: 'room_new', roomId: 'room_new', shareCode: '0002',
      userA: { userId: 'new_user' }, userB: {},
      status: 'waiting', createTime: new Date(Date.now() - 5 * 60 * 1000),
    });
    expect(dbStore.rooms.size).toBe(2);

    const res = await cleanExpiredLocations.main({});
    expect(res.code).toBe(0);
    expect(res.cleanedRooms).toBe(1);
    expect(dbStore.rooms.get('room_old').status).toBe('ended');
    expect(dbStore.rooms.get('room_new').status).toBe('waiting');
  });
});

describe('🔄 完整流程：A ↔ B 位置共享', () => {
  beforeEach(() => resetStore());

  test('创建 → 加入 → 上报位置 → 相互查看 → 离开', async () => {
    // 1. A 创建房间
    setCurrentUser('user_Alice');
    const createRes = await createRoom.main({
      roomId: 'room_integration',
      shareCode: '4321',
      userA: { nickName: 'Alice' },
    });
    expect(createRes.code).toBe(0);
    const roomId = createRes.roomId;

    // 2. B 通过共享码加入
    setCurrentUser('user_Bob');
    const joinRes = await joinRoom.main({
      shareCode: '4321',
      userB: { nickName: 'Bob' },
    });
    expect(joinRes.code).toBe(0);
    expect(joinRes.partnerInfo.nickName).toBe('Alice');

    // 3. A 上报位置（上海）
    setCurrentUser('user_Alice');
    const db = mockDb();
    await db.collection('locations').doc(roomId + '_user_Alice').set({
      data: { roomId, userId: 'user_Alice', latitude: 31.2304, longitude: 121.4737, heading: 180, accuracy: 5, timestamp: new Date() },
    });

    // 4. B 上报位置（上海偏东）
    setCurrentUser('user_Bob');
    await db.collection('locations').doc(roomId + '_user_Bob').set({
      data: { roomId, userId: 'user_Bob', latitude: 31.2404, longitude: 121.4837, heading: 270, accuracy: 6, timestamp: new Date() },
    });

    // 5. A 查看 -> 看到 Bob 的位置
    setCurrentUser('user_Alice');
    const infoA = await getRoomInfo.main({ roomId });
    expect(infoA.code).toBe(0);
    expect(infoA.partnerInfo.nickName).toBe('Bob');
    expect(infoA.partnerLocation.latitude).toBe(31.2404);
    expect(infoA.partnerLocation.longitude).toBe(121.4837);
    expect(infoA.myLocation.latitude).toBe(31.2304);

    // 6. B 查看 -> 看到 Alice 的位置
    setCurrentUser('user_Bob');
    const infoB = await getRoomInfo.main({ roomId });
    expect(infoB.code).toBe(0);
    expect(infoB.partnerLocation.latitude).toBe(31.2304);
    expect(infoB.myLocation.latitude).toBe(31.2404);

    // 7. A 结束共享
    setCurrentUser('user_Alice');
    const leaveRes = await leaveRoom.main({ roomId });
    expect(leaveRes.code).toBe(0);

    // 8. 验证
    expect(dbStore.rooms.get(roomId).status).toBe('ended');
    expect(dbStore.locations.size).toBe(0);
  });
});
