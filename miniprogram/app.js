/**
 * 道路救援位置共享小程序
 * App 实例
 */
const config = require('./env-config');
const locationService = require('./services/location');
const roomService = require('./services/room');

App({
  globalData: {
    userInfo: null,
    openid: '',
    currentRoom: null,
    cloudReady: false,
    cloudEnv: config.CLOUD_ENV_ID || '',
  },

  onLaunch() {
    // 初始化云开发
    this._initCloud();

    // 获取用户 openid（异步，不阻塞渲染）
    // 调用方可通过 waitForOpenId() 等待获取完成
    this._openidPromise = this.getOpenId();

    // 检查登录态和配对状态
    this.checkSession();

    // 数据库自动初始化（延迟1秒确保云 SDK 就绪）
    setTimeout(() => {
      this._initDatabase();
    }, 1000);
  },

  /**
   * 等待 openid 获取完成
   * 供 room.js 等模块在需要 openid 前调用
   * @returns {Promise<string>}
   */
  waitForOpenId() {
    const openid = this.globalData.openid;
    if (openid) return Promise.resolve(openid);
    // 如果缓存中有但 globalData 还没同步（极少情况），从缓存读
    const cached = wx.getStorageSync('openid');
    if (cached) {
      this.globalData.openid = cached;
      return Promise.resolve(cached);
    }
    // 等待 getOpenId 完成
    if (this._openidPromise) {
      return this._openidPromise.then(() => this.globalData.openid);
    }
    // 兜底：重新获取
    return this.getOpenId();
  },

  onShow() {
    const room = this.globalData.currentRoom;
    if (room) {
      try {
        locationService.startBackgroundUpdate(room.roomId, this.globalData.openid);
      } catch (e) {
        // 后台定位失败不阻塞
      }
    }
  },

  /**
   * 初始化云开发
   */
  _initCloud() {
    if (!wx.cloud) {
      console.warn('当前基础库版本不支持云开发，部分功能不可用');
      this.globalData.cloudReady = false;
      return;
    }

    if (!config.CLOUD_ENV_ID) {
      console.warn(
        '%c⚠️ 云环境未配置',
        'color: #fa5151; font-size: 14px; font-weight: bold;'
      );
      console.info(
        '%c请打开 miniprogram/env-config.js 填写您的云环境 ID',
        'color: #409eff;'
      );
      console.info(
        '%c或右键 cloudfunctions → 选择云环境 → 上传并部署云函数',
        'color: #409eff;'
      );
      // 先初始化但不指定 env，后续可动态切换
      wx.cloud.init({
        traceUser: true,
      });
      this.globalData.cloudReady = false;
      return;
    }

    try {
      wx.cloud.init({
        env: config.CLOUD_ENV_ID,
        traceUser: true,
      });
      this.globalData.cloudReady = true;
      console.log(`✅ 云开发已初始化 (env: ${config.CLOUD_ENV_ID})`);
    } catch (err) {
      console.error('云开发初始化失败', err);
      this.globalData.cloudReady = false;
    }
  },

  /**
   * 自动初始化数据库集合（首次运行自动创建 rooms + locations）
   */
  _initDatabase() {
    console.log('📦 [initDB] 数据库初始化...');

    // 尝试3次
    const tryInit = (attempt = 0) => {
      if (attempt >= 3) {
        console.warn('📦 [initDB] 3次重试均失败，降至直接写入模式');
        this._tryCreateCollection('rooms');
        this._tryCreateCollection('locations');
        return;
      }
      
      wx.cloud.callFunction({
        name: 'initDatabase',
        timeout: 20000,
      }).then(res => {
        const r = res.result || {};
        console.log('📦 [initDB] 返回 code=' + r.code + ' results=' + JSON.stringify(r.results));
        if (r && r.code === 0) {
          console.log('📦 [initDB] ✅ 数据库初始化完成');
          return;
        }
        console.warn('📦 [initDB] ⚠️ 初始化未完成, 第' + (attempt + 1) + '次重试...');
        setTimeout(() => tryInit(attempt + 1), 3000);
      }).catch(err => {
        console.warn('📦 [initDB] ❌ 第' + (attempt + 1) + '次调用失败:', err.message || err);
        setTimeout(() => tryInit(attempt + 1), 3000);
      });
    };

    tryInit(0);
  },

  /**
   * 通过写入数据尝试自动创建集合
   */
  _tryCreateCollection(name) {
    try {
      const db = wx.cloud.database();
      db.collection(name).add({
        data: { _init: true, createdAt: db.serverDate() },
        success() {
          console.log(`✅ 集合 ${name} 创建/写入成功`);
          // 清理初始数据
          db.collection(name).where({ _init: true }).remove().catch(() => {});
        },
        fail(err) {
          console.warn(`集合 ${name} 写入失败:`, err);
        },
      });
    } catch (e) {
      console.warn(`集合 ${name} 创建失败:`, e);
    }
  },

  /**
   * 获取用户 OpenID
   */
  getOpenId() {
    const cached = wx.getStorageSync('openid');
    if (cached) {
      console.log('🔐 [getOpenId] ✅ 使用缓存: ' + cached.slice(0, 10) + '...');
      this.globalData.openid = cached;
      return Promise.resolve(cached);
    }

    console.log('🔐 [getOpenId] 缓存不存在，开始获取...');
    return this._fetchOpenId().catch(err => {
      console.error('🔐 [getOpenId] ❌ 获取失败', err);
      // 降级：生成本地临时 ID
      const tempId = 'tmp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      console.warn('🔐 [getOpenId] 🆘 降级使用临时ID: ' + tempId);
      this.globalData.openid = tempId;
      wx.setStorageSync('openid', tempId);
      return tempId;
    });
  },

  /**
   * 从云函数获取 OpenID
   */
  async _fetchOpenId() {
    try {
      console.log('🔐 [_fetchOpenId] 调用云函数 login...');
      const res = await wx.cloud.callFunction({
        name: 'login',
        timeout: 15000,
      });
      if (res && res.result && res.result.openid) {
        const openid = res.result.openid;
        console.log('🔐 [_fetchOpenId] ✅ 云函数返回 openid: ' + openid.slice(0, 10) + '...');
        this.globalData.openid = openid;
        wx.setStorageSync('openid', openid);
        return openid;
      }
      console.warn('🔐 [_fetchOpenId] ⚠️ 云函数返回无 openid');
    } catch (err) {
      console.warn('🔐 [_fetchOpenId] ❌ 云函数调用失败', err.message || err);
    }

    // 备用：通过 wx.login 获取临时 code
    console.log('🔐 [_fetchOpenId] 备用方案: wx.login');
    return new Promise((resolve, reject) => {
      wx.login({
        success(res) {
          if (res.code) {
            const tempId = 'wx_' + res.code.slice(-16);
            console.log('🔐 [_fetchOpenId] ✅ wx.login 临时ID: ' + tempId);
            wx.setStorageSync('openid', tempId);
            resolve(tempId);
          } else {
            console.error('🔐 [_fetchOpenId] ❌ wx.login 无 code');
            reject(new Error('wx.login 失败'));
          }
        },
        fail(err) {
          console.error('🔐 [_fetchOpenId] ❌ wx.login 调用失败', err);
          reject(err);
        },
      });
    });
  },

  /**
   * 检查登录态和上次配对
   */
  checkSession() {
    try {
      const savedRoom = wx.getStorageSync('currentRoom');
      if (savedRoom && savedRoom.roomId && savedRoom.status === 'active') {
        this.globalData.currentRoom = savedRoom;
      } else {
        this.globalData.currentRoom = null;
        wx.removeStorageSync('currentRoom');
      }
    } catch (e) {
      this.globalData.currentRoom = null;
    }
  },

  /**
   * 保存配对信息
   */
  saveRoom(roomData) {
    this.globalData.currentRoom = roomData;
    try {
      wx.setStorageSync('currentRoom', roomData);
    } catch (e) {
      console.warn('保存配对信息失败', e);
    }
  },

  /**
   * 清除配对（结束共享）
   */
  clearRoom() {
    this.globalData.currentRoom = null;
    try {
      wx.removeStorageSync('currentRoom');
    } catch (e) {}
  },
});
