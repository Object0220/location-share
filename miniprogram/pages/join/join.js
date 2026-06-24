/**
 * 加入房间页 - 输入共享码/扫码加入
 */
const app = getApp();
const roomService = require('../../services/room');
const locationService = require('../../services/location');

Page({
  data: {
    codeValue: '',           // 4 位共享码
    codeLength: 0,
    codeSlots: [
      { value: '', filled: false, active: false },
      { value: '', filled: false, active: false },
      { value: '', filled: false, active: false },
      { value: '', filled: false, active: false },
    ],
    loading: false,
    errorMsg: '',
    isScanning: false,
  },

  onLoad(options) {
    console.log('🔗 [加入页] onLoad options=' + JSON.stringify(options));
    if (options.code) {
      console.log('🔗 [加入页] 从分享链接携带 code=' + options.code);
      this.setData({ codeValue: options.code });
      this._updateSlots(options.code);
      this._doJoin(options.code);
    }
  },

  onUnload() {
    // 清理可能存在的定时器
    if (this._errorTimer) {
      clearTimeout(this._errorTimer);
    }
  },

  // ====== 事件处理 ======

  onBack() {
    wx.navigateBack();
  },

  /**
   * 点击插槽定位光标
   */
  onSlotTap(e) {
    const index = e.currentTarget.dataset.index;
    if (!this.data.codeSlots[index].filled) {
      this._setActiveSlot(index);
    }
  },

  /**
   * 数字键盘按键
   */
  onKeyPress(e) {
    const value = e.currentTarget.dataset.value;
    let code = this.data.codeValue;
    const activeIndex = this.data.codeSlots.findIndex(s => s.active);

    if (code.length >= 4) return;

    // 确定填充位置（从 active 位置或第一个空位开始）
    let fillIndex = activeIndex >= 0 && !this.data.codeSlots[activeIndex].filled
      ? activeIndex
      : code.length;

    if (fillIndex >= 4) return;

    code += value;
    this._updateSlots(code);
    this.setData({ codeValue: code, errorMsg: '' });

    // 自动提交
    if (code.length === 4) {
      this._doJoin(code);
    }
  },

  /**
   * 删除键
   */
  onDelete() {
    let code = this.data.codeValue;
    if (code.length === 0) return;

    // 找到 active 位置或最后一个字符
    const activeIndex = this.data.codeSlots.findIndex(s => s.active);
    let removeIndex;

    if (activeIndex > 0 && !this.data.codeSlots[activeIndex - 1].filled) {
      // active 在空位，删除上一个
      removeIndex = activeIndex - 1;
    } else {
      removeIndex = code.length - 1;
    }

    code = code.slice(0, -1);
    this._updateSlots(code);
    this.setData({ codeValue: code, errorMsg: '' });
  },

  /**
   * 清空
   */
  onClear() {
    this.setData({ codeValue: '', errorMsg: '' });
    this._updateSlots('');
  },

  /**
   * 粘贴共享码
   */
  onPaste() {
    const that = this;
    wx.getClipboardData({
      success(res) {
        const text = (res.data || '').trim();
        // 只提取数字，限制 4 位
        const digits = text.replace(/\D/g, '').slice(0, 4);
        if (digits.length === 4) {
          that._updateSlots(digits);
          that.setData({ codeValue: digits, errorMsg: '' });
          that._doJoin(digits);
        } else if (digits.length > 0) {
          that.setData({ errorMsg: '共享码格式不正确，请输入4位数字' });
          that._updateSlots(digits);
          that.setData({ codeValue: digits });
        }
      },
    });
  },

  /**
   * 扫码
   */
  onScanCode(e) {
    this.setData({ isScanning: true });
    const result = e.detail.result;
    if (result) {
      // 提取共享码：可能是直接数字，也可能是 URL 参数
      const codeMatch = result.match(/(?:code=)?(\d{4})/);
      const code = codeMatch ? codeMatch[1] : result.replace(/\D/g, '').slice(0, 4);

      if (code.length === 4) {
        this._updateSlots(code);
        this.setData({ codeValue: code, errorMsg: '' });
        this._doJoin(code);
      } else {
        this.setData({ errorMsg: '未能识别有效的共享码' });
      }
    }
    this.setData({ isScanning: false });
  },

  // ====== 内部方法 ======

  /**
   * 更新输入框 UI
   */
  _updateSlots(code) {
    const slots = this.data.codeSlots.map((slot, i) => ({
      value: code[i] || '',
      filled: !!code[i],
      active: i === code.length, // 下一个空位闪烁
    }));
    this.setData({ codeSlots: slots, codeLength: code.length });
  },

  /**
   * 设置 active 插槽
   */
  _setActiveSlot(index) {
    const slots = this.data.codeSlots.map((slot, i) => ({
      ...slot,
      active: i === index,
    }));
    this.setData({ codeSlots: slots });
  },

  /**
   * 执行加入房间
   */
  async _doJoin(code) {
    console.log('🔗 [加入页] ⏳ 开始加入房间 code=' + code);

    const perm = await locationService.checkPermission();
    if (!perm.granted) {
      console.log('🔗 [加入页] 请求定位权限...');
      const granted = await locationService.requestPermission();
      if (!granted) {
        console.warn('🔗 [加入页] ❌ 定位权限被拒');
        return;
      }
    }

    const userInfo = app.globalData.userInfo || {
      nickName: '共享用户',
      avatarUrl: '',
    };

    this.setData({ loading: true, errorMsg: '' });

    try {
      const result = await roomService.joinRoom(code, userInfo);
      this.setData({ loading: false });

      console.log('🔗 [加入页] ✅ 加入成功! roomId=' + result.roomId + ' 对方=' + (result.partnerInfo ? result.partnerInfo.nickName : '无'));
      wx.showToast({ title: '加入成功', icon: 'success' });

      setTimeout(() => {
        console.log('🔗 [加入页] 🔄 跳转到地图页');
        wx.redirectTo({
          url: '/pages/map/map',
        });
      }, 1000);
    } catch (err) {
      this.setData({ loading: false });
      console.error('🔗 [加入页] ❌ 加入失败', err.message || err);

      const errorMsg = err.message || '加入失败，请检查共享码是否正确';
      this.setData({ errorMsg });

      this._errorTimer = setTimeout(() => {
        this.setData({ errorMsg: '' });
      }, 3000);
    }
  },
});
