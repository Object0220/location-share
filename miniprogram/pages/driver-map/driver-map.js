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
    shareEnded: false,
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
    this._selfEnded = false;
    this.roomId = room.roomId;
    this.userId = app.globalData.openid;
    this.setData({ waitingForPartner: true, shareCode: room.shareCode || '', shareEnded: false });
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

  onBack() {
    // 结束态下不关闭页面，统一回到首页
    if (this.data.shareEnded) {
      this.onEndedGoHome();
      return;
    }
    this._handleBack();
  },

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
        // 标记"司机主动结束"：房间置为 ended 后，本页 watch 也会收到 ended 事件，
        // 此时不能走 _onRoomEnded 的"返回上一页"分支，而应停留在当前页面显示结束态
        this._selfEnded = true;
        try {
          wx.showLoading({ title: '结束救援...' });
          await roomService.leaveRoom(this.roomId, 'driver');
          wx.hideLoading();
          // 主动结束：关闭"等待客户加入"监听，清理资源，但停留在当前页面
          this._closeJoinWatcher();
          this._onRoomEnded();
        } catch (err) {
          wx.hideLoading();
          console.error(DBG + '结束失败', err);
          this._selfEnded = false;
          wx.showToast({ title: '结束失败，请重试', icon: 'none' });
        }
      },
    });
  },

  /**
   * 结束态页面：返回首页
   */
  onEndedGoHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  },

  // ====== 司机独有逻辑：等待客户加入 ======

  /**
   * 关闭"等待客户加入"的 watch（页面卸载/结束共享时调用）
   * 防止页面退出后 watcher 继续执行
   */
  _closeJoinWatcher() {
    if (this._joinWatcher) {
      try { this._joinWatcher.close(); } catch (e) {}
      this._joinWatcher = null;
    }
  },

  _watchForPartnerJoin() {
    if (!this.roomId) return;
    const db = wx.cloud.database();
    const that = this;

    // 创建房间即开始持续上报位置（等待客户期间也上报，保证房间生命周期由司机控制）
    locationService.requestPermission().then(granted => {
      if (granted) {
        that._startLocationServices();
      } else {
        that._showLocationError('定位权限被拒绝，请在设置中开启');
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
        if (room.status === 'waiting') {
          // 客户退出 → 回到等待态（房间保持 waiting，生命周期不受客户影响）
          that._onPartnerLeft();
        }
        if (room.status === 'ended') {
          that._onRoomEnded();
        }
      },
      onError: (err) => {
        // watch 是唯一监听通道，断开即失效，记录日志以便排查
        console.error(DBG + '❌ watch 失败，客户加入/退出将无法感知', err);
      },
    });
  },

  _onPartnerJoined(partnerInfo, roomData) {
    if (this._joining) return;
    this._joining = true;

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

  /**
   * 客户退出 → 司机回到"等待客户加入"状态
   * 房间保持 waiting，生命周期不受客户影响，司机位置继续上报
   */
  _onPartnerLeft() {
    if (!this._joining) return;
    console.log(DBG + '👋 客户已退出，回到等待状态');

    // 停止共享阶段的对方位置监听 / 房间 ended 监听 / 定时器（位置上报继续）
    this._unwatch();
    this._stopStaleCheck();
    this._stopUiTimer();

    // 重置防重入标志，允许下一位客户再次加入（watch 仍在监听房间状态）
    this._joining = false;

    // 更新房间状态为 waiting（继续等待下一位客户）
    app.saveRoom({
      roomId: this.roomId,
      shareCode: this.data.shareCode,
      role: 'A', status: 'waiting', partnerInfo: null,
    });

    this.setData({
      waitingForPartner: true,
      partnerLocation: null,
      partnerOnline: false,
      partnerStale: false,
      markers: [],
      polyline: [],
      distance: null,
    });

    wx.showToast({ title: '客户已退出，继续等待', icon: 'none' });
  },
});
