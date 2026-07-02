/**
 * 首页 - 创建/加入共享房间
 */
const app = getApp();
const roomService = require('../../services/room');
const locationService = require('../../services/location');

Page({
  data: {
    toast: { show: false, message: '' },
    debugMsg: '',
    showRetry: false,
  },

  onLoad() {
    console.log('🏠 [首页] onLoad');
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
    const room = app.globalData.currentRoom;
    if (room && room.status === 'waiting') {
      console.log('🏠 [首页] ⏳ 有未完成的等待页，重新进入');
      wx.redirectTo({ url: '/pages/waiting/waiting' });
    }
  },

  onHide() {},
  onUnload() {},

  /** 创建共享房间 */
  async onCreateRoom() {
    console.log('🏠 [首页] 👆 点击「创建共享房间」');
    const perm = await locationService.checkPermission();
    if (!perm.granted) {
      const granted = await locationService.requestPermission();
      if (!granted) { console.warn('🏠 [首页] ❌ 定位权限被拒绝'); return; }
    }
    const userInfo = app.globalData.userInfo || { nickName: '拖车司机', avatarUrl: '' };
    app.globalData.userInfo = userInfo;
    this._doCreateRoom(userInfo);
  },

  onJoinRoom() { wx.navigateTo({ url: '/pages/join/join' }); },

  /** 执行创建房间 → 跳转到独立等待页 */
  async _doCreateRoom(userInfo) {
    console.log('🏠 [首页] ⏳ 正在创建房间...');
    wx.showLoading({ title: '创建房间...' });
    try {
      const result = await roomService.createRoom(userInfo);
      console.log('🏠 [首页] ✅ 房间创建成功 shareCode=' + result.shareCode);
      wx.hideLoading();
      // 跳转到独立等待页，由等待页管理房间监听和后续跳转
      wx.redirectTo({ url: '/pages/waiting/waiting' });
    } catch (err) {
      wx.hideLoading();
      console.error('🏠 [首页] ❌ 创建房间失败', err.message || err);
      this._showToast('创建失败，请重试');
    }
  },

  /** Toast 提示 */
  _showToast(message) {
    this.setData({ toast: { show: true, message } });
    setTimeout(() => this.setData({ toast: { show: false, message: '' } }), 2000);
  },
});
