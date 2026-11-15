# 同步与分享协议 v1

本文保留旧客户端兼容行为。新接入请使用 [通用同步 API v2](SYNC_V2.md)，不再要求客户端维护 ID 摘要、版本和游标。本文的账号绑定与密码分享仍适用。

所有时间为服务端 Unix 毫秒。JSON 使用 UTF-8，错误为 `{ "error": "原因", "detail": {...} }`。生产服务器必须 HTTPS。本文中的 ID/口令均是说明占位，不是真实凭证。

## 认证和绑定

后台先创建用户，再生成一次性绑定码。App 发起：

```http
POST /api/bind
Content-Type: application/json

{"code":"一次性绑定码","deviceName":"客厅电视"}
```

返回 201：`{ deviceId, userId, token, username }`。`username` 是后台当前人物名称；人物由一次性设备码决定。旧客户端可以继续传 username，但该字段不参与身份判定，也不能改变设备码所属人物。此后所有 `/api/sync/*` 使用 `Authorization: Bearer <token>`。接口从凭证确定 owner，不信任请求中的 userId，也没有设备自动注册人物的接口。

管理员使用 `/api/setup` 和 `/api/login` 建立 Cookie 会话。空库可直接 POST `{username,password}` 到 setup，密码最低 5 位；已有管理员返回 409。不需要初始化 Secret，不将管理员密码或 Cookie 交给 App。

已有安装在同一已验证身份续绑时，可在 bind 中增加 `expectedUserId`。有效码属于另一人物时返回 409 / USER_MISMATCH，并在同一事务内保证不消费码、不创建设备。新安装不传此字段；原令牌经目标服务器验证为 401 后，也允许不携带旧 expectedUserId 重新绑定。新身份开始传输前必须确认服务器和实际 username，旧凭据与队列单独保留，不直接重放给新身份。

## 一键绑定与同步规则

后台在用户绑定弹窗生成链接：`vodplus://sync/bind?server=<encodeURIComponent(HTTPS服务根地址)>&code=<encodeURIComponent(设备码)>`。仅在用户点击时打开；不携带用户名、管理员凭据或设备 token。可选 Android 兼容入口为 `intent://sync/bind?...#Intent;scheme=vodplus;package=com.fongmi.vodplus;end`。App 必须校验 HTTPS、参数和现有身份，不能静默覆盖不同人物的本地队列。设备码仍为 10 分钟有效、单次消费。

每轮同步开始使用设备 Bearer 请求 `GET /api/sync/settings`，返回：

```json
{"fileExtensions":["py","js","txt","json","m3u8","jar","php","html"],"includeExtensionless":true,"excludedDirectories":["_cache","__pycache__","pycache"],"revision":2}
```

全局默认，后缀小写且不带点。按文件名最后一个点判定，大小写不敏感；无点文件和 `.hide` 视为无后缀，`.hide.json` 的后缀为 json。未排除的目录仍同步。excludedDirectories 按任意层级目录段名忽略大小写匹配，排除目录本身和整个子树；同名普通文件只按文件规则判断。旧后台缺此字段时客户端采用这三个默认目录名。revision 只需按返回值比较，不要硬编码为 1。

规则 revision 改变时，App 从 cursor=0 重新核对，利用已有 ID/version/hash 避免重复覆盖。不匹配的本地文件不能被当作删除；保留元数据和本地待办，重新允许该类型后可以恢复。服务端 changes 不过滤，旧内容与历史下载保留。

新增排除目录或其下的新文件/内容返回 422，detail.code=`DIRECTORY_EXCLUDED`。变更流和历史读取不裁剪，规则变化也不自动清理旧内容。

规则约束人物空间新文件或内容变化；已存文件删除、移动、停用及相同内容的恢复仍可提交。公共爬虫库不直接参与设备同步，发布不受此规则限制；复制到人物空间时遵守人物同步规则。

