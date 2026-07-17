/**
 * 地图共享模块 - 位置共享所有通用逻辑
 * driver-map 和 customer-map 共用
 */
const locationService = require('./location');
const roomService = require('./room');
const util = require('../utils/util');

module.exports = {
  CONSTANTS: {
    PARTNER_STALE_TIMEOUT: 30000,
    PARTNER_OFFLINE_TIMEOUT: 45000,
    STALE_CHECK_INTERVAL: 10000,
    UI_REFRESH_INTERVAL: 1000,
    PARTNER_UPDATE_THROTTLE: 5000,
  },

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
    };
  },

  getDefaultFields() {
    return {
      roomId: '',
      userId: '',
      _staleCheckTimer: null,
      _updateUiTimer: null,
      _locationWatchTimer: null,
      _pollingGuard: false,
      _unwatchLocation: null,
      _roomStatusWatcher: null,
      _roomStatusPollTimer: null,
      _roomStatusPollStopped: false,
      _lastPartnerTimestamp: 0,
      _lastPartnerTick: 0,
      _watchPartnerRetryCount: 0,
      _watchPartnerRetryTimer: null,
      _watchRoomRetryCount: 0,
      _watchRoomRetryTimer: null,
      _partnerRawData: null,
      _cachedMyLocation: null,
      _cachedPartnerLocation: null,
      _markersInited: false,
      _prevStale: false,
      _userInteracted: false,
    };
  },

  /** 将共享方法混入页面实例 */
  mixin(page) {
    const C = this.CONSTANTS;

    // ====== 初始化 ======
    page._resetState = function () {
      this._cachedMyLocation = null;
      this._cachedPartnerLocation = null;
      this._markersInited = false;
      this._prevStale = false;
      this._userInteracted = false;
    };

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

    // ====== 权限 & 定位 ======

    page._requestPermissions = async function (role) {
      const granted = await locationService.requestPermission();
      if (!granted) { this._showLocationError('定位权限被拒绝，请在设置中开启'); return; }

      locationService.checkPermission().then(perm => {
        if (!perm.background) {
          setTimeout(() => locationService.requestBackgroundPermission().catch(() => {}), 3000);
        }
      });

      this._startLocationServices();
      this._startWatchingPartner();
      this._watchRoomEnded(role);

      this._backgroundTimer = setTimeout(() => {
        this._backgroundTimer = null;
        locationService.startBackgroundUpdate(this.roomId, this.userId);
      }, 5000);
    };

    page._startLocationServices = function () {
      const cb = (loc) => { if (loc) this._onMyLocationUpdate(loc); };
      locationService.startUpdating(this.roomId, this.userId, cb, { foreground: true });
    };

    // ====== 对方位置监听 ======

    page._startWatchingPartner = function () {
      this._watchPartnerRetryCount = 0;
      this._unwatchLocation = roomService.watchPartnerLocation(
        this.roomId, this.userId,
        (data) => {
          this.setData({ wsConnected: true });
          this._onPartnerLocationUpdate(data);
        },
        (status) => {
          if (status.connected) { this.setData({ wsConnected: true }); this._watchPartnerRetryCount = 0; }
          else { this.setData({ wsConnected: false }); this._scheduleWatchPartnerRetry(); }
        }
      );
      this._startPollingPartner();
    };

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
          } catch (err) { console.warn('⚠️ 轮询失败', err.errMsg || err.message || err); }
          poll();
        }, 5000);
      };
      poll();
    };

    page._stopPolling = function () {
      this._pollingStopped = true;
      this._pollingGuard = false;
      if (this._locationWatchTimer) { clearTimeout(this._locationWatchTimer); this._locationWatchTimer = null; }
    };

    page._scheduleWatchPartnerRetry = function () {
      this._watchPartnerRetryCount = (this._watchPartnerRetryCount || 0) + 1;
      const delay = Math.min(1000 * Math.pow(2, this._watchPartnerRetryCount - 1), 30000);
      this._watchPartnerRetryTimer = setTimeout(() => {
        this._watchPartnerRetryTimer = null;
        if (!this._unwatchLocation && this.roomId) this._startWatchingPartner();
      }, delay);
    };

    // ====== 房间 ended 监听 ======

    page._watchRoomEnded = function (role) {
      if (!this.roomId) return;
      if (this._roomStatusWatcher) { this._roomStatusWatcher.close(); this._roomStatusWatcher = null; }
      this._watchRoomRetryCount = 0;
      const db = wx.cloud.database();
      const prefix = role === 'driver' ? '🚗' : '👤';
      this._roomStatusWatcher = db.collection('rooms').doc(this.roomId).watch({
        onChange: (snapshot) => {
          if (snapshot.type === 'init') return;
          this._watchRoomRetryCount = 0;
          const room = snapshot.docs && snapshot.docs[0];
          if (room && room.status === 'ended') {
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

    page._startPollingRoomEnded = function (prefix) {
      if (!this.roomId) return;
      this._roomStatusPollStopped = false;
      if (this._roomStatusPollTimer) { clearTimeout(this._roomStatusPollTimer); this._roomStatusPollTimer = null; }
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

    page._stopPollingRoomEnded = function () {
      this._roomStatusPollStopped = true;
      if (this._roomStatusPollTimer) { clearTimeout(this._roomStatusPollTimer); this._roomStatusPollTimer = null; }
    };

    page._scheduleWatchRoomRetry = function () {
      this._watchRoomRetryCount = (this._watchRoomRetryCount || 0) + 1;
      const delay = Math.min(1000 * Math.pow(2, this._watchRoomRetryCount - 1), 30000);
      this._watchRoomRetryTimer = setTimeout(() => {
        this._watchRoomRetryTimer = null;
        if (!this._roomStatusWatcher && this.roomId) this._watchRoomEnded();
      }, delay);
    };

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

    page._unwatch = function () {
      if (this._unwatchLocation) { this._unwatchLocation(); this._unwatchLocation = null; }
      if (this._roomStatusWatcher) { this._roomStatusWatcher.close(); this._roomStatusWatcher = null; }
      this._stopPollingRoomEnded();
    };

    // ====== 位置更新 ======

    page._onMyLocationUpdate = function (loc) {
      if (!loc) return;
      const myLoc = { latitude: loc.latitude, longitude: loc.longitude, heading: loc.heading || 0, speed: loc.speed || 0 };
      this._cachedMyLocation = myLoc;
      const updateData = {};
      if (this.data.locationError) updateData.locationError = '';
      if (this.data.isFirstLoad) updateData.isFirstLoad = false;
      if (!this._userInteracted) updateData.myLocation = myLoc;
      if (Object.keys(updateData).length > 0) this.setData(updateData);
      if (this._markersInited) { this._updateMarkerPositions(); this._updatePolyline(); }
      else { this._initMapMarkers(); }
    };

    page._onPartnerLocationUpdate = function (data) {
      if (!data) return;
      const now = Date.now();
      if (now - this._lastPartnerTick < C.PARTNER_UPDATE_THROTTLE) return;
      this._lastPartnerTick = now;
      this._lastPartnerTimestamp = data._timestamp || now;
      this._partnerRawData = data;
      const partnerLoc = { latitude: data.latitude, longitude: data.longitude, heading: data.heading || 0, speed: data.speed || 0 };
      this._cachedPartnerLocation = partnerLoc;
      this.setData({ partnerLocation: partnerLoc, partnerOnline: true, partnerStale: false });
      if (this._cachedMyLocation && this._cachedMyLocation.latitude) {
        this.setData({ distance: util.formatDistance(util.calcDistance(
          this._cachedMyLocation.latitude, this._cachedMyLocation.longitude,
          partnerLoc.latitude, partnerLoc.longitude
        ))});
      }
      if (!this._markersInited || this.data.markers.length < 1) this._initMapMarkers();
      else { this._updateMarkerPositions(); this._updatePolyline(); }
      this._startStaleCheck();
    };

    // ====== 标记管理 ======

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
          iconPath: this.data.partnerInfo.avatarUrl || '/images/marker-partner.svg', width: 28, height: 28,
          callout: { content: this.data.partnerInfo.nickName || '', display: 'ALWAYS', fontSize: 12, borderRadius: 10, bgColor: '#07c160', padding: 6, textAlign: 'center', color: '#fff' },
          rotate: partnerLoc.heading || 0, anchor: { x: 0.5, y: 0.5 },
        });
      }
      this.setData({ markers });
      if (partnerLoc && partnerLoc.latitude) this._markersInited = true;
      this._updatePolyline();
    };

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

    page._updatePolyline = function () {
      const myLoc = this._cachedMyLocation;
      const partnerLoc = this._cachedPartnerLocation;
      if (!myLoc || !partnerLoc || !myLoc.latitude || !partnerLoc.latitude) {
        this.setData({ polyline: [] }); return;
      }
      this.setData({
        polyline: [{
          points: [{ latitude: myLoc.latitude, longitude: myLoc.longitude }, { latitude: partnerLoc.latitude, longitude: partnerLoc.longitude }],
          color: '#07c160', width: 3, dottedLine: false, arrowLine: true,
        }],
      });
    };

    // ====== UI + 在线检测 ======

    page._startUiTimer = function () {
      this._stopUiTimer();
      this._refreshUpdateTime();
      this._updateUiTimer = setInterval(() => this._refreshUpdateTime(), C.UI_REFRESH_INTERVAL);
    };

    page._stopUiTimer = function () { if (this._updateUiTimer) { clearInterval(this._updateUiTimer); this._updateUiTimer = null; } };

    page._refreshUpdateTime = function () {
      if (this._lastPartnerTimestamp > 0) {
        this.setData({ partnerLastUpdate: util.formatTimeAgo(this._lastPartnerTimestamp) });
      }
    };

    page._startStaleCheck = function () {
      this._stopStaleCheck();
      this._staleCheckTimer = setInterval(() => {
        if (this._lastPartnerTimestamp <= 0) return;
        const elapsed = Date.now() - this._lastPartnerTimestamp;
        const isStale = elapsed > C.PARTNER_STALE_TIMEOUT;
        const isOffline = elapsed > C.PARTNER_OFFLINE_TIMEOUT;
        if (isStale !== this._prevStale || isOffline !== !this.data.partnerOnline) {
          this._prevStale = isStale;
          this.setData({ partnerStale: isStale, partnerOnline: !isOffline });
          this._updateMarkerLabels();
        }
      }, C.STALE_CHECK_INTERVAL);
    };

    page._updateMarkerLabels = function () {
      const idx = this.data.markers.findIndex(m => m.id === 'partner');
      if (idx < 0) return;
      const label = this.data.partnerStale ? '暂未更新' : (this.data.partnerInfo.nickName || '');
      const content = this.data.partnerLastUpdate ? label + ' · ' + this.data.partnerLastUpdate : label;
      this.setData({ [`markers[${idx}].callout.content`]: content });
    };

    page._stopStaleCheck = function () { if (this._staleCheckTimer) { clearInterval(this._staleCheckTimer); this._staleCheckTimer = null; } };

    // ====== 通用清理 ======

    page._clearRetryTimers = function () {
      if (this._backgroundTimer) { clearTimeout(this._backgroundTimer); this._backgroundTimer = null; }
      if (this._watchPartnerRetryTimer) { clearTimeout(this._watchPartnerRetryTimer); this._watchPartnerRetryTimer = null; }
      if (this._watchRoomRetryTimer) { clearTimeout(this._watchRoomRetryTimer); this._watchRoomRetryTimer = null; }
      this._watchPartnerRetryCount = 0;
      this._watchRoomRetryCount = 0;
    };

    page._showLocationError = function (msg) {
      console.warn('⚠️ ' + msg);
      this.setData({ locationError: msg });
    };

    // ====== 通用事件 ======

    page.onMarkerTap = function (e) {
      if (e.detail.markerId === 'self') return;
      this.setData({
        showPartnerDetail: true,
        partnerSpeed: this._partnerRawData ? (this._partnerRawData.speed || 0).toFixed(1) : '0',
        partnerHeading: this._partnerRawData ? Math.round(this._partnerRawData.heading || 0) + '°' : '0°',
      });
    };

    page.onCloseDetail = function () { this.setData({ showPartnerDetail: false }); };

    page.onRetryLocation = function () {
      this.setData({ locationError: '' });
      locationService.requestPermission().then(granted => {
        if (!granted) { this._showLocationError('定位权限被拒绝，请在设置中开启'); return; }
        locationService.getCurrentPosition().then(loc => {
          if (loc) this._onMyLocationUpdate(loc);
          else this._showLocationError('获取位置失败，请检查 GPS 信号');
        });
      });
    };

    page.onScaleChange = function (e) { if (e.detail.scale) this.data.mapScale = e.detail.scale; };
    page.onRegionChange = function (e) { if (e.type === 'begin') this._userInteracted = true; };

    page.onCenterSelf = function () {
      if (!this._cachedMyLocation || !this._cachedMyLocation.latitude) return;
      this._userInteracted = false;
      this.setData({ myLocation: this._cachedMyLocation, mapScale: 16 });
    };
  },
};
