/**
 * 定时清理过期位置数据云函数
 * 建议设置定时触发器，每 5 分钟执行一次
 * 清理超过 5 分钟的位置数据
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 保留数据的时间（毫秒）
const KEEP_DURATION = 5 * 60 * 1000; // 5 分钟

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

    // 检查并结束长期无人使用的 waiting 房间（超过 30 分钟）
    const roomExpireTime = new Date(Date.now() - 30 * 60 * 1000);
    const expiredRooms = await db.collection('rooms').where({
      status: 'waiting',
      createTime: _.lt(roomExpireTime),
    }).get();

    if (expiredRooms.data.length > 0) {
      for (const room of expiredRooms.data) {
        console.log('🧹 [cleanExpiredLocations] 关闭过期房间 roomId=' + room._id);
        await db.collection('rooms').doc(room._id).update({
          data: { status: 'ended' },
        });
      }
      console.log('🧹 [cleanExpiredLocations] 清理了 ' + expiredRooms.data.length + ' 个过期等待房间');
    } else {
      console.log('🧹 [cleanExpiredLocations] 无过期等待房间');
    }

    console.log('🧹 [cleanExpiredLocations] ✅ 清理完成');
    return {
      code: 0,
      cleaned: result.stats.removed,
      cleanedRooms: expiredRooms.data.length,
    };
  } catch (err) {
    console.error('🧹 [cleanExpiredLocations] ❌ 清理失败', err);
    return { code: -1, message: '清理失败' };
  }
};
