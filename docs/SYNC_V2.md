# 通用同步 API v2（对接契约）

后台只保存按用户隔离的 JSON 与普通文件，不解释客户端业务。所有接口沿用设备绑定返回的 `Authorization: Bearer <token>`。默认由客户端用户手动选择推送或下载；普通同步不自动推送本机修改。

可直接参考 [轻量 JavaScript SDK](../examples/sync-v2-client.js)：`pushAll` 枚举本次数据/文件并确认清单，`download` 自动分页和确认。`onProgress` 返回同一任务累计进度，调用方更新同一行即可；`putFile` 负责完整写临时文件再替换，真实 I/O 错误直接抛出，SDK 不会确认成功。

后台创建用户并生成设备码后，客户端用 `POST /api/bind` 提交 `{code,deviceName}`，获得 `{deviceId,userId,token,username}`。不传管理员密码，不自行指定 userId。`GET /api/health` 的 `syncApi:2` 表示支持本文协议；`GET /api/sync/settings` 可使用相同设备凭证读取通用文件规则。

## 数据与推送

`POST /api/v2/sync/push`，JSON：

```json
{"requestId":"本次操作UUID","namespace":"org.example.app.settings","upsert":[{"key":"preferences","value":{"theme":"dark","extensions":{}}}],"delete":["removed-record"]}
```

`namespace` 是客户端约定的数据分区，`key` 是该分区里的普通字符串名称，不是摘要或服务器记录 ID；单例可以始终用 `preferences`。`value` 可为任意 JSON。服务端负责 ID、版本、去重、发布和历史。响应 `{ "ok":true }`。同一 requestId 重试必须使用同一内容；不同请求按服务器提交顺序覆盖同一个 key。

仅 upsert 列出的 key 整体替换，delete 列出的 key 删除，省略的记录、其他 namespace 均保持不变。没有隐式“全量推送即删除遗漏项”。各客户端扩展须使用独立 namespace/key，不能在共同 JSON 文档里整体替换其他客户端的未知字段。`legacy.*` 为只读旧数据分区。

一次最多 50 个 upsert/delete，总 JSON 128 KiB，单条 value 16 KiB；更多记录分批提交。namespace 最长 120 字符，key 最长 2000 字符。每个用户现有 5000 条实体上限继续有效。

## 文件推送

`PUT /api/v2/sync/file?path=<编码的相对路径>`，请求体为原始字节，`Content-Type: application/octet-stream`，`Idempotency-Key: <本次操作UUID>`。成功响应 `{ "ok":true,"path":"dir/a.py","size":123 }`。服务端计算摘要、创建父目录、复用内容并发布；无需先传 blob、hash、ID 或版本。同路径覆盖，不删除其他路径。当前纯 D1 单文件仍限 1.5 MiB。

`DELETE /api/v2/sync/file?path=...`，相同 Idempotency-Key 规则；仅删除该普通文件，不递归删除目录。不存在也成功。移动可先写入新路径再删除旧路径。

后缀/排除目录规则应用于文件上传与恢复。被排除的上传返回 200 `{ "ok":true,"skipped":true,"reason":"DIRECTORY_EXCLUDED" }` 或 `FILE_TYPE_NOT_ALLOWED`，不是同步失败；不会因未上传或排除而隐式删除旧文件。

### 手动完整推送

为避免客户端维护旧清单，同一 push 接口支持完整发布会话：

1. `POST /api/v2/sync/push`：`{"action":"start","requestId":"UUID","scope":{"namespaces":["org.example.app.settings"],"files":true,"roots":[""]}}`，返回 `{session,expiresAt}`。
2. 分批推送本机当前全部记录，每次原数据推送 body 增加 `session`；逐个推送当前文件时增加 `X-Sync-Session` 请求头。成功的 key/路径自动进入本次清单；无需上传旧清单或计算差异。规则排除的文件可以省略。
3. 所有上传成功后 `POST /api/v2/sync/push`：`{"action":"finish","session":"..."}`。服务器删除指定分区/文件根范围内本次未出现的记录或文件；保留其他分区、范围外文件及当前排除项。返回 `{ok:true}`，重复确认幂等。

