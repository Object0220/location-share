/**
 * 环境配置文件
 */
const CONFIG = {
  // 云开发环境 ID
  CLOUD_ENV_ID: 'cloud1-d1g3zbdz9872533e9',

  // 定位参数
  LOCATION: {
    FOREGROUND_INTERVAL: 10000,   // 前台 10s
    BACKGROUND_INTERVAL: 15000,   // 后台 15s — 切后台降频省电
  },
};

module.exports = CONFIG;
