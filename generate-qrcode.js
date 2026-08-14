/**
 * 生成微信小程序码（二维码图片）
 *
 * 适用：个人主体小程序（URL Scheme 不支持个人主体，小程序码支持）。
 * 用户扫码即可进入指定页面，并自动带入共享码 code。
 *
 * 用法:
 *   node generate-qrcode.js --code 1234
 *   node generate-qrcode.js -c 1234 --path /pages/join/join
 *   node generate-qrcode.js -c 1234 --upload            # 生成后上传到 CloudBase 静态托管
 *
 * 参数:
 *   -c, --code    共享码（手机号后4位），必填
 *   -p, --path    小程序落地页（默认 /pages/join/join）
 *   --upload      生成后自动上传到 CloudBase 静态托管，输出可访问图片 URL
 *   -e, --env     静态托管环境 ID（默认读 cloudbaserc.json）
 *
 * 需要环境变量 WX_APPSECRET，或在脚本中直接填入 SECRET。
 * 上传需安装并登录 @cloudbase/cli（tcb login）。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const APPID = 'wxe4390f025affc74f';
const SECRET = process.env.WX_APPSECRET || '';

function parseArgs(argv) {
  const args = { code: '', path: '/pages/join/join', upload: false, env: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--code') args.code = argv[++i];
    else if (a === '-p' || a === '--path') args.path = argv[++i];
    else if (a === '--upload') args.upload = true;
    else if (a === '-e' || a === '--env') args.env = argv[++i];
  }
  return args;
}

if (!SECRET) {
  console.error('❌ 请设置环境变量 WX_APPSECRET，或在脚本中填入 SECRET');
  process.exit(1);
}

// 读取 cloudbaserc.json 里的环境 ID（用于上传）
function getEnvId() {
  try {
    const rc = JSON.parse(fs.readFileSync(path.join(__dirname, 'cloudbaserc.json'), 'utf8'));
    return rc.envId;
  } catch (e) {
    return '';
  }
}

async function main() {
  const { code, path: pagePath, upload } = parseArgs(process.argv);
  if (!code) {
    console.error('❌ 请通过 --code 指定共享码，如 --code 1234');
    process.exit(1);
  }

  // 1. access_token
  const tokenRes = await fetch(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${SECRET}`
  );
  const tokenData = await tokenRes.json();
  if (tokenData.errcode) {
    console.error('❌ access_token 获取失败:', tokenData.errmsg);
    process.exit(1);
  }
  console.log('✅ access_token 获取成功');
  const access_token = tokenData.access_token;

  // 2. 生成小程序码
  // getwxacodeunlimit 要求页面已发布，未发布时改用 getwxacode（path 直接带参）
  // 若仍报 invalid page，说明小程序需先发布或使用体验版二维码
  const useUnlimit = process.argv.includes('--unlimit');
  let qrRes, reqBody;
  if (useUnlimit) {
    // 已发布小程序：scene 传参
    reqBody = JSON.stringify({ scene: `code=${code}`, page: pagePath, width: 430 });
    qrRes = await fetch(
      `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${access_token}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: reqBody }
    );
  } else {
    // 未发布也可尝试：path 直接带参（参数放 query，需 join 页支持 options.code）
    reqBody = JSON.stringify({ path: `${pagePath}?code=${code}`, width: 430, check_path: false });
    qrRes = await fetch(
      `https://api.weixin.qq.com/wxa/getwxacode?access_token=${access_token}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: reqBody }
    );
  }

  const buf = Buffer.from(await qrRes.arrayBuffer());
  // 错误时返回 JSON 文本
  if (buf[0] === 0x7b) {
    const err = JSON.parse(buf.toString('utf8'));
    console.error('❌ 小程序码生成失败:', err.errmsg);
    process.exit(1);
  }

  const outName = `qrcode-${code}.png`;
  const outPath = path.join(__dirname, outName);
  fs.writeFileSync(outPath, buf);
  console.log(`\n✅ 小程序码已生成: ${outPath}`);
  console.log(`   扫码效果: 进入 ${pagePath} 并自动填入 code=${code}`);

  // 3. 可选：上传到 CloudBase 静态托管
  if (upload) {
    const envId = parseArgs(process.argv).env || getEnvId();
    if (!envId) {
      console.error('❌ 未指定环境 ID（--env 或 cloudbaserc.json）');
      process.exit(1);
    }
    console.log('\n📤 上传到 CloudBase 静态托管...');
    const cmd = `tcb hosting deploy ${outPath} ${outName} -e ${envId}`;
    try {
      const out = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
      console.log(out);
      const domain = `https://${envId}-*.tcloudbaseapp.com`; // 实际域名见托管详情
      console.log(`🔗 图片访问地址（请到托管详情确认完整域名）: ${domain}/${outName}`);
    } catch (e) {
      console.error('❌ 上传失败，请确认已 tcb login 且环境正确:', e.message);
    }
  } else {
    console.log('\n💡 加 --upload 可自动上传到 CloudBase 静态托管，生成可分享的图片链接。');
  }
}

main().catch(err => {
  console.error('❌ 脚本执行失败', err);
});
