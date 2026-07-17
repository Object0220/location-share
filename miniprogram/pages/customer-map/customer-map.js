/**
 * 客户地图页 - 只做一件事：
 * 加入房间后 → 直接启动位置共享（委托给 map-shared）
 */
const app = getApp();
const locationService = require('../../services/location');
const roomService = require('../../services/room');
const shared = require('../../services/map-shared');
const DBG = '👤 [customer-map]';

Page({
  data: {
    ...shared.getDefaultData(),
    partnerInfo: { nickName: '拖车司机', avatarUrl: '' },
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
    if (room.status !== 'active') {
      console.warn(DBG + '⛔ 非活跃状态');
      app.clearRoom();
      wx.navigateBack();
      return;
    }

    this._resetState();
    this.roomId = room.roomId;
    this.userId = app.globalData.openid;
    if (room.partnerInfo) {
      this.setData({
        partnerInfo: {
          nickName: room.partnerInfo.nickName || '拖车司机',
          avatarUrl: room.partnerInfo.avatarUrl || '',
        },
      });
    }

    console.log(DBG + '🚀 启动位置共享');
    this._requestPermissions('customer');
  },

  onShow() {
    const room = app.globalData.currentRoom;
    if (!room || room.status !== 'active') {
      if (room && room.status === 'ended') this._showLocationError('共享已结束');
      return;
    }
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

    onEndShare() {
    wx.showModal({
      title: '退出救援',
      content: '退出后仍可通过共享码重新加入房间。',
      confirmColor: '#f5a623',
      cancelText: '取消',
      confirmText: '退出房间',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          wx.showLoading({ title: '退出救援...' });
          await roomService.leaveRoom(this.roomId, 'customer');
          wx.hideLoading();
          const pages = getCurrentPages();
          wx.navigateBack({ delta: Math.max(1, Math.min(pages.length, 2)) });
        } catch (err) {
          wx.hideLoading();
          console.error(DBG + '退出失败', err);
          const pages = getCurrentPages();
          wx.navigateBack({ delta: Math.max(1, Math.min(pages.length, 2)) });
        }
      },
    });
  },
});
