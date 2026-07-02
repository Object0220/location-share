/**
 * 房间/配对服务模块
 * 管理共享码生成、配对、房间状态、实时数据订阅
 */

// 不能用顶层 getApp()，App() 初始化时模块已加载但未完成
// 改为在函数内部懒加载
function getAppInstance() {
  return getApp();
}

module.exports = {
  /**
   * 创建共享房间（配对发起方）
   * @param {object} userInfo - { nickName, avatarUrl }
   * @param {string} [phoneLast4] - 手机号后4位，用作共享码
   * @returns {Promise<{roomId, shareCode, qrcodeUrl}>}
   */
  async createRoom(userInfo, phoneLast4) {
    const app = getAppInstance();
    // 等待 openid 就绪（首次打开可能还在获取中）
    const openid = await app.waitForOpenId();
    if (!openid) {
      console.error('🏠 [createRoom] ❌ 未获取到用户标识');
      return Promise.reject(new Error('未获取到用户标识'));
    }

    const shareCode = phoneLast4 || this._generateShareCode();
    const roomId = 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

    console.log('🏠 [createRoom] 🚀 调用云函数 roomId=' + roomId + ' shareCode=' + shareCode + ' user=' + (userInfo.nickName || '匿名'));

    return wx.cloud.callFunction({
      name: 'createRoom',
      data: {
        roomId,
        shareCode,
        userA: {
          userId: openid,
          nickName: userInfo.nickName || '拖车司机',
          avatarUrl: userInfo.avatarUrl || '',
        },
      },
    }).then(res => {
      const result = res.result;
      console.log('🏠 [createRoom] 📥 云函数返回: code=' + result.code + ' roomId=' + result.roomId + ' shareCode=' + result.shareCode);

      // 检查云函数返回码
      if (result.code && result.code !== 0) {
        console.error('🏠 [createRoom] ❌ 云函数返回错误: ' + result.message);
        throw new Error(result.message || '创建房间失败');
      }
      // 保存房间信息到本地
      app.saveRoom({
        roomId: result.roomId,
        shareCode: result.shareCode,
        role: 'A',
        status: 'waiting',
        partnerInfo: null,
      });
      console.log('🏠 [createRoom] ✅ 创建成功，已保存到本地');
      return result;
    });
  },

  /**
   * 通过司机手机号后4位加入房间
   * @param {string} shareCode - 手机号后4位
   * @param {object} userInfo - { nickName, avatarUrl }
   * @returns {Promise<{roomId, roomData}>}
   */
  async joinRoom(shareCode, userInfo) {
    const app = getAppInstance();
    // 等待 openid 就绪
    const openid = await app.waitForOpenId();
    if (!openid) {
      console.error('🔗 [joinRoom] ❌ 未获取到用户标识');
      return Promise.reject(new Error('未获取到用户标识'));
    }

    console.log('🔗 [joinRoom] 🚀 调用云函数 shareCode=' + shareCode + ' user=' + (userInfo.nickName || '匿名'));

    return wx.cloud.callFunction({
      name: 'joinRoom',
      data: {
        shareCode: shareCode.toUpperCase(),
        userB: {
          userId: openid,
          nickName: userInfo.nickName || '客户',
          avatarUrl: userInfo.avatarUrl || '',
        },
      },
    }).then(res => {
      const result = res.result;
      console.log('🔗 [joinRoom] 📥 云函数返回: code=' + result.code + ' roomId=' + result.roomId + ' partner=' + (result.partnerInfo ? result.partnerInfo.nickName : '无'));

      if (result.code && result.code !== 0) {
        console.error('🔗 [joinRoom] ❌ 云函数返回错误: ' + result.message);
        throw new Error(result.message || '加入房间失败');
      }
      // 保存房间信息到本地
      app.saveRoom({
        roomId: result.roomId,
        shareCode: result.shareCode,
        role: 'B',
        status: 'active',
        partnerInfo: result.partnerInfo,
      });
      console.log('🔗 [joinRoom] ✅ 加入成功，已保存到本地');
      return result;
    });
  },

  /**
   * 获取房间信息和客户位置
   * @param {string} roomId
   * @returns {Promise<{roomData, partnerLocation}>}
   */
  getRoomInfo(roomId) {
    console.log('📡 [getRoomInfo] 🚀 调用云函数 roomId=' + roomId);
    return wx.cloud.callFunction({
      name: 'getRoomInfo',
      data: { roomId },
    }).then(res => {
      const r = res.result;
      console.log('📡 [getRoomInfo] 📥 返回 code=' + r.code + ' 状态=' + (r.roomData ? r.roomData.status : '无') + ' 对方位置=' + (r.partnerLocation ? '有' : '无'));
      return r;
    });
  },

  /**
   * 结束共享 / 离开房间
   * @param {string} roomId
   * @returns {Promise}
   */
  leaveRoom(roomId) {
    const app = getAppInstance();
    const openid = app.globalData.openid;
    console.log('🚪 [leaveRoom] 🚀 调用云函数 roomId=' + roomId + ' userId=' + (openid ? openid.slice(0, 10) : '无'));
    return wx.cloud.callFunction({
      name: 'leaveRoom',
      data: { roomId, userId: openid },
    }).then(res => {
      console.log('🚪 [leaveRoom] 📥 返回: ' + JSON.stringify(res.result));
      app.clearRoom();
      console.log('🚪 [leaveRoom] ✅ 已清理本地房间状态');
      return res.result;
    });
  },

  /**
   * 订阅客户位置变化（云开发实时数据推送）
   * @param {string} roomId
   * @param {string} myUserId - 自己的 userId
   * @param {function} onLocationUpdate - 客户位置更新回调
   * @returns {function} unwatch 函数
   */
  watchPartnerLocation(roomId, myUserId, onLocationUpdate) {
    const db = wx.cloud.database();
    const watcher = db.collection('locations')
      .where({
        roomId,
        userId: db.command.neq(myUserId),
      })
      .watch({
        onChange: (snapshot) => {
          if (snapshot.type === 'init') {
            // 初始数据
            if (snapshot.docChanges && snapshot.docChanges.length > 0) {
              const partnerLoc = snapshot.docChanges[0].doc;
              if (onLocationUpdate) onLocationUpdate(partnerLoc);
            }
          } else {
            // 实时变更
            snapshot.docChanges.forEach(change => {
              if (change.queueType === 'update' || change.queueType === 'init') {
                if (onLocationUpdate) onLocationUpdate(change.doc);
              }
            });
          }
        },
        onError: (err) => {
          console.error('位置订阅失败', err);
        },
      });

    return () => {
      try { watcher.close(); } catch (e) {}
    };
  },

  /**
   * 获取配对信息（客户昵称、头像）
   * 统一走云函数，与 getRoomInfo 保持一致
   * @param {string} roomId
   * @returns {Promise<object|null>}
   */
  async getPartnerInfo(roomId) {
    const result = await this.getRoomInfo(roomId);
    if (result.code !== 0 || !result.roomData) return null;
    return result.partnerInfo || null;
  },

  // ====== 辅助方法 ======

  /**
   * 生成 4 位数字共享码
   */
  _generateShareCode() {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += Math.floor(Math.random() * 10).toString();
    }
    return code;
  },
};
