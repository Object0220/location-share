/**
 * 位置服务模块
 * 管理 GPS 采集、权限、上报、后台定位
 */

// 后台定位回调节流间隔 (ms)，避免高频回调刷屏（从环境配置读取，默认 5s）
const CONFIG = require('../env-config');
const MIN_REPORT_INTERVAL = Math.max(2000, (CONFIG.LOCATION && CONFIG.LOCATION.REPORT_INTERVAL) || 5000);

let locationCallback = null;
let _active = false;   // 取消令牌：stopUpdating 时置 false，阻止回调继续执行
let _started = false;  // startLocationUpdateBackground 防重复注册
let _lastReportTime = 0; // 上报节流：上次成功上报时间戳

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
      // 先查当前状态，已授权直接返回，不重复弹窗
      wx.getSetting({
        success(res) {
          if (res.authSetting['scope.userLocation']) {
            resolve(true);
            return;
          }
          // 未授权 → 尝试 wx.authorize
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
                success: (modalRes) => {
                  if (modalRes.confirm) {
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
        },
        fail() {
          // getSetting 失败，兜底走授权
          resolve(false);
        },
      });
    });
  },

  /**
   * 请求后台定位权限（改用 wx.getSetting + wx.openSetting 方式）
   * wx.authorize 对 scope.userLocationBackground 静默失败
   * @returns {Promise<boolean>}
   */
  requestBackgroundPermission() {
    return new Promise((resolve) => {
      // 先查当前状态
      wx.getSetting({
        success(res) {
          if (res.authSetting['scope.userLocationBackground']) {
            resolve(true);
            return;
          }
          // 未授权 → 弹窗引导去设置页
          wx.showModal({
            title: '需要后台定位权限',
            content: '开启后台定位，退出小程序后仍可共享位置',
            confirmText: '去设置',
            success: (modalRes) => {
              if (modalRes.confirm) {
                wx.openSetting({
                  success(settingRes) {
                    const granted = !!settingRes.authSetting['scope.userLocationBackground'];
                    if (!granted) {
                      console.warn('📍 [location] 后台定位权限未开启');
                    }
                    resolve(granted);
                  },
                  fail(err) {
                    console.warn('📍 [location] openSetting 失败', err);
                    resolve(false);
                  },
                });
              } else {
                resolve(false);
              }
            },
          });
        },
        fail(err) {
          console.warn('📍 [location] getSetting 失败', err);
          resolve(false);
        },
      });
    });
  },

  /**
   * 开始位置监听和上报
   * @param {string} roomId - 房间ID
   * @param {string} userId - 用户ID
   * @param {function} onLocation - 位置更新回调 (用于更新本地地图)
   */
  startUpdating(roomId, userId, onLocation) {
    locationCallback = onLocation;
    _active = true;

    console.log('📍 [location] 🚀 开始位置上报(后台定位单一通道) roomId=' + roomId + ' userId=' + (userId ? userId.slice(0, 10) : '无'));

    // 单一后台定位通道：onLocationChange 回调统一驱动"地图居中 + 上报"，无需额外首采
    this._startBackgroundLocation(roomId, userId);
  },

  /**
   * 停止位置上报
   */
  stopUpdating() {
    console.log('📍 [location] 🛑 停止位置上报');
    _active = false;
    _started = false;
    try {
      wx.stopLocationUpdate({ fail: (err) => console.warn('📍 [location] stopLocationUpdate 失败', err) });
    } catch (e) {
      console.warn('📍 [location] stopLocationUpdate 异常', e);
    }
    locationCallback = null;
    _lastReportTime = 0;
  },

  /**
   * 启动后台定位（唯一通道）
   * wx.startLocationUpdateBackground 在前台也会持续回调，因此前后台共用此通道。
   * 需配合 app.json 的 requiredBackgroundModes: ["location"]。
   */
  _startBackgroundLocation(roomId, userId) {
    if (_started) {
      console.log('📍 [location] ⏭ 后台定位已启动，跳过重复注册');
      return;
    }
    _started = true;

    const that = this;
    const onLoc = (res) => {
      if (!_active) return;
      const loc = that._normalizeLocation(res);
      if (locationCallback) locationCallback(loc);
      that._reportLocation(roomId, userId, loc);
    };

    // 真机只走后台定位单一通道
    wx.startLocationUpdateBackground({
      success() {
        console.log('📍 [location] 后台定位已启动');
        wx.onLocationChange(onLoc);
      },
      fail(err) {
        console.warn('📍 [location] 启动后台定位失败', err);
      },
    });
  },

  // ====== 内部方法 ======

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
      altitude: raw.altitude || 0,
      timestamp: Date.now(),
    };
  },
};
