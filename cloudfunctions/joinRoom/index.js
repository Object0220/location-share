/**
 * 通过共享码加入房间云函数
 * B 用户输入共享码后配对
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { shareCode, userB } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || userB.userId;

  console.log('🔗 [joinRoom] 开始 shareCode=' + shareCode + ' userId=' + openid);

  if (!shareCode) {
    console.warn('🔗 [joinRoom] ❌ 共享码为空');
    return { code: -1, message: '请输入共享码' };
  }

  try {
    // 查找对应房间
    console.log('🔗 [joinRoom] 查找等待中的房间 shareCode=' + shareCode);
    const roomRes = await db.collection('rooms')
      .where({
        shareCode,
        status: 'waiting',
      })
      .get();

    if (roomRes.data.length === 0) {
      console.warn('🔗 [joinRoom] ❌ 未找到房间 shareCode=' + shareCode);
      return { code: -1, message: '共享码无效或房间已过期' };
    }

    const room = roomRes.data[0];
    console.log('🔗 [joinRoom] 找到房间 roomId=' + room._id + ' creator=' + room.userA.userId);

    // 检查是否是自己创建的房间
    if (room.userA.userId === openid) {
      console.warn('🔗 [joinRoom] ❌ 不能加入自己的房间');
      return { code: -1, message: '不能加入自己创建的房间' };
    }

    // 检查是否已经在其他活跃房间中
    console.log('🔗 [joinRoom] 检查是否在其他活跃房间中');
    const existing = await db.collection('rooms')
      .where({
        $or: [
          { 'userA.userId': openid },
          { 'userB.userId': openid },
        ],
        status: 'active',
      })
      .get();

    if (existing.data.length > 0) {
      console.log('🔗 [joinRoom] 🔚 结束旧房间 roomId=' + existing.data[0]._id);
      await db.collection('rooms')
        .where({ _id: existing.data[0]._id })
        .update({
          data: { status: 'ended', updateTime: db.serverDate() },
        });
    }

    // B 加入房间，更新为 active
    // 用 where(status='waiting') 做条件更新，防止两人同时加入
    console.log('🔗 [joinRoom] 📝 更新房间状态 -> active');
    const updateRes = await db.collection('rooms')
      .where({
        _id: room._id,
        status: 'waiting',
      })
      .update({
        data: {
          userB: _.set({
            userId: openid,
            nickName: userB.nickName || '客户',
            avatarUrl: userB.avatarUrl || '',
          }),
          status: 'active',
          updateTime: db.serverDate(),
        },
      });

    if (updateRes.stats.updated === 0) {
      console.warn('🔗 [joinRoom] ❌ 房间已被其他人先加入 roomId=' + room._id);
      return { code: -1, message: '房间已被其他人加入' };
    }

    console.log('🔗 [joinRoom] ✅ 加入成功 roomId=' + room._id + ' partner=' + room.userA.nickName);
    return {
      code: 0,
      roomId: room._id,
      shareCode: room.shareCode,
      partnerInfo: {
        nickName: room.userA.nickName,
        avatarUrl: room.userA.avatarUrl,
        userId: room.userA.userId,
      },
    };
  } catch (err) {
    console.error('🔗 [joinRoom] ❌ 加入失败', err);
    return { code: -1, message: '加入失败: ' + (err.message || JSON.stringify(err)) };
  }
};
