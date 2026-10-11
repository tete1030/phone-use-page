export const SDK_VERSION='1.3.1';
export const apiMethods = [
  {name:'device.observe()',signature:'device.observe(): Promise<Observation>',purpose:'只读：读取最新设备状态和安卓节点快照。',params:'无参数。',result:'返回 snapshotId、foregroundApp、nodes、focus、focusEpoch、能力与错误。',example:'return await device.observe();',note:'不包含网页焦点或操作台控件。'},
  {name:'device.element(selector)',signature:'device.element(selector): ElementLocator',purpose:'建立节点查询，本身不操作手机。',params:'text、resourceId、description、className、package，可组合精确匹配。',result:'返回具有动作方法的定位器。',example:'await device.element({ text: "WLAN" }).click();',note:'执行时必须唯一匹配；重名报 AMBIGUOUS_TARGET，不猜第一个。'},
  {name:'element.click()',signature:'ElementLocator.click({jitter}={}): Promise<ActionResult>',purpose:'通过触摸点击经过重新验证的目标。',params:'jitter：可选布尔值，默认沿用运行脚本时的“随机落点”设置；未指定设置时开启。',result:'返回执行回执、snapshotId、jitter 和实际手机像素落点 point。',example:'await device.element({ text: "WLAN" }).click({jitter:true});',note:'偏移限于中心附近，单轴最多 5 px；小控件自动缩小范围。jitter:false 使用中心点，不保证免于风控。'},
  {name:'element.longPress()',signature:'ElementLocator.longPress({durationMs=700,jitter}={}): Promise<ActionResult>',purpose:'长按报告 longClickable 的目标。',params:'durationMs：400–3000 毫秒；jitter 同 click。',result:'返回执行回执及实际手机像素落点 point。',example:'await device.element({ text: "WLAN" }).longPress({durationMs:800,jitter:true});',note:'未报告长按能力时拒绝；整个按下到抬起过程使用同一个落点。'},
  {name:'element.focus()',signature:'ElementLocator.focus(): Promise<ActionResult>',purpose:'点击可编辑目标请求手机输入焦点。',params:'无参数。',result:'返回 ActionResult；重新观察 focus 判断实际焦点。',example:'await device.element({ className: "android.widget.EditText" }).focus();',note:'焦点改变后网页文字会话需要重新绑定。'},
  {name:'element.setText(text)',signature:'ElementLocator.setText(text): Promise<ActionResult>',purpose:'通过 UI Automator 替换完整文本，支持 Unicode。',params:'text：字符串，最多 32768 字符。',result:'返回 ActionResult。',example:'await device.element({ className: "android.widget.EditText" }).setText("蓝牙");',note:'整值替换会影响光标位置。密码与不支持的自绘字段拒绝。'},
  {name:'element.setChecked(value)',signature:'ElementLocator.setChecked(value,{jitter}={}): Promise<ActionResult>',purpose:'设置已报告 checkable/clickable 的开关并验证。',params:'value：true 或 false；jitter 同 click，仅在需要点击时生效。',result:'返回 ActionResult；未达到状态时报 VERIFY_FAILED。',example:'await device.element({ description: "WLAN 开关" }).setChecked(false,{jitter:true});',note:'选择器须按实际节点填写；不是 Android ACTION_SET_CHECKED。'},
  {name:'element.scrollIntoView()',signature:'ElementLocator.scrollIntoView(): Promise<ElementSnapshot>',purpose:'向上滑动当前界面直到目标唯一可见。',params:'无参数；最多 8 次滑动。',result:'返回可见节点或 TARGET_NOT_FOUND。',example:'await device.element({ text: "更多设置" }).scrollIntoView();',note:'有限的向下列表查找，不支持任意方向或隐藏应用状态。'},
  {name:'device.press(key)',signature:'device.press(key): Promise<ActionResult | WakeResult>',purpose:'手机导航或功能按键；WAKEUP 唤醒并请求系统解锁。',params:'BACK、HOME、RECENTS、ENTER、ESC、TAB、BACKSPACE、DELETE、UP、DOWN、LEFT、RIGHT、SPACE、PASTE、MOVE_HOME、MOVE_END、WAKEUP。',result:'普通按键返回 ActionResult；WAKEUP 返回 status、screenOn、locked。',example:'await device.press("BACK");',note:'锁屏/熄屏时普通按键被拒绝；WAKEUP 不输入密码，未成功解锁时需用户在手机上完成。'},
  {name:'device.tap(x,y)',signature:'device.tap(x,y): Promise<ActionResult>',purpose:'使用手机像素坐标点击。',params:'x、y 为 observe 返回的手机显示坐标。',result:'返回 ActionResult。',example:'await device.tap(540,1200);',note:'不是网页 CSS 坐标；显示方向或尺寸不一致时拒绝。'},
  {name:'device.swipe(...)',signature:'device.swipe(x1,y1,x2,y2,{durationMs=350}={}): Promise<ActionResult>',purpose:'手机坐标滑动；drag 同样接受这些参数。',params:'坐标为 px，durationMs 为 100–5000 毫秒。',result:'返回 ActionResult。',example:'await device.swipe(540,1800,540,800,{durationMs:400});',note:'取消后释放触摸；无法回滚已完成动作。'},
  {name:'device.pinch(options)',signature:'device.pinch({x,y,startDistance,endDistance}): Promise<ActionResult>',purpose:'双指缩放。',params:'中心与两指间距为手机 px。',result:'返回 ActionResult。',example:'await device.pinch({x:540,y:1200,startDistance:100,endDistance:400});',note:'两指端点必须位于有效屏幕内。'},
  {name:'device.waitFor(selector)',signature:'device.waitFor(selector,{timeoutMs=5000}={}): Promise<ElementSnapshot>',purpose:'只读等待唯一可见目标。',params:'选择器同 element，timeoutMs 最大 30000。',result:'返回节点；超时报 TIMEOUT。waitGone 等待目标消失。',example:'await device.waitFor({text:"设置"},{timeoutMs:5000});',note:'出现不等于界面完全静止，不自动点击。'},
  {name:'device.sleep(ms)',signature:'device.sleep(ms): Promise<void>',purpose:'可取消地等待。',params:'0–30000 毫秒，受任务总时限限制。',result:'返回 null。',example:'await device.sleep(300);',note:'优先等实际界面条件；支持停止任务。'},
  {name:'device.openApp(packageName)',signature:'device.openApp(packageName,{component}={}): Promise<ActionResult>',purpose:'打开当前 Android 用户的应用启动入口。',params:'packageName：包名；可选 component 从 apps().launchers 选择。',result:'返回启动请求回执；无入口、组件失效、锁屏时拒绝。',example:'await device.openApp("com.android.settings");',note:'不强制停止应用；按桌面启动语义处理。恢复特定已有任务使用 switchTask。'},
  {name:'device.apps(options)',signature:'device.apps({launchableOnly=false,refresh=false}={}): Promise<AppEntry[]>',purpose:'只读：已安装包与可启动组件。',params:'launchableOnly 过滤没有桌面入口的包；refresh 强制刷新 60 秒缓存。',result:'返回 packageName、thirdParty、launchers。',example:'return await device.apps({launchableOnly:true});',note:'当前显示包名，不伪造应用名称；一个包可以有多个入口。'},
  {name:'device.recentTasks()',signature:'device.recentTasks(): Promise<AndroidTask[]>',purpose:'只读：当前 Android 用户的系统近期任务。',params:'无参数。',result:'返回 taskId、顶部 Activity、activities、foreground、switchable。',example:'return await device.recentTasks();',note:'近期记录不等于运行中的进程；没有 Activity 的记录不可直接切换。'},
  {name:'device.runningApps()',signature:'device.runningApps(): Promise<ProcessObservation>',purpose:'只读：检测到可见进程的应用。',params:'无参数。',result:'返回 apps：包名与 PID/UID/进程名，及 processScope。',example:'return await device.runningApps();',note:'包含缓存和服务，非活跃计算证明；自定义或隔离进程名可能无法归属。'},
  {name:'device.navigation()',signature:'device.navigation(): Promise<Navigation>',purpose:'只读：当前任务与系统 Task → Activity 层级。',params:'无参数。',result:'返回 current、tasks、userId、locked、internalStack="unknown"。',example:'return await device.navigation();',note:'Fragment、Compose、WebView 内部页面返回栈未知；Activity 数不等于页面数。'},
  {name:'device.switchTask(taskId)',signature:'device.switchTask(taskId): Promise<ActionResult>',purpose:'聚焦已有任务并验证实际 resumed taskId。',params:'taskId：从最新 recentTasks() 获取的整数。',result:'返回 taskId 和实际前台组件，过期或不可聚焦时报错。',example:'const tasks=await device.recentTasks(); console.log(tasks); // 选择实际 taskId 后调用 device.switchTask(taskId)',note:'不会退化为重新打开应用，也不使用任务锁定；OS 仍可能重建被回收的 Activity。'},
  {name:'device.back(options)',signature:'device.back({steps=1,stopOnTaskChange=true,intervalMs=350}={}): Promise<BackResult>',purpose:'顺序发送 BACK，每次回读系统导航状态。',params:'steps 1–10；intervalMs 100–2000 ms；默认前台任务/包变化后停止后续按键。',result:'返回 requested、completed、reason、逐步 transitions；可被停止任务取消。',example:'return await device.back({steps:2});',note:'次数是按键次数，可能先关闭输入法或弹窗；不保证页面层数或最后一次不会退出应用。'},
  {name:'device.uiTree() / screenshot()',signature:'device.uiTree(): Promise<AndroidNode[]>',purpose:'只读获取树；screenshot 读取诊断图。',params:'无参数。',result:'uiTree 返回节点；screenshot 返回 {mime,data}，data 为 Base64。',example:'return await device.uiTree();',note:'视频使用独立连续流，截图不作为实时视频替代。'},
  {name:'device.panel(kind)',signature:'device.panel("notifications" | "settings"): Promise<ActionResult>',purpose:'展开通知栏或控制中心。',params:'kind为notifications或settings。',result:'返回已发送回执；面板呈现需观察。',example:'await device.panel("notifications");',note:'ROM可能限制设置面板展开，非导航返回栈。'},
  {name:'device.clipboard()',signature:'device.clipboard(): Promise<{text:string}>',purpose:'按需读取手机剪贴板。',params:'无参数。',result:'返回text；Android拒绝时明确报错。',example:'return await device.clipboard();',note:'不会自动覆盖网页草稿或粘贴。'},
  {name:'device.setClipboard(text)',signature:'device.setClipboard(text): Promise<ActionResult>',purpose:'写手机剪贴板，不自动粘贴。',params:'Unicode字符串，最多32768字符。',result:'返回已发送、未验证。',example:'await device.setClipboard("hello");',note:'手机权限受ROM限制。'},

];

