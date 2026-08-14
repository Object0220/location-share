/**
 * 客户地图页 - 只做一件事：
 * 加入房间后 → 直接启动位置共享（委托给 map-shared）
 */
const app = getApp();
const roomService = require('../../services/room');
const shared = require('../../services/map-shared');
const { ROLE_NAMES } = require('../../constants');
const DBG = '👤 [customer-map]';

Page({
  data: {
    ...shared.getDefaultData(),
    partnerInfo: { nickName: ROLE_NAMES.driver, avatarUrl: '' },
    settingDest: false,
    shareEnded: false,
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
    // 统一走共享初始化（roomId/userId/partnerInfo），不再手写副本
    if (!this._initRoom()) return;

    console.log(DBG + '🚀 启动位置共享');
    this._requestPermissions('customer');

    // 客户端"共享结束"语义：无论客户主动退出还是司机结束共享，
    // 都停留在当前页面展示"救援已结束"覆盖层（不自动返回），由"返回首页"离开
    const _self = this;
    this._onRoomEnded = function () {
      if (_self._ended) return;        // 防重入
      _self._ended = true;
      _self._cleanup();
      getApp().clearRoom();
      _self.setData({ shareEnded: true });
    };
  },

  onShow() {
    this._handleShow();
  },

  onHide() {
    this._handleHide();
  },

  onUnload() {
    this._leaveRoomOnUnload();
    this._handleUnload(DBG);
  },

  onBack() {
    // 已结束态：系统返回直接回首页，不再触发退出房间
    if (this.data.shareEnded) {
      this.onEndedGoHome();
      return;
    }
    // 用户通过系统返回/导航返回时，主动退出房间并展示结束态覆盖层
    this._exitRoom();
  },

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
          const sysInfo = wx.getDeviceInfo();
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
        // 目的地标记由房间 watch 回调（_watchRoomEnded）自动更新
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
        this._exitRoom();
      },
    });
  },

  /**
   * 退出房间并展示"救援已结束"覆盖层（停留本页）
   * onEndShare（带确认弹窗）与 onBack（系统/导航返回）共用
   * 不再自动返回上一页，由覆盖层"返回首页"离开
   * @returns {Promise<void>}
   */
  async _exitRoom() {
    // 标记"主动结束"：房间置为 ended 后，本页 watch 也会收到 ended 事件，
    // 此时应停留在当前页面显示结束态，而非走 navigateBack
    this._selfEnded = true;
    try {
      wx.showLoading({ title: '退出救援...' });
      await roomService.leaveRoom(this.roomId, 'customer');
      // 退出后立即停止定位上报与监听（房间数据保留本地，重新加入时再启动）
      this._cleanup();
      wx.hideLoading();
      this._onRoomEnded();   // 展示 shareEnded 覆盖层
    } catch (err) {
      wx.hideLoading();
      console.error(DBG + '退出失败', err);
      // 退出失败也停止定位，避免页面离开后仍在后台上报
      this._cleanup();
      this._onRoomEnded();
    }
  },

  /**
   * 结束态页面：返回首页
   */
  onEndedGoHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  },

  /**
   * 页面被卸载（系统返回键/手势返回/redirect）时静默退出房间
   * 页面即将销毁，不再做 UI 反馈与导航，仅发起离开请求并清理本地
   */
  _leaveRoomOnUnload() {
    if (this.data.shareEnded) return;   // 已结束态：房间已置为 ended，无需重复退出
    roomService.leaveRoom(this.roomId, 'customer').catch((err) => {
      console.error(DBG + '卸载时退出失败', err);
    });
    // 本地清理由 onUnload 的 _handleUnload 统一处理
  },
});
