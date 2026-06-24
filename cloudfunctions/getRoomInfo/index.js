/**
 * 获取房间信息云函数
 * 包括配对方信息、配对方最新位置
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { roomId } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  console.log('📡 [getRoomInfo] 开始 roomId=' + roomId + ' userId=' + openid);

  if (!roomId) {
    console.warn('📡 [getRoomInfo] ❌ 参数不完整');
    return { code: -1, message: '参数不完整' };
  }

  try {
    // 获取房间数据
    const roomRes = await db.collection('rooms').doc(roomId).get();
    const room = roomRes.data;

    if (!room) {
      console.warn('📡 [getRoomInfo] ❌ 房间不存在 roomId=' + roomId);
      return { code: -1, message: '房间不存在' };
    }

    console.log('📡 [getRoomInfo] 房间状态=' + room.status);

    // 判断当前用户是 A 还是 B，获取对方信息
    let partnerInfo = null;
    let myRole = '';
    if (room.userA && room.userA.userId === openid) {
      partnerInfo = room.userB;
      myRole = 'A';
    } else if (room.userB && room.userB.userId === openid) {
      partnerInfo = room.userA;
      myRole = 'B';
    } else {
      console.warn('📡 [getRoomInfo] ❌ 非房间成员 openid=' + openid);
      return { code: -1, message: '您不是该房间的成员' };
    }

    console.log('📡 [getRoomInfo] 角色=' + myRole + ' 有对方=' + !!partnerInfo);

    // 获取对方最新位置（文档 ID = roomId_userId，一对一覆盖写入）
    let partnerLocation = null;
    if (partnerInfo) {
      const partnerDocId = roomId + '_' + partnerInfo.userId;
      const locRes = await db.collection('locations').doc(partnerDocId).get();

      if (locRes.data) {
        partnerLocation = locRes.data;
        console.log('📡 [getRoomInfo] 对方位置 lat=' + partnerLocation.latitude + ' lng=' + partnerLocation.longitude);
      } else {
        console.log('📡 [getRoomInfo] 对方暂无位置数据');
      }
    }

    // 获取自己的最新位置
    let myLocation = null;
    const myDocId = roomId + '_' + openid;
    const myLocRes = await db.collection('locations').doc(myDocId).get();

    if (myLocRes.data) {
      myLocation = myLocRes.data;
      console.log('📡 [getRoomInfo] 我的位置 lat=' + myLocation.latitude + ' lng=' + myLocation.longitude);
    }

    console.log('📡 [getRoomInfo] ✅ 返回房间信息');
    return {
      code: 0,
      roomData: {
        roomId: room._id,
        shareCode: room.shareCode,
        status: room.status,
        createTime: room.createTime,
      },
      partnerInfo,
      partnerLocation,
      myLocation,
    };
  } catch (err) {
    console.error('📡 [getRoomInfo] ❌ 获取失败', err);
    return { code: -1, message: '获取失败' };
  }
};
