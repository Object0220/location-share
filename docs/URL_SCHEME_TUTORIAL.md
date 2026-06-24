# 微信小程序外链（URL Scheme）接入教程

通过 URL Scheme，短信、邮件、网页里的链接点击后可以直接打开你的小程序。

## 前置条件

- 小程序已上传代码（不需要发布，体验版也可以）
- 小程序 AppID：`wxe4390f025affc74f`

---

## 第一步：上传代码

### 方法 A：开发者工具上传（推荐）

1. 打开微信开发者工具
2. 点顶部工具栏 **「上传」** 按钮
3. 版本号填 `1.0.0`，备注随意
4. 上传成功后到小程序管理后台确认

### 方法 B：通过 miniprogram-ci 上传（已安装）

```bash
# 1. 先生成上传密钥（看第二步）
# 2. 然后运行上传脚本
node upload.js
```

---

## 第二步：生成上传密钥

1. 打开 **[微信小程序管理后台](https://mp.weixin.qq.com/)** → 扫码登录
2. 左侧 **「开发」** → **「开发管理」** → **「开发设置」**
3. 拉到 **「小程序代码上传密钥」** → 点 **「生成」**
4. 生成后下载 `.key` 文件，放到项目根目录，命名为 `private.key`

> ⚠️ 密钥只能下载一次，请妥善保管

---

## 第三步：创建上传脚本

在项目根目录创建 `upload.js`：

```js
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

  console.log('上传成功', result);
})();
```

运行：

```bash
node upload.js
```

---

## 第四步：生成 URL Scheme

### 获取 access_token

```bash
# 从微信服务器获取 access_token
# APPID 和 SECRET 在小程序管理后台 → 开发 → 开发设置 → 开发者ID
curl "https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=APPID&secret=APPSECRET"
```

### 调用接口生成 Scheme

```bash
# 替换 YOUR_ACCESS_TOKEN
curl -X POST \
  "https://api.weixin.qq.com/wxa/generatescheme?access_token=YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jump_wxa": {
      "path": "/pages/index/index",
      "query": ""
    },
    "expire_type": 1,
    "expire_interval": 30
  }'
```

参数说明：

| 参数 | 说明 |
|---|---|
| `jump_wxa.path` | 打开的页面路径 |
| `jump_wxa.query` | 携带的参数，如 `roomId=xxx` |
| `expire_type` | `1`=有效期天数 `2`=有效期分钟 |
| `expire_interval` | 天数或分钟数 |

返回示例：

```json
{
  "errcode": 0,
  "errmsg": "ok",
  "openlink": "weixin://dl/business/?t=xxx_xxx"
}
```

拿到 `openlink` 就是你的小程序外链。

---

## 第五步：在短信/网页中使用

```
weixin://dl/business/?t=xxx_xxx
```

- **短信/邮件：** 直接作为链接文本发送
- **网页：** `<a href="weixin://dl/business/?t=xxx_xxx">打开小程序</a>`
- **二维码：** 用二维码生成工具把链接转成二维码

---

## 一键脚本

如果想一条命令搞定，创建一个 `generate-scheme.js`：

```js
const https = require('https');

const APPID = 'wxe4390f025affc74f';
const SECRET = '你的APPSECRET';  // ← 从管理后台获取

async function main() {
  // 1. 获取 token
  const tokenRes = await fetch(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${SECRET}`
  );
  const { access_token } = await tokenRes.json();
  console.log('access_token 获取成功');

  // 2. 生成 Scheme
  const schemeRes = await fetch(
    `https://api.weixin.qq.com/wxa/generatescheme?access_token=${access_token}`,
    {
      method: 'POST',
      body: JSON.stringify({
        jump_wxa: { path: '/pages/index/index', query: '' },
        expire_type: 1,
        expire_interval: 30,
      }),
    }
  );
  const data = await schemeRes.json();
  console.log('外链:', data.openlink);
}

main();
```

运行：

```bash
node generate-scheme.js
```

---

## 注意事项

- ❗ URL Scheme 有**有效期**，过期后失效
- ❗ 小程序**未发布**也可以使用（体验版也可以）
- ❗ 每个小程序每天生成 Scheme 有**数量限制**（默认每天 10 万次）
- ✅ 点开链接的用户必须是该小程序的**开发者/体验者**才能打开未发布的小程序
