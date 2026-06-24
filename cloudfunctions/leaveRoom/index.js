/**
 * 离开/结束共享房间云函数
 * 任一方点击结束共享后调用
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { roomId, userId } = event;

  console.log('🚪 [leaveRoom] 开始 roomId=' + roomId + ' userId=' + userId);

  if (!roomId) {
    console.warn('🚪 [leaveRoom] ❌ 参数不完整');
    return { code: -1, message: '参数不完整' };
  }

  try {
    // 获取房间信息
    const roomRes = await db.collection('rooms').doc(roomId).get();
    const room = roomRes.data;

    if (!room) {
      console.warn('🚪 [leaveRoom] ❌ 房间不存在 roomId=' + roomId);
      return { code: -1, message: '房间不存在' };
    }

    console.log('🚪 [leaveRoom] 房间当前状态=' + room.status);

    // 标记房间为已结束
    await db.collection('rooms').doc(roomId).update({
      data: {
        status: 'ended',
        updateTime: db.serverDate(),
      },
    });
    console.log('🚪 [leaveRoom] ✅ 房间状态已更新为 ended');

    // 清理该房间的位置数据
    try {
      const delRes = await db.collection('locations').where({
        roomId,
      }).remove();
      console.log('🚪 [leaveRoom] 🧹 已清理位置数据, 删除=' + JSON.stringify(delRes.stats));
    } catch (e) {
      console.warn('🚪 [leaveRoom] 清理位置数据失败', e);
    }

    console.log('🚪 [leaveRoom] ✅ 结束共享成功');
    return { code: 0, message: '已结束共享' };
  } catch (err) {
    console.error('🚪 [leaveRoom] ❌ 离开房间失败', err);
    return { code: -1, message: '操作失败' };
  }
};
