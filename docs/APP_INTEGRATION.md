# ys App 接入边界

新版公开协议以 [通用同步 API v2](SYNC_V2.md) 为准；下文记录旧版集成和绑定兼容边界。新版改为手动推送/下载，由客户端自己的命名空间承载影视业务与扩展，服务端负责发布和恢复差异；不再要求客户端维护旧版本协议。Android 改动由 App 会话独立完成和验收。

ys App 的同步已由对应 Android 项目会话接入。本仓库负责后台、同步协议与传输示例；本次没有跨目录修改或编译 Android，也不以服务端测试代替 Android 真机验收。

## 设置入口与页面

同步入口和主设置页保持 ys 当前布局，本轮不额外增加主设置项。

绑定只提交 `{code,deviceName}`，不再填写用户名。后台用一次性设备码确定人物，返回 `{deviceId,userId,token,username}`；显示服务器返回的当前 username，不猜名称。原客户端传 username 仍兼容，但不会影响绑定归属。

后台“一键绑定”使用 `vodplus://sync/bind?server=<编码后的HTTPS服务根地址>&code=<编码后的设备码>`，仅带 server/code。App 校验 HTTPS、参数及已有身份，拒绝静默覆盖不同人物；未安装新版 App 时，后台保留复制设备码的入口。

同一已验证身份续绑时携带 expectedUserId；原令牌在目标服务器明确返回 401 后，不再把旧 expectedUserId 附加到新身份绑定请求。后台在携带此字段且有效码人物不匹配时仍返回 409、不消费码，App 同样校验成功响应的 userId。首次外部链接确认服务器来源，不同既有服务器的一键绑定不再硬拒绝，而是走下述切换和身份确认流程。

人物可在同一设备切换，但后台管理员不是人物。每个绑定关系保留独立凭证、队列、游标、文件索引和本地数据命名空间。切换前冻结原人物会话；原人物未上传队列继续归属原 userId，不改标签转给新人物。

## 已绑定服务器切换

操作入口仍是“同步设置 → 同步服务器”，不增加主设置项。SyncServerProfiles 与 SyncAccount 按地址加密保存绑定资料，并持久保存本地 owner；停止旧请求和配置加载后再保存新地址。

1. 使用原设备令牌向新地址发起只读 `GET /api/sync/settings` 鉴权；旧规则接口 404 时，可以使用只读 changes 请求验证。
2. 验证成功，视为同一后台的域名/路径迁移，复用原本地 owner、队列、游标和版本；不能只因 URL 改变而创建另一份同步空间。
3. 返回 401，解除当前失效授权，但保留旧地址的加密资料和旧队列，允许填写新设备码。新身份获得独立 owner，第一次传输前展示服务器与后台实际返回的用户名，等待明确确认；旧人物队列不能直接重放。
4. 连接失败仍保存新地址，允许修改或再次验证；失败本身不等于令牌失效，不自动判定为同一后台。
5. 切回旧地址时恢复该地址的资料，并重新验证授权。

同地址重新部署或后台重置后填新设备码，也先验证旧令牌；失效后允许重新绑定，不因遗留 expectedUserId 永久阻断。全程不清除 App 本机文件和历史，不自动执行后台重置。操作需要安装包含本轮修改的 App 构建，源码验证不等于真机验证。

## 建议模块

| 模块 | 职责 |
|---|---|
| SyncAccountStore | 服务器/人物/设备绑定凭证与 Keystore 存储 |
| SyncOutboxDao | 持久化 opId、原始请求、文件暂存位置、重试状态 |
| SyncRecordMapper | History/Config/Search/Progress 的跨设备键映射 |
| LocalResourceIndex | 文件 UUID、相对路径、hash、version、enabled、deleted |
| SyncTransport | HTTP、鉴权、限额、退避与错误解释 |
| SyncApplyJournal | 下载暂存、校验、原子替换、崩溃恢复、游标提交 |
| SyncCoordinator | 前台触发、去抖、一次一轮同步、取消与用户切换 |
| SyncLogStore | 上传/下载内容、时间、成功和失败原因 |

`examples/sync-client.js` 可运行并参与测试，提供 enqueue/sync/recordId。它的 storage 是宿主接口，不是现成 Android 存储实现：

| 方法 | 必须保证 |
|---|---|
| enqueue(item) | 在返回前持久化；owner 与原始 opId 不再修改 |
| pending(owner) | 仅返回该人物可重试项；同一实体连续本地修改有序合并/提交 |
| committed(owner,opId,items) | 原子记录服务端版本并删除该待办；保留提交后产生的新本地修改 |
| conflict(owner,item,detail) | 保存本地候选并暂停自动重试，不删除原内容 |
| cursor(owner) | 返回最后完成落盘的游标 |
| applyRemote(owner,staged,cursor,options) | 校验后成组应用；有待办的实体保留双份/冲突；屏蔽文件监听回传；完成才推进游标 |
| log(owner,event) | 写用户可见的同步日志 |

参考代码按轮次收齐分页后按 ID 合并最新版，避免目录移动被分页拆开。生产客户端可将暂存清单落库以节省内存；不要把所有文件一次放入内存。

## 文件规则与有界并发

每轮开始读取 `GET /api/sync/settings`（设备 Bearer）：`fileExtensions` 默认 py/js/txt/json/m3u8/jar/php/html，`includeExtensionless=true`，另有 `excludedDirectories`，默认 `_cache`、`__pycache__`、`pycache`；revision 以服务端实际值为准。按最后一个点提取后缀，小写比较；无点及 `.hide` 是无后缀，未排除的目录仍同步。排除规则按任意层级目录段名、不区分大小写，整棵子树跳过；根目录同名普通文件不因目录规则被排除。旧后台缺字段时使用默认三项。

