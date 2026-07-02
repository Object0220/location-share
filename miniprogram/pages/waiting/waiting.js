/**
 * 等待页 - 拖车司机输入手机号后4位、创建房间、等待客户加入
 * 首页点击「我是拖车司机」后跳转至此页
 */
const app = getApp();
const roomService = require('../../services/room');
const locationService = require('../../services/location');

Page({
  data: {
    // 输入手机号阶段
    showPhoneInput: true,
    phoneDigits: ['', '', '', ''],
    phoneLength: 0,

    // 等待阶段
    showWaiting: false,
    shareCode: '',
    shareCodeArray: [],
  },

  roomId: '',
  _roomWatcher: null,
  _watchRetryTimer: null,
  _watchRetryCount: 0,

  onLoad() {
    console.log('⏳ [waiting] onLoad — 输入手机号后4位');
  },

  onUnload() {
    console.log('⏳ [waiting] onUnload');
    this._closeWatcher();
  },

  // ====== 手机号输入事件 ======

  onPhoneKeyPress(e) {
    const value = e.currentTarget.dataset.value;
    if (this.data.phoneLength >= 4) return;

    const digits = [...this.data.phoneDigits];
    digits[this.data.phoneLength] = value;
    this.setData({
      phoneDigits: digits,
      phoneLength: this.data.phoneLength + 1,
    });
  },

  onPhoneDelete() {
    if (this.data.phoneLength <= 0) return;
    const digits = [...this.data.phoneDigits];
    digits[this.data.phoneLength - 1] = '';
    this.setData({
      phoneDigits: digits,
      phoneLength: this.data.phoneLength - 1,
    });
  },

  onPhoneClear() {
    this.setData({
      phoneDigits: ['', '', '', ''],
      phoneLength: 0,
    });
  },

  // ====== 事件 ======

  onBack() {
    if (this.data.showPhoneInput) {
      wx.navigateBack();
    } else {
      // 等待模式返回视为放弃
      this._closeWatcher();
      app.clearRoom();
      wx.navigateBack();
    }
  },

  /** 开始创建救援房间 */
  async onStartCreate() {
    if (this.data.phoneLength < 4) {
      wx.showToast({ title: '请输入手机号后四位', icon: 'none' });
      return;
    }

    const phoneLast4 = this.data.phoneDigits.join('');

    // 1. 请求定位权限
    const perm = await locationService.checkPermission();
    if (!perm.granted) {
      const granted = await locationService.requestPermission();
      if (!granted) {
        console.warn('⏳ [waiting] ❌ 定位权限被拒绝');
        wx.showToast({ title: '需要定位权限', icon: 'none' });
        return;
      }
    }

    // 2. 获取用户信息
    const userInfo = app.globalData.userInfo || { nickName: '拖车司机', avatarUrl: '' };
    app.globalData.userInfo = userInfo;

    // 3. 创建房间（用手机号后4位作为共享码）
    console.log('⏳ [waiting] ⏳ 正在创建房间...');
    wx.showLoading({ title: '创建房间...' });
    try {
      const result = await roomService.createRoom(userInfo, phoneLast4);
      wx.hideLoading();

      console.log('⏳ [waiting] ✅ 房间创建成功 shareCode=' + result.shareCode + ' roomId=' + result.roomId);

      this.roomId = result.roomId;
      this.setData({
        showPhoneInput: false,
        showWaiting: true,
        shareCode: result.shareCode,
        shareCodeArray: result.shareCode.split(''),
      });

      // 4. 开始监听房间状态
      this._watchRoomStatus(result.roomId);
    } catch (err) {
      wx.hideLoading();
      console.error('⏳ [waiting] ❌ 创建房间失败', err.message || err);
      wx.showToast({ title: '创建失败，请重试', icon: 'none' });
    }
  },

  /** 复制共享码 */
  onCopyCode() {
    wx.setClipboardData({
      data: this.data.shareCode,
      success: () => wx.showToast({ title: '已复制手机号后四位', icon: 'none' }),
    });
  },

  /** 取消救援 */
  onCancelRoom() {
    const that = this;
    wx.showModal({
      title: '取消救援',
      content: '确定要取消当前救援吗？',
      success(res) {
        if (!res.confirm) return;
        that._doCancelRoom();
      },
      fail(err) {
        console.error('⏳ [waiting] ❌ 弹窗失败', err);
      },
    });
  },

  /** 执行取消 */
  async _doCancelRoom() {
    try {
      this._closeWatcher();
      const room = app.globalData.currentRoom;
      if (room && room.roomId) {
        await roomService.leaveRoom(room.roomId);
      } else {
        app.clearRoom();
      }
      wx.navigateBack();
    } catch (err) {
      console.error('⏳ [waiting] ❌ 取消救援失败', err);
      app.clearRoom();
      wx.navigateBack();
    }
  },

  // ====== 监听房间状态 ======

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
          console.log('⏳ [waiting] 🎉 客户已加入! nickName=' + room.userB.nickName);
          this._closeWatcher();
          app.saveRoom({
            roomId: room._id, shareCode: room.shareCode,
            role: 'A', status: 'active', partnerInfo: room.userB,
          });
          wx.showToast({ title: '客户已加入', icon: 'success' });
          setTimeout(() => wx.redirectTo({ url: '/pages/map/map' }), 1000);
        }

        if (room.status === 'ended') {
          console.log('⏳ [waiting] 🔚 救援已结束');
          this._closeWatcher();
          app.clearRoom();
          wx.showToast({ title: '救援已结束', icon: 'none' });
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
