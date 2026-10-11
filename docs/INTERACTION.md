# 点击方式与受保护画面

## 坐标触摸与元素定位

元素点击先确认目标身份、可用性和屏幕内边界，再执行动作。坐标触摸通过 scrcpy 发送按下、抬起事件。UI Automator 的元素定位点击则由其定位器查找控件并执行点击；其常规 `click()` 最终也发送坐标触摸，不能把这条路径标为无障碍节点的 `ACTION_CLICK`。

真实的节点动作是 `AccessibilityNodeInfo.performAction(ACTION_CLICK)` 等接口，与上述两条触摸路径不同。当前上游 UI Automator 接口没有供本项目直接使用的通用节点动作入口，需要另外扩展 Android 端能力。

触摸注入不能保证与物理手指无法区分。落点偏移只改变点击位置，不证明能够避免应用风控。节点位于屏幕范围内，也不代表没有被其他窗口遮挡。

## 随机落点

元素点击、长按，以及需要改变状态的开关点击，默认开启随机落点。界面元素区域的“随机落点”复选框可以关闭它，设置保存在当前浏览器中。执行 JS 时保存该设置作为本次任务的默认值；任务开始后再修改复选框，不会改变运行中任务的默认值。

落点位于目标与手机屏幕相交区域的中心附近，每个方向的偏移最多为 5 个手机像素，且不超过该方向有效区域尺寸的 10%。小于 10 像素的方向不偏移。选定的落点在按下和抬起时保持一致，长按不会变成拖动。关闭偏移时使用中心点。

以下 JS 参数可以覆盖任务默认值：

```js
await device.element({text: "目标按钮"}).click({jitter: true});
await device.element({text: "目标按钮"}).click({jitter: false});
await device.element({text: "目标按钮"}).longPress({durationMs: 800, jitter: true});
await device.element({resourceId: "com.example.app:id/toggle"}).setChecked(true, {jitter: true});
```

HTTP 的 `POST /api/node` 和 `POST /api/tasks` 支持 `clickOptions: {jitter: false}`；未提供时默认开启。SDK 保持唯一匹配、过期目标验证和开关状态回读。触摸回执包含 `jitter` 和实际手机坐标 `point: {x, y}`；这些坐标尚未缩放为视频像素，动作效果仍以 `verification` 为准。

直接点击或拖动视频、`device.tap(x,y)` 等明确指定坐标的手势、输入框聚焦与文本替换不加入随机偏移。设置开关时若已经达到期望状态，不发送触摸，也不会产生落点回执。没有新增点击后端或备用模式。

## 文字输入与结果确认

网页只保留一个草稿框。编辑、`fill/type`、Enter 换行都不会写入手机；只有点击“填写到手机（替换全文）”才执行一次操作。目标来自唯一的可编辑手机焦点，或使用者在下拉列表/元素树中的明确选择。不会猜测多个字段，也不会在焦点变化后自动把草稿发往新字段。

手机改字不会覆盖网页草稿。“读取当前内容”读取所选字段一次，替换草稿前会提示未发送内容；读取不会修改手机。原始键盘、剪贴板和额外手势放在高级操作中。原始按键仍可能经过 IME，其回执只表示已发送，不证明应用接受。

网页按钮与 JS `element.setText(text)` 共用一次写入、原目标回读验证。不需要手动绑定、不轮询同步、不根据手机新内容自动改写草稿，也不在填写后发送 Enter/Tab 或点击业务提交按钮。

- 写入前窗口、目标身份或边界不匹配：拒绝操作，重新选择目标后再填写。
- 写入后原目标文字一致：返回 `verification=verified`。验证码自动跳到下一格不单独构成失败。
- 写入后文字不同：报 `TEXT_VERIFY_FAILED`，回执包含 `execution=sent`、`verification=failed`。
- 写入后窗口变化或原目标无法回读：报 `TEXT_RESULT_UNKNOWN`，回执包含 `execution=sent`、`verification=inconclusive`。先观察手机，不能当作未执行而直接重试。

以上两种写入后错误均会停止 JS 中未捕获错误的后续调用；网页保留草稿，不自动重试。更换视频通道或重连不会自动补发文字。

`/api/binding` 和旧 `/api/text` 属于已移除的网页同步接口。一次写入使用 `/api/node` 的 `setText` 动作；按需读取使用 `POST /api/node/text`，参数为 `target`。公开 JS SDK 的 `element.setText()` 调用形式不变。

## 受保护画面：已记录，暂不考虑 root

2026-10-11 记录：使用者反馈某些应用的登录页在手机上正常显示，但串流只显示标题栏，正文为黑色；使用者确认这是安全内容捕获限制。本轮没有在真实设备上复现或读取目标窗口标志。

Android 的 `FLAG_SECURE`、安全 Surface 等机制允许内容显示在物理屏幕上，同时从截图或非安全屏幕捕获输出中排除。标题栏可见、部分内容为黑色与这种行为相符；具体保护层仍需后续诊断确认。

目前保留以下边界：

- 暂不研究或实施 root、Hook、系统权限修改来解除保护。
- 更换 TURN/WSS 通道、调整编码或重连不能恢复在手机采集阶段已经被排除的内容。
- 视频连接正常与内容完整可见是两个不同状态；未来应在界面和观察 API 中明确提示受保护内容。
- UI 树可能仍可读取，但不能假设所有受保护页面都暴露节点；现有密码字段限制仍然有效。
- 仅靠黑色像素无法确认安全窗口，应结合窗口证据，证据不足时标记为未知。

后续可以评估只读窗口信息探测与状态提示。当前仅记录事项，没有加入探测、改变录屏行为或解除保护。

参考：[Android 安全窗口说明](https://developer.android.com/security/fraud-prevention/activities)、[scrcpy 上游受保护窗口说明](https://github.com/Genymobile/scrcpy/issues/3072)。
