/**
 * 生成微信小程序 URL Scheme 外链
 * 用法: node generate-scheme.js
 *
 * 需要先设置环境变量 WX_APPSECRET
 * 或在脚本中直接填入 SECRET
 */

const APPID = 'wxe4390f025affc74f';
const SECRET = process.env.WX_APPSECRET || '';

if (!SECRET) {
  console.error('❌ 请设置环境变量 WX_APPSECRET，或在脚本中填入 SECRET');
  process.exit(1);
}

async function main() {
  // 1. 获取 access_token
  const tokenUrl = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${SECRET}`;
  const tokenRes = await fetch(tokenUrl);
  const tokenData = await tokenRes.json();

  if (tokenData.errcode) {
    console.error('❌ access_token 获取失败:', tokenData.errmsg);
    process.exit(1);
  }

  console.log('✅ access_token 获取成功');
  const access_token = tokenData.access_token;

  // 2. 生成 URL Scheme
  const schemeRes = await fetch(
    `https://api.weixin.qq.com/wxa/generatescheme?access_token=${access_token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jump_wxa: {
          path: '/pages/index/index',
          query: '',
        },
        expire_type: 1,
        expire_interval: 30, // 30 天有效
      }),
    }
  );
  const schemeData = await schemeRes.json();

  if (schemeData.errcode) {
    console.error('❌ Scheme 生成失败:', schemeData.errmsg);
    process.exit(1);
  }

  console.log('\n✅ URL Scheme 生成成功!');
  console.log('🔗', schemeData.openlink);
  console.log('\n将此链接用于短信、邮件、网页中，用户点击后即可打开小程序。');
}

main().catch(err => {
  console.error('❌ 脚本执行失败', err);
});
