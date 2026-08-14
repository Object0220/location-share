/**
 * 设置救援目的地云函数
 * rooms 文档内嵌 destination 字段
 * 客户调用 → 司机 watch 实时可见
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { roomId, destination } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  console.log('📍 [setDestination] 开始 roomId=' + roomId);

  if (!roomId || !destination || !destination.latitude || !destination.longitude) {
    return { code: -1, message: '参数不完整' };
  }

  try {
    const roomRes = await db.collection('rooms').doc(roomId).get();
    const room = roomRes.data;
    if (!room) return { code: -1, message: '房间不存在' };
    if (!room.userB || room.userB.userId !== openid) {
      return { code: -1, message: '只有客户可以设置目的地' };
    }

    await db.collection('rooms').doc(roomId).update({
      data: { destination, updateTime: db.serverDate() },
    });

    console.log('📍 [setDestination] ✅', JSON.stringify(destination));
    return { code: 0, message: '地址已设置' };
  } catch (err) {
    console.error('📍 [setDestination] ❌', err);
    return { code: -1, message: '设置失败' };
  }
};
