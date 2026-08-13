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
  const { roomId, shareCode, userA, taskId } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || userA.userId;

  console.log('🏠 [createRoom] 开始  roomId=' + roomId + ' shareCode=' + shareCode + ' taskId=' + taskId + ' userId=' + openid);

  if (!roomId || !shareCode) {
    console.warn('🏠 [createRoom] ❌ 参数不完整', JSON.stringify({ roomId, shareCode }));
    return { code: -1, message: '参数不完整' };
  }

  try {
    // 按 roomId（taskId 维度）精确查询是否已有房间
    // 同一 taskId 再次进入（如司机重进）直接复用，不清空配对方
    console.log('🏠 [createRoom] 检查已有房间 roomId=' + roomId);
    const existing = await db.collection('rooms').doc(roomId).get().catch(() => null);

    if (existing && existing.data) {
      const room = existing.data;
      if (room.status === 'waiting' || room.status === 'active') {
        console.log('🏠 [createRoom] ♻️ 复用已有房间 roomId=' + room._id + ' shareCode=' + room.shareCode);
        return {
          code: 0,
          roomId: room._id,
          shareCode: room.shareCode,
        };
      }
      // 已结束的房间：重置为干净的等待态后复用（保留 userA，清空配对方避免旧客户数据干扰）
      console.log('🏠 [createRoom] 🔄 房间已结束，重置为等待态 roomId=' + room._id);
      await db.collection('rooms').doc(room._id).update({
        data: {
          status: 'waiting',
          userB: {},
          updateTime: db.serverDate(),
        },
      });
      return {
        code: 0,
        roomId: room._id,
        shareCode: room.shareCode,
      };
    }

    // 共享码使用传入值（车主号码后4位），不做随机重试，避免验证码漂移导致客户无法加入

    // 创建房间
    const roomData = {
      _id: roomId,
      roomId,
      shareCode,
      taskId: taskId || '',
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
      roomId, shareCode,
      userA_id: openid, userA_name: userA.nickName || '拖车司机',
      status: 'waiting',
    }));
    const result = await db.collection('rooms').add({ data: roomData });

    console.log('🏠 [createRoom] ✅ 创建成功', JSON.stringify({
      _id: result._id,
      shareCode,
      status: 'waiting',
      userA_id: openid,
      userA_name: userA.nickName || ROLE_NAMES.driver,
    }));
    return {
      code: 0,
      roomId: result._id,
      shareCode,
    };
  } catch (err) {
    console.error('🏠 [createRoom] ❌ 创建失败', err);
    return { code: -1, message: '创建失败' };
  }
};