export function sdkBootstrap() {
  return `const call=(method,params={})=>__rpc(method,JSON.stringify(params)).then(JSON.parse);
  globalThis.device=Object.freeze({
    panel:(kind)=>call('panel',{kind}),clipboard:()=>call('clipboard',{write:false}),setClipboard:(text)=>call('clipboard',{write:true,text}),observe:()=>call('observe'),uiTree:()=>call('uiTree'),screenshot:()=>call('screenshot'),
    element:(selector)=>Object.freeze({
      click:(options={})=>call('node',{selector,action:'click',clickOptions:options}),
      longPress:(options={})=>{const {durationMs,...clickOptions}=options;return call('node',{selector,action:'longPress',value:durationMs??700,clickOptions});},
      focus:()=>call('node',{selector,action:'focus'}),setText:(text)=>call('node',{selector,action:'setText',value:text}),
      setChecked:(value,options={})=>call('node',{selector,action:'setChecked',value,clickOptions:options}),scrollIntoView:()=>call('scrollIntoView',{selector})
    }),
    tap:(x,y)=>call('gesture',{kind:'tap',x,y}),
    swipe:(x1,y1,x2,y2,options={})=>call('gesture',{kind:'swipe',x1,y1,x2,y2,...options}),
    drag:(x1,y1,x2,y2,options={})=>call('gesture',{kind:'drag',x1,y1,x2,y2,...options}),
    pinch:(options)=>call('gesture',{kind:'pinch',...options}),
    press:(key)=>call('press',{key}),sleep:(ms)=>call('sleep',{ms}),
    waitFor:(selector,options={})=>call('waitFor',{selector,...options}),
    waitGone:(selector,options={})=>call('waitGone',{selector,...options}),
    apps:(options={})=>call('apps',options),recentTasks:()=>call('recentTasks'),runningApps:()=>call('runningApps'),navigation:()=>call('navigation'),
    switchTask:(taskId)=>call('switchTask',{taskId}),back:(options={})=>call('back',options),
    openApp:(packageName,options={})=>call('openApp',{packageName,...options})
  });globalThis.console=Object.freeze({log:(...args)=>__log(JSON.stringify(args)),warn:(...args)=>__log(JSON.stringify(args))});`;
}
