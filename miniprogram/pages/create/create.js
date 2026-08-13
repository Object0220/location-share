/**
 * 等待页 - 拖车司机由 App 传入参数自动创建救援房间并跳转地图页
 * App 跳转时携带参数：taskId（任务id）/ faultPlateNumber（故障车牌号）/ carOwnerPhone（车主号码后4位）
 */
const app = getApp();
const roomService = require('../../services/room');
const locationService = require('../../services/location');
const { ROLE_NAMES } = require('../../constants');

Page({
  data: {
    // 创建中状态
    showCreating: true,
    taskId: '',
    carOwnerPhone: '',
  },

  roomId: '',

  onLoad(options) {
    // options.taskId（任务id） / faultPlateNumber（故障车牌号） / carOwnerPhone （车主号码后4位）
    console.log('共享位置参数', options);
    const { faultPlateNumber, taskId, carOwnerPhone } = options;
    console.log('faultPlateNumber' + faultPlateNumber);
    console.log('carOwnerPhone：' + carOwnerPhone);
    console.log('taskId' + taskId);

    if (!taskId || !carOwnerPhone) {
      wx.showToast({ title: '缺少任务参数', icon: 'none' });
      console.error('⏳ [waiting] ❌ 缺少 taskId 或 carOwnerPhone');
      return;
    }

    this.taskId = taskId;
    this.carOwnerPhone = carOwnerPhone;
    this.setData({ taskId, carOwnerPhone });

    // 进入即自动创建房间（先校验定位权限）
    this._autoCreate();
  },

  onUnload() {
    console.log('⏳ [waiting] onUnload');
  },

  onBack() {
    wx.navigateBack();
  },

  /** 校验定位权限后自动创建救援房间并跳转 */
  async _autoCreate() {
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

    // 3. 用传入参数创建房间（taskId 作唯一标识，carOwnerPhone 作验证码）
    console.log('⏳ [waiting] ⏳ 正在创建房间...');
    wx.showLoading({ title: '创建房间...' });
    try {
      const result = await roomService.createRoom(userInfo, {
        taskId: this.taskId,
        carOwnerPhone: this.carOwnerPhone,
      });
      wx.hideLoading();

      console.log('⏳ [waiting] ✅ 房间创建成功 roomId=' + result.roomId);

      this.roomId = result.roomId;

      // 4. 直接跳转到地图页等待客户加入
      console.log('⏳ [waiting] 🗺️ 跳转到地图页');
      await new Promise(r => setTimeout(r, 300));
      wx.redirectTo({ url: '/pages/driver-map/driver-map' });
    } catch (err) {
      wx.hideLoading();
      console.error('⏳ [waiting] ❌ 创建房间失败', err.message || err);
      wx.showToast({ title: '创建失败，请重试', icon: 'none' });
    }
  },

});
