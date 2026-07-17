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
    settingDest: false,
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

  // ====== 救援目的地 ======

  /** 打开微信原生地址选择器 */
  onSetDestination() {
    // 确保定位权限已授权
    wx.getSetting({
      success: (setting) => {
        if (!setting.authSetting['scope.userLocation']) {
          wx.showModal({ title: '需要位置权限', content: '请在设置中开启位置权限以使用地址选择功能', showCancel: false });
          return;
        }
        this._openLocationPicker();
      },
      fail: () => this._openLocationPicker(),
    });
  },

  _openLocationPicker() {
    wx.chooseLocation({
      success: (res) => {
        if (!res.latitude || !res.longitude) return;
        console.log(DBG + '📍 选择了地址:', res.name, res.address);
        this._saveDestination({
          name: res.name || '',
          address: res.address || '',
          latitude: res.latitude,
          longitude: res.longitude,
        });
      },
      fail: (err) => {
        if (err.errMsg && err.errMsg.indexOf('cancel') > -1) return;
        console.error(DBG + '❌ chooseLocation 失败', err);
        // 开发者工具不支持 chooseLocation
        try {
          const sysInfo = wx.getSystemInfoSync();
          if (sysInfo.platform === 'devtools') {
            wx.showModal({
              title: '提示',
              content: '地址选择器仅在真机上可用，当前为开发者工具。',
              showCancel: false,
            });
            return;
          }
        } catch (_) {}
        wx.showToast({ title: '选择地址失败', icon: 'none' });
      },
    });
  },

  /** 保存目的地到云端 */
  async _saveDestination(dest) {
    this.setData({ settingDest: true });
    try {
      const result = await roomService.setDestination(this.roomId, dest);
      if (result.code === 0) {
        this.setData({ destination: dest });
        // 立即更新地图标记
        this._updateDestinationMarker();
        wx.showToast({ title: '目的地已设置', icon: 'success' });
        console.log(DBG + '📍 目的地坐标:', dest.latitude, dest.longitude);
      } else {
        wx.showToast({ title: result.message || '设置失败', icon: 'none' });
      }
    } catch (err) {
      console.error(DBG + '❌ 设置失败', err);
      wx.showToast({ title: '设置失败', icon: 'none' });
    } finally {
      this.setData({ settingDest: false });
    }
  },

  /** 客户退出房间（房间保留，下次可重新加入） */
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
