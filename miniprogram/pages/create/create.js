/**
 * 等待页 - 拖车司机输入手机号后4位、创建房间、等待客户加入
 * 首页点击「我是拖车司机」后跳转至此页
 */
const app = getApp();
const roomService = require('../../services/room');
const locationService = require('../../services/location');
const { ROLE_NAMES } = require('../../constants');

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

  onLoad() {
    console.log('⏳ [waiting] onLoad — 输入手机号后4位');
  },

  onUnload() {
    console.log('⏳ [waiting] onUnload');
  },

  // ====== 手机号输入事件 ======

  onPhoneKeyPress(e) {
    const value = e.currentTarget.dataset.value;
    if (this.data.phoneLength >= 4) return;

    const digits = [...this.data.phoneDigits];
    digits[this.data.phoneLength] = value;
    const newLength = this.data.phoneLength + 1;
    this.setData({
      phoneDigits: digits,
      phoneLength: newLength,
    });

    // 输完4位自动弹确认框
    if (newLength === 4) {
      setTimeout(() => this.onStartCreate(), 300);
    }
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
    wx.navigateBack();
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
    const userInfo = app.globalData.userInfo || { nickName: ROLE_NAMES.driver, avatarUrl: '' };
    app.globalData.userInfo = userInfo;

    // 3. 确认对话框
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '创建救援房间',
        content: '手机号后四位：' + phoneLast4 + '\n客户输入此号码即可加入救援。',
        confirmText: '确认创建',
        cancelText: '取消',
        success: (res) => resolve(res.confirm),
      });
    });
    if (!confirmed) return;

    // 4. 创建房间（用手机号后4位作为共享码）
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

      // 4. 直接跳转到地图页等待客户加入
      console.log('⏳ [waiting] 🗺️ 跳转到地图页');
      await new Promise(r => setTimeout(r, 500));
      wx.redirectTo({ url: '/pages/driver-map/driver-map' });
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


});
