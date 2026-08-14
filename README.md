# 双人实时位置共享 · 微信小程序

> 两个用户（A 和 B）在地图上实时看到彼此的位置，实现双向位置共享。

## 项目结构

```
location-share/
├── project.config.json          # 项目配置文件（需替换 appid）
├── miniprogram/                  # 小程序前端代码
│   ├── app.json / app.js / app.wxss
│   ├── sitemap.json
│   ├── constants.js             # 全局常量（角色名等文案）
│   ├── env-config.js            # 环境配置（云环境 ID、定位上报频率）
│   ├── pages/
│   │   ├── index/               # 首页（创建/加入房间入口）
│   │   ├── waiting/             # 司机输入手机号后4位、创建房间、等待页
│   │   ├── driver-map/          # 司机地图页（等待客户加入 + 位置共享）
│   │   ├── customer-map/        # 客户地图页（位置共享 + 设置救援目的地）
│   │   └── join/                # 加入房间页（输入共享码/扫码）
│   ├── services/
│   │   ├── location.js          # 定位服务（GPS采集、权限、后台定位）
│   │   ├── room.js              # 房间/配对服务（创建、加入、订阅）
│   │   └── map-shared.js        # 地图共享通用逻辑（mixin 注入两个地图页）
│   ├── utils/
│   │   └── util.js              # 工具函数（距离计算、时间格式化）
│   └── images/                  # 图片资源（需替换为实际 PNG）
├── cloudfunctions/              # 云函数
│   ├── login/                   # 获取 OpenID
│   ├── createRoom/              # 创建共享房间
│   ├── joinRoom/                # 通过共享码加入房间
│   ├── leaveRoom/               # 结束共享/离开房间
│   ├── getRoomInfo/             # 获取房间及对方位置信息
│   ├── setDestination/          # 客户设置救援目的地
│   ├── initDatabase/            # 初始化数据库集合（首次运行自动创建）
│   └── cleanExpiredLocations/   # 定时清理过期位置数据
```

> **实时位置同步**：采用云开发实时数据推送（watch API）+ 5 秒轮询兜底，不依赖 WebSocket。

## 快速开始

### 1. 环境准备

- 安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
- 注册小程序并获取 AppID → 替换 `project.config.json` 中的 `appid`
- 开通云开发 → 创建云环境 → 替换 `miniprogram/env-config.js` 中的 `CLOUD_ENV_ID`

### 2. 部署云函数

```bash
# 在微信开发者工具中
1. 右键 cloudfunctions 目录 → 选择云开发环境
2. 选中所有云函数 → 右键 → 上传并部署（全部云端安装依赖）
```

### 3. 创建数据库集合

在云开发控制台创建以下集合：

| 集合名 | 权限设置 | 说明 |
|--------|---------|------|
| `rooms` | 仅创建者可读写 | 房间配对数据 |
| `locations` | 仅创建者可读写 | 实时位置数据 |

> **注意**：locations 集合的权限需要通过安全规则限制，确保只有房间成员可读写。

### 4. 数据库安全规则

**rooms 集合：**
```json
{
  "read": "doc.status === 'active' && (doc.userA.userId === auth.openid || (doc.userB && doc.userB.userId === auth.openid))",
  "write": "doc.status === 'waiting' || doc.status === 'active'"
}
```

**locations 集合：**
```json
{
  "read": "query.roomId != null",
  "write": "doc.userId === auth.openid"
}
```

### 5. 运行

1. 在微信开发者工具中打开项目根目录
2. 编译运行
3. 真机调试（需要开启 GPS 和定位权限）

### 6. 通过链接启动小程序（短信 / 邮件）

直接把 `weixin://` 开头的 Scheme 放进短信，在 **Android** 上基本无法识别跳转，iOS 也仅部分客户端支持。因此采用 **H5 中转页** 方案：短信里放一个 `https://` 普通链接，用户点击后由 H5 页根据设备拉起小程序。

#### 6.1 生成 Scheme

