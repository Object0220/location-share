/**
 * 生成微信小程序 URL Scheme 外链 + H5 中转页地址
 *
 * 用法:
 *   node generate-scheme.js
 *   node generate-scheme.js --path /pages/join/join --query "code=1234"
 *   node generate-scheme.js -p /pages/index/index -q "" -d 30
 *
 * 参数:
 *   -p, --path    小程序落地页路径（默认 /pages/index/index）
 *   -q, --query   落地页 query 参数，如 "code=1234"（默认空）
 *   -d, --days    Scheme 有效天数（默认 30，最大 30）
 *   --host        H5 中转页部署后的访问地址（用于拼接短信链接，可选）
 *
 * 需要先设置环境变量 WX_APPSECRET，或在脚本中直接填入 SECRET
 */

const APPID = 'wxe4390f025affc74f';
const SECRET = process.env.WX_APPSECRET || '';

// ---- 解析命令行参数 ----
function parseArgs(argv) {
  const args = { path: '/pages/index/index', query: '', days: 30, host: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--path') args.path = argv[++i];
    else if (a === '-q' || a === '--query') args.query = argv[++i];
    else if (a === '-d' || a === '--days') args.days = Number(argv[++i]) || 30;
    else if (a === '--host') args.host = argv[++i];
  }
  args.days = Math.min(Math.max(args.days, 1), 30); // 微信限制最大 30 天
  return args;
}

if (!SECRET) {
  console.error('❌ 请设置环境变量 WX_APPSECRET，或在脚本中填入 SECRET');
  process.exit(1);
}

async function main() {
  const { path, query, days, host } = parseArgs(process.argv);

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
        jump_wxa: { path, query },
        expire_type: 1,
        expire_interval: days, // 最长 30 天
      }),
    }
  );
  const schemeData = await schemeRes.json();

  if (schemeData.errcode) {
    console.error('❌ Scheme 生成失败:', schemeData.errmsg);
    process.exit(1);
  }

  console.log('\n✅ URL Scheme 生成成功!');
  console.log('🔗 落地页:', path, query ? `?${query}` : '');
  console.log('🔗 openlink:', schemeData.openlink);

  // 3. 组装短信可点击的 H5 中转链接（需先把 web/launch.html 部署到 https 域名）
  if (host) {
    const landing = encodeURIComponent(`${path}${query ? `?${query}` : ''}`);
    const smsLink = `${host.replace(/\/$/, '')}/launch.html?path=${landing}&scheme=${encodeURIComponent(schemeData.openlink)}`;
    console.log('\n📩 短信/邮件用此 https 链接（Android/iOS 通用）:');
    console.log('   ', smsLink);
    console.log('   （请先将 web/launch.html 上传到该 https 域名根目录/对应路径）');
  } else {
    console.log('\n💡 提示: 加 --host https://你的域名 可自动生成短信用的 H5 中转链接。');
    console.log('   短信里直接放 weixin:// 链接在 Android 上大多无法跳转，建议用 H5 中转页。');
  }
}

main().catch(err => {
  console.error('❌ 脚本执行失败', err);
});
