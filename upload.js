/**
 * 上传小程序代码到微信服务器
 * (强制直连，绕过系统代理)
 */

// === 绕过系统代理：让 servicewechat.com 直连 ===
const net = require('net');
const tls = require('tls');
const origNetConnect = net.connect;
const origTlsConnect = tls.connect;

net.connect = function (...args) {
  const opts = typeof args[0] === 'object' ? args[0] : {};
  const host = opts.host || opts.servername || '';
  // 微信相关域名直连
  if (host.includes('servicewechat.com') || host.includes('qq.com')) {
    opts.localAddress = undefined; // 不强制本地地址
    return origNetConnect.apply(this, args);
  }
  return origNetConnect.apply(this, args);
};

tls.connect = function (...args) {
  const opts = typeof args[0] === 'object' ? args[0] : {};
  const host = opts.host || opts.servername || '';
  if (host.includes('servicewechat.com') || host.includes('qq.com')) {
    opts.localAddress = undefined;
    return origTlsConnect.apply(this, args);
  }
  return origTlsConnect.apply(this, args);
};
// === 绕过结束 ===

const ci = require('miniprogram-ci');
const path = require('path');

(async () => {
  const project = new ci.Project({
    appid: 'wxe4390f025affc74f',
    type: 'miniProgram',
    projectPath: path.resolve(__dirname, 'miniprogram'),
    privateKeyPath: path.resolve(__dirname, 'private.key'),
    ignores: ['node_modules/**/*'],
  });

  const result = await ci.upload({
    project,
    version: '1.0.0',
    desc: '自动上传',
    setting: {
      es6: true,
      es7: true,
      minify: true,
      autoPrefixWXSS: true,
    },
  });

  console.log('✅ 上传成功', result);
})().catch(err => {
  console.error('❌ 上传失败', err);
  process.exit(1);
});