```bash
# 设置小程序 secret（在微信公众平台 → 开发 → 开发设置 获取）
export WX_APPSECRET='你的小程序secret'

# 生成首页 Scheme（不带参数）
node generate-scheme.js

# 生成带共享码的 Scheme（用户点链接直接进加入页）
node generate-scheme.js --path /pages/join/join --query "code=1234"
```

#### 6.2 部署 H5 中转页

将 `web/launch.html` 上传到一个 **已备案的 https 域名**（如对象存储 / 静态托管）。然后用 `--host` 生成短信链接：

```bash
node generate-scheme.js --path /pages/join/join --query "code=1234" \
  --host https://your-domain.com
```

输出示例：

```
📩 短信/邮件用此 https 链接（Android/iOS 通用）:
    https://your-domain.com/launch.html?path=%2Fpages%2Fjoin%2Fjoin%3Fcode%3D1234&scheme=weixin%3A%2F%2F...
```

把这条 `https://` 链接放进短信/邮件即可。中转页逻辑：

- **iOS / 微信内**：自动 `location.href = scheme` 拉起小程序；
- **Android 微信外**：自动尝试拉起，失败则展示「复制链接在微信打开」兜底。

#### 6.3 注意事项

- Scheme 最长有效期 30 天（`-d` 参数，默认 30）；
- H5 中转域名必须 **https 且已备案**，否则微信内可能无法跳转；
- 若中转页与小程序同主体且已配置「URL Scheme 白名单」可进一步提升成功率（非必须）。

### 7. 运行测试

```bash
# 首次运行需安装测试依赖（jest）
npm install --save-dev jest
npm test
```

测试覆盖：
- `tests/cloudfunctions.test.js`：云函数核心业务逻辑（通过 mock 微信云开发 SDK 在本地运行）
- `tests/util.test.js`：前端工具函数（距离计算、时间格式化、防抖、节流）

## 核心功能

### 用户配对
- A 用户点击「创建共享房间」→ 生成 4 位共享码
- B 用户点击「加入共享房间」→ 输入共享码或扫码
- 配对成功后自动跳转地图页

### 实时位置
- 前台每 5 秒上报一次 GPS 坐标（后台每 15 秒，切后台自动降频省电）
- 后台定位（需用户授权）
- 使用云开发实时数据推送（watch API）接收对方位置
- 降级方案：5 秒轮询

### 地图显示
- 微信原生 `<map>` 组件
- 自己和对方双标记点
- 方向箭头（基于 heading）
- 两点间连线
- include-points 自动缩放到两人可见

## 注意事项

### 权限申请
```
requiredBackgroundModes: ["location"]
```

需在小程序管理后台位置接口申请（付费接口）：
- `wx.onLocationChange` - 持续定位接口
- `wx.startLocationUpdateBackground` - 后台定位

### 图片资源
`images/` 目录下需要替换为实际 PNG 图片：
- `marker-self.png` (32x32) - 自己位置标记
- `marker-partner.png` (36x36) - 对方位置标记
- `default-avatar.png` (64x64) - 默认头像
- `share-bg.png` (400x300) - 分享卡片背景

### 性能优化
- 前台 5s / 后台 15s 上报频率（由 `miniprogram/env-config.js` 配置）
- 位置数据仅保留最近 5 分钟（由 cleanExpiredLocations 自动清理）
- 使用 `db.doc(id).set()` 保证每个用户只有一条最新位置记录

## 异常处理

| 场景 | 表现 |
|------|------|
| GPS 信号弱 | 红色提示条 + 重试按钮 |
| 实时订阅断连 | 浮动提示「连接中断，正在重连…」（自动降级轮询 + 指数退避重连） |
| 对方位置 > 1 分钟未更新 | 黄色提示「对方位置暂未更新」 |
| 定位权限被拒 | 引导用户去系统设置开启 |
| 对方退出 | 房间状态标记为 ended，返回首页 |

## 开发优先级

1. ✅ MVP：双向位置显示 + 配对码 + 地图基础功能
2. ⏳ 优化：后台定位 + 掉线重连 + 性能调优 + UI 美化
3. ⏳ 发布：合规检查 + 提交审核

## 许可

MIT
