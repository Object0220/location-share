/**
 * 定时清理过期位置数据云函数
 * 建议设置定时触发器，每 5 分钟执行一次
 * 1. 清理超过 5 分钟的位置数据
 * 2. 结束"司机已离线"的房间（司机超过 10 分钟未上报位置 → 判定司机已离开，结束房间）
 *
 * 房间生命周期由司机点击"结束共享"控制：
 * - 司机在线期间（持续上报位置），房间不会被自动结束
 * - 只有司机离线（杀进程/断网/异常退出）时，才由这里兜底结束，避免房间永久残留
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 保留数据的时间（毫秒）
const KEEP_DURATION = 5 * 60 * 1000; // 5 分钟

// 判定司机离线的时长（毫秒）：超过该时长无位置上报 → 结束房间
const DRIVER_OFFLINE_DURATION = 10 * 60 * 1000; // 10 分钟

exports.main = async (event, context) => {
  console.log('🧹 [cleanExpiredLocations] 开始定期清理');

  try {
    // 计算过期时间
    const expireTime = new Date(Date.now() - KEEP_DURATION);

    // 删除过期数据
    const result = await db.collection('locations').where({
      timestamp: _.lt(expireTime),
    }).remove();

    console.log('🧹 [cleanExpiredLocations] 清理了 ' + result.stats.removed + ' 条过期位置数据');

    // 查询所有未结束的房间（waiting / active）
    const rooms = await db.collection('rooms').where({
      status: _.in(['waiting', 'active']),
    }).get();

    // 结束"司机已离线"的房间
    const driverTimeout = new Date(Date.now() - DRIVER_OFFLINE_DURATION);
    let endedRooms = 0;

    for (const room of rooms.data) {
      const driverUserId = room.userA && room.userA.userId;
      if (!driverUserId) continue;

      const recent = await db.collection('locations').where({
        roomId: room._id,
        userId: driverUserId,
        timestamp: _.gt(driverTimeout),
      }).count();

      if (recent.total === 0) {
        console.log('🧹 [cleanExpiredLocations] 司机已离线，结束房间 roomId=' + room._id);
        await db.collection('rooms').doc(room._id).update({
          data: { status: 'ended' },
        });
        endedRooms++;
      }
    }

    console.log('🧹 [cleanExpiredLocations] ✅ 清理完成，结束离线房间 ' + endedRooms + ' 个');
    return {
      code: 0,
      cleaned: result.stats.removed,
      endedRooms,
    };
  } catch (err) {
    console.error('🧹 [cleanExpiredLocations] ❌ 清理失败', err);
    return { code: -1, message: '清理失败' };
  }
};
