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
