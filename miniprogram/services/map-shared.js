/**
 * 地图共享模块
 * ============
 * driver-map 和 customer-map 的通用逻辑抽离
 *
 * 职责边界：
 * - 定位服务启动           ✓（委托 location.js）
 * - 对方位置监听           ✓（watch 实时推送，断线自动重连）
 * - 房间 ended 监听        ✓（watch 实时推送，断线自动重连）
 * - 地图标记/连线/UI 更新  ✓
 * - 掉线检测/重试          ✓
 *
 * 不处理：
 * - 等待客户加入逻辑       → driver-map
 * - 角色相关文案          → 各自页面
 *
 * 用法：在页面 onLoad 中调用 shared.mixin(this)
 */
const locationService = require('./location');
const roomService = require('./room');
const util = require('../utils/util');

// ============================================================
// 角色差异配置表
// 司机端 / 客户端 在共享地图上的"视角差异"全部集中在此，
// 避免散落在各方法里用 if (_shareRole === 'driver') 硬编码。
// 新增角色差异时，先来这里加字段，再在 mixin 里引用。
// ============================================================
const ROLE_CONFIG = {
  driver: {
    icon: '🚗',                    // 日志前缀图标
    partnerLabel: '客户',          // 对方标记上的称呼（司机看对方）
    selfEndedLog: '🚗 司机主动结束，停留在当前页面',
  },
  customer: {
    icon: '👤',                    // 日志前缀图标
    partnerLabel: '司机',          // 对方标记上的称呼（客户看对方）
    selfEndedLog: '👤 客户主动结束，停留在当前页面',
  },
};

