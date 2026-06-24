# 云数据库索引配置

在微信开发者工具 → 云开发控制台 → 数据库 → `集合名` → 索引 中创建以下索引。

## `rooms` 集合

| 索引键 | 说明 |
|---|---|
| `userA.userId` asc, `status` asc | `createRoom`/`joinRoom` 检查用户是否有活跃房间 |
| `userB.userId` asc, `status` asc | 同上，B 侧查询 |
| `shareCode` asc, `status` asc | `joinRoom` 通过共享码查找等待中的房间 |
| `status` asc, `createTime` asc | `cleanExpiredLocations` 清理超时 waiting 房间 |

## `locations` 集合

| 索引键 | 说明 |
|---|---|
| `timestamp` asc | `cleanExpiredLocations` 清理过期位置数据 |
| `roomId` asc, `userId` asc | `watchPartnerLocation` 实时订阅对方位置 |
