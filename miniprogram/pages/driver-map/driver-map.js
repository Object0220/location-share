/**
 * 司机地图页 - 只做两件事：
 * 1. 等待客户加入（展示共享码 + 遮罩）
 * 2. 客户加入后 → 启动位置共享（委托给 map-shared）
 */
const app = getApp();
const locationService = require('../../services/location');
const roomService = require('../../services/room');
const shared = require('../../services/map-shared');
const DBG = '🚗 [driver-map]';

Page({
  data: {
    ...shared.getDefaultData(),
    waitingForPartner: false,
    shareCode: '',
    partnerInfo: { nickName: '客户', avatarUrl: '' },
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
    const room = app.globalData.currentRoom;
    if (!room) return;
    if (room.status === 'waiting') return;
    if (room.status !== 'active') { this._showLocationError('共享已结束'); return; }
    if (this.roomId && this.userId) locationService.onForeground(this.roomId, this.userId);
    this._startUiTimer();
  },

  onHide() {
    if (this.roomId && this.userId) locationService.onBackground(this.roomId, this.userId);
    this._stopUiTimer();
  },

  onUnload() {
    console.log(DBG + 'onUnload');
    locationService.stopUpdating();
    this._unwatch();
    this._stopStaleCheck();
    this._stopUiTimer();
    this._stopPolling();
    this._clearRetryTimers();
    this._resetState();
  },

  onBack() { wx.navigateBack(); },

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
          await roomService.leaveRoom(this.roomId);
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
          fail: () => {},
        });
      }
    });

    db.collection('rooms').doc(this.roomId).watch({
      onChange: (snapshot) => {
        if (snapshot.type === 'init') return;
        const room = snapshot.docs && snapshot.docs[0];
        if (!room) return;
        if (room.status === 'active' && room.userB) {
          console.log(DBG + '🎉 客户已加入! nickName=' + (room.userB.nickName || '客户'));
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
    const poll = () => {
      this._pollTimer = setTimeout(async () => {
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
        } catch (_) {}
        poll();
      }, 5000);
    };
    poll();
  },

  _onPartnerJoined(partnerInfo, roomData) {
    if (this._joining) return;
    this._joining = true;
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }

    app.saveRoom({
      roomId: roomData._id || this.roomId,
      shareCode: roomData.shareCode,
      role: 'A', status: 'active', partnerInfo,
    });

    this.setData({
      waitingForPartner: false,
      partnerInfo: { nickName: partnerInfo.nickName || '客户', avatarUrl: partnerInfo.avatarUrl || '' },
    });

    console.log(DBG + '🚀 客户已加入，启动位置共享');
    this._requestPermissions('driver');
  },
});