服务器切换不新增后端接口：App 停止旧连接后保存新地址，以原设备令牌读取 settings（旧接口 404 时用只读 changes）验证。成功则保留原同步空间；401 允许新码绑定；网络失败保留地址并等待改正/重试。详见 [App 接入](APP_INTEGRATION.md#已绑定服务器切换)。

## 文件完整上传

```http
PUT /api/sync/blobs/<sha256小写hex>
Authorization: Bearer <token>
Content-Type: application/octet-stream

<原始文件字节>
```

上限 1,572,864 字节。200 返回 `{ hash, size }`；422 表示摘要不匹配。上传不会发布文件版本，随后必须提交元数据。重复上传同一内容安全。可选 `?path=<encodeURIComponent(相对路径)>` 会在读取上传正文前校验文件规则。旧接口只有 hash，无法单凭哈希判断类型，因此仍接受不带 path 的内容暂存，但新文件/新内容的 commit 必须通过规则校验；不符合时返回 422，detail.code=`FILE_TYPE_NOT_ALLOWED`，并给出当前 revision。D1 内容按凭证对应的 owner 与 hash 隔离，不接收客户端路径。服务端内部存储块不改变整文件上传协议。

## 幂等提交

```json
{
  "opId": "a03de5db-c3fa-4d25-a9d5-d3ae1da372aa",
  "patch": {
    "id": "ab8bcdbe-322c-42c5-931a-598a836a0aae",
    "kind": "file",
    "path": "影视线路/sample.py",
    "baseVersion": 3,
    "data": {"hash":"64位小写SHA256","size":1200},
    "enabled": true,
    "deleted": false
  }
}
```

发送到 `POST /api/sync/commit`。`opId`、文件 ID 使用 UUID，重试不重建 ID 或修改请求内容。patch 是完整的新状态，而非部分字段补丁；目录 kind 为 `directory`、data 为 `{}`。创建 baseVersion=0，编辑/移动/停用/删除使用本地已知版本。

200 返回 `{ items: [实体快照...] }`。快照有 `id,kind,path,version,data,enabled,deleted,source,updated`；目录操作可能包含多个子项。版本从 1 递增，owner 不作为可写字段。

409 冲突响应包含 `detail.conflictId`（仅已保存候选的版本冲突）和当前实体。路径占用、已删除或会话序号过时也会返回 409，可能没有 conflictId；客户端均应保留本地待办并提示原因。不得自动把旧 patch 的 baseVersion 替换为最新值。

无关文件导致空间序号变化时，服务端保持原 baseVersion 自动重读并最多尝试 4 次，不保存伪冲突。持续竞争返回 503、`Retry-After: 1`、`detail.retryable=true`；保留原 opId 和完整请求体重试，不自动修改基础版本。文件内容上传/下载可有界并发，App 元数据 commit 继续有序。

提交响应丢失时重发相同 opId，服务端返回同一结果；不会增加版本。服务端保留回执，无短期重试窗口限制。JSON 字段顺序也应保持稳定，建议队列存储已序列化的原请求。

删除使用同一 ID 的 `deleted:true`。服务器保存墓碑。恢复需显式 `restore:true`，现阶段提供给管理员确认恢复使用，App 不应在普通扫描中自动提交恢复。

## 增量拉取和确认

```http
GET /api/sync/changes?cursor=0
Authorization: Bearer <token>
```

```json
{
  "changes": [{"seq":10,"id":"...","kind":"file","path":"a.py","version":2,"data":{"hash":"...","size":10},"enabled":1,"deleted":0,"source":"device:...","updated":1700000000000}],
  "cursor":10,
  "until":25,
  "hasMore":true
}
```

每页最多 100 条。下一页使用返回 cursor，并携带第一页 until：`?cursor=10&until=25`。本轮全部页收齐后按实体 ID 取最后状态，再统一应用。新增变更留待下一轮。

内容下载：`GET /api/sync/files/<fileId>?version=<version>`。返回原字节和 `X-Content-SHA256`；客户端以变更清单中的 hash/size 校验。历史下载范围包含保留的增量快照，不限后台的 20 版历史浏览窗口。

先写临时文件、校验，再原子替换。路径、停用、删除和游标需要可恢复的本地事务；因文件系统与 SQLite 无法天然跨介质事务，Android 应用暂存目录和应用日志，在崩溃后继续或回滚，不能先提交游标。

应用成功后：

```http
POST /api/sync/ack
Content-Type: application/json
Authorization: Bearer <token>

{"cursor":25,"ok":true}
```

失败可提交旧的、最后成功 cursor，`ok:false,error:"校验失败"`。ACK 游标只能在该用户范围内前进；不能提前 ACK 尚未落盘的远程变化。当前游标按 App 持久保存的本地 owner 隔离。新地址用原令牌验证成功的同后台迁移复用原 owner/游标；切换到新人物使用独立 owner 和游标。按地址保存的绑定资料与云端由凭证确定的 userId 是两层概念，客户端不能自行指定云端 owner。

## 观看记录与配置身份

支持 `history / progress / search / config`。没有 path，data 包含稳定的 `key`。ID 为 `<kind>_<SHA256(UTF8(key))>`，服务端校验两者一致。

推荐 key 规范：

| 类型 | key |
|---|---|
| history | `JSON.stringify([sourceKey,siteKey,videoKey])` |
| progress | `JSON.stringify([sourceKey,siteKey,videoKey,episodeKey])` |
| search | NFC 标准化并 trim 后的关键词；不要擅自合并不同大小写语义 |
| config | `vod.current`、`live.current`，或配置稳定 UUID 的历史项 |

sourceKey 由配置来源稳定标识产生；不要包含短期分享 token，不要使用 Room/SQLite 自增 ID。相同片名不能证明是相同影片。

progress 的 data 必须包含：

```json
{"key":"稳定组合键","sessionId":"一次播放会话UUID","sequence":12,"position":72.5,"title":"显示名称"}
```

position 以秒为单位，可下降。同会话 sequence 严格递增；新会话使用新的 sessionId，也受 baseVersion 检查。客户端时间仅可作为展示字段，不用于判定胜负。

搜索清空和历史删除逐条提交墓碑。不要传整个数据库，更不要复制使用中的 SQLite 文件。

## 只读配置分享

密码交换：

```http
POST /share/<shareId>/auth
Content-Type: application/json

{"password":"分享密码"}
```

返回 `{ token, expires: null, url }`，链接永久有效。密码接口的 index.json、脚本、JSON 子配置和多线路 URL 都含同范围只读 token。空密码接口不需要验证，直接 GET `/share/<id>/index.json`，所有生成的子 URL 不含 token。`GET /share/<id>/info` 返回 name/passwordRequired 及公开接口 URL。

也可以使用 Bearer 访问分享接口，但生成的子 URL 仍会携带 token，以兼容不能给每次脚本下载加 Header 的现有 App。分享 token 无法访问 `/api/sync/*` 或管理员接口。管理员 Cookie 也不能替代分享 token 读取子文件。

密码错误 401，尝试过多 429，接口/人物/目录停用 404，token 被撤销后返回 401；永久 token 不按时间过期。换取 token 的口令只通过 POST 传输，不写到 URL。

## 设备配置控制

新增设备 Bearer 接口：`GET /api/sync/device-config`、`POST /api/sync/device-config/report`。当前值与待应用指令分开，按 deviceId 隔离；字段为 vod/live/theme/wallpaper。读取、刷新、回报序号及幂等语义见 [设备控制协议](DEVICE_CONTROL.md)。

## 管理 API 速查

管理员 Cookie 会话下：

| 方法 / 路径 | 功能 |
|---|---|
| GET `/api/admin/overview` | 用户、设备、发布和最近日志 |
| GET `/api/admin/account` | 当前管理员名称 |
| POST `/api/admin/account/password` | currentPassword/newPassword；成功后注销旧会话 |
| POST `/api/admin/account/reset` | currentPassword/confirmation=RESET；原子清空业务数据 |
| GET `/api/admin/sync-settings` | 读取全局文件规则 |
| PUT `/api/admin/sync-settings` | fileExtensions/includeExtensionless/excludedDirectories/revision；旧请求省略目录字段会保留现有值，版本冲突返回 409 |
| POST `/api/admin/users` | `{name}` 创建人物 |
| PATCH `/api/admin/users/:id` | `{name?,enabled?}` |
| POST `/api/admin/users/:id/binding` | 一次性设备码 |
| PATCH `/api/admin/devices/:id` | `{name?,revoked?}` |
| GET/PUT `/api/admin/devices/:id/config` | 查看实际回报；按 opId/baseRevision 下发字段 |
| POST `/api/admin/devices/:id/config/refresh` | 请求设备重新采集当前值 |
| GET `/api/admin/spaces/:owner/entities` | 文件与记录清单 |
| PUT `/api/admin/spaces/:owner/blobs/:hash` | 完整内容上传 |
| POST `/api/admin/spaces/:owner/commit` | 同步格式的版本提交 |
| GET `/api/admin/spaces/:owner/files/:id?version=N` | 当前或指定历史文件 |
| GET `/api/admin/spaces/:owner/versions/:id` | 最近 20 版元数据 |
| GET `/api/admin/spaces/:owner/conflicts` | 未解决候选 |
| GET `/api/admin/spaces/:owner/conflict-file/:id` | 完整候选字节 |
| POST `/api/admin/spaces/:owner/resolve/:id` | 关闭候选，采用需先正常提交 |
| POST `/api/admin/copy` | 公共文件复制：owner/fileId/sourceVersion/id/opId/path |
| POST `/api/admin/shares` | name/owner/root/password |
| PATCH `/api/admin/shares/:id` | name/enabled/password；显式修改密码或 revokeTokens=true 撤销旧 token |
| POST `/api/admin/shares/:id/token` | 管理员签发只读 URL |

401 重新绑定/登录；403 权限或跨站请求问题；409 冲突等待处理；413 缩小单次数据；422 校验/配置引用错误；429 延后重试；5xx 指数退避并保留队列。重试增加随机抖动，App 非活跃期间不无限循环。
