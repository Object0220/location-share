# 双人实时位置共享 · 微信小程序

> 两款用户（A 和 B）在地图上实时看到彼此的位置，实现双向位置共享。

## 项目结构

```
location-share/
├── project.config.json          # 项目配置文件（需替换 appid）
├── miniprogram/                  # 小程序前端代码
│   ├── app.json / app.js / app.wxss
│   ├── sitemap.json
│   ├── pages/
│   │   ├── index/               # 首页（创建/加入房间）
│   │   ├── map/                 # 地图页（核心位置共享）
│   │   └── join/                # 加入房间页（输入共享码/扫码）
│   ├── services/
│   │   ├── location.js          # 定位服务（GPS采集、权限、后台定位）
│   │   ├── websocket.js         # WebSocket 连接管理（自动重连、心跳）
│   │   └── room.js              # 房间/配对服务（创建、加入、订阅）
│   ├── utils/
│   │   └── util.js              # 工具函数（距离计算、时间格式化）
│   └── images/                  # 图片资源（需替换为实际 PNG）
├── cloudfunctions/              # 云函数
│   ├── login/                   # 获取 OpenID
│   ├── createRoom/              # 创建共享房间
│   ├── joinRoom/                # 通过共享码加入房间
│   ├── leaveRoom/               # 结束共享/离开房间
│   ├── getRoomInfo/             # 获取房间及对方位置信息
│   └── cleanExpiredLocations/   # 定时清理过期位置数据
```

## 快速开始

### 1. 环境准备

- 安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
- 注册小程序并获取 AppID → 替换 `project.config.json` 中的 `appid`
- 开通云开发 → 创建云环境 → 替换 `miniprogram/app.js` 中的 `env`

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

## 核心功能

### 用户配对
- A 用户点击「创建共享房间」→ 生成 6 位共享码
- B 用户点击「加入共享房间」→ 输入共享码或扫码
- 配对成功后自动跳转地图页

### 实时位置
- 前台每 2 秒上报一次 GPS 坐标
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
- 前台 2s / 后台 5s 上报频率
- 位置数据仅保留最近 5 分钟（由 cleanExpiredLocations 自动清理）
- 使用 `db.doc(id).set()` 保证每个用户只有一条最新位置记录

## 异常处理

| 场景 | 表现 |
|------|------|
| GPS 信号弱 | 红色提示条 + 重试按钮 |
| WebSocket 断连 | 浮动提示「连接中断，正在重连…」 |
| 对方位置 > 1 分钟未更新 | 黄色提示「对方位置暂未更新」 |
| 定位权限被拒 | 引导用户去系统设置开启 |
| 对方退出 | 房间状态标记为 ended，返回首页 |

## 开发优先级

1. ✅ MVP：双向位置显示 + 配对码 + 地图基础功能
2. ⏳ 优化：后台定位 + 掉线重连 + 性能调优 + UI 美化
3. ⏳ 发布：合规检查 + 提交审核

## 许可

MIT
