/**
 * 首页 - C端车主入口
 */
const app = getApp();

Page({
  data: {
    debugMsg: '',
    showRetry: false,
    statusType: '', // success | loading | warn | error
  },

  onLoad() {
    console.log('🏠 [首页] onLoad');
    this.setData({ debugMsg: '正在连接服务...', statusType: 'loading' });
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
            this.setData({ debugMsg: '⚠️ 服务异常，点此重试', showRetry: true, statusType: 'error' });
            return;
          }
          const ok = (r.results || []).every(x => x.status === 'exists' || x.status === 'created');
          this.setData({
            debugMsg: ok ? '✅ 服务已就绪' : '⚠️ 服务初始化中，请稍候',
            showRetry: !ok,
            statusType: ok ? 'success' : 'warn',
          });
        })
        .catch(err => {
          if (++attempts < 5) {
            this.setData({ debugMsg: `⏳ 正在重连（${attempts}/5）...`, statusType: 'loading' });
            setTimeout(check, 3000);
          } else {
            this.setData({ debugMsg: `❌ 连接失败，点此重试`, showRetry: true, statusType: 'error' });
          }
        });
    };
    setTimeout(check, 2000);
  },

  onRetryInit() {
    this.setData({ debugMsg: '正在重连...', showRetry: false, statusType: 'loading' });
    this._checkDbReady();
  },

  onShow() {
    console.log('🏠 [首页] onShow');
    const room = app.globalData.currentRoom;
    if (room && room.status === 'waiting') {
      console.log('🏠 [首页] ⏳ 有未完成的等待页，重新进入');
      wx.redirectTo({ url: '/pages/create/create' });
    }
  },

  onHide() {},
  onUnload() {},

  onJoinRoom() {
    wx.navigateTo({ url: '/pages/join/join' });
  },
});
