/**
 * 等待页 - 创建房间、显示共享码、等待对方加入
 * 独立页面，首页点击「创建共享房间」直接跳转至此页
 */
const app = getApp();
const roomService = require('../../services/room');
const locationService = require('../../services/location');

Page({
  data: {
    shareCode: '',
    shareCodeArray: [],
  },

  roomId: '',
  _roomWatcher: null,
  _watchRetryTimer: null,
  _watchRetryCount: 0,

  async onLoad() {
    console.log('⏳ [waiting] onLoad — 开始创建房间');

    // 1. 请求定位权限（需要定位才能创建房间共享位置）
    const perm = await locationService.checkPermission();
    if (!perm.granted) {
      const granted = await locationService.requestPermission();
      if (!granted) {
        console.warn('⏳ [waiting] ❌ 定位权限被拒绝');
        wx.showToast({ title: '需要定位权限', icon: 'none' });
        setTimeout(() => wx.redirectTo({ url: '/pages/index/index' }), 1500);
        return;
      }
    }

    // 2. 获取用户信息
    const userInfo = app.globalData.userInfo || { nickName: '拖车司机', avatarUrl: '' };
    app.globalData.userInfo = userInfo;

    // 3. 调用云函数创建房间
    console.log('⏳ [waiting] ⏳ 正在创建房间...');
    wx.showLoading({ title: '创建房间...' });
    try {
      const result = await roomService.createRoom(userInfo);
      wx.hideLoading();

      console.log('⏳ [waiting] ✅ 房间创建成功 shareCode=' + result.shareCode + ' roomId=' + result.roomId);

      this.roomId = result.roomId;
      this.setData({
        shareCode: result.shareCode,
        shareCodeArray: result.shareCode.split(''),
      });

      // 4. 开始监听房间状态（等待对方加入）
      this._watchRoomStatus(result.roomId);
    } catch (err) {
      wx.hideLoading();
      console.error('⏳ [waiting] ❌ 创建房间失败', err.message || err);
      wx.showToast({ title: '创建失败，请重试', icon: 'none' });
      setTimeout(() => wx.redirectTo({ url: '/pages/index/index' }), 1500);
    }
  },

  onUnload() {
    console.log('⏳ [waiting] onUnload');
    this._closeWatcher();
  },

  // ====== 事件 ======

  onBack() {
    // 返回首页视为放弃，清理房间状态
    this._closeWatcher();
    app.clearRoom();
    wx.navigateBack();
  },

  /** 复制共享码 */
  onCopyCode() {
    wx.setClipboardData({
      data: this.data.shareCode,
      success: () => wx.showToast({ title: '已复制共享码', icon: 'none' }),
    });
  },

  /** 取消共享 */
  async onCancelRoom() {
    wx.showModal({
      title: '取消共享',
      content: '确定要取消当前房间吗？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const room = app.globalData.currentRoom;
          if (room) await roomService.leaveRoom(room.roomId);
          app.clearRoom();
          wx.navigateBack();
        } catch (err) {
          console.error('取消共享失败', err);
          app.clearRoom();
          wx.navigateBack();
        }
      },
    });
  },

  // ====== 监听房间状态 ======

  /** 监听房间，检测对方加入 */
  _watchRoomStatus(roomId) {
    if (!roomId) return;
    console.log('⏳ [waiting] 📡 开始监听房间 roomId=' + roomId);
    const db = wx.cloud.database();

    this._roomWatcher = db.collection('rooms').doc(roomId).watch({
      onChange: (snapshot) => {
        this._watchRetryCount = 0;
        const room = snapshot.docs && snapshot.docs[0];
        if (!room) return;

        console.log('⏳ [waiting] 📡 watch 更新: 状态=' + room.status + ' userB=' + (room.userB ? room.userB.nickName : 'null'));

        if (room.status === 'active' && room.userB) {
          console.log('⏳ [waiting] 🎉 对方已加入! nickName=' + room.userB.nickName);
          this._closeWatcher();
          app.saveRoom({
            roomId: room._id, shareCode: room.shareCode,
            role: 'A', status: 'active', partnerInfo: room.userB,
          });
          wx.showToast({ title: '对方已加入', icon: 'success' });
          setTimeout(() => wx.redirectTo({ url: '/pages/map/map' }), 1000);
        }

        if (room.status === 'ended') {
          console.log('⏳ [waiting] 🔚 共享已结束');
          this._closeWatcher();
          app.clearRoom();
          wx.showToast({ title: '共享已结束', icon: 'none' });
          setTimeout(() => wx.redirectTo({ url: '/pages/index/index' }), 1500);
        }
      },
      onError: (err) => {
        console.error('⏳ [waiting] ❌ watch 失败', err);
        this._roomWatcher = null;
        this._scheduleWatchRetry(roomId);
      },
    });
  },

  /** 失败重试（指数退避） */
  _scheduleWatchRetry(roomId) {
    this._watchRetryCount = (this._watchRetryCount || 0) + 1;
    const delay = Math.min(1000 * Math.pow(2, this._watchRetryCount - 1), 30000);
    console.log('⏳ [waiting] ⏳ ' + delay + 'ms 后重试 (第' + this._watchRetryCount + '次)');
    this._watchRetryTimer = setTimeout(() => {
      this._watchRetryTimer = null;
      if (!this._roomWatcher && roomId) {
        this._watchRoomStatus(roomId);
      }
    }, delay);
  },

  _closeWatcher() {
    if (this._watchRetryTimer) {
      clearTimeout(this._watchRetryTimer);
      this._watchRetryTimer = null;
    }
    this._watchRetryCount = 0;
    if (this._roomWatcher) {
      this._roomWatcher.close();
      this._roomWatcher = null;
    }
  },
});
