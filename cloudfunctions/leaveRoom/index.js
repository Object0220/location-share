/**
 * 离开/结束共享房间云函数
 *
 * role 参数决定行为：
 *   'customer' → 退出房间（清 userB, status=waiting，只删自己的位置，房间保留）
 *   'driver'   → 永久关闭（status=ended, 删所有位置）
 *   不传/其他  → 兼容旧调用，视为 driver
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { roomId, role } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  console.log('🚪 [leaveRoom] 开始 roomId=' + roomId + ' role=' + (role || 'driver') + ' userId=' + openid);

  if (!roomId) {
    console.warn('🚪 [leaveRoom] ❌ 参数不完整');
    return { code: -1, message: '参数不完整' };
  }

  try {
    const roomRes = await db.collection('rooms').doc(roomId).get();
    const room = roomRes.data;
    if (!room) return { code: -1, message: '房间不存在' };

    const isA = room.userA.userId === openid;
    const isB = room.userB && room.userB.userId === openid;
    if (!isA && !isB) return { code: -1, message: '您不是该房间的成员' };

    // ====== 客户退出：清 userB，房间保留 ======
    if (role === 'customer') {
      if (!isB) return { code: -1, message: '只有客户可以退出' };
      console.log('🚪 [leaveRoom] 👤 客户退出 roomId=' + roomId);

      await db.collection('rooms').doc(roomId).update({
        data: { userB: {}, status: 'waiting', destination: _.remove(), updateTime: db.serverDate() },
      });

      try {
        await db.collection('locations').where({ roomId, userId: openid }).remove();
      } catch (e) { console.warn('🚪 [leaveRoom] 清理位置失败', e); }

      return { code: 0, message: '已退出房间' };
    }

    // ====== 司机关闭：永久结束 ======
    if (!isA) return { code: -1, message: '只有司机可以关闭房间' };
    if (room.status === 'ended') return { code: 0, message: '房间已结束' };

    console.log('🚪 [leaveRoom] 🔒 司机关闭 roomId=' + roomId);
    await db.collection('rooms').doc(roomId).update({
      data: { status: 'ended', updateTime: db.serverDate() },
    });

    try {
      await db.collection('locations').where({ roomId }).remove();
    } catch (e) { console.warn('🚪 [leaveRoom] 清理位置失败', e); }

    return { code: 0, message: '已结束共享' };
  } catch (err) {
    console.error('🚪 [leaveRoom] ❌ 操作失败', err);
    return { code: -1, message: '操作失败' };
  }
};
