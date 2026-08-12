/**
 * 前端工具函数测试
 * 覆盖 miniprogram/utils/util.js 的纯函数（无需 wx mock）
 */

const { calcDistance, formatDistance, formatTimeAgo, debounce, throttle } = require('../miniprogram/utils/util');

describe('📏 calcDistance', () => {
  test('北京-上海距离约 1067 公里', () => {
    const d = calcDistance(39.9042, 116.4074, 31.2304, 121.4737);
    // 实际约 1067km，允许 ±20km 误差
    expect(d).toBeGreaterThan(1050000);
    expect(d).toBeLessThan(1080000);
  });

  test('同一点距离为 0', () => {
    expect(calcDistance(30, 120, 30, 120)).toBeCloseTo(0, 6);
  });
});

describe('📏 formatDistance', () => {
  test('不足 1 米显示「小于1米」', () => {
    expect(formatDistance(0.5)).toBe('小于1米');
  });

  test('米级显示（取整）', () => {
    expect(formatDistance(500)).toBe('500米');
    expect(formatDistance(999)).toBe('999米');
  });

  test('公里级显示（保留1位小数）', () => {
    expect(formatDistance(1234)).toBe('1.2公里');
    expect(formatDistance(1000)).toBe('1.0公里');
  });
});

describe('⏱️ formatTimeAgo', () => {
  test('秒级显示', () => {
    expect(formatTimeAgo(Date.now() - 5000)).toBe('5秒');
  });

  test('未来时间/不足1秒显示「0秒」', () => {
    expect(formatTimeAgo(Date.now() + 1000)).toBe('0秒');
    expect(formatTimeAgo(Date.now())).toBe('0秒');
  });
});

describe('🛡️ debounce', () => {
  afterEach(() => jest.useRealTimers());

  test('多次连续调用只执行一次（合并）', () => {
    jest.useFakeTimers();
    const fn = jest.fn();
    const d = debounce(fn, 300);
    d();
    d();
    d();
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('应透传参数并保持 this', () => {
    jest.useFakeTimers();
    const fn = jest.fn();
    const obj = {
      value: 1,
      d: debounce(function (a) { fn(this.value, a); }, 100),
    };
    obj.d(42);
    jest.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith(1, 42);
  });
});

describe('🛡️ throttle', () => {
  afterEach(() => jest.useRealTimers());

  test('间隔内只执行一次', () => {
    jest.useFakeTimers();
    const fn = jest.fn();
    const t = throttle(fn, 500);
    t();
    expect(fn).toHaveBeenCalledTimes(1);
    t();
    t();
    expect(fn).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(500);
    t();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
