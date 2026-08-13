/**
 * 环境配置文件
 */
const CONFIG = {
  // 云开发环境 ID
  CLOUD_ENV_ID: 'cloudbase-d1gif13eec92ce0f2',

  // 定位参数（后台定位单一通道，前后台通用）
  LOCATION: {
    // 位置回调节流间隔，避免高频回调刷屏；开发者工具降级轮询也用此间隔
    REPORT_INTERVAL: 5000,
  },
};

module.exports = CONFIG;