未 finish 不会按遗漏项删除，已成功上传的单项可见；这不是整批回滚事务。会话绑定设备，有效期 24 小时；过期重新开始。每个分区须由客户端明确管理，不能把其他客户端的扩展分区包括在完整发布范围里。

## 唯一恢复接口

所有阶段使用 `POST /api/v2/sync/restore`。客户端仅保存服务端返回的不透明 session/page/content 标记，无需游标、版本、hash 或本地扫描比较。

开始：

```json
{"action":"start","requestId":"本次下载UUID","scope":{"namespaces":["org.example.app.settings","legacy.config"],"files":true,"roots":[""]},"full":false}
```

`namespaces` 必填且为精确名称；`files` 默认 false，true 时 roots 默认为 `[""]`（全部相对目录）。不同 scope 独立保存设备上次成功恢复的状态。首次为 full，后续默认 delta；`full:true` 强制全量。在线点播是否选择 files、客户端本地目录映射完全由客户端决定。服务端没有 LocalFiles、点播/直播或绝对路径概念。

响应：

```json
{"session":"不透明标记","mode":"delta","page":"第一页标记","total":3,"expiresAt":1800000000000,"policy":{"fileExtensions":["py"],"includeExtensionless":true,"excludedDirectories":["_cache","__pycache__","pycache"]}}
```

取包：`{"action":"page","session":"...","page":"..."}`。

```json
{"items":[{"type":"data","op":"put","namespace":"org.example.app.settings","key":"preferences","value":{"theme":"dark"}},{"type":"file","op":"put","path":"dir/a.py","size":123,"content":"内容标记"},{"type":"file","op":"delete","path":"removed.py"}],"next":"下一页标记或null","done":false}
```

数据删除项为 `type:data, op:delete, namespace, key`。每页最多 25 项，文件字节不内嵌 JSON。`{"action":"content","session":"...","content":"..."}` 返回固定快照的原始文件字节。开始后发生的云端更新留到下次恢复，不混入当前会话。所有标记绑定该设备与用户，不能跨设备使用。

客户端收到 put 直接覆盖本机，即使本机有未推送修改；收到 delete 直接删除。文件正常下载完整后替换。完整恢复下发所选 namespace 的全部记录，客户端先清空这些自己管理的分区再应用；其他 namespace 保留。文件 full 下发全部允许文件以及服务端已知删除，不能凭空删除服务端从未见过的本地文件；不需要本地扫描对比。排除规则造成的消失不会生成删除通知。

所有包和文件都成功应用后：`{"action":"ack","session":"..."}`，响应 `{ "ok":true }`。只有 ack 成功才推进设备基线；失败、中断不确认，可用原 session/page 重取，重复 ack 幂等。必须先取完分页；应用是否成功由客户端负责。会话有效期 24 小时，过期返回 410，重新 start 将按最后成功基线重新恢复。云端基线按用户/设备/规范化 scope 隔离，较旧会话确认不会覆盖较新基线。

未确认就开始新会话会自动转为 full，补发全部当前内容及此前可能应用的删除通知；因此中断后云端恰好改回旧值也不会漏恢复。旧会话被较新会话替代后确认会返回 409 `RESTORE_SUPERSEDED`，重新开始下载即可。客户端只需串行执行同一范围的恢复，不做版本冲突判断。

## 旧数据与上线

原账号、设备 token、分享、后台文件界面与版本历史保留。新文件接口和后台共用现有文件存储。旧非文件实体以 `legacy.<原kind>`、key=原实体 ID、value=原 data 原样提供，后台不解释内容；例如既有 config 被读取为 legacy.config。客户端可读取后转入自己的 namespace，旧记录保留供旧版使用。v2 不要求再生成旧协议的 SHA256 ID。旧 API 暂时继续工作。

旧数据是兼容导入来源，不应每次覆盖客户端已发布的新分区。客户端可在自己的扩展分区保存已导入标记；该标记及旧数据的业务转换由客户端决定，服务端不识别其含义。

先上线后端 v2 与文档，确认健康检查正常，再发布使用 v2 的 App。客户端遇到 404 应提示服务器需升级，不静默改用自动双向推送。错误沿用 `{error,detail?}`；同一任务在客户端一行更新累计进度，不逐文件写日志。
