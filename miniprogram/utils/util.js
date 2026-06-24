/**
 * 工具函数
 */

/**
 * 格式化时间显示
 * @param {number} timestamp - 毫秒时间戳
 * @returns {string} 相对时间描述
 */
function formatTimeAgo(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 0) return '刚刚';
  if (diff < 3000) return '刚刚';
  if (diff < 60000) return Math.floor(diff / 1000) + '秒前';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  return Math.floor(diff / 3600000) + '小时前';
}

/**
 * 计算两点之间的距离 (Haversine 公式)
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} 距离（米）
 */
function calcDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // 地球半径（米）
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * 格式化距离显示
 * @param {number} meters
 * @returns {string}
 */
function formatDistance(meters) {
  if (meters < 1) return '小于1米';
  if (meters < 1000) return Math.round(meters) + '米';
  return (meters / 1000).toFixed(1) + '公里';
}

/**
 * 防抖
 */
function debounce(fn, delay = 300) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * 节流
 */
function throttle(fn, interval = 500) {
  let lastTime = 0;
  return function (...args) {
    const now = Date.now();
    if (now - lastTime >= interval) {
      lastTime = now;
      fn.apply(this, args);
    }
  };
}

module.exports = {
  formatTimeAgo,
  calcDistance,
  formatDistance,
  debounce,
  throttle,
};
