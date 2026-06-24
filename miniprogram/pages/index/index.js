/**
 * 首页 - 创建/加入共享房间
 */
const app = getApp();
const roomService = require('../../services/room');
const locationService = require('../../services/location');

Page({
  data: {
    hasActiveRoom: false,
    partnerName: '',
    showShareCode: false,
    shareCode: '',
    shareCodeArray: [],
    toast: { show: false, message: '' },
    debugMsg: '',
    showRetry: false,
  },

  onLoad() {
    console.log('🏠 [首页] onLoad');
    this._checkActiveRoom();
    this.setData({ debugMsg: '正在初始化数据库...' });
    this._checkDbReady();
  },

  /** 检查数据库是否就绪 */
  _checkDbReady() {
    let attempts = 0;
    const check = () => {
      wx.cloud.callFunction({ name: 'initDatabase', timeout: 20000 })
        .then(res => {
          const r = res.result || {};
          if (r.code !== 0) {
            this.setData({ debugMsg: `❌ ${JSON.stringify(r)}`, showRetry: true });
            return;
          }
          const ok = (r.results || []).every(x => x.status === 'exists' || x.status === 'created');
          const msgs = (r.results || []).map(x => `${x.name}=${x.status}`).join(', ');
          this.setData({ debugMsg: ok ? `✅ 数据库就绪 (${msgs})` : `⚠️ ${msgs}`, showRetry: !ok });
        })
        .catch(err => {
          if (++attempts < 5) {
            this.setData({ debugMsg: `⏳ 重试 ${attempts}/5...` });
            setTimeout(check, 3000);
          } else {
            this.setData({ debugMsg: `❌ ${err.message || err}`, showRetry: true });
          }
        });
    };
    setTimeout(check, 2000);
  },

  onRetryInit() {
    this.setData({ debugMsg: '重试中...', showRetry: false });
    this._checkDbReady();
  },

  onShow() {
    console.log('🏠 [首页] onShow');
    if (this._roomWatcher) return;
    const room = app.globalData.currentRoom;
    if (room && room.status === 'waiting') {
      console.log('🏠 [首页] 有等待中的房间 roomId=' + room.roomId + ' shareCode=' + room.shareCode);
      this._watchRoomStatus(room.roomId);
    }else{
      this.setData({ showShareCode: false ,hasActiveRoom: false});
    }
  },

  onHide() { this._closeWatcher(); },
  onUnload() { this._closeWatcher(); },

  _closeWatcher() {
    // 清除重试定时器
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

  /** 创建共享房间 */
  async onCreateRoom() {
    console.log('🏠 [首页] 👆 点击「创建共享房间」');
    const perm = await locationService.checkPermission();
    if (!perm.granted) {
      const granted = await locationService.requestPermission();
      if (!granted) { console.warn('🏠 [首页] ❌ 定位权限被拒绝'); return; }
    }
    const userInfo = app.globalData.userInfo || { nickName: '共享用户', avatarUrl: '' };
    app.globalData.userInfo = userInfo;
    this._doCreateRoom(userInfo);
  },

  onJoinRoom() { wx.navigateTo({ url: '/pages/join/join' }); },
  enterMap() { wx.navigateTo({ url: '/pages/map/map' }); },

  /** 复制共享码 */
  onCopyCode() {
    wx.setClipboardData({
      data: this.data.shareCode,
      success: () => this._showToast('已复制共享码'),
    });
  },

  /** 取消/结束共享 */
  async onCancelRoom() {
    wx.showModal({
      title: '取消共享',
      content: '确定要取消当前房间吗？',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const room = app.globalData.currentRoom;
          if (room) await roomService.leaveRoom(room.roomId);
          this.setData({ showShareCode: false, hasActiveRoom: false, partnerName: '' });
          app.clearRoom();
        } catch (err) {
          console.error('取消共享失败', err);
        }
      },
    });
  },

  // ====== 内部方法 ======

  /** 检查是否有活跃的房间 */
  _checkActiveRoom() {
    const room = app.globalData.currentRoom;
    this.setData({
      hasActiveRoom: !!(room && room.status === 'active'),
      partnerName: (room && room.partnerInfo) ? room.partnerInfo.nickName : '对方',
    });
  },

  /** 执行创建房间 */
  async _doCreateRoom(userInfo) {
    console.log('🏠 [首页] ⏳ 正在创建房间...');
    wx.showLoading({ title: '创建房间...' });
    try {
      const result = await roomService.createRoom(userInfo);
      const shareCode = result.shareCode;
      console.log('🏠 [首页] ✅ 房间创建成功 shareCode=' + shareCode);
      this.setData({
        showShareCode: true,
        shareCode,
        shareCodeArray: shareCode.split(''),
      });
      wx.hideLoading();
      console.log('🏠 [首页] 开始监听房间状态 roomId=' + result.roomId);
      this._watchRoomStatus(result.roomId);
    } catch (err) {
      wx.hideLoading();
      console.error('🏠 [首页] ❌ 创建房间失败', err.message || err);
      this._showToast('创建失败，请重试');
    }
  },

  /** 监听房间状态变化（对方是否已加入） */
  _watchRoomStatus(roomId) {
    if (this._roomWatcher) {
      console.log('🏠 [首页] 📡 已有 watcher，跳过');
      return;
    }

    console.log('🏠 [首页] 📡 开始 watch 房间状态 roomId=' + roomId);
    const db = wx.cloud.database();

    this._roomWatcher = db.collection('rooms').doc(roomId).watch({

      onChange: (snapshot) => {
        // 收到有效推送 → 重置重试计数
        this._watchRetryCount = 0;

        const room = snapshot.docs && snapshot.docs[0];
        if (!room) return;

        console.log('🏠 [首页] 📡 watch 更新: 状态=' + room.status + ' userB=' + (room.userB ? room.userB.nickName : 'null'));

        if (room.status === 'active' && room.userB) {
          console.log('🏠 [首页] 🎉 对方已加入! nickName=' + room.userB.nickName);
          app.saveRoom({
            roomId: room._id, shareCode: room.shareCode,
            role: 'A', status: 'active', partnerInfo: room.userB,
          });
          this.setData({
            showShareCode: false, hasActiveRoom: true,
            partnerName: room.userB.nickName || '对方',
          });
          wx.showToast({ title: '对方已加入', icon: 'success' });
          setTimeout(() => wx.navigateTo({ url: '/pages/map/map' }), 1000);
        }

        if (room.status === 'ended') {
          console.log('🏠 [首页] 🔚 共享已结束');
          this._closeWatcher();
          app.clearRoom();
          this.setData({ showShareCode: false ,hasActiveRoom: false});
          wx.showToast({ title: '共享已结束', icon: 'none' });
          return;
        }
      },

      onError: (err) => {
        console.error('🏠 [首页] ❌ watch 房间状态失败', err);
        this._roomWatcher = null;
        this._scheduleWatchRetry(roomId);
      },
    });
  },

  /** 失败后指数退避重试（1s → 2s → 4s → ... → 最多 30s） */
  _scheduleWatchRetry(roomId) {
    this._watchRetryCount = (this._watchRetryCount || 0) + 1;
    const delay = Math.min(1000 * Math.pow(2, this._watchRetryCount - 1), 30000);

    console.log('🏠 [首页] ⏳ ' + delay + 'ms 后重试 watch (第' + this._watchRetryCount + '次)');

    this._watchRetryTimer = setTimeout(() => {
      this._watchRetryTimer = null;
      if (!this._roomWatcher && roomId) {
        this._watchRoomStatus(roomId);
      }
    }, delay);
  },

  /** Toast 提示 */
  _showToast(message) {
    this.setData({ toast: { show: true, message } });
    setTimeout(() => this.setData({ toast: { show: false, message: '' } }), 2000);
  },
});