记录上次规则 revision；变化后从 cursor=0 重新核对，按已有版本去重。不匹配的文件只跳过传输，绝不能生成删除操作，不自动清理旧文件，也不丢掉文件元数据或未上传内容。重新允许该类型后，可重新扫描并恢复传输。

文件字节上传/下载可采用有界池，建议从 3–4 个并发请求开始测试；元数据 commit 保持有序。PUT blobs 可以附加编码后的 path 做提前校验；只有 hash 的旧请求仍可暂存内容，但发布新内容的 commit 强制执行规则。422/FILE_TYPE_NOT_ALLOWED 或 DIRECTORY_EXCLUDED 表示策略阻止，应保留待办待规则变化；503/retryable 表示暂时竞争，按 Retry-After 退避，重试原 opId/原 baseVersion。真正的版本冲突仍为 409。

`examples/sync-client.js` 是传输参考，宿主需要实现上述策略缓存、过滤与 revision 重扫，不能把示例当作已完成全部 Android 持久化/过滤的客户端。

## 触发时机

- App 打开、恢复前台、用户点击“立即同步”时拉取并提交。
- 历史、进度、搜索、配置变化先写 outbox，再去抖同步。播放期间可适度合并进度，在暂停、退出和换集时补交。
- App 活跃时每 60–120 秒轻量拉取（可配置），请求本身更新 last_seen。没有新变更的响应也应记录最后成功时间。
- 断网/5xx/429 保留队列，带抖动的指数退避。离开前台可停止定时器，无需关闭 App 后保活。
- 401 提示凭证撤销/人物停用，停止盲目重试；409 保留候选并提示处理。

## LocalFiles

设备使用 `LocalFileSetting` 配置的自身根目录，只把相对路径交给服务端。拼接后验证规范化路径仍位于根目录内，拒绝符号链接逃逸。文件 UUID 存在独立索引中，不能以路径作为 ID。

文件监听等待稳定写入再取快照。上传重试使用同一个暂存文件，不能一边重试同一 opId 一边重新读取已经变化的内容。下载写临时目录，校验 hash/size 后替换；用应用日志恢复跨文件/数据库操作。

**停用必须改扫描入口。** LocalFileConfig 扫描时查询该文件和所有祖先的 enabled/deleted 元数据。不要仅把 `.py` 改名隐藏，也不要仍把停用文件送进现有扫描器。目录停用不一定给每个子项生成单独版本，客户端要按祖先计算。

下载应用期间标记来源为 remote，并更新索引 hash/version；监听回调发现内容等于已应用版本时不创建新 outbox。只比较“修改时间”不够。

后台不会替 App 选择点播/直播配置。发布接口只产生 URL；用户显式选择后才写 config 记录。根目录路径、音量、解码方式和屏幕布局等设备设置默认不跨设备。

## 记录与播放进度

History/Config 的数据库自增 ID 不传到跨设备身份。为源、站点、影片和剧集建立稳定组合键；不同来源的同名影片不能直接合并。带分享 token 的 URL 应剥离凭证部分再生成稳定来源身份，或直接使用 shareId。

每次播放开始创建 sessionId，sequence 单调递增。position 可减小；旧离线会话遇到 409 后不能拿最新版本号自动重放。UI 可以询问用户选择本机进度或云端进度。

SQLite 内部事务读取记录快照并写 outbox，不复制活跃数据库文件。搜索清空与历史删除逐条同步墓碑。

## 单设备远程配置

按 [设备控制协议](DEVICE_CONTROL.md) 接入独立的轻量检查任务，前台约 5 秒读取待办和刷新序号，不被批量文件传输阻塞。实际加载后才上报 appliedRevision；失败保留成功版本、真实值与错误原因。旧后台的 404 不得影响普通同步。

后台下发的是单设备配置，应用时标记远程/设备级来源并更新防回传基线，不能在下一轮快照或现有配置监听中重新上传成人物共享 config，造成其他设备跟随切换。

## 云端重置

管理员主动重置会清空云端人物和设备凭证，原 App 请求会得到 401。新版 App 验证旧授权失效后允许填写新设备码，新身份传输前确认实际用户名；旧地址资料和待上传队列单独保留，不直接归给新人物。云端操作不自动删除手机文件和历史。

## 分享密码适配

可先由浏览器打开 `/s/<shareId>` 输入密码，获得带 token 的配置 URL，再粘贴到 App。生成的脚本 URL 保留扩展名，JSON 相对依赖会自动带授权；是否兼容所有 ys 加载器仍须安装后实测，不能以服务端测试代替真机结论。

若要 App 内原生密码弹窗，检测 `/share/` 的 401 和 `detail.authUrl`，只对同源 authUrl 发 POST；成功后保存永久 token（expires 为 null）并重新加载；公开接口不需要密码或 token。不要把旧 Apidog/Apifox 的 Cookie 提交协议直接套过来。token 被主动撤销后重新输入分享密码，不涉及人物同步 token。

只读参考入口：`LocalFileSetting.java`、`LocalFileConfig.java`、`bean/History.java`、`bean/Config.java`、`app/src/mobile/.../SettingFragment.java` 与 `fragment_setting.xml`。大屏入口位于 `app/src/leanback`；同步核心应放在共享 main 模块。
