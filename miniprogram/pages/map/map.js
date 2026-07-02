/**
 * 地图页 - 核心位置共享页面
 *
 * 功能：
 * - 实时显示拖车司机和客户的位置
 * - 自动调整地图显示范围
 * - 方向指示、距离计算
 * - 后台定位支持
 */
const app = getApp();
const locationService = require('../../services/location');
const roomService = require('../../services/room');
const util = require('../../utils/util');

// 对方位置未更新超时（毫秒）
const PARTNER_STALE_TIMEOUT = 30000;
const PARTNER_OFFLINE_TIMEOUT = 45000;
// 定时器检查间隔
const STALE_CHECK_INTERVAL = 10000;
const UI_REFRESH_INTERVAL = 1000;
// 对方位置节流（watch 推送过滤）
const PARTNER_UPDATE_THROTTLE = 5000;

Page({
  data: {
    myLocation: { latitude: 0, longitude: 0, heading: 0, speed: 0 },
    partnerLocation: null,
    mapScale: 15,
    markers: [],
    polyline: [],
    satelliteMode: false,
    partnerInfo: { nickName: '客户', avatarUrl: '' },
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
  },

  roomId: '',
  userId: '',
  _staleCheckTimer: null,
  _updateUiTimer: null,
  _locationWatchTimer: null,
  _unwatchLocation: null,
  _roomStatusWatcher: null,
  _roomStatusPollTimer: null,
  _lastPartnerTimestamp: 0,
  _lastPartnerTick: 0,
  _partnerRawData: null,
  _cachedMyLocation: null,
  _cachedPartnerLocation: null,
  _markersInited: false,
  _prevStale: false,
  _userInteracted: false,

  onLoad() {
    console.log('🗺️ [map] onLoad roomId=' + (app.globalData.currentRoom ? app.globalData.currentRoom.roomId.slice(0, 20) : '无'));
    this._resetState();
    this._initRoom();
    this._requestPermissions();
  },

  onShow() {
    console.log('🗺️ [map] onShow');
    const room = app.globalData.currentRoom;
    if (!room || room.status !== 'active') {
      console.warn('🗺️ [map] ⚠️ 配对已结束');
      this._showLocationError('配对已结束');
      return;
    }
    if (this.roomId && this.userId) {
      locationService.onForeground(this.roomId, this.userId);
    }
    this._startUiTimer();
  },

  onHide() {
    console.log('🗺️ [map] onHide');
    if (this.roomId && this.userId) {
      locationService.onBackground(this.roomId, this.userId);
    }
    this._stopUiTimer();
  },

  onUnload() {
    console.log('🗺️ [map] onUnload 清理');
    locationService.stopUpdating();
    this._unwatch();
    this._stopStaleCheck();
    this._stopUiTimer();
    this._stopPolling();
    this._resetState();
  },

  // ====== 事件 ======

  onMarkerTap(e) {
    if (e.detail.markerId === 'self') return;
    this.setData({
      showPartnerDetail: true,
      partnerSpeed: this._partnerRawData ? (this._partnerRawData.speed || 0).toFixed(1) : '0',
      partnerHeading: this._partnerRawData ? Math.round(this._partnerRawData.heading || 0) + '°' : '0°',
    });
  },

  onCloseDetail() {
    this.setData({ showPartnerDetail: false });
  },

  /** 返回首页 */
  onBack() {
    wx.navigateBack();
  },

  onEndShare() {
    wx.showModal({
      title: '结束救援',
      content: '确定要结束救援吗？客户将不再看到你的位置。',
      confirmColor: '#fa5151',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          wx.showLoading({ title: '结束救援...' });
          await roomService.leaveRoom(this.roomId);
          wx.hideLoading();
          wx.navigateBack({ delta: 2 });
        } catch (err) {
          wx.hideLoading();
          console.error('结束救援失败', err);
          app.clearRoom();
          wx.navigateBack({ delta: 2 });
        }
      },
    });
  },

  onRetryLocation() {
    this.setData({ locationError: '' });
    locationService.getCurrentPosition().then(loc => {
      if (loc) {
        this._onMyLocationUpdate(loc);
      } else {
        this._showLocationError('获取位置失败，请检查 GPS 和权限设置');
      }
    });
  },

  onZoomIn() {
    this.setData({ mapScale: Math.min(this.data.mapScale + 1, 20) });
  },

  onZoomOut() {
    this.setData({ mapScale: Math.max(this.data.mapScale - 1, 3) });
  },

  onToggleSatellite() {
    this.setData({ satelliteMode: !this.data.satelliteMode });
  },

  onScaleChange(e) {
    if (e.detail.scale) {
      this.data.mapScale = e.detail.scale;
      console.log('🗺️ [map] scale=' + e.detail.scale);
    }
  },

  onRegionChange(e) {
    if (e.type === 'begin') {
      this._userInteracted = true;
      console.log('🗺️ [map] 👆 用户开始拖拽地图');
    }
  },

  onCenterSelf() {
    if (!this._cachedMyLocation || !this._cachedMyLocation.latitude) return;
    console.log('🗺️ [map] 🎯 回到我位置');
    this._userInteracted = false;
    this.setData({
      myLocation: this._cachedMyLocation,
      mapScale: 16,
    });
  },

  // ====== 初始化 ======

  _resetState() {
    this._cachedMyLocation = null;
    this._cachedPartnerLocation = null;
    this._markersInited = false;
    this._prevStale = false;
    this._userInteracted = false;
  },

  _initRoom() {
    const room = app.globalData.currentRoom;
    if (!room || !room.roomId) {
      wx.showToast({ title: '配对信息丢失', icon: 'none' });
      setTimeout(() => wx.redirectTo({ url: '/pages/index/index' }), 1500);
      return;
    }
    this.roomId = room.roomId;
    this.userId = app.globalData.openid;
    if (room.partnerInfo) {
      this.setData({
        partnerInfo: {
          nickName: room.partnerInfo.nickName || '客户',
          avatarUrl: room.partnerInfo.avatarUrl || '',
        },
      });
    }
  },

  async _requestPermissions() {
    const granted = await locationService.requestPermission();
    if (!granted) {
      this._showLocationError('定位权限被拒绝，请在设置中开启');
      return;
    }
    locationService.requestBackgroundPermission().catch(() => {});
    this._startLocationServices();
    this._startWatchingPartner();
    this._watchRoomStatus();
  },

  _startLocationServices() {
    const cb = (loc) => { if (loc) this._onMyLocationUpdate(loc); };
    locationService.startUpdating(this.roomId, this.userId, cb, { foreground: true });
    locationService.startBackgroundUpdate(this.roomId, this.userId);
  },

  _startWatchingPartner() {
    this._unwatchLocation = roomService.watchPartnerLocation(
      this.roomId, this.userId,
      (data) => { this._onPartnerLocationUpdate(data); }
    );
    this._startPollingPartner();
  },

  _startPollingPartner() {
    const POLL_INTERVAL = 5000;
    // 如果已经停止了，不再轮询
    if (this._locationWatchTimer === false) return;
    const poll = () => {
      this._locationWatchTimer = setTimeout(async () => {
        try {
          const db = wx.cloud.database();
          const res = await db.collection('locations')
            .where({ roomId: this.roomId, userId: db.command.neq(this.userId) })
            .get();
          if (res.data && res.data.length > 0) {
            console.log('🗺️ [map] 📡 轮询获取到对方位置');
            this._onPartnerLocationUpdate(res.data[0]);
          }
        } catch (err) {
          console.warn('🗺️ [map] ⚠️ 轮询失败', err.errMsg || err.message || err);
        }
        poll();
      }, POLL_INTERVAL);
    };
    poll();
  },

  _stopPolling() {
    if (this._locationWatchTimer) {
      clearTimeout(this._locationWatchTimer);
      this._locationWatchTimer = null;
    }
  },

  _unwatch() {
    if (this._unwatchLocation) {
      this._unwatchLocation();
      this._unwatchLocation = null;
    }
    if (this._roomStatusWatcher) {
      this._roomStatusWatcher.close();
      this._roomStatusWatcher = null;
    }
    if (this._roomStatusPollTimer) {
      clearTimeout(this._roomStatusPollTimer);
      this._roomStatusPollTimer = null;
    }
  },

  /** 监听房间状态，ended 时自动返回首页 */
  _watchRoomStatus() {
    if (!this.roomId) return;
    // 尝试 watch（如果实时推送可用）
    const db = wx.cloud.database();
    this._roomStatusWatcher = db.collection('rooms').doc(this.roomId).watch({
      onChange: (snapshot) => {
        this._onRoomStatusChange(snapshot);
      },
      onError: (err) => console.error('🗺️ [map] ❌ watch 房间状态失败', err),
    });
    // 轮询备用（watch 不可用时生效）
    this._startPollingRoomStatus();
  },

  /** 轮询房间状态（watch 不可用时的备用方案） */
  _startPollingRoomStatus() {
    if (!this.roomId) return;
    const poll = () => {
      if (this._roomStatusPollTimer === false) return;
      this._roomStatusPollTimer = setTimeout(async () => {
        try {
          const db = wx.cloud.database();
          const res = await db.collection('rooms').doc(this.roomId).get();
          const room = res.data;
          if (room && room.status === 'ended') {
            console.log('🗺️ [map] 🔚 (轮询检测到) 共享已结束');
            this._onRoomEnded();
            return;
          }
        } catch (_) {}
        poll();
      }, 8000);
    };
    poll();
  },

  /** 房间结束处理 */
  _onRoomStatusChange(snapshot) {
    const room = snapshot.docs && snapshot.docs[0];
    if (!room || room.status !== 'ended') return;
    this._onRoomEnded();
  },

  _onRoomEnded() {
    console.log('🗺️ [map] 🔚 共享已结束');
    this._unwatch();
    locationService.stopUpdating();
    this._stopStaleCheck();
    this._stopUiTimer();
    this._stopPolling();
    this._resetState();
    app.clearRoom();
    wx.showToast({ title: '客户已结束救援', icon: 'none' });
    setTimeout(() => wx.navigateBack(), 1500);
  },

  // ====== 位置更新 ======

  _onMyLocationUpdate(loc) {
    if (!loc) return;
    const myLoc = { latitude: loc.latitude, longitude: loc.longitude, heading: loc.heading || 0, speed: loc.speed || 0 };
    this._cachedMyLocation = myLoc;

    const updateData = {};
    if (this.data.locationError) updateData.locationError = '';
    if (this.data.isFirstLoad) { updateData.isFirstLoad = false; console.log('🗺️ [map] 🚩 首次定位 lat=' + myLoc.latitude.toFixed(5) + ' lng=' + myLoc.longitude.toFixed(5)); }
    if (!this._userInteracted) updateData.myLocation = myLoc;

    if (Object.keys(updateData).length > 0) this.setData(updateData);

    if (this._markersInited) {
      this._updateMarkerPositions();
      this._updatePolyline();
    } else {
      this._initMapMarkers();
    }
  },

  _onPartnerLocationUpdate(data) {
    if (!data) return;
    const now = Date.now();
    if (now - this._lastPartnerTick < PARTNER_UPDATE_THROTTLE) return;
    this._lastPartnerTick = now;

    this._lastPartnerTimestamp = data._timestamp || now;
    this._partnerRawData = data;
    const partnerLoc = { latitude: data.latitude, longitude: data.longitude, heading: data.heading || 0, speed: data.speed || 0 };
    this._cachedPartnerLocation = partnerLoc;

    console.log('🗺️ [map] 对方位置 lat=' + partnerLoc.latitude.toFixed(5) + ' lng=' + partnerLoc.longitude.toFixed(5));

    this.setData({ partnerLocation: partnerLoc, partnerOnline: true, partnerStale: false });

    if (this._cachedMyLocation && this._cachedMyLocation.latitude) {
      this.setData({
        distance: util.formatDistance(util.calcDistance(
          this._cachedMyLocation.latitude, this._cachedMyLocation.longitude,
          partnerLoc.latitude, partnerLoc.longitude
        )),
      });
    }

    if (!this._markersInited || this.data.markers.length < 1) {
      this._initMapMarkers();
    } else {
      this._updateMarkerPositions();
      this._updatePolyline();
    }
    this._startStaleCheck();
  },

  // ====== 标记管理 ======

  _initMapMarkers() {
    if (this._markersInited) return;
    console.log('🗺️ [map] 🏁 初始化标记');
    const myLoc = this._cachedMyLocation || this.data.myLocation;
    const partnerLoc = this._cachedPartnerLocation;
    if (!myLoc || !myLoc.latitude) return;

    const markers = [];

    if (partnerLoc && partnerLoc.latitude) {
      const label = this.data.partnerStale ? '暂未更新' : (this.data.partnerInfo.nickName || '客户');
      const callout = this.data.partnerLastUpdate ? label + ' · ' + this.data.partnerLastUpdate : label;
      markers.push({
        id: 'partner',
        latitude: partnerLoc.latitude, longitude: partnerLoc.longitude,
        iconPath: this.data.partnerInfo.avatarUrl || '/images/marker-partner.svg', width: 28, height: 28,
        callout: { content: callout, display: 'ALWAYS', fontSize: 12, borderRadius: 10, bgColor: '#07c160', padding: 6, textAlign: 'center', color: '#fff' },
        rotate: partnerLoc.heading || 0, anchor: { x: 0.5, y: 0.5 },
      });
    }

    this.setData({ markers });
    if (partnerLoc && partnerLoc.latitude) this._markersInited = true;
    this._updatePolyline();
  },

  _updateMarkerPositions() {
    if (!this._markersInited) return;
    const partnerLoc = this._cachedPartnerLocation;
    if (partnerLoc && partnerLoc.latitude) {
      this.setData({
        'markers[0].latitude': partnerLoc.latitude,
        'markers[0].longitude': partnerLoc.longitude,
        'markers[0].rotate': partnerLoc.heading || 0,
      });
    }
  },

  _updateMarkerLabels() {
    if (this.data.markers.length < 1) return;
    const label = this.data.partnerStale ? '暂未更新' : (this.data.partnerInfo.nickName || '客户');
    const content = this.data.partnerLastUpdate ? label + ' · ' + this.data.partnerLastUpdate : label;
    this.setData({ 'markers[1].callout.content': content });
  },

  _updatePolyline() {
    const myLoc = this._cachedMyLocation;
    const partnerLoc = this._cachedPartnerLocation;
    if (!myLoc || !partnerLoc || !myLoc.latitude || !partnerLoc.latitude) {
      this.setData({ polyline: [] });
      return;
    }
    this.setData({
      polyline: [{
        points: [{ latitude: myLoc.latitude, longitude: myLoc.longitude }, { latitude: partnerLoc.latitude, longitude: partnerLoc.longitude }],
        color: '#07c160', width: 3, dottedLine: false, arrowLine: true,
      }],
    });
  },

  // ====== UI 定时刷新 ======

  _startUiTimer() {
    this._stopUiTimer();
    this._refreshUpdateTime();
    this._updateUiTimer = setInterval(() => this._refreshUpdateTime(), UI_REFRESH_INTERVAL);
  },

  _stopUiTimer() {
    if (this._updateUiTimer) {
      clearInterval(this._updateUiTimer);
      this._updateUiTimer = null;
    }
  },

  _refreshUpdateTime() {
    if (this._lastPartnerTimestamp > 0) {
      this.setData({ partnerLastUpdate: util.formatTimeAgo(this._lastPartnerTimestamp) });
      if (this._markersInited) this._updateMarkerLabels();
    }
  },

  // ====== 在线检测 ======

  _startStaleCheck() {
    this._stopStaleCheck();
    this._staleCheckTimer = setInterval(() => {
      if (this._lastPartnerTimestamp <= 0) return;
      const elapsed = Date.now() - this._lastPartnerTimestamp;
      const isStale = elapsed > PARTNER_STALE_TIMEOUT;
      const isOffline = elapsed > PARTNER_OFFLINE_TIMEOUT;
      if (isStale !== this._prevStale || isOffline !== !this.data.partnerOnline) {
        this._prevStale = isStale;
        this.setData({ partnerStale: isStale, partnerOnline: !isOffline });
        console.log('🗺️ [map] ⏱ stale=' + isStale + ' online=' + !isOffline + ' (' + Math.round(elapsed / 1000) + 's无更新)');
        if (this._markersInited) this._updateMarkerLabels();
      }
    }, STALE_CHECK_INTERVAL);
  },

  _stopStaleCheck() {
    if (this._staleCheckTimer) {
      clearInterval(this._staleCheckTimer);
      this._staleCheckTimer = null;
    }
  },

  _showLocationError(msg) {
    console.warn('🗺️ [map] ⚠️ ' + msg);
    this.setData({ locationError: msg });
  },
});
