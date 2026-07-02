/**
 * 创建共享房间云函数
 * 生成共享码，建立配对关系
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

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
      console.log('🏠 [createRoom] ♻️ 复用已有房间 roomId=' + room._id + ' shareCode=' + room.shareCode);
      return {
        code: 0,
        roomId: room._id,
        shareCode: room.shareCode,
        qrcodeUrl: '',
      };
    }

    // 检查共享码是否已被占用
    console.log('🏠 [createRoom] 检查共享码占用 shareCode=' + shareCode);
    const codeExists = await db.collection('rooms')
      .where({ shareCode, status: 'waiting' })
      .get();

    if (codeExists.data.length > 0) {
      console.log('🏠 [createRoom] 🔁 共享码冲突，重新生成');
      return exports.main({
        ...event,
        shareCode: generateShareCode(),
      });
    }

    // 创建房间
    console.log('🏠 [createRoom] 📝 写入数据库 roomId=' + roomId);
    const result = await db.collection('rooms').add({
      data: {
        _id: roomId,
        roomId,
        shareCode,
        userA: {
          userId: openid,
          nickName: userA.nickName || '拖车司机',
          avatarUrl: userA.avatarUrl || '',
        },
        userB: {},
        status: 'waiting',
        createTime: db.serverDate(),
        updateTime: db.serverDate(),
      },
    });

    console.log('🏠 [createRoom] ✅ 创建成功 roomId=' + result._id + ' shareCode=' + shareCode);
    return {
      code: 0,
      roomId: result._id,
      shareCode,
      qrcodeUrl: '',
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
