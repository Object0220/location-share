/**
 * 创建共享房间云函数
 * 生成共享码，建立配对关系
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 云函数独立部署，无法跨目录引用前端常量，此处定义局部常量
const ROLE_NAMES = {
  driver: '拖车司机',
  customer: '客户',
};

exports.main = async (event, context) => {
  const { roomId, shareCode, userA } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || userA.userId;

  console.log('🏠 [createRoom] 开始  roomId=' + roomId + ' shareCode=' + shareCode + ' userId=' + openid);

  if (!roomId || !shareCode) {
    console.warn('🏠 [createRoom] ❌ 参数不完整', JSON.stringify({ roomId, shareCode }));
    return { code: -1, message: '参数不完整' };
  }

  try {
    // 检查是否已有活跃房间
    console.log('🏠 [createRoom] 检查已有活跃房间 userId=' + openid);
    const existing = await db.collection('rooms')
      .where({
        $or: [
          { 'userA.userId': openid },
          { 'userB.userId': openid },
        ],
        status: db.command.in(['waiting', 'active']),
      })
      .get();

    if (existing.data.length > 0) {
      const room = existing.data[0];

      // 如果房间已有配对方（上一轮残留），清空重置为等待状态
      if (room.userB && room.userB.userId) {
        console.log('🏠 [createRoom] 🧹 发现残留配对方 userB=' + room.userB.userId + '，重置房间');
        await db.collection('rooms').doc(room._id).update({
          data: {
            userB: {},
            status: 'waiting',
            shareCode,
            updateTime: db.serverDate(),
          },
        });
        // 同时清理该房间的旧位置数据，避免干扰
        try {
          await db.collection('locations').where({ roomId: room._id }).remove();
        } catch (e) {
          console.warn('🏠 [createRoom] 清理旧位置数据失败', e);
        }
        console.log('🏠 [createRoom] ♻️ 复用已有房间（已重置） roomId=' + room._id + ' shareCode=' + shareCode);
        return {
          code: 0,
          roomId: room._id,
          shareCode,
        };
      }

      // 没有残留配对方，直接复用
      console.log('🏠 [createRoom] ♻️ 复用已有房间 roomId=' + room._id + ' shareCode=' + room.shareCode);
      return {
        code: 0,
        roomId: room._id,
        shareCode: room.shareCode,
      };
    }

    // 检查共享码是否已被占用（最多重试 10 次避免死循环）
    let finalShareCode = shareCode;
    let maxRetries = 10;
    while (maxRetries-- > 0) {
      console.log('🏠 [createRoom] 检查共享码占用 shareCode=' + finalShareCode);
      const codeExists = await db.collection('rooms')
        .where({ shareCode: finalShareCode, status: 'waiting' })
        .get();

      if (codeExists.data.length === 0) break;

      console.log('🏠 [createRoom] 🔁 共享码冲突，重新生成');
      finalShareCode = generateShareCode();
    }

    if (maxRetries < 0) {
      console.error('🏠 [createRoom] ❌ 共享码重试耗尽');
      return { code: -2, message: '共享码生成失败，请重试' };
    }

    // 创建房间
    const roomData = {
      _id: roomId,
      roomId,
      shareCode: finalShareCode,
      userA: {
        userId: openid,
        nickName: userA.nickName || ROLE_NAMES.driver,
        avatarUrl: userA.avatarUrl || '',
      },
      userB: {},
      status: 'waiting',
      createTime: db.serverDate(),
      updateTime: db.serverDate(),
    };
    console.log('🏠 [createRoom] 📝 写入数据库', JSON.stringify({
      roomId, shareCode: finalShareCode,
      userA_id: openid, userA_name: userA.nickName || '拖车司机',
      status: 'waiting',
    }));
    const result = await db.collection('rooms').add({ data: roomData });

    console.log('🏠 [createRoom] ✅ 创建成功', JSON.stringify({
      _id: result._id,
      shareCode: finalShareCode,
      status: 'waiting',
      userA_id: openid,
      userA_name: userA.nickName || ROLE_NAMES.driver,
    }));
    return {
      code: 0,
      roomId: result._id,
      shareCode: finalShareCode,
    };
  } catch (err) {
    console.error('🏠 [createRoom] ❌ 创建失败', err);
    return { code: -1, message: '创建失败' };
  }
};

function generateShareCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
}
