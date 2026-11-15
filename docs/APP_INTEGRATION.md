# ys App 接入边界

本项目已实现服务端接口、后台页面及 JavaScript 传输参考，**尚未改动 ys Android 源码，也没有编译或真机验证**。以下是后续在 ys 项目会话中实施的接入约定。

## 设置入口与页面

手机版可把缓存行拆为 `[同步] [缓存]`，下一行保留 `[备份] [恢复]`；或把同步图标放在顶部遥控器图标左侧。最终入口位置尚待用户选择，不能把建议当作定案。

独立同步页至少包含服务器 URL、后台已有用户名、设备名称、绑定码、自动同步开关、立即同步、当前状态、最后成功时间和日志。初次绑定后隐藏绑定码输入，保存返回的 userId/deviceId/token。

人物可在同一设备切换，但后台管理员不是人物。每个绑定关系保留独立凭证、队列、游标、文件索引和本地数据命名空间。切换前冻结原人物会话；原人物未上传队列继续归属原 userId，不改标签转给新人物。

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

## 分享密码适配

可先由浏览器打开 `/s/<shareId>` 输入密码，获得带 token 的配置 URL，再粘贴到 App。生成的脚本 URL 保留扩展名，JSON 相对依赖会自动带授权；是否兼容所有 ys 加载器仍须安装后实测，不能以服务端测试代替真机结论。

若要 App 内原生密码弹窗，检测 `/share/` 的 401 和 `detail.authUrl`，只对同源 authUrl 发 POST；成功后保存永久 token（expires 为 null）并重新加载；公开接口不需要密码或 token。不要把旧 Apidog/Apifox 的 Cookie 提交协议直接套过来。token 被主动撤销后重新输入分享密码，不涉及人物同步 token。

只读参考入口：`LocalFileSetting.java`、`LocalFileConfig.java`、`bean/History.java`、`bean/Config.java`、`app/src/mobile/.../SettingFragment.java` 与 `fragment_setting.xml`。大屏入口位于 `app/src/leanback`；同步核心应放在共享 main 模块。
