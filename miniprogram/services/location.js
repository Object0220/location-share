/**
 * 位置服务模块
 * 管理 GPS 采集、权限、上报、后台定位
 */

// 不能用顶层 getApp()，App() 初始化时模块已加载但未完成
// 改为在函数内部懒加载
function getAppInstance() {
  return getApp();
}

// 上报频率 (ms)
const INTERVAL_FOREGROUND = 10000;   // 前台 10 秒
const INTERVAL_BACKGROUND = 15000;    // 后台 15 秒

let updateTimer = null;
let backgroundMode = false;
let isForeground = true;
let lastLocation = null;
let locationCallback = null;
// 取消令牌：stopUpdating 时设为 false，阻止重试回调继续执行
let _active = false;
// 上报节流
const MIN_REPORT_INTERVAL = 10000; // 10 秒
let _lastReportTime = 0;           // 上次成功上报的时间戳

module.exports = {
  /**
   * 检查定位权限
   * @returns {Promise<{granted: boolean, background: boolean}>}
   */
  checkPermission() {
    return new Promise((resolve) => {
      wx.getSetting({
        success(res) {
          const granted = !!res.authSetting['scope.userLocation'];
          const background = !!res.authSetting['scope.userLocationBackground'];
          resolve({ granted, background });
        },
        fail() {
          resolve({ granted: false, background: false });
        },
      });
    });
  },

  /**
   * 请求定位权限（前台）
   * @returns {Promise<boolean>}
   */
  requestPermission() {
    return new Promise((resolve) => {
      wx.authorize({
        scope: 'scope.userLocation',
        success() {
          resolve(true);
        },
        fail() {
          // 引导用户去设置页手动开启
          wx.showModal({
            title: '需要位置权限',
            content: '请开启位置权限以使用位置共享功能',
            success: (res) => {
              if (res.confirm) {
                wx.openSetting({
                  success(settingRes) {
                    resolve(!!settingRes.authSetting['scope.userLocation']);
                  },
                });
              } else {
                resolve(false);
              }
            },
          });
        },
      });
    });
  },

  /**
   * 请求后台定位权限
   * @returns {Promise<boolean>}
   */
  requestBackgroundPermission() {
    return new Promise((resolve) => {
      wx.authorize({
        scope: 'scope.userLocationBackground',
        success() {
          resolve(true);
        },
        fail() {
          wx.showModal({
            title: '需要后台定位权限',
            content: '开启后台定位，退出小程序后仍可共享位置',
            confirmText: '去设置',
            success: (res) => {
              if (res.confirm) {
                wx.openSetting({
                  success(settingRes) {
                    resolve(!!settingRes.authSetting['scope.userLocationBackground']);
                  },
                });
              } else {
                resolve(false);
              }
            },
          });
        },
      });
    });
  },

  /**
   * 开始位置监听和上报
   * @param {string} roomId - 房间ID
   * @param {string} userId - 用户ID
   * @param {function} onLocation - 位置更新回调 (用于更新本地地图)
   * @param {object} options - 配置项 { foreground: boolean }
   */
  startUpdating(roomId, userId, onLocation, options = {}) {
    const isFore = options.foreground !== false;
    isForeground = isFore;
    locationCallback = onLocation;
    _active = true;

    console.log('📍 [location] 🚀 开始位置上报 roomId=' + roomId + ' userId=' + (userId ? userId.slice(0, 10) : '无') + ' foreground=' + isFore);

    // 立即采一次高精度位置
    this.getCurrentPosition().then(loc => {
      if (!_active) return;
      if (loc) {
        lastLocation = loc;
        if (onLocation) onLocation(loc);
        this._reportLocation(roomId, userId, loc);
      }
    });

    // 使用 wx.onLocationChange 持续监听（获取 heading 等实时数据）
    this._startWatching(roomId, userId);

    // 启动定时高精度轮询（主上报通道）
    this._startPeriodicReport(roomId, userId);
  },

  /**
   * 停止位置上报
   */
  stopUpdating() {
    console.log('📍 [location] 🛑 停止位置上报');
    _active = false;
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }
    try {
      wx.stopLocationUpdate({ fail: () => {} });
    } catch (e) {}
    backgroundMode = false;
    locationCallback = null;
    lastLocation = null;
    _lastReportTime = 0;
  },

  /**
   * 小程序进入后台 - 降频上报
   */
  onBackground(roomId, userId) {
    isForeground = false;
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }
    this._startPeriodicReport(roomId, userId);
  },

  /**
   * 小程序回到前台 - 恢复频率
   */
  onForeground(roomId, userId) {
    isForeground = true;
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }
    this._startPeriodicReport(roomId, userId);
  },

  /**
   * 启动后台定位更新
   * 需配合 app.json 的 requiredBackgroundModes: ["location"]
   */
  startBackgroundUpdate(roomId, userId) {
    const that = this;
    wx.startLocationUpdateBackground({
      success() {
        console.log('后台定位已启动');
        backgroundMode = true;
        wx.onLocationChange(function (res) {
          const loc = that._normalizeLocation(res);
          lastLocation = loc;
          if (locationCallback) locationCallback(loc);
          that._reportLocation(roomId, userId, loc);
        });
      },
      fail(err) {
        console.warn('启动后台定位失败', err);
        that._startPeriodicReport(roomId, userId);
      },
    });
  },

  /**
   * 获取当前位置（单次，高精度）
   * @returns {Promise<object|null>}
   */
  getCurrentPosition() {
    return new Promise((resolve) => {
      if (!_active) { resolve(null); return; }
      console.log('📍 [location] 开始定位...');
      wx.getLocation({
        type: 'gcj02',
        isHighAccuracy: true,
        highAccuracyExpireTime: 10000,
        success: (res) => {
          if (!_active) return;
          const accuracy = res.accuracy || 0;
          console.log('📍 [location] 定位成功 lat=' + res.latitude.toFixed(5) + ' lng=' + res.longitude.toFixed(5) + ' acc=' + accuracy.toFixed(0) + 'm');
          resolve({
            latitude: res.latitude,
            longitude: res.longitude,
            speed: res.speed || 0,
            accuracy,
            altitude: res.altitude || 0,
            heading: 0,
            timestamp: Date.now(),
          });
        },
        fail: (err) => {
          if (!_active) return;
          console.warn('📍 [location] ❌ getLocation 失败', err.errMsg || err);
          resolve(null);
        },
      });
    });
  },

  // ====== 内部方法 ======

  /**
   * 启动 wx.onLocationChange 监听
   */
  _startWatching(roomId, userId) {
    const that = this;
    try {
      wx.startLocationUpdate({
        success() {
          wx.onLocationChange(function (res) {
            if (!_active) return;
            const loc = that._normalizeLocation(res);
            lastLocation = loc;
            if (locationCallback) locationCallback(loc);
          });
        },
        fail(err) {
          console.warn('📍 [location] ⚠️ onLocationChange 不可用，仅靠轮询', err.errMsg || err);
        },
      });
    } catch (e) {
      console.warn('📍 [location] ⚠️ startLocationUpdate 不支持');
    }
  },

  /**
   * 定时高精度轮询（主上报通道）
   */
  _startPeriodicReport(roomId, userId) {
    const that = this;
    const interval = isForeground ? INTERVAL_FOREGROUND : INTERVAL_BACKGROUND;

    function poll() {
      if (!_active) return;
      updateTimer = setTimeout(() => {
        if (!_active) return;
        that.getCurrentPosition().then(loc => {
          if (!_active) return;
          if (loc) {
            lastLocation = loc;
            if (locationCallback) locationCallback(loc);
            that._reportLocation(roomId, userId, loc);
          } else if (lastLocation) {
            that._reportLocation(roomId, userId, lastLocation);
          }
          poll();
        });
      }, interval);
    }

    if (updateTimer) clearTimeout(updateTimer);
    poll();
  },

  /**
   * 上报位置到云端
   */
  _reportLocation(roomId, userId, location) {
    if (!roomId || !userId || !location) return;

    // 节流：首次放行，之后 ≥ 10 秒才上报
    const now = Date.now();
    if (_lastReportTime > 0 && now - _lastReportTime < MIN_REPORT_INTERVAL) {
      return;
    }
    _lastReportTime = now;

    const db = wx.cloud.database();
    const locData = {
      roomId,
      userId,
      latitude: location.latitude,
      longitude: location.longitude,
      speed: location.speed || 0,
      heading: location.heading || 0,
      accuracy: location.accuracy || 0,
      timestamp: db.serverDate(),
      _timestamp: Date.now(),
    };

    const docId = `${roomId}_${userId}`;
    console.log('📍 [location] 上报位置 docId=' + docId + ' lat=' + location.latitude.toFixed(5) + ' lng=' + location.longitude.toFixed(5) + ' acc=' + (location.accuracy || 0).toFixed(0) + 'm');

    db.collection('locations').doc(docId).set({
      data: locData,
    }).then(() => {
      // 静默成功，不污染控制台
    }).catch(err => {
      console.warn('📍 [location] ❌ 位置上报失败', err.message || err);
    });
  },

  /**
   * 标准化位置数据
   */
  _normalizeLocation(raw) {
    return {
      latitude: raw.latitude,
      longitude: raw.longitude,
      speed: raw.speed || 0,
      accuracy: raw.horizontalAccuracy || raw.accuracy || 0,
      altitude: raw.altitude || 0,
      heading: raw.direction || raw.heading || 0,
      timestamp: Date.now(),
    };
  },
};
