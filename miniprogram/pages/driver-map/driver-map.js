/**
 * 司机地图页 - 只做两件事：
 * 1. 等待客户加入（展示共享码 + 遮罩）
 * 2. 客户加入后 → 启动位置共享（委托给 map-shared）
 */
const app = getApp();
const locationService = require('../../services/location');
const roomService = require('../../services/room');
const shared = require('../../services/map-shared');
const { ROLE_NAMES } = require('../../constants');
const DBG = '🚗 [driver-map]';

Page({
  data: {
    ...shared.getDefaultData(),
    waitingForPartner: false,
    shareCode: '',
    partnerInfo: { nickName: ROLE_NAMES.customer, avatarUrl: '' },
  },
  ...shared.getDefaultFields(),

  onLoad() {
    shared.mixin(this);
    const room = app.globalData.currentRoom;
    console.log(DBG + 'onLoad roomId=' + (room ? room.roomId.slice(0, 20) : '无'));

    if (!room || !room.roomId) {
      wx.showToast({ title: '配对信息丢失', icon: 'none' });
      setTimeout(() => wx.redirectTo({ url: '/pages/index/index' }), 1500);
      return;
    }
    if (room.status !== 'waiting') {
      console.warn(DBG + '⛔ 非等待状态');
      app.clearRoom();
      wx.navigateBack();
      return;
    }

    this._resetState();
    this.roomId = room.roomId;
    this.userId = app.globalData.openid;
    this.setData({ waitingForPartner: true, shareCode: room.shareCode || '' });
    console.log(DBG + '⏳ 等待客户加入 shareCode=' + room.shareCode);

    // 监听客户加入 + 共享结束
    this._watchForPartnerJoin();
  },

  onShow() {
    this._handleShow();
  },

  onHide() {
    this._handleHide();
  },

  onUnload() {
    // 先关闭司机页特有的"等待客户加入"监听，再走统一清理
    this._closeJoinWatcher();
    this._handleUnload(DBG);
  },

  onBack() { this._handleBack(); },

  onCopyCode() {
    wx.setClipboardData({
      data: this.data.shareCode,
      success: () => wx.showToast({ title: '已复制共享码', icon: 'none' }),
    });
  },

  onEndShare() {
    wx.showModal({
      title: '结束救援',
      content: '确定要结束救援吗？客户将不再看到你的位置。',
      confirmColor: '#fa5151',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          wx.showLoading({ title: '结束救援...' });
          await roomService.leaveRoom(this.roomId, 'driver');
          wx.hideLoading();
          const pages = getCurrentPages();
          wx.navigateBack({ delta: Math.max(1, Math.min(pages.length, 2)) });
        } catch (err) {
          wx.hideLoading();
          console.error(DBG + '结束失败', err);
          app.clearRoom();
          const pages = getCurrentPages();
          wx.navigateBack({ delta: Math.max(1, Math.min(pages.length, 2)) });
        }
      },
    });
  },

  // ====== 司机独有逻辑：等待客户加入 ======

  /**
   * 关闭"等待客户加入"的 watch 与轮询（页面卸载时调用）
   * 防止页面退出后 watcher 与定时器继续执行
   */
  _closeJoinWatcher() {
    if (this._joinWatcher) {
      try { this._joinWatcher.close(); } catch (e) {}
      this._joinWatcher = null;
    }
    this._joinPollStopped = true;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this._joinPollTimer = false;
  },

  _watchForPartnerJoin() {
    if (!this.roomId) return;
    const db = wx.cloud.database();
    const that = this;

    // 先预申请定位权限
    locationService.requestPermission().then(granted => {
      if (granted) {
        wx.getLocation({
          type: 'gcj02',
          success: (res) => {
            const loc = { latitude: res.latitude, longitude: res.longitude };
            console.log(DBG + '🚩 预定位 lat=' + loc.latitude.toFixed(5) + ' lng=' + loc.longitude.toFixed(5));
            that.setData({ myLocation: loc, isFirstLoad: false });
          },
          fail: (err) => {
            console.warn(DBG + '⚠️ 预定位失败', err.errMsg || err.message || err);
          },
        });
      }
    });

    this._joinWatcher = db.collection('rooms').doc(this.roomId).watch({
      onChange: (snapshot) => {
        if (snapshot.type === 'init') return;
        const room = snapshot.docs && snapshot.docs[0];
        if (!room) return;
        if (room.status === 'active' && room.userB) {
          console.log(DBG + '🎉 客户已加入! nickName=' + (room.userB.nickName || ROLE_NAMES.customer));
          that._onPartnerJoined(room.userB, room);
        }
        if (room.status === 'ended') {
          that._onRoomEnded();
        }
      },
      onError: (err) => {
        console.error(DBG + '❌ watch 失败', err);
        that._pollForPartnerJoin();
      },
    });

    // polling 备用
    this._pollForPartnerJoin();
  },

  _pollForPartnerJoin() {
    if (this._joinPollTimer) return;
    this._joinPollTimer = true;
    this._joinPollStopped = false;
    const poll = () => {
      if (this._joinPollStopped) return;
      this._pollTimer = setTimeout(async () => {
        if (this._joinPollStopped) return;
        try {
          const db = wx.cloud.database();
          const room = (await db.collection('rooms').doc(this.roomId).get()).data;
          if (!room) return;
          if (room.status === 'active' && room.userB && this.data.waitingForPartner) {
            console.log(DBG + '🎉 (轮询) 客户已加入');
            this._onPartnerJoined(room.userB, room);
            return;
          }
          if (room.status === 'ended') { this._onRoomEnded(); return; }
        } catch (err) {
          console.warn(DBG + '⚠️ 查询房间状态失败', err.errMsg || err.message || err);
        }
        poll();
      }, 5000);
    };
    poll();
  },

  _onPartnerJoined(partnerInfo, roomData) {
    if (this._joining) return;
    this._joining = true;
    this._joinPollStopped = true;
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }

    app.saveRoom({
      roomId: roomData._id || this.roomId,
      shareCode: roomData.shareCode,
      role: 'A', status: 'active', partnerInfo,
    });

    this.setData({
      waitingForPartner: false,
      partnerInfo: { nickName: partnerInfo.nickName || ROLE_NAMES.customer, avatarUrl: partnerInfo.avatarUrl || '' },
    });

    console.log(DBG + '🚀 客户已加入，启动位置共享');
    this._requestPermissions('driver');
  },
});
