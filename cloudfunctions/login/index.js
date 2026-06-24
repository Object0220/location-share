/**
 * 登录云函数
 * 获取用户 OpenID
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
  console.log('🔐 [login] 开始获取用户身份');
  const wxContext = cloud.getWXContext();

  const result = {
    openid: wxContext.OPENID,
    unionid: wxContext.UNIONID || '',
    appid: wxContext.APPID,
  };

  console.log('🔐 [login] 成功', JSON.stringify({ openid: result.openid, appid: result.appid }));
  return result;
};
