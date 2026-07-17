/**
 * 地图共享模块
 * ============
 * driver-map 和 customer-map 的通用逻辑抽离
 *
 * 职责边界：
 * - 定位服务启动           ✓（委托 location.js）
 * - 对方位置监听+轮询      ✓
 * - 房间 ended 监听+轮询   ✓
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

module.exports = {
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
      partnerSpeed: '0',
      partnerHeading: '0',
      distance: null,
      locationError: '',
      partnerStale: false,
      showPartnerDetail: false,
      isFirstLoad: true,
      destination: null,          // 救援目的地 { name, address, latitude, longitude }
      destDistance: null,         // 我到目的地的距离
    };
  },

  // ============================================================
  // 页面私有字段默认值（不在 data 中，不触发渲染）
  // ============================================================
  getDefaultFields() {
    return {
      roomId: '',
      userId: '',
      _staleCheckTimer: null,         // 掉线检测 interval id
      _updateUiTimer: null,            // UI 刷新 interval id
      _locationWatchTimer: null,       // 位置轮询 setTimeout id
      _pollingGuard: false,            // 防重复启动轮询
      _unwatchLocation: null,          // 位置 watch 的取消函数
      _roomStatusWatcher: null,        // 房间 ended watch 实例
      _roomStatusPollTimer: null,      // 房间 ended 轮询 timer
      _roomStatusPollStopped: false,   // 房间轮询停止标记（比 clearTimeout 可靠）
      _lastPartnerTimestamp: 0,        // 对方最后一次位置更新时间戳
      _lastPartnerTick: 0,             // 节流用时间戳
      _watchPartnerRetryCount: 0,      // 位置 watch 重试计数（指数退避）
      _watchPartnerRetryTimer: null,   // 位置 watch 重试 timer
      _watchRoomRetryCount: 0,         // 房间 watch 重试计数
      _watchRoomRetryTimer: null,      // 房间 watch 重试 timer
      _partnerRawData: null,           // 对方位置原始数据（用于弹窗显示）
      _cachedMyLocation: null,         // 缓存自己的位置（避免频繁读 data）
      _cachedPartnerLocation: null,    // 缓存对方位置
      _markersInited: false,           // 标记是否已初始化
      _prevStale: false,               // 上一次掉线状态（检测变化用）
      _userInteracted: false,          // 用户是否拖拽过地图
    };
  },

  // ============================================================
  // mixin(page)
  // 核心方法：将 20+ 个共享方法注入页面实例
  // 页面 onLoad 时调用一次即可
  //
  // 注入后页面拥有全部 _requestPermissions、_startWatchingPartner 等
  // 生命周期 onShow/onHide/onUnload 仍需页面自己编写
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

    /**
     * 请求定位权限 + 启动所有服务
     * 这是整个位置共享的入口点
     *
     * 启动顺序（重要）：
     * 1. requestPermission            ← 前台定位授权（阻塞）
     * 2. checkPermission → 后台授权   ← 可选，不阻塞
     * 3. startLocationServices        ← 开始定位+上报
     * 4. startWatchingPartner         ← 监听对方位置（watch+轮询）
     * 5. watchRoomEnded               ← 监听共享结束
     * 6. startBackgroundUpdate(延迟5s)← 后台定位，与 startLocation 错开频率限制
     *
     * @param {string} role - 'driver' | 'customer'（仅用于日志前缀）
     */
    page._requestPermissions = async function (role) {
      const granted = await locationService.requestPermission();
      if (!granted) {
        this._showLocationError('定位权限被拒绝，请在设置中开启');
        return;
      }

      // 后台权限可选，先让地图出来再弹
      locationService.checkPermission().then(perm => {
        if (!perm.background) {
          setTimeout(() => locationService.requestBackgroundPermission().catch(() => {}), 3000);
        }
      });

      this._startLocationServices();
      this._startWatchingPartner();
      this._watchRoomEnded(role);

      // 延迟启动后台定位，避免与 startLocationUpdate 撞 -13000 频率限制
      this._backgroundTimer = setTimeout(() => {
        this._backgroundTimer = null;
        locationService.startBackgroundUpdate(this.roomId, this.userId);
      }, 5000);
    };

    /**
     * 启动位置上报 + 本地地图更新
     * - 立即采一次高精度位置
     * - 注册 wx.onLocationChange 持续监听
     * - 定时轮询上报（前台5s/后台15s）
     */
    page._startLocationServices = function () {
      const cb = (loc) => { if (loc) this._onMyLocationUpdate(loc); };
      locationService.startUpdating(this.roomId, this.userId, cb, { foreground: true });
    };

    // ----- 对方位置监听 -----

    /**
     * 监听对方位置变化
     * 双通道：watch（实时推送） + polling（5s轮询兜底）
     *
     * watch 不可用时自动降级到轮询
     * 轮询有 _pollingGuard + _pollingStopped 防双循环
     */
    page._startWatchingPartner = function () {
      this._watchPartnerRetryCount = 0;
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
            this.setData({ wsConnected: true });
            this._watchPartnerRetryCount = 0;
          } else {
            this.setData({ wsConnected: false });
            this._scheduleWatchPartnerRetry();
          }
        }
      );
      this._startPollingPartner();
    };

    /**
     * 位置轮询（watch 兜底）
     * 查 locations 集合中对方的文档（userId 不等于自己）
     */
    page._startPollingPartner = function () {
      if (this._pollingGuard) return;
      this._pollingGuard = true;
      this._pollingStopped = false;
      const poll = () => {
        if (this._pollingStopped) return;
        this._locationWatchTimer = setTimeout(async () => {
          if (this._pollingStopped) return;
          try {
            const db = wx.cloud.database();
            const res = await db.collection('locations')
              .where({ roomId: this.roomId, userId: db.command.neq(this.userId) }).get();
            if (res.data && res.data.length > 0) this._onPartnerLocationUpdate(res.data[0]);
          } catch (err) {
            console.warn('⚠️ 轮询失败', err.errMsg || err.message || err);
          }
          poll();
        }, 5000);
      };
      poll();
    };

    /** 停止位置轮询 */
    page._stopPolling = function () {
      this._pollingStopped = true;
      this._pollingGuard = false;
      if (this._locationWatchTimer) {
        clearTimeout(this._locationWatchTimer);
        this._locationWatchTimer = null;
      }
    };

    /**
     * 位置 watch 重试（指数退避）
     * 1s → 2s → 4s → ... → 30s 封顶
     * 仅当 _unwatchLocation 为 null（watch 已断开）时才重试
     */
    page._scheduleWatchPartnerRetry = function () {
      this._watchPartnerRetryCount = (this._watchPartnerRetryCount || 0) + 1;
      const delay = Math.min(1000 * Math.pow(2, this._watchPartnerRetryCount - 1), 30000);
      this._watchPartnerRetryTimer = setTimeout(() => {
        this._watchPartnerRetryTimer = null;
        if (!this._unwatchLocation && this.roomId) this._startWatchingPartner();
      }, delay);
    };

    // ----- 房间 ended 监听 -----

    /**
     * 监听房间 ended 状态
     * 当对方结束救援时，自动返回首页
     * watch（实时） + polling（5s轮询兜底）
     *
     * @param {string} role - 'driver' | 'customer'
     */
    page._watchRoomEnded = function (role) {
      if (!this.roomId) return;
      // 关闭旧 watcher 防止泄漏
      if (this._roomStatusWatcher) {
        this._roomStatusWatcher.close();
        this._roomStatusWatcher = null;
      }
      this._watchRoomRetryCount = 0;
      const db = wx.cloud.database();
      const prefix = role === 'driver' ? '🚗' : '👤';
      this._roomStatusWatcher = db.collection('rooms').doc(this.roomId).watch({
        onChange: (snapshot) => {
          // 跳过 type=init（初始快照），只处理真实变更
          if (snapshot.type === 'init') return;
          this._watchRoomRetryCount = 0;
          const room = snapshot.docs && snapshot.docs[0];
          if (!room) return;
          // 检测目的地更新
          if (room.destination && room.destination.latitude) {
            this.setData({ destination: room.destination });
            this._initMapMarkers();
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
          this._scheduleWatchRoomRetry();
        },
      });
      this._startPollingRoomEnded(prefix);
    };

    /**
     * 房间 ended 轮询兜底
     * 每5s查一次 rooms 集合，检测到 ended 就退出
     */
    page._startPollingRoomEnded = function (prefix) {
      if (!this.roomId) return;
      this._roomStatusPollStopped = false;
      if (this._roomStatusPollTimer) {
        clearTimeout(this._roomStatusPollTimer);
        this._roomStatusPollTimer = null;
      }
      const poll = () => {
        if (this._roomStatusPollStopped) return;
        this._roomStatusPollTimer = setTimeout(async () => {
          if (this._roomStatusPollStopped) return;
          try {
            const db = wx.cloud.database();
            const room = (await db.collection('rooms').doc(this.roomId).get()).data;
            if (room && room.status === 'ended') {
              console.log(prefix + ' 🔚 (轮询) 对方已结束救援');
              this._onRoomEnded();
              return;
            }
          } catch (_) {}
          poll();
        }, 5000);
      };
      poll();
    };

    /** 停止房间 ended 轮询 */
    page._stopPollingRoomEnded = function () {
      this._roomStatusPollStopped = true;
      if (this._roomStatusPollTimer) {
        clearTimeout(this._roomStatusPollTimer);
        this._roomStatusPollTimer = null;
      }
    };

    /**
     * 房间 watch 重试（指数退避）
     * 规则同位置 watch 重试
     */
    page._scheduleWatchRoomRetry = function () {
      this._watchRoomRetryCount = (this._watchRoomRetryCount || 0) + 1;
      const delay = Math.min(1000 * Math.pow(2, this._watchRoomRetryCount - 1), 30000);
      this._watchRoomRetryTimer = setTimeout(() => {
        this._watchRoomRetryTimer = null;
        if (!this._roomStatusWatcher && this.roomId) this._watchRoomEnded();
      }, delay);
    };

    /**
     * 共享结束处理
     * 清理所有资源：watch、轮询、定位、定时器、房间数据
     * 然后返回上一页
     */
    page._onRoomEnded = function () {
      console.log('🔚 共享已结束');
      this._unwatch();
      locationService.stopUpdating();
      this._stopStaleCheck();
      this._stopUiTimer();
      this._stopPolling();
      this._clearRetryTimers();
      this._resetState();
      getApp().clearRoom();
      wx.showToast({ title: '救援已结束', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
    };

    /**
     * 统一关闭所有监听器
     * 包括：位置 watch、房间 watch、房间轮询
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
      this._stopPollingRoomEnded();
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
        heading: loc.heading || 0, speed: loc.speed || 0,
      };
      this._cachedMyLocation = myLoc;

      const updateData = {};
      if (this.data.locationError) updateData.locationError = '';
      if (this.data.isFirstLoad) updateData.isFirstLoad = false;
      // 用户拖拽过地图时不自动移动中心
      if (!this._userInteracted) updateData.myLocation = myLoc;

      if (Object.keys(updateData).length > 0) this.setData(updateData);

      if (this._markersInited) {
        this._updateMarkerPositions();
        this._updatePolyline();
      } else {
        this._initMapMarkers();
      }
    };

    /**
     * 对方位置更新
     * 由 watch 或 polling 触发
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

      // 计算距离
      if (this._cachedMyLocation && this._cachedMyLocation.latitude) {
        this.setData({
          distance: util.formatDistance(util.calcDistance(
            this._cachedMyLocation.latitude, this._cachedMyLocation.longitude,
            partnerLoc.latitude, partnerLoc.longitude
          )),
        });
      }

      // 更新地图标记
      if (!this._markersInited || this.data.markers.length < 1) {
        this._initMapMarkers();
      } else {
        this._updateMarkerPositions();
        this._updatePolyline();
      }
      this._startStaleCheck();
    };

    // ----- 标记管理 -----

    /**
     * 初始化地图标记
     * 只在首次获取到双方位置时执行一次
     * 用 _markersInited 防止重复初始化
     *
     * 标记布局：
     * - partner（绿色）：对方位置，名称+更新时间
     * - 自己的位置通过 map 组件的 show-location 显示蓝点
     */
    page._initMapMarkers = function () {
      if (this._markersInited) return;
      const myLoc = this._cachedMyLocation || this.data.myLocation;
      const partnerLoc = this._cachedPartnerLocation;
      if (!myLoc || !myLoc.latitude) return;

      const markers = [];
      if (partnerLoc && partnerLoc.latitude) {
        markers.push({
          id: 'partner',
          latitude: partnerLoc.latitude, longitude: partnerLoc.longitude,
          iconPath: this.data.partnerInfo.avatarUrl || '/images/marker-partner.svg',
          width: 28, height: 28,
          callout: {
            content: this.data.partnerInfo.nickName || '',
            display: 'ALWAYS', fontSize: 12, borderRadius: 10,
            bgColor: '#07c160', padding: 6, textAlign: 'center', color: '#fff',
          },
          rotate: partnerLoc.heading || 0,
          anchor: { x: 0.5, y: 0.5 },
        });
      }
      // 目的地标记
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
      if (partnerLoc && partnerLoc.latitude) this._markersInited = true;
      this._updatePolyline();
    };

    /**
     * 更新标记位置（高频调用）
     * 用 findIndex 按 id 查找，不硬编码下标
     */
    page._updateMarkerPositions = function () {
      if (!this._markersInited) return;
      const partnerLoc = this._cachedPartnerLocation;
      if (partnerLoc && partnerLoc.latitude) {
        const idx = this.data.markers.findIndex(m => m.id === 'partner');
        if (idx < 0) return;
        this.setData({
          [`markers[${idx}].latitude`]: partnerLoc.latitude,
          [`markers[${idx}].longitude`]: partnerLoc.longitude,
          [`markers[${idx}].rotate`]: partnerLoc.heading || 0,
        });
      }
    };

    /**
     * 更新连线（两点之间的绿色箭头线）
     * 双方都有位置时才显示
     */
    /** 添加/更新目的地标记（客户设置后立即调用） */
    page._updateDestinationMarker = function () {
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
      if (idx >= 0) {
        markers[idx] = { ...markers[idx], ...marker };
      } else {
        markers.push(marker);
      }
      this.setData({ markers });
      this._markersInited = true;
    };

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

    /** 启动"距离上次更新"标签的 1s 定时器 */
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

    /** 刷新时间标签（如"30秒前""2分钟前"） */
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

    /** 更新标记上的文字标签（名称+时间/暂未更新） */
    page._updateMarkerLabels = function () {
      const idx = this.data.markers.findIndex(m => m.id === 'partner');
      if (idx < 0) return;
      const label = this.data.partnerStale
        ? '暂未更新'
        : (this.data.partnerInfo.nickName || '');
      const content = this.data.partnerLastUpdate
        ? label + ' · ' + this.data.partnerLastUpdate
        : label;
      this.setData({ [`markers[${idx}].callout.content`]: content });
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
      if (this._watchPartnerRetryTimer) {
        clearTimeout(this._watchPartnerRetryTimer);
        this._watchPartnerRetryTimer = null;
      }
      if (this._watchRoomRetryTimer) {
        clearTimeout(this._watchRoomRetryTimer);
        this._watchRoomRetryTimer = null;
      }
      this._watchPartnerRetryCount = 0;
      this._watchRoomRetryCount = 0;
    };

    /** 显示定位错误信息 */
    page._showLocationError = function (msg) {
      console.warn('⚠️ ' + msg);
      this.setData({ locationError: msg });
    };

    // ----- 通用事件 -----

    /** 点击对方标记 → 显示详情弹窗 */
    page.onMarkerTap = function (e) {
      if (e.detail.markerId === 'self') return;
      this.setData({
        showPartnerDetail: true,
        partnerSpeed: this._partnerRawData
          ? (this._partnerRawData.speed || 0).toFixed(1) : '0',
        partnerHeading: this._partnerRawData
          ? Math.round(this._partnerRawData.heading || 0) + '°' : '0°',
      });
    };

    /** 关闭详情弹窗 */
    page.onCloseDetail = function () {
      this.setData({ showPartnerDetail: false });
    };

    /**
     * 重试获取位置
     * 先重新申请权限（如果之前被拒，会跳转设置页）
     * 有权限后再调 getCurrentPosition
     */
    page.onRetryLocation = function () {
      this.setData({ locationError: '' });
      locationService.requestPermission().then(granted => {
        if (!granted) {
          this._showLocationError('定位权限被拒绝，请在设置中开启');
          return;
        }
        locationService.getCurrentPosition().then(loc => {
          if (loc) this._onMyLocationUpdate(loc);
          else this._showLocationError('获取位置失败，请检查 GPS 信号');
        });
      });
    };

    /** 地图缩放事件 */
    page.onScaleChange = function (e) {
      if (e.detail.scale) this.data.mapScale = e.detail.scale;
    };

    /** 地图拖拽开始 → 标记用户交互，停止自动移动中心 */
    page.onRegionChange = function (e) {
      if (e.type === 'begin') this._userInteracted = true;
    };

    /** 回到我的位置 */
    page.onCenterSelf = function () {
      if (!this._cachedMyLocation || !this._cachedMyLocation.latitude) return;
      this._userInteracted = false;
      this.setData({ myLocation: this._cachedMyLocation, mapScale: 16 });
    };
  },
};
