# 按设备读取与下发配置

此功能独立于人物的历史和共享 config 记录。只修改选中的 deviceId，不影响同人物的其他设备。后台保存指令不等于 App 已成功加载，必须以设备回报为准。

App 应用设备指令时须标记远程/设备级来源，同时更新本地防回传基线；不能被已有 Config 监听或下一轮快照重新上传成人物共享配置，间接让其他设备跟随切换。

## 字段

四项值都用字符串表示：`vod` 点播、`live` 直播、`theme` 主题、`wallpaper` 壁纸。URL 或现有 App 支持的配置值由 App 的相应加载器处理；服务端不会代为请求这些地址。空字符串表示清空/恢复默认。

## App 接口

都使用该设备的 Bearer token，不接受客户端传 deviceId 来切换目标。

`GET /api/sync/device-config`：

```json
{
  "revision": 2,
  "values": {"vod":"https://example.com/vod.json"},
  "appliedRevision": 1,
  "refreshRevision": 3,
  "reportSeq": 5,
  "pollAfterMs": 5000
}
```

- `values` 只包含待应用的字段，没有待办时为 `{}`，不要求所有字段一起改。
- `revision` 是管理员指令版本；未确认的多次修改会合并，已确认的旧字段不会被无关的新指令重复下发。
- `refreshRevision` 是实时取值请求序号，更新后应重新采集当前值并上报。
- `reportSeq` 是已接受的最新回报序号，用于首次恢复本机计数。

`POST /api/sync/device-config/report`：

```json
{
  "sequence": 6,
  "values": {"vod":"https://example.com/vod.json","live":"","theme":"system","wallpaper":""},
  "appliedRevision": 2,
  "refreshRevision": 3,
  "error": ""
}
```

每次必须上报四项真实值。`sequence` 按设备单调递增；同序号同内容重试幂等，旧序号或同序号不同内容返回 409。应用成功后才推进 appliedRevision；失败保持最后成功版本、回报实际值并填写最多 500 字符的 error。当前完整版本确认时，服务端校验实际值与下发字段一致。

先持久化这次完整回报再发送，网络失败重发同一序号和内容。收到 409 后重新 GET 并重新采集本机值；不能把过时采样换成更大序号强行覆盖。应用过程中又有新指令时，可以先确认已经完成的旧版本，再读取下一版；后台仍显示新版本待处理。

建议绑定有效且 App 前台运行时约 5 秒检查一次，使用独立的有界控制任务，不被大量文件传输阻塞。不要求 App 退出后强保活或 WebSocket。初次绑定、四项值本机变化和刷新请求变化时主动上报；无需每 5 秒无条件重复写相同回报。旧后台返回 404 时跳过此能力，不能影响普通同步。

## 管理端接口

- `GET /api/admin/devices/:id/config`：返回 desired、revision、current、reportedAt、appliedRevision、reportSeq、refreshRevision、reportedRefreshRevision、requestedAt、error。`current=null` 表示从未收到真实回报。
- `PUT /api/admin/devices/:id/config`：`{opId,baseRevision,values}`，values 是要修改的字段。相同 opId 原请求重试幂等；过时 baseRevision 返回 409。
- `POST /api/admin/devices/:id/config/refresh`：返回递增 refreshRevision，不会伪造设备当前值。

后台弹窗每 2 秒查看新回报，最长等待 60 秒。设备未运行、离线或尚未接入接口时，显示最后回报和等待提示。关闭弹窗停止轮询。

## 已有绑定保护

`POST /api/bind` 允许额外携带 `expectedUserId`。有此字段时，设备码必须属于该人物；有效码不匹配返回 `409` 和 `detail.code=USER_MISMATCH`，不消费码、不创建设备。过期或已使用的无效码仍返回 401。新安装不传此字段。

首次未配置服务器的外部链接由 App 确认一次服务器来源；同一既有服务器可以继续绑定，不同既有服务器禁止静默覆盖。App 仍应校验返回 userId，保留原凭证与原人物队列。