module.exports = {
  // 暴露给页面/外部使用（如需扩展）
  ROLE_CONFIG,

  // ============================================================
  // 配置常量
  // ============================================================
  CONSTANTS: {
    PARTNER_STALE_TIMEOUT: 30000,     // 对方位置超过 30s 未更新 → 标为"延迟"
    PARTNER_OFFLINE_TIMEOUT: 45000,   // 超过 45s → 标为"离线"
    STALE_CHECK_INTERVAL: 10000,      // 掉线检测间隔
    UI_REFRESH_INTERVAL: 1000,        // 更新时间标签刷新间隔
    PARTNER_UPDATE_THROTTLE: 5000,    // 对方位置更新节流（避免高频 setData）
  },

  // ============================================================
  // 页面 data 默认值
  // 两个地图页的 data 结构保持一致，WXML 才能共用
  // ============================================================
  getDefaultData() {
    return {
      myLocation: { latitude: 0, longitude: 0, heading: 0, speed: 0 },
      partnerLocation: null,
      mapScale: 15,
      markers: [],
      polyline: [],
      satelliteMode: false,
      partnerInfo: {},
      partnerOnline: false,
      wsConnected: true,
      partnerLastUpdate: '',
      distance: null,
      locationError: '',
      partnerStale: false,
      isFirstLoad: true,
      destination: null,          // 救援目的地 { name, address, latitude, longitude }
      destDistance: null,         // 我到目的地的距离
    };
  },

  // ============================================================
  // 页面私有字段默认值（不在 data 中，不触发渲染）
  //
  // ⚠️ 契约说明（页面与共享模块的约定，改动需谨慎）
  // 这些字段由 mixin 注入到页面实例，是「共享模块 ↔ 页面」之间的隐式契约：
  //
  // 【页面 → 共享模块】页面在 onLoad 阶段必须设置的字段：
  //   - roomId / userId        : 由 _initRoom() 或页面手动赋值，共享逻辑依赖
  //   - _shareRole             : 调用 _requestPermissions(role) 时写入，驱动日志/文案
  //
  // 【页面 → 共享模块】页面可主动读取/写入、影响共享行为的"状态开关"：
  //   - _selfEnded             : 置 true 时，结束不跳页而是停留在结束态（司机主动结束）
  //   - _userInteracted        : 拖拽地图后置 true，停止自动移动中心
  //
  // 【共享模块 → 页面】其余 _xxx 字段均为共享模块内部状态，
  //   页面【不应】直接读写，仅供 mixin 内部方法使用（见各自注释）。
  // ============================================================
  getDefaultFields() {
    return {
      roomId: '',
      userId: '',
      _shareRole: '',                   // 【契约】角色 'driver' | 'customer'，由 _requestPermissions 写入，驱动 ROLE_CONFIG
      _staleCheckTimer: null,         // 掉线检测 interval id
      _updateUiTimer: null,            // UI 刷新 interval id
      _unwatchLocation: null,          // 位置 watch 的取消函数
      _roomStatusWatcher: null,        // 房间 ended watch 实例
      _lastPartnerTimestamp: 0,        // 对方最后一次位置更新时间戳
      _lastPartnerTick: 0,             // 节流用时间戳
      _watchPartnerRetryCount: 0,      // 位置 watch 重试计数（指数退避，内联 setTimeout 重连，无需保存 timer 引用）
      _watchRoomRetryCount: 0,         // 房间 watch 重试计数（同上）
      _partnerRawData: null,           // 对方位置原始数据缓存
      _backgroundTimer: null,          // 后台定位启动延迟 timer（_requestPermissions 中设置）
      _cachedMyLocation: null,         // 缓存自己的位置（避免频繁读 data）
      _cachedPartnerLocation: null,    // 缓存对方位置
      _markersInited: false,           // 标记是否已初始化
      _prevStale: false,               // 上一次掉线状态（检测变化用）
      _userInteracted: false,          // 【契约】用户拖拽过地图后置 true，停止自动移动中心
      _selfEnded: false,               // 【契约】主动结束标志：true 时结束停留在当前页而非跳页
      _ended: false,                   // 共享是否已结束（防 _onRoomEnded 重入）
      _initialFitDone: false,          // 首次视野框选是否已完成
    };
  },

  // ============================================================
  // mixin(page)
  // 核心方法：将 20+ 个共享方法注入页面实例
  // 页面 onLoad 时调用一次即可
  //
  // 注入后页面拥有全部 _requestPermissions、_startWatchingPartner 等
  // 生命周期 onShow/onHide/onUnload/onBack 由页面委托给
  // _handleShow/_handleHide/_handleUnload/_handleBack 统一处理
  // ============================================================
  mixin(page) {
    const C = this.CONSTANTS;

    // ----- 初始化 -----

    /**
     * 重置（非 data）状态
     * 在 onLoad 和 onUnload 时调用
     */
    page._resetState = function () {
      this._cachedMyLocation = null;
      this._cachedPartnerLocation = null;
      this._markersInited = false;
      this._prevStale = false;
      this._userInteracted = false;
      this._initialFitDone = false;
      this._backgroundTimer = null;
    };

    /**
     * 从 app.globalData 读取房间数据
     * @returns {boolean} 是否初始化成功
     */
    page._initRoom = function () {
      const room = getApp().globalData.currentRoom;
      if (!room || !room.roomId) {
        wx.showToast({ title: '配对信息丢失', icon: 'none' });
        setTimeout(() => wx.redirectTo({ url: '/pages/index/index' }), 1500);
        return false;
      }
      this.roomId = room.roomId;
      this.userId = getApp().globalData.openid;
      if (room.partnerInfo) {
        this.setData({
          partnerInfo: {
            nickName: room.partnerInfo.nickName || '',
            avatarUrl: room.partnerInfo.avatarUrl || '',
          },
        });
      }
      return true;
    };

    // ----- 权限 & 定位服务 -----

    /** 日志前缀：🚗 司机 / 👤 客户（取自 ROLE_CONFIG） */
    page._logPrefix = function () {
      return (ROLE_CONFIG[this._shareRole] || ROLE_CONFIG.customer).icon;
    };

    /** 对方标记的显示文字：司机端看对方是"客户"，客户端看对方是"司机"（取自 ROLE_CONFIG） */
    page._partnerLabel = function () {
      return (ROLE_CONFIG[this._shareRole] || ROLE_CONFIG.customer).partnerLabel;
    };

    /**
     * 请求定位权限 + 启动所有服务
     * 这是整个位置共享的入口点
     *
     * 启动顺序（重要）：
     * 1. requestPermission            ← 前台定位授权（阻塞）
     * 2. checkPermission → 后台授权   ← 可选，不阻塞
     * 3. startLocationServices        ← 后台定位单一通道（前后台通用）
     * 4. startWatchingPartner         ← 监听对方位置（watch 实时推送）
     * 5. watchRoomEnded               ← 监听共享结束
     *
     * @param {string} role - 'driver' | 'customer'（仅用于日志前缀）
     */
    page._requestPermissions = async function (role) {
      this._shareRole = role; // 供各回调日志区分司机🚗/客户👤
      const granted = await locationService.requestPermission();
      if (!granted) {
        this._showLocationError('定位权限被拒绝，请在设置中开启');
        return;
      }

      // 后台权限可选，先让地图出来再弹
      locationService.checkPermission().then(perm => {
        if (!perm.background) {
          setTimeout(() => locationService.requestBackgroundPermission().catch(err => {
            console.warn('⚠️ 申请后台定位权限失败', err.errMsg || err.message || err);
          }), 3000);
        }
      });

      this._startLocationServices();
      this._startWatchingPartner();
      this._watchRoomEnded();
    };

    /**
     * 启动位置上报 + 本地地图更新（后台定位单一通道，前后台通用）
     */
    page._startLocationServices = function () {
      const cb = (loc) => { if (loc) this._onMyLocationUpdate(loc); };
      locationService.startUpdating(this.roomId, this.userId, cb);
    };

    // ----- 对方位置监听 -----

    /**
     * 监听对方位置变化（watch 实时推送，唯一通道）
     * 断线后由 _scheduleRetry 指数退避自动重连
     */
    page._startWatchingPartner = function () {
      this._watchPartnerRetryCount = 0;
      const prefix = this._logPrefix();
      this._unwatchLocation = roomService.watchPartnerLocation(
        this.roomId, this.userId,
        // onChange：位置更新
        (data) => {
          this.setData({ wsConnected: true });
          this._onPartnerLocationUpdate(data);
        },
        // onStatus：连接状态变更
        (status) => {
          if (status.connected) {
            console.log(prefix + ' 📡 对方位置 watch 已连接');
            this.setData({ wsConnected: true });
            this._watchPartnerRetryCount = 0;
          } else {
            console.warn(prefix + ' ⚠️ 对方位置 watch 断开，进入重连' + (status.error ? ': ' + (status.error.errMsg || status.error.message || status.error) : ''));
            // 断开时先关闭旧 watcher，防止重连期间双 watcher 双 setData
            if (this._unwatchLocation) {
              try { this._unwatchLocation(); } catch (e) {}
            }
            this._unwatchLocation = null;  // 清空引用，重连守卫才能通过
            this.setData({ wsConnected: false });
            this._scheduleRetry('Partner', () => {
              if (!this._unwatchLocation) this._startWatchingPartner();
            });
          }
        }
      );
    };

    /**
     * watch 重试（指数退避，位置/房间两处共用）
     * 1s → 2s → 4s → ... → 30s 封顶
     *
     * @param {string} key - 'Partner' | 'Room'，决定读写哪组计数字段
     * @param {Function} restart - 重试动作（内部自行判断是否可重连）
     */
    page._scheduleRetry = function (key, restart) {
      const countKey = '_watch' + key + 'RetryCount';
      const timerKey = '_watch' + key + 'RetryTimer';
      this[countKey] = (this[countKey] || 0) + 1;
      const delay = Math.min(1000 * Math.pow(2, this[countKey] - 1), 30000);
      this[timerKey] = setTimeout(() => {
        this[timerKey] = null;
        if (this.roomId) restart.call(this);
      }, delay);
    };

    // ----- 房间 ended 监听 -----

    /**
     * 监听房间 ended 状态（watch 实时推送，唯一通道）
     * 当对方结束救援时，自动返回首页
     * 断线后由 _scheduleRetry 指数退避自动重连
     */
    page._watchRoomEnded = function () {
      if (!this.roomId) return;
      // 关闭旧 watcher 防止泄漏
      if (this._roomStatusWatcher) {
        this._roomStatusWatcher.close();
        this._roomStatusWatcher = null;
      }
      this._watchRoomRetryCount = 0;
      const db = wx.cloud.database();
      const prefix = this._logPrefix();
      this._roomStatusWatcher = db.collection('rooms').doc(this.roomId).watch({
        onChange: (snapshot) => {
          // init 快照同样处理：断线重连后可能错过目的地变更，需要补回标记；
          // ended 由 _ended 防重入保护，不会重复执行
          this._watchRoomRetryCount = 0;
          const room = snapshot.docs && snapshot.docs[0];
          if (!room) return;
          console.log(prefix + ' 🏠 房间变更: status=' + room.status + ' destination=' + (room.destination && room.destination.name ? room.destination.name : '无'));
          // 检测目的地更新（含 init 快照，避免断线期间设置的标记永久丢失）
          if (room.destination && room.destination.latitude) {
            this.setData({ destination: room.destination });
            // markers 已初始化 → 单独 upsert 目的地标记；否则走 _refreshMarkers 重建
            if (this._markersInited) this._upsertDestMarker();
            else this._refreshMarkers();
            this._calcDestDistance();
          }
          // 检测共享结束
          if (room.status === 'ended') {
            console.log(prefix + ' 🔚 对方已结束救援');
            this._onRoomEnded();
          }
        },
        onError: (err) => {
          console.error(prefix + ' ❌ watch 房间失败', err);
          this._roomStatusWatcher = null;
          this._scheduleRetry('Room', () => {
            if (!this._roomStatusWatcher) this._watchRoomEnded();
          });
        },
      });
    };

    /**
     * 统一清理：关监听、停定位与定时器、重置状态
     * _onRoomEnded 与 _handleUnload 共用
     */
    page._cleanup = function () {
      this._unwatch();
      locationService.stopUpdating();
      this._stopStaleCheck();
      this._stopUiTimer();
      this._clearRetryTimers();
      this._resetState();
    };

    /**
     * 共享结束处理
     * 清理所有资源：watch、定位、定时器、房间数据
     *
     * 结束来源：
     * - 对方结束救援 → 提示后返回上一页
     * - 司机主动结束（this._selfEnded）→ 停留在当前页面显示结束态，
     *   不自动关闭界面，由用户点击"返回首页"离开
     */
    page._onRoomEnded = function () {
      if (this._ended) return;   // 防重入：watch 异步回调可能重复触发 ended
      this._ended = true;
      console.log('🔚 共享已结束');
      this._cleanup();
      getApp().clearRoom();

      // 主动结束（司机/客户）：不关闭页面，展示结束态
      if (this._selfEnded) {
        console.log((ROLE_CONFIG[this._shareRole] || ROLE_CONFIG.customer).selfEndedLog);
        this.setData({ shareEnded: true });
        return;
      }

      // 对方结束（或房间被清理）：提示后返回上一页
      wx.showToast({ title: '救援已结束', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
    };

    /**
     * 统一关闭所有监听器
     * 包括：位置 watch、房间 watch
     */
    page._unwatch = function () {
      if (this._unwatchLocation) {
        this._unwatchLocation();
        this._unwatchLocation = null;
      }
      if (this._roomStatusWatcher) {
        this._roomStatusWatcher.close();
        this._roomStatusWatcher = null;
      }
    };

    // ----- 位置更新回调 -----

    /**
     * 自定位更新
     * 由 location.startUpdating 的回调触发
     * - 缓存位置到 _cachedMyLocation
     * - 更新地图中心（用户未拖拽时）
     * - 清空错误提示
     * - 更新标记位置
     */
    page._onMyLocationUpdate = function (loc) {
      if (!loc) return;
      const myLoc = {
        latitude: loc.latitude, longitude: loc.longitude,
      };
      this._cachedMyLocation = myLoc;

      const updateData = {};
      if (this.data.locationError) updateData.locationError = '';
      if (this.data.isFirstLoad) updateData.isFirstLoad = false;
      // 用户拖拽过地图时不自动移动中心
      if (!this._userInteracted) updateData.myLocation = myLoc;

      if (Object.keys(updateData).length > 0) this.setData(updateData);

      this._refreshMarkers();
      this._updatePolyline();
    };

    /**
     * 对方位置更新
     * 由 watch 实时推送触发
     * - 有 PARTNER_UPDATE_THROTTLE 节流（防高频 setData）
     * - 更新距离计算
     * - 更新标记 + 连线
     * - 重启掉线检测计时器
     */
    page._onPartnerLocationUpdate = function (data) {
      if (!data) return;
      const now = Date.now();
      if (now - this._lastPartnerTick < C.PARTNER_UPDATE_THROTTLE) return;
      this._lastPartnerTick = now;
      const prefix = this._logPrefix();
      console.log(prefix + ' 📍 收到对方位置: ' + data.latitude.toFixed(6) + ',' + data.longitude.toFixed(6) +
        ' 速度=' + (data.speed || 0).toFixed(1) + 'm/s 方向=' + (data.heading || 0) + '°');

      this._lastPartnerTimestamp = data._timestamp || now;
      this._partnerRawData = data;
      const partnerLoc = {
        latitude: data.latitude, longitude: data.longitude,
        heading: data.heading || 0, speed: data.speed || 0,
      };
      this._cachedPartnerLocation = partnerLoc;
      this.setData({
        partnerLocation: partnerLoc, partnerOnline: true, partnerStale: false,
      });

      // 首次同时拿到双方位置 → 框选视野（只触发一次，之后交给用户操作）
      if (!this._initialFitDone && this._cachedMyLocation && this._cachedMyLocation.latitude) {
        this._initialFitDone = true;
        this._fitToPartners();
      }

      // 计算距离
      if (this._cachedMyLocation && this._cachedMyLocation.latitude) {
        this.setData({
          distance: util.formatDistance(util.calcDistance(
            this._cachedMyLocation.latitude, this._cachedMyLocation.longitude,
            partnerLoc.latitude, partnerLoc.longitude
          )),
        });
      }

      // 计算距离（顶部信息卡展示）
      if (this._cachedMyLocation && this._cachedMyLocation.latitude) {
        this.setData({
          distance: util.formatDistance(util.calcDistance(
            this._cachedMyLocation.latitude, this._cachedMyLocation.longitude,
            partnerLoc.latitude, partnerLoc.longitude
          )),
        });
      }

      // 更新地图标记
      this._refreshMarkers();
      this._updatePolyline();

      this._startStaleCheck();
    };

    // ----- 标记管理 -----

    /**
     * 刷新地图标记（自动决定"建"还是"改"）
     *
     * - markers 里已有 'partner' → 单字段更新其坐标（高频路径，避免整表 setData）
     * - 没有 → 整表重建（首次、客户退出再进入、markers 丢失等场景）
     *
     * 整表重建时同步补上 destination 标记；polyline 由调用方负责
     */
    page._refreshMarkers = function () {
      const partnerLoc = this._cachedPartnerLocation;
      if (!partnerLoc || !partnerLoc.latitude) return;

      // 高频路径：partner 标记已存在 → 单字段更新
      const idx = this.data.markers.findIndex(m => m.id === 'partner');
      if (idx >= 0) {
        this.setData({
          [`markers[${idx}].latitude`]: partnerLoc.latitude,
          [`markers[${idx}].longitude`]: partnerLoc.longitude,
          [`markers[${idx}].rotate`]: partnerLoc.heading || 0,
        });
        return;
      }

      // 重建路径：partner 不存在（首次 / 退出再进入 / 丢失）
      const markers = [{
        id: 'partner',
        latitude: partnerLoc.latitude, longitude: partnerLoc.longitude,
        iconPath: '/images/marker-partner.svg',
        width: 28, height: 28,
        callout: {
          content: this._partnerLabel(),
          display: 'ALWAYS', fontSize: 12, borderRadius: 10,
          bgColor: '#07c160', padding: 6, textAlign: 'center', color: '#fff',
        },
        rotate: partnerLoc.heading || 0,
        anchor: { x: 0.5, y: 0.5 },
      }];
      // 目的地标记（如有）
      const dest = this.data.destination;
      if (dest && dest.latitude) {
        markers.push({
          id: 'destination',
          latitude: dest.latitude, longitude: dest.longitude,
          iconPath: '/images/marker-dest.svg',
          width: 32, height: 32,
          callout: {
            content: dest.name || '目的地',
            display: 'ALWAYS', fontSize: 12, borderRadius: 10,
            bgColor: '#f5a623', padding: 6, textAlign: 'center', color: '#fff',
          },
          anchor: { x: 0.5, y: 0.5 },
        });
      }
      this.setData({ markers });
      this._markersInited = true;
    };

    /**
     * 添加/更新目的地标记（markers 已初始化后，目的地变更时调用）
     * 已有则原地替换，没有则追加
     */
    page._upsertDestMarker = function () {
      const dest = this.data.destination;
      if (!dest || !dest.latitude) return;
      const markers = [...this.data.markers];
      const idx = markers.findIndex(m => m.id === 'destination');
      const marker = {
        id: 'destination',
        latitude: dest.latitude, longitude: dest.longitude,
        iconPath: '/images/marker-dest.svg', width: 32, height: 32,
        callout: {
          content: dest.name || '目的地', display: 'ALWAYS',
          fontSize: 12, borderRadius: 10, bgColor: '#f5a623',
          padding: 6, textAlign: 'center', color: '#fff',
        },
        anchor: { x: 0.5, y: 0.5 },
      };
      if (idx >= 0) markers[idx] = marker;
      else markers.push(marker);
      this.setData({ markers });
    };

    /**
     * 视野框选：首次同时拿到双方位置时，让地图完整显示自己、对方与目的地
     * 只触发一次，避免抢用户操作；少于两个有效点时静默跳过
     */
    page._fitToPartners = function () {
      const my = this._cachedMyLocation;
      const partner = this._cachedPartnerLocation;
      const dest = this.data.destination;
      const points = [];
      if (my && my.latitude) points.push({ latitude: my.latitude, longitude: my.longitude });
      if (partner && partner.latitude) points.push({ latitude: partner.latitude, longitude: partner.longitude });
      if (dest && dest.latitude) points.push({ latitude: dest.latitude, longitude: dest.longitude });
      if (points.length < 2) return;   // 少于两个点没有框选意义
      try {
        const mapCtx = wx.createMapContext('map', this);
        mapCtx.includePoints({ points, padding: [90, 60, 90, 60] });
        console.log(this._logPrefix() + ' 🗺️ 首次视野框选完成，共 ' + points.length + ' 个点');
      } catch (e) {
        console.warn('🗺️ includePoints 失败', e);
      }
    };

    /**
     * 更新连线（两点之间的绿色箭头线）
     * 双方都有位置时才显示
     */
    page._updatePolyline = function () {
      const myLoc = this._cachedMyLocation;
      const partnerLoc = this._cachedPartnerLocation;
      if (!myLoc || !partnerLoc || !myLoc.latitude || !partnerLoc.latitude) {
        this.setData({ polyline: [] });
        return;
      }
      this.setData({
        polyline: [{
          points: [
            { latitude: myLoc.latitude, longitude: myLoc.longitude },
            { latitude: partnerLoc.latitude, longitude: partnerLoc.longitude },
          ],
          color: '#07c160', width: 3, dottedLine: false, arrowLine: true,
        }],
      });
    };

    // ----- UI 定时刷新 -----

    /** 启动"距离上次更新"标签的定时器 */
    page._startUiTimer = function () {
      this._stopUiTimer();
      this._refreshUpdateTime();
      this._updateUiTimer = setInterval(() => this._refreshUpdateTime(), C.UI_REFRESH_INTERVAL);
    };

    /** 停止 UI 定时器 */
    page._stopUiTimer = function () {
      if (this._updateUiTimer) {
        clearInterval(this._updateUiTimer);
        this._updateUiTimer = null;
      }
    };

    /** 刷新时间标签（如"30秒前""2分钟前"），顶部信息卡"更新"字段依赖 */
    page._refreshUpdateTime = function () {
      if (this._lastPartnerTimestamp > 0) {
        this.setData({ partnerLastUpdate: util.formatTimeAgo(this._lastPartnerTimestamp) });
      }
    };

    // ----- 掉线检测 -----

    /**
     * 启动对方在线检测
     * 每 10s 检查一次：从最后更新时间到现在的间隔
     * - >30s → stale（对方位置暂未更新）
     * - >45s → offline（对方离线）
     *
     * 每次接收到新位置时重启计时器
     */
    page._startStaleCheck = function () {
      this._stopStaleCheck();
      this._staleCheckTimer = setInterval(() => {
        if (this._lastPartnerTimestamp <= 0) return;
        const elapsed = Date.now() - this._lastPartnerTimestamp;
        const isStale = elapsed > C.PARTNER_STALE_TIMEOUT;
        const isOffline = elapsed > C.PARTNER_OFFLINE_TIMEOUT;

        // 只在状态变化时 setData（避免无意义的渲染）
        if (isStale !== this._prevStale || isOffline !== !this.data.partnerOnline) {
          this._prevStale = isStale;
          this.setData({ partnerStale: isStale, partnerOnline: !isOffline });
          this._updateMarkerLabels();
        }
      }, C.STALE_CHECK_INTERVAL);
    };

    /** 更新标记上的文字：正常显示角色名，掉线时显示"暂未更新" */
    page._updateMarkerLabels = function () {
      const idx = this.data.markers.findIndex(m => m.id === 'partner');
      if (idx < 0) return;
      this.setData({
        [`markers[${idx}].callout.content`]: this.data.partnerStale ? '暂未更新' : this._partnerLabel(),
      });
    };

    /** 停止掉线检测 */
    page._stopStaleCheck = function () {
      if (this._staleCheckTimer) {
        clearInterval(this._staleCheckTimer);
        this._staleCheckTimer = null;
      }
    };

    /** 计算我到目的地的距离 */
    page._calcDestDistance = function () {
      const dest = this.data.destination;
      const myLoc = this._cachedMyLocation;
      if (!dest || !myLoc || !myLoc.latitude) { return; }
      const d = util.calcDistance(myLoc.latitude, myLoc.longitude, dest.latitude, dest.longitude);
      this.setData({ destDistance: util.formatDistance(d) });
    };

    // ----- 通用清理 -----

    /**
     * 清理所有重试定时器
     * 在 onUnload 时调用
     */
    page._clearRetryTimers = function () {
      if (this._backgroundTimer) {
        clearTimeout(this._backgroundTimer);
        this._backgroundTimer = null;
      }
      this._watchPartnerRetryCount = 0;
      this._watchRoomRetryCount = 0;
    };

    /** 显示定位错误信息 */
    page._showLocationError = function (msg) {
      console.warn('⚠️ ' + msg);
      this.setData({ locationError: msg });
    };

    // ----- 生命周期处理（页面 onShow/onHide/onUnload/onBack 统一委托）-----

    /**
     * 页面 onShow 统一处理
     * - 无房间信息 → 静默返回
     * - 非 active 状态 → 仅 ended 时提示"共享已结束"，其余静默返回
     * - active 状态 → 恢复前台定位 + 启动 UI 刷新定时器
     */
    page._handleShow = function () {
      const room = getApp().globalData.currentRoom;
      if (!room) return;
      if (room.status !== 'active') {
        if (room.status === 'ended') this._showLocationError('共享已结束');
        return;
      }
      this._startUiTimer();
    };

    /** 页面 onHide 统一处理：停止 UI 刷新定时器（后台定位通道持续运行，无需切换） */
    page._handleHide = function () {
      this._stopUiTimer();
    };

    /**
     * 页面 onUnload 统一清理
     * 停止定位、关闭 watch、停止定时器、重置状态
     * @param {string} [prefix] - 页面日志前缀（如 '🚗 [driver-map]'）
     */
    page._handleUnload = function (prefix) {
      if (prefix) console.log(prefix + 'onUnload');
      this._cleanup();
    };

    /** 页面 onBack 统一处理 */
    page._handleBack = function () {
      wx.navigateBack();
    };

    // ----- 通用事件 -----

    /**
     * 重试获取位置：重新申请权限（若之前被拒会跳转设置页）
     * 权限恢复后由后台定位回调自动更新地图，无需主动拉取
     */
    page.onRetryLocation = function () {
      this.setData({ locationError: '' });
      locationService.requestPermission().then(granted => {
        if (!granted) {
          this._showLocationError('定位权限被拒绝，请在设置中开启');
          return;
        }
      });
    };

    /** 地图缩放事件 */
    page.onScaleChange = function (e) {
      if (e.detail.scale) this.data.mapScale = e.detail.scale;
    };

    /** 地图拖拽开始 → 标记用户交互，停止自动移动中心（仅用户手势，代码 setData 触发的 update 不计入） */
    page.onRegionChange = function (e) {
      if (e.type === 'begin' && e.causedBy === 'gesture') {
        this._userInteracted = true;
      }
    };

    /** 回到我的位置 */
    page.onCenterSelf = function () {
      if (!this._cachedMyLocation || !this._cachedMyLocation.latitude) return;
      this._userInteracted = false;
      this.setData({ myLocation: this._cachedMyLocation, mapScale: 16 });
    };
  },
};
