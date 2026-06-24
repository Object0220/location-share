/**
 * 数据库初始化
 * 检查 rooms 和 locations 集合是否存在
 * 提示：集合需先在云开发控制台手动创建
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async () => {
  const results = [];
  const names = ['rooms', 'locations'];

  for (const name of names) {
    try {
      // 查询 -> 存在则跳过
      await db.collection(name).limit(1).get();
      results.push({ name, status: 'exists' });
    } catch (err) {
      // 集合不存在
      results.push({ name, status: 'not_exists', msg: err.message });
    }
  }

  const allExist = results.every(r => r.status === 'exists');

  if (!allExist) {
    const missing = results.filter(r => r.status !== 'exists').map(r => r.name).join(', ');
    console.error(`❌ 以下集合未创建，请手动在云开发控制台创建: ${missing}`);
  } else {
    console.log('✅ 所有集合已就绪');
  }

  return { code: allExist ? 0 : -1, results, message: allExist ? 'ok' : '请手动创建集合后重试' };
};
