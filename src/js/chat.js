// ===== 功能：聊天（主聊天页） =====
// ⚠️ 2026-08-25 深夜磁盘满事故：本文件曾 0 字节，由 HEAD(9928715) index.html 产物段恢复（minified，原注释已失）
// 已补回当时未提交的两处改动：①桌面弹窗头像 cs-avatar-partner；②经期关心 20% 预掷门控移除（详见 WORKLOG 紧急横幅）

(function () {
const body = document.getElementById('chat-body');
if (!body) return;
const chatLoadingEl = document.getElementById('chat-loading'); // v3.26.x：聊天记录加载进度条
const uid = window.activePrefix();
const store = window.activeStore();
function closeIme() {
try {
const ae = document.activeElement;
if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) ae.blur();
} catch (e) {}
}
let msgs = [];
const sessionChangedIdx = new Set();
let chatDbReady = false;
// FIX 2026-09-15 #526：本会话已确认当前桌面无历史（全新/空库）——进度条不再显示（见 updateChatLoading）
let chatKnownEmpty = false;
let lastIdbLoadPrefix = null;
let lastIdbLoadAt = 0;
const IDB_RELOAD_MIN_GAP = 8000;
// FIX 2026-09-21 #967 权威未达标记：本桌「已起读、权威还没到手」期间恒真。与 chatDbReady
// 分工不同——chatDbReady 只管「读库链已收口、可以放开写盘」，armReadyFuse 的 15s 保险丝也会
// 把它置真（那只是解写盘死锁，不代表数据到了）。进度条必须认「数据到没到」而不是「保险丝跳
// 没跳」：旧实现两者混用一个标志，保险丝一跳进度条就收，屏上却一条消息都没有 ⇒「聊天里
// 什么也看不到」且再没有任何读库入口（无头实证：读全失败进聊天，第 15s 进度条收起、第 35s
// 6 次快重试耗尽、90s 仍空屏零提示；模拟回前台事件也不恢复，只有再点一次进聊天才回来）。
let chatAuthPending = false;
// #967 慢重试看门狗：IDB_RETRY_MAX 的 6 次快重试（5s 一档）耗尽后旧实现永久放弃，而「在飞链
// 被冻结 / 大键读超时」这类失败往往几十秒后才恢复 ⇒ 屏上永久空白且无读库入口。看门狗在
// 「聊天页可见 + 权威未达 + 非确认空库」期间每 15s 补一次真读（forceIdb 绕过去重闸），权威一到
// 即自停；离开聊天页不空转（重进聊天走 enterChat 自身那条链）。
const CHAT_AUTH_WATCH_MS = 15000;
let authWatchT = null;
// #967 权威到手判定：读到权威数据（含空数组）或确认空库都算「有结论」；只有保险丝置真的
// ready 不算（那正是空屏的来源）。
function chatAuthSettled() { return chatKnownEmpty || (chatDbReady && !chatAuthPending); }
let pendingLocal = null; // 权威就绪前暂存的内存消息（绝不落盘，防止污染读取/覆盖 IDB）
// ===== v3.26.x 止血：聊天大包（含图片 base64）避免「每个交互同步全量写」 =====
// 根因：chat-msgs 单键可达数百 MB（图片 base64 内联），saveMsgs/saveMsgsNow 每次
// 都对整包同步 JSON.stringify + idbSet → 数百 ms~数秒长任务（发消息/来消息打断、
// 打字缓冲、收键盘卡、上滑卡、切页卡）。方案：把这个整包串化+落盘改为「合并 + 低频
// + 空闲窗口」执行——requestIdleCallback 空闲期或 ≥PERSIST_MIN_GAP 才写一次，
// 不与交互/帧率争主线程；数据语义不变（仍写整包最新，不丢数据），离页仍强制兜底。
const PERSIST_MIN_GAP = 2500;   // 两次实际落盘的最小间隔（ms）
let lastPersistAt = 0;          // 上次实际落盘时间（performance.now()）
let persistTimer = null;        // 排队中标记（rIdle/timeout）
let persistRun = null;          // 待执行落盘闭包（tail 只保留最新一次）
function runPersist() {
  persistTimer = null;
  // FIX 2026-09-19 #814 消息被吞·持久化半边（收口会话在 verify-decision-dedup-exempt G1 稳定红下定位）：
  // 节流等待分支不得提前清空待写槽——原实现先取走 persistRun 再判 PERSIST_MIN_GAP，命中等待分支时
  // 挂出的 setTimeout(runPersist) 重跑读到的是【已被清空的槽】＝这次整包写被静默丢弃且永不重试：
  // chat-msgs 基准包停在上一条、外部只读 chat-msgs 的备份导出/媒体池 GC 全看不到它、flushSave
  // 也救不回（槽已空）＝「刚发的消息莫名消失」。改为：槽里有人才继续，等待分支整体推迟重跑，
  // 推迟期间若被更新的写手顶替则按最新的写（写手串化整个 msgs 数组，晚跑不丢内容）。
  if (!persistRun) return;
  const wait = PERSIST_MIN_GAP - (performance.now() - lastPersistAt);
  if (wait > 0) { persistTimer = setTimeout(runPersist, wait); return; }
  const run = persistRun;
  persistRun = null;
  // #907：聊天落盘相位标记（1628 条/2.9MB 历史时整包 stringify+IDB 写是「卡死几秒」头号嫌疑，
  // 卡顿自检在 >250ms 前台冻结时点名）
  try { if (window.__mochiPhase) window.__mochiPhase('persist(chat)'); } catch (e0) {}
  try { run(); lastPersistAt = performance.now(); } catch (e) {}
}
function schedulePersist(writer) {
  persistRun = writer;
  if (persistTimer) return;
  if (window.requestIdleCallback) persistTimer = window.requestIdleCallback(runPersist, { timeout: 4000 });
  else persistTimer = setTimeout(runPersist, 2500);
}
function flushPersistNow() {
  const run = persistRun;
  persistRun = null;
  persistTimer = null;
  if (run) { try { run(); lastPersistAt = performance.now(); } catch (e) {} }
}
function cancelPersist() { persistRun = null; persistTimer = null; }
document.addEventListener('contact-switched', function () {
try {
// 切走前强制落盘待写（persistRun 闭包已捕获旧命名空间前缀，切桌面后仍写对桌面）
flushPersistNow();
// FIX 2026-09-17 #127：切走前把增量日志收口进基准包（旧桌面），保证该桌面 chat-msgs 完整
try { chatConsolidate(chatArchPrefix); } catch (e) {}
try { hideTyping(); } catch (e) {}
chatArchClearBaseline();
msgs = [];
pendingLocal = null;
chatDbReady = false;
chatKnownEmpty = false; // FIX 2026-09-15 #526：换桌面重新判定
chatAuthPending = false; // #967：新桌面重新判定权威未达状态
stopChatAuthWatch(); // #967：看门狗按桌面重启（旧桌面的等待不得跨桌面续命）
chatBlkResetState(); // #722：换桌面＝分块/热片/冷头状态全部复位（新桌面读自己的块或旧整包）
sessionChangedIdx.clear();
// FIX 2026-09-15 #489：切桌面即作废屏上渲染凭据——聊天 body 的旧 DOM 属于上个会话，
// 切走期间记录可能被跨桌面补投递原地改写（如 问问TA/邀请TA 的 answered），同窗补丁只
// 比对条数/前缀看不见内容变更，会把旧 pending 卡留在屏上（「切走再切回显示未回复」
// 的最后一块拼图）。置 stale 后下次进聊天走整窗渲染，按当前库内数据重画。
windowStale = true;
// v3.14.x：清掉旧联系人遗留的异步状态（跨切换残留的保险丝会把新桌面误置
// 就绪；重试定时器只对旧联系人有意义；authLoadedPrefix 归位重新考核）
if (readyFuse) { clearTimeout(readyFuse); readyFuse = null; }
if (idbRetryTimer) { clearTimeout(idbRetryTimer); idbRetryTimer = null; }
idbRetryCount = 0;
authLoadedPrefix = null;
armReadyFuse();
try { lastQuote = null; } catch (e) {}
try { lastMineText = ''; } catch (e) {}
try { lastMineQuote = ''; } catch (e) {}
try { lastQuotedText = ''; } catch (e) {}
try {
draftImgs = [];
renderDraft();
} catch (e) {}
try { if (input) { input.value = ''; try { input._mLastTyped = ''; } catch (e2) {} } } catch (e) {} // #215 切桌面作废输入快照
try { updateChatPartnerName(); } catch (e) {}
try { fillAvatar('chat-user-av', 'cs-avatar-user'); fillAvatar('chat-partner-av', 'cs-avatar-partner'); } catch (e) {}
try { if (window.applyContinueSayUI) window.applyContinueSayUI(); } catch (e) {}
try { updateChatLoading(); } catch (e) {}   // 切桌面聊天页已隐藏 → 进度条同步隐藏
// v3.26.x：切桌面立即预读新桌面聊天记录——用户导航/点开聊天前读库已在跑，
//   打开聊天页时记录往往已就绪，不再等 enterChat 才开始读（省下数秒等待）
// FIX 2026-09-01 #120：大历史桌面套门控，跳过预读（进入聊天页才读），防低端机崩溃
try { chatPrefetchIfLight(function () { loadMsgs(); }); } catch (e) {}
} catch (e) {}
});
const LS_SNAP_LIMIT = 2 * 1024 * 1024;
let lsSnapTimer = null;
let lsSnapPending = null; // { arr, prefix }：窗口内最新一次请求，trailing 时写
// v3.26.x OOM：聊天大包（图片 base64 内联）浅层字节估算——只取字符串 .length 相加，
// 不拷贝/串化数据本身，用于「是否走精简快照 / 是否数组直存 IDB」的阈值判断。
function msgsBytes(arr) {
if (!Array.isArray(arr)) return 0;
let n = 0;
for (let i = 0; i < arr.length; i++) {
const m = arr[i];
if (!m || typeof m !== 'object') { n += 32; continue; }
const t = m.text; if (typeof t === 'string') n += t.length;
const im = m.img; if (typeof im === 'string') n += im.length;
const vc = m.voice; if (typeof vc === 'string') n += vc.length;
const ps = m.parts;
if (Array.isArray(ps)) { for (let j = 0; j < ps.length; j++) { const p = ps[j]; if (p && typeof p.v === 'string') n += p.v.length; } }
n += 64;
}
return n;
}
// v3.26.x OOM 核心：聊天记录 IDB 直存数组（structured clone，读写都免整包 JSON 串化/解析）。
// 旧实现单键可达数百 MB（图片 base64 内联）时：读库 JSON.parse 数百 MB（秒级阻塞+堆尖峰）、
// 每次落盘 JSON.stringify 再数百 MB（OPPO Reno10Pro+ 自带浏览器实测 JS 堆被推到 905/1078MB，
// 渲染进程被杀、页面自动重启）。小历史（估算 ≤CHAT_STR_THRESHOLD）沿用字符串路径，与旧数据
// 完全一致（loadMsgs 双形态兼容）；数组路径失败（DataCloneError/事务异常）回退字符串，绝不丢数据。
const CHAT_STR_THRESHOLD = 3 * 1024 * 1024;
function persistMsgsToIdb(key, arr) {
if (!window.idbSet) return Promise.resolve(false);
if (!arr || !arr.length || msgsBytes(arr) <= CHAT_STR_THRESHOLD) {
return window.idbSet(key, JSON.stringify(arr || []));
}
return window.idbSet(key, arr).then(ok => {
if (ok) return true;
return window.idbSet(key, JSON.stringify(arr));
});
}
// ===== FIX 2026-09-17 #127 聊天记录分片：新消息先写增量日志，基准包低频重写 =====
// 根因：#526 只把整包落盘降频，没解决「每次仍写整包」——chat-msgs 单键可达数百 MB
// （用户实测 155~214MB），发 1KB 文字也要整包 JSON/结构化克隆 + 落盘，写放大数百倍，
// 是 iOS OOM / 读写超时 / 开屏恢复慢的共同上游。
// 方案：<prefix>:chat-msgs 继续作「基准包」，新增 <prefix>:chat-arch 作「基准包之后
// 的增量日志」。平时只写小日志键；读侧（loadMsgs）把两者按序拼接，语义不变。
// 安全闸（宁可多写、绝不写错）：写日志前逐条校验基准段这一次真的没被动过（对象身份 +
// 字段指纹，删/插/改任一都破校验）；任一不满足就退回原「整包重写基准包」行为。
// 压缩：日志条数/字节超阈值时合并进基准包并清日志（把 N 次全量摊薄成约 1 次）。
const CHAT_ARCH_KEY = 'chat-arch';
const CHAT_ARCH_MAX = 400;                 // 日志条数上限，超过即压缩
const CHAT_ARCH_BYTES = 4 * 1024 * 1024;   // 日志字节估算上限，超过即压缩
// 只在「基准包本身已经很大」时才走分片：小历史整包重写本来就便宜（几百 KB 内），
// 保持旧行为可让其它直接读 <prefix>:chat-msgs 的地方（媒体池体检/诊断/回归脚本）零变化，
// 把分片的收益与风险都收在真正吃写放大的大库用户上。
const CHAT_ARCH_MIN_CKPT = 1024 * 1024;    // 基准包 ≥1MB 才启用增量日志
const CHAT_FP_TEXT = 4096;                 // 指纹里参与字符校验的文本长度上限（超长只比长度）
let chatArchPrefix = null;                 // 基准包对应的命名空间
let chatArchRef = null;                    // 基准段消息对象引用（长度=基准条数）
let chatArchFp = null;                     // 与 chatArchRef 平行的字段指纹
let chatArchBytes = 0;                     // 基准包字节估算（决定是否启用分片）
function chatArchClearBaseline() { chatArchPrefix = null; chatArchRef = null; chatArchFp = null; chatArchBytes = 0; }
// 基准段消息的「廉价指纹」：覆盖常见的原地改写字段（文本内容/媒体存在与长度/回答状态等）。
// 文本 ≤CHAT_FP_TEXT 时纳入字符滚动校验（同长度改字也咬得住）；超长文本只比长度
// （那种体量几乎必是媒体本体，不存在「同长度被编辑」的真实场景）。
function chatMsgFp(m) {
if (!m || typeof m !== 'object') return '0';
try {
const t = typeof m.text === 'string' ? m.text : '';
const im = typeof m.img === 'string' ? m.img : '';
const vc = typeof m.voice === 'string' ? m.voice : '';
let ch = 0;
if (t.length && t.length <= CHAT_FP_TEXT) { for (let i = 0; i < t.length; i++) ch = (ch * 31 + t.charCodeAt(i)) | 0; }
const ps = m.parts;
let pn = 0;
if (Array.isArray(ps)) { for (let j = 0; j < ps.length; j++) { const p = ps[j]; if (p && typeof p === 'object') pn = (pn * 31 + String(p.k || '').length + (typeof p.v === 'string' ? p.v.length : 0)) | 0; } }
return ((typeof m.ts === 'number' ? m.ts : 0) || 0) + '|' + (m.side || '') + '|' + (m.type || '') + '|' + (m.special || '') + '|' +
(m.retracted ? 1 : 0) + '|' + (m.answered ? 1 : 0) + '|' + (m.pending ? 1 : 0) + '|' +
(m.dedupExempt ? 1 : 0) + '|' + t.length + '|' + ch + '|' + im.length + '|' + vc.length + '|' +
(Array.isArray(ps) ? ps.length : 0) + '|' + pn + '|' +
(m.choiceStatus || '') + '|' + (m.curiousStatus || '') + '|' + (m.inviteStatus || '') + '|' + (m.askStatus || '');
} catch (e) { return 'x'; }
}
function chatArchSetBaseline(prefix, arr) {
try {
chatArchPrefix = prefix;
chatArchRef = Array.isArray(arr) ? arr.slice() : [];
chatArchFp = chatArchRef.map(chatMsgFp);
chatArchBytes = msgsBytes(chatArchRef);
} catch (e) { chatArchClearBaseline(); }
}
// 基准段「没被动过」判定：长度不缩、逐条对象身份一致、逐条指纹一致。
function chatArchReusable(prefix, arr) {
if (chatArchPrefix !== prefix || !Array.isArray(chatArchRef) || !Array.isArray(arr)) return false;
const base = chatArchRef.length;
if (arr.length < base) return false;
for (let i = 0; i < base; i++) {
if (arr[i] !== chatArchRef[i]) return false;
if (chatMsgFp(arr[i]) !== chatArchFp[i]) return false;
}
return true;
}
function chatArchPurge(prefix) {
try { if (window.idbDelete) window.idbDelete(prefix + ':' + CHAT_ARCH_KEY); } catch (e) {}
try { localStorage.removeItem(prefix + ':' + CHAT_ARCH_KEY); } catch (e) {}
}
// 统一聊天历史落盘入口：能复用基准段就只写增量日志，否则整包重写基准包并清日志。
// forceFull=true 强制整包（清空/导入/离页收口用，保证外部只读键方看到完整历史）。
// FIX 2026-09-18 #722 聊天冷片懒读（#127b 落地）：整包基准包超 CHAT_BLK_MIN 时改为
// 「分块直存」（<prefix>:chat-blk-<seq> 数组键 + <prefix>:chat-blk-idx 索引），读侧只读
// 末尾热片（~2MB）即可开聊天，更早的块按需取回——41MB 级桌面进聊天从整读数秒降到几百毫秒。
// 小历史（≤4MB）与旧格式读/写路径一字不变；chat-arch 增量日志语义不变（新消息仍追加日志）。
// 块格式下「基准段」= 热片/全量内存（chatArchSetBaseline 照常登记），可复用就追加日志；
// 不可复用（热片内有编辑/归一化变更）且头部冷块未并入内存时走「尾部块重写」（头块不动），
// 内存已有全量（rebase/导入）则整组重分块。详见 chatBlkWriteFull/chatBlkRewriteTail。
function persistChatHistory(prefix, arr, forceFull) {
try {
if (!window.idbSet) return;
if (!Array.isArray(arr)) arr = [];
if (chatBlkIdx) {
// —— 分块格式在位 ——
// forceFull 在分块格式下不再强制整组重写：blocks+log 本就是「外部可见的完整历史」，
// 可复用就追加日志（否则每次切桌面的 chatConsolidate 都白付一次尾部块重写）；
// 清空/导入走 chatBlkIdx 复位后的新写路径，不经过本分支。
if (arr.length && chatArchBytes >= CHAT_ARCH_MIN_CKPT && chatArchReusable(prefix, arr)) {
const base = chatArchRef.length;
if (arr.length === base) { chatArchPurge(prefix); return; } // 与基准包全等，无增量
const log = arr.slice(base);
if (log.length <= CHAT_ARCH_MAX && msgsBytes(log) <= CHAT_ARCH_BYTES) {
persistMsgsToIdb(prefix + ':' + CHAT_ARCH_KEY, log);
return;
}
}
if (!chatRebased) {
chatBlkRewriteTail(prefix, arr); // 热片对齐尾部块重写（头部冷块不在内存也不需要；未 rebase 时内存绝不是全量，绝不能走整组重写=丢头部）
return;
}
chatBlkWriteFull(prefix, arr); // 内存全量（rebase 后/导入）：整组重分块
return;
}
if (!forceFull && arr.length && chatArchBytes >= CHAT_ARCH_MIN_CKPT && chatArchReusable(prefix, arr)) {
const base = chatArchRef.length;
if (arr.length === base) { chatArchPurge(prefix); return; } // 与基准包全等，无增量
const log = arr.slice(base);
if (log.length <= CHAT_ARCH_MAX && msgsBytes(log) <= CHAT_ARCH_BYTES) {
persistMsgsToIdb(prefix + ':' + CHAT_ARCH_KEY, log);
return;
}
}
if (msgsBytes(arr) > CHAT_BLK_MIN) { chatBlkWriteFull(prefix, arr); return; } // #722 大历史直接分块，不再写整包
persistMsgsToIdb(prefix + ':chat-msgs', arr);
chatArchPurge(prefix);
chatArchSetBaseline(prefix, arr);
} catch (e) {}
}
// ===== #722 聊天冷片懒读：分块存储核心 =====
// 存储形态（大历史才启用，阈值 CHAT_BLK_MIN=4MB）：
//   <prefix>:chat-blk-<seq>  数组直存的「块」（每块 ≤CHAT_BLK_BYTES 浅估）
//   <prefix>:chat-blk-idx    索引 {v:1, blocks:[{k,bytes,n}...], total, nextSeq}
//   <prefix>:chat-msgs       旧整包键（分块后删除；旧格式读路径保持兼容）
// 读侧：loadMsgs 先读 blk-idx，在位则只读「末尾热块」（≈2MB）+ chat-arch 日志回放＝开聊天；
//   更早的块由 chatColdEnsureHydrated 后台逐块取回（chatColdHead 暂存），getChatMsgs 用
//   head.concat(msgs) 永远返回完整历史（统计/导出/补投递等消费方零改动）。
// 上滑到热片顶部时 chatRebaseCold 一次性把头并入 msgs 并位移窗口/草稿下标（此后内存全量）。
const CHAT_BLK_MIN = 4 * 1024 * 1024;
const CHAT_BLK_BYTES = 2 * 1024 * 1024;
const CHAT_BLK_HOT_N = 300;      // 热片至少覆盖的条数（不足再往前多取一块）
const CHAT_BLK_HOT_MAX = 2;      // 热片最多取的块数
let chatBlkIdx = null;           // 在位标记（null=旧整包格式）
let chatBlkTotal = 0;            // 全量条数（账本口径用，热片读时内存只有尾部）
let chatBlkWriting = false;      // 分块写单飞闸（并发请求合并，收尾取最新）
let chatBlkPending = null;       // 写期间到达的最新全量（收尾后补写）
let chatHotFrom = 0;             // 热片覆盖的块下标起点（尾部重写时保留其前的头块）
let chatColdHead = [];           // 已取回未并入 msgs 的头部消息（时间正序）
let chatColdFrom = 0;            // 尚未取回的头块下标
let chatColdDone = true;         // 头块是否已全部取回
let chatColdHydrating = false;
let chatRebased = false;         // 冷头是否已并入 msgs（此后内存=全量）
let chatHotBaseN = 0;            // 热片装载时的条数（#722 分块格式下账本守卫的比对基准）
// ===== #954 热片会话缓存：「第二次进同一桌面零 IDB 等待」 =====
// blk-idx 与末尾热块（≤2 块×2MB 浅估）读一次后驻留本表；loadMsgs 读热片前先查这里，命中＝
// 不发起 idbGet 事务（切桌面回来/退出重进聊天从「真读一遍 2MB×N」变成内存直取）。一致性四路：
// 写入侧（chatBlkWriteFull/chatBlkRewriteTail）每写成功一块/一份索引就同步更新表项＝会话内
// 永不吃旧值；chatBlkPurgePrefix（清空/导入）整前缀作废；mochi-restore-done（备份恢复整库
// 重写）全表作废；forceIdb（读库重试/强读）绕过缓存直读 IDB＝异常链路永不拿缓存当权威。
// 表项带 10 分钟时效与 12 项上限（一个桌面=索引+2 热块+尾部重写新增 ~5 项），超限逐出最旧。
const chatHotCache = {};
const CHAT_HOT_CACHE_TTL = 10 * 60 * 1000;
const CHAT_HOT_CACHE_MAX = 12;
function chatHotCacheGet(k) {
const e = chatHotCache[k];
if (!e || (Date.now() - e.at) > CHAT_HOT_CACHE_TTL) return undefined;
return e.v;
}
function chatHotCacheSet(k, v) {
try {
chatHotCache[k] = { v: v, at: Date.now() };
const ks = Object.keys(chatHotCache);
if (ks.length > CHAT_HOT_CACHE_MAX) {
ks.sort(function (a, b) { return chatHotCache[a].at - chatHotCache[b].at; });
for (let i = 0; i < ks.length - CHAT_HOT_CACHE_MAX; i++) delete chatHotCache[ks[i]];
}
} catch (e) {}
}
function chatHotCacheDropPrefix(prefix) {
try { Object.keys(chatHotCache).forEach(function (k) { if (k.indexOf(prefix + ':chat-blk-') === 0) delete chatHotCache[k]; }); } catch (e) {}
}
function chatHotCacheDropAll() {
try { Object.keys(chatHotCache).forEach(function (k) { delete chatHotCache[k]; }); } catch (e) {}
}
// 重分块/尾部重写会产生新 seq 块键：旧死块的缓存项若不随手清掉，既白占额度还会把活热块
// 从 LRU 里挤出去（切换回来又得真读＝缓存白做）。写成功收尾按新 live 集合同步一次。
function chatHotCacheSyncLive(prefix, blocks) {
try {
const live = {}; (blocks || []).forEach(function (b) { live[b.k] = 1; });
Object.keys(chatHotCache).forEach(function (k) {
if (k.indexOf(prefix + ':chat-blk-') !== 0 || k === prefix + ':chat-blk-idx') return;
if (!live[k.slice(prefix.length + 1)]) delete chatHotCache[k]; // #954：死块缓存随写清除
});
} catch (e) {}
}
function chatBlkResetState() {
chatBlkIdx = null; chatBlkTotal = 0; chatHotFrom = 0; chatHotBaseN = 0;
chatColdHead = []; chatColdFrom = 0; chatColdDone = true; chatColdHydrating = false; chatRebased = false;
}
// 浅估分块：块内条数不定，按 msgsBytes 同口径的字节浅估切（每块 ≤CHAT_BLK_BYTES）
function chatBlkSplit(arr) {
const out = [];
let cur = [], bytes = 0;
for (let i = 0; i < arr.length; i++) {
const m = arr[i];
cur.push(m);
bytes += 96 + (m && typeof m.text === 'string' ? m.text.length : 0) + (m && typeof m.img === 'string' ? m.img.length : 0);
if (bytes >= CHAT_BLK_BYTES) { out.push(cur); cur = []; bytes = 0; }
}
if (cur.length) out.push(cur);
return out;
}
// 全量重分块：arr 必须是完整历史（rebase 后内存 / 导入）。单飞：写期间的新请求记 pending 收尾补写。
function chatBlkWriteFull(prefix, arr) {
if (chatBlkWriting) { chatBlkPending = arr.slice(); return; }
chatBlkWriting = true;
const old = chatBlkIdx;
const seq = (old && old.nextSeq) || 0;
const chunks = chatBlkSplit(arr);
const blocks = [];
let p = Promise.resolve();
let s = seq;
chunks.forEach(function (c) {
const k = 'chat-blk-' + (s++);
const a = c;
p = p.then(function () { return persistMsgsToIdb(prefix + ':' + k, a); }).then(function () {
chatHotCacheSet(prefix + ':' + k, a); // #954w 块写成功即更新缓存＝下次读永远拿到刚写的
blocks.push({ k: k, bytes: msgsBytes(a), n: a.length });
});
});
p = p.then(function () {
const idx = { v: 1, blocks: blocks, total: arr.length, nextSeq: s };
const idxStrW = JSON.stringify(idx); // #954
return window.idbSet(prefix + ':chat-blk-idx', idxStrW).then(function (ok) {
if (ok === false) throw new Error('idx-write-fail');
chatHotCacheSet(prefix + ':chat-blk-idx', idxStrW); // #954w
chatHotCacheSyncLive(prefix, blocks); // #954w 死块缓存随写清除
chatBlkIdx = idx; chatBlkTotal = arr.length;
chatHotFrom = Math.max(0, blocks.length - 1);
chatColdHead = []; chatColdFrom = 0; chatColdDone = true; chatRebased = false;
chatArchPurge(prefix);
chatArchSetBaseline(prefix, arr);
try { if (window.idbDelete) window.idbDelete(prefix + ':chat-msgs'); } catch (e) {}
try { localStorage.removeItem(prefix + ':chat-msgs'); } catch (e) {}
// 清掉旧格式的孤儿块键（idx 里不再引用的 chat-blk-*）
try {
const live = {}; blocks.forEach(function (b) { live[b.k] = 1; });
if (old && Array.isArray(old.blocks)) old.blocks.forEach(function (b) { if (!live[b.k] && window.idbDelete) window.idbDelete(prefix + ':' + b.k); });
} catch (e) {}
});
}).catch(function () { scheduleIdbRetry(); }).then(function () {
chatBlkWriting = false;
if (chatBlkPending) { const a = chatBlkPending; chatBlkPending = null; chatBlkWriteFull(prefix, a); }
});
}
// 尾部块重写：不可追加（热片内有编辑/归一化变更）且头部冷块不在内存时——热片本来就是
// 整块对齐取的，直接用内存里的热片（±新增尾部）重写它覆盖的那几个块，头块一个字节不动。
function chatBlkRewriteTail(prefix, arr) {
if (chatBlkWriting) { chatBlkPending = arr.slice(); return; }
chatBlkWriting = true;
const idx = chatBlkIdx;
const head = (idx.blocks || []).slice(0, chatHotFrom);
// 尾部段＝内存热片本身（热片本就按整块对齐取，arr[0] 恰是尾部块首条；绝不 slice——
// headN 是全量口径条数、与本地内存下标无关，切了就是把 41MB 桌面写成空尾＝灾难性丢历史）
const tailArr = arr;
const seq = idx.nextSeq || 0;
const chunks = chatBlkSplit(tailArr);
const blocks = head.slice();
let p = Promise.resolve();
let s = seq;
const newKeys = [];
chunks.forEach(function (c) {
const k = 'chat-blk-' + (s++);
const a = c;
newKeys.push(k);
p = p.then(function () { return persistMsgsToIdb(prefix + ':' + k, a); }).then(function () {
chatHotCacheSet(prefix + ':' + k, a); // #954t 尾块写成功即更新缓存
blocks.push({ k: k, bytes: msgsBytes(a), n: a.length });
});
});
p = p.then(function () {
// #1360：total 是「这一桌全量条数」的账，不是「内存里这一段」——头部冷块一个字节都没动，
// 却原来被写成 arr.length（只有热片），于是每重写一次尾块，索引就宣称自己短了一截。
// 下游三把尺子全部跟着塌：① chatBlkHotLoad 的 headN=total-热片 ⇒ 归零即 chatColdDone=true，
// 头部从此不再被取回（实测 900 条一场之内报成 306，另一次打开后只剩 303 条）＝用户口径的
// 「聊天记录一天比一天少、莫名其妙被吞」；② chat-meta 账本按 total 落盘＝缩水守卫的尺子
// 自己变短，之后真丢数据也判不出来；③ 只读账本/索引的统计、导出、诊断跟着少报。
const headCnt = (function (hs) { let t = 0; for (let i = 0; i < hs.length; i++) t += (hs[i] && hs[i].n) || 0; return t; })(head);
const idx2 = { v: 1, blocks: blocks, total: headCnt + arr.length, nextSeq: s };
const idxStrT = JSON.stringify(idx2); // #954
return window.idbSet(prefix + ':chat-blk-idx', idxStrT).then(function (ok) {
if (ok === false) throw new Error('idx-write-fail');
chatHotCacheSet(prefix + ':chat-blk-idx', idxStrT); // #954t
chatHotCacheSyncLive(prefix, blocks); // #954t 死块缓存随写清除
chatBlkIdx = idx2; chatBlkTotal = headCnt + arr.length;
// 重写后块边界变了：热片重新对齐到末尾整块
chatHotFrom = head.length;
const live = {}; blocks.forEach(function (b) { live[b.k] = 1; });
(idx.blocks || []).forEach(function (b) { if (!live[b.k] && window.idbDelete) window.idbDelete(prefix + ':' + b.k); });
chatArchPurge(prefix);
chatArchSetBaseline(prefix, arr);
});
}).catch(function () { scheduleIdbRetry(); }).then(function () {
chatBlkWriting = false;
if (chatBlkPending) { const a = chatBlkPending; chatBlkPending = null; chatBlkRewriteTail(prefix, a); }
});
}
// 清掉某前缀下的全部分块键与索引（clearChatHistory / 导入 用）。**必须按前缀扫盘**：
// 会话没打开过该桌面时 chatBlkIdx 为 null，只看内存索引会漏删磁盘块 → 清空后下次启动
// blk-idx 回放把已清历史复活、导入后旧索引遮蔽新记录。两路都做（内存索引已知时立即删，
// 再扫盘兜底），删除请求先于新格式写入下发（同一连接事务按调用顺序排队）。
function chatBlkPurgePrefix(prefix) {
try {
chatHotCacheDropPrefix(prefix); // #954：清空/导入＝热片缓存整前缀作废
if (chatBlkIdx && Array.isArray(chatBlkIdx.blocks) && window.idbDelete) {
chatBlkIdx.blocks.forEach(function (b) { try { window.idbDelete(prefix + ':' + b.k); } catch (e) {} });
}
if (window.idbDelete) { try { window.idbDelete(prefix + ':chat-blk-idx'); } catch (e) {} }
if (window.idbListKeys && window.idbDelete) {
window.idbListKeys().then(function (keys) {
(keys || []).forEach(function (k) {
if (typeof k === 'string' && k.indexOf(prefix + ':chat-blk-') === 0) { try { window.idbDelete(k); } catch (e) {} }
});
}).catch(function () {});
}
} catch (e) {}
}
// 读侧热片装载：读末尾热块 → 交给权威读链的既有合并/守卫/渲染体（v=热片数组，语义=「读到的权威」）
function chatBlkHotLoad(prefix, idxRaw, noCache) {
const idx = JSON.parse(idxRaw);
if (!idx || !Array.isArray(idx.blocks) || !idx.blocks.length) return Promise.resolve(null);
chatBlkIdx = idx; chatBlkTotal = idx.total || 0;
const hotKeys = [];
let hotN = 0;
for (let b = idx.blocks.length - 1; b >= 0 && hotN < CHAT_BLK_HOT_N && hotKeys.length < CHAT_BLK_HOT_MAX; b--) {
hotKeys.unshift(idx.blocks[b].k); hotN += idx.blocks[b].n || 0;
}
chatHotFrom = idx.blocks.length - hotKeys.length;
chatHotBaseN = hotN; // #722：账本守卫基准=热片条数（内存此后=热片+新增）
const headN = Math.max(0, (idx.total || hotN) - hotN);
chatColdHead = []; chatColdFrom = 0; chatColdDone = headN === 0; chatColdHydrating = false; chatRebased = false;
// #722：热块读取沿用 #716 口径——按块字节放大读等待窗（2MB 块在 4× 节流的手机上
// 结构化克隆就可能超默认 4s ⇒ undefined＝读失败重试循环），且逐块串行读（并行会叠加峰值）。
// 末块（最新那段）必须读成——它决定聊天页能不能开；更早的热块尽力而为，读失败不清空
// 整体结果（那块落在热片之前的序号里，由后台水合/rebase 按序补上，绝不丢消息）。
let p = Promise.resolve();
const parts = [];
hotKeys.forEach(function (k, ki) {
const bytes = (chatBlkIdx && chatBlkIdx.blocks[chatHotFrom + ki] && chatBlkIdx.blocks[chatHotFrom + ki].bytes) || 1048576;
const hint = { minWaitMs: 4000 + Math.min(28000, Math.ceil((bytes || 1048576) / 1048576) * 2000) };
p = p.then(function () {
const fk = prefix + ':' + k;
if (!noCache) { const cv = chatHotCacheGet(fk); if (cv !== undefined) return cv; } // #954：热块缓存命中＝零 IDB 等待
return window.idbGet(fk, hint).then(function (v) { if (v !== undefined && v !== null) chatHotCacheSet(fk, v); return v; }); // #954：真读成功回填缓存（块值数组/字符串双形态都驻留，读侧本就双形态兼容）
}).then(function (v) { parts.push(v); });
});
return p.then(function () {
if (window.activePrefix() !== prefix) return null;
let hot = [], miss = false;
for (let pi = 0; pi < parts.length; pi++) {
let a = parts[pi];
// #722：块值双形态兼容（persistMsgsToIdb 对小尾块存 JSON 字符串、大块存数组直存）——与旧读路径同口径
if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = null; } }
const isLast = (pi === parts.length - 1);
if (!Array.isArray(a)) {
// 末块（最新那段）必须读成——它决定聊天页能不能开，失败＝本次读失败去重试，绝不置 ready；
// 更早的热块尽力而为：读失败只跳过该块（它在热片之前，由后台水合/rebase 按序补上，绝不丢消息）
if (isLast) { miss = true; return; }
continue;
}
hot = hot.concat(a);
}
if (miss || !hot.length) return null; // 块读失败 → 回到旧读路径语义（=读失败重试，绝不置 ready）
return hot;
}).catch(function () { return null; });
}
// 头部冷块后台逐块取回（读侧开聊天后空闲推进；loadOlderIncremental 顶部边界也会触发）
function chatColdEnsureHydrated() {
if (chatColdDone || chatColdHydrating || !chatBlkIdx || chatRebased || !window.idbGet) return;
chatColdHydrating = true;
const myPrefix = window.activePrefix();
const step = function () {
if (window.activePrefix() !== myPrefix || !chatBlkIdx || chatRebased) { chatColdHydrating = false; return; }
if (chatColdFrom >= chatHotFrom) { chatColdDone = true; chatColdHydrating = false; return; }
const blk = chatBlkIdx.blocks[chatColdFrom];
window.idbGet(myPrefix + ':' + blk.k).then(function (v) {
if (window.activePrefix() !== myPrefix) { chatColdHydrating = false; return; }
if (!Array.isArray(v)) { chatColdHydrating = false; return; } // #722 读失败：下标不前移，留待下次触发重试同块
chatColdHead = v.concat(chatColdHead); // 头块按时间正序前插
chatColdFrom++;
setTimeout(step, 30);
}).catch(function () { chatColdHydrating = false; });
};
step();
}
// 上滑到热片顶部：头部冷块一次性并入 msgs，并位移所有「窗口/草稿/归一化」下标状态与 DOM
// data-idx（真实下标此后=本地下标，内存自此为全量；基准段 refs 同步升级为全量）。
function chatRebaseCold() {
const n = chatColdHead.length;
if (!n || chatRebased) return;
msgs = chatColdHead.concat(msgs);
chatColdHead = [];
chatRebased = true;
renderStart += n; renderEnd += n;
if (windowRenderedN) windowRenderedN += n;
if (Array.isArray(windowRenderedLite)) windowRenderedLite = windowRenderedLite.map(function (i2) { return i2 + n; });
try {
if (sessionChangedIdx && sessionChangedIdx.size) {
const s2 = Array.from(sessionChangedIdx).map(function (i2) { return i2 + n; });
sessionChangedIdx.clear(); s2.forEach(function (i2) { sessionChangedIdx.add(i2); });
}
} catch (e) {}
try { if (Array.isArray(normChangedIdxs)) normChangedIdxs = normChangedIdxs.map(function (i2) { return i2 + n; }); } catch (e) {}
try { if (typeof normOrigIdx === 'number' && normOrigIdx >= 0) normOrigIdx += n; } catch (e) {}
try {
Object.keys(inplaceDrafts).forEach(function (k) {
const v = inplaceDrafts[k]; delete inplaceDrafts[k]; inplaceDrafts[String(Number(k) + n)] = v;
});
} catch (e) {}
try { if (typeof inplaceFocusIdx === 'number' && inplaceFocusIdx >= 0) inplaceFocusIdx += n; } catch (e) {}
try { body.querySelectorAll('[data-idx]').forEach(function (el) { el.dataset.idx = String(Number(el.dataset.idx) + n); }); } catch (e) {}
try { chatArchSetBaseline(window.activePrefix(), msgs); } catch (e) {} // 基准 refs 升级为全量：此后编辑任何消息都能被指纹检出
try { syncLastMineText(); } catch (e) {} // #722 自查：lastMineIdx 是 msgs 下标，并入冷头后整体位移——直接重算（引用「我最后一条」的回复不会指错位）
}
// 把基准段+日志收口成整包（切桌面/离页/导出前调用；外部模块只读 chat-msgs 时也看得到全量）
function chatConsolidate(prefix) {
try {
if (!prefix || !window.idbSet) return;
if (chatArchPrefix !== prefix || !Array.isArray(chatArchRef)) return;
if (!Array.isArray(msgs) || !msgs.length) return;
if (!chatArchReusable(prefix, msgs)) return;
if (msgs.length <= chatArchRef.length) return;
if (!chatLedgerGuard(prefix, msgs)) return;
persistChatHistory(prefix, msgs, true);
} catch (e) {}
}
// v3.26.x #90：聊天记录「条数账本」+ 缩水守卫（本会话跨桌面/读库异常路径的最后止损）。
// #88 的 authOk 闸门只挡「本会话没读到权威值」；账本再挡一种：读到了、但内存里的数组
// 明显不是库里那一份（切错桌面残留、快照污染、并发覆盖）。账本 = 本命名空间最近一次
// 权威条数，存 <prefix>:chat-meta（几百字节小键，idb.js 已把它排除出写日志，
// 不会被 LS 回滚补回过期值）。整包落盘前同步比对：新条数不足账本一半且账本 ≥300 条
// → 判定可疑缩水，IDB 与 LS 快照一律不写（LS 废机上覆盖就是永久丢），弹窗告知一次
// 并补挂 scheduleIdbRetry()：权威读回后 loadMsgs 会把内存里的新消息合并进完整历史再存。
// 守卫判定全同步（比对内存数字，零额外开销），只在可疑路径才弹窗。
const CHAT_LEDGER_MIN = 300;
const CHAT_LEDGER_STEP = 50;   // IDB 账本按步进落盘：只需量级正确，免每次存盘多发事务
const chatLedger = {};         // prefix -> 已知权威条数
let chatLedgerWarned = {};
const chatLedgerRetryAt = {};  // prefix -> 上次强制重读时间（限流，防重读风暴）
const chatLedgerBytes = {};    // prefix -> 已落盘的字节估算（FIX 2026-09-01 #120，防重复写）
// FIX 2026-09-01 #120：账本额外记 b（msgsBytes 估算，近似值即可，不用精确），供冷启动
// 「大历史懒读」门控（chatPrefetchIfLight）廉价判断当前桌面聊天包是否巨大——重启后不必
// 读 155MB 大键才知道它大。b 缺失按「未知」，门控会保守选择行为（见 chatPrefetchIfLight，不破坏旧逻辑）。
function chatLedgerSave(prefix, n, bytes) {
const prev = chatLedger[prefix];
chatLedger[prefix] = n;
const bChanged = typeof bytes === 'number' && bytes >= 0 && chatLedgerBytes[prefix] !== bytes;
if (prev === n && !bChanged) return;
if (!bChanged && typeof prev === 'number' && n > prev && n - prev < CHAT_LEDGER_STEP) return;
const obj = { n: n, t: Date.now() };
if (typeof bytes === 'number' && bytes >= 0) obj.b = bytes;
try { window.idbSet(prefix + ':chat-meta', JSON.stringify(obj)); } catch (e) {}
if (typeof bytes === 'number' && bytes >= 0) chatLedgerBytes[prefix] = bytes;
}
// 小键补读（chat-msgs 大键读失败时，恰恰只有它能回答「库里到底有多少条」）：
// 已知有值就不重复读，异步回来也不覆盖本会话更新过的内存值。
function chatLedgerLoad(prefix) {
if (!window.idbGet || chatLedger[prefix] !== undefined) return;
try {
window.idbGet(prefix + ':chat-meta').then(function (v) {
try {
if (v === undefined || v === null || chatLedger[prefix] !== undefined) return;
const o = typeof v === 'string' ? JSON.parse(v) : v;
if (o && typeof o.n === 'number' && o.n > 0) chatLedger[prefix] = o.n;
if (o && typeof o.b === 'number' && o.b >= 0) chatLedgerBytes[prefix] = o.b; // #716：字节账本一并回填，大键读等待窗要用
} catch (e) {}
}).catch(function () {});
} catch (e) {}
}
// FIX 2026-09-01 #120：低端安卓真机（OPPO findx9 等）开网站/进聊天崩溃——default 桌面
// 聊天大包（图片 base64 内联，实测 155MB/1656条≈94KB每条）在冷启动和切桌面时被两处预读
// （mochi-restore-done 的 loadMsgs(true)、启动 loadMsgs、contact-switched 预读）一次性
// idbGet 反序列化超大值，与启动回填叠加成堆尖峰，渲染进程被杀。这里用账本 b 判断「历史很大」
// 的桌面：冷启动跳过预读，改为进入聊天页才读（enterChat 内部会调 loadMsgs）；小历史保留
// 原预读加速（不影响大众体验）。零数据风险：读库本就异步，且 saveMsgs 的 authOk 闸门保证
// 未读到权威前新消息只进 pendingLocal、绝不整包覆盖历史。
const CHAT_LAZY_BYTES = 8 * 1024 * 1024; // 历史字节估算门槛：超此即视为大包，冷启动懒读
function chatPrefetchIfLight(load) {
  let prefix;
  try { prefix = window.activePrefix(); } catch (e) { prefix = ''; }
  if (!window.idbGet) { try { load(); } catch (e2) {} return; }
  window.idbGet(prefix + ':chat-meta').then(function (v) {
    // FIX 2026-09-01 #120：冷启动预读门控——
    //   · 账本「完全缺失」（全新/空账号：无 #90 账本=从未落盘，实为无数据）→ 照常预读；
    //   · 账本存在且 b 已知 ≤ 门槛（小历史）→ 照常预读；
    //   · 账本存在但 b 缺失或超门槛（旧格式超大历史 / 本次未写 b）→ 跳过冷启动预读，
    //     进入聊天页才读（enterChat 会 loadMsgs）。理由：老用户超大历史在账本里一定
    //     有 n（每次落盘都写），只是缺新字段 b；唯一能防低端机首启崩的就是此时不预读，
    //     首启跑过我行 loadMsgs 落盘会补写 b，之后冷启动按 b 精确判断。
    //   · 读账本失败（catch）→ 也不预读（防低端机在高峰期抢读大包）。
    let knownSmall = false;
    let noLedger = v === undefined || v === null;
    try {
      if (!noLedger) {
        const o = typeof v === 'string' ? JSON.parse(v) : v;
        if (o && typeof o.b === 'number' && o.b >= 0 && o.b <= CHAT_LAZY_BYTES) knownSmall = true;
      }
    } catch (e2) {}
    if (knownSmall || noLedger) { try { load(); } catch (e2) {} return; }
    try { window.__xyChatLazyLoad = true; } catch (e2) {} // 大包/未知大小 → 冷启动跳过预读
  }).catch(function () { /* 读账本失败：也不预读（防低端机在高峰期抢读大包） */ });
}
// 返回 true=允许整包落盘（账本已更新）；false=可疑缩水，已拒绝落盘
function chatLedgerGuard(prefix, arr) {
const n = Array.isArray(arr) ? arr.length : 0;
let base = chatLedger[prefix];
// #722 分块格式：内存只有热片（尾部），全量条数账本（idx.total）对不上——守卫基准改用
// 「热片装载时的条数」（头部在不可变块里物理上不会缩水；可缩水的只有尾部，仍被守卫覆盖）。
// 头部整块丢失由 blk-idx/块键读失败路径兜底（读失败绝不置 ready），不走本守卫。
if (chatBlkIdx && typeof chatHotBaseN === 'number' && chatHotBaseN > 0) base = chatHotBaseN;
if (typeof base === 'number' && base >= CHAT_LEDGER_MIN && n * 2 < base) {
if (!chatLedgerWarned[prefix]) {
chatLedgerWarned[prefix] = 1;
try {
if (window.openModal) window.openModal('聊天记录保护', '', function () {}, {
noInput: true, okText: '知道了',
staticText: '检测到本次要保存的记录比已存的历史少了很多（' + base + ' 条 → ' + n + ' 条），' +
'已暂缓保存以防历史被覆盖。请留意稍后重进聊天页确认记录是否完整。'
});
} catch (e) {}
try { scheduleIdbRetry(); } catch (e) {}
}
// v3.26.x #90：拒绝落盘不是终点——① 暂存内存数组，权威读回后 loadMsgs 会把其中的新
// 消息合并进完整历史（切桌面时也不会随内存一起丢）；② 强制重读：scheduleIdbRetry 走的
// 普通 loadMsgs 会被 IDB_RELOAD_MIN_GAP 时间闸跳过（此刻刚读过），只有 forceIdb 才真重读。
// 按命名空间 20 秒限流，防极端情况下反复重读整包大历史。
try { if (Array.isArray(arr) && arr.length && (!pendingLocal || pendingLocal.length < arr.length)) pendingLocal = arr.slice(); } catch (e) {}
try {
const nowR = Date.now();
if (nowR - (chatLedgerRetryAt[prefix] || 0) > 20000) {
chatLedgerRetryAt[prefix] = nowR;
setTimeout(function () {
try { if (window.activePrefix() === prefix) loadMsgs(true); } catch (e) {}
}, 1500);
}
} catch (e) {}
return false;
}
// #1360：账本记的是「库里有多少条」，分块格式下库里＝没动过的头块＋内存这一段。原来直接记
// arr.length（只有内存这一段）＝和 ① 同一个错误换了个地方：索引的全量账修好了，账本这侧照旧
// 被写成热片条数，#90 缩水守卫的尺子照样变短（实测 900 条的桌被记成 304）。
const ledgerN = (chatBlkIdx && typeof chatBlkTotal === 'number' && chatBlkTotal > n) ? chatBlkTotal : n;
chatLedgerSave(prefix, ledgerN, msgsBytes(arr));
return true;
}
// 精简快照：大历史时剥掉 img/voice/long-text 及 parts 里的图片/语音负载（保留占位与 _lsLite
// 标记，合并逻辑按原语义识别），使 localStorage 兜底快照始终 ≤2MB、且构建过程不再整包串化。
function liteSnapArray(arr) {
if (msgsBytes(arr) <= LS_SNAP_LIMIT) return arr; // 小历史：全量快照
return arr.map(m => {
if (!m || typeof m !== 'object') return m;
const hasBig = m.img || m.voice || (typeof m.text === 'string' && m.text.length > 8192) ||
(Array.isArray(m.parts) && m.parts.some(p => p && typeof p.v === 'string' && p.v.length > 512));
if (!hasBig) return m;
const c = Object.assign({}, m);
c._lsLite = 1;
if (c.img) c.img = '';
if (c.voice) c.voice = '';
if (typeof c.text === 'string' && c.text.length > 8192) c.text = '[内容已省略]';
if (Array.isArray(c.parts)) {
c.parts = c.parts.map(p => {
if (!p || typeof p !== 'object' || typeof p.v !== 'string') return p;
if (p.k === 'img' || p.k === 'voice' || p.v.length > 8192) {
const pc = Object.assign({}, p);
if (p.k === 'img' || p.k === 'voice') pc.v = '';
else pc.v = '[内容已省略]';
return pc;
}
return p;
});
}
return c;
});
}
function performLsSnapWrite(arr, prefix) {
try {
if (!Array.isArray(arr)) return;
let snapArr = liteSnapArray(arr);
let snap = JSON.stringify(snapArr);
// #180：超限不再整体放弃——原实现静默不写＝LS 兜底全空，权威读取失败窗口里聊的
// 消息没有任何副本。改为从最旧开始折半丢弃（最多 5 轮），保住最近的尾巴落 LS。
let round = 0;
while (snap.length > LS_SNAP_LIMIT && snapArr.length > 1 && round < 5) {
round++;
const keep = Math.max(1, Math.floor(snapArr.length / 2));
snapArr = liteSnapArray(arr.slice(arr.length - keep));
snap = JSON.stringify(snapArr);
}
if (snap.length <= LS_SNAP_LIMIT) {
localStorage.setItem((prefix || window.activePrefix()) + ':chat-msgs', snap);
}
} catch (e) {}
}
// FIX 2026-09-07 #245：预权威期的 LS 快照保存改「与既有快照去重合并」——旧实现整包覆盖，
// 启动期（签到/TA 主动消息）的保存会把 LS 里仅存的历史快照顶掉=打开聊天首渲缺历史、
// 权威回读后前缀凭据失配=同一消息屏上两份+整窗重画（真机「闪屏+弹一下后恢复」，无头
// 实证 rm7+add7+种子消息×2）。按 ts|side|text 排序去重合并，上限仍由 performLsSnapWrite
// 的 lite 折半兜底。
// FIX 2026-09-15 #511：签名统一走 lsMergeSig（与 dupSig 同口径、展开媒体令牌）——旧的内联
// ts|side|前64字符签名在「LS 存原文 base64 / 内存已令牌化」时判不出同一条，LS 快照里会长期存两份。
function mergeLsSnapshotWith(msgsNow, prefix) {
try {
let raw = '';
try { raw = store.get('chat-msgs') || ''; } catch (e) { raw = ''; }
// FIX 2026-09-20 #943a：超限遗留快照不再整包 parse+merge——快照写入器自己的上限就是
// LS_SNAP_LIMIT（超限只可能来自旧版本残留，实例 2.7MB），每次发消息/退后台把 2.7MB
// JSON.parse＋全量去重合并再重串化压在主线程热路径上（iOS 实测为百 ms 级冻结，
// perfcheck 前台冻结 45 次的主要来源）。直接用 msgsNow 的新 lite 快照覆盖该键：
// 权威数据在 IndexedDB，LS 只是兜底副本，无语义损失。
if (raw.length > LS_SNAP_LIMIT) { performLsSnapWrite(msgsNow, prefix); return; }
let old = [];
try { old = JSON.parse(raw || '[]'); } catch (e) { old = []; }
if (!Array.isArray(old)) old = [];
const seen = new Set(msgsNow.map(lsMergeSig));
// FIX 2026-09-16 #594：再补一层「媒体两种存法」互补判定（媒体池冷载时 lsMergeSig 展开不出
// 原文）——否则写侧照样把同一条的旧形态副本存进 LS，下次进页读侧再翻倍（#511 同款半修）
const kinds = recKindIndex(msgsNow);
// FIX 2026-09-18 #776：写侧与读侧同口径——正文被换脸/令牌化后 lsMergeSig 与 recKindCovers 都对不上，
// 旧形态副本会长期留在快照里，下次进页被读侧当成新消息补回来（一份变两份、刷新还在）。
const copied = new Set();
msgsNow.forEach(x => chatRecKeysAdd(copied, x));
const merged = msgsNow.concat(old.filter(m => {
if (!m || seen.has(lsMergeSig(m)) || recKindCovers(kinds, m)) return false;
return !chatRecKeysHit(copied, m);
})).sort((a, b) => (((a && a.ts) || 0) - ((b && b.ts) || 0)));
performLsSnapWrite(merged, prefix);
} catch (e) {}
}
function writeLsSnapshot(arr, prefix, force) {
if (!Array.isArray(arr)) return;
if (force) {
if (lsSnapTimer) { clearTimeout(lsSnapTimer); lsSnapTimer = null; }
lsSnapPending = null;
performLsSnapWrite(arr, prefix);
return;
}
if (msgsBytes(arr) <= LS_SNAP_LIMIT) { performLsSnapWrite(arr, prefix); return; }
if (lsSnapTimer) { lsSnapPending = { arr: arr, prefix: prefix }; return; }
performLsSnapWrite(arr, prefix);
lsSnapTimer = setTimeout(() => {
lsSnapTimer = null;
if (lsSnapPending) {
const p = lsSnapPending;
lsSnapPending = null;
performLsSnapWrite(p.arr, p.prefix);
}
}, 4000);
}
// ===== 2026-09-05 #180 聊天尾巴日志（同步兜底，修多机型反复「刷新重开丢最近一段聊天」）=====
// 背景：整包落盘走「空闲回调+最小2.5s间隔」低频合并（v3.26.x 止血），且 16MB 级异步 IDB
// 事务在部分安卓内核（一加/OPPO/真我/荣耀/小米 Edge 等实测族）会挂起或随进程被杀回滚、
// flushSave 的离页事务也未必来得及提交——最近几条消息在这几个窗口里没有任何第二副本。
// 防线：每条新消息同步写 LS 小键 <cid>:chat-tail（纯文本轻量副本，≤60 条，大负载不进），
// localStorage 同步写必达；下次权威读库成功后按签名去重合并回放。不与 saveMsgs 链路
// （#88 权威守卫/#90 账本守卫）耦合：权威守卫拒绝落盘的窗口里日志照样在攒，恢复时一并带回。
const CHAT_TAIL_MAX = 60;
const CHAT_TAIL_TEXT_MAX = 1000;
function chatTailSig(m) {
try { return ((m && m.ts) || 0) + '|' + (m.side || '') + '|' + String((m && m.text) || '').slice(0, 120); } catch (e) { return ''; }
}
// FIX 2026-09-18 #749：尾巴日志「是否已落盘」的**稳定身份**——ts(毫秒)+side+special。
// 不含 text（正文会被 normCell 归一化/编辑原地改写，拿它当身份＝改写后判定漂移→重复回放）。
// 与 idbTsSide / recKindCovers 的记录身份口径同源（ts 毫秒精确且同侧）。
function chatTailId(m) {
try { return ((m && m.ts) || 0) + '|' + (m.side || '') + '|' + (m.special || ''); } catch (e) { return ''; }
}
function chatTailRead() {
try {
const arr = JSON.parse(store.get('chat-tail') || '[]');
return Array.isArray(arr) ? arr : [];
} catch (e) { return []; }
}
function chatTailClear() {
try { store.remove('chat-tail'); } catch (e) {}
}
// FIX 2026-09-18 #766（用户报障：聊天里我发/TA 发的消息「莫名其妙一条变多条」，刷新还在、全部
// 类型都有、有的机型有有的没有）：**尾巴日志的寿命收口**。日志唯一职责＝兜住「整包还没落盘
// 进程就被杀掉」的最近几条（#180 立项目的）；可旧实现从头到尾**只在超 60 条时滚动丢弃、从不在
// 条目已被历史覆盖后摘除**——于是库里早已存着这些消息、日志里也永远留着一份，任何一次「内存里
// 没有但日志里有」（#722 热片只装载尾部、某个热块读失败留空洞、慢内核整包读超时退回 LS 有损
// 快照、异步链里切了联系人而日志读的是对方命名空间、导入/清空顶掉历史）都会被 chatTailMerge
// 当成「这条还没落盘」补一份进内存，随后 saveMsgs 把它**固化进库**＝刷新还在、越用越多。
// 修法＝权威读库后把「本次已确认在历史里（命中 have/haveId）」的条目从日志摘除：这类条目按定义
// 就是刚从库里读出来的，回收零风险，日志从此只保留真正待兜底的那一小段。
// **必须走 store 层**（而非直写 localStorage）：chat-tail 在 localStorage 与 IndexedDB 各有一份
// 副本（idb.js 镜像 + 启动 idbRestore 回填，实测两副本并存），绕过 store 只改 LS 会被下次启动的
// IDB 旧副本原样复活＝白改；store.set 同时更新内存缓存/LS/IDB 镜像三处。
function chatTailRetire(keep) {
try {
const arr = chatTailRead();
if (!Array.isArray(arr) || !arr.length) return;
const k = Array.isArray(keep) ? keep : [];
if (k.length === arr.length) return; // 一条都没覆盖，不写盘
try { store.set('chat-tail', JSON.stringify(k)); } catch (e) {}
} catch (e) {}
}
// 只收纯文本/轻消息：img/voice/大 parts 同步写 LS 会写爆，仍走整包落盘链路
// FIX 2026-09-05 #206 表情包「重复 + 乱码 → 空白方框」（Oppo A5 Pro/Via 等多机型）：
// 日志只收「能一字不差回放」的消息。sticker/image 型消息的 text 就是媒体数据本体
// （base64/远程链/@@m: 令牌），收录后回放必失真——type 被丢弃变文字气泡；且 #142 媒体
// 令牌化稍后会把该条 text 改写成 @@m:令牌，日志里留存的旧文本签名随之漂移，下次启动
// chatTailMerge 把它当「没落盘的新消息」回放＝同一表情包旁边多出一条乱码/坏图复制。
// parts 混合消息（回放丢图成半条）与超长文本（截断存储）同理。宁可不兜底，绝不回放坏数据。
// #337 互动卡字段随日志回放：special 为 ask-*/查岗/邀请的记录，问题/选项字段
// （askQuestion/choiceQuestion/curiousQuestion/roastText 及各自选项）不进日志的话，
// IDB 整包落盘失败后靠尾巴日志恢复出的互动卡＝「卡片在、问题空白」（choose/curious
// 渲染只读专用字段不回退 text）＋单选丢选项。这些字段都是小文本/小数组，随条收录。
const CHAT_TAIL_INTERACT_FIELDS = ['askQuestion', 'askOptions', 'askType', 'askMultiMax', 'deskCk', 'deskCkDir',
'choiceQuestion', 'choiceOptions', 'choicePref', 'choiceCat',
'curiousQuestion', 'curiousQuick', 'curiousReplies', 'curiousFollowup', 'curiousQid', 'curiousCat',
'roastText', 'roastCat', 'inviteContent', 'inviteStatus', 'inviteAnswer', 'inviteType'];
function chatTailAppend(rec) {
try {
if (!rec || rec.retracted || rec.img || rec.voice) return;
if (rec.type === 'sticker' || rec.type === 'image' || rec.type === 'voice') return;
if (Array.isArray(rec.parts) && rec.parts.length) return;
if (typeof rec.text !== 'string' || rec.text.length > CHAT_TAIL_TEXT_MAX) return;
const entry = { ts: rec.ts || Date.now(), side: rec.side || '', special: rec.special || '', text: rec.text, x: null };
for (let fi = 0; fi < CHAT_TAIL_INTERACT_FIELDS.length; fi++) {
const k = CHAT_TAIL_INTERACT_FIELDS[fi];
if (rec[k] !== undefined) { if (!entry.x) entry.x = {}; entry.x[k] = rec[k]; }
}
if (JSON.stringify(entry).length > CHAT_TAIL_TEXT_MAX * 3) return; // 超限宁可不兜底（同 #206 口径）
const arr = chatTailRead();
arr.push(entry);
while (arr.length > CHAT_TAIL_MAX) arr.shift();
store.set('chat-tail', JSON.stringify(arr));
} catch (e) {}
}
// 撤回后日志里的原文不得回放（否则刷新后已撤回内容复活）——按签名整条摘除
function chatTailDrop(rec) {
try {
if (!rec) return;
const sig = chatTailSig(rec);
const arr = chatTailRead().filter(j => chatTailSig(j) !== sig);
store.set('chat-tail', JSON.stringify(arr));
} catch (e) {}
}
// 权威读库成功后调用：日志中不在当前历史里的条目按 ts 归位合并（整包落盘仍走 saveMsgs 守卫链）
function chatTailMerge(forPrefix) {
try {
// FIX 2026-09-18 #766：命名空间一致性闸门。本函数内读日志走的是 store＝**当前激活联系人**，而调用
// 方（loadMsgs 异步链）手里的 msgs 属于**发起读取时**的 myPrefix。链里用户切了联系人＝两者不同源，
// 把对方的日志当「本会话未落盘的消息」回放进这个联系人的历史 ⇒ 凭空重复、且随后 saveMsgs 固化进库
// （刷新还在）。是否命中取决于切换时机与读库快慢——正是「同样的操作有的手机有、有的没有」的来路。
if (forPrefix && typeof window !== 'undefined' && typeof window.activePrefix === 'function' && window.activePrefix() !== forPrefix) return 0;
const arr = chatTailRead();
if (!arr.length || !Array.isArray(msgs)) return;
// FIX 2026-09-18 #749（iQOO Neo9 + Chrome 等跨机型：聊天里同一条消息重复成多条，我方与
// 联系人两侧都有；切换联系人再进就没、只退出聊天页再进又有＝每次权威读库都再回放一份）：
// 根因＝「已落盘」判定只看 chatTailSig（ts|side|正文前 120 字符）——而正文是**可被原地改写的
// 字段**：后台归一化 normCell 会把图标类正文换血（ICON_BELL→ICON_TEL、poke 的「✉️」→ICON_ENV），
// 消息编辑/词典重建正文同理。正文一改，日志里的旧签名与 msgs 对不上 ⇒ 判「这条还没落盘」
// ⇒ 回放一份 ⇒ 与原消息并存成重复；下次读库再判一次、再回放一份＝「一直重复多条」。
// 修法＝补一层**不受正文改写影响**的身份判定：ts（毫秒精度）+ side + special 已是本项目既定的
// 记录身份口径（见 idbTsSide 的 lite 残留过滤 / recKindCovers 注释），msgs 里同一身份已存在
// ⇒ 该条早就落盘了，绝不回放。文本签名（chatTailSig）**保持为原判定**只作正向补充，两套口径
// 任一命中即视为已落盘＝零误伤（合法新消息 ts 是本会话新取的毫秒值，不会与既有消息撞身份）。
const have = new Set();
const haveId = new Set();
let winFrom = Infinity;
for (let i = 0; i < msgs.length; i++) {
have.add(chatTailSig(msgs[i]));
haveId.add(chatTailId(msgs[i]));
const t0 = msgs[i] && msgs[i].ts;
if (typeof t0 === 'number' && t0 < winFrom) winFrom = t0;
}
const add = [];
const keep = []; // 本次仍须保留的日志条目（#766：命中＝已确认落盘，回收）
for (let i = 0; i < arr.length; i++) {
const j = arr[i];
if (!j) continue;
if (have.has(chatTailSig(j)) || haveId.has(chatTailId(j))) continue; // 已在这份权威历史里＝职责完成，摘除
// FIX 2026-09-18 #766：**早于本次装载窗口的条目一律不回放**。have/haveId 判的是「这条不在内存
// 里」，而 #722 之后内存 msgs 可能只是历史的热片（尾部块）——更早的消息正躺在没并进内存的头块里，
// 「不在 msgs」≠「不在库」。某块读失败留空洞、慢内核只读到尾部时，把这类条目补进内存＝凭空多
// 一份重复，还会被随后的 saveMsgs 固化进库。日志的兜底职责只覆盖「最近一段没落盘的」，比窗口
// 更早的一律宁可不兜底、绝不回放（纯时序判定，零机型分支；小历史整包装载时 winFrom=最早一条，
// 本闸门恒不生效＝常规路径行为一字不变）。
if (winFrom !== Infinity && (j.ts || 0) < winFrom) { keep.push(j); continue; }
// FIX 2026-09-05 #206 旧版日志里的存量媒体存根不得回放：data:/@@m: 开头却无 type 的条目
// 只可能是旧版截断收录的媒体数据——回放即「乱码文字气泡 → 被 normCell 归一化按 data:image/
// 前缀误迁移成 image → 截断 base64 解码失败 = 坏图空白方框」，且与原消息并存成重复。跳过，
// 该条随日志 60 条滚动自然淘汰，不再新增（chatTailAppend 已拒收媒体型消息）。
const jt = typeof j.text === 'string' ? j.text : '';
if (jt.indexOf('@@m:') === 0 || chatIsInlineDataSrc(jt)) { keep.push(j); continue; } // FIX #948 判据大小写/前导空白不敏感（变体存根回放＝乱码气泡）
keep.push(j);
// #337：互动卡条目还原问题/选项字段（旧版日志条目无 x＝照旧只回放四字段）
const r = { ts: j.ts, side: j.side, special: j.special, text: jt };
if (j.x && typeof j.x === 'object') {
for (const k in j.x) { if (Object.prototype.hasOwnProperty.call(j.x, k)) r[k] = j.x[k]; }
}
add.push(r);
}
chatTailRetire(keep); // #766：已被历史覆盖的条目当场退休，日志不再长期留着重复的源头
if (!add.length) return 0;
msgs = msgs.concat(add).sort((a, b) => ((a && a.ts) || 0) - ((b && b.ts) || 0));
saveMsgs();
return add.length; // FIX 2026-09-13 #407：回放条数上抛（插入/排序=下标位移，调用方据此标记 changed 重渲）
} catch (e) {}
return 0;
}
// v3.14.x：防「权威读取失败被当空历史」守卫状态——idbGet 的 4s+4s 超时兜底
//（v3.9.x 防挂起）对「键存在但读取超时」也 resolve undefined，与「键不存在」不可区分；
// 真机切桌面瞬间几十模块并发抢 IDB，chat-msgs 大键读取易超时 → 若当"无权威数据"
// 处理会用内存/LS 有损快照覆盖 IDB = 聊天记录丢失。authLoadedPrefix=本会话已成功
// 读过权威的命名空间（空记录落盘守卫用）；读取失败走有界自动重试。
let authLoadedPrefix = null;
let idbRetryTimer = null;
let idbRetryCount = 0;
const IDB_RETRY_MAX = 6;
// FIX 2026-09-21 #967：慢重试看门狗（见 CHAT_AUTH_WATCH_MS 声明处注释）。
// 只读、幂等、绝不抛；每次装载单飞（authWatchT 非空即返回）。
function armChatAuthWatch() {
if (authWatchT) return;
authWatchT = setTimeout(function () {
authWatchT = null;
try {
if (chatAuthSettled()) return;
if (!chatVisible()) return; // 离开聊天页＝不空转（重进聊天走 enterChat 那条链并重新武装看门狗）
loadMsgs(true);
armChatAuthWatch();
} catch (e) {}
}, CHAT_AUTH_WATCH_MS);
}
function stopChatAuthWatch() { if (authWatchT) { clearTimeout(authWatchT); authWatchT = null; } }
function scheduleIdbRetry() {
if (idbRetryTimer || idbRetryCount >= IDB_RETRY_MAX) { armChatAuthWatch(); return; } // #967：快重试耗尽＝看门狗接手，绝不永久放弃读库
idbRetryCount++;
idbRetryTimer = setTimeout(function () {
idbRetryTimer = null;
try { loadMsgs(true); } catch (e) {} // #952：重试必须真读＝forceIdb 绕过读库链在飞去重闸
}, 5000);
}
let readyFuse = null;
function armReadyFuse() {
if (readyFuse || chatDbReady) return;
const fusePrefix = window.activePrefix();
readyFuse = setTimeout(function () {
readyFuse = null;
if (chatDbReady) return;
// v3.14.x：跨联系人兜底——保险丝按武装时命名空间捕获，若已切走（正常路径
// contact-switched 已清本定时器，此处防极端时序漏清）不得误置新桌面就绪
try { if (window.activePrefix() !== fusePrefix) return; } catch (e) {}
chatDbReady = true;
const fuseMsgs = (pendingLocal && pendingLocal.length) ? pendingLocal : msgs;
if (fuseMsgs && fuseMsgs.length) {
try { writeLsSnapshot(fuseMsgs, fusePrefix, true); } catch (e) {}
} else {
try {
const lsRaw = store.get('chat-msgs');
if (lsRaw) {
const lsArr = JSON.parse(lsRaw);
if (Array.isArray(lsArr) && lsArr.length) {
msgs = lsArr;
try { syncLastMineText(); } catch (e) {}
}
}
} catch (e) {}
}
try {
if (chatVisible() && msgs.length && !body.children.length) {
renderWindow(false, true);
scrollChatBottom();
}
} catch (e) {}
// v3.26.x #88：保险丝只放开「显示 + LS 有损快照」，整包落盘仍要等真读到权威
//（authLoadedPrefix 不匹配时 saveMsgs/saveMsgsNow 一律暂存）。这里顺带补挂一次有界
// 读回重试（scheduleIdbRetry 自身限 6 次/5s 间隔），否则读库超时的设备本会话再也拿不回历史。
try { scheduleIdbRetry(); } catch (e) {}
try { updateChatLoading(); } catch (e) {} // 保险丝已就绪 → 隐藏聊天记录加载进度条
}, 15000);
}
function saveMsgs() {
try { scheduleMediaPass(1500); } catch (e) {} // #142：有新消息写入即安排增量令牌化（pass 自带权威守卫与 WeakSet 去重）
// v3.26.x #88：守卫从「未就绪」收紧到「本会话没读到该桌面的权威数据」。
// chatDbReady 会被 15 秒就绪保险丝（armReadyFuse）置 true，而那时 authLoadedPrefix 仍
// 不等于当前命名空间（IDB 读库超时/挂起）。旧逻辑在这个窗口只要 msgs 非空就整包写
// IDB：用户发一条消息 → msgs=[这一条] → 整包覆盖 = 该桌面全部历史被抹成一条。
// 诊断实证（小米 14U Edge）：本机 localStorage 已废（键数 0 + 写探针 QuotaExceededError），
// writeLsSnapshot 的 LS 兜底同样写不进去，覆盖就是永久丢；配合该机启动耗时 24 秒，
// 读库必然压不过 15 秒保险丝 → 高发。
// 现在这种窗口一律只暂存 pendingLocal + 写 LS 有损快照 + 安排重试读回权威；权威读回后
// loadMsgs 会把 pendingLocal 合并进完整历史再落盘。语义：宁可晚存几条，绝不覆盖全部。
const authOk = chatDbReady && authLoadedPrefix === window.activePrefix();
if (!authOk) {
try { pendingLocal = msgs.slice(); } catch (e) {}
// v3.14.x：内存为空时不写 LS 快照——权威读取失败窗口里任何模块触发保存，
// 会把 LS 里仅存的有损备份也覆盖成 "[]"（IDB 万一后续丢失将无从恢复）
if (msgs.length) mergeLsSnapshotWith(msgs, undefined); // #245：合并而非覆盖，保住 LS 里的历史快照
try { scheduleIdbRetry(); } catch (e) {}
return;
}
// v3.26.x 止血：改为合并+低频+空闲落盘（见上方调度器），不再每个动作同步写整包
const myPrefix = window.activePrefix();
schedulePersist(() => {
  // v3.26.x #88：原守卫只挡空数组（防覆盖全部历史），非空时仍会整包覆盖——改为
  // 「本会话确实读到过该命名空间的权威数据」才允许整包落盘。排队到执行之间若切过
  // 桌面，contact-switched 会先 flushPersistNow() 落完再归位 authLoadedPrefix，不漏存。
  if (authLoadedPrefix !== myPrefix) return;
  // v3.26.x #90：条数缩水守卫——内存数组明显少于库内账本时整包不落（含 LS 快照）
  if (!chatLedgerGuard(myPrefix, msgs)) return;
  // FIX 2026-09-17 #127：能复用基准段就只写增量日志（否则整包重写，同旧行为）
  try { if (window.idbSet) persistChatHistory(myPrefix, msgs); } catch (e) {}
  writeLsSnapshot(msgs, myPrefix);
});
}
function flushSave() {
if (window.__resetting) return;
// v3.26.x 止血：立即落盘待写（离页/切走兜底）；#88：未读到权威则仅写 LS 有损快照
flushPersistNow();
// FIX 2026-09-17 #127：离页/导出/切走前把增量日志收口进基准包——外部只读 <prefix>:chat-msgs
// 的模块（备份导出、媒体池 GC、单功能导出）必须看到完整历史，不能只看到基准段。
// chatConsolidate 自带缩水守卫与「基准段未被动过」判定，不满足时不动作（保持旧行为）。
try { chatConsolidate(chatArchPrefix); } catch (e) {}
if ((!chatDbReady || authLoadedPrefix !== window.activePrefix()) && msgs.length) writeLsSnapshot(msgs, undefined, true);
}
window.chatFlushSave = flushSave;
// ===== #142 媒体池：聊天图片内容寻址去重 =====
// 同一张表情包/图片每发一次就整份 base64 进库（诊断实证 chat-msgs 全桌面 ≈214MB，
// 重复占大头）。normalize 把消息里的 data:image 替换为池令牌 @@m:<hash>（media-pool.js
// 负责哈希/落池/渲染解析），消息体只留 44 字符引用。安全设计：
//   · 令牌化只发生在内存 msgs 上，落盘走 saveMsgs() 原路（#88 权威守卫/#90 账本守卫全保留）；
//   · 池数据落盘（mochiMediaFlush）先于 msgs 落盘——崩溃窗口最多「池多一条孤儿」，
//     不可能出现「令牌入库而池数据丢失」；
//   · WeakSet 记录已处理消息：每条消息每会话只哈希一次，pass 高频触发零重复开销；
//   · 令牌跨桌面/跨设备稳定（内容哈希），备份导出带池键即可在他机恢复；
//   · crypto.subtle 不可用（非安全上下文）时 tokenize 恒 null，一切保持旧路径。
let _mediaPassT = null, _mediaPassBusy = false;
const _mediaTokSeen = new WeakSet();
function scheduleMediaPass(delay) {
if (!window.mochiMediaTokenize) return;
clearTimeout(_mediaPassT);
_mediaPassT = setTimeout(mediaNormalizePass, delay || 1500);
}
async function mediaNormalizePass() {
if (_mediaPassBusy) { scheduleMediaPass(4000); return; }
// 与 saveMsgs 同款权威守卫：本会话没读到该桌面权威数据时绝不改写（防把半库令牌化覆盖全史）
if (!chatDbReady || authLoadedPrefix !== window.activePrefix()) return;
_mediaPassBusy = true;
try {
let changed = 0;
let _rollback = []; // FIX 2026-09-05 #186 写池失败回滚账 [{obj, prop, val, msg}]
let _pendTok = 0; // FIX 2026-09-10 #283 迁移期分批冲池计数
for (let i = 0; i < msgs.length; i++) {
const m = msgs[i];
if (!m || _mediaTokSeen.has(m)) continue;
let did = false;
if (typeof m.text === 'string' && chatIsDataImgSrc(m.text)) {
const t = await window.mochiMediaTokenize(m.text.trim());
if (t) { _rollback.push({ o: m, p: 'text', v: m.text, msg: m }); m.text = t; changed++; did = true; }
}
if (typeof m.img === 'string' && chatIsDataImgSrc(m.img)) {
const t = await window.mochiMediaTokenize(m.img.trim());
if (t) { _rollback.push({ o: m, p: 'img', v: m.img, msg: m }); m.img = t; changed++; did = true; }
}
// FIX 2026-09-10 #283 语音令牌化——历史语音/语音字卡整份 data:audio 内联在 text
//（「名称|||data:audio/…」，#142 v1 只收图片漏了它 ⇒ 本机诊断 chat-msgs 79.2MB：
// 每次落盘 structured clone 整包＝低端机长任务 100~400ms+GC 频繁＝「经常卡、按不动」）。
// 替换为「名称|||@@m:hash」/「|||@@m:hash」，音频本体进池只存一份；名称段原样保留。
if (typeof m.text === 'string' && m.text.length > 1024) {
const _bar = m.text.indexOf('|||');
const _tail = _bar > 0 ? m.text.slice(_bar + 3) : '';
// FIX 2026-09-20 #948 「名称|||data:…」与裸 data:audio 两形态都改大小写/空白不敏感判定，
// 并把载荷整串 trim 后再哈希入池（旧写法整串带首尾空白入池＝池值不标准、解图端体检判失败）
const _tailData = _bar > 0 && chatIsInlineDataSrc(_tail.trim()) ? _tail.trim() : '';
if (_tailData) {
const t = await window.mochiMediaTokenize(_tailData);
if (t) { _rollback.push({ o: m, p: 'text', v: m.text, msg: m }); m.text = m.text.slice(0, _bar + 3) + t; changed++; did = true; }
} else if (chatIsDataAudioSrc(m.text)) {
const t = await window.mochiMediaTokenize(m.text.trim());
if (t) { _rollback.push({ o: m, p: 'text', v: m.text, msg: m }); m.text = '|||' + t; changed++; did = true; }
}
}
if (typeof m.voice === 'string' && m.voice.length > 1024 && chatIsDataAudioSrc(m.voice)) {
const t = await window.mochiMediaTokenize(m.voice.trim());
if (t) { _rollback.push({ o: m, p: 'voice', v: m.voice, msg: m }); m.voice = t; changed++; did = true; }
}
if (Array.isArray(m.parts) && m.parts.length) {
for (let j = 0; j < m.parts.length; j++) {
const p = m.parts[j];
if (p && typeof p.v === 'string' && chatIsDataImgSrc(p.v)) {
const t = await window.mochiMediaTokenize(p.v.trim());
if (t) { _rollback.push({ o: p, p: 'v', v: p.v, msg: m }); p.v = t; changed++; did = true; }
}
}
}
_mediaTokSeen.add(m);
if (did) _pendTok++;
if ((i & 63) === 63 || _pendTok >= 32) {
// FIX 2026-09-10 #283 迁移期分批冲池：语音批量令牌化可达几十 MB，writeBuf 与单条
// idbSetAll 事务随批封顶（≤32 条）；池数据先落盘后，已冲批次从回滚账除名（池已持久，
// 无需回滚原件，回滚账常持几十 MB 原件＝迁移会话堆尖峰）
if (_pendTok >= 32) {
const _okMid = await window.mochiMediaFlush();
if (_okMid === false) {
for (let r = 0; r < _rollback.length; r++) { try { _rollback[r].o[_rollback[r].p] = _rollback[r].v; } catch (e2) {} try { _mediaTokSeen.delete(_rollback[r].msg); } catch (e3) {} }
scheduleMediaPass(8000);
console.warn('[mochi] 媒体池写盘失败，本次 ' + changed + ' 处令牌化已回滚待重试');
return; // finally 复位 busy
}
_rollback = []; // 已冲批次池数据均已持久，全部除名（清空回滚账=释放原件引用）
_pendTok = 0;
}
await new Promise(r => setTimeout(r, 0));
// 中途切桌面/权威归属变化 → 立即中止（WeakSet 未标记的记录留给下次 pass）
if (authLoadedPrefix !== window.activePrefix()) break;
}
}
if (changed > 0) {
const _ok = await window.mochiMediaFlush(); // 池数据先落盘，再让引用落盘（顺序不可反）
if (_ok === false) {
// FIX 2026-09-05 #186 写池失败（idbSetAll 返回 false）绝不能带令牌落库——否则令牌入库
// 而池数据只在内存重试队列，页面被杀即永久空白气泡（vivo X200s+Edge 等大库机反复出现）。
// 回滚本次全部令牌化，WeakSet 去标记，留给下次 pass 重试。
for (let r = 0; r < _rollback.length; r++) { try { _rollback[r].o[_rollback[r].p] = _rollback[r].v; } catch (e2) {} try { _mediaTokSeen.delete(_rollback[r].msg); } catch (e3) {} }
scheduleMediaPass(8000);
console.warn('[mochi] 媒体池写盘失败，本次 ' + changed + ' 处令牌化已回滚待重试');
} else {
saveMsgs();
try { console.info('[mochi] 媒体池：' + changed + ' 处聊天图片/语音已去重为池引用'); } catch (e) {}
}
}
} catch (e) {} finally { _mediaPassBusy = false; }
}
document.addEventListener('mochi-restore-done', function () { setTimeout(function () { scheduleMediaPass(1000); }, 18000); });
document.addEventListener('contact-switched', function () { setTimeout(function () { scheduleMediaPass(1000); }, 12000); });
window.chatMediaNormalizeNow = mediaNormalizePass; // 可测性/诊断钩子（verify-media-pool 用）
try {
window.addEventListener('beforeunload', flushSave);
document.addEventListener('visibilitychange', () => {
if (document.visibilityState === 'hidden') flushSave();
else if (deskMsgEl && !deskMsgEl.hidden) hideDeskMsg();
});
} catch (e) {}
window.getChatMsgs = function () { return chatColdHead.length ? chatColdHead.concat(msgs) : msgs; }; // #722：冷头未并入时也返回完整历史（浅拼接，统计/导出/补投递等消费方零改动）
try { window.__mochiProf = window.__mochiProf || {}; } catch (e) {}
function __prof(t) { try { window.__mochiProf[t] = performance.now(); } catch (e) {} }
// ===== v3.26.x OOM 防线：聊天大数据量分批/延迟归一化 =====
// 根因：三星 S24 等真机上，旧账号积累数万条聊天记录时，启动读库后在主线程同步
// 跑完所有「全量数组」pass（collapseRapidDups / 图表迁移 / 媒体迁移 / 转义还原 /
// ts 回填 / sysNick 清扫），主线程阻塞数秒 → 渲染进程 OOM、页面崩溃。
// 方案：IDB 解析/合并后先出首屏，把这些 pass 挪到后台按片 setTimeout 分批跑，
// 单帧只耗几毫秒；全部跑完再合并渲染 + 落盘。各 pass 均按对象引用改属性、幂等可重入。
const ICON_BELL = '<svg class="st-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v3M4.2 4.2l2.2 2.2M2 12h3M19 12h3M4.2 19.8l2.2-2.2M17.6 17.6l2.2 2.2"/><path d="M12 6a6 6 0 016 6v4h-3v-4a3 3 0 00-6 0v4H6v-4a6 6 0 016-6z"/><path d="M9 20h6"/></svg>';
const ICON_TEL = '<svg class="st-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></svg>';
const ICON_ENV = '<svg class="st-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>';
const ICON_CQ_FIX = { '再等等，会遇到我': '再等等，会遇到你', '你身边': '我身边', '只给我看': '只给你看' };
const NORM_CHUNK = 2500;
let normTimer = null, normPrefix = null;
// FIX 2026-09-16 #624 多图消息守卫：parts 里 ≥2 张图的记录不得被下面「text 以 data:image/
// 开头 → 升级成 type:'image'」的存量规则折叠——升级后渲染走单图类型分支（renderMsg 的类型
// 分支先于 parts 分支），第二张起全部丢失＝用户 / TA 的「一条消息两张图」刷新或重进后只剩一张。
function hasMultiImgParts(r) {
  if (!r || !Array.isArray(r.parts)) return false;
  let n = 0;
  for (let i = 0; i < r.parts.length; i++) {
    const p = r.parts[i];
    if (p && p.k === 'img' && ++n > 1) return true;
  }
  return false;
}
function normCell(r) {
  let c = false;
  if (!r) return false;
  try {
    if (typeof r.text === 'string' && r.text.indexOf(ICON_BELL) >= 0) { r.text = r.text.split(ICON_BELL).join(ICON_TEL); c = true; }
    if (r.special === 'poke' && typeof r.text === 'string') {
      const t = r.text.replace(/✉️\s*/g, '').replace(/✉\s*/g, '');
      if (t !== r.text) { r.text = ICON_ENV + t; c = true; }
    }
    // FIX 2026-09-20 #948h 存量无 MIME 图片载荷就地补正 MIME（File.type 为空时 FileReader 产出
    // "data:;base64,…"）：WebKit 系对无类型 data: 不做图片嗅探＝不补正则照旧裂图/占位，补正后
    // 才真出图（Chrome 系本就嗅探，补正只是把形态规范化）。魔数判定零机型分支、幂等（补正后即
    // 不再是本形态），且只碰无 MIME 形态，其余载荷一字不动。
    if (typeof r.text === 'string' && r.text.indexOf('data:;base64,') >= 0) {
      const __nmFixed = chatFixNoMimeImg(r.text);
      if (__nmFixed) { r.text = __nmFixed; c = true; }
    }
    // FIX 2026-09-20 #948 判据换成大小写/前导空白不敏感的统一口径（chat.js 新增 chatIsImgSrcLike
    // /chatIsDataAudioSrc）：旧写法 `r.text.indexOf('data:image/') === 0` 让内核给的变体形态
    // （大写 MIME、串首空白、data:image/HEIC、data:application/…）永远升不了级＝整段 base64
    // 当文字直出＝用户所见「图片变长乱码」，且这类载荷也进不了媒体池（见 media-pool #948）。
    if ((r.type === 'text' || !r.type) && !hasMultiImgParts(r) && typeof r.text === 'string' && chatIsImgSrcLike(r.text)) { r.type = 'image'; c = true; }
// FIX 2026-09-12 #383 存量乱码自愈：#383 前令牌卡曾以 type:text 入库（气泡直出 @@m:hash 串），
// 归一化补认裸令牌→type='image'（与上行 data:image 升级同口径），刷新后历史乱码消息变回图片
// FIX 2026-09-10 #283 语音型归一：裸 data:audio 文本与「|||@@m:令牌」（pass 令牌化后的无主
// 名称形态）补 type='voice'，走语音气泡渲染（名称缺省「语音消息」），不再当纯文本直出
if ((r.type === 'text' || !r.type) && typeof r.text === 'string' &&
(chatIsDataAudioSrc(r.text) || (r.text.indexOf('|||') >= 0 && /@@m:[0-9a-f]{32}$/.test(r.text)))) { r.type = 'voice'; c = true; }
// #451 存量治愈：词典拼字/梦角自由造句旧消息「正文换血后 parts 残留原回复」——气泡渲染
// parts 优先于 text（#202 混合消息链路），引用快照/收藏/回复引用读 text＝「消息显示 A、
// 引用预览显示 B」（iOS Chrome 等多机型同报）。addIn 白名单不存 spell/mjFree 字段，
// 来源 chip（mood tag）是唯一持久化标识；文本段≠正文时以正文重建 parts（保留图片段）。
// 幂等：重建后文本段===text 不再触发。
// FIX 2026-09-20 #948 正文本身就是媒体载荷时不得重建：把 dataURL/令牌塞进 k:'text' 段
// ＝把「乱码」从 text 通道挪进 parts 文本通道（渲染端照样整串直出），且原写法还会在
// 无图片段时把 parts 清成 null。此类记录由上方 type 升级走图片/语音气泡，本段整块跳过。
if (Array.isArray(r.parts) && r.parts.length && typeof r.text === 'string' && r.text &&
!chatIsMediaPayload(r.text) &&
Array.isArray(r.mood) && r.mood.some(md => md && (md.tag === '词典' || md.tag === '词典拼字' || md.tag === '词典拼句' || md.tag === '词典拼词' || md.tag === '词典逐卡连发' || md.tag === '梦角自由造句'))) {
const __hpImgs = r.parts.filter(p => p && p.k === 'img');
const __hpTxt = r.parts.filter(p => p && p.k === 'text').map(p => p.v).join(' ');
if (__hpTxt !== r.text) {
r.parts = __hpImgs.length ? [{ k: 'text', v: r.text }].concat(__hpImgs) : null;
c = true;
}
}
// FIX 2026-09-18 #773c 历史「多字卡回复」错标签自愈（判据与保守口径见 pyChipDropIfSingle 处注释）
if (pyChipDropIfSingle(r)) c = true;
    if (r.special === 'poke' && typeof r.text === 'string' && r.text.indexOf('&lt;svg class=&quot;st-ico&quot;') === 0) {
      const mm = r.text.match(/^(&lt;svg class=&quot;st-ico&quot;[\s\S]*?&lt;\/svg&gt;)([\s\S]*)$/);
      if (mm) { r.text = mm[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&') + mm[2]; c = true; }
    }
    if (r.special === 'ask-curious' && Array.isArray(r.curiousQuick)) {
      const f = r.curiousQuick.map(o => ICON_CQ_FIX[o] || o);
      if (f.some((o, i) => o !== r.curiousQuick[i])) { r.curiousQuick = f; c = true; }
    }
    if (r.special === 'ask-curious' && typeof r.curiousAnswer === 'string' && ICON_CQ_FIX[r.curiousAnswer]) { r.curiousAnswer = ICON_CQ_FIX[r.curiousAnswer]; c = true; }
    // #1477：无 ts 的存量记录改盖「自身事件时间」（红包 rpTs／申请 askTs／问卷 surveyTs／投递 dAt），
    // 不再盖加载时刻的 Date.now()——旧写法让这类记录每次首遇都变「最新一条」，下一次按 ts 升序
    // 合并排序即被挪到数组末尾，而 DOM 的 data-idx/data-mk 是按旧顺序画的 ⇒ 点卡片读到别的消息
    //（「联系人发的红包无法点击领取」的漂移驱动）。链与 msgKeyOf 的 msgRecTsOf 同一条，两头要一起改。
    if (!r.ts) { r.ts = (r.rpTs || r.askTs || r.surveyTs || r.dAt) || Date.now(); c = true; }
  } catch (e) {}
  return c;
}
// ===== FIX 2026-09-07 #256 表情包「屏上重复一条、刷新几下又变回一条」——相邻重复判定三处口径收口 =====
// 根因：相邻重复判定存在三套窗口——addRec 实时去重 1200ms、collapseRapidDups/normCollapseRange
// 刷新归一化 2500ms(文本)/60000ms(仅 img/voice/special 字段型媒体)。多字卡回复条间隔
// randInt(1200,2800)ms 恰好整体落在实时窗之外：联系人一批回两张同款表情包（表情包池小或
// 表情包概率拉满时高发，各机型均现），屏上两张都渲染；刷新后归一化又按「相邻重复」删掉一张
// （间隔 ≤2500ms 且两份文本形式一致时）＝「重复一条、刷新几下消失变回一条」。
// 次因（跨形式漏判）：#142 媒体令牌化会把 text 从 data:base64 异步改写为 @@m:令牌，令牌化
// 竞态下同一条内容一处已是令牌、另一处仍是 base64，文本直比不等＝重复判定全链漏过，刷新也
// 合并不了（要等两次令牌化收敛后再一轮归一化，体感「刷好几下才好」）。
// 收口：①dupGapMs 唯一窗口源（文本 2500ms 不变；媒体 60000ms——img/voice/special 字段两侧
// 沿用既有 60000；text 即媒体的 sticker/image/voice 型仅收件侧扩到 60000，发件侧是人为重发
// 60s 内重发同图属合法行为不吞）；②mediaTxtEq 展开池令牌后再比对（内容寻址，令牌展开即原
// 数据）——addRec 实时去重与刷新归一化共用，屏上所见即刷新后所见，不再翻饼。
const DUP_GAP_TEXT = 2500, DUP_GAP_MEDIA = 60000;
// FIX 2026-09-16 #594（用户：切换桌面联系人→打开聊天，所有消息变 2 条再回弹恢复）：
// 媒体「同一内容、不同存储形态」的唯一归一化入口。令牌化竞态（#142/#256/#283）下同一条消息
// 在一处是原文（data:image base64，或语音的「名称|||data:audio」）、另一处已是 @@m: 令牌，
// 任何「这是同一条吗」的判定直接比原文都判成两条。本函数把两形态收敛成同一份原文
// （池未热载 mochiMediaExpand 返回 null 时退化为原文，与 #256/#511 同款不误判口径）。
// 四个计入口共用本函数，杜绝「修了读侧、写侧/IDB 侧仍按旧口径各存一份」的半修：
//   · mediaTxtEq（addRec 实时去重）· dupSig（刷新归一化/相邻重复合并）
//   · lsMergeSig（LS 快照 ↔ 内存合并，#511）· loadMsgs 权威合并签名 sigOf（#594 本轮补漏）
function mediaFormText(s) {
  const raw = (s == null) ? '' : String(s);
  if (!raw) return raw;
  try {
    if (window.mochiMediaIsToken && window.mochiMediaExpand) {
      const bar = raw.indexOf('|||');
      // 语音尾形态「名称|||令牌」：只展开尾部，名称段原样保留（#283）
      if (bar >= 0) {
        const tail = raw.slice(bar + 3);
        if (tail && window.mochiMediaIsToken(tail)) {
          const ex = window.mochiMediaExpand(tail);
          if (ex) return raw.slice(0, bar + 3) + ex;
        }
      } else if (window.mochiMediaIsToken(raw)) {
        const ex = window.mochiMediaExpand(raw);
        if (ex) return ex;
      }
    }
  } catch (e) {}
  return raw;
}
// 合并/去重签名用的内容片段：短串整串入签名（与旧口径逐字节一致，零判别力损失）；
// 长串（base64 可达数百 KB）只取「长度 + 前 96 字符」——整串进 Set 哈希会让切桌面/开聊天
// 白白烧 CPU（#511 同口径；长度+头部随内容变化，对「跨形态同一条」判别力足够）
function mediaSigPart(v) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string') { try { return String(v.length); } catch (e) { return ''; } }
  const x = mediaFormText(v);
  if (x.length <= 256) return x;
  return x.length + '|' + x.slice(0, 96);
}
function mediaTxtEq(a, b) {
  const x = (a == null) ? '' : String(a);
  const y = (b == null) ? '' : String(b);
  if (x === y) return true;
  // FIX 2026-09-16 #594：跨形态比对统一走 mediaFormText（原先只认「整串令牌」，语音的
  // 「名称|||令牌」形态漏在窗外＝同一条语音在两处判不同）
  return mediaFormText(x) === mediaFormText(y);
}
// FIX 2026-09-16 #594 后半段（不依赖媒体池热载的兜底判定）：
// mediaFormText 要靠 mochiMediaExpand 展开令牌，而它是**纯 map 热缓存查询**——冷启动/换桌面
// 时池里什么都没热载（音频按 #283 内存纪律更是永不进热缓存）⇒ 展开恒 null ⇒ 上一条比较
// 仍判「两条」。快照合并必须与池温无关，故这里补一条形态判定：
// 同一 ts|side|special|type 的记录在一侧是原文（data:image/data:audio）、另一侧是 @@m: 令牌
// ＝同一条记录的两种存法（ts 精确到毫秒且同侧，本文件 idbTsSide 的 lite 残留过滤早已用这个
// 身份口径），快照侧那份是旧形态副本，丢弃。
// 只对「媒体形态互补」的组合生效：普通文本、令牌↔令牌、原文↔原文一律不受影响（编辑后的
// 新文本、两张不同表情包的合法重复都不会被误吞）。
function mediaKindOf(v) {
  if (typeof v !== 'string' || !v) return '';
  try {
    if (window.mochiMediaIsToken && window.mochiMediaIsToken(v)) return 'tok';
    const bar = v.indexOf('|||');
    if (bar >= 0) {
      const tail = v.slice(bar + 3);
      if (chatIsInlineDataSrc(tail)) return 'raw'; // FIX #948
      if (window.mochiMediaIsToken && window.mochiMediaIsToken(tail)) return 'tok';
      return '';
    }
    if (chatIsInlineDataSrc(v)) return 'raw'; // FIX #948 整串任意 data: 载荷都是媒体，不是文字
  } catch (e) {}
  return '';
}
function recMediaKind(m) { return m ? (mediaKindOf(m.text) || mediaKindOf(m.img)) : ''; }
function recMediaKey(m) {
  return ((m.ts || 0) + '|' + (m.side || '') + '|' + (m.special || '') + '|' + (m.type || ''));
}
// 权威侧形态索引：去重键 -> { raw, tok }（同键下两种存法都记下来）
function recKindIndex(arr) {
  const idx = new Map();
  try {
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i];
      if (!m) continue;
      const k = recMediaKind(m);
      if (!k) continue;
      const key = recMediaKey(m);
      let rec = idx.get(key);
      if (!rec) { rec = { raw: false, tok: false }; idx.set(key, rec); }
      rec[k] = true;
    }
  } catch (e) {}
  return idx;
}
// 快照侧这条是否已被权威侧以「另一种存法」收录（互补形态 ⇒ 同一条记录）
function recKindCovers(kindIndex, m) {
  if (!kindIndex || !m) return false;
  const k = recMediaKind(m);
  if (!k) return false;
  const rec = kindIndex.get(recMediaKey(m));
  if (!rec) return false;
  return k === 'tok' ? rec.raw : rec.tok;
}
function dupGapMs(m) {
  if (!m) return DUP_GAP_TEXT;
  if (m.img || m.voice || m.special) return DUP_GAP_MEDIA;
  if ((m.type === 'sticker' || m.type === 'image' || m.type === 'voice') && (m.side || '') === 'in') return DUP_GAP_MEDIA;
  // FIX 2026-09-12 #359 → 2026-09-14 #437 口径演进（发送侧媒体：表情包/图片/语音字卡）：
  // 2500ms→8000ms（#359：摩托罗拉 G100/华为 P50E 无反馈补点「发一遍出 2 个」）→800ms（#437：
  // 用户确认「同一时间发同样的内容必须能发出去」，多机型同报误吞）。表情面板发完即关，人为重发
  // 必须重开面板再点同一条 ≈≥1s，800ms 只吞机械双派发/双击（#359 无头实证 150ms 双派发、
  // #401 低端机长任务 606ms 延迟均 <800ms，与 #401 发件侧纯文本 800ms 同一口径），有意重发
  // 一律放行；collapseRapidDups/normCollapseRange 共用本窗口＝刷新归一化不回吞（屏上所见即
  // 刷新后所见，#256 原则不动）。收件侧 60000ms 不变（#256 TA 多字卡回复批 1.2~2.8s 间隔
  // 防同款两张照旧）；命中吞并时 addRec 给 toast 反馈不再静默（#437，静默吞＝「发不出去」报障源）。
  if (m.type === 'sticker' || m.type === 'image' || m.type === 'voice') return 800;
  // parts 型纯图片消息（相册发送，text 为空/说明文字）同窗口：同图快速重发属合法行为
  if (Array.isArray(m.parts) && m.parts.some(p => p && p.k === 'img') && (m.side || '') === 'out') return 800;
  // FIX 2026-09-13 #401 发件侧纯文本去重窗口 2500ms→800ms：发守卫（userEditedAfterClear）
  // 已放行的「用户真实重打同文本」仍撞进本窗被静默吞掉＝「点发送消息没了」（红米 K80
  // 报障同族复发——v3.17.x 只修了守卫层误吞，addRec 这第二层漏网；无头实证：重打同文本
  // 1.2s 后再发，守卫放行、addRec 吞掉，输入框被清+音效照放+TA 照回，气泡 0 条）。
  // 机械双击两次 click 间隔几乎恒 <800ms（含低端机长任务 606ms 延迟）仍被本窗兜底 +
  // 发守卫双层防护；真人「清框→重打→再点发送」不可能 <800ms。收件侧/媒体窗口一律不动
  // （#256 屏上所见即刷新后所见：normCollapseRange/collapseRapidDups 同口径收窄，一致）。
  if ((m.side || '') === 'out' && (m.type === 'text' || !m.type) && !m.img && !m.voice && !m.special) return 800;
  return DUP_GAP_TEXT;
}
// FIX 2026-09-19 #814d 「消息被切」探针：一切丢弃/收敛路径各留一笔（环形 40 条，只读、
// 绝不抛），device.js 诊断报告「消息被吞体检」行暴露计数与最近样本。#814 起合法消息理论上
// 只会被【身份级】判据切掉（同 ts 副本 / 同对象 / 出生号 / 发件侧 800ms 机械双派发）——
// 报告里 g814ts/g814out 偶发属正常防重生效，量级异常（几十上百）＝有通道在重投或误判，
// 凭 tag+时间戳直接定位，不再靠猜。
window.__mochiMsgCut = window.__mochiMsgCut || [];
function chatMsgCutMark(tag, m) {
try {
const a = window.__mochiMsgCut;
a.push(Date.now() + ':' + tag + ':' + ((m && m.side) || '') + ':' + String((m && m.text) != null ? m.text : ((m && m.special) || '')).slice(0, 20));
if (a.length > 40) a.shift();
} catch (e) {}
}
function normCollapseRange(from, to) {
  let removed = 0;
  try {
    const n = msgs.length;
    for (let i = Math.min(to, n) - 1; i > from; i--) {
      const a = msgs[i], b = msgs[i - 1];
      if (!a || !b || !a.side || a.side !== b.side) continue;
      if (dupSig(a) !== dupSig(b)) continue;
      if (a.dedupExempt || b.dedupExempt) continue; // FIX 2026-09-15 #544 决定答案豁免相邻合并（刷新侧与 addRec 实时侧同口径，屏上所见即刷新后所见）
      const hasContent = (a.text && a.text.length) || a.img || a.voice || !!a.special || (a.parts && a.parts.length);
      if (!hasContent) continue;
      const dts = (a.ts || 0) - (b.ts || 0);
      // FIX 2026-09-19 #814b：刷新归一化只回并**同 ts** 的重投副本（尾巴日志/LS 快照/chat-arch/
      // 热片补投一律保留原 ts）——旧的「跨毫秒内容相邻合并」窗（in 侧 60000ms/2500ms、special 卡
      // 实时层整条跳过却在这里挨收）把 TA/系统真发的合法第二条当脏数据从库里删掉，且落盘固化＝
      // 「之前发出来的消息被吞」的直接机制（实时层放行的，刷新一次再收一次）。dupSig 内容判据保留
      // （旧存量数据无出生号 uid 时的兜底，配合同 ts 才准删）。零机型分支。
      if (dts !== 0) continue;
      chatMsgCutMark('g814ts', a); // #814d
      try { if (normRemovedRecs) normRemovedRecs.push(a); } catch (e) {} // FIX #675：被删记录对象留给原位收敛
      msgs.splice(i, 1); removed++;
    }
  } catch (e) {}
  return removed;
}
function scheduleDeferredNormalization() {
  if (normTimer) return;
  let pre;
  try { pre = window.activePrefix(); } catch (e) { pre = ''; }
  if (pre === normPrefix) return;
  normPrefix = pre;
  normTimer = setTimeout(runDeferredNormalization, 80);
}
function runDeferredNormalization() {
  normTimer = null;
  let myPre;
  try { myPre = window.activePrefix(); } catch (e) { myPre = ''; }
  if (myPre !== normPrefix) { normPrefix = null; return; }
  let idx = 0, changed = false;
  const idSeen = new Map(); // FIX 2026-09-18 #776：身份级重复收敛的下标登记（跨块共享，本轮归一化内有效）
  // v3.26.x #211：记录归一化改动的最靠后下标与结构性删除数。收尾时若改动全部落在
  // 当前渲染窗口之外（changedHi < renderStart），跳过整窗重建——renderWindow 会销毁
  // 重建整个消息区（气泡+图片全部重建重新解码=肉眼可见闪一下），是「打开聊天偶尔
  // 闪动」的第二来源（偶发＝仅当历史里存在待迁移数据时 finish 才走渲染）。屏上数据
  // 真的变了仍整窗重渲；sysNick 清扫与相邻重复删除（下标位移）按保守整窗处理。
  let changedHi = -1, removedAll = 0, sysNickChanged = false;
  normChangedIdxs = []; // FIX 2026-09-13 #402：本轮归一化改动下标清单（原位补丁用）
  // FIX #675：本轮删除/改动的记录对象登记（此刻 msgs 即归一化前的原始数组）
  normChangedRecs = []; normRemovedRecs = [];
  const N = msgs.length;
  if (!N) { normPrefix = null; return; }
  // FIX #675：记录 → 原始下标映射（DOM data-idx 与窗口凭据都是原始下标系，删除后据此回推）
  try { normOrigIdx = new Map(); for (let _oi = 0; _oi < N; _oi++) normOrigIdx.set(msgs[_oi], _oi); } catch (e) { normOrigIdx = null; }
  // 快照尾节点：归一化运行期 addRec 尾部追加的节点都在它之后（下标已是新系），原位收敛分段处理。
  // 防御式取节点（回归脚本会把这个函数抽进无 DOM 沙箱跑，body/document 可能不在作用域）
  try { normSnapTail = (document.getElementById('chat-body') || {}).lastElementChild || null; } catch (e) { normSnapTail = null; }
  const finish = () => {
    try { sysNickChanged = !!sysNickCatchup(); changed = changed || sysNickChanged; } catch (e) {}
    normPrefix = null;
    if (!changed) return;
    // v3.26.x #88：未读到权威时不整包写回（同 saveMsgs 守卫）。归一化是幂等的，
    // 本次跳过会在下次读库成功后重跑；拿内存里的部分数组覆盖 = 丢全部历史。
    if (authLoadedPrefix !== myPre) return;
    // v3.26.x #90：归一化会删相邻重复（条数变少）——命中缩水判定时只跳过落盘（幂等，
    // 下次读库成功后重跑），渲染照常，不影响本会话使用。
    const canPersist = chatLedgerGuard(myPre, msgs);
    if (canPersist) {
    try { if (window.idbSet) persistChatHistory(myPre, msgs); } catch (e) {}
    try { writeLsSnapshot(msgs, myPre, true); } catch (e) {}
    }
    // #211：改动全部在渲染窗口之外时跳过整窗重建（防打开聊天闪一下）；屏上有改动才重渲
    // #220：走「屏上重渲」或改动落在窗口内时，屏上窗口已不再是「与 msgs 一致的旧貌」，
    // windowStale 置真——权威读库收尾的同窗补丁据此跳过（这里已重渲过，无需再补）。
    // FIX 2026-09-13 #402（进聊天跳动一下·多机型偶发，#352 无头诊断实锤）：窗口内改动
    // 旧路径 renderWindow 整窗重建＝rem+add ~200 节点同批＝进入聊天 ~0.5s 后整屏跳一下。
    // 现改为：无结构删除（removedAll===0，normCell 只原地改记录、下标全程稳定）且非
    // sysNick 全局改名时，优先 patchChangedInPlace 对命中下标原位换节点（其余节点零
    // 重建）；任一守卫不满足回退原整窗渲染，行为与旧版一致。sysNick 改名/结构删除
    // （下标位移）仍保守整窗（原路径不动）。
    try {
    if (chatVisible() && msgs.length &&
    (sysNickChanged || removedAll > 0 || changedHi >= renderStart)) {
    let patched = false;
    if (!sysNickChanged && removedAll > 0 &&
    patchNormRemovalsInPlace(normRemovedRecs)) {
    // FIX #675：结构删除已原位收敛（删节点+下标回推，零整窗重建＝图片不重新解码不弹）；
    // 本轮字段级改动按「删除后的新下标」继续原位补丁，失败仍回退整窗兜底。
    const newIdxs = [];
    try {
    for (let _ci = 0; _ci < normChangedRecs.length; _ci++) {
    const _ni = msgs.indexOf(normChangedRecs[_ci]);
    if (_ni >= 0) newIdxs.push(_ni);
    }
    } catch (e) { newIdxs.length = 0; }
    patched = patchChangedInPlace(newIdxs, renderStart);
    } else if (!(sysNickChanged || removedAll > 0)) {
    patched = patchChangedInPlace(normChangedIdxs, renderStart);
    }
    if (!patched) {
    renderWindow(false, true);
    // FIX 2026-09-30 #1491：这一支的「整窗重建＋无条件贴底」是弹回当前页的第二发（诊断单里那 6 次
    //   prog 位移就落在跳转之后的重画里）。归一化改的是数据、不是用户意图：用户已经解钉在看历史时，
    //   重画完不该替他滚回底部。判据只取 chatPinnedBottom 这一个当场事实，钉住态（用户就在最新一条
    //   附近／自己刚发了消息）行为逐字不变。零机型／零 UA 分支。
    if (chatPinnedBottom) scrollChatBottom(); // #1491h 用户已接管滚动＝归一化回退整窗后不替他贴底
    }
    } else if (changed && changedHi >= renderStart) {
    windowStale = true;
    try { if (!chatVisible()) scheduleChatPrewarm(myPre); } catch (e) {} // #951f 凭据既已作废，页面还藏着时当场把预渲重做一遍——否则这份作废只会在用户点开聊天那一瞬兑现成整窗重建（clear→逐块重建＝闪屏），预渲白做一次
    }
    } catch (e) {}
  };
  const tick = () => {
    let nowPre;
    try { nowPre = window.activePrefix(); } catch (e) { nowPre = ''; }
    if (nowPre !== normPrefix) { normPrefix = null; return; }
    const end = Math.min(N, idx + NORM_CHUNK);
    for (let i = idx; i < end; i++) { if (normCell(msgs[i])) { changed = true; changedHi = Math.max(changedHi, i); if (normChangedIdxs.indexOf(i) < 0) normChangedIdxs.push(i); try { normChangedRecs.push(msgs[i]); } catch (e) {} } }
    const _id = collapseIdentityRange(idx, end + 1, idSeen); // FIX #776 身份级重复（正文签名看不见的那一类）
    if (_id) { changed = true; removedAll += _id; }
    const _rm = normCollapseRange(idx, end + 1, msgs);
    if (_rm) { changed = true; removedAll += _rm; }
    if (end < N) { idx = end; setTimeout(tick, 0); }
    else finish();
  };
  setTimeout(tick, 0);
}
function migrateLegacyMediaMsgs() {
let migrated = false;
msgs.forEach(r => {
// FIX 2026-09-15 #534 存量图片直链消息补 type='image'——#533 前链接导入的字卡
// （裸 http(s) 图链）曾被当文字卡抽出、以 type:'text' 落库，气泡直出整段链接；
// 与 normCell / 渲染端自愈同口径（只认带图片扩展名的单条直链，普通链接不受影响）。
if (r && (r.type === 'text' || !r.type) && !hasMultiImgParts(r) && typeof r.text === 'string' && chatIsImgSrcLike(r.text)) { // FIX 2026-09-20 #948 与 normCell 同款大小写/空白不敏感判据
r.type = 'image';
migrated = true;
}
});
if (migrated) saveMsgs();
}
function dupSig(m) {
if (!m) return '';
const sp = m.special || '';
let extra = '';
try {
if (sp === 'ask-card' || sp === 'ask') extra = String(m.askQuestion || '') + '|' + JSON.stringify(m.askOptions || []) + '|' + String(m.askType || '');
else if (sp === 'ask-choose') extra = String(m.choiceQuestion || '') + '|' + JSON.stringify(m.choiceOptions || []) + '|' + String(m.choicePref || '') + '|' + String(m.choiceCat || '');
else if (sp === 'ask-curious') extra = String(m.curiousQuestion || '') + '|' + JSON.stringify(m.curiousQuick || []) + '|' + String(m.curiousCat || '');
else if (sp === 'ask-roast') extra = String(m.roastText || '') + '|' + String(m.roastCat || '');
else if (sp === 'invite') extra = String(m.inviteContent || m.text || '');
else if (sp === 'gift') extra = String(m.giftId || '') + '|' + String(m.giftName || '') + '|' + String(m.giftEmoji || '') + '|' + String(m.giftWish || '') + '|' + String(m.giftPrice == null ? '' : m.giftPrice); // FIX 2026-09-12 #379 礼物签名误用鲜花字段（flName/flEmoji/flWish 礼物记录里全 undefined）→ 任意两件礼物签名恒等，60s 窗口内第二件被当重复删＝「连续送心愿单礼物第一件之外全闪一下就消失」；改用礼物自己的字段（dish 菜肴同理），不同礼物签名必然不同
else if (sp === 'dish') extra = String(m.dishName || '') + '|' + String(m.dishEmoji || '') + '|' + String(m.dishWish || '') + '|' + String(m.dishPrice == null ? '' : m.dishPrice); // FIX #379 同上：菜肴消息字段与鲜花不同，此前也恒等签名
else if (sp === 'flower') extra = String(m.flName || '') + '|' + String(m.flEmoji || '') + '|' + String(m.flWish || '');
} catch (e) {}
const normT = (m.type === 'text' || !m.type) ? '' : String(m.type || '');
// #256：x 跨形式归一——令牌化竞态下同一内容一处 @@m:令牌、一处 data:base64，
// 直比不等＝相邻重复漏判。池令牌内容寻址，展开即原数据；池未热载 expand null 时
// 回退原文（退化为旧行为，不引入误判）。
// FIX 2026-09-16 #594：跨形态归一收口到 mediaFormText（原先只展开「整串令牌」，
// 语音的「名称|||令牌」形态漏判；与合并签名/实时去重共用同一函数＝三处口径不再分叉）
const x = mediaFormText(m.text);
return JSON.stringify({ s: m.side || '', t: normT, sp: sp, x: x, im: !!m.img, vc: !!m.voice, e: extra });
}
// FIX 2026-09-15 #511 进聊天气泡「先变 2 条再恢复」（用户：桌面点开【聊天】进页面，
// 联系人最新一条莫名其妙变成 2 个，然后又恢复正常）：
// LS 快照与内存 msgs 的合并签名原只比 ts|side|原文前 64 字符——同一逻辑消息在 LS 侧是
// 原始 base64、内存侧已令牌化（#256 令牌竞态）⇒ 原文不等 ⇒ 判成两条 ⇒ 首帧渲染出 2 个气泡；
// 随后后台归一化 collapseRapidDups/normCollapseRange 用 dupSig（会展开媒体令牌）判相邻
// 重复又把它合并回 1，用户看到的正是「变 2 个 → 又恢复正常」。
// 收口：合并签名与 dupSig 同口径（展开媒体令牌 + 计入 special/type），两处合并点共用本函数
// （mergeLsSnapshotWith 写快照、loadMsgs 读快照回并内存，任一处口径不齐都会在 LS 里留下两份）。
// 取「长度 + 前 96 字符」而非整串：媒体原文可达数百 KB，整串进 Set 哈希会让进聊天白白烧 CPU；
// 长度+头部随内容变化，对「跨形式同一条」判别力足够（池未热载 expand 返回 null 时退化为旧行为，不误判）。
function lsMergeSig(m) {
if (!m) return '';
// FIX 2026-09-16 #594：展开逻辑收口到 mediaFormText（同一入口，#511 的「整串令牌」口径
// 加上语音「名称|||令牌」形态，与 dupSig/sigOf 完全同源）
const x = mediaFormText(m.text);
return ((m.ts || 0) + '|' + (m.side || '') + '|' + (m.special || '') + '|' + (m.type || '') + '|' + x.length + '|' + x.slice(0, 96));
}
try { window.__lsMergeSig = lsMergeSig; } catch (e) {} // 回归脚本可测性出口（只读纯函数）
function collapseRapidDups(arr) {
let removed = 0;
for (let i = arr.length - 1; i > 0; i--) {
const a = arr[i], b = arr[i - 1];
if (!a || !b || !a.side || a.side !== b.side) continue;
if (dupSig(a) !== dupSig(b)) continue;
const hasContent = (a.text && a.text.length) || a.img || a.voice || !!a.special || (a.parts && a.parts.length);
if (!hasContent) continue;
const dts = (a.ts || 0) - (b.ts || 0);
if (dts < 0 || dts > dupGapMs(a)) continue;
arr.splice(i, 1);
removed++;
}
return removed;
}
// ===== FIX 2026-09-18 #776 聊天「一条变多条」第三通道：身份级重复（现有判据全看不见的那一类）=====
// 本项目每条消息的 ts 都是 `Date.now()` 现取的毫秒值，落点 side 只有 in/out 两值 ⇒
// 「ts 与 side 都相同」的两条记录按定义就是**同一条消息的两份副本**，不可能是两次发送
// （真人连发同文本也撞不进同一毫秒）。这与 dupSig/lsMergeSig 那套「正文签名」判据是**互补**
// 关系而非重复：正文签名只认「内容也一样」的副本，而所有回放通道（尾巴日志 #180、增量日志
// chat-arch #127、LS 有损快照 #358、分块热片 #722）带回来的副本恰恰**正文不等**——
//   · 库内那条已被 normCell 原地换脸/改名清扫/媒体令牌化（#749 在尾巴链上修过的同一件事，
//     增量日志与快照合并这两处仍按正文判 ⇒ 漏）；
//   · 快照那条被剥掉 img/voice（有损副本，img:'' vs dataURL ⇒ sigOf 不等）。
// 判不出＝补回一份 ⇒ 屏上两条 ⇒ 落盘固化 ⇒「刷新还在、越用越多」。#766 关掉的是尾巴日志的
// 长期驻留，本条关掉的是「正文形态漂移让副本认不出原件」这个更普遍的判别缺口，并顺带**自愈
// 存量脏数据**（前几版已写进库的重复对，用户现在打开聊天就该看到它们消失，而不是留着）。
// 保留哪一份：按信息完整度浅估保更全的那条（有损副本/半截正文不留），另一条删除。
function chatRecIdKey(m) {
if (!m) return '';
const t = m.ts;
if (typeof t !== 'number' || !(t > 0)) return ''; // 无 ts 的记录不参与身份判定（防「0|side」互撞误删）
return t + '|' + (m.side || '');
}
// 类型级身份键：ts+side 之上再钉 special/type。**只到 ts+side 是不够的**——批量发送
// （sendBatchItem，聊天输入栏「批量」一次发多张图/多条文本）是在同一个同步循环里逐条 addRec，
// ts 全等于同一毫秒、side 全是 out，那是用户真发了 N 条。补上 special/type 后仍需下一级
// 正文判定（chatRecCopyKey），因为批量里「同类型多条」正是那种形态。
function chatRecKindKey(m) {
const k = chatRecIdKey(m);
if (!k) return '';
const normT = (m.type === 'text' || !m.type) ? '' : String(m.type || '');
return k + '|' + (m.special || '') + '|' + normT;
}
// 松散正文签名：与 dupSig 同族但**忽略媒体在场与存法**（img/voice 有无、令牌 vs 原文 vs 被剥空）
// ——这正是「同一条消息的两份副本」最常见的差异（LS 有损快照把 img 剥成空串、#142 令牌化把原文
// 换成 @@m: 令牌）。正文段走 mediaSigPart（展开令牌 + 长串只取长度与前 96 字符，与 #511/#594 同口径）。
function chatRecLooseSig(m) {
if (!m) return '';
try {
const normT = (m.type === 'text' || !m.type) ? '' : String(m.type || '');
let ps = '';
if (Array.isArray(m.parts) && m.parts.length) {
ps = m.parts.map(function (p) { return (p && p.k ? p.k : '') + ':' + mediaSigPart(p && p.v).slice(0, 24); }).join(',');
}
return JSON.stringify({ s: m.side || '', t: normT, sp: m.special || '', x: mediaSigPart(m.text), ps: ps });
} catch (e) { return ''; }
}
// 两条记录是否互为副本＝同一条消息被存/投了两份。判据（宁漏不误删）：①ts+side+special+type
// 同一身份；②在此前提下「松散正文签名相同」（忽略媒体在场与存法）**或**「出生号 uid 相同」。
// 五个落盘/回放闸门（实时 addRec、LS 快照写侧 mergeLsSnapshotWith、读侧 localNew、
// chat-arch 增量合并、后台归一化）共用本口径。合法情形逐项核对过：真人连发同文本＝不同毫秒
// （①分开）；批量一次发多张图＝同毫秒但正文不同且各带各自出生号（②两条判据都分开）；
// 异侧同文＝side 不同（①分开）。
//   ① 松散正文键——历史库里没有 uid 的存量记录只能靠正文认亲；
//   ② uid 键——addRec 给每条消息打的出生号（见 chatRecStampUid）。有了它，「同一条消息
//      被原地改过正文」（normCell 换脸/改名清扫/媒体令牌化）这一类副本才**仍然认得出**：
//      正文已经不等，松散签名自然对不上，但出生号是随对象一起落库的，克隆回来一模一样。
//      R6-B 实测就是这个形态：同 ts 同 side，一条 '旧形态'、一条 '新形态（正文已被原地改写）'，
//      五条闸门全部漏过 → 屏上两条 → 落盘固化 →「刷新还在、越用越多」。
// 为什么不删掉①只用 uid：存量数据没有 uid，判据一换就全漏。为什么 uid 键要带 kindKey 前缀：
// 万一出生号因异常撞号，也只可能误伤「同一毫秒同侧同类型」，而那恰好是同一条消息的定义。
function chatRecCopyKeys(m) {
const out = [];
const k = chatRecKindKey(m);
if (!k) return out;
const s = chatRecLooseSig(m);
if (s) out.push(k + '|' + s);
if (m && typeof m.uid === 'string' && m.uid) out.push(k + '#u' + m.uid);
return out;
}
// 登记/查库两个方向各一个入口（闸门统一走这两个，避免又一处口径分叉）
function chatRecKeysAdd(set, m) {
const a = chatRecCopyKeys(m);
for (let i = 0; i < a.length; i++) set.add(a[i]);
return set;
}
function chatRecKeysHit(set, m) {
const a = chatRecCopyKeys(m);
for (let i = 0; i < a.length; i++) if (set.has(a[i])) return true;
return false;
}
// 出生号：本会话随机盐 + ts 的 36 进制 + 自增序（同一毫秒连发的批量/多字卡各得一个，互不相同）。
// 盐是必需的：命中同一 uid＝按定义判为同一条消息并删一份，若两次页面加载各自从 seq=1 重新数起、
// 又恰好落在同一毫秒，就会跨会话撞号、把两条真消息并成一条。
// 只在新消息进 msgs 时打（addRec）；从库里读出来的记录不补号——补了就成了「两条各自独立的
// 新消息」，反而把该认的亲认掉了。
const _recUidSalt = Math.random().toString(36).slice(2, 10);
let _recUidSeq = 0;
function chatRecStampUid(rec) {
if (!rec || typeof rec !== 'object' || rec.uid) return;
try {
const t = (typeof rec.ts === 'number' && rec.ts > 0) ? rec.ts : Date.now();
rec.uid = _recUidSalt + '-' + t.toString(36) + '-' + (++_recUidSeq).toString(36);
} catch (e) {}
}
function chatRecIdScore(m) {
if (!m) return -1;
let s = 0;
try {
if (typeof m.text === 'string') s += m.text.length;
if (typeof m.img === 'string') s += m.img.length ? 1000 + m.img.length : 0;
if (typeof m.voice === 'string') s += m.voice.length ? 1000 + m.voice.length : 0;
if (Array.isArray(m.parts) && m.parts.length) s += 2000 * m.parts.length;
if (m.special) s += 500;
if (m.askQuestion || m.choiceQuestion || m.curiousQuestion || m.roastText || m.inviteContent) s += 300;
if (m.retracted) s -= 400; // 撤回态比原文更弱：优先保留未撤回的那份
} catch (e) {}
return s;
}
// 两条记录是否共享任一副本键（松散正文键 / uid 键）
function chatRecKeysShare(a, b) {
const ka = chatRecCopyKeys(a);
if (!ka.length) return false;
const kb = chatRecCopyKeys(b);
if (!kb.length) return false;
for (let i = 0; i < ka.length; i++) for (let j = 0; j < kb.length; j++) if (ka[i] === kb[j]) return true;
return false;
}
// FIX 2026-09-19 #796：卡片族「跨毫秒双派发」闩的指纹补长。礼物/红包等 special 卡正文为空
//（身份在 giftId/rpAmount 等专用字段上），裸松散签名分不开「同侧同类型的不同卡」；把卡片
// 身份字段拼进指纹——同一手势的双派发克隆全等，不同卡各不相同。
function chatRecCardExtra(m) {
if (!m) return '';
let s = '';
try {
if (m.giftId != null) s += '|G' + m.giftId;
if (m.giftName) s += '|N' + m.giftName;
if (m.rpAmount != null) s += '|A' + m.rpAmount;
if (m.rpWish) s += '|W' + m.rpWish;
if (m.flName) s += '|F' + m.flName;
if (m.flEmoji) s += '|E' + m.flEmoji;
if (m.inviteContent) s += '|I' + m.inviteContent;
if (m.askQuestion) s += '|Q' + m.askQuestion;
if (m.askFen != null) s += '|K' + m.askFen;
if (m.dishName) s += '|D' + m.dishName;
} catch (e) {}
return s;
}
// 按块运行的身份收敛（后台归一化 tick 调用，跨块共享 seen）：命中同身份的副本即删掉「信息更少」
// 的那一份、另一份留在原位（只产生一次删除，DOM 侧走 #675 原位收敛，不必整窗重建）。
// seen 登记的是下标，本块内一旦发生删除就会左移漂移 ⇒ 用前必校验「该下标此刻仍装着同一身份」，
// 不符则重新登记（宁可这轮漏收、下一轮再收，绝不错删真消息）。
function collapseIdentityRange(from, to, seen) {
let removed = 0;
try {
if (!seen || typeof seen.set !== 'function') return 0;
const n = msgs.length;
const drop = new Set();
for (let i = from; i < to && i < n; i++) {
const m = msgs[i];
if (!m || drop.has(i)) continue;
const ks = chatRecCopyKeys(m);
if (!ks.length) continue;
let j;
for (let q = 0; q < ks.length; q++) {
const v = seen.get(ks[q]);
if (v !== undefined && v !== i && !drop.has(v)) { j = v; break; }
}
if (j === undefined) { for (let q = 0; q < ks.length; q++) seen.set(ks[q], i); continue; }
const other = msgs[j];
if (!other || !chatRecKeysShare(other, m)) { // 下标漂移（本块删过东西）＝重新登记，绝不删
for (let q = 0; q < ks.length; q++) seen.set(ks[q], i);
continue;
}
const keep = chatRecIdScore(m) > chatRecIdScore(other) ? i : j;
const lose = keep === i ? j : i;
try { if (normRemovedRecs) normRemovedRecs.push(msgs[lose]); } catch (e) {}
drop.add(lose);
const kk = chatRecCopyKeys(msgs[keep]); // 幸存者的全部键指向它（第三份副本照此与它比）
for (let q = 0; q < kk.length; q++) seen.set(kk[q], keep);
removed++;
}
const idx = Array.from(drop).sort((a, b) => a - b);
for (let d = idx.length - 1; d >= 0; d--) msgs.splice(idx[d], 1);
} catch (e) {}
return removed;
}
// FIX 2026-09-18 #776 诊断探针：重复体检。报障「一条变多条」时，光看条数说不出**还剩哪一种重复**，
// 每轮都要重新猜通道。本探针按身份键（ts+side+special+type，见 chatRecKindKey）分组，把多出来的副本分成四类报出来：
//   batch＝两条各带**不同**出生号（addRec 逐条打号，同毫秒批量发送就是这个形状）→ 不是重复；
//   same＝正文/媒体形态一致（现有正文判据收得掉，出现＝收敛没跑或没回写）；
//   uidc＝正文已不等但出生号相同（normCell 换脸/改名清扫/媒体令牌化原地改过正文）→ 认得出、收得掉；
//   drift＝正文已不等且无出生号可认（升级前写的存量脏数据，宁漏不误删所以留在库里）。
//   sus＝same+uidc+drift＝真正待修份数（drift>0 说明库里还有升级前的脏副本）。
// 只读、单遍、绝不抛（诊断面板在谁手上都不能因为体检本身把页面搞挂）。
window.__mochiDupCensus = function () {
try {
const byId = new Map();
let uidN = 0;
for (let i = 0; i < msgs.length; i++) {
const m = msgs[i];
if (!m) continue;
if (m.uid) uidN++;
const k = chatRecKindKey(m); // 裸 ts|side 不够：同一毫秒同侧投两张不同卡（ask-msg + ask-curious）是常态
if (!k) continue;
const g = byId.get(k);
if (g) g.push(m); else byId.set(k, [m]);
}
let groups = 0, extra = 0, same = 0, uidc = 0, drift = 0, batch = 0;
const eg = [];
const head = function (m) {
const t = String((m && m.text) || '').slice(0, 18);
return t || ((m && (m.special || m.type)) ? String(m.special || m.type) : '(空)');
};
const kinds = {};
byId.forEach(function (g) {
if (!g || g.length < 2) return;
groups++;
extra += g.length - 1;
for (let i = 1; i < g.length; i++) {
const a = g[0], b = g[i];
const ua = (typeof a.uid === 'string' && a.uid) ? a.uid : '';
const ub = (typeof b.uid === 'string' && b.uid) ? b.uid : '';
if (ua && ub && ua !== ub) { batch++; continue; } // 各带出生号＝同毫秒批量，不是副本
if (chatRecLooseSig(a) && chatRecLooseSig(a) === chatRecLooseSig(b)) same++;
else if (ua && ua === ub) uidc++;
else drift++;
if (eg.length < 3) eg.push((a.side || '?') + ':' + head(a) + ' ⟂ ' + head(b));
}
const kk = (g[0].special || g[0].type || 'text') + '×' + g.length;
kinds[kk] = (kinds[kk] || 0) + 1;
});
let top = '';
try {
top = Object.keys(kinds).sort(function (a, b) { return kinds[b] - kinds[a]; }).slice(0, 3)
.map(function (k) { return k + '(' + kinds[k] + '组)'; }).join(' ');
} catch (e) {}
return { total: msgs.length, groups: groups, extra: extra, same: same, uidc: uidc, drift: drift, batch: batch, sus: same + uidc + drift, uid: uidN, top: top, eg: eg };
} catch (e) { return { err: String(e) }; }
};
function answeredRec(r) {
if (!r) return false;
if (r.special === 'ask-choose' && r.choiceStatus === 'answered') return true;
if (r.special === 'ask-curious' && r.curiousStatus === 'answered') return true;
if (r.special === 'ask-roast' && r.roastStatus === 'answered') return true;
if (r.special === 'ask-card' && r.askStatus === 'answered') return true;
if (r.special === 'invite' && r.inviteStatus === 'answered') return true;
return false;
}
// FIX 2026-09-21 #952：同桌面的权威读库链在飞去重——「此间【去找TA】切桌面进聊天」这类
//   一次点击内先 setActiveContact（contact-switched 预读）再 enterChat（进页 loadMsgs）的路径，
//   会对刚激活的同一命名空间并发跑两条完整读库链：分块热片（2MB×N）读+解析+合并+整窗重建全部
//   ×2，各自失败还各挂一套 5s 重试与 LS 快照重写。低端机/大历史上主线程被打满后 IDB 回调与
//   定时器被饿死→读取超时 undefined→再触发重试＝恶性循环，「正在加载聊天记录」反复出现、
//   消息区反复清空重建、长时间卡顿（无头 20× 节流 + 8.5MB 分块历史实证：读库链×2、整窗重建
//   400→0→200→400 反复多轮、chatScrollMax 强制回流占 CPU 采样 ~10s/20s）。普通进聊天只有
//   一条链不受影响。去重窗口有墙（12s），链收尾（成功/空库/非数组）会提前清；scheduleIdbRetry
//   改走 loadMsgs(true)（forceIdb 天然绕过去重）＝读库真失败的重试永不被本闸吞掉。
let _lmChainBusy = null;
let _lmChainBusyUntil = 0;
// ===== FIX 2026-09-28 #1360 大键整包读「等待窗到点」不等于「这一发没读出来」
// 现场（OPPO K13 Turbo Pro／Edge 153 桌面 PWA，IDB default:chat-msgs=102MB、localStorage 只剩
// 2.2MB 有损尾巴、诊断「本页被系统回收过 59 次」）：idbGet 的窗（#716 已放大到 60s）到点后只
// resolve(undefined) 并把这一发真读**丢弃**，而内核其实还在反序列化它。于是①上层每 5~15s 的重试
// 各发一整包重读（同一份 102MB 读第二遍、第三遍＝堆尖峰，看着就是「卡＋被回收」）、②屏上长期
// 只剩那条尾巴（＝「记录一天比一天少」）、③#722 的分块迁移只挂在「整包读成功」那一条路上＝包
// 越大越读不成、读不成永远分不了块＝永久锁死。
// 收口＝同一把键只要有还挂在内核里的一发，就等它落地，绝不另起第二发；晚到但读成的那份照样走
// 原来那条权威合并/守卫/迁移链。判据只问「这一发完成没有」，零机型／零 UA 分支。
let chatLateReadKey = null;
// 在飞标记：这一桌的整包读「已经交给内核了」（含被等待窗放弃、内核还在反序列化的那一发）。
// 旧行为＝窗一到点结果被丢掉、上层每 5~15s 再发一整包，102MB 级历史在同一场里被读第二遍第三遍
// （＝堆尖峰、＝页面被系统回收，＝诊断里「本页被系统回收过 59 次」那一行）；而 #722 的分块迁移
// 又只挂在「整包读成功」这一条路上＝包越大越读不成、读不成永远分不了块＝永久锁死。
// 有了这个标记：同一把键在飞期间进来的读（含 forceIdb 的重试与看门狗）一律让路，等那一发落地。
// 有墙：内核那一发最迟在 idb.js 的天花板（180s）落地或被判死，标记过期后照常允许新读＝不会永久锁。
let chatWholeReadKey = null;
let chatWholeReadAt = 0;
const CHAT_WHOLE_READ_LIVE_MAX = 200000;
function chatWholeReadSettle(key) { if (chatWholeReadKey === key) { chatWholeReadKey = null; chatWholeReadAt = 0; } }
function chatLateClear(key) { if (chatLateReadKey === key) chatLateReadKey = null; }
// 起一发「等得起」的大键读：这一把键只要有还挂在内核里的一发（哪怕它的等待窗早就到点了），
// 就附议等它落地，绝不再另起第二发——旧行为＝每 5~15s 的重试各发一整包重读。
function chatReadAwaitable(key, startRead) {
chatWholeReadKey = key; chatWholeReadAt = Date.now();
const pending = window.idbLateRead ? window.idbLateRead(key) : null;
if (pending) {
chatLateReadKey = key;
return pending.then(function (pv) { chatLateClear(key); chatWholeReadSettle(key); return (pv === undefined || pv === null) ? undefined : pv; },
function () { chatLateClear(key); chatWholeReadSettle(key); return undefined; });
}
return startRead().then(function (v) {
if (v !== undefined && v !== null) { chatLateClear(key); chatWholeReadSettle(key); return v; }
const late = window.idbLateRead ? window.idbLateRead(key) : null;
if (!late) { chatWholeReadSettle(key); return v; }
chatLateReadKey = key;
return late.then(function (lv) { chatLateClear(key); chatWholeReadSettle(key); return (lv === undefined || lv === null) ? v : lv; },
function () { chatLateClear(key); chatWholeReadSettle(key); return v; });
}, function (e) { chatLateClear(key); chatWholeReadSettle(key); return undefined; });
}
function loadMsgs(forceIdb) {
armReadyFuse();
// FIX 2026-09-07 #245：权威未就绪期间照常解析 LS 兜底快照（旧门 !persistTimer&&!msgs.length
// 会被启动期新增双双跳过=首渲缺历史）。配合预权威保存的 mergeLsSnapshotWith（LS 快照不再
// 被会话新消息覆盖），首渲即含完整历史，权威回读走前缀增量/残留原位升级=零整窗重画。
if (!chatDbReady) {
let lsArr = [];
try { lsArr = JSON.parse(store.get('chat-msgs') || '[]'); } catch (e) { lsArr = []; }
if (!Array.isArray(lsArr)) lsArr = [];
if (lsArr.length && msgs.length) {
// FIX 2026-09-15 #511 进聊天最新一条「变 2 条再恢复」：合并签名只比 ts|side|原文前64字符，
// 同一逻辑消息 LS=原始 base64、内存=令牌 @@m:（#256 令牌竞态）原文不等→判两条→首帧
// 渲染出 2 个气泡；随后归一化用展开令牌的 dupSig 判相邻重复又合并回 1＝先 2 后 1。
// 签名统一走 lsMergeSig（与 dupSig 同口径：展开媒体令牌 + 含 special/type）——两处合并点
// 共用同一函数，避免「修了读侧、写侧仍按旧口径在 LS 里存两份」的半修。
const seen = new Set(lsArr.map(lsMergeSig));
// FIX 2026-09-16 #594：快照与内存同一条的「媒体两种存法」互补判定（冷池下 expand 不可用，
// 见 recKindCovers 注释）——缺了这一步，快照侧旧形态副本会被当新消息 concat 回来＝消息翻倍
const lsKinds = recKindIndex(lsArr);
const extra = msgs.filter(m => m && !seen.has(lsMergeSig(m)) && !recKindCovers(lsKinds, m));
msgs = lsArr.concat(extra).sort((a, b) => (((a && a.ts) || 0) - ((b && b.ts) || 0)));
} else if (lsArr.length) {
msgs = lsArr;
}
try { syncLastMineText(); } catch (e) {}
}
// v3.26.x：全量 migration/去重 pass 移到 runDeferredNormalization 后台分批跑，防大数据主线程卡死
const nowT = Date.now();
const skipRead = chatDbReady &&
lastIdbLoadPrefix === window.activePrefix() &&
nowT - lastIdbLoadAt < IDB_RELOAD_MIN_GAP &&
!forceIdb;
if (!skipRead) {
try {
if (window.idbGet) {
const myPrefix = window.activePrefix();
// FIX 2026-09-21 #952：同桌面读库链在飞去重（见 _lmChainBusy 声明处注释）——
//   forceIdb（重试/显式强读）不受本闸限制；墙=12s，读库链若真死也有重试与保险丝兜底。
if (!forceIdb && _lmChainBusy === myPrefix && Date.now() < _lmChainBusyUntil) return;
// #1360：这一桌的整包读已经在内核里跑（哪怕它的等待窗早就到点、上层已经当成读不到在重试）＝
// 本次一律让路，不再另起第二发整包重读。forceIdb（5s 重试／15s 看门狗／保险丝补挂）也照让——
// 旧行为正是「每一发都超时、每一发都重读 102MB」；标记有墙（见 CHAT_WHOLE_READ_LIVE_MAX），
// 那一发最迟在 idb.js 的天花板上落地或判死，过期后照常允许新读＝不会永远读不到。
const _pkgKey = myPrefix + ':chat-msgs';
if (chatWholeReadKey === _pkgKey && Date.now() - chatWholeReadAt < CHAT_WHOLE_READ_LIVE_MAX) return;
_lmChainBusy = myPrefix;
_lmChainBusyUntil = Date.now() + 12000;
chatAuthPending = true; // #967：本条链起读＝权威未达（进度条据此保持，"数据到没到"不再由保险丝冒充）
armChatAuthWatch(); // #967：链一起就给看门狗兜底（快重试被打断/饿死时仍有慢重试）
// v3.26.x #90：先补读条数账本（小键，几乎不会超时）。大键读取失败时它是唯一
// 能回答「库里到底有多少条」的依据，落盘守卫全靠它。
try { chatLedgerLoad(myPrefix); } catch (e) {}
// #716：按账本字节放大本次读取的等待窗——idbGet 默认 4s+4s，41MB 级历史在手机上
// 单次读取+反序列化就超 8s ⇒ 每次尝试都超时=undefined → 重试 6 次每次重读 41MB 全失败
// ＝「正在加载聊天记录」挂很久也进不去（红米 K80 default:chat-msgs=41.2MB 实报）。
// 口径同写入侧 idbSetAll（+2000/256KB）：2000ms/MB、上限 +28s、总上限 60s。
let bigReadMs = 0;
try {
const lb = chatLedgerBytes[myPrefix];
if (typeof lb === 'number' && lb > 2 * 1024 * 1024) bigReadMs = 4000 + Math.min(28000, Math.ceil(lb / 1048576) * 2000);
} catch (e0) {}
// #722 分块格式门：blk-idx 在位＝大历史已分块，只读末尾热片（~2MB）喂进下方同一条
// 权威合并/守卫/渲染链（chatBlkHotLoad 返回热片数组当 v；块读失败返回 null＝按读失败重试，
// 绝不当空库），不再整读 41MB 级基准包。索引不在位＝旧整包格式，走原路径一字不变。
let bidxP = null;
if (!forceIdb) { const ci954 = chatHotCacheGet(myPrefix + ':chat-blk-idx'); if (typeof ci954 === 'string') bidxP = Promise.resolve(ci954); } // #954：索引缓存命中
if (!bidxP) bidxP = window.idbGet(myPrefix + ':chat-blk-idx').then(function (raw954) {
if (raw954 && typeof raw954 === 'string' && raw954.indexOf('"v"') >= 0) chatHotCacheSet(myPrefix + ':chat-blk-idx', raw954); // #954：索引真读成功回填缓存
return raw954;
});
bidxP.then(function (bidxRaw) {
if (window.activePrefix() !== myPrefix) return null;
if (bidxRaw && typeof bidxRaw === 'string' && bidxRaw.indexOf('"v"') >= 0) {
return chatBlkHotLoad(myPrefix, bidxRaw, !!forceIdb);
}
return chatReadAwaitable(myPrefix + ':chat-msgs', function () {
return window.idbGet(myPrefix + ':chat-msgs', bigReadMs > 4000 ? { minWaitMs: bigReadMs } : undefined);
});
}).then(v => {
if (window.activePrefix() !== myPrefix) return;
if (v === undefined || v === null) {
// v3.14.x：先区分「键确实不存在」与「读取失败/超时」——idbGet 超时兜底也
// resolve undefined，真机切桌面并发抢事务时大键读取超时并不罕见；若当"无权威"
// 会置 ready 并用内存/LS 有损快照覆盖 IDB = 全部历史被清。
// v3.26.x #90：复核改走 idb.js 的严格三态探测 idbHasKey（true 存在/false 确认没有/
// null 没读到）。原 idbGetAllKeys 在超时、挂起时 resolve 空数组，与「确认空库」
// 不可区分 → 读取失败被当成「这个桌面没有历史」，置 authLoadedPrefix 放开整包落盘
// → 发一条消息即把全部历史覆盖成一条（诊断实证：小米 14U Edge，LS 已废无第二副本）。
// 现在只有 has === false 才认「无历史」；null 与 true 一律按读取失败处理。
const idbKey = myPrefix + ':chat-msgs';
// FIX 2026-09-17 #127：「确认空库」必须把增量日志键一起算进去——只认 chat-msgs 会把
// 「基准包读超时（undefined）但日志在」误判成空库，随后 LS 有损快照晋升覆盖整段历史。
const idbArchKey = myPrefix + ':chat-arch';
// #1360：「这个桌面没有历史」这句话必须由**全部三种存法**一起作证。#722 之后大历史既不存
// chat-msgs 也不存 chat-arch（整包被删、改住 chat-blk-idx + chat-blk-<seq>），而这里原来只问
// 前两个 ⇒ 分块桌面的热片一旦读不成（块键值 2MB 级、内核慢就超时＝chatBlkHotLoad 返回 null，
// 与「读空」在旧判据里同形），三个条件全票通过＝当场确认空库 → 把内存里那条尾巴当权威整包
// 写回 IDB、并把账本对齐成尾巴条数（无头实测：库里 900 条、一场之内被写成 2 条＋账本 n=2）。
const idbIdxKey = myPrefix + ':chat-blk-idx';
const confirmMiss = window.idbHasKey
? Promise.all([window.idbHasKey(idbKey), window.idbHasKey(idbArchKey), window.idbHasKey(idbIdxKey)]).then(function (r) { return r[0] === false && r[1] === false && r[2] === false; })
: (window.idbGetAllKeys
? window.idbGetAllKeys().then(function (keys) {
return !(keys || []).some(function (k) { return k === idbKey || k === idbArchKey || k === idbIdxKey; });
}).catch(function () { return false; })
: Promise.resolve(true));
confirmMiss.then(function (isMiss) {
if (window.activePrefix() !== myPrefix) return;
if (!isMiss) { scheduleIdbRetry(); return; }
// FIX 2026-09-07 #245：账本矛盾守卫——账本 n>0（#90 账本=「库里到底有多少条」的唯一
// 小键依据）与「确认空库」矛盾＝探测在冷启动窗口说了谎（无头实证：键存在仍进本分支，
// 随后 LS 会话快照被当唯一历史回写 IDB=历史被顶掉；权威收尾缺历史=真机「闪+弹后恢复」，
// 「恢复」全靠相邻重复归一化兜底）。账本说有历史就按读取失败走重试，绝不进空库分支。
let _ledN = 0;
try { _ledN = chatLedger[myPrefix] || 0; } catch (e) {}
if (_ledN > 0) { scheduleIdbRetry(); return; }
// FIX 2026-09-15 #526：账本 0 + 首轮探测确认 miss ＝ 这个桌面没有历史可读。立刻收起
//   「正在加载聊天记录…」，否则要白等下面 2.5s 空库二次复核才隐藏（新建联系人首次进
//   聊天必现的进度条就出在这里）。真有历史的桌面走上面 _ledN>0 / 有数据分支，不受影响。
chatKnownEmpty = true;
try { updateChatLoading(); } catch (e) {}
// FIX 2026-09-12 #358 空库二次复核（账本缺失时的最后防线）：TASKS #133 探测层在冷启动
// 早期窗口对已存在的键会同时谎报 idbGet undefined + idbHasKey false，账本缺失（chat-meta
// 未写入/读取失败）时上面的矛盾守卫失效——单次探测说「空库」就把 LS 有损快照（折半弃旧，
// 只有尾部）晋升为权威＝老历史永久被顶掉（实证：真机诊断 LS 与 IDB chat-msgs 同为 2.2MB）。
// 2.5s 后（避开冷启动争抢窗口）hasKey+idbGet 双复核，任一翻案都按读取失败重试；
// 两次都确认没有才进空库分支。
setTimeout(function () {
try { if (window.activePrefix() !== myPrefix) return; } catch (e) {}
const reprobe = window.idbHasKey
? Promise.all([window.idbHasKey(idbKey), window.idbHasKey(idbArchKey), window.idbHasKey(idbIdxKey)]).then(function (r) { return (r[0] === true || r[1] === true || r[2] === true) ? true : null; })
: Promise.resolve(null);
Promise.resolve(reprobe).then(function (has2) {
try { if (window.activePrefix() !== myPrefix) return; } catch (e) {}
if (has2 === true) { scheduleIdbRetry(); return; }
window.idbGet(idbKey).then(function (v2) {
try { if (window.activePrefix() !== myPrefix) return; } catch (e) {}
if (v2 !== undefined && v2 !== null) { scheduleIdbRetry(); return; }
window.idbGet(idbArchKey).then(function (v3) {
try { if (window.activePrefix() !== myPrefix) return; } catch (e) {}
if (v3 !== undefined && v3 !== null) { scheduleIdbRetry(); return; }
// #1360：二次复核同样要把分块索引当证人——hasKey 说「在」而 idbGet 说「读不到」＝内核在忙，
// 更不是「这个桌面没有历史」。
window.idbGet(idbIdxKey).then(function (v4) {
try { if (window.activePrefix() !== myPrefix) return; } catch (e) {}
if (v4 !== undefined && v4 !== null) { scheduleIdbRetry(); return; }
enterConfirmedEmpty();
}).catch(function () { scheduleIdbRetry(); });
}).catch(function () { scheduleIdbRetry(); });
}).catch(function () { scheduleIdbRetry(); });
}).catch(function () { scheduleIdbRetry(); });
}, 2500);
return;
});
// v3.26.x #88：到达这里＝第一轮探测已确认空库（isMiss false 或已重试），原空库分支
function enterConfirmedEmpty() {
chatDbReady = true;
chatKnownEmpty = true; // FIX 2026-09-15 #526：确认空库＝无历史可读
chatAuthPending = false; // #967：确认空库＝有结论，进度条收起是正确语义
stopChatAuthWatch(); // #967：空库＝读库有结论，看门狗下班
idbRetryCount = 0;
_lmChainBusy = null; // #952：空库确认收尾，放行后续 loadMsgs
authLoadedPrefix = myPrefix;
chatArchClearBaseline(); // FIX 2026-09-17 #127：空库无基准段
try { syncLastMineText(); } catch (e) {}
const lsRaw = store.get('chat-msgs');
if (lsRaw) {
try {
const lsArr = JSON.parse(lsRaw);
if (Array.isArray(lsArr) && lsArr.length) {
if (window.idbSet) window.idbSet(myPrefix + ':chat-msgs', lsRaw);
}
} catch (e) {}
}
if (pendingLocal && pendingLocal.length) {
msgs = pendingLocal.concat(msgs.filter(m => !pendingLocal.some(p => p && p.ts === m.ts && p.text === m.text)));
pendingLocal = null;
try { if (window.idbSet) persistChatHistory(myPrefix, msgs, true); } catch (e) {}
writeLsSnapshot(msgs, myPrefix, true);
}
// #90：已确认库里没有 chat-msgs，账本随之对齐真实状态（过期的高账本不该再拦正常保存）
try { chatLedgerSave(myPrefix, (msgs && msgs.length) || 0, msgsBytes(msgs)); } catch (e) {}
try { chatTailMerge(myPrefix); } catch (e) {} // #180：确认空库也回放尾巴日志（本会话/上次会话未落盘部分）；#766 同命名空间才回放
try { updateChatLoading(); } catch (e) {} // FIX 2026-09-15 #526：确认空库后收起进度条
try { scheduleChatPrewarm(myPrefix); } catch (e) {} // #951g 空桌面确认权威落定（无内容可画时函数内自带 msgs 守卫直接不动作）
}
return;
}
try {
__prof('ch0_enter');
let idbArr = typeof v === 'string' ? JSON.parse(v) : v;
__prof('ch1_parsed');
if (!Array.isArray(idbArr)) { // #967：读到不可用形态（脏值/异格式）＝按读失败处理——旧实现只置 ready 就 return，
// 屏上什么都没有却收掉进度条且再无重试（与「读超时」同样的永久空屏）；写盘闸门语义（ready 放开）保持原样。
chatDbReady = true; chatKnownEmpty = false; _lmChainBusy = null; // #952 收尾清在飞标记
scheduleIdbRetry(); return; }
// FIX 2026-09-16 #594（用户报障：切换桌面联系人→打开聊天，所有消息变 2 条再回弹恢复；
// 无头实测精确复现——种 12 条表情包字卡的桌面，切过去开聊天 msgs/DOM 双双变 24，每条
// 一份 @@m: 令牌 + 一份原文 base64 相邻成对）：
// 根因＝权威合并这里的去重签名只比「原文」：LS 兜底快照里同一条是原文 base64、IndexedDB
// 权威副本已令牌化（#142/#256/#283 令牌化竞态，大历史/常用表情包桌面必然命中），原文不等
// ⇒ 判成两条 ⇒ localNew 把快照副本当"新消息"append 回 merged ⇒ msgs = 权威 + 旧形态副本，
// 两边 ts 相同 ⇒ 按 ts 排序后成对相邻 ⇒ 首屏「所有消息都变 2 个」；随后后台归一化
// （dupSig 会展开令牌）按相邻重复把它们合并回 1＝用户看到的「回弹一下恢复正常」；
// 归一化没赶上/未覆盖时更糟：重复被整包落盘固化成真重复。
// 修复：签名与 lsMergeSig/dupSig 同口径，统一走 mediaFormText + mediaSigPart（展开 @@m:
// 令牌与语音尾形态，长 base64 只取长度+前 96 字符，不再整串进 Set）。与 #511 同一族——
// #511 收口了 LS 侧合并（lsMergeSig），权威合并这侧当时漏网，本条补齐＝四处口径同源。
// 媒体「同一条」判定从此只有一处实现，任何一侧被改回原文直比都会重新翻倍（哨兵 #594a~c 守）。
const sigOf = (m) => { try { return JSON.stringify({ t: mediaSigPart(m && m.text), s: m && m.side, ts: m && m.ts, i: (m && m.img) ? mediaSigPart(m.img) : 0 }); } catch (e) { return ''; } };
// FIX 2026-09-17 #127：读增量日志并与基准包拼接后再进入原合并/守卫链（读侧语义不变）。
// 拼接去重：压缩是「先写完整基准包、后删日志」，两步之间崩溃会让日志里的条目已在基准包里。
const ckptArr = idbArr;
window.idbGet(myPrefix + ':chat-arch').then(function (av) {
if (window.activePrefix() !== myPrefix) return;
if (av === undefined || av === null) { try { av = store.get(CHAT_ARCH_KEY); } catch (e) {} } // LS 兜底（旧版/导入曾把日志键落 LS）
try {
let archArr = [];
try { archArr = typeof av === 'string' ? JSON.parse(av) : av; } catch (e) { archArr = []; }
if (!Array.isArray(archArr)) archArr = [];
if (archArr.length) {
const ckptSigs = new Set();
const ckptCopies = new Set(); // FIX 2026-09-18 #776：日志与基准包的拼接只认正文签名 sigOf ⇒ 基准包那条被剥掉媒体/换过存法时，日志里的同一条被当「正文不同的新消息」拼回来＝同一条两份（同 ts），事后任何正文判据都合不掉。副本键忽略媒体在场与存法，专治这一类
for (let ci = 0; ci < ckptArr.length; ci++) { if (ckptArr[ci]) { ckptSigs.add(sigOf(ckptArr[ci])); chatRecKeysAdd(ckptCopies, ckptArr[ci]); } }
archArr = archArr.filter(function (m) { return m && !ckptSigs.has(sigOf(m)) && !chatRecKeysHit(ckptCopies, m); });
if (archArr.length) idbArr = ckptArr.concat(archArr).sort(function (a, b) { return (((a && a.ts) || 0) - ((b && b.ts) || 0)); });
}
} catch (e) {}

const hasLocal = !!((pendingLocal && pendingLocal.length) || (msgs && msgs.length));
let merged, curArr = pendingLocal || msgs || [];
let changed = false;
// v3.26.x OOM：无本地待合并数据时跳过全量签名 Set 构建（旧大数据账号最常见的启动场景）
if (!hasLocal) {
  merged = idbArr;
} else {
  const idbSigs = new Set();
  idbArr.forEach(x => { if (x) idbSigs.add(sigOf(x)); });
  __prof('ch2_sigset');
  const idbTsSide = new Set(idbArr.map(x => (((x && x.ts) || 0) + '|' + ((x && x.side) || ''))));
  const idbCopies = new Set();
  idbArr.forEach(x => chatRecKeysAdd(idbCopies, x));
  __prof('ch3_tsside');
  const liteResidue = (m) => !!(m && (m._lsLite || m.img === '' || m.voice === ''));
  // FIX 2026-09-16 #594：权威侧媒体形态索引——「同一条记录在快照里是原文、在库里是令牌」
  // （令牌化竞态；池冷载时 sigOf 展开不出原文）时，快照副本不得当新消息 append 回来
  const idbKinds = recKindIndex(idbArr);
  __prof('ch3b_kinds');
  const localNew = curArr.filter(m => m && !idbSigs.has(sigOf(m))).filter(m => {
    if (recKindCovers(idbKinds, m)) return false;
    // FIX 2026-09-18 #776：身份闸门从「仅有损残留」扩到任何一条本地记录——库里已有同一条消息的
    // 另一种形态（正文被 normCell 换脸/改名清扫/令牌化后 sigOf 与媒体形态索引都认不出，见
    // chatRecCopyKeys 注释），补回来就是凭空多一份、且事后合不掉。
    // 判据必须是副本键而不是裸 ts+side：批量发送 sendBatchItem 会在同一毫秒同侧连推多条，
    // 那是合法数据，按裸身份砍就会把「哥哥发的三条」并成一条。
    if (chatRecKeysHit(idbCopies, m)) return false;
    if (!liteResidue(m)) return true;
    return !idbTsSide.has((((m && m.ts) || 0)) + '|' + ((m && m.side) || ''));
  });
  localNew.forEach(m => { try { delete m._lsLite; } catch (e) {} });
  merged = idbArr.concat(localNew).sort((a, b) => ((a && a.ts || 0) - (b && b.ts || 0)));
  if (merged.length === curArr.length) {
    curArr.forEach((m, i) => {
      if (!m || i >= merged.length) return;
      if (sessionChangedIdx.has(i)) merged[i] = m;
    });
  }
  curArr.forEach((m, i) => {
    if (!m || i >= merged.length) return;
    if (!answeredRec(m) || answeredRec(merged[i])) return;
    merged[i] = m;
  });
  changed = localNew.length > 0 || merged.length !== msgs.length;
  if (!changed && merged.length === msgs.length && msgs.length) {
    changed = msgs.some(m => m && (m.img === '' || m.voice === ''));
  }
}
msgs = merged;
__prof('ch4_merged');
if (hasLocal && merged.length !== curArr.length) sessionChangedIdx.clear();
// v3.26.x：原同步全量 normalization（collapseRapidDups/migrateLegacyMediaMsgs/
// restoreEscapedPokeIcons/sysNickCatchup/图标迁移/ts 回填）移入后台分批归一化，
// 首屏即时可交互，防大数据 OOM 崩溃。此处仅本次合并产生的 changed 落盘。
try { syncLastMineText(); } catch (e) {}
__prof('ch5_passes');
pendingLocal = null;
chatDbReady = true;
chatKnownEmpty = false; // FIX 2026-09-15 #526：读到权威数据（含空数组）＝不再是「已知空库」，进度条交回常规判定
chatAuthPending = false; // #967：权威到手，进度条交回常规判定
stopChatAuthWatch(); // #967：权威到手＝看门狗下班
// v3.14.x：本命名空间已读到权威（此后空数组落盘才被允许——内存已含全部历史）
authLoadedPrefix = myPrefix;
idbRetryCount = 0;
_lmChainBusy = null; // #952：本桌读库链成功收尾，放行后续 loadMsgs
try { if (chatTailMerge(myPrefix) > 0) changed = true; } catch (e) {} // #180：权威就绪后回放尾巴日志（上次会话未落盘的最近消息）；FIX #407 回放插入=下标位移，并入 changed 走重渲，防屏上 data-idx 陈旧串条；FIX #766 传入 myPrefix＝日志必须与这份 msgs 同命名空间才回放
try { chatDeskInboxMerge(myPrefix); } catch (e) {} // #1200：权威落定后回填跨桌面中转箱（分块桌面整包写不进的两端互通，去重合并＋就地重渲）
try { chatReplyDebtCheck(myPrefix); } catch (e) {} // #1356：上一场「已经应下来、却被回收打断」的那一发回复，这一刻补投（判据＝msgs 自身，零新增存储键）
// v3.26.x #90：账本基线＝刚读到的库内条数（同值不重复落盘，见 chatLedgerSave 节流）
try { chatLedgerSave(myPrefix, chatBlkTotal || idbArr.length, chatBlkTotal ? Math.max(msgsBytes(idbArr), chatLedgerBytes[myPrefix] || 0) : msgsBytes(idbArr)); } catch (e) {} // #722 分块格式：账本记全量条数（热片读时 idbArr 只是尾部，全量条数以 idx.total 为准，缩水守卫才不会误判）
// #722 迁移：旧整包格式的大历史首次读成功后，后台一次性重排成分块格式（此后进聊天只读热片）。
// 延后 15s（避开开屏/进聊天关键窗口）；单飞与失败重试由 chatBlkWriteFull/scheduleIdbRetry 承担。
if (!chatBlkIdx && msgsBytes(idbArr) > CHAT_BLK_MIN) {
setTimeout(function () {
try {
if (window.activePrefix() !== myPrefix || chatBlkIdx || chatBlkWriting) return;
if (Array.isArray(msgs) && msgs.length > 100) chatBlkWriteFull(myPrefix, msgs);
} catch (e) {}
}, 15000);
}
// FIX 2026-09-17 #127：基准段＝本次读到的基准包（不含日志）——此后新消息只写增量日志；
// 基准段一旦被原地改动/增删，chatArchReusable 会拒绝复用并自动整包重写（安全闸）。
try { chatArchSetBaseline(myPrefix, ckptArr); } catch (e) {}
try {
lastIdbLoadPrefix = window.activePrefix();
lastIdbLoadAt = Date.now();
} catch (e) {}
try { localStorage.removeItem('xy-home-v2:chat-msgs'); } catch (e) {}
if (changed) {
__prof('ch6_save');
// FIX 2026-09-17 #127：能复用基准段就只写增量日志（否则整包重写，同旧行为）
try { if (window.idbSet) persistChatHistory(myPrefix, msgs); } catch (e) {}
try { writeLsSnapshot(msgs, myPrefix, true); } catch (e) {}
__prof('ch7_end');
if (chatVisible() && chatNearBottom()) {
// v3.26.x #220：权威数据与屏上快照同窗同貌时原地补丁（不整窗重建=不闪）；
// 条数不同（快照缺尾部）/渲染后台归一化改过窗口/非同桌面 → 照旧整窗重渲
// #1010：收尾这一段（换装 + 屏上媒体解码）全程持有进度条——先置位再动 DOM，
// 落地后由 chatSettleHoldSettle 收（无未解码图＝当场收，行为与旧版一致）
chatSettleHoldArm(); // #1010：权威收尾在飞（换装 + 视口媒体解码）——进度条持有到本段结束
if (!inplacePatchIfSameWindow()) {
renderWindow(false, true);
scrollChatBottom();
}
chatSettleHoldSettle();
} else if (chatVisible()) {
// FIX 2026-09-13 #407：不贴底（用户正在翻历史）时 #220 有意不重渲防闪，但 msgs 已变
// （下标可能位移）——屏上窗口凭据作废，防后续同窗补丁在陈旧 DOM 上误patch；
// 用户可见的菜单动作（引用/收藏/编辑/撤回）已由 resolveActiveMsg 身份重定位兜底
windowStale = true;
}
} else if (chatVisible() && msgs.length && !body.children.length) {
// v3.26.x：冷加载（切桌面后 msgs=[]、无本地待合并，changed=false 原路径不会重渲）——
//   读库完成后聊天页仍开着且消息区为空 → 补渲染一次（同时隐藏加载进度条）
chatSettleHoldArm(); // #1010：冷加载首渲同样走收尾媒体窗
renderWindow(false, true);
scrollChatBottom();
chatSettleHoldSettle();
}
// FIX 2026-09-15 #478（TASKS #131① 真缺陷定性；#480 已让位给并行会话的 tabbar 掉出 .phone 回归）：权威读库成功必须保证 LS 快照存在。
// v3.9 修复3「读库成功写快照」被 OOM 批的 !hasLocal 快路径打掉——冷启动/切联系人（最常见
// 形态）changed 恒 false，快照永不落 LS＝切走再切回遇 IDB 事务挂起（一加/OPPO/真我/荣耀/
// 小米 Edge 实测挂起族）时记录失去唯一兜底副本、整窗不可见（verify-chat-switch-idb-hang
// 3 断言红的根因）。写快照与 changed 解耦：changed 路径维持原同步强写行为零变化；
// 未变更路径延迟一拍补写，不在启动关键路径追加同步 stringify 负担。
if (!changed) {
setTimeout(function () {
try { if (window.activePrefix() === myPrefix) writeLsSnapshot(msgs, myPrefix, true); } catch (e) {}
}, 0);
}
try { updateChatLoading(); } catch (e) {} // #703：权威就绪即收起进度条（覆盖 changed=false 且屏上已有快照内容、不走 renderWindow 的路径）
try { scheduleChatPrewarm(myPrefix); } catch (e) {} // #951e 权威落定：页面还藏着就当场把整窗重建提前做掉，点开聊天不再闪屏
// v3.26.x OOM：旧大数据字符串存量（升级前写入的 chat-msgs 单键字符串）后台一次性
// 转数组直存——此后每次读库免整包 JSON.parse（消除数百 MB 解析尖峰与秒级主线程阻塞）。
// 放在 if(changed) 之外：无本地改动（changed=false）的常见大数据场景也要迁移。
if (typeof v === 'string' && v.length > CHAT_STR_THRESHOLD && idbArr && idbArr.length) {
setTimeout(function () {
// FIX 2026-09-17 #127：字符串存量迁移同样走统一入口（基准段已设好，这里通常整包重写）
try { if (window.activePrefix() === myPrefix && window.idbSet) persistChatHistory(myPrefix, msgs, true); } catch (e) {}
}, 0);
}
// v3.26.x：读库完成后调度后台分批归一化（幂等，仅对当前联系跑一次）
scheduleDeferredNormalization();
// #722：热片渲染完成后稍候推进头部冷块后台取回（getChatMsgs 随时可给全量；用户极快
// 上滑到顶时 loadOlderIncremental 也会主动触发）
try { setTimeout(chatColdEnsureHydrated, 2500); } catch (e) {}
// FIX 2026-09-10 #283 冷启动收敛触发：语音令牌化原只挂在 mochi-restore-done（IDB 整轮
// 挂起时永不到达）与切桌面事件上——只在两事件间使用的设备历史语音永远不被收口。pass 自带
// 权威守卫/WeakSet 去重/幂等，读库成功后延迟跑一次即可覆盖冷启动路径
try { scheduleMediaPass(12000); } catch (e) {}
}); // FIX 2026-09-17 #127：增量日志读取回调收口
} catch (e) { /* 解析失败：不置 chatDbReady，下次进入再重试 */ }
});
}
} catch (e) {}
} // v3.13.x：时间闸跳过全量重读的关闭括号
// v3.26.x：全部全量 migration/去重已移入 runDeferredNormalization 后台分批执行
// （见本文件顶部 OOM 防线注释）。此处兜底：无权威读库（IDB 缺键/读取失败回溯）
// 场景也补一次归一化调度；scheduleDeferredNormalization 按当前联系幂等去重。
if (chatDbReady && msgs.length) scheduleDeferredNormalization();
}
function escTxt(s) {
return String(s == null ? '' : s)
.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// FIX 2026-09-19 #817 连续空格在内容层保护（多空格→等量 &nbsp;）：替代已撤销的气泡正文
// span 全局保留空白 CSS 规则——部分内核（一加自带浏览器实报，多机型同现）对 shrink-to-fit
// 气泡里的预格式化文本把自适应宽误算成最小内容宽，发出消息被压成一字一行竖排。&nbsp; 不折叠、
// 不断行是全内核通用行为；单个空格不动（保留正常断行机会），\n→<br> 语义不变。
function escTxtBr(s) {
return escTxt(s).replace(/ {2,}/g, m => '&nbsp;'.repeat(m.length)).replace(/\n/g, '<br>');
}
// FIX 2026-09-13 #385 媒体池令牌夹在文字中间被当文字直出（乱码："不错 多笑笑吧 @@m:5839…cb87 我不是很适应这个"）
// ——#383 只治「整条 text 就是裸令牌」（normCell 升 type=image）；多字卡回复 pickN.join(' ') 拼出的
// 混合文本消息里令牌嵌在正文中间，type 仍是 text，渲染端 escTxtBr 原样铺出令牌串＝乱码。聊天/群聊
// 公用库共享故多机型全现。这里在消费者边界（气泡渲染）统一把内嵌 @@m:<hash32> 行内转成 <img>，
// 交给 media-pool 文档级观察器解图——无论令牌怎么进 text、存量/新收、哪个机型浏览器都不再直出令牌串。
// 群聊渲染复用（group-chat.js 调 window.mochiInlineTextHtml）；纯令牌整条也走 <img> 是渲染端兜底。
window.mochiInlineTextHtml = function (s) {
s = String(s == null ? '' : s);
// FIX 2026-09-20 #948 内联 dataURL 载荷夹在正文里不再整串直出（同 #385 令路口径）：漏进文字
// 通道的图片/语音载荷在这里统一收成「[图片]/[语音]」标注；整串就是图片引用的形态由调用方
// （renderMsg 文本分支/群聊）按聊天图片渲染，本函数只负责「正文中间夹着载荷」这类混排。
if (s.indexOf('@@m:') < 0 && !chatHasMediaPayload(s)) return escTxtBr(s);
// 不带 i 标志＝令牌分支保持小写严格（大写伪令牌按文本转义，见下方形态判定）；data: 分支用显式
// 大小写字符类，与判据一样对 MIME 大小写不敏感——载荷形态由内核给出，不能赌它小写。
// FIX 2026-09-20 #948h MIME 段改为可选（"data:;base64,…" 无 MIME 载荷同样要在这里被切开收标注，
// 否则整串 base64 走 else 分支原样铺出＝本批主诉乱码的无 MIME 来路）。
const _t = s.split(/(@@m:[0-9a-f]{32}|[Dd][Aa][Tt][Aa]:[a-zA-Z0-9.+-]*(?:\/[a-zA-Z0-9.+-]+)?(?:;[^,]*)?,[A-Za-z0-9+/=]*)/g), _tt = [];
for (let _i = 0; _i < _t.length; _i++) {
const _p = _t[_i];
if (/^@@m:[0-9a-f]{32}$/.test(_p)) {
_tt.push('<img class="msg-inline-tok" src="' + _p + '" alt="" loading="lazy" decoding="async">');
} else if (chatIsDataImgSrc(_p)) { _tt.push(escTxtBr('[图片]')); }
else if (chatIsDataAudioSrc(_p)) { _tt.push(escTxtBr('[语音]')); }
else if (chatIsInlineDataSrc(_p)) { _tt.push(escTxtBr('[附件]')); } // 内核给的非图非音载荷（octet-stream 等）
else { _tt.push(escTxtBr(_p)); }
}
return _tt.join('');
};
// FIX 2026-09-17 #648 互动卡「TA：」回应行清洗（#383 令牌直出家族的存量治愈层）——
// #554/#632 全库令牌化不分分类，历史上被抽进 互动回应/查岗 等功能池的媒体卡（@@m: 令牌 /
// 「名称|||data:」语音 / 裸图片直链）已随 rec.askReply/choiceReply/curiousReply/roastReply
// 落库；来源侧守卫（getCustomFuncCards #648a / pickAskCardReply #648b）只堵新数据，这里对
// 卡片展示点统一清洗：整条图片直链或 data: base64→[图片]，语音「名称|||…」保留名称段，
// 内嵌令牌→[图片]（与 #403 桌面弹窗清洗链同口径）。普通文字与文内普通链接原样保留。
function askCardReplyClean(s) {
let t = String(s == null ? '' : s);
if (!t) return t;
const bare = t.trim();
if (chatIsImageUrlCard(bare)) return '[图片]';
if (/^data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,/i.test(bare)) return '[图片]';
const bar = t.indexOf('|||');
if (bar >= 0) t = t.slice(0, bar).replace(/\.[^.]+$/, '').trim() || '[语音]';
if (t.indexOf('@@m:') >= 0) t = t.replace(/@@m:[0-9a-f]{32}/g, '[图片]');
return t;
}
window.askCardReplyClean = askCardReplyClean; // ta-ask.js 好奇结果弹窗复用
function pokeIconHtml(text) {
const s = String(text == null ? '' : text);
const prefix = '<svg class="st-ico"';
if (s.indexOf(prefix) === 0) {
const end = s.indexOf('</svg>');
if (end >= 0) return s.slice(0, end + 6) + escTxt(askCardReplyClean(s.slice(end + 6)));
}
return escTxt(askCardReplyClean(s)); // #648g 存量拍一拍/回应里的媒体卡清洗后再铺（令牌→[图片]）
}
// v3.30.x：拍一拍人称「昵称制」——聊天昵称与桌面解耦后（v3.26.x），联系人昵称是聊天里
// 唯一的人称来源。拍一拍消息里除了 {ta}/{me} 占位符外，字卡文案中写死的独立人称占位
// （TA / ta / 他 / 她，语义上均指代联系人/被拍方）也一并按「联系人昵称」回填，
// 不再跟随性别称呼（他/她/TA）——否则用户改了联系人昵称，拍一拍里仍出现 TA 很费解。
// 保护段：<svg>…</svg> 图标、data:*;base64 与合成词（其他/他们/她们/他人）不受影响；
// 不用 lookbehind（旧版 iOS Safari 不支持），占位符先掩成控制符防二次替换。
function pokePersonMap(s, taNm, meNm) {
if (s === null || s === undefined) return s;
let t = String(s);
if (typeof t !== 'string' || !t) return t;
const hasPh = t.indexOf('{ta}') >= 0 || t.indexOf('{me}') >= 0;
if (hasPh) t = t.split('{ta}').join('\u0002').split('{me}').join('\u0003');
const segs = t.split(/(<svg[\s\S]*?<\/svg>)/);
for (let i = 0; i < segs.length; i += 2) {
const parts = segs[i].split(/(data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)/);
for (let j = 0; j < parts.length; j += 2) {
let p = parts[j];
p = p.split('其他').join('\u0004').split('他们').join('\u0005').split('她们').join('\u0006').split('他人').join('\u0007');
p = p.split('TA').join(taNm);
p = p.replace(/\bta\b/g, taNm);
p = p.split('他').join(taNm).split('她').join(taNm);
p = p.split('\u0004').join('其他').split('\u0005').join('他们').split('\u0006').join('她们').split('\u0007').join('他人');
parts[j] = p;
}
segs[i] = parts.join('');
}
t = segs.join('');
if (hasPh) t = t.split('\u0002').join(taNm).split('\u0003').join(meNm);
return t;
}
function attrEsc(s) {
return String(s == null ? '' : s)
.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function restoreEscapedPokeIcons() {
let escMigrated = false;
msgs.forEach(r => {
if (r && r.special === 'poke' && typeof r.text === 'string' && r.text.indexOf('&lt;svg class=&quot;st-ico&quot;') === 0) {
const mm = r.text.match(/^(&lt;svg class=&quot;st-ico&quot;[\s\S]*?&lt;\/svg&gt;)([\s\S]*)$/);
if (mm) {
r.text = mm[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&') + mm[2];
escMigrated = true;
}
}
});
return escMigrated;
}
function chatLabel(ck, dk, fb) {
let v = null;
try { v = store.get(ck); } catch (e) {}
if (v) return v;
// v3.26.x：dk 传 null 表示不回退桌面键——聊天昵称与桌面彻底解耦（用户要求：聊天设置里
// 联系人/我的昵称不再跟随桌面，未设时用默认占位 TA/我，即 v3.8.x 原设计）
if (!dk) return fb;
try { v = store.get(dk); } catch (e) {}
return v || fb;
}
// v3.26.x：聊天昵称与桌面解耦——只读聊天专用键 cs-lbl-*，未设时默认 TA/我，
// 不再回退读桌面 lbl-partner/lbl-user（v3.9.x 的「跟随桌面」按用户要求取消）
// v3.30.x：拍一拍人称昵称制——不再走 T()（taFit 称呼替换），改用 pokePersonMap：
// {ta}/{me} 与字卡里写死的 TA/ta/他/她 一律按 我的昵称/联系人昵称 回填
// FIX 2026-09-18 #775（用户实报：改了昵称、消息里的拍一拍不变；多机型/多浏览器同报）：
// 联系人昵称的解析链必须与聊天顶栏（updateChatPartnerName）、通话小框（contacts.js
// contactNameFor 注释所记的同一次修复）完全一致——cs-lbl-partner → 联系人名片名 → 称呼词。
// 本函数此前少了「名片名」这一环，于是只在「联系人管理」里改名的用户（没单独设过聊天昵称，
// 即 cs-lbl-partner 为空）会看到顶栏跟着变、拍一拍仍写「TA」。链分叉＝观感「改名没生效」。
// 与 v3.26.x「聊天昵称不跟随桌面美化昵称（lbl-partner）」不冲突：桌面美化键仍不参与本链，
// 名片名是聊天域身份来源（顶栏一直在用），不是桌面装饰。
function chatPartnerName() {
const v = chatLabel('cs-lbl-partner', null, '');
if (v) return v;
const cn = window.contactNameFor ? window.contactNameFor(window.__activeCid || 'default') : '';
return cn || (window.taWord ? window.taWord() : 'TA');
}
window.chatPartnerName = chatPartnerName;
function chatUserName() { return chatLabel('cs-lbl-user', null, '我'); }
// v3.25.x：系统消息昵称动态化——改名后历史系统消息称呼跟随当前昵称。
// 存储：改名时把旧昵称从系统标记记录的 text 清扫成 {ta}/{me} 占位符（白名单=renderMsg 里走
//   T(rec.text) 的分支，普通气泡 text 永不扫、永不换）；渲染：T() 把占位符换回当前昵称。
// {ta} 含花括号，不可能出现在 base64 字母表/svg 文本里；但被清扫的旧名可能撞上 base64/svg
// 段（如默认名 TA），清扫按 taFit 同款分段保护。hist/swept 每桌面各存一份，loadMsgs 惰性补扫。
// FIX 2026-09-18 #775c：这套机制原先只有联系人（{ta}）一半，「我的昵称」没有对应的 {me}
// 清扫（avatar-lib.js「chat.js 只维护 {ta} 占位符」注释即该缺口）。v3.26.x 起新拍一拍存的是
// 占位符，但更早的历史里昵称是**字面**写进正文的——只改「我的昵称」时旧记录永远停在旧名，
// 用户实报「给我和联系人换了昵称，拍一拍里的昵称还是没变」的两条根因之一。现按槽位并跑两份。
const SYS_NICK_SLOTS = {
ta: { cur: chatPartnerName, token: '{ta}', histKey: 'sysmsg-nick-hist', sweptKey: 'sysmsg-nick-swept', legacy: 'TA' },
me: { cur: chatUserName, token: '{me}', histKey: 'sysmsg-user-nick-hist', sweptKey: 'sysmsg-user-nick-swept' }
};
function sysNickSlot(slot) { return SYS_NICK_SLOTS[slot === 'me' ? 'me' : 'ta']; }
// 清扫前置豁免：空名无需扫；{me} 侧默认占位「我」「你」是人称代词而非用户起的名字，
// 扫它＝把系统消息里的每个「我」批量换成 {me}（连「我们」「我的」都被牵动），不做。
function sysNickSweepSkip(oldName, token) {
if (!oldName) return true;
return token === '{me}' && (oldName === '我' || oldName === '你');
}
function sysNickHistGet(st, slot) {
const k = sysNickSlot(slot).histKey;
try {
const v = JSON.parse(st.get(k) || '[]');
if (Array.isArray(v)) return v.filter(x => typeof x === 'string' && x);
} catch (e) {}
return [];
}
function sysNickSweepText(s, oldName, token) {
const ph = token || '{ta}';
const segs = String(s).split(/(<svg[\s\S]*?<\/svg>)/);
for (let i = 0; i < segs.length; i += 2) {
const parts = segs[i].split(/(data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)/);
for (let j = 0; j < parts.length; j += 2) {
if (parts[j].indexOf(oldName) >= 0) parts[j] = parts[j].split(oldName).join(ph);
}
segs[i] = parts.join('');
}
return segs.join('');
}
function sysNickSweepable(r) {
if (!r || typeof r.text !== 'string' || !r.text) return false;
// FIX 2026-09-16 #616（昵称池）：nickKeep 的消息是**事件记录**——正文里带引号的昵称
//（如「我把昵称换成了「小满」」）是当时发生的事实，不能跟随后续改名一起被清扫成 {ta}
//（否则第二次改名后旧记录会谎报成「换成了当前名」，两条记录看起来一模一样）。
// 放在 mailNotice 之前：nickKeep 是显式豁免，优先级高于其它可清扫类型。
if (r.nickKeep) return false;
if (r.mailNotice) return true;
return r.special === 'poke' || r.special === 'ask-msg' || r.special === 'call' ||
r.special === 'call-reply' || r.special === 'invite-reply' || r.special === 'pong' ||
r.special === 'brick' || r.special === 'memory';
}
function sysNickSweepMsgs(arr, oldName, slot) {
const token = sysNickSlot(slot).token;
if (sysNickSweepSkip(oldName, token)) return false;
let changed = false;
for (let i = 0; i < arr.length; i++) {
const r = arr[i];
if (!sysNickSweepable(r) || r.text.indexOf(oldName) < 0) continue;
const t = sysNickSweepText(r.text, oldName, token);
if (t !== r.text) { r.text = t; changed = true; }
}
return changed;
}
// FIX 2026-09-16 #626 寻踪「更新了一条日常」系统消息改名后同 ts 变两条：
// 昵称清扫只改了 msgs（并落盘），漏了 chat-tail 兜底日志——改名后 msgs 里这条已变
// {ta} 更新了一条日常、chat-tail 里还是「旧名 更新了一条日常」；下次 chatTailMerge 按
// ts|side|正文 签名判不出同一条，把旧名那条当「未落盘的新消息」补回 ⇒ 同一 ts 两条、
// 文字不同又永远合不掉（置顶/寻踪必现）。收口＝凡是清扫 msgs 的 oldName，同步清扫 chat-tail。
function chatTailSweepNick(oldName, slot) {
try {
const token = sysNickSlot(slot).token;
if (typeof oldName !== 'string' || sysNickSweepSkip(oldName, token)) return false;
const arr = chatTailRead();
if (!arr.length) return false;
let changed = false;
for (let i = 0; i < arr.length; i++) {
const j = arr[i];
if (!sysNickSweepable(j) || j.text.indexOf(oldName) < 0) continue;
const t = sysNickSweepText(j.text, oldName, token);
if (t !== j.text) { j.text = t; changed = true; }
}
if (changed) store.set('chat-tail', JSON.stringify(arr));
return changed;
} catch (e) { return false; }
}
function sysNickCatchup() {
let changed = false;
['ta', 'me'].forEach(function (slotKey) {
const S = sysNickSlot(slotKey);
const cur = S.cur();
const hist = sysNickHistGet(store, slotKey);
if (!hist.length) {
try { store.set(S.histKey, JSON.stringify([cur])); store.set(S.sweptKey, '1'); } catch (e) {}
return;
}
if (hist[hist.length - 1] !== cur) {
// 名字在上次会话后被改动（含绕过钩子的外部写入，如备份导入）：旧尾名清扫成占位符，与改名钩子同效
if (sysNickSweepMsgs(msgs, hist[hist.length - 1], slotKey)) changed = true;
try { chatTailSweepNick(hist[hist.length - 1], slotKey); } catch (e) {} // FIX 2026-09-16 #626 尾巴日志同步清扫
hist.push(cur);
try { store.set(S.histKey, JSON.stringify(hist)); } catch (e) {}
}
let swept = 0;
try { swept = parseInt(store.get(S.sweptKey), 10) || 0; } catch (e) {}
if (swept < hist.length) {
for (let i = swept; i < hist.length; i++) {
if (hist[i] && hist[i] !== cur) {
if (sysNickSweepMsgs(msgs, hist[i], slotKey)) changed = true;
try { chatTailSweepNick(hist[i], slotKey); } catch (e) {} // FIX 2026-09-16 #626 尾巴日志同步清扫
}
}
try { store.set(S.sweptKey, String(hist.length)); } catch (e) {}
}
});
return changed;
}
let avatarBatchCache = null;
function fillAvatar(el, key) {
if (typeof el === 'string') el = document.getElementById(el);
if (!el) return;
let data;
if (avatarBatchCache && key in avatarBatchCache) {
data = avatarBatchCache[key];
} else {
data = store.get(key);
if (!data && key === 'cs-avatar-partner') data = store.get('avatar-partner');
if (!data && key === 'cs-avatar-user') data = store.get('avatar-user');
if (avatarBatchCache) avatarBatchCache[key] = data || null;
}
if (data && data.length > 500 * 1024) data = null;
// FIX 2026-09-16 #617 头像「闪一下重新加载」（红米 K80 Chrome 等多机型，用户明说其他设备型号
//   也有）：原实现无条件 el.innerHTML='' + 新建 img + 赋 src，于是每一次 fillAvatar 调用都会
//   把该位置的头像节点整块换成新节点——新节点从零解码，且旧节点先被清空＝该位置空一帧再出现。
//   触发面最广的一处是「头像互动里点一张换头像」：它走 refreshChatAvatars()，把**全部**已渲染
//   消息的头像（实测 16 条气泡 + 顶栏 + 一条系统行＝17 个 img 节点，17 次 load）连同没变的那
//   一侧一起重建＝整列头像一起闪、一起重新加载。回前台 / 切桌面 / 跨上下文 storage 变更
//   （convergeAvatars）走同一条路，所以真机（常切前后台、解码位图易被回收）比无头更容易看见。
//   收口：①值没变＝DOM 一律不碰（__avApplied 记录已落地的值）；②值变了也只改现有 img 的 src，
//   不再拆节点——浏览器会继续画旧图直到新图解好，不出现空帧。零机型分支、零视觉改动。
if (el.__avApplied === (data || '')) return;
el.__avApplied = data || '';
if (data) {
const cur = el.querySelector('img');
if (cur) { cur.src = data; cur.alt = ''; }
else {
const img = document.createElement('img');
img.src = data;
img.alt = '';
el.innerHTML = '';
el.appendChild(img);
}
} else {
el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#999999" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.5-6 8-6s8 2 8 6"/></svg>';
}
}
window.fillAvatar = fillAvatar;
function refreshChatAvatars() {
// v3.16.x：先清批量渲染缓存——渲染窗口内某条消息 renderMsg 抛异常会跳过末尾的
// appendAvatarBatch(false)，avatarBatchCache 残留后 fillAvatar 永远读缓存旧值，
// 换头像后回前台/切桌面触发的刷新仍显示旧头像（刷新页面才恢复）。这里强制失效，
// 让本次刷新重新读存储最新值。
avatarBatchCache = null;
fillAvatar('chat-user-av', 'cs-avatar-user');
fillAvatar('chat-partner-av', 'cs-avatar-partner');
document.querySelectorAll('.msg-in .msg-av').forEach(av => fillAvatar(av, 'cs-avatar-partner'));
document.querySelectorAll('.msg-out .msg-av').forEach(av => fillAvatar(av, 'cs-avatar-user'));
}
window.refreshChatAvatars = refreshChatAvatars;
fillAvatar('chat-user-av', 'cs-avatar-user');
fillAvatar('chat-partner-av', 'cs-avatar-partner');
try {
document.addEventListener('mochi-restore-done', function () {
try {
chatHotCacheDropAll(); // #954：备份恢复整库重写＝热片缓存全作废（随后 forceIdb 直读重建）
// FIX 2026-09-01 #120：大历史桌面跳过 restore 完成时的强读（进入聊天页才读），防低端机崩溃
chatPrefetchIfLight(function () { loadMsgs(true); });
if (chatVisible() && chatNearBottom() && body && msgs.length) {
// v3.26.x #220：备份恢复后同窗同貌时原地补丁，不再整窗重建（防正在看聊天时跳动）
if (!inplacePatchIfSameWindow()) {
renderWindow(false, true);
scrollChatBottom();
}
}
fillAvatar('chat-user-av', 'cs-avatar-user');
fillAvatar('chat-partner-av', 'cs-avatar-partner');
try { updateChatPartnerName(); } catch (e) {}
} catch (e) {}
});
} catch (e) {}
const pname = document.getElementById('chat-partner-name');
function updateChatPartnerName() {
if (!pname) return;
// 顶栏与消息内昵称（拍一拍/系统消息）共用 chatPartnerName 这一份解析链，不再各写一份
pname.textContent = chatPartnerName();
}
updateChatPartnerName();
window.renderChatHeader = updateChatPartnerName;
try {
document.addEventListener('mochi-wrj-heal', function () { try { updateChatPartnerName(); } catch (e) {} });
// FIX 2026-09-18 #775g：联系人管理里改名（contacts.renameContact 派发 contact-renamed）后
// 顶栏也按同一条取名链立刻重取——此前只有「聊天设置改昵称」「昵称池换名」两条路径会调
// renderChatHeader，名片改名后回到聊天顶栏仍是旧名（用户读作「昵称没生效」）
document.addEventListener('contact-renamed', function () { try { updateChatPartnerName(); } catch (e) {} });
} catch (e) {}
const typingEl = document.getElementById('chat-typing');
let typingOn = false;
// FIX 2026-09-27 #1326「一直显示对方正在输入中却不出消息，退出再进才显现」（一加12／Via 实报，
// 用户明说其他设备型号也有出现）：这一行是一句关于「在飞的这一发」的承诺，而承诺此前**没有期限**。
// 投递用的是 setTimeout(fn, 设定的回复时长)，页面被整页冻结／深度节流时那一发可以几十分钟不回来
//（随附诊断单实测：回复时间=1~15s，而 回复实测=12.6s|61.2s|…|388.3s），行就一直挂着；enterChat
// 还照旧按 typingOn 把它重新点亮＝每进一次聊天页就把这句谎重说一遍。
// 判据只取一个事实：这一发承诺到期了没有。到期时刻在 showTyping 当场登记；复核既挂在自选的
// 看门狗上，也挂在回前台／进聊天页上——冻结期连同看门狗一起冻住，只靠 setTimeout 等于没挂。
let typingDueAt = 0;
let typingWatch = 0;
function chatVisible() {
const p = document.getElementById('page-chat');
return !!(p && !p.hidden);
}
// v3.26.x：聊天记录加载进度条显隐——消息区为空且权威数据未就绪时显示「正在加载聊天记录…」，
//   读库完成（chatDbReady=true）或离开聊天页自动隐藏
// FIX 2026-09-15 #526：已知空库（新联系人/空桌面，chatKnownEmpty）不再显示——没有历史可读，
//   原来新建联系人首次进聊天会白等 2.5s 空库复核才收起进度条
// FIX 2026-09-17 #703：去掉「msgs 为空」前置——切桌面后进聊天，LS 尾部快照（或快速预读）
//   先把 msgs 填上几条，权威大包还要再读数秒，旧条件在这段窗口把进度条压掉＝屏上零反馈、
//   权威到达时 200 气泡+百张图集中解码＝「没有加载缓冲动画、卡几秒」（无头 4× 节流实证：
//   进度条全程未显示、803ms 长任务）。只要权威未就绪且聊天页可见就显示；就绪即收起。
let chatRebuilding = false; // #841：分帧整窗重建的「列表已清空、新内容未换装」空窗期——该窗口必须显示进度条，否则用户看到的是闪白/闪旧记录＝当成 bug
// FIX 2026-09-21 #1010 收尾媒体窗（用户实报「数据加载弹窗消失之后，聊天记录还会闪一下才恢复」）：
//   权威回读收尾除了「换装列表」还有第二段可见变化——屏上这些气泡里的图片是**迟到解码**的
//   （dataURL 解码 / 媒体池令牌解析 / 懒加载补图），收尾当帧只是把 <img> 节点换上，位图落地
//   往往在几百 ms 后，届时整列高度一次性长出来（无头 8× 节流实测：收尾瞬间 h 26804→42791、
//   scrollTop 随贴底重钉跳 26k px）。进度条的旧条件只认「数据到没到」（chatDbReady /
//   chatAuthPending / chatRebuilding），收尾一落地就撤 ⇒ 用户看到的顺序恰好是「弹窗先消失、
//   记录再闪一下」。这里把「收尾的屏上媒体解码」也算进进度条的持有条件：权威收尾换/补过屏上
//   媒体节点时，进度条留到这些图解码落地（或 1.2s 上限）才撤；收尾没碰媒体（纯文本历史、无图
//   可补）＝当场撤，行为与旧版逐字节相同（同一同步任务内先置后撤，中间无绘制）。
let chatSettleHoldUntil = 0;
let chatSettleHoldT = null;
let chatSettleHardUntil = 0;
// 视口内还有没解码完的图片（只算视口±40px 内＝用户真会看到的那些；视口外的 lazy 图可能
// 永远不触发加载，算进来只会把进度条白拖到 deadline）
function chatMediaPendingCount() {
try {
const list = body.querySelectorAll('img.msg-img');
if (!list.length) return 0;
const br = body.getBoundingClientRect();
const top = br.top - 40, bot = br.bottom + 40;
let pending = 0;
for (let i = 0; i < list.length; i++) {
const im = list[i];
if (im.complete && im.naturalWidth) continue;
const r = im.getBoundingClientRect();
if (r.bottom < top || r.top > bot) continue; // 视口外（懒加载未触发）不计
pending++;
}
return pending;
} catch (e) { return 0; }
}
function chatSettleHoldOn() { return chatSettleHoldUntil > 0; }
// 分帧换装（renderWindow 的 setTimeout(buildChunk) 链）在飞时不能判「无未解码图」——那一刻
// DOM 还是空的（frag 未换装），误判成「收尾已落地」会让进度条先撤、图再落地＝原症状。此时
// 把 deadline 往后顺延（硬上限 chatSettleHardUntil 兜底，防构建卡死把进度条钉死）。
function chatSettleHoldDefer() {
chatSettleHoldUntil = Math.min(chatSettleHoldUntil + 400, chatSettleHardUntil);
if (!chatSettleHoldT) chatSettleHoldT = setTimeout(chatSettleHoldPoll, 120);
}
function chatSettleHoldPoll() {
chatSettleHoldT = null;
if (!chatSettleHoldOn()) return;
if (!chatVisible()) {
chatSettleHoldUntil = 0;
try { updateChatLoading(); } catch (e) {}
return;
}
if (batchRendering) { chatSettleHoldDefer(); return; }
if (chatMediaPendingCount() === 0 || performance.now() > chatSettleHoldUntil) {
chatSettleHoldUntil = 0;
try { updateChatLoading(); } catch (e) {}
return;
}
chatSettleHoldT = setTimeout(chatSettleHoldPoll, 120);
}
// 收尾开始：置位（进度条此期间不收；deadline 防「有图永不 complete」把进度条钉死）
function chatSettleHoldArm() {
chatSettleHoldUntil = performance.now() + 1200;
chatSettleHardUntil = chatSettleHoldUntil + 6000;
}
// 收尾落地：屏上已无未解码图 → 当场收（同一任务内无中间绘制＝不闪）；否则等解码（≤deadline）
function chatSettleHoldSettle() {
if (!chatSettleHoldOn()) return;
if (!chatVisible()) {
chatSettleHoldUntil = 0;
try { updateChatLoading(); } catch (e) {}
return;
}
if (batchRendering) { chatSettleHoldDefer(); return; } // 换装未落定：等 finishSwap 再判
if (chatMediaPendingCount() === 0) {
chatSettleHoldUntil = 0;
try { updateChatLoading(); } catch (e) {}
return;
}
if (!chatSettleHoldT) chatSettleHoldT = setTimeout(chatSettleHoldPoll, 120);
}
// FIX 2026-09-23 #1057（用户报障：#951 上线后「问题依旧没有解决。那这个加载进度条还是不完整啊，
// 就是因为这样切换，来回切换用户就会以为是 bug」）：15× 节流逐帧取证量出三处「像 bug」的形态——
// ①同桌面「退出→再点开」进度条照挂 1208ms，而屏上明明已经有本桌面这一窗（#951 预渲的成果被浪费）：
//   enterChat 无条件 chatRebuilding=true，把「将要重画」的标志当成了「屏上什么都没有」；
// ②切桌面后 120ms 内点开：进度条浮在**上一个桌面**的 123 条气泡上 915ms（#489 清 msgs 不清 DOM，
//   预渲 600ms 后才落地）＝「闪一下」本体，拿别人的聊天记录当加载背景绝不是诚实反馈；
// ③内容画好后条再挂 1190ms 然后瞬间消失（无收场）。
// 三处共同根因＝进度条只回答「标志位有没有置起」，从不回答「屏上现在是什么」。本批把判据补齐：
// A 显隐加一层屏上凭据；B 真在加载且屏上不是本桌面的窗 → 遮掉消息区（visibility 保留滚动几何，
// 不伤 #1039 首帧贴底）；C 收场走 160ms 淡出。零机型分支：判据全是屏上凭据与既有标志。
// 屏上这一窗是否属于「当前桌面」：DOM 有节点 + 凭据已登记 + 未作废 + 命名空间对得上。
function chatScreenHasOwnWindow() {
if (!body || !body.children.length) return false;
if (windowRenderedN === 0) return false; // 无屏上凭据（首渲前）
if (windowStale) return false; // 渲染后数据被归一化/合并改过＝屏上已落后
try { if (windowRenderedPrefix !== window.activePrefix()) return false; } catch (e) { return false; }
return true;
}
let chatLoadingOutT = null;
// 进度条唯一的显隐出口：show＝要不要顶着，cover＝要不要连消息区一起遮掉（屏上没有本桌面的窗才遮）
function setChatLoadingUI(show, cover) {
if (chatLoadingOutT) { clearTimeout(chatLoadingOutT); chatLoadingOutT = null; }
if (show) {
chatLoadingEl.hidden = false;
chatLoadingEl.classList.remove('chat-loading-out');
} else if (!chatLoadingEl.hidden) {
chatLoadingEl.classList.add('chat-loading-out'); // #1057c：不撤 DOM 先淡出，160ms 后再真撤（瞬间消失＝用户眼里的「闪」）
chatLoadingOutT = setTimeout(function () { chatLoadingOutT = null; chatLoadingEl.hidden = true; chatLoadingEl.classList.remove('chat-loading-out'); }, 160);
}
const host = chatLoadingEl.parentElement; // #chat-loading 是 #page-chat 的直接子节点
if (host) host.classList.toggle('chat-loading-cover', !!cover);
}
function updateChatLoading() {
if (!chatLoadingEl) return;
const ownWin = chatScreenHasOwnWindow(); // #1057a：屏上已有本桌面这一窗＝用户已经在看内容，#967 的「空屏必须有提示」不再成立（标志位照旧置着，只是它不代表空屏）；只有 #1010 的收尾媒体窗还能在它之上顶着
const flagsUp = (!chatDbReady || chatRebuilding || chatAuthPending || batchRendering || chatSettleHoldOn()) && !chatKnownEmpty; // #703：去掉「msgs 为空」前置 · #841：重建空窗期同样显示 · #967：权威未达同样显示（保险丝置真不代表数据到了，空屏必须一直有提示）· #1010：收尾媒体解码未落地同样显示（否则「弹窗先消失、记录再闪一下」）
let withdraw = ownWin && !chatSettleHoldOn(); // #1057：判据从「标志位」补上「屏上拿不拿得出本桌面这一窗」
// #1057 不许削掉 #1010 的契约：窗在位、但视口内还有未解码的图＝用户其实还没看到内容，条照旧顶着。
// 这里直接借用 #1010 的收尾窗把条放下来（Arm 自带 deadline、Settle 排 120ms 轮询并在落地那帧重判），
// 免得本批另起一台「永挂没人收」的定时器；遮罩仍只看 ownWin，同桌面重进时消息区不被遮＝与 #1010 原行为逐帧一致。
// flagsUp 短路在前＝稳态浏览不会逐次量 DOM（本函数有 14 处调用点）。
if (withdraw && flagsUp && chatMediaPendingCount() > 0) { withdraw = false; chatSettleHoldArm(); chatSettleHoldSettle(); }
const show = chatVisible() && flagsUp && !withdraw;
setChatLoadingUI(show, show && !ownWin); // #1057b：遮罩只在「屏上不是本桌面的窗」时挂（切桌面/预渲未落地/整窗重建中途）；CSS 侧规则见 chat-main.css 的 #1057b 哨兵
}
// FIX #162（iPad Air 7 / iPadOS 26 Safari：对方回一条消息视图就向上漂一次，不贴最新消息）
// 贴底钉住态：程序化滚到底时置真，用户手动触摸/滚轮滚动即解除；复写与图片补滚只在钉住时进行
let chatPinnedBottom = true;
// FIX 2026-09-15 #516：聊天区「贴底目标」统一取值——打字行可见时必须把它的高度扣回去。
// 「对方正在输入」行是 #chat-body 的**兄弟**节点（同属 #page-chat 的 flex 行）：行一显示就把
// chat-body 的可视高压掉一行高 T（≈22px），scrollHeight 一点没动 ⇒ 此时 scrollHeight − clientHeight
// 得到的"最大值"比行隐藏态的真最大值虚高 T px。#514 只治了 showTyping/hideTyping 这两个写点，
// 但 out 侧 120ms 兜底、in 侧 rAF/150ms 兜底**仍可能在打字行显示期执行**（实测连发第 1 条落地前
// 一帧的 scrollTop 正落在这份虚高值上）——行一隐藏最大值当场回落 T px、内核把 scrollTop 钳掉
// T px ＝ 内容凭空下弹 T px（#514 的残根）。而 T ≤ .chat-body 的 padding-bottom:24px（产品给底部
// 留的空白呼吸区）⇒「贴底」本来就该指行隐藏态的位置，与行是否显示无关：
// 目标 = scrollHeight − (clientHeight + 行高)。纯几何、零机型/内核分支。
function chatScrollMax() {
const cb = document.getElementById('chat-body');
if (!cb) return 0;
const t = typingEl;
const typingH = (t && !t.hidden && t.offsetHeight) ? t.offsetHeight : 0;
return Math.max(0, cb.scrollHeight - (cb.clientHeight + typingH));
}
function scrollChatBottom() {
const cb = document.getElementById('chat-body');
// FIX 2026-09-20 #912（红米 K80 Chrome 等多机型报「联系人发消息总不在最底部」）：瞬时贴底写入
// 必须先取消在飞的平滑动画——旧动画帧持有的是上一条消息时的 start/target，连发期间它会把本条
// 刚写到位的 scrollTop 按旧曲线拉回去（无头实证：写入后下一帧 top 倒退、gap 反复张开到 564px）。
// #912 语义＝同步写是最高优先级，动画只服务「写完之后没人再写」的收尾窗口
// FIX #316：回钉贴底时同步关回浏览器滚动锚定（与 #199 overflow-anchor:none 同口径）
if (cb) { if (_ccSmoothT) { cancelAnimationFrame(_ccSmoothT); _ccSmoothT = null; } chatPinnedBottom = true; cb.classList.remove('scroll-anchor-auto'); cb.scrollTop = chatScrollMax(); }
}
// v3.3x.x：TA 自发消息跟底的平滑滚动——replace 瞬时 scrollTop=scrollHeight 的"咻地一跳"。
// rAF 驱动 + ease-out 三次加速曲线（起步快、末端自然落定），只改 scrollTop（无布局属性动画）；
// 可被下一次调用重置（来消息连发时不叠加、始终朝最底滑）。仅「TA 自发 in」使用；
// 自己发消息/键盘回钉/图片补滚等需瞬时复位的场景仍走 scrollChatBottom（保持 #162/#416/#504 契约）。
let _ccSmoothT = null;
function scrollChatBottomSmooth() {
const cb = document.getElementById('chat-body');
if (!cb) return;
chatPinnedBottom = true;
cb.classList.remove('scroll-anchor-auto');
const target = chatScrollMax(); // FIX 2026-09-15 #516 同 chatScrollMax：打字行显示期写入不得越过「行隐藏态最大值」（否则行一隐藏必被钳回＝下弹一行高）
const start = cb.scrollTop;
if (target <= start) { cb.scrollTop = target; return; }
const dur = Math.min(360, 180 + (target - start) * 0.35);
const t0 = performance.now();
if (_ccSmoothT) { cancelAnimationFrame(_ccSmoothT); _ccSmoothT = null; }
const step = (now) => {
const p = Math.min(1, (now - t0) / dur);
const e = 1 - Math.pow(1 - p, 3);
cb.scrollTop = start + (target - start) * e;
if (p < 1) { _ccSmoothT = requestAnimationFrame(step); }
else { _ccSmoothT = null; cb.scrollTop = target; }
};
_ccSmoothT = requestAnimationFrame(step);
}
// FIX #316（红米 K80 Chrome 等多机型报「聊天记录一直跳、一直闪」）：#199 为治 Gecko 锚定
// 与 #162 贴底钉住对打，给 .chat-body 无差别加了 overflow-anchor:none——Chromium 原生
// 滚动锚定被一并关掉。此后浏览历史时，视口上方消息里的图片异步解码撑高（.msg-img 最高
// 260px/张）再无任何补偿，看的内容一次次被推走＝「聊天记录一直跳」。修法：解钉（用户
// 手动触摸/滚轮滚动）时动态开回锚定，由内核原生保持视口稳定；回钉贴底时关回（#199
// 防对打语义不变——对打只发生在钉住态，解钉期 #162 不写 scrollTop，无架可打）。
function unpinChatAndAnchor() {
chatPinnedBottom = false;
// FIX 2026-09-20 #912：解钉＝用户接管滚动权，在飞的跟底平滑动画必须当场取消——
// 否则动画帧继续按旧 target 写 scrollTop＝动画跟用户手指对打（#716 同族）。
if (_ccSmoothT) { cancelAnimationFrame(_ccSmoothT); _ccSmoothT = null; } body.classList.add('scroll-anchor-auto');
}
function chatNearBottom() {
const cb = document.getElementById('chat-body');
if (!cb) return true;
return cb.scrollHeight - cb.scrollTop - cb.clientHeight < 120;
}
// FIX #416（红米 K80 Chrome 等多机型报「聊天/群聊滑动页面，每次点滑动自动往最新消息最底下跳」）：
// 回钉/接管判定必须认「真的贴到底」，不能认「离底 <120px」——最新一条消息（图/长文本）通常
// 恰好落在离底 24~120px 区间，用户一上翻阅读、一轻点就误判回钉被拽回最底。贴底=距最大
// scrollTop 只剩 ≤8px（.chat-body 底部还有 padding-bottom:24px 的呼吸区，用户读最新消息时
// 离底必然 >24px，互不混淆）。
// FIX 2026-09-21 #998（红米 K80 Chrome 实报「联系人发消息，最新消息总是不会跟随自动滑动到最
// 底部，需要我自己滑动到最底下」，用户点名其他机型同现、要求勿致跨机型回归）：本判定必须与写方
// scrollChatBottom() 用**同一把尺子**。写方落点是 chatScrollMax()（已扣掉「对方正在输入」行高 T），
// 读方却用裸 scrollHeight − clientHeight——而打字行恰好在每条来消息落地前显示 0.4~1.4s（正是用户
// 会去点/滑的那段窗口），行显示期真贴底时裸口径读出「离底 T≈22px > 8」＝假解钉态：轻点回钉
// （touchend）与滚动落定回钉两条恢复路一起失效，钉住态再也回不来，此后每条来消息都不跟底
// （无头实证：一次轻点即失底，之后连发 gap 累积到 133.7px、最新一条整条落在消息区下方 +38.7px）。
// 改用 chatScrollMax()：贴底＝距真最大值 ≤8px，与行是否显示无关（#416 的 8px 口径、以及「用户读
// 最新一条时离底必然 >24px 的呼吸区」结论零变化，橡皮筋超界仍判真）。纯几何、零机型/内核分支。
function chatAtBottom() {
const cb = document.getElementById('chat-body');
if (!cb) return true;
return chatScrollMax() - cb.scrollTop <= 8;
}
// FIX 2026-09-15 #492（帮我决定/多人决定结果发到聊天后聊天记录不自动滑到最新消息，多机型同报）：
// 用户主动触发的「来向」消息一次性跟底标记——chatAddIn({follow:true}) 置位、此处消费。决策结果
// 是用户当下操作的直接产物，与「自己发消息」（out 侧必跟底）和群聊结果（followGcBottom(true)
// 强制跟底）同权，不该吃 in 侧「用户在看历史就别打扰」的钉住闸（真机上翻过聊天＝解钉态，结果
// 气泡永远落在视口下方）；TA 自发消息的 #162/#378/#416 不打扰契约零改动。
let chatUserFollowScroll = false;
function maybeScrollChatBottom(side) {
if (batchRendering) {
if (side === 'out') pendingOutScroll = true;
return; // #492 follow 标记批量渲染期不消费，留待真实追加时生效
}
if (!chatVisible()) return;
const out = side === 'out';
const userFollow = !out && chatUserFollowScroll; // FIX #492 一次性消费
if (userFollow) chatUserFollowScroll = false;
// FIX #378（红米 K80 Chrome 等多机型报「联系人发消息不自动滚到最新」）：来消息跟底闸
// 改按钉住标记——内核丢弃首写/图片迟到解码顶开后，视口离底会超 120px，旧 nearGcBottom
// 闸把后续每条来消息都误判成「在看历史」永不跟底；用户手动接管（触摸/滚轮解钉）与
// 搜索/引用跳转定位（#334）本就解除钉住，chatPinnedBottom 已完整表达「别打扰」
// FIX 2026-09-21 #998：跟底判据补一条「视口此刻就在真底部」——chatPinnedBottom 是**可过期的标记**
// （一次触摸即解钉，恢复路一旦被时序错过就永久失真），而「用户此刻停在最新一条上」是几何事实。
// 两者取或：标记说钉住 ⇒ 照旧跟底（#378/#162 契约零改动）；标记失真的解钉态、但视口就在真最大值
// ≤8px ⇒ 这条来消息照样跟底（用户本来就在看最新消息，落一条新消息没有任何理由不给他看，且
// scrollChatBottom 当场把标记复位＝自愈）。用户真在上翻阅读（离底 >8px）时两条都不成立，仍是
// 「绝不打扰」——#416 口径零改动。判据与写方同尺（chatAtBottom ⇒ chatScrollMax）＝不受打字行影响。
if (!out && !userFollow && !chatPinnedBottom && !chatAtBottom()) return;
	if (out || userFollow) {
	// 自己发(out) / 用户主动触发的 follow（决策结果等）：保持瞬时落底——本人的消息即刻到底才自然
	scrollChatBottom();
	requestAnimationFrame(scrollChatBottom);
	setTimeout(scrollChatBottom, 120);
	chatResumeRealign('send'); // #1523a 发送这一发连写三次常落在键盘收起／回场几何风暴的中间态上＝#978 那种「滚动树停旧偏移、scrollTop 读数假绿」，而这三连写自己不是补口：挂上落定枪，几何全静默后再同值重落一枪（健康态零副作用）
	} else {
	// FIX 2026-09-15 #516：TA 自发（in）跟底改为**插入帧内同步瞬时**贴底。
	// 旧实现是插入之后才启动平滑滚动：新气泡先在视口下方渲染（实测 390×844、气泡高 53px 时
	// 底边落在消息区视口下方 +38.7px，连发三条一模一样），再用 ~200ms 滑上来——用户看到的就是
	// 「消息一条条飞出来」（报障原话：第一条好了，其他消息还是飞出来的）。同步写让「布局 + 滚动」
	// 落在同一任务内完成，浏览器绘制时内容已对齐 ＝ 新气泡直接在底部贴边长出（内容整体上移一格、
	// 最新一条始终贴着底边），零滑动、零位移，与「自己发消息」（out）侧同构。
	scrollChatBottom(); // FIX 2026-09-15 #516 插入帧内同步贴底：新气泡落地即在底部（旧实现先在视口下方渲染再平滑滑上来＝用户报的「消息飞出来」）
	// FIX #162 兜底保留：iPadOS 26 Safari 内核可能丢弃首写 / 被迟到的布局变更顶开。兜底复写走
	// 平滑——此刻通常已经贴底（target ≤ start 直接落位、不产生动画），真有迟到差距时平滑收口，
	// 不会把视口远处的内容"咻"地一次拽到底。
	requestAnimationFrame(() => { if (chatPinnedBottom) scrollChatBottomSmooth(); });
	setTimeout(() => { if (chatVisible() && chatPinnedBottom) scrollChatBottomSmooth(); }, 150);
	}
}
// FIX 2026-09-23 #1180（用户直派「回复条数最少1最多2，加上撤回补发和其他功能发的消息，聊天里联系人发送的消息非常多，怎么限制」）：TA 消息总量限流（默认关闭）。
// 「回复条数」只管被动回复的基础条数，逐卡连发/撤回补发/心情分享/红包捎话/邀请/主动发送全都绕过它，所以调到 1~2 也照样刷屏——本闸管的是「总量」：任意 rl-win 分钟内、TA 已送达的收件最多 rl-max 条，超出的那几条不再投递，窗口滑过去自动恢复。
// 计数源＝msgs 自身（in 侧），零新增存储键：重载/切桌面/跨页补投都按消息 ts 落回同一个窗口，天然复原；豁免位见 rlExempt（special:'read' 已读回执＋限流自己的钥匙）。零机型分支。
// FIX 2026-09-27 #1341（复核 #1180 四处口径，用户「帮我检查这个功能有没有用、会不会导致无法正常聊天」）：
// ① 限流不再共用 #1015 夜间闸那把钥匙。旧写法 `p.nightAllow || special==='read'` 让「夜间豁免」顺手成了「限流豁免」——
//    带 nightAllow 的 TA 自发内容（经期关心/经期预警、音乐互动的系统台词）既不占额度也拦不住，与设置页写的
//    「只有已读回执与你当刻操作引发的记录豁免」不符。现在夜间闸认 nightAllow、限流认 rateAllow，两把钥匙各开各的门；
//    「用户当刻操作引发」那批记录（红包领取退回、游戏战绩、存钱罐结算、决定结果）逐处补 rateAllow，拆位前后行为逐位相同。
// ② 额度满时不再「已读不回」：已读回执本就被豁免，所以旧写法下你刚发完话、TA 只给你一个已读标记，最长静音一整个窗口。
//    现在改成——你自己在最近 RL_REPLY_GRACE_MS 内发过消息、且这一发还没动用过保底，则窗口里的第一条 TA 收件照落，其余照拦
//    （每发用户消息至多一次；额度没满时不烧保底）。
// ③ 钱已入账的卡片必落：TA 自动红包/自动申请心意币/自动送礼都在**扣款之前**先看额度（源头不生成＝不会出现「扣了钱没卡片」，
//    与 #1015 在 trySystemAutoSend 里写的同一条口径），而一旦钱已经扣了，那张卡带 rateAllow 照落（红包卡是唯一领取入口）。
const RL_REPLY_GRACE_MS = 60000; // 你说话之后仍给 TA 留一条保底回应的窗口
let rlUserSpokeAt = 0; // 你自己最后一次发消息的时刻（addRec 落库时盖章，out 侧所有入口都收在这）
let rlReserveFor = 0; // 保底已经为哪一刻用过＝每发用户消息至多一次
function rlExempt(p) { return !!p && (p.rateAllow === true || p.special === 'read'); }
function rlReserveAvailable() {
return !!rlUserSpokeAt && rlReserveFor !== rlUserSpokeAt && Date.now() - rlUserSpokeAt <= RL_REPLY_GRACE_MS;
}
function rateLimitFull() {
try {
const c = cfg();
if (cfgn(c, 'turn-en', 0) === 1) return false; // 「连发的算一轮」（nova 式）打开＝本总量限流整条不再计数与拦（用户口径：两条机制各管各的，不叠加）
if (cfgn(c, 'rl-en', 0) !== 1) return false;
const win = Math.max(1, cfgn(c, 'rl-win', 5)) * 60000;
const max = Math.max(1, cfgn(c, 'rl-max', 15));
const now = Date.now();
let n = 0;
for (let i = msgs.length - 1, k = 0; i >= 0 && k < 400; i--, k++) {
const p = msgs[i];
if (!p || (p.side || '') !== 'in' || rlExempt(p)) continue;
if (now - (p.ts || 0) > win) continue;
if (++n >= max) return true;
}
return false;
} catch (e) { return false; }
}
// 单一裁决点：addIn（音效之前）与 addRec（兜底）对同一发判定两次，两次必须同结论——所以「这一发
// 走的是保底」记在被判的对象上，只有真落进 msgs 那一刻才烧掉（被去重闸退回时不烧，留给下一条）。
function rateBlocksIn(rec) {
if ((rec.side || '') !== 'in' || rlExempt(rec)) return false;
if (!rateLimitFull()) return false;
if (!rlReserveAvailable()) return true;
rec.rlReserveUsed = 1;
return false;
}
window.chatRateLimitFull = rateLimitFull; // #1341 只读探针：给「扣款前先看额度」的机制问一句（gift-shop 的自动送礼同用它）
window.__rlDiag = function () { // #1341 诊断钩子：把「窗口内到底数到几条、msgs 现在多少条、这一发的保底还在不在」如实报出来
// （回归脚本按它设定前提，不靠猜时序——clearChatHistory 之后有一拍异步重读会整包换掉 msgs）
try {
const c = cfg();
const win = Math.max(1, cfgn(c, 'rl-win', 5)) * 60000;
const max = Math.max(1, cfgn(c, 'rl-max', 15));
const now = Date.now();
let n = 0;
for (let i = msgs.length - 1, k = 0; i >= 0 && k < 400; i--, k++) {
const p = msgs[i];
if (!p || (p.side || '') !== 'in' || p.rateAllow === true || p.special === 'read') continue; // 与 rlExempt 同尺，写成内联是为了让 #1341b 那根针在文件里唯一
if (now - (p.ts || 0) > win) continue;
n++;
}
return { en: cfgn(c, 'rl-en', 0), win: win, max: max, n: n, total: msgs.length, spoke: rlUserSpokeAt, used: rlReserveFor, reserve: rlReserveAvailable() ? 1 : 0 };
} catch (e) { return null; }
};
// #1326：承诺的期限从「设定」里读，不从机型／UA 里读——rs-max 就是产品自己定义的「TA 最长会打多久」，
// 再兜住本文件其它「正在输入→落地」链路自有的最长等待（连发条间 2.6s），最后留 5s 余地：
// 正常链路里 hideTyping 就在那一发之后，够不着这条线。
function chatTypingHorizonMs() {
const rsMax = Math.max(1, Number(cfg()['rs-max']) || 40);
return Math.max(rsMax * 1000, 2600) + 5000;
}
// 到期＝把行收掉（消息照常随后落地，那一发只是迟到不是丢了）＋留一行现场证：
// 下次再报「正在输入不出消息」时，库里就有「迟到了多久、从哪条路复核到的」，不必再挨个猜。
function chatTypingReconcile(why) {
if (!typingOn || !typingDueAt || Date.now() < typingDueAt) return false;
const overMs = Date.now() - typingDueAt;
hideTyping();
try {
const l = window.__chatTypingExpired = window.__chatTypingExpired || [];
if (l.length >= 8) l.shift();
l.push({ t: Date.now(), why: String(why || ''), overMs: overMs });
window.__chatTypingExpiredN = (window.__chatTypingExpiredN || 0) + 1;
} catch (e) {}
return true;
}
function showTyping() {
if (!typingEl) return;
if (rateLimitFull() && !rlReserveAvailable()) return; // #1180：额度已满＝TA 不会再发出来了，就别再演「正在输入」（否则每条都变成「打了字又没消息」）
typingOn = true;
typingDueAt = Date.now() + chatTypingHorizonMs(); // #1326：点亮这一行的同一刻登记它的到期时刻
if (typingWatch) clearTimeout(typingWatch);
typingWatch = setTimeout(function () { typingWatch = 0; chatTypingReconcile('watch'); }, chatTypingHorizonMs());
if (chatVisible()) {
typingEl.hidden = false; // FIX 2026-09-15 #514 只切可见性、不写 scrollTop（#334 守钉加强版：连钉住态也不抢滚动权）
// #514 根因（红米 K80 Chrome 等多机型报「联系人连发多条消息时聊天记录一直闪、一直回弹」）：
// 「对方正在输入」行是 #chat-body 的**兄弟**节点（#page-chat 的 flex 行），显示它只吃 chat-body
// 的 clientHeight——可滚最大（scrollHeight − clientHeight）反被抬高一行高、scrollHeight 一点没动。
// 旧实现在钉住态把 scrollTop 顶到「行显示中」的那份最大值（比行隐藏态大 22px）；行一隐藏
// （hideTyping，紧随其后就是这条消息落地）最大值当场回落 22px、内核把 scrollTop 钳掉 22px
// ＝ 内容凭空下弹 22px，紧接着新消息又被平滑滚回底部 → 每个来回「上跳 22px + 下弹 22px」；
// TA 连发多条 / 主动发送连发（tick 内 hideTyping→addIn→showTyping 循环）＝用户看到的
// 「一直闪、一直回弹」。打字行实高 22px ≤ .chat-body 的 padding-bottom:24px（这块本来就是
// 消息区底部空的呼吸区），占位期间最后一条消息照旧完整可见——所以显示/隐藏都不该写 scrollTop：
// 不写过界就没有钳位，内容一个像素都不动，行只安静占掉那块留白。纯几何、零机型/内核分支。
// 跟底职责仍全归 maybeScrollChatBottom：这里只切可见性（解钉态本就不抢滚动权，#331 语义等价；
// 钉住态贴底由 #162/#378/#416/#492 各自路径维持，它们都在「行隐藏态」下写，钳位目标一致）。
}
}
function hideTyping() {
if (!typingEl) return;
typingOn = false;
typingDueAt = 0; // #1326：这一发兑现了（或这条链作废了）＝期限一并撤掉，别留下一个到不了期的旧承诺
if (typingWatch) { clearTimeout(typingWatch); typingWatch = 0; }
typingEl.hidden = true;
if (chatPinnedBottom) scrollChatBottom(); // FIX 2026-09-11 #334 解钉态不抢滚动权；#514 起这次写只作收尾补平（行隐藏态 scrollTop 已在最大值，正常链路里等于无操作）
}
// FIX 2026-09-28 #1356 荣耀畅玩40Plus(RKY-AN00)／夸克 10.18.6 实报「发消息联系人不显示正在输入中了，
//   就莫名其妙的感觉消息被吞了」＋「不要覆盖修改导致不同型号设备浏览器的 bug 反复出现，这个问题其他
//   设备型号也有出现」（随附 mochi-diag-2026-09-28-05-36-59… 诊断件）：
// 根因不在机型，在「这一发回复只活在一枚 setTimeout 里」——scheduleReply 掷完延迟就 showTyping，
// 投递那一刻靠 setTimeout(fn, delay)；页面被系统回收／用户重开，这一发承诺连同定时器一起没了，
// 而重开后的那份 msgs 里最后一条仍是【自己发的】，屏幕上既没有「正在输入中」也永远等不来回音
// ＝用户口径的「消息被吞」。纯产物无头实测（LS 每次写都抛 QuotaExceededError 的这台机结构条件，
// 回复时间设 8~8s，发出 2s 后重开页面）：重开后 40s 内 taRepliesAfterMine 恒 0、typing 恒 0，
// 库里最后一条永远是那条 out——这一发不是迟到，是整场不再有人兑现。
// 该诊断件同时记着：本页被系统回收过 59 次、回复时间=1~540s（用户把「最长」调到 540 秒）＝
// 等待窗几乎必然跨过一次回收；Chromium/WebKit/各家安卓内核一律会这么杀页面，所以「其他型号也有出现」。
// 改法（判据零机型／零 UA 分支，只取「这条消息是不是上一场留下的、它后面有没有回音」两个事实）：
// 权威落定那一刻（与 #180 尾巴日志回放、#1200 中转箱回填同一段）回头看一眼 msgs 自己——
//   最后一条是自己当刻之前（本场开始以前）发的正文卡、且它之后没有任何 in 侧内容、且这一刻仍在
//   产品自己定义的「TA 最长会打多久」(#1326 chatTypingHorizonMs) 之内 ⇒ 这就是上一场没落的那一发，
//   按同一把尺子重新掷一次延迟、先亮「正在输入中」再走同一条 replyOnce 管线补投。
// 零新增存储键（口径同 #1180「计数源＝msgs 自身…重载/切桌面天然复原」）；每桌面每会话只认一次，
// 免得把「此刻这一发还在飞的」当成欠的；夜间静默／#1180 限流／无回应档照旧各自拦这一发（补投不是绕过闸门）。
const CHAT_SESSION_START = Date.now();
const replyDebtDoneFor = new Set();
function chatReplyDebtCheck(myPrefix) {
try {
if (!myPrefix || replyDebtDoneFor.has(myPrefix)) return;
replyDebtDoneFor.add(myPrefix); // 一桌一场只认这一次：认的是「上一场没走完的那一发」
if (!Array.isArray(msgs) || !msgs.length) return;
const last = msgs[msgs.length - 1];
if (!last || (last.side || '') !== 'out') return; // 最后一条不是自己发的＝没有欠
if ((last.special || '') !== '') return; // 已读回执/系统卡不是「向 TA 说了一句话」
if (!((last.ts || 0) > 0) || last.ts >= CHAT_SESSION_START) return; // 本场刚发的＝那一发还在飞，不归这里管
const age = Date.now() - last.ts;
if (age > chatTypingHorizonMs()) return; // 超出产品自己定义的「TA 最长会打多久」＝那是历史，不是欠
const c = cfg();
if (hit(c['rn-prob'])) return;
if (window.nightModeActive && window.nightModeActive()) return;
if (rateLimitFull()) return;
const rsMin = Math.max(1, Number(c['rs-min']) || 1);
const rsMax = Math.max(rsMin, Number(c['rs-max']) || rsMin);
const wait = Math.max(400, Math.min(chatTypingHorizonMs(), (rsMin + Math.random() * (rsMax - rsMin)) * 1000 - age));
try { window.__chatReplyDebtFired = (window.__chatReplyDebtFired || 0) + 1; } catch (e0) {}
showTyping(); // 把上一场没兑现的那句承诺接续上：先让人看到「正在输入」，再等这一发落地
setTimeout(() => {
try { hideTyping(); } catch (e1) {}
try { replyOnce(c, null); } catch (e2) {}
}, wait);
} catch (e) {}
}
function cfg() { return (window.replyCfg && window.replyCfg()) || {}; }
function cfgn(c, k, d) { const v = c[k]; return v === undefined ? d : v; }
function hit(p) { return Math.random() * 100 < p; }
function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function pick(arr) { return arr.length ? arr[Math.floor(Math.random() * arr.length)] : ''; }
function pickN(arr, n) {
const copy = arr.slice();
const out = [];
while (copy.length && out.length < n) {
out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
}
return out;
}
// FIX 2026-09-15 #531：自定义字卡池分类修正——①emoji 判定补 BMP 符号区（☺️⭐☀️✨☕ 等，
// 原判定只看代理对与 astral 段，纯 BMP 符号卡落进 text）；②颜文字判定补无括号形态
//（▽・ω・▽、๑•́ ₃ •̀๑ 等）。让「文字」池只装可读句子，避免符号/颜文字卡占满文字池。
// 判定顺序：含 astral emoji 一律 emoji（保持原行为）→ 含中文/假名/字母/数字＝可读卡按原样
// 归 text/颜文字 → 无可读字符才按符号区/颜文字特征归 emoji/kaomoji。
const CHAT_READABLE_RE = /[A-Za-z0-9\u4e00-\u9fff\u3041-\u3096\u30a1-\u30fa]/;
const CHAT_KAOMOJI_FACE_RE = /[｡◕‿・▽´｀￣﹏◠◡≧≦ω＾￢¬^•˙˘๑٩۶ฅヽノ]/;
function chatLooksKaomoji(c) {
if (chatIsBracketedKaomojiCard(c)) return true;
return CHAT_KAOMOJI_FACE_RE.test(c);
}
function chatIsEmojiCard(c) {
if (/[\uD800-\uDBFF]/.test(c)) return true;
if (CHAT_READABLE_RE.test(c)) return false;
if (chatLooksKaomoji(c)) return false; // 非可读但含颜文字特征（含 ✿♥✧ 等符号的颜文字）→ 交颜文字分支
for (const ch of c) {
const cp = ch.codePointAt(0);
if ((cp >= 0x1F000 && cp <= 0x1FAFF) || (cp >= 0x2600 && cp <= 0x27BF) || (cp >= 0x2B00 && cp <= 0x2BFF)) return true;
}
return false;
}
function chatIsKaomojiCard(c) {
if (chatIsBracketedKaomojiCard(c)) return true;
if (CHAT_READABLE_RE.test(c)) return false;
return CHAT_KAOMOJI_FACE_RE.test(c);
}
// FIX 2026-09-23 #1152 括号成对只证明「带括号」，不证明「是颜文字」：旧判定把括号规则放在可读性
// 规则之前，于是「远(离我很远、或感觉疏离)」这类戴括号的中文句子被归进颜文字池，被 #1051 的 '\n'
// 硬换行接在文字卡后面＝句子从中间断开（用户实报「我之前只要颜文字不被截断换行」）。判据收成一条：
// 含中文/假名等可读文字、且不含颜文字面部符号＝它是文字卡，不是颜文字卡。纯符号颜文字与
// （^o^）（( ˘ ˘ )zZ）这类带字母/无面部符号但含符号字符的形态判定结果不变。
// FIX 2026-09-24 #1191 括号壳里空无一物也不是颜文字：#1152 只挡住了「括号里装着中文句子」，而
// 「()」「（）」「( )」这类空壳既无可读文字也无面部符号，旧判据仍按「括号成对」把它收进颜文字池，
// 于是被 #1051 的硬换行接在文字卡后面＝用户实报「【背包 / ()】这个内容也自动换行」。
// 判据＝把括号与空白全剥掉后什么都不剩＝壳不是脸：回落成普通文字卡（颜文字池空＝没有末尾卡可另起一行）。
const CHAT_BRACKET_SHELL_RE = /^[\s()（）[\]【】<>《》]+$/;
function chatIsBracketedKaomojiCard(c) {
return !CHAT_BRACKET_SHELL_RE.test(c) && /[\(（｡◕(◕)(づ｡(¬)]/.test(c) && /[\)）】)]/.test(c) && !(CHAT_READABLE_RE.test(c) && !CHAT_KAOMOJI_FACE_RE.test(c));
}
window.chatIsKaomojiCard = chatIsKaomojiCard; // 专项验证与展示面共用（同一判据各写一份＝复发土壤）
window.chatIsBracketedKaomojiCard = chatIsBracketedKaomojiCard; // 群聊/默认字卡分池借用
// 「文字」池是否至少有一张可读句子卡（中文/假名/字母/数字）。FIX 2026-09-15 #531：全是颜文字/符号
// /emoji 时视为「没有可用的自定义文本回复源」——#157 的默认主字卡兜底据此触发，否则用户只加了
// 颜文字/符号卡时池里没有任何句子，联系人只能反复发那几张符号（用户报「消息和信都是连续发颜表情，
// 无法使用其他字卡」；系统预设 2 级锁已解锁）。含中文/字母的用户（#157 场景）行为不变。
function chatHasReadableTextCard(arr) {
return arr.some(s => typeof s === 'string' && CHAT_READABLE_RE.test(s));
}
// FIX 2026-09-15 #534 图片直链识别——存量消息自愈用。只认「整条消息就是一张图片直链」
// 的形态：单个 http(s) token、无空格引号、带图片扩展名（可带 query/hash）。用户聊天里真
// 发的普通链接（无图片扩展名）保持原文本显示，不误判成图（避免换成裂图反而更糟）。
// 背景：链接导入的字卡（图床不允许跨域时按链接存原图 URL，位于字卡库【表情包/图片】）
// 曾被 getPool 的 data:/|||/@@m: 三道守卫漏过、当文字卡抽出并以 type:'text' 落库，
// 气泡直出「https://…/IMG_2343.png」整段链接（用户报「联系人发送的消息应该是图片，
// 会变成图上的乱码」）。#533 已堵住入库口，这里补上已落库历史消息的渲染自愈。
function chatIsImageUrlCard(s) {
if (typeof s !== 'string') return false;
return /^https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|gif|webp|bmp|avif|svg)(?:[?#][^\s"'<>]*)?$/i.test(s.trim());
}
// FIX 2026-09-20 #948 媒体载荷识别的唯一口径（大小写/空白不敏感）——聊天气泡把图片渲染成一整
// 串「乱码」的来路只有一条：内联 dataURL 载荷漏进了「文字」通道（字卡被当文本卡抽中、TA 回应
// 直传、parts 被丢、存量自愈没跑完），而旧判定全是 `x.indexOf('data:image/') === 0` 这种
// 大小写敏感＋不允许前导空白的写法。用户直派 OPPO K13x 自带浏览器（实报 HeyTapBrowser）＋
// 「其他设备型号也有」⇒ 一律不做机型分支，只把判据收口成零分支的健壮形态：
//   · 载荷在别处（字卡库/历史消息）以什么形态写入我们无法约束（解码失败/压缩失败时按原图
//     入库、相册/文件管理器给的内联类型五花八门），但「它是不是媒体」这件事只有这一份判据；
//   · 前缀类判定只扫串头 64 字符（base64 串可达数百 KB，禁止对整串跑回溯型正则）；
//   · 令牌判定仍归 media-pool 官方口径（mochiMediaIsToken），此处只补它不认的内联形态。
const DATA_HEAD_RE = /^data:([a-z0-9.+-]+)\/([a-z0-9.+-]+)[;,]/i;
function chatMediaHead(s) {
if (typeof s !== 'string' || !s) return '';
let t = s;
for (let i = 0; i < t.length; i++) {
const ch = t.charAt(i);
if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r' && ch !== '\f') { t = t.slice(i); break; }
}
return t.length > 64 ? t.slice(0, 64) : t;
}
// FIX 2026-09-20 #948h 无 MIME 载荷（File.type 为空时 FileReader 产出 "data:;base64,…"——安卓
// 文件管理器/部分内核的相册与录音口实测走这条腿，iOS「文件」App 选图亦可能给出空类型）：
// 形态上没有 image/audio 段，上面那条 MIME 正则与旧的全部精确前缀判定一并漏过，于是它被当正文
// 铺出＝与本次乱码同症状（只是来路不同）。它与其它内联载荷一样是媒体而非文字；「是图还是未知」
// 不猜内核、只按 base64 头解出的魔数定夺（jpeg/png/gif/webp/bmp），认不出就只当「内联载荷」。
// 自解 base64 头（不用 atob）：判定层要在零浏览器依赖的行为校验脚本里同结论跑，且只解前十几个
// 字节，成本可忽略。禁第二份口径——media-pool 本地兜底与此严格同义。
const DATA_NOMIME_RE = /^data:;base64,/i;
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64HeadBytes(b64, n) {
const out = [];
for (let i = 0; i + 3 < b64.length && out.length < n; i += 4) {
const a = B64_ALPHABET.indexOf(b64.charAt(i)), b = B64_ALPHABET.indexOf(b64.charAt(i + 1));
const c = B64_ALPHABET.indexOf(b64.charAt(i + 2)), d = B64_ALPHABET.indexOf(b64.charAt(i + 3));
if (a < 0 || b < 0 || c < 0 || d < 0) break;
out.push((a << 2) | (b >> 4), ((b & 15) << 4) | (c >> 2), ((c & 3) << 6) | d);
}
return out;
}
// 无 MIME 载荷的图片魔数判定 → 规范化 MIME；不是无 MIME 形态或魔数非图片一律返回 ''
function chatB64ImgMime(s) {
const h = chatMediaHead(s);
if (!DATA_NOMIME_RE.test(h)) return '';
const comma = h.indexOf(',');
const b = b64HeadBytes(comma >= 0 ? h.slice(comma + 1) : '', 12);
if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg';
if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
return '';
}
// 把 "data:;base64,<图片>" 还原成规范形态（幂等：补正后不再是无 MIME 形态）；非图片返回 ''
function chatFixNoMimeImg(s) {
if (typeof s !== 'string') return '';
const mime = chatB64ImgMime(s);
if (!mime) return '';
const i = s.indexOf(',');
return i >= 0 ? ('data:' + mime + ';base64,' + s.slice(i + 1)) : '';
}
function chatIsDataImgSrc(s) {
const h = chatMediaHead(s);
if (h.charCodeAt(0) !== 100 && h.charCodeAt(0) !== 68) return false; // 'd'/'D'
const m = DATA_HEAD_RE.exec(h);
return !!(m && m[1].toLowerCase() === 'image');
}
function chatIsDataAudioSrc(s) {
const h = chatMediaHead(s);
if (h.charCodeAt(0) !== 100 && h.charCodeAt(0) !== 68) return false;
const m = DATA_HEAD_RE.exec(h);
return !!(m && m[1].toLowerCase() === 'audio');
}
// 内联媒体载荷（图/音）——任何以 data:... 开头的载荷都不是可当文字铺出的正文
function chatIsInlineDataSrc(s) {
const h = chatMediaHead(s);
if (h.charCodeAt(0) !== 100 && h.charCodeAt(0) !== 68) return false;
if (DATA_NOMIME_RE.test(h)) return true; // FIX #948h 无 MIME 载荷（旧的全部前缀判定漏过＝当正文铺 base64）
return /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+[;,]/i.test(h);
}
function chatIsMediaPayload(s) {
return chatIsDataImgSrc(s) || chatIsDataAudioSrc(s) || chatIsInlineDataSrc(s) || chatIsImageUrlCard(s);
}
// 图片候选：显式 image/* ＋「内核会嗅探成图片」的无类型载荷（Chromium 家族实测
// data:application/octet-stream;base64,… 能正常解码出图，而文件读取器给不出类型时恒发这一份
// 形态）——只排除 audio/*（录音恒带显式 audio MIME）与 video/*（按图渲染必坏）。
// 判错的最坏后果是走 #202 加载失败占位，远比把几百 KB base64 当正文铺出好。
function chatIsDataImgLikeSrc(s) {
const h = chatMediaHead(s);
if (!h) return false;
const c0 = h.charCodeAt(0);
if (c0 !== 100 && c0 !== 68) return false;
if (DATA_NOMIME_RE.test(h)) return !!chatB64ImgMime(s); // FIX #948h 无 MIME：魔数说了算（认不出＝非图，仍按内联载荷收标注）
const m = DATA_HEAD_RE.exec(h);
if (!m) return false;
const t = m[1].toLowerCase();
return t !== 'audio' && t !== 'video';
}
// 整串就是「可直接喂给 <img src> 的图片引用」：媒体池令牌 / 内联图片 dataURL / 图片直链
function chatIsImgSrcLike(s) {
if (typeof s !== 'string' || !s) return false;
if (window.mochiMediaIsToken && window.mochiMediaIsToken(s)) return true;
return chatIsDataImgLikeSrc(s) || chatIsImageUrlCard(s);
}
// 字卡/回应串里是否含媒体（整串载荷，或正文中间夹着的真令牌/「名称|||」语音形态）
// ——含则不得进「文字」池。刻意不按裸 'data:' 子串匹配：正常英文句子里出现 "data:" 的
// 文字卡不能被误剔（误剔＝联系人少一张文本卡，比少一层防护更难查）。
function chatHasMediaPayload(s) {
if (typeof s !== 'string' || !s) return false;
if (chatIsMediaPayload(s)) return true;
if (s.indexOf('@@m:') >= 0 && /@@m:[0-9a-f]{32}/.test(s)) return true;
if (s.indexOf('|||') >= 0) return true;
// FIX #948h 无 MIME 载荷（"data:;base64,…"）夹在正文中间同样不得进文字池（#948 的 MIME 形态
// 正则漏过它＝旧的 `indexOf('data:') === 0` 守卫被收窄，无 MIME 卡会重新被当文本发出）
if (/\sdata:;base64,/i.test(s.slice(0, 4096))) return true;
return /\sdata:[a-z0-9.+-]+\/[a-z0-9.+-]+[;,]/i.test(s.slice(0, 4096));
}
window.chatIsDataImgSrc = chatIsDataImgSrc; // 群聊等处显式 image/* 判定借用同一口径
// #948 群聊/其他展示面统一借用（各自再写一份精确前缀判定＝本次乱码的复发土壤）
window.chatIsImgSrcLike = chatIsImgSrcLike;
window.chatIsDataImgLikeSrc = chatIsDataImgLikeSrc; // media-pool 令牌化闸门同口径
window.chatB64ImgMime = chatB64ImgMime; // FIX #948h media-pool 本地兜底/自愈共用同一魔数判定
window.chatFixNoMimeImg = chatFixNoMimeImg; // FIX #948h 存量无 MIME 图片载荷补正 MIME（渲染前）
window.chatIsDataAudioSrc = chatIsDataAudioSrc;
window.chatIsInlineDataSrc = chatIsInlineDataSrc;
window.chatIsMediaPayload = chatIsMediaPayload;
window.chatHasMediaPayload = chatHasMediaPayload;
// FIX 2026-09-26 #1308 语音载荷的内核回执体检（华为畅享70Pro／红米等 Chrome 实报「我方发的语音没有
// 办法播放」，用户明说其他机型同现、要求不许按机型打补丁）：导出件里那条 data:audio/webm;codecs=opus
// 解出来＝36 字节 EBML 容器头 + 一长串 0 字节（MediaRecorder 只交出头、一帧音频都没写进来），
// 而旧结账闸只看 `!blob.size`（这种空壳有几 KB）与「录满 1 秒」，于是坏件被永久存进聊天记录，
// 每次点播放内核回一句 MEDIA_ERR_SRC_NOT_SUPPORTED，用户看到的永远是一句不带原因的「语音播放失败」。
// 判据只取「内核有没有回话」「内核报的是哪个 code」两个事实，零机型／零 UA 分支。
const VOICE_PROBE_MS = 1600;
const VOICE_DEAD_MSG = '这条语音里没有可播放的声音（当时就没录进去），需要重新录一条';
window.__mochiVoiceDead = window.__mochiVoiceDead || [];
window.__mochiVoiceDeadN = 0;
// 现场留证（环 8）：哪条链路／容器／体积／内核错误码——#1305 同一课，被拦那一刻没人记账，
// 下一张诊断单照样只能挨个猜。只记不判：任何读数都不参与放行／拦截的决定。
function chatVoiceWitness(where, detail) {
try {
const ring = window.__mochiVoiceDead;
const it = Object.assign({ t: Date.now(), where: String(where) }, detail || {});
ring.push(it);
if (ring.length > 8) ring.shift();
window.__mochiVoiceDeadN++;
if (window.__mochiPhase) window.__mochiPhase('voice-' + it.where);
} catch (e) {}
}
function chatVoiceSrcInfo(src) {
try {
const s = String(src || '');
const m = /^data:([^;,]+)/i.exec(s);
return { kind: m ? m[1].toLowerCase() : (s.indexOf('blob:') === 0 ? 'blob' : '?'), bytes: s.length };
} catch (e) { return { kind: '?', bytes: 0 }; }
}
// 内核明确说「这份字节解不开音频」＝4（MEDIA_ERR_SRC_NOT_SUPPORTED）。与「加载不到／被自动播放策略
// 拦下」是两件事，判据只有 MediaError.code 这一个内核事实，两处消费点共用本函数。
function chatVoiceUnopenable(a) {
return !!(a && a.error && a.error.code === 4);
}
window.chatVoiceUnopenable = chatVoiceUnopenable;
// 三态回执：'ok'＝内核解得开；'no'＝内核当场说解不开；'unknown'＝窗口内内核没回话（慢壳／被系统冻结／
// 拿不到 createObjectURL 的壳）——按 #1241 口径 unknown 不许认死，只留证不改行为。
// ⚠️ 不许拿 duration 当判据：MediaRecorder 吐出的 webm 不带 Cues 索引，真录音在 loadedmetadata 那一刻
// duration 恒为 Infinity（无头实测读数见 tools/verify-1308-voice-empty-gate.mjs），要求「有限正时长」
// 会把每一段正常录音都判成坏件。
window.chatVoiceReceipt = function (src, ms) {
return new Promise((resolve) => {
let done = false;
let a = null;
const fin = (v) => {
if (done) return;
done = true;
try { if (a && a.parentNode) a.parentNode.removeChild(a); } catch (e) {}
a = null;
resolve(v);
};
try {
a = new Audio();
a.preload = 'metadata';
a.style.display = 'none';
// #358 同款：未挂载的 Audio 在部分安卓壳上对什么都不回话＝恒判 unknown，挂进 DOM 才走标准解码管线
document.body.appendChild(a);
a.addEventListener('loadedmetadata', () => fin('ok'));
a.addEventListener('error', () => fin('no'));
a.src = src;
a.load();
} catch (e) { fin('unknown'); return; }
setTimeout(() => fin('unknown'), Math.max(120, ms || VOICE_PROBE_MS));
});
};
// 诊断回读（device.js 【数据】节调用）：这一会话拦到／遇到几次，最近一次是谁
window.__voiceDiag = function () {
try {
const ring = window.__mochiVoiceDead || [];
if (!ring.length) return '本会话没遇到打不开的语音（0 次）';
const last = ring[ring.length - 1] || {};
return '遇到打不开的语音 ' + window.__mochiVoiceDeadN + ' 次（录音闸拦下／播放被内核拒）· 最近: '
+ (last.where || '?') + ' ' + (last.kind || '?') + ' ' + (last.bytes || '?') + 'B'
+ (last.code ? ' 内核码' + last.code : '') + ' @' + new Date(last.t).toLocaleTimeString();
} catch (e) { return '语音体检读数失败'; }
};
function getPool() {
const cards = (window.getCustomCards && window.getCustomCards()) || [];
const pokeSet = (function () {
const pk = (window.getPokeCards && window.getPokeCards()) || [];
return pk.length ? new Set(pk) : null;
})();
const text = [], kaomoji = [], emoji = [], sticker = [], image = [], voice = [], poke = [];
const mediaSticker = (window.getMediaCards && window.getMediaCards('sticker')) || [];
const mediaImage = (window.getMediaCards && window.getMediaCards('image')) || [];
const mediaVoice = (window.getMediaCards && window.getMediaCards('voice')) || [];
sticker.push.apply(sticker, mediaSticker);
image.push.apply(image, mediaImage);
voice.push.apply(voice, mediaVoice);
cards.forEach(c => {
if (pokeSet && pokeSet.has(c)) return; // 拍一拍字卡不进普通回复池
// FIX 2026-09-20 #948 四道媒体守卫（#142 data:/|||、#383 裸 @@m: 令牌、#533 裸 http(s) 图片
// 链接）收成一条大小写＋空白不敏感、且认「正文中间夹着真令牌」的统一判据：旧四道全是精确
// 前缀/整串判定，内核或导入给出的变体形态（大写 MIME、串首空白、data:image/HEIC、
// data:application/…、句子＋令牌混排）漏进文字池＝TA 抽中即以 type:'text' 发出、气泡整屏铺
// base64（用户所见「图片变长乱码」；#383/#533 当年各治一种形态，本条把口径统一防再漏）。
if (typeof c === 'string' && chatHasMediaPayload(c)) return;
if (chatIsEmojiCard(c)) emoji.push(c);
else if (chatIsKaomojiCard(c)) kaomoji.push(c);
else text.push(c);
});
try {
const dcfg = (window.defaultCardCfg && window.defaultCardCfg()) || {};
const isOff = window.isDefaultCardOff || null;
const useChat = window.defaultCardUse ? window.defaultCardUse('chat') : true;
const catOn = window.defaultCardCat || (() => true);
// #319 防未成年人锁：锁定时系统预设字卡整体不入池（上面自建字卡已照常入池，不受影响）
const sysLocked = !(window.cardLockOpen && window.cardLockOpen());
if (dcfg.enabled !== false && useChat && !sysLocked) {
// v3.26.x #157：默认主字卡只在自定义 text 池为空时兜底并入——原实现开启即把 4600+
// 张默认主字卡无条件全量并入回复池，「整体概率」dc-overall（如 5%）只管 genOneReply
// 里 drawCards 那条混入路径，对池子本身无效：650 张自定义对 4600+ 默认均匀随机抽取，
// 体感「概率调到 5% 联系人还是基本用默认字卡」（小米15Pro+Chrome 等多机型反馈）。
// 对齐颜文字/emoji 分支的兜底语义：有自定义就用自定义，默认字卡按 dc-overall 概率混入。
// FIX 2026-09-15 #531：兜底门由「自定义 text 池为空」放宽为「text 池没有可读句子卡」——
// 用户只加了颜文字/符号卡时 text 池非空却无句子，旧门不触发＝池里没有任何中文/句子卡，
// 联系人只能反复发那几张符号（#531 报障）。含中文/字母的自定义字卡（#157 场景）语义不变。
if (catOn('main') && !chatHasReadableTextCard(text)) {
const defGrps = (window.getDefaultCardGroups && window.getDefaultCardGroups('main')) || [];
defGrps.forEach(g => {
const arr = g[1] || [];
arr.forEach(c => {
if (isOff && isOff('main', c)) return;
if (typeof c !== 'string' || !c) return;
if (/[\uD800-\uDBFF]/.test(c)) emoji.push(c);
else if (chatIsBracketedKaomojiCard(c)) kaomoji.push(c); // FIX #1152 与自建字卡同一判据（旧写法把「……（好像有谁轻轻应了一声）」这类默认卡也当颜文字）
else text.push(c);
});
});
}
if (catOn('kaomoji') && !kaomoji.length) {
const kg = (window.getDefaultCardGroups && window.getDefaultCardGroups('kaomoji')) || [];
kg.forEach(g => (g[1] || []).forEach(c => { if (isOff && isOff('kaomoji', c)) return; if (typeof c === 'string' && c) kaomoji.push(c); }));
}
if (catOn('emoji') && !emoji.length) {
const eg = (window.getDefaultCardGroups && window.getDefaultCardGroups('emoji')) || [];
eg.forEach(g => (g[1] || []).forEach(c => { if (isOff && isOff('emoji', c)) return; if (typeof c === 'string' && c) emoji.push(c); }));
}
}
} catch (e) {}
return { text, kaomoji, emoji, sticker, image, voice, poke };
}
// v3.27.x：暴露给番茄钟陪伴模式复用——让陪伴中的 TA 使用与普通聊天一致的字卡池回复
window.getPool = getPool;
// v3.27.x：生成回复前确保字卡池就绪——冷启动挂起大键（__xyIdbDeferredKeys，见 idb.js
// v3.14.x OOM 防线）时同步读回复池是空库，此前首条回复直接落 FALLBACK_REPLY_POOL，
// 某些手机上联系人因此一直发兜底那几条系统预设字卡（用户反馈）。
// v3.28.x：修「还有手机没解决」——① 等待上限 2.5s 对慢 IDB（iOS 挂后台杀连接、
// 大图字卡库）太短，放宽到与 idbHydrateKey 自身 8s 超时对齐；② 回复池主源是当前
// 联系人的专属字卡，此前走「公用→专属」共享链，公用大键慢会拖住专属，改为专属优先
// 直取（hydrateReplyScope），就绪即放行、公用随后后台补；③ 取回失败/超时记冷却，
// 冷却期内池子仍空时不再每条回复干等，避免坏 IDB 手机每次回复都白等；④ 始终不阻塞
//（超时保留原兜底，下次回复重试；池子一旦就绪立即走自定义字卡）。
// v3.28.x（根因收口）：就绪判定以「自定义字卡是否就位」为准，不用合并池——合并池含
// 系统默认字卡，默认字卡开关开着时池子恒非空，旧判定直接放行，挂起大键里的自定义
// 字卡永不取回，联系人只发默认/兜底那几条系统预设字卡（Phase E 复现：池 4728 张
// 系统卡但自定义 MARKER 不在内）。取回完成或确认无自定义字卡（用户确实没加）即放行，
// 靠默认字卡/兜底回复，不阻塞。
function hasCustomReplyCards() {
  try {
    const cc = (window.getCustomCards && window.getCustomCards()) || [];
    return cc.length > 0;
  } catch (e) { return false; }
}
let lastHydFailAt = 0;
const HYDR_FAIL_COOLDOWN = 30000;
// v3.28.x（第三层收口）：回复池后台自愈——坏/慢 IDB 手机上单次取回可能整体失败
//（idbHydrateKey 8s 内两次尝试仍挂，事务队列被占/连接反复被断），此前每次回复只
// 干等一次、失败后进冷却不再取 → 池子整会话读空，联系人一直发兜底那几条系统预设字卡。
// 这里在「池仍空」时安排有界低频后台重试：每 5s 一次、上限 12 次，一旦自定义字卡
// 就绪立即停；只要设备 IDB 恢复/启动回填落定，池子取回后【后续所有回复】马上用上
// 自定义字卡，不再一直兜底。内存成本与现有回复路径一致（回复本来就会触发取回），
// 不会额外把大库拉进堆；每次尝试走 hydrateReplyScope（in-flight 去重 + absent 缓存）。
let _replyWatcherTimer = null;
let _replyWatcherLeft = 0;
const _REPLY_WATCHER_MAX = 12;
const _REPLY_WATCHER_INTERVAL = 5000;
function _replyWatcherStop() {
  if (_replyWatcherTimer) { clearTimeout(_replyWatcherTimer); _replyWatcherTimer = null; }
  _replyWatcherLeft = 0;
}
function _replyWatcherTick() {
  _replyWatcherTimer = null;
  if (hasCustomReplyCards()) { _replyWatcherStop(); return; }
  let done = false;
  const settle = function () {
    if (done) return; done = true;
    if (hasCustomReplyCards()) { _replyWatcherStop(); return; }
    _replyWatcherKick();
  };
  try {
    // 专属优先（回复池主源）；就绪即停，公用后台补
    window.hydrateReplyScope('own', function () {
      if (hasCustomReplyCards()) { settle(); return; }
      window.hydrateReplyScope('public', function () { settle(); });
    });
  } catch (e) { settle(); }
}
function _replyWatcherKick() {
  try {
    if (hasCustomReplyCards()) { _replyWatcherStop(); return; }
    if (!window.hydrateReplyScope || _replyWatcherTimer || _replyWatcherLeft <= 0) return;
    _replyWatcherLeft--;
    _replyWatcherTimer = setTimeout(_replyWatcherTick, _REPLY_WATCHER_INTERVAL);
  } catch (e) {}
}
function _replyWatcherStart() {
  try {
    if (hasCustomReplyCards() || _replyWatcherTimer || _replyWatcherLeft > 0) return;
    _replyWatcherLeft = _REPLY_WATCHER_MAX;
    _replyWatcherKick();
  } catch (e) {}
}
function ensureReplyCardsReady(capMs) {
  // v3.28.x：等待上限 8s→20s——专属+公用双键串行取回最坏 16s（每键对齐 idbHydrateKey
  // 内部 4s+4s 重试），8s 会切断慢 IDB 手机（真我/荣耀 Edge 事务偶发挂起、MB 级大键读取
  // 耗时长的真机）的取回完成点，回复池整会话读空落兜底卡。20s 让双键都能跑完；超时后
  // 冷却期内池子仍空时不再每条回复干等（坏 IDB 手机直接快出兜底），池子一旦就绪立即走
  // 自定义字卡（就绪判定在冷却检查之前，冷却不会挡住已就绪的池子）。
  // 取回失败/超时/完成后池仍空 → 启动后台自愈重试（_replyWatcherStart），等设备恢复。
  const cap = capMs || 20000;
  try {
    if (hasCustomReplyCards()) { lastHydFailAt = 0; _replyWatcherStop(); return Promise.resolve(true); }
    if (!window.hydrateReplyScope) return Promise.resolve(false);
    // 取回失败/超时冷却：自定义字卡仍缺且刚失败过，不再干等（直接回兜底路径，等下次回复重试）
    if (Date.now() - lastHydFailAt < HYDR_FAIL_COOLDOWN) { _replyWatcherStart(); return Promise.resolve(false); }
    return new Promise((res) => {
      let settled = false;
      const tm = setTimeout(() => { if (!settled) { settled = true; lastHydFailAt = Date.now(); _replyWatcherStart(); res(false); } }, cap);
      const finish = (ok) => { if (!settled) { settled = true; clearTimeout(tm); res(ok); } };
      // 专属字卡优先取回（回复池主源）；就绪即放行，公用字卡后台补
      window.hydrateReplyScope('own', () => {
        if (hasCustomReplyCards()) {
          try { if (window.hydrateLibScopes) window.hydrateLibScopes(['public']); } catch (e) {}
          _replyWatcherStop();
          finish(true);
          return;
        }
        // 专属取回完成仍无自定义字卡 → 再取公用；取回完成（或确认无此键）即放行，
        // 避免没加自定义字卡的用户每条回复都干等
        window.hydrateReplyScope('public', () => {
          if (!hasCustomReplyCards()) _replyWatcherStart(); // 池仍空 → 后台自愈重试
          finish(true);
        });
      });
    });
  } catch (e) { return Promise.resolve(false); }
}
window.ensureReplyCardsReady = ensureReplyCardsReady;
// v3.26.x：回复字卡池诊断——「联系人一直只发【收到～】」报障时直接定位：池子各类型数量、
// 自定义字卡总数、默认字卡三个开关，打进设置→复制诊断信息的【数据】节。省去依赖用户手数。
window.__replyPoolDiag = function () {
  try {
    const P = getPool();
    const cfg = (window.defaultCardCfg && window.defaultCardCfg()) || {};
    const customRaw = (window.getCustomCards && window.getCustomCards()) || [];
    // FIX 2026-09-15 #531：补「总档/自定义占比/媒体概率/池样本」现场——「联系人只发颜文字、
    // 用不了其他字卡」类报障一眼看出是概率设置还是自定义池内容（全是符号卡）导致，免复现。
    const rc = (window.replyCfg && window.replyCfg()) || {};
    const sample = (a) => a.slice(0, 3).map(s => String(s).replace(/\s+/g, ' ').slice(0, 6)).join('|') || '空';
    return [
      '池text=' + P.text.length,
      'kaomoji=' + P.kaomoji.length,
      'emoji=' + P.emoji.length,
      'sticker=' + P.sticker.length,
      'image=' + P.image.length,
      'voice=' + P.voice.length,
      'poke=' + P.poke.length,
      '自定义字卡=' + customRaw.length,
      '默认总开关=' + cfg.enabled,
      '聊天使用=' + (window.defaultCardUse ? window.defaultCardUse('chat') : '?'),
      '主字卡=' + (window.defaultCardCat ? window.defaultCardCat('main') : '?'),
      // v3.26.x #163：补概率滑杆现场——「默认概率调到八九十还是总发自定义字卡」类报障
      // 直接核对 dc-overall-chat（场景概率，未设回退整体）与主字卡分类占比是否真调到位
      '默认概率chat=' + (cfg.overallFor ? cfg.overallFor('chat') : cfg.overall),
      '主卡占比=' + (cfg.probs ? cfg.probs.main : '?'),
      '总档=' + (window.dcpAll ? window.dcpAll() : '?'),
      '自定义占比=' + (rc['csp-cust'] !== undefined ? rc['csp-cust'] : '?'),
      '媒体概率=' + ['sticker', 'emoji', 'image', 'voice', 'kaomoji'].map(k => k + ':' + (rc[k + '-prob'] !== undefined ? rc[k + '-prob'] : '?')).join(','),
      '多字卡py=' + (rc['py-en'] === 1 ? (rc['py-prob'] + '%') : '关'),
      // FIX 2026-09-29 #1451 拼字张数现场——「拼字一直发 5 张」类报障不必再靠猜：这里写的是
      // 抽卡侧真正取用的那对区间（同设置页读数行，都是 replyCfg 算好的同一份生效值），
      // 单设还是跟随、最近 6 次各拼了几张一起摆出来
      '拼字=' + (rc['qs-en'] === 1 ? (rc['qs-prob'] + '%') : '关') +
        (rc['qs-min'] !== undefined ? ' 每次' + rc['qs-min'] + '~' + rc['qs-max'] + '张' + (rc['qs-pair-own'] === 1 ? '(单设)' : '(跟随多字卡)') : ''),
      '拼字实测=' + (window.__spellLog && window.__spellLog.length ? window.__spellLog.join('|') : '无记录'),
      // FIX 2026-09-16 #571：回复延迟现场——设定值（回复速度最短~最长，秒）+ 最近实测落地耗时。
      // 「字卡延迟反应卡顿N秒」类报障：实测≈设定=设定即此延迟（回复速度设置所致）；实测≫设定=真卡顿。
      '回复时间=' + (rc['rs-min'] !== undefined ? rc['rs-min'] : 1) + '~' + (rc['rs-max'] !== undefined ? rc['rs-max'] : 40) + 's',
      '回复实测=' + (window.__replyLatLog && window.__replyLatLog.length ? window.__replyLatLog.map(m => (m / 1000).toFixed(1) + 's').join('|') : '无记录'),
      '无回应概率rn=' + (rc['rn-prob'] !== undefined ? rc['rn-prob'] + '%' : '?'),
      'text样本=' + sample(P.text),
      'kaomoji样本=' + sample(P.kaomoji),
      'emoji样本=' + sample(P.emoji)
    ].join(' / ');
  } catch (e) { return '诊断出错:' + e.message; }
};
function fmtTime(ts) {
if (!ts) return '';
const d = new Date(ts);
const p = (n) => (n < 10 ? '0' + n : '' + n);
return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function timeDividerText(ts) {
if (!ts) return '';
const d = new Date(ts);
const now = new Date();
const p = (n) => (n < 10 ? '0' + n : '' + n);
const h12 = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
const hm = (d.getHours() < 12 ? '上午 ' : '下午 ') + h12 + ':' + p(d.getMinutes());
const dayOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
const dayGap = Math.round((dayOf(now) - dayOf(d)) / 86400000);
if (dayGap <= 0) return hm;
if (dayGap === 1) return '昨天 ' + hm;
if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}
let chatVoiceAudio = null;
let chatVoiceBtn = null;
function stopChatVoice() {
if (chatVoiceAudio) {
try { chatVoiceAudio.pause(); } catch (e) {}
// FIX 2026-09-12：与播放时挂载对称，停播即卸——data: 音频解码缓冲随元素存活，显式释放不等 GC
try { if (chatVoiceAudio.parentNode) chatVoiceAudio.parentNode.removeChild(chatVoiceAudio); } catch (e) {}
chatVoiceAudio = null;
}
if (chatVoiceBtn) { chatVoiceBtn.classList.remove('playing'); chatVoiceBtn = null; }
}
function playVoiceInChat(btn, src) {
if (!src) { toast('语音数据缺失'); return; }
if (chatVoiceBtn === btn) { stopChatVoice(); return; }
stopChatVoice();
const a = new Audio(src);
// FIX 2026-09-12 #358 语音气泡/收藏语音播放：把 Audio 挂到 DOM 再播——部分安卓 WebView
// （雨见等）对未挂载的 Audio 会静默空放/直接 failure（「桌面收藏里联系人收藏的我的语音
// 点播放显示播放失败」，多机型同现；与聊天内语音气泡同链路）。与语音录制试听同款加固
// （见 toggleVoicePlay 的 document.body.appendChild(a)）。挂载后再 play，走标准解码管线。
if (!a.parentNode) { a.style.display = 'none'; document.body.appendChild(a); }
const detachA = () => { try { if (a.parentNode) a.parentNode.removeChild(a); } catch (e) {} };
chatVoiceAudio = a;
chatVoiceBtn = btn;
btn.classList.add('playing');
// FIX #1308 失败分流：过去 error 事件与 play() 落空都汇到同一句「语音播放失败」，而「内核解不开这份
// 字节」和「这一秒没允许我播」是两件事——前者是存量坏件（当时就没录到声音），后者重推一下就好的。
// 只按 MediaError.code 分（自动播放被拒时 error 是空的，绝不误判成坏件）；两路事件同源时只报一次。
let failed = false;
const fail = () => {
if (failed) return;
failed = true;
const dead = chatVoiceUnopenable(a);
chatVoiceWitness(dead ? 'play' : 'play-load', Object.assign({ code: a.error ? a.error.code : 0 }, chatVoiceSrcInfo(src)));
detachA();
stopChatVoice();
toast(dead ? VOICE_DEAD_MSG : '语音播放失败');
};
a.addEventListener('ended', () => { failed = true; detachA(); stopChatVoice(); });
a.addEventListener('error', fail);
a.play().catch(fail);
}
function voicePartsOf(text) {
// FIX 2026-09-13 #395 防御：裸令牌（无主形态漏切）/ 令牌被当名字时不得把令牌串显成名称
const raw = String(text || '');
if (window.mochiMediaIsToken && window.mochiMediaIsToken(raw)) return { name: '语音消息', src: raw };
// FIX 2026-09-20 #948 整条就是内联 data:audio 载荷（无「名称|||」分隔形态，语音令牌化未跑完/
// 旧判定大小写敏感漏过）：载荷即播放源，不得被 split 拆掉后只剩空 src＋名称显示成 mime 头
if (chatIsDataAudioSrc(raw)) return { name: '语音消息', src: raw };
const p = raw.split('|||');
let name = (p[0] || '语音消息').replace(/\.[^.]+$/, '');
if (window.mochiMediaIsToken && window.mochiMediaIsToken(name)) name = '语音消息';
return { name: name, src: p[1] || '' };
}
function fillVoiceBubble(b, text, prefixHtml) {
const v = voicePartsOf(text);
b.innerHTML = (prefixHtml || '') + '<div class="msg-voice" data-src="' + attrEsc(v.src) + '">' +
'<button class="msg-voice-play" title="播放">' +
// 播放/暂停双图标：playing 时 CSS 切换显示，点按三角↔双竖条有互动态（录制面板试听钮同款）
'<svg class="voice-ico-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' +
'<svg class="voice-ico-pause" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>' +
'</button>' +
'<div class="msg-voice-wave"><i></i><i></i><i></i><i></i><i></i></div>' +
'<span class="msg-voice-name">' + escTxt(v.name) + '</span>' +
'</div>';
const btn = b.querySelector('.msg-voice-play');
if (btn) {
// FIX 2026-09-15 #507 语音播放按钮 touch 直驱（「点我发的语音听不了/点了只弹菜单」多机型同报，
// 用户明说其他设备型号也有、要求零机型分支）：#480 气泡轻点直驱曾把播放按钮的轻点也当「点气泡」——
// body touchend 先开消息菜单+布 800ms 吞 click 窗口，吞 click 族内核（Via/夸克/部分壳与内核版本）
// 补发的 click 根本不来或被 body 层吞掉＝点播放永远播不出；健康内核也是菜单/播放双触发。
// 修复两刀（都在各自分段的同一闭包内、互不引用跨段状态）：①msgActionEligible 把 .msg-voice-play
// 排除出「点气泡」判定（touchstart 不再布点/不长按计时，body touchend/click/contextmenu 全链路
// 都不再开菜单不吞 click，长按弹菜单走同气泡非按钮区原语义保留）；②本按钮 touchend 直驱播放 +
// vTapGuard 守卫吞补发 click 防双跑（与 #480 maRunAction 同模式），长按（按下≥500ms）时本直驱
// 也照常播放——按钮区不再承担菜单职责。
let vTapGuard = 0;
const vPlayAction = function () {
if (!v.src) { toast('语音数据缺失'); return; }
// FIX 2026-09-10 #283 语音令牌：播放前异步取回池数据（音频不进热缓存，每次点按 idbGet，
// 池缺失/被剥空 → 与图片占位同口径提示）；_vExp 防取回窗口内连点双播
if (window.mochiMediaIsToken && window.mochiMediaIsToken(v.src)) {
if (!window.mochiMediaExpandAsync || btn._vExp) return;
btn._vExp = true;
window.mochiMediaExpandAsync(v.src, function (data) {
btn._vExp = false;
if (data) playVoiceInChat(btn, data); else toast('语音数据缺失');
});
return;
}
playVoiceInChat(btn, v.src);
};
btn.addEventListener('click', function (e) {
e.stopPropagation();
if (Date.now() < vTapGuard) return; // #507 touch 直驱已播，吞补发 click 防双跑
vPlayAction();
});
btn.addEventListener('touchend', function (e) {
const mt = e.changedTouches && e.changedTouches[0];
if (!mt) return;
e.stopPropagation(); // #507 不入 body touchend＝不开消息菜单、不布吞 click 窗口
if (Date.now() < vTapGuard) return;
vTapGuard = Date.now() + 800;
vPlayAction();
});
}
}
const QUOTE_PLACEHOLDER = /^(图片|表情包|\[图片\]|\[表情包\])$/;
// 旧数据兜底：修复前 TA 自动引用存的是原始 text（语音为「名称|||data:audio;base64…」），
// 直出会整串 base64 铺满屏幕。渲染前统一还原成可读标签，新数据本已是标签、原样通过。
function quoteTextSafe(s) {
let str = String(s == null ? '' : s);
// #148：媒体池令牌（@@m:hash）是图片载荷不是文本，直出会把令牌串当文字铺进引用块/引用预览条
if (window.mochiMediaIsToken && window.mochiMediaIsToken(str)) return '';
const bar = str.indexOf('|||');
if (bar >= 0) str = bar > 0 ? '[语音] ' + str.slice(0, bar) : '';
const di = str.indexOf('data:');
if (di > 0 && str.length - di > 120) str = str.slice(0, di).trim();
return str;
}
// FIX 2026-09-15 #490 引用预览条与气泡同轨显示（「联系人发的消息，引用后看到的和引用的不一致」
// EC-PAD01 SE Chrome 等多机型同报）：气泡正文渲染统一过 renderMsg 的 T()——in 侧走 taFit
// 称呼替换（字卡库以 ta/TA/他 作中性人称占位，默认字卡 110+ 处；联系人性别设为他/她后
// 气泡全是替换词）、双侧回填 {ta}/{me} 昵称占位符；引用预览条此前直出存储原文＝气泡显示
// 「她想你了」、预览还是「ta想你了」两轨不一致；发送后引用块 quoteHtml 又走 taFit，预览
// 与落定引用块也对不上。此助手与 T() 同序同规则，仅作显示层替换、不改存储原文
//（与 taFit 口径一致：改称呼后历史重新渲染即自动跟随）。
function quoteDisplayFit(text, side) {
let t = String(text == null ? '' : text);
const __taNm = chatPartnerName();
const __meNm = chatUserName();
const hasPh = t.indexOf('{ta}') >= 0 || t.indexOf('{me}') >= 0;
if (side !== 'out' && window.taFit) {
if (hasPh) t = t.split('{ta}').join('\u0002').split('{me}').join('\u0003');
t = window.taFit(t);
if (hasPh) t = t.split('\u0002').join(__taNm).split('\u0003').join(__meNm);
return t;
}
if (hasPh) t = t.split('{ta}').join(__taNm).split('{me}').join(__meNm);
return t;
}
function quoteHtml(q, side) {
const __fitQ = (side !== 'out') && !!window.taFit;
const FQ = (s) => (__fitQ ? window.taFit(s) : s);
if (q && typeof q === 'object') {
// #148：图片载荷除 data: 外还有媒体池令牌 @@m:hash——令牌照常渲染成 <img src>，
// 渲染期由 media-pool 文档级观察器解析成池数据（与消息本体图片同一机制）
const isQM = (s) => typeof s === 'string' && (s.indexOf('data:') === 0 || (window.mochiMediaIsToken && window.mochiMediaIsToken(s)));
const imgs = (q.imgs || []).filter(isQM).slice(0, 3);
const t = quoteTextSafe(q.t);
const tHtml = (t && t.indexOf('data:') !== 0 && !(imgs.length && QUOTE_PLACEHOLDER.test(t))) ? (window.mochiInlineTextHtml ? window.mochiInlineTextHtml(FQ(t)) : escTxtBr(FQ(t))) : ''; // FIX 2026-09-13 #394 引用块内嵌令牌转图
let inner = '';
if (imgs.length) inner += '<span class="msg-quote-imgs">' + imgs.map(s => '<img class="msg-quote-img" src="' + attrEsc(s) + '" alt="图片" loading="lazy" decoding="async">').join('') + '</span>';
if (tHtml) inner += '<span class="msg-quote-text">' + tHtml + '</span>';
return '<div class="msg-quote">' + inner + '</div>';
}
if (typeof q === 'string' && (q.indexOf('data:') === 0 || (window.mochiMediaIsToken && window.mochiMediaIsToken(q)))) {
return '<div class="msg-quote"><img class="msg-quote-img" src="' + attrEsc(q) + '" alt="图片" loading="lazy" decoding="async"></div>';
}
const qs = quoteTextSafe(q);
return '<div class="msg-quote"><span class="msg-quote-text">' + (window.mochiInlineTextHtml ? window.mochiInlineTextHtml(FQ(qs)) : escTxtBr(FQ(qs))) + '</span></div>'; // FIX 2026-09-13 #394 引用块内嵌令牌转图
}
let inplaceDrafts = {};
// v3.28.x：当前聚焦的互动卡片输入栏下标。联系人新消息触发整窗重渲染（renderWindow）会
// 重建输入框，若不在重建后回补 focus，安卓会收起输入法、卡片像被收起，打断用户输入。
// 用 document focusin/focusout 跟踪（contenteditable `.ce-box` 上 activeElement 常为 body，
// 单看 activeElement 不可靠；focusin 能命中 ceBox，故以此为权威）。
let inplaceFocusIdx = -1;
document.addEventListener('focusin', (e) => {
  const t = e.target;
  if (!t || t.nodeType !== 1 || !t.closest) return;
  if (!t.closest('.msg-inplace')) return;
  const item = t.closest('.msg-ask');
  inplaceFocusIdx = item && item.dataset.idx !== undefined ? Number(item.dataset.idx) : -1;
});
document.addEventListener('focusout', () => {
  const ae = document.activeElement;
  if (ae && ae.nodeType === 1 && ae.closest && ae.closest('.msg-inplace')) return;
  inplaceFocusIdx = -1;
});
function inplaceTypeOf(rec) {
if (!rec) return null;
if (rec.special === 'ask-choose') return 'choose';
if (rec.special === 'ask-curious') return 'curious';
if (rec.special === 'ask-roast') return 'roast';
if (rec.special === 'ask-card') return 'ask';
return null;
}
function collectInplaceDrafts() {
if (!body) return;
inplaceDrafts = {};
// 快照当前聚焦下标：这里是清空 body 前唯一能读到「仍在聚焦」的位置（focusout 在
// innerHTML='' 时才触发）。activeElement 命中 input 或它的 ceBox 都算聚焦，作为兜底。
try {
const ae = document.activeElement;
if (ae && ae.nodeType === 1 && ae.closest && ae.closest('.msg-inplace')) {
const fi = ae.closest('.msg-ask');
if (fi && fi.dataset.idx !== undefined) inplaceFocusIdx = Number(fi.dataset.idx);
}
} catch (e) {}
body.querySelectorAll('.msg-ask[data-idx] .msg-inplace input.ip-input').forEach(inp => {
const item = inp.closest('.msg-ask');
if (!item || item.dataset.idx === undefined) return;
const idx = Number(item.dataset.idx);
const t = inplaceTypeOf(msgs[idx]);
if (t && (inp.value || '').trim()) inplaceDrafts[idx] = { type: t, value: inp.value };
});
// 若 focusin 跟踪的下标在当前渲染里指向已作答卡片则失效；未作答的（含空输入）保留，
// 以便重渲染后重开输入栏、维持焦点不被打断
if (inplaceFocusIdx >= 0) {
const ridx = msgs[inplaceFocusIdx];
if (ridx && inplaceTypeOf(ridx) !== null && inplaceAnswered(ridx)) inplaceFocusIdx = -1;
}
}
function inplaceAnswered(rec) {
if (!rec) return true;
return (
(rec.special === 'ask-choose' && rec.choiceStatus === 'answered') ||
(rec.special === 'ask-curious' && rec.curiousStatus === 'answered') ||
(rec.special === 'ask-roast' && rec.roastStatus === 'answered') ||
(rec.special === 'ask-card' && rec.askStatus === 'answered')
);
}
function restoreInplaceDrafts() {
if (!body) return;
Object.keys(inplaceDrafts).forEach(k => {
const idx = Number(k);
const d = inplaceDrafts[k];
if (!d || !d.type || d.type === 'choose') { delete inplaceDrafts[k]; return; } // 单选无输入框，草稿无效
const item = body.querySelector('.msg-ask[data-idx="' + idx + '"]');
if (!item || item.querySelector('.msg-inplace')) return;
const rec = msgs[idx];
if (!rec || !d.value) { delete inplaceDrafts[k]; return; }
const done =
(d.type === 'curious' && rec.curiousStatus === 'answered') ||
(d.type === 'roast' && rec.roastStatus === 'answered') ||
(d.type === 'ask' && rec.askStatus === 'answered');
if (done) { delete inplaceDrafts[k]; return; }
if (!expandCardInPlace(idx, d.type)) { delete inplaceDrafts[k]; return; }
const inp = body.querySelector('.msg-ask[data-idx="' + idx + '"] .msg-inplace input.ip-input');
if (inp) {
inp.value = d.value;
try {
const r = document.createRange();
const box = inp.__ceBox || inp;
r.selectNodeContents(box);
r.collapse(false);
const s = window.getSelection();
s.removeAllRanges();
s.addRange(r);
} catch (e) {}
// v3.28.x：重建后若正是重渲染前聚焦的那张卡片，回补焦点，让输入法保持弹出、不被收起
if (inplaceFocusIdx === idx) {
setTimeout(() => { try { inp.focus(); } catch (e) {} }, 0);
}
}
});
// v3.28.x：聚焦但还没打字的输入栏不在草稿字典里，重建后补开输入栏，维持焦点不被打断
// （expandCardInPlace 内部会对输入框 refocus）
if (inplaceFocusIdx >= 0) {
const idx = inplaceFocusIdx;
const item = body.querySelector('.msg-ask[data-idx="' + idx + '"]');
if (item && !item.querySelector('.msg-inplace')) {
const rec = msgs[idx];
const type = inplaceTypeOf(rec);
if (type && !inplaceAnswered(rec)) try { expandCardInPlace(idx, type); } catch (e) {}
}
}
}
function expandCardInPlace(idx, type) {
const el = body.querySelector('.msg-ask[data-idx="' + idx + '"]');
if (!el) return false;
const rec = msgs[idx];
if (!rec) return false;
if (el.querySelector('.msg-inplace')) { el.querySelector('.msg-inplace').remove(); delete inplaceDrafts[idx]; return true; }
const done =
(type === 'choose' && rec.choiceStatus === 'answered') ||
(type === 'curious' && rec.curiousStatus === 'answered') ||
(type === 'roast' && rec.roastStatus === 'answered') ||
(type === 'ask' && rec.askStatus === 'answered');
if (done && type === 'ask' && (rec.askType === 'single' || rec.askType === 'multi') && Array.isArray(rec.askOptions) && rec.askOptions.length) {
const card = el.querySelector('.msg-ask-card');
if (!card) return false;
const wrap = document.createElement('div');
wrap.className = 'msg-inplace';
const chosen = String(rec.askAnswer || '');
(rec.askOptions || []).forEach(o => {
const row = document.createElement('div');
// #1415：多选题的答案是「A、B」整串，逐格比全文会一灰到底——交给 mochiAnswerHits 按段判
row.className = 'ip-opt-row' + (window.mochiAnswerHits && window.mochiAnswerHits(String(o.t || ''), chosen) ? ' sel' : '');
let replyTxt = '';
if (Array.isArray(o.reply) && o.reply.length) {
const arr = o.reply.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
if (arr.length === 1) replyTxt = arr[0];
else if (arr.length > 1) replyTxt = arr[0] + ' 等' + arr.length + '条';
} else if (typeof o.reply === 'string' && o.reply.trim()) {
replyTxt = o.reply.trim();
}
row.innerHTML = '<span class="ip-opt-t">' + escTxt(String(o.t || '')) + '</span>' +
(replyTxt ? '<span class="ip-opt-reply">' + escTxt(replyTxt) + '</span>' : '');
wrap.appendChild(row);
});
card.appendChild(wrap);
return true;
}
if (done) return false;
const card = el.querySelector('.msg-choose-card, .msg-ask-card');
if (!card) return false;
const wrap = document.createElement('div');
wrap.className = 'msg-inplace';
if (type === 'choose') {
const opts = rec.choiceOptions || [];
if (!opts.length) return false;
opts.forEach((o, i) => {
const b = document.createElement('button');
b.className = 'ip-opt';
b.textContent = String(o.t || '');
b.addEventListener('click', () => {
const prefIdx = typeof rec.choicePref === 'number' ? rec.choicePref : 0;
const prefTxt = opts[prefIdx] ? opts[prefIdx].t : '';
const isPref = i === prefIdx;
const isLiked = o.liked === true || o.liked === 'true';
const matchTxt = isPref ? '✦ 刚好想到了一起'
: isLiked ? '你们想得不一样，不过TA似乎很喜欢你的答案'
: '这次没有选到一起。TA心里想的是：「' + prefTxt + '」';
if (window.chatChooseReply) window.chatChooseReply(idx, String(o.t || ''), o, matchTxt);
if (window.logFish) window.logFish();
});
wrap.appendChild(b);
});
} else if (type === 'ask' && (rec.askType === 'multi' || rec.type === 'multi')) {
// #1415：多选题手动作答＝勾选＋提交两拍（单选题保持「点一下就落地」不动）。
// 这里不能沿用单选那条「点即答」的按钮：一次点选只表达一个答案，多选必须有第二拍才算数。
const opts = Array.isArray(rec.askOptions) ? rec.askOptions : (Array.isArray(rec.options) ? rec.options : []);
if (!opts.length) return false;
const rows = [];
const picked = [];
// #1480：题自带「最多N」（批量问卷/题库导入的「（多选·最多2）」标记经 pushAsk 透传成 askMultiMax）
// 就给手动作答也上同一道闸——限 2 勾第 3 个点不动并说明；没带＝0＝不限，与改前行为逐字相同。
const capN = (rec.askMultiMax >= 2 && rec.askMultiMax <= 6) ? rec.askMultiMax : 0;
const btn = document.createElement('button');
btn.className = 'ip-multi-submit';
btn.type = 'button';
const syncSubmit = () => {
btn.disabled = !picked.length;
btn.textContent = picked.length ? '提交（已选 ' + picked.length + (capN ? '/' + capN : '') + ' 个）' : '先勾选答案';
};
// 所选选项各自写过的「~TA回应」并成一份候选，交给 chatAskReply 抽一条（一条都没有＝走预设池）
const repliesOf = o => {
const r = o && o.reply;
if (Array.isArray(r)) return r.filter(s => typeof s === 'string' && s.trim());
if (typeof r === 'string') return r.split(';').map(s => s.trim()).filter(Boolean);
return [];
};
opts.forEach(o => {
const t = String((o && o.t) || '');
const row = document.createElement('div');
row.className = 'ip-opt-row ip-opt-chk';
const replyArr = repliesOf(o);
row.innerHTML = '<span class="ip-opt-box"></span><span class="ip-opt-t">' + escTxt(t) + '</span>' +
(replyArr.length ? '<span class="ip-opt-reply">' + escTxt(replyArr.length > 1 ? replyArr[0] + ' 等' + replyArr.length + '条' : replyArr[0]) + '</span>' : '');
row.addEventListener('click', () => {
const at = picked.indexOf(t);
if (at < 0 && capN && picked.length >= capN) { toast('这题最多选 ' + capN + ' 个'); return; }
if (at >= 0) picked.splice(at, 1); else picked.push(t);
row.classList.toggle('on', at < 0);
syncSubmit();
});
rows.push({ row: row, t: t, o: o });
wrap.appendChild(row);
});
btn.addEventListener('click', () => {
if (!picked.length) return;
const chosen = rows.filter(r => picked.indexOf(r.t) >= 0);
const answers = [];
const replies = [];
chosen.forEach(r => { answers.push(r.t); repliesOf(r.o).forEach(s => replies.push(s)); });
if (window.chatAskReply) window.chatAskReply(idx, answers.join('、'), replies.length ? replies : undefined);
if (window.logFish) window.logFish();
});
wrap.appendChild(btn);
syncSubmit();
} else if (type === 'ask' && (rec.askType === 'single' || (rec.type === 'single' && Array.isArray(rec.options) && rec.options.length))) {
const opts = Array.isArray(rec.askOptions) ? rec.askOptions : (Array.isArray(rec.options) ? rec.options : []);
if (!opts.length) return false;
opts.forEach((o, i) => {
const b = document.createElement('button');
b.className = 'ip-opt';
b.textContent = String(o.t || '');
b.addEventListener('click', () => {
// v3.43.x #447：单选题点选项——「回应接聊天字卡/词典」开关开启时同样走普通聊天完整链路
//（公用+专属字卡+系统字卡+词典拼字，genChatStyleReply raw 直传），不再走 90/10 预设混合；
// 未掷中/开关关＝原选项预设回应路径不变
let _cr = null;
if (window.taAskChatReplyOn && window.taAskChatReplyOn() && window.genChatStyleReply) _cr = window.genChatStyleReply();
if (_cr && window.chatAskReply) window.chatAskReply(idx, String(o.t || ''), _cr, { raw: true });
else if (window.chatAskReply) window.chatAskReply(idx, String(o.t || ''), o.reply);
if (window.logFish) window.logFish();
});
wrap.appendChild(b);
});
} else {
const quicks = (type === 'curious' ? (rec.curiousQuick || []) : []).filter(q => typeof q === 'string' && q);
if (quicks.length) {
const chips = document.createElement('div');
chips.className = 'ip-chips';
quicks.forEach(q => {
const c = document.createElement('button');
c.className = 'ip-chip';
c.textContent = q;
c.addEventListener('click', () => { try { inp.value = q; inp.focus(); } catch (e) {} });
chips.appendChild(c);
});
wrap.appendChild(chips);
}
const row = document.createElement('div');
row.className = 'ip-row';
const inp = document.createElement('input');
inp.className = 'ip-input';
inp.type = 'text';
inp.placeholder = type === 'roast' ? (window.taFit ? window.taFit('回 TA 一句…') : '回 TA 一句…') : '输入你的回答…';
const send = document.createElement('button');
send.className = 'ip-send';
send.textContent = type === 'roast' ? (window.taFit ? window.taFit('回TA') : '回TA') : '回答';
const doSend = () => {
const v = (inp.value || '').trim();
if (!v) return;
// FIX 2026-09-30 #1462：提交前先收键盘（口径同 #512 askDismissIme／#542 弹窗 close——blur 先行）。
// 就地作答框（.ip-input，安卓已转 .ce-box）此刻持有焦点，随后 chatAskReply/chatCuriousReply/
// chatRoastReply 把整张卡 el.innerHTML 换成「已回答」＝聚焦中的可编辑元素被「元素移除」带走
// 而不是「失焦收起」——一批内核/输入法不为这种移除派 focusout、也不派（或极迟才派）
// visualViewport.resize，移动适配收键盘链四条复原路全拿不到证据 → .phone 内联收缩高停在键盘期
// 数值，只能等「2.2s 无活动」看门狗兜底＝「答完题输入法收起很慢、键盘位那半边灰底」（红米 K80
// Chrome 复报，作者明说其他机型也有；#512 修问问TA半框、#542 修通用弹窗，就地作答是同根因第三处）。
// 先 blur 走标准失焦链（focusout 必派发），再向移动层报备一次有界兜底（连 focusout 都不派的内核）。
// 零机型分支：无聚焦时 blur 与报备均为空操作，iOS（不转 ce-box）与桌面行为不变。
try { inp.blur(); } catch (eKb) {}
if (window.mochiKbDismiss) { try { window.mochiKbDismiss(); } catch (eKd) {} }
if (type === 'curious' && window.chatCuriousReply) {
const replies = (rec.curiousReplies && rec.curiousReplies.length) ? rec.curiousReplies : ['嗯，我记住了。', '原来是这样。', '好，我记住了。'];
const reply = (window.pickAskCardReply ? window.pickAskCardReply(replies) : replies[Math.floor(Math.random() * replies.length)]);
const fw = (rec.curiousFollowup && Math.random() < 0.3) ? rec.curiousFollowup : null;
window.chatCuriousReply(idx, v, reply, fw);
} else if (type === 'roast' && window.chatRoastReply) {
const defs = ['你觉得我会信？', '少骗我。', '哼。', '好吧好吧。', '就这一次？', '行吧，放过你。', '嗯，这还差不多。'];
const pool = window.getInteractPool ? window.getInteractPool('吐槽·回应', defs) : defs;
const reply = (window.pickAskCardReply ? window.pickAskCardReply(pool) : pool[Math.floor(Math.random() * pool.length)]);
window.chatRoastReply(idx, v, reply);
} else if (type === 'ask' && window.chatAskReply) {
const defs = ['收到你的回答。', '好呀，我知道了。', '你这么说，我记住了。'];
const pool = window.getInteractPool ? window.getInteractPool('询问·回应', defs) : defs;
// FIX 2026-09-17 #648 与吐槽/好奇分支同款走 pickAskCardReply（预设池媒体守卫）——
// 原裸抽 pool[random] 会把功能池里混入的媒体卡原样发进 rec.askReply＝互动卡直出令牌串
window.chatAskReply(idx, v, (window.pickAskCardReply ? window.pickAskCardReply(pool) : pool[Math.floor(Math.random() * pool.length)]));
}
if (window.logFish) window.logFish();
delete inplaceDrafts[idx];
};
send.addEventListener('click', doSend);
inp.addEventListener('keydown', (e) => {
if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); doSend(); }
});
row.appendChild(inp);
row.appendChild(send);
wrap.appendChild(row);
const draft = inplaceDrafts[idx];
if (draft && draft.type === type && draft.value) {
inp.value = draft.value;
}
inp.addEventListener('input', () => {
inplaceDrafts[idx] = { type: type, value: inp.value || '' };
});
}
card.appendChild(wrap);
const fi = wrap.querySelector('input.ip-input');
if (fi) setTimeout(() => { try { fi.focus(); } catch (e) {} }, 60);
return true;
}
if (body) {
let rpPressTimer = null;
let rpPressSuppressClick = false;
body.addEventListener('pointerdown', (e) => {
const rpCard = e.target.closest('.msg-rp-card');
if (!rpCard) return;
const rpItem = rpCard.closest('.msg-rp');
if (!rpItem || rpItem.dataset.idx === undefined) return;
const rpShownDEl = rpItem.querySelector('.msg-rp-status');
const rpShownD = rpShownDEl ? rpShownDEl.textContent : '';
const rpHitD = msgRecFromEl(rpItem, function (m) { return rpStatusText(m) === rpShownD; }); // #1477：下标快路径＋data-mk 身份校正；同身份多份取与显示一致那份
if (!rpHitD) return;
const rpRec = rpHitD.rec;
if (!rpRec || rpRec.special !== 'redpacket' || (rpRec.rpStatus || 'pending') !== 'pending' || rpRec.side === 'out') return;
rpPressTimer = setTimeout(() => {
rpPressTimer = null;
rpPressSuppressClick = true;
if (window.openModal) {
window.openModal('退回这个红包？', '', () => {
rpRec.rpStatus = 'returned';
const w = rpWalletGet();
w.systemBalance += Math.round((rpRec.rpAmount || 0) * 100);
rpWalletSet(w);
saveMsgsNow();
if (!rpPatchStatusInPlace(msgs.indexOf(rpRec))) renderWindow(true, true); // FIX 2026-09-07 #230 红包状态流转不整窗重建（闪屏）
const amtTxt = '（心意币 ¥' + Number(rpRec.rpAmount || 0).toFixed(2) + '）';
setTimeout(() => addIn('你退回了红包' + amtTxt, { special: 'poke', nightAllow: true, rateAllow: true }), randInt(300, 800));
}, { okText: '退回', cancelText: '取消' });
}
}, 500);
});
const rpClearPress = () => { if (rpPressTimer) { clearTimeout(rpPressTimer); rpPressTimer = null; } };
body.addEventListener('pointerup', rpClearPress);
body.addEventListener('pointerleave', rpClearPress);
body.addEventListener('pointercancel', rpClearPress);
body.addEventListener('click', (e) => {
// #1005 问卷卡也进「点卡片浮现收藏」这一套：守卫必须认得 .msg-survey-card，否则点问卷卡时
// 会先被这里把它自己的 .show-fav 抹掉再补上（切不成开关）；点卡片外也要能把它的心形收起来。
if (!e.target.closest('.msg-ask-card, .msg-choose-card, .msg-survey-card, .msg-fav-heart, .msg-inplace')) {
body.querySelectorAll('.msg-ask-card.show-fav, .msg-choose-card.show-fav, .msg-survey-card.show-fav').forEach(c => c.classList.remove('show-fav'));
}
const favBtn = e.target.closest('.msg-fav-heart');
if (favBtn) {
e.stopPropagation();
// v3.28.x：心形不只挂在 .msg-ask 家族（红包/送花/礼物/佳肴是 .msg-rp/.msg-flower/.msg-gift），
// 改为按最近的 data-idx 容器定位，保证所有带心形的互动卡片都能收藏
const fItem = favBtn.closest('[data-idx]');
if (fItem && fItem.dataset.idx !== undefined) window.favCardFromMsg(Number(fItem.dataset.idx));
return;
}
// #985：礼物卡的【领取】与【回复】——两条都只对「联系人送我的礼物」出现（giftSelf 的 TA 自买卡
// 与历史卡不响应）。按钮点击必须 stopPropagation：礼物卡在 msg 容器内，冒泡上去会顶掉卡片自身的
// 手势层（同下面心愿卡【送 TA】的口径）。
const giftClaimBtn = e.target.closest('.msg-gift-claim');
if (giftClaimBtn) {
e.stopPropagation();
const gItem = giftClaimBtn.closest('[data-idx]');
const gIdx = gItem && gItem.dataset.idx !== undefined ? Number(gItem.dataset.idx) : -1;
const gRec = gIdx >= 0 ? msgs[gIdx] : null;
if (!gRec || gRec.special !== 'gift' || !giftIsIncoming(gRec)) return;
giftClaimNow(gIdx);
return;
}
const giftReplyBtn = e.target.closest('.msg-gift-reply');
if (giftReplyBtn) {
e.stopPropagation();
const grItem = giftReplyBtn.closest('[data-idx]');
const grIdx = grItem && grItem.dataset.idx !== undefined ? Number(grItem.dataset.idx) : -1;
const grRec = grIdx >= 0 ? msgs[grIdx] : null;
if (!grRec || grRec.special !== 'gift' || !giftIsIncoming(grRec)) return;
giftReplyNow(grIdx);
return;
}
// v3.26.x #660：聊天里「TA 的心愿」卡片点【送 TA】——复用市集购买弹窗（gift-shop 侧同一扣款 /
// 心意柜 / 聊天送礼链路），成交回调把这张卡就地转「已送出」（不整窗重建，同红包 #230 口径）
// #1316：回调不再动「点击时捕获的 wItem」（那是一次性补丁，中途重画就落在旧节点上），成交只负责说出
// 「这件心愿兑现了」这个事实，屏上每一张心愿卡按同一把尺子重判——含同款商品的兄弟卡片。
const wishBuyBtn = e.target.closest('.msg-wish-buy');
if (wishBuyBtn) {
e.stopPropagation();
const wItem = wishBuyBtn.closest('.msg-wish');
const wIdx = wItem && wItem.dataset.idx !== undefined ? Number(wItem.dataset.idx) : -1;
const wRec = wIdx >= 0 ? msgs[wIdx] : null;
if (!wRec || wRec.special !== 'wish' || !window.giftBuyFromWishCard) { toast('这张卡片已经翻篇啦'); return; }
window.giftBuyFromWishCard(wRec, function () { chatWishSettled(wRec.wishGiftId); });
return;
}
const rpCard = e.target.closest('.msg-rp-card');
if (rpCard) {
if (rpPressSuppressClick) { rpPressSuppressClick = false; return; }
e.stopPropagation();
const rpItem = rpCard.closest('.msg-rp');
if (!rpItem || rpItem.dataset.idx === undefined) return;
const rpShownEl = rpItem.querySelector('.msg-rp-status');
const rpShown = rpShownEl ? rpShownEl.textContent : '';
const rpHit = msgRecFromEl(rpItem, function (m) { return rpStatusText(m) === rpShown; }); // #1477：旧下标会把同屏别的消息当成这张卡；同身份多份时取「与卡片显示一致」那份
if (!rpHit) return;
const rpIdx = rpHit.idx;
const rpRec = rpHit.rec;
if (!rpRec || rpRec.special !== 'redpacket') return;
if ((rpRec.rpStatus || 'pending') !== 'pending') return; // #1477：与卡片状态文案同口径（falsy＝待领取）
if (rpRec.side === 'out') { toast(window.taFit ? window.taFit('等待 TA 领取') : '等待 TA 领取'); return; } // #1477：与「我 发出」渲染同侧判据（side 缺失的历史卡＝联系人发出，可领）
rpRec.rpStatus = 'received';
rpRec.rpOpenedAt = Date.now();
const wallet = rpWalletGet();
wallet.myBalance += Math.round((rpRec.rpAmount || 0) * 100);
rpWalletSet(wallet);
saveMsgsNow();
const amtTxt = '（心意币 ¥' + Number(rpRec.rpAmount || 0).toFixed(2) + '）';
// FIX 2026-09-15 #517 用户要求：领取联系人发来的红包不再弹黑色提示浮层（#cc-toast 黑底白字，见
// chat-pages.css 的 #cc-toast / chat.js 的 toast()）。领取反馈已有两处、信息零丢失——①卡片自身状态
// 就地转「已领取」（rpPatchStatusInPlace，不重建窗口）②聊天里 poke 留痕「你领取了红包（心意币 ¥x）」。
// 黑色浮层只是重复打扰。勿恢复：原为 toast('已领取' + amtTxt);
// 注：本条上方「等待 TA 领取」的 toast 是无效操作提示（点自己发出的未领红包），语义不同，保留。
if (!rpPatchStatusInPlace(rpIdx)) renderWindow(true, true); // FIX 2026-09-07 #230 红包状态流转不整窗重建（闪屏）
setTimeout(() => addIn('你领取了红包' + amtTxt, { special: 'poke', nightAllow: true, rateAllow: true }), randInt(400, 1000));
// v3.29.x #807：红包领后捎一句话（我领 TA 的红包方向）——等 poke 留痕落地后再掷概率，别抢在留痕前
setTimeout(() => rpCollectFeedback('in'), randInt(1100, 2200));
return;
}
if (e.target.closest('.msg-inplace')) return;
// v3.33.x #523：批量问卷卡片点击 → 打开只读「问卷详情」（题干+选项+TA 的作答），
// 不再跳批量设置问卷页（用户报「点已交卷卡片却打开了批量设置问卷的页面」）
const surveyCard = e.target.closest('.msg-survey-card');
if (surveyCard) {
e.stopPropagation(); // 不冒泡触发气泡操作菜单
// #1005 收藏心形默认隐藏、点卡片才浮现（再点卡片外收起）——用户报「批量设置问卷后发送到聊天里
// 的卡片直接显示了收藏的按钮」。与单题卡同一套 .show-fav 开关：先记本次点击前的状态，清掉别处
// 已浮现的心形后按需加回本卡（＝点一下浮现、再点一下收起），随后照旧打开问卷详情。
const sHadFav = surveyCard.classList.contains('show-fav');
body.querySelectorAll('.msg-ask-card.show-fav, .msg-choose-card.show-fav, .msg-survey-card.show-fav').forEach(c => c.classList.remove('show-fav'));
if (!sHadFav) surveyCard.classList.add('show-fav');
const sItem = surveyCard.closest('.msg-survey');
const sIdx = sItem && sItem.dataset.idx !== undefined ? Number(sItem.dataset.idx) : -1;
const sRec = sIdx >= 0 ? msgs[sIdx] : null;
if (window.openSurveyDetail && sRec) window.openSurveyDetail(sRec);
else if (window.openAskSurvey) window.openAskSurvey();
return;
}
const card = e.target.closest('.msg-ask-card, .msg-choose-card');
if (!card) return;
const item = card.closest('.msg-ask');
if (!item || item.dataset.idx === undefined) return;
const idx = Number(item.dataset.idx);
const rec = msgs[idx];
if (!rec) return;
if (card.classList.contains('answered') && rec.special === 'ask' && (rec.askType === 'single' || rec.askType === 'multi') && Array.isArray(rec.askOptions) && rec.askOptions.length) {
e.stopPropagation();
const hadFav = card.classList.contains('show-fav');
body.querySelectorAll('.msg-ask-card.show-fav, .msg-choose-card.show-fav').forEach(c => c.classList.remove('show-fav'));
if (!hadFav) card.classList.add('show-fav');
expandCardInPlace(idx, 'ask');
return;
}
const hadFav = card.classList.contains('show-fav');
body.querySelectorAll('.msg-ask-card.show-fav, .msg-choose-card.show-fav').forEach(c => c.classList.remove('show-fav'));
if (!hadFav) card.classList.add('show-fav');
if (card.classList.contains('answered')) { e.stopPropagation(); return; } // 已作答：只切换收藏按钮
e.stopPropagation(); // 不冒泡触发气泡操作菜单
let type = null;
if (rec.special === 'ask-choose') type = 'choose';
else if (rec.special === 'ask-curious') type = 'curious';
else if (rec.special === 'ask-roast') type = 'roast';
else if (rec.special === 'ask-card') type = 'ask';
if (!type) return;
const ok = expandCardInPlace(idx, type);
if (!ok) {
try {
if (type === 'choose' && window.openTC) window.openTC(idx);
else if (type === 'curious' && window.openCurious) window.openCurious(idx);
else if (type === 'roast' && window.openRoast) window.openRoast(idx);
else if (type === 'ask' && window.openAskReply) window.openAskReply(idx);
} catch (err) {}
}
});
}
// FIX 2026-09-16 #572d（用户点名：要「我原来的模式」）：查看原文恢复原来的「点一下在气泡里就地
// 展开、再点收回」。浮层版（#572b/#572c）用户不要——不管浮层内容怎么还原排版，它本质还是弹窗，
// 不是「那条消息在聊天流里变回原文」。故 #572b/#572c 的浮层实现与 #572 的滚动补偿一并撤销，交互与
// 观感回到原样。
// 唯一保留的改动是兜底渲染：原来无快照的存量消息走 rec.orig → rec.text 的裸文本直出，会把整屏 base64
// 铺进气泡（语音那条实测气泡 45px→1599px、列表高度 1492→3038）、字卡里的 HTML 还会被当标签执行
//（群聊 #244 已按安全口径修，单聊这里对齐）。有快照的常规路径一字未动。
// 另注：就地展开＝该气泡当场变高，纵向列表必然被推动（下面消息下移 dH；开内核滚动锚定时改成上面
// 上移 dH）——这是「就地展开」自带的语义，不是回归，用户明确要这个模式，故不再做任何滚动补偿。
function retractSafeHtml(rec) {
const raw = String(rec && rec.text != null ? rec.text : '');
const parts = (rec && Array.isArray(rec.parts)) ? rec.parts : null;
const isImgSrc = (s) => typeof s === 'string' && !!s && chatIsImgSrcLike(s); // FIX 2026-09-20 #948 同口径收口（旧判据漏大写 MIME/前导空白/裸令牌）
let text = raw;
const imgs = [];
if (parts && parts.length) {
text = parts.filter(p => p && p.k === 'text').map(p => p.v).join(' ');
parts.forEach(p => { if (p && p.k === 'img' && p.v) imgs.push(p.v); });
}
const textIsImg = isImgSrc(text);
if (!imgs.length && textIsImg) imgs.push(text);
const isVoice = (rec && rec.type === 'voice') || raw.indexOf('|||') >= 0;
// FIX 2026-09-16 #572e（用户点检「原内容和 tag 能不能正常显示」）：无快照兜底也要把情绪字卡 tag 渲染出来
// ——有快照时 tag 随 rec.orig 那份气泡 HTML 一起回来（快照是撤回瞬间的 innerHTML，情绪块就在里面），
// 但无快照的老消息走本兜底，旧口径只给文本 ⇒ tag 会凭空消失。此处按 renderMsg 的情绪块同款标记渲染
//（.msg-moods > .msg-mood[.msg-intent] > .msg-mood-tag + 文案），并跳过已被撤回的那几条
//（rec.retractedMood，与 partialRetractMsg 的口径一致），口径与群聊/收藏同源。
let html = '';
if (imgs.length) html += imgs.slice(0, 3).map(s => '<img class="msg-img msg-img-sm" src="' + attrEsc(s) + '" alt="撤回的图片">').join('');
if (isVoice) html += '<span style="opacity:.85">[语音] ' + escTxt(raw.split('|||')[0] || '') + '</span>';
else if (!textIsImg && text.trim()) html += '<span style="opacity:.85;word-break:break-word">' + (window.mochiInlineTextHtml ? window.mochiInlineTextHtml(quoteDisplayFit(text, rec.side)) : escTxtBr(quoteDisplayFit(text, rec.side))) + '</span>'; // FIX 2026-09-17 #648 撤回无快照兜底同走内嵌令牌助手（混排令牌不再直出，与 #385 撤回段同口径）
const moods = (rec && Array.isArray(rec.mood)) ? rec.mood : [];
const liveMoods = moods.filter((md, mi) => md && String(md.tag || '').trim() && !srcTagHidden(md.tag) && !(rec.retractedMood && rec.retractedMood.indexOf(mi) >= 0));
if (liveMoods.length) {
html += '<div class="msg-moods">' + liveMoods.map(md => {
const tg = escTxt(String(md.tag == null ? '' : md.tag));
const lb = md.label == null ? '' : String(md.label);
const dup = lb !== '' && lb === String(rec.text == null ? '' : rec.text);
const cls = (md.tag === '交流意图') ? 'msg-mood msg-intent' : 'msg-mood';
return '<div class="' + cls + '"><span class="msg-mood-tag">' + tg + '</span>' + (dup || lb === '' ? '' : '<span>' + escTxt(quoteDisplayFit(lb, rec.side)) + '</span>') + '</div>';
}).join('') + '</div>';
}
return html || '<span style="opacity:.5;font-size:12px">（这条消息没有可显示的原文）</span>';
}
function bindToggle(b, side) {
const who = side === 'out' ? '我' : '对方';
b.style.cursor = 'pointer';
b.onclick = function () {
if (b.dataset.showing === '1') {
b.innerHTML = '<span style="opacity:.6;font-size:12px;cursor:pointer">' + who + '撤回了一条消息</span>';
b.dataset.showing = '0';
} else {
b.innerHTML = b.dataset.orig;
b.dataset.showing = '1';
}
chatRetractToggleAfter('toggle'); // #871：展开/收起＝滚动区内容高突变，按钉住/解钉两态做贴底或落定重落
};
}
// FIX 2026-09-19 #871（iPhone 12 Pro Max Safari 实报「展开撤回消息再收起／贴底轻划／划太快／点
// 撤回字卡明细再打开，气泡和头像错位」，用户注明多机型同现）：就地展开/收起与「撤回 N 条字卡▾」
// 明细开合都是**滚动容器内的高度突变**，无头实证 DOM 几何逐像素复原（错位不在布局层）——错位出
// 自表现层：高度在滚动会话中途增减后，WebKit 的滚动树仍可按旧偏移呈现旧瓦片；而程序化 scrollTop
// 修正要么缺席（解钉态零接管，靠内核钳位），要么迟到（钉住态等 250ms 看门狗，窗口里最后一行先被
// 推出屏再弹回），要么对打（#162 图片 onload 双写是唯一没接 #716/#765 让路闸的写手，手势/惯性
// 进行中当场写 scrollTop）。修法＝统一纪律，零机型分支，全部复用 #861 的落定锁：
//   ①三处开合动作收尾走本助手：钉住态立即贴底（消掉 250ms 推出-弹回窗口）＋交 #861 落定锁复核
//     一次（几何/滚动静默后补写，防内核丢写）；解钉态走 chatResyncScrollQuiet——滚动/触摸静默后
//     显式钳回真实 max（收起缩短内容时 scrollTop>max 的超界不再依赖内核钳位时机）＋同值重落一枪
//     （强制滚动树对新几何重对齐；Blink/Gecko 对同值写零副作用，健康引擎零变化）。
//   ②#162 图片 onload 补滚接让路闸：滚动/触摸进行中不当场写，交 #861 落定锁；静默态保持原双写
//     快路（#504 契约不变）。
// #572d 既定语义不动：展开/收起对下方内容的推挤不做锚定补偿。
function chatRetractToggleAfter(kind) {
if (batchRendering || !chatVisible()) return;
if (chatPinnedBottom) { scrollChatBottom(); chatRepinAfterSettle(); }
else chatResyncScrollQuiet(kind);
}
let _rsyncT = null;
let _rsyncDeadline = 0;
function chatResyncScrollQuiet(kind) {
if (_rsyncT || chatPinnedBottom) return; // 钉住态归 #861 落定锁管，不双排
_rsyncDeadline = Date.now() + 1200;
_rsyncT = setTimeout(chatResyncStep, 120);
}
function chatResyncStep() {
_rsyncT = null;
const now = Date.now();
if (!chatVisible() || chatPinnedBottom) return; // 等待期用户已回钉＝归 #861 管
if (!chatRepinQuietEnough(now)) { if (now < _rsyncDeadline) _rsyncT = setTimeout(chatResyncStep, 120); return; }
const cb = document.getElementById('chat-body');
if (!cb) return;
const realMax = cb.scrollHeight - cb.clientHeight;
cb.scrollTop = Math.min(cb.scrollTop, realMax); // 超界显式钳回；未超界＝同值重落（滚动树重对齐）
}
let batchRendering = false;
let pendingOutScroll = false;
let appendTarget = null;
// FIX 2026-09-20 #878（用户报障「聊天里发送的礼物卡片没有任何动画缓冲突然出现很突兀，
// 互动卡片都有这个问题」）：入场动画类原先在 renderMsg 建节点时加（原 4405 行位置），
// 但礼物/互动卡/文本等**所有**分支随后都以 m.className = 'msg-gift'/'msg-ask'/'msg …'
// 整体覆盖 className，msg-enter 在挂载前就被抹掉＝动画实际从未触发。类补加挪到
// appendMsg 挂载前（此处恒在各分支覆盖之后）；batchRendering 闸口径不变：
// 批量渲染/原位重画不入场动画。
// FIX 2026-09-21 #1004：整窗分帧构建在飞时落地的消息**绝不写进本轮 appendTarget**（DocumentFragment）
// ——写进去只有两种下场，两种都是用户可感知的坏形态：①本轮稍后被新一轮 renderWindow 作废 ⇒ 节点随
// fragment 一起丢弃，而这条已进 msgs、循环又已越过它的下标（len 是开轮时取的快照，不会再回头画）
// ⇒ 屏上永久少一条（用户所报「显示不全」）；②本轮正常换装 ⇒ 节点被插在「构建进度」那个位置
// （fragment 尾），后面几批消息整批 append 在它后面 ⇒ 新消息埋进列表中间（用户所报「发消息后位置
// 错位」）。改法＝暂存进 batchDefer.q，换装完成（body.appendChild(frag) 之后）按到达顺序补挂到列表尾；
// 本轮作废则整队丢弃（新一轮按 msgs 全量重画）。判据只有「下标 ≥ 开轮时的 msgs.length」这一个
// 与设备/内核无关的量。
let batchDefer = null;
// FIX 2026-09-23 #1151 一次性入场动画「播完就摘类」＋只在页面可见时挂：
// CSS 动画在元素 display:none → block 时会**从头重播**（全内核一致行为，与机型无关），而切页面
// 正是整页 hidden 翻转。原实现给节点挂上 .msg-enter 后永不摘除，于是「退出聊天回桌面 → 再进聊天」
// 那一瞬，屏上所有曾当场新增的气泡集体重放淡入+上浮（from{opacity:0;translateY(8px)scale(.98)}）
// ＝用户实报「聊天记录弹闪一下然后恢复正常」；DOM 一字未动，所以历次针对重渲链的修复与
// MutationObserver 探针全都看不见这一面（无头实证：重进首帧 4 条动画 currentTime 由 400/finished
// 归零成 0/running）。第二处＝页面藏着时到达的消息本不该有「入场」可言（用户没看着），原先会攒成
// 回场那一帧几十条同时弹，同一条报障的另一形态，故挂类前加可见闸。摘类只可能在动画播完后发生，
// 播完态与 .msg-enter 的 to 帧逐像素相同＝对正在播放的动画零影响。
function enterMsgOnce(m) {
m.classList.add('msg-enter');
m.addEventListener('animationend', function onEnterEnd(e) {
if (e.target !== m) return; // 子节点动画（语音波形/小花/抽卡）冒泡上来不算
m.classList.remove('msg-enter'); // #1151a 摘类＝重播向量归零
m.removeEventListener('animationend', onEnterEnd);
});
}
function appendMsg(m) {
if (!batchRendering && chatVisible() && !document.hidden) enterMsgOnce(m); // #1151b · #1181a：闸口从「页面没被切走」补成「用户真的看得见」——浏览器后台期 chatVisible() 仍为真，而 #913 的暂停类会把这些气泡的入场动画冻在第 0 帧（fill:both＝opacity:0、动画永不结束、类永不摘除），攒一整段后台后在回前台那一瞬集体补播＝用户实报「切回来记录弹跳闪一下才恢复正常」
if (batchDefer) {
const ix = Number(m.dataset.idx);
if (Number.isFinite(ix) && ix >= batchDefer.len) { batchDefer.q.push(m); return; }
}
(appendTarget || body).appendChild(m);
}
// FIX 2026-09-21 #972（用户实报 OPPO Find X9 Edge「聊天发消息后气泡+头像一起消失、位置错位、重启才
// 复原」）：批量头像缓存必须**永远新建**。旧写法 「if (on) { if (!avatarBatchCache) avatarBatchCache = {}; }」
// 在批量轮被新一轮 renderWindow 顶掉时（两条早退路径都跳过末尾的 appendAvatarBatch(false)）会把缓存
// 残留在全局变量上，此后每一轮都因「已存在」不再新建＝整场会话吃那份旧快照：之后每条新渲染的消息
// （renderMsg → fillAvatar）读到的都是泄漏那一刻的头像值（换过桌面＝别的桌面的头像，读不到＝灰占位
// ＝「头像消失」），fillAvatar 的命中缓存 __avApplied 又把错值钉在节点上，只有刷新才恢复＝「重启后复原」。
// 新建后泄漏最多影响那一轮；作废路径另按对象身份释放（见 myAvBatch）。
function appendAvatarBatch(on) {
if (on) avatarBatchCache = {};
else avatarBatchCache = null;
}
const RENDER_MAX = 200;   // 渲染窗口条数上限
const WINDOW_MAX = 400;   // v3.10.x：增量渲染窗口硬上限（含上下缓冲，防 DOM 无限膨胀）
const LOAD_STEP = 100;    // 向上滚动每次加载的条数
const TOP_THRESHOLD = 150;// scrollTop 小于此值触发向上加载（px）
const JUMP_VIEW = 30;     // 搜索跳转时目标索引上方预留的余量
let renderStart = 0;      // 渲染窗口起点（msgs 下标）；0 = 全量
let renderEnd = 0;        // v3.10.x：渲染窗口终点（msgs 下标，开区间）；增量裁剪/恢复用
// v3.26.x #220 聊天重开/权威读库收尾不闪：记录「屏上消息区由哪份 msgs 渲染」——
// windowRenderedN=整窗渲染时的条数、windowRenderedPrefix=渲染时联系人命名空间、
// windowStale=渲染后台归一化/尾巴合并改过 msgs（屏上已落后）。三者共同回答
// 「DOM 是否仍与 msgs 一致」，一致则 enterChat 重开跳过整窗重建、权威到达走原地补丁。
let windowRenderedN = 0;
let windowRenderedPrefix = null;
let windowStale = false;
// FIX 2026-09-18 #775b（用户实报：改了「我 / 联系人」的昵称，聊天里已发出的拍一拍仍是旧名）：
// 昵称是**渲染期**回填的（{ta}/{me} 占位符 → 当前昵称），msgs 里的原文一字未变，所以
// 「条数相同 + 同桌面 + 屏上不落后」的同窗补丁判据看不出屏上名字已过期，重开聊天页就跳过
// 整窗重建 → 屏上停留在旧名（刷新/重开应用才恢复，故「有的手机有、有的手机没有」＝取决于
// 该设备这次会话有没有真的重进聊天，与机型/内核无关）。补一条昵称凭据：整窗渲染时记下当时
// 用的昵称签名，签名变了＝屏上昵称过期，同窗补丁作废、走整窗重建。
let windowRenderedNicks = '';
function chatNickSig() {
try { return chatPartnerName() + '\u0001' + chatUserName(); } catch (e) { return ''; }
}
// FIX 2026-09-25 #1236「关不掉」观感收口（与 #775b 昵称签名同一套机制）：来源 chip 的显示跟随
//   总闸（见 srcTagHidden），而「回复设置 → 聊天」里关掉「多字卡回复 / 词典拼字 / 梦角自由造句」
//   再回聊天页时，屏上气泡若走同窗补丁就不会重画 → 旧标签还挂着＝用户判定「开关没用」。
//   整窗渲染时记下当时三个闸的存储值，值变了＝屏上标签已过期，作废同窗补丁、走整窗重建。
let windowRenderedSrcTags = '';
function srcTagSig() {
try { return store.get('reply-py-en') + '\u0001' + store.get('reply-qs-en') + '\u0001' + store.get('reply-mjf-en'); } catch (e) { return windowRenderedSrcTags; }
}

// FIX 2026-09-13 #402（进聊天跳动一下·多机型偶发）：归一化窗口内改动的下标清单。
// runDeferredNormalization 的 tick 逐 chunk 填写（无结构删除时下标全程稳定），
// finish 收尾据此对命中下标原位换节点（patchChangedInPlace），不再整窗重建。
// 模块级声明：跨 chunk 持续累积 + 哨兵锚稳定；换桌面/清窗路径随 windowStale 一并复位。
let normChangedIdxs = null;
// FIX 2026-09-17 #675（打开聊天消息「全部弹一下再恢复」·归一化结构性删除路径收口）：
// 归一化删相邻重复（normCollapseRange 的 splice）时，finish 仍走 renderWindow 整窗重建
// ＝进入聊天 ~250ms 后 200 个气泡连同全部 img 节点整批销毁重建、图片逐张重新解码＝肉眼
// 「消息全部弹一下，然后再恢复正常」（#402 只收了「无结构删除」的字段级改动路径）。
// 原位收敛需要两份凭据：①被删记录对象（身份稳定，normCell 只原地改不换对象）；
// ②归一化开始时的「记录 → 原始下标」映射（DOM data-idx 与窗口凭据都是原始下标系，
// 删除只发生在 tick 内、无插入无重排，原始下标 = 现下标 + 前方删除数，可精确回推）。
let normChangedRecs = [];
let normRemovedRecs = [];
let normOrigIdx = null;
let normSnapTail = null;
// #245：整窗渲染时登记窗口内含精简快照残留（_lsLite/img==='' /voice===''）的下标——
// 权威读库收尾据此对这些下标原位换节点补真实媒体（见 inplacePatchIfSameWindow）。
// 必须在渲染时刻登记：权威合并后 msgs 已是全量数据，事后扫描扫不出「屏上渲的是精简」。
let windowRenderedLite = null;
// FIX 2026-09-21 #1010 屏上窗口身份凭据（打开聊天「数据加载弹窗消失后记录还要闪一下」的真因收口）：
//   windowRenderedN 只记「条数」，判不出「屏上这一窗到底是权威数组的哪一段」。#241 的同窗补丁
//   按「屏上是权威的前缀」这一假设工作，而 LS 兜底快照是**尾部切片**（performLsSnapWrite 超 2MB
//   从最旧折半丢弃，留下的正是最近一段），它渲染出的 data-idx 是**快照内的局部下标**（0..k-1）；
//   权威回读后同一批记录的真实下标是 len-k..len-1。旧判据只看「DOM 下标恰为 renderStart..
//   windowRenderedN-1 顺序排列」——局部下标天然满足，于是①lite 残留原位升级按错位下标取 msgs[i]，
//   把最旧那几条的媒体塞进最新几个气泡（内容串位）；②grown=len-k 触发尾部增量追加，把同一批记录
//   再画一遍，随后 prune 又削掉错位节点＝一次「记录整批闪动+重排」（41MB 级历史必然命中：快照必被
//   剥媒体且折半）。补两条身份凭据：整窗渲染时记下窗口首/尾记录的身份键（媒体载荷不参与——同一条
//   消息在 LS 精简态与权威态存法不同，身份必须一致），收尾时据此判定「前缀 / 尾部切片 / 说不清」，
//   尾部切片走下标整体平移（零节点重建、零追加、零剪枝）。
let windowKeyLo = -1;
let windowKeyHi = -1;
let windowKeyLoVal = '';
let windowKeyHiVal = '';
// 身份键：时间戳+方向+类型+special+正文。**媒体/占位载荷一律不参与**——同一条消息在 LS 精简态
// 与权威态的存法不同（媒体记录正文被 liteSnapArray 换成 '[内容已省略]' 或剥空，媒体池令牌化后
// 又是 '@@m:hash'），身份必须一样；special 类（拍一拍/系统提示）正文即语义，但也只认 ts|side|special
// 三元组，避免两侧措辞差异把身份判丢。不做哈希——同毫秒同向同类同正文的两条记录极罕见（合并去重
// 早已收敛），且判定要求首尾两端同时命中，误判概率可忽略；判错的后果只是退回整窗重建（保守方向）。
function chatWinKey(m) {
if (!m || typeof m !== 'object') return '#';
const t = (typeof m.text === 'string') ? m.text : '';
const mediaish = !!(m.img || m.voice || m.type === 'image' || m.type === 'sticker' || m.type === 'voice' || m.special || m._lsLite || t === '' || t === '[内容已省略]');
return (m.ts || 0) + '|' + (m.side || '') + '|' + (m.type || '') + '|' + (m.special || '') + '|' + (mediaish ? 'M' : t.length + ':' + t.slice(0, 24));
}
function chatWinKeysSync() {
try {
windowKeyLo = renderStart;
windowKeyHi = renderEnd - 1;
windowKeyLoVal = (renderStart >= 0 && renderStart < msgs.length) ? chatWinKey(msgs[renderStart]) : '';
windowKeyHiVal = (windowKeyHi >= 0 && windowKeyHi < msgs.length) ? chatWinKey(msgs[windowKeyHi]) : '';
} catch (e) { windowKeyLo = -1; windowKeyHi = -1; windowKeyLoVal = ''; windowKeyHiVal = ''; }
}

// ===== #1466 聊天渲染窗口取证环（#1357 契约落地；只读取证，零行为改动）=====
// 背景：「聊天记录乱跳，一会显示以前的聊天记录一会显示现在的」自 #1357 起第三次报
// （2026-09-29 iPhone 15 Pro Max／iOS 18.7 Safari，诊断单 mochi-diag-2026-09-29-13-56）。
// #1357 已把数据层三发无头排除（读库/合并/回放/账本全绿），结论＝「定性要等一份带这一格的
// 新诊断单」，但那支载荷没有落库——其后每份诊断单里都没有这一格，现象始终盲判。本批把
// 尺子真正装上。
// 结构：24 格环形、1.2s 一拍；JS 侧状态指纹（窗口起止/条数/整窗凭据/最近滚动与抑制时间戳）
// 没变就不读几何、不记条（常驻拍零几何读，性能纪律同 #969 家族）。判定沿用 #1357 口径：
//   back＝窗口起点回挪 >20 条（换装换成更早的一段）；
//   prog＝两次采样间位移 >200px 且落在程序化滚动抑制窗内（跟底/回钉在用户不在底时拽画面）；
//   blank＝msgs 有货而消息区空窗（#841 分帧在飞/链断）。
// 读数入口 window.__chatWinRing()；device.js 诊断【视口/屏幕】节按它打印
// 「聊天窗口取证：共=N条 此刻画 A–B 窗口倒退=x 程序写入的位移=y」＋最近 8 条轨迹。
const chatWinRingArr = [];
let chatWinRingLast = null;
let chatWinRingBacks = 0;
let chatWinRingProgPx = 0;
function chatWinRingSnap() {
return { lo: renderStart, hi: renderEnd, n: msgs.length, rn: windowRenderedN, stale: windowStale ? 1 : 0 };
}
function chatWinRingMark(kind, lo, hi, w) {
try {
chatWinRingArr.push({ t: Date.now(), k: kind, lo: lo, hi: hi, w: w });
if (chatWinRingArr.length > 24) chatWinRingArr.shift();
} catch (e) {}
}
function chatWinRingTick() {
try {
const pg = document.getElementById('page-chat');
if (!pg || pg.hidden) return;
const s = chatWinRingSnap();
const actTs = (typeof _chatScrollActTs === 'number') ? _chatScrollActTs : 0;
const supTs = (typeof suppressScrollUntil === 'number') ? suppressScrollUntil : 0;
const fp = s.lo + '|' + s.hi + '|' + s.n + '|' + s.rn + '|' + s.stale + '|' + actTs + '|' + supTs;
const now = Date.now();
if (chatWinRingLast && chatWinRingLast.fp === fp) return; // 指纹没变＝不读几何不记条
const b = document.getElementById('chat-body');
const st = b ? b.scrollTop : 0;
if (chatWinRingLast) {
const L = chatWinRingLast;
const backN = L.lo - s.lo;
const dTop = Math.abs(st - L.st);
if (backN > 20) {
chatWinRingBacks++;
chatWinRingMark('back', s.lo, s.hi);
}
if (dTop > 200 && (now < supTs || now - actTs < 200)) {
chatWinRingProgPx += dTop;
chatWinRingMark('prog', s.lo, s.hi);
}
if (s.n > 0 && b && !b.children.length) chatWinRingMark('blank', s.lo, s.hi);
}
chatWinRingLast = { fp: fp, lo: s.lo, hi: s.hi, st: st };
} catch (e) {}
}
try { setInterval(chatWinRingTick, 1200); } catch (e) {}
window.__chatWinRing = function () {
return { backs: chatWinRingBacks, progPx: chatWinRingProgPx, ring: chatWinRingArr.slice(-8), cur: chatWinRingSnap() };
}
const TIME_DIVIDER_GAP = 5 * 60 * 1000;
function maybeInsertDivider(idx) {
if (store.get('cs-time-style') !== 'divider') return;
if (idx < 0 || idx >= msgs.length) return;
const cur = msgs[idx];
if (!cur || !cur.ts) return;
if (idx > 0) {
const prev = msgs[idx - 1];
if (!prev || !prev.ts) return;
if (cur.ts - prev.ts < TIME_DIVIDER_GAP) return;
}
const d = document.createElement('div');
d.className = 'msg-time-divider';
d.innerHTML = '<span>' + timeDividerText(cur.ts) + '</span>';
// FIX 2026-09-21 #972：批量整窗渲染期本函数**必须与消息同行**——旧写法无条件 body.appendChild，
// 而那一刻 body 刚被 innerHTML='' 清空、全部消息行都还在 appendTarget（DocumentFragment）里等换装，
// 于是分隔线被 append 在空 body 上、消息随后整批 append 在它们**后面**：无头实测 199 条消息对应
// 199 条分隔线全部连排堆在列表头部（时间轴顺序全错，滚动高度虚增数千 px，越限裁剪时 scrollTop 补偿
// 被钳到 0＝视口弹走，越界裁剪还会把消息削掉＝「显示不全」）。判据只有「挂到哪个父节点」。
// #1004：批量构建在飞时落地的分隔线同理不得插进本轮 fragment 中间（会插在窗口中部＝错位）——
// 与 appendMsg 共用同一暂存队列，换装后按到达顺序补挂。
if (batchDefer && idx >= batchDefer.len) { batchDefer.q.push(d); return; }
(appendTarget || body).appendChild(d);
}
let suppressScrollUntil = 0; // 程序化滚动后短暂忽略 scroll 事件（防渲染本身触发向上加载）
// #718：整窗渲染分帧——冷路径（keepScroll=false）窗口 ≥80 条时，renderMsg 循环一口气建
// 200 条＝单条 500~900ms 长任务（权威到达/冷进聊天那一下「卡住＋进度条冻结」，红米 K80
// 诊断单 898/924ms 长任务实证）。分帧＝每批 RENDER_CHUNK 条进 fragment、帧间让出主线程
// （进度条动画恢复），构建完一次换装。keepScroll=true 的用户触发重渲走原同步路径（视觉
// 零变化）；forceSync 给「返回即需要 body 节点」的调用方（#846 起暂无调用方——addRec 钳位改
// trimWindowTopQuiet 静默裁顶，不再整窗重建）。
// 世代令牌防重入：新一轮 renderWindow 作废旧构建（frag 丢弃、状态由新轮重新登记）。
const RENDER_CHUNK = 50;
const RENDER_CHUNK_MIN = 80;
let _rwToken = 0;
// FIX 2026-09-26 #1313（红米 K80 Chrome 实报「把浏览器挂着后台一段时间再回来，聊天里依旧不显示回来后
// 新发的聊天消息，一片空白，要重新刷新网页才恢复正常」，第四次复报同一症状、用户明说其他设备型号也有
// 出现且要求不要覆盖式修补）：判据只取一个事实——「这一轮整窗构建还在不在推进」，纯时序、零机型／零 UA 分支。
// 根因（同尺 A/B 无头实证，tools/verify-1313-render-pump-stall.mjs 红侧读数即用户所见：kids:0／
// loading:block／n 还在涨而屏上一条不画／退出重进仍 0／放行泵才出画面）：分帧构建唯一的生命线是
// buildChunk 末尾那条 setTimeout(buildChunk,0) 自续链，而 body.innerHTML='' 发生在**开轮那一刻**。
// 链一旦不再回来，batchRendering／appendTarget／chatRebuilding 就永久停在「构建中」，屏上是空列表：
// ① 单条记录把 renderMsg 弄抛——#919a 的注释里就有真机 buildChunk→renderMsg「reading 'side'」的实锤，
//    而 #919a/#919b 的守卫只认「记录位不是对象」，对象里的坏字段照样抛；
// ② 内核把这条 0ms 链节流／冻结到不再派发（#1202 取证过隐藏标签约 1 次/分钟，解冻后那半轮未必续得上）。
// 此后每一条恢复路径都撞上同一个早退：回场复核④（`|| batchRendering) return;`）、空洞自愈
// armWindowHoleHeal、增量补尾、退出重进（同窗补丁要求「屏上是这份 msgs」）＝没有任何补口，只有刷新能恢复。
// 而「在飞」这个判据本身在卡死态永远为真，所以任何拿「让路给在飞的构建」当理由的早退都成了死路。
// 三件事，既有语义一条不削：
// ① 单条记录弄抛不再能带走整轮（逐条 try/catch，抛错下标记进 threwIdx，与 #919a 的空洞分开——它不是
//    「等数据补上就自愈」的空洞，喂进 armWindowHoleHeal 会变成「重画→又抛→又排」的 700ms 空转，破坏
//    #1004 的自终止不变量），只置 windowStale（屏上确实少一条，同窗补丁从此不信）＋留证；
// ② 每轮登记一只泵，泵每跑一段盖一次进展时间戳，chatPumpStalled()＝「声称在飞且超过阈值没有任何进展」；
// ③ 看门狗按这条尺子接管：把剩下的记录画完再走**既有的** finishSwap 收尾（不新增第二套换装逻辑），
//    并把本轮标记为 done，让那条已经停摆的链即便迟到回来也只是空手而归（不重复换装）。看门狗自己是
//    真正的延时定时器、不挂在那条 0ms 链上，所以链死了它还在；隐藏期不接管（那是冻结不是卡死），
//    期间有过进展就改期再观察。
const CHAT_PUMP_STALL_MS = 2500; // 一帧都不推进多久才算卡死：无头实测单批 50 条 renderMsg 在 4× CPU 节流下仍 <250ms，留一个量级的余量＝绝不误伤健康的分帧轮（误伤只是把「让出主线程」换成「一口气画完」，总工不变）
let chatPump = null; // 只有「分帧整窗轮」会登记：{ at, token, done, watch, rescue }
function chatPumpTouch() { if (chatPump) chatPump.at = Date.now(); }
function chatPumpStalled() {
if (!batchRendering || !chatPump) return false; // 不在飞／不是分帧轮＝没有可停滞的泵
return Date.now() - chatPump.at >= CHAT_PUMP_STALL_MS;
}
function chatPumpStopWatch(p) { if (p && p.watch) { clearTimeout(p.watch); p.watch = 0; } }
function chatPumpArmWatch(p) {
chatPumpStopWatch(p);
p.watch = setTimeout(function () { chatPumpWatch(p); }, CHAT_PUMP_STALL_MS);
}
function chatPumpWatch(p) {
p.watch = 0;
if (p.done || chatPump !== p) return; // 本轮已收装／已被新一轮顶替（新轮自己排了自己的枪）
if (!batchRendering) return;
if (document.hidden) { chatPumpArmWatch(p); return; } // 后台期内核本就不派发定时器＝冻结不是卡死，等回前台再判
if (Date.now() - p.at < CHAT_PUMP_STALL_MS) { chatPumpArmWatch(p); return; } // 期间有过进展＝泵还活着，再观察一轮
chatPumpRescue('watchdog');
}
// 现场留证（#1305／#1308 同一课：静默失败最难查，报障时只能挨个猜）：环 8 条＋计数，成功路径零开销
function chatRenderIncident(why, stallMs, threw) {
try {
const l = window.__chatRenderIncidents = window.__chatRenderIncidents || [];
if (l.length >= 8) l.shift();
l.push({ t: Date.now(), why: String(why), stallMs: stallMs || 0, threw: threw || 0, token: _rwToken, kids: body.children.length, n: msgs.length });
window.__chatRenderIncidentN = (window.__chatRenderIncidentN || 0) + 1;
if (window.__mochiPhase) window.__mochiPhase('render:' + why); // 塞进 #907 相位账本：卡顿自检回查冻结起点前的最近标记时能点名
} catch (e) {}
}
function chatPumpRescue(why) {
const p = chatPump;
if (!p || p.done || !batchRendering) return false;
chatRenderIncident(why, Date.now() - p.at, 0);
try { p.rescue(); } catch (e) {} // rescue 内部逐条已有 try/catch，这里只兜「收尾自身抛」＝维持旧行为
return true;
}
window.__chatPumpDiag = function () { return { flying: batchRendering, stalled: chatPumpStalled(), sinceMs: chatPump ? Date.now() - chatPump.at : -1, incidents: (window.__chatRenderIncidents || []).slice(-3) }; }; // 只观测不改写：供 verify 脚本与真机诊断回读
function renderWindow(keepScroll, clampTop, forceSync) {

  try { if (!keepScroll && window.__mochiPhase) window.__mochiPhase('chat-renderWindow'); } catch (e0) {}const len = msgs.length;
chatRebuilding = false; // #841e：新一轮渲染先复位空窗标志（被作废的旧分帧轮不得把进度条留在屏上）
const prevTop = keepScroll ? body.scrollTop : 0;
const prevHeight = keepScroll ? body.scrollHeight : 0;
// FIX 2026-09-21 #1004（用户实报「退出聊天页面回到桌面，然后再打开聊天页面，一片空白，没有任何
// 聊天记录加载」）：窗口起点必须落在**本轮数据长度之内**。旧写法 「const start = Math.min(renderStart, len)」
// 只把 start 钳进 [0,len]：renderStart ≥ len 时 start === len ⇒ 循环一条都不画，而 body 已被上面那句
// innerHTML='' 清空 ⇒ 空白页；finishSwap 又把 windowRenderedN 登记成 len（＝「屏上是这份 msgs 的前 len 条」），
// 进度条按「有内容或就绪」收起 ⇒ 用户看到的就是「一片空白、没有任何加载提示」，重进只走同窗补丁判定，
// 白屏就一直停在那儿。renderStart 什么时候会越界：换桌面路径把 msgs 清空重读（contact-switched 里
// msgs=[] 但 renderStart 不跟着复位）、合并/归一化把 msgs 缩短、任何缩表路径都可能。短离场回场、
// 换时间样式（chatReRenderTime）这类 keepScroll 轮不会重算 renderStart，正是最常撞上的一枪。
// 修法：起点越界时按「最新 RENDER_MAX 条」重开窗口（与 clampTop 同语义），空窗不可能发生。
// FIX 2026-09-30 #1491（作者实报「搜索消息不能定位原消息位置，马上直接弹回当前页面」）：这一句的本义
//   ＝「把窗口按到最新一段」，而回场补画／权威合并／归一化回退／红包状态流转都拿 renderWindow(clampTop)
//   当「重画」用——于是「重画一遍」和「把用户正在看的那一段搬走」被混成了同一发。解钉态（用户自己接管
//   了滚动，含 #334 跳转刚解的那颗钉）下按到尾部＝屏上整段历史被换成最新 200 条，加上调用方紧随的那发
//   scrollChatBottom＝所见「点了一下又被弹回来」。铁证＝诊断单取证环 6×[prog@7140~8257]（跳转确实成功、
//   窗口就停在那儿、滚动被反复写回底部）而「此刻画 8059–8263」＝len−RENDER_MAX。
//   修法＝按当场事实分流，零机型／零 UA 分支：
//   ① 起点越界（#1004 空窗防护）照旧按到尾部段——起点已经在数组之外，没有「当前窗口」可言；
//   ② 屏上此刻画的条数正好等于 renderStart..len（＝原地重画既不多画一条也不少画一条）时保持原窗口，
//      用户看到的就是他刚定位的那一段；
//   ③ 其余（刚清空、切桌面、首渲前、屏上与窗口本来不符）照旧按到尾部段，规模语义一字不变——
//      结构判据（首枚 data-idx＝窗口起点、末枚＝最新一条）同时挡住了「renderStart=0 而屏上只有一窗」
//      被放大成整史铺开的事故；且不像「数 children」那样把日期分隔线算进来（真机天天一枚＝永不相等）。
if (renderStart >= len) renderStart = Math.max(0, len - RENDER_MAX); // #1004 起点越界＝空窗防护，与钉住态无关
else if (clampTop) {
const _rwN = body.querySelectorAll('.msg[data-idx]');
const _rwFirst = _rwN.length ? Number(_rwN[0].dataset.idx) : -1;
const _rwLast = _rwN.length ? Number(_rwN[_rwN.length - 1].dataset.idx) : -1;
if (!(_rwFirst === renderStart && _rwLast >= len - 1)) renderStart = Math.max(0, len - RENDER_MAX);
}
const start = Math.min(renderStart, len);
renderEnd = len; // 整窗重建渲染到最新，窗口终点复位（裁剪状态随之清空）
// v3.26.x #220：登记「屏上由哪份 msgs 渲染」——非整窗路径（增量追加/裁剪）不更新
// N（条数没变，屏上仍是这份窗口），只有整窗渲染才重新登记。
windowRenderedN = len;
windowRenderedPrefix = window.activePrefix();
windowRenderedNicks = chatNickSig(); // #775b：整窗渲染＝屏上昵称已刷新，登记当时的昵称签名
windowRenderedSrcTags = srcTagSig(); // #1236：同一次整窗渲染＝屏上来源 chip 也是当时的闸态，一并登记
windowStale = false;
chatWinKeysSync(); // #1010：登记屏上窗口首/尾记录身份（收尾据此判前缀 / 尾部切片）
chatWinRingMark('win', start, len); // #1466：整窗换装轨迹（取证环，只读）
collectInplaceDrafts();
windowRenderedLite = null;
const _liteIdx = [];
body.innerHTML = '';
batchRendering = true;
const frag = document.createDocumentFragment();
appendTarget = frag;
appendAvatarBatch(true);
const myAvBatch = avatarBatchCache; // #972：本轮自己的缓存对象身份——作废时只释放「还属于本轮」那份，绝不误清新一轮的
const myDefer = batchDefer = { len: len, q: [] }; // #1004：本轮开轮时的条数快照（迟到节点判据）＋暂存队列
const skippedIdx = []; // #1004：本轮因「记录位不是对象」被 #919a 保护性跳过的下标（屏上少画一条，必须留痕）
const threwIdx = []; // #1313：本轮 renderMsg 当场弄抛的下标（对象里的坏字段）——与 #919a 的空洞分开记：它不是「等数据补上就自愈」的空洞
let i = start;
const myToken = ++_rwToken;
const myPump = { at: Date.now(), token: myToken, done: false, watch: 0, rescue: null }; // #1313：本轮的泵（进展时间戳＋接管入口＋是否已收装）
// #1313：分帧链与「接管」共用同一份逐条画（判据与 #919a 一字不差；抛错的下标计入 threwIdx 而不是丢掉本轮）
const paintRange = function (end) {
for (; i < end; i++) {
const _rm = msgs[i];
if (!_rm || typeof _rm !== 'object') { skippedIdx.push(i); continue; } // #919a 记录位空洞/坏记录跳过不画：renderMsg(undefined) 抛 TypeError 打断整轮分帧构建（setTimeout 链断＝不换装不贴底、batchRendering 卡死，屏上停在窗口最旧的几十条、退出重进才恢复；用户设备 buildChunk→renderMsg「reading 'side'」实锤）
try {
maybeInsertDivider(i);
if (_rm && (_rm._lsLite || _rm.img === '' || _rm.voice === '' ||
(Array.isArray(_rm.parts) && _rm.parts.some(p => p && typeof p.v === 'string' && p.v === '')))) {
_liteIdx.push(i);
}
const m = renderMsg(_rm, i); // #1326：真实下标要在挂载之前落定，否则 #1004 的「迟到节点」判据读到的是 provisional 数
m.dataset.idx = i; // 覆盖 renderMsg 内的 msgs.length-1（批量渲染时必须为真实下标）
} catch (eThrow) { threwIdx.push(i); } // #1313：单条记录不许带走整轮构建（链断＝永久空白，见上面 #919a 那条真机实锤）
}
};
const finishSwap = function () {
if (myPump.done) return; // #1313：本轮已经收过装（正常跑完或看门狗接管），任何迟到的续链不得二次换装
chatPumpStopWatch(myPump); // #1313：本轮到此为止，看门狗撤枪
// #972/#1004：作废轮也要收自己的尾巴——批量头像缓存按对象身份释放（旧写法在这里直接 return＝缓存
// 泄漏被后续所有轮次永久复用），迟到队列整队丢弃（新一轮按 msgs 全量重画，不会漏条）。
if (myToken !== _rwToken) { if (avatarBatchCache === myAvBatch) appendAvatarBatch(false); if (batchDefer === myDefer) batchDefer = null; return; }
myPump.done = true;
if (chatPump === myPump) chatPump = null; // #1313：泵只登记「真正在飞的那一轮」
if (_liteIdx.length) windowRenderedLite = _liteIdx;
appendAvatarBatch(false);
appendTarget = null;
batchRendering = false;
body.appendChild(frag);
// #1004：换装后按到达顺序补挂构建期迟到的消息/分隔线（下标都 ≥ 开轮长度，接在窗口尾即正确顺序），
// 并把窗上凭据对齐到真实长度——否则 windowRenderedN 停在开轮值会骗过同窗补丁判定。
if (myDefer.q.length) {
for (let q = 0; q < myDefer.q.length; q++) body.appendChild(myDefer.q[q]);
windowRenderedN = msgs.length;
renderEnd = msgs.length;
}
batchDefer = null;
// #1004：本轮有记录位不是对象被跳过的，屏上就少一条，而且此后没有任何补画入口（窗口是 [start,len)
// 的连续区间，增量路径只补两端）⇒ 永久空洞。这里标记屏上已落后（windowStale，同窗补丁判定据此
// 放弃就地收尾）并排一次自愈重画（见 armWindowHoleHeal）。
if (skippedIdx.length) { windowStale = true; armWindowHoleHeal(skippedIdx); }
// #1313：抛错的记录位同样是「屏上少一条」，但绝不能喂进上面那条自愈队列——它在数据侧仍是对象，
// armWindowHoleHeal 的「仍是空洞才不重排」判据据此判定该重画，重画又抛、又排＝700ms 空转，
// 把 #1004 刻意保住的自终止不变量反过来弄成死循环。这里只置作废凭据＋留证。
if (threwIdx.length) { windowStale = true; chatRenderIncident('paint-throw', 0, threwIdx.length); }
if (keepScroll && prevHeight > 0) {
body.scrollTop = prevTop + (body.scrollHeight - prevHeight);
}
if (pendingOutScroll) {
pendingOutScroll = false;
scrollChatBottom();
} else if (!keepScroll && chatPinnedBottom) {
scrollChatBottom(); // #718 分帧路径：调用方紧跟的 scrollToBottom 跑在换装前（空 body＝空操作），这里补真正的贴底
}
suppressScrollUntil = Date.now() + 200; // 本轮渲染/滚动结束后 200ms 内不响应 scroll
restoreInplaceDrafts();
chatRebuilding = false; // #841a：新内容已换装落定，交回常规判定
updateChatLoading(); // 渲染完成（有内容或就绪）→ 隐藏加载进度条
try { chatSettleHoldSettle(); } catch (e) {} // #1010：分帧换装落定后再判「视口媒体解码是否落地」——在飞期间上面那次 updateChatLoading 只靠 chatRebuilding 顶着，落定这一帧必须重判，否则进度条先撤、图再落地＝原症状
if (chatPinnedBottom) chatEntrySettle(); // #841b：重建换装＝一次「进页」，重开 1.2s 同帧贴底窗，视口内图片迟到解码当帧收口，不等 250ms 看门狗拽把
};
const buildChunk = function () {
if (myPump.done) return; // #1313：本轮已收装（正常跑完或接管完毕），停摆后迟到的那一发不许再动任何状态（appendTarget 已空＝旧写法会把节点直接补挂进 body 里成重复消息）
if (myToken !== _rwToken) { try { restoreInplaceDrafts(); } catch (e) {} if (avatarBatchCache === myAvBatch) appendAvatarBatch(false); if (batchDefer === myDefer) batchDefer = null; return; } // #718 作废：草稿回填旧 DOM（新轮 collect 会再收），不丢草稿；#972/#1004：作废轮释放自己那轮的批量头像缓存与迟到队列（#1313：作废轮的看门狗不在此撤——它是真延时定时器，到点自己见 chatPump 已换主即空手而归）
chatPumpTouch(); // #1313：跑到了这里＝泵还在推进（盖时间戳的唯一出处）
paintRange(Math.min(i + RENDER_CHUNK, len));
if (i < len) { setTimeout(buildChunk, 0); return; }
finishSwap();
};
// #1313 接管＝把剩下的记录画完，再走上面那个**既有**的换装收尾（顺序与正常跑完的分帧轮一字不差，
// 不新增第二套收尾逻辑）。总工与正常分帧相同，只是不再让出主线程——停滞到这份上，先让屏上有内容。
myPump.rescue = function () {
while (!myPump.done && i < len) paintRange(Math.min(i + RENDER_CHUNK, len));
finishSwap();
};
if (!keepScroll && !forceSync && (len - start) >= RENDER_CHUNK_MIN && window.requestAnimationFrame) {
chatRebuilding = true; // #841f：分帧构建期列表是空的，进度条顶上（updateChatLoading 读该标志）
updateChatLoading(); // #841g：置位后立即置屏，不留一帧「闪白无提示」
chatPump = myPump; chatPumpArmWatch(myPump); // #1313：登记本轮的泵并排一枪看门狗——这一枪是真正的延时定时器、不挂在那条 0ms 链上，链死了它还在
setTimeout(buildChunk, 0); // #718 分帧构建
return;
}
for (; i < len; i++) {
const _rm = msgs[i];
if (!_rm || typeof _rm !== 'object') { skippedIdx.push(i); continue; } // #919b 同 #919a：同步整窗路径也不得被单条空记录打断（异常一路上抛，调用方紧随的贴底/收尾整段跳过）
try {
maybeInsertDivider(i);
if (_rm && (_rm._lsLite || _rm.img === '' || _rm.voice === '' ||
(Array.isArray(_rm.parts) && _rm.parts.some(p => p && typeof p.v === 'string' && p.v === '')))) {
_liteIdx.push(i);
}
const m = renderMsg(_rm, i); // #1326：真实下标要在挂载之前落定，否则 #1004 的「迟到节点」判据读到的是 provisional 数
m.dataset.idx = i; // 覆盖 renderMsg 内的 msgs.length-1（批量渲染时必须为真实下标）
} catch (eThrow) { threwIdx.push(i); } // #1313：同步整窗路径同理——单条记录不许把异常抛给调用方（那会连贴底/撤进度条一起跳过，屏上停在被清空的状态）
}
finishSwap();
}
// FIX 2026-09-21 #951（用户报障：切换桌面联系人之后打开聊天页面「还是会闪屏一下然后恢复正常，
// 聊天里没有数据加载缓冲的动画」＝#893 症状家族的新通道）：
// 根因（纯 HEAD 无头实测取证，零机型分支）：contact-switched 清空 msgs 并按 #489 强制
// windowStale=true，却从不碰 chat-body 的 DOM；而新桌面的权威数据在切换当口已被
// chatPrefetchIfLight→loadMsgs 预读进内存。于是「点聊天图标」那一刻必然整窗重建
// （inplacePatchIfSameWindow 因 stale＋windowRenderedPrefix 仍属旧桌面＝双重不可能命中）：
// body 先 innerHTML='' 再逐块建 → 可见空窗（实测 120 条：不节流 19ms、15× 节流 1148ms，
// 快机上进度条只活 19ms＝用户说的「没有缓冲动画」）；<80 条走同步路径无空窗，却是一记
// 585ms 长任务把旧桌面画面定格后整窗砸掉＝「闪一下才恢复正常」。
// 修法＝把整窗重建搬到页面还藏着的时候做掉：本命名空间权威落定（authLoadedPrefix，刻意不
// 信 chatDbReady——15 秒就绪保险丝会假置位）且聊天页仍隐藏时，延后 600ms（让桌面翻页动画
// 走完，不与 #943 的 iOS 热路径根治对打）预渲一次，enterChat 的同窗补丁从此命中。
// 边界：#489 语义不削（预渲发生在切换之后、按新桌面权威整窗重画，旧桌面 DOM 反而更早离场）；
// >8MB 大历史未预读→authLoadedPrefix 不匹配→本闸不动作，进聊天仍是「真在读数据」的空窗＋
// 进度条（那是诚实反馈，不该拿假内容糊过去）。
let chatPrewarmTimer = null;
function scheduleChatPrewarm(prefix) {
if (chatPrewarmTimer) { clearTimeout(chatPrewarmTimer); chatPrewarmTimer = null; }
if (!prefix) return;
chatPrewarmTimer = setTimeout(function () {
chatPrewarmTimer = null;
try {
if (document.hidden || chatVisible()) return;
if (window.activePrefix() !== prefix) return;
if (!(chatDbReady && authLoadedPrefix === prefix)) return; // #951b 就绪闸只认本命名空间权威（chatDbReady 会被 15 秒保险丝假置位）
if (batchRendering || (windowRenderedPrefix === prefix && !windowStale)) return; // #951c 屏上已是本桌面且未作废＝不重复动手
if (!msgs || !msgs.length) return;
renderWindow(false, true); // #951d 隐藏态整窗预渲落地（enterChat 的同窗补丁据此命中）
} catch (e) {}
}, 600);
}
window.chatReRenderTime = function () {
if (chatPage.hidden || !body.children.length) return;
renderWindow(true, false);
};
// v3.26.x #220 聊天重开/权威读库收尾不闪：原地补丁——msgs 与屏上窗口「同窗同貌」
// （归属同桌面、窗口尾贴到最新、渲染后归一化/尾巴合并没改过窗口内数据、DOM 里的
// [data-idx] 恰为 renderStart..len-1 顺序排列）时，不再整窗重建（整窗=气泡全部重建
// 重新解码=肉眼跳动），只做轻量收尾：已读回执占位（idle 分支读不到正文的专用标记）
// 替换成真实内容。返回 true=已补丁无需重渲；false=不满足条件，调用方走原整窗渲染。
// 注：窗口含 lite 快照残留（img==='' / voice==='' / _lsLite，大历史 LS 快照必然剥负载）
// 时不跳过——权威数据在这些下标上是真实媒体，整窗重渲才算把图/语音补上（内容真变了）。
// FIX 2026-09-07 #241：放宽「窗口尾必须贴最新」——屏上窗口是权威数组的「前缀」（权威
// 比屏上多出尾部，典型=LS 快照缺上次会话尾条/对端新消息只在 IDB）时，原条件直接放弃
// → 权威收尾整窗清空重画=打开聊天「先跳动一下才显示正常」（小米15Pro/Chrome 同机复发，
// 无头实测 rm3+add8 复现）。现改为：前缀段仍须无 lite 残留+DOM idx 齐整，通过后走
// loadNewerIncremental 尾部增量追加（已有节点零重建），屏上比权威多（数据回滚/裁剪）
// 仍整窗兜底。#220 原同窗路径（grown===0）行为逐字节不变。
function inplacePatchIfSameWindow() {
const len = msgs.length;
if (!len) return false;
if (batchRendering) return false; // #951h 分帧构建在飞＝屏上是空/半截列表，「同窗同貌」不成立（#951 隐藏态预渲让这条通道变成常遇：点的那一刻构建还没跑完，若判成已画好会就地收掉进度条并把在飞的换装链晾在半路＝闪白无提示；返回 false 让调用方走 renderWindow，旧链由 _rwToken 作废）
if (windowStale) return false;
try { if (windowRenderedPrefix !== window.activePrefix()) return false; } catch (e) { return false; }
// #775b：昵称（拍一拍/系统消息里的 {ta}/{me} 回填来源）在屏上渲染之后被改过 → 屏上昵称已过期，
// 原地补丁只补下标、不改文字，必须让调用方走整窗重建（含备份导入、聊天设置改名、昵称池换名、
// 联系人管理改名等所有入口，比逐个入口挂钩子可靠）
if (windowRenderedNicks !== chatNickSig()) return false;
if (windowRenderedSrcTags !== srcTagSig()) return false; // #1236 三个总闸在屏上渲染之后被改过＝标签已过期，整窗重建才摘得掉
const grown = len - windowRenderedN;
if (grown < 0) return false; // 屏上比权威多＝数据被裁/回滚，整窗重建兜底
if (windowRenderedN === 0) return false; // 无屏上凭据（首渲场景）走原整窗渲染
// 窗口内 lite 残留清单（renderWindow 渲染时刻登记的 windowRenderedLite，仅取屏上段）——
// FIX 2026-09-07 #245：不再见残留就 return false 整窗重渲。大历史 LS 兜底快照必然剥负载
// （img/voice/超长文本→占位+_lsLite，见 liteSnapArray），每次打开聊天权威收尾都命中此处
// =整窗清空重画=真机「闪屏+弹一下才正常」（小米15Pro 复发；#241 只覆盖「快照缺尾部」
// 形态）。改为对这些下标原位换节点（权威合并后 msgs[i] 已是全量数据），其余节点零重建、
// 窗口条数不变=滚动位置不弹。清单在下方「尾部切片平移」之后才取值（平移后下标才是权威系）。
// DOM [data-idx] 须恰为 renderStart..windowRenderedN-1 顺序排列（时间分隔线无 data-idx 不计；
// 有裁剪/位移/脏节点即放弃，走整窗重建兜底）
let n = renderStart;
const pending = [];
for (let k = 0; k < body.children.length; k++) {
const el = body.children[k];
if (!el.dataset || el.dataset.idx === undefined) continue;
if (Number(el.dataset.idx) !== n) return false;
if (el.dataset.pendingRead === '1') pending.push(el);
n++;
}
if (n !== windowRenderedN) return false;
// FIX 2026-09-21 #1010 屏上窗口是「权威的尾部切片」时的下标平移（见 windowKey* 声明处注释）：
// 判据＝屏上窗口首/尾两条记录的身份，分别命中权威数组的最后 windowRenderedN 条的首/尾
//（媒体无关键，LS 精简态与权威态同键）。命中即认定「屏上内容本来就对，只是 data-idx 是
// 快照内的局部下标」——把 DOM 下标与窗口凭据整体平移 delta，然后照常走 lite 原位升级
//（此时下标已是权威系，升级取到的是正确记录），且不再追加/剪枝（窗口本就贴到最新）。
// 前缀形态（#241：屏上确为权威前段）走原路径逐字节不变；两种都不成立＝整窗重建兜底。
let winShift = 0;
{
const headIdx = renderStart;
const cnt = windowRenderedN - renderStart;
const tailIdx = len - cnt;
const prefixShape = (windowKeyLoVal !== '' && headIdx >= 0 && headIdx < len && chatWinKey(msgs[headIdx]) === windowKeyLoVal);
const tailShape = !prefixShape && cnt > 0 && tailIdx >= 0 && windowKeyHiVal !== '' &&
chatWinKey(msgs[tailIdx]) === windowKeyLoVal && chatWinKey(msgs[len - 1]) === windowKeyHiVal;
if (!prefixShape) {
if (!tailShape) return false; // 说不清＝整窗重建兜底（保守）
// #1010 边界：屏上窗口还没铺满一个渲染窗时（典型＝开机/系统消息只增量画了 1~2 条，
// windowRenderedN 才 2）不能只平移——那等于把「最新 2 条」当成整个窗口，历史全不见。
// 交回整窗渲染（内容正确，构建期由进度条罩着）。
if (cnt < Math.min(len, RENDER_MAX)) return false;
winShift = tailIdx - headIdx;
if (winShift !== 0) {
// ① DOM 下标整体平移（只改属性，不碰节点与内容＝零重建、零重排、零闪动）
for (let k = 0; k < body.children.length; k++) {
const el = body.children[k];
if (el.dataset && el.dataset.idx !== undefined) el.dataset.idx = String(Number(el.dataset.idx) + winShift);
}
// ② 窗口凭据与 lite 残留清单同步平移（残留下标同样是快照内局部下标）
renderStart += winShift;
windowRenderedN = len;
renderEnd = len;
if (Array.isArray(windowRenderedLite)) windowRenderedLite = windowRenderedLite.map(function (i2) { return i2 + winShift; });
// 窗口凭据已贴到最新 ⇒ 下面「尾部增量追加」按新凭据重算追加量为 0（不会把同一批记录再画一遍）
chatWinKeysSync();
try { (window.__patch1010Log = window.__patch1010Log || []).push('tail-shift:' + winShift + '/n' + cnt); } catch (e0) {}
}
}
}
const liteUpgrade = (Array.isArray(windowRenderedLite) ? windowRenderedLite : [])
.filter(i => i >= renderStart && i < windowRenderedN);
if (liteUpgrade.length) {
// #245 残留原位升级：renderMsg 内部 appendMsg 落到 body 末尾后立刻 replaceChild 挪到
// 原位（同一同步任务内无中间绘制）；batchRendering=true 抑制 msg-enter 入场动画与
// maybeScrollChatBottom 副作用，pendingOutScroll 原样保还。任一节点缺失/渲染异常仍
// return false 走整窗重建兜底。
collectInplaceDrafts();
const wasNearBottom = chatNearBottom();
const prevTop = body.scrollTop;
const prevH = body.scrollHeight;
const prevPendingOut = pendingOutScroll;
batchRendering = true;
for (let u = 0; u < liteUpgrade.length; u++) {
const ui = liteUpgrade[u];
const old = body.querySelector('[data-idx="' + ui + '"]');
if (!old) { batchRendering = false; return false; }
let nu = null;
try { nu = renderMsg(msgs[ui], ui); } catch (e) { nu = null; } // #1326：原位补丁同样带真实下标（旧写法在构建在飞时会被误判成迟到节点）
if (!nu || nu.dataset.idx === undefined) { batchRendering = false; return false; }
nu.dataset.idx = ui;
old.parentNode.replaceChild(nu, old);
}
batchRendering = false;
pendingOutScroll = prevPendingOut;
windowRenderedLite = null; // 残留已全部原位补齐
restoreInplaceDrafts();
const dH = body.scrollHeight - prevH;
if (dH) {
if (wasNearBottom) scrollChatBottom(); // 原在底部：升级后保持贴底
else body.scrollTop = prevTop + dH; // 不在底部：按高度差补偿，视口内内容不跳
}
suppressScrollUntil = Date.now() + 200;
if (chatPinnedBottom) chatEntrySettle(); // #841c：lite 占位换成真图后照样有迟到长高，重开同帧贴底窗
}
for (let k = 0; k < pending.length; k++) {
const el = pending[k];
delete el.dataset.pendingRead;
const rec = msgs[Number(el.dataset.idx)];
const b = el.querySelector('.msg-bubble');
if (rec && rec.special === 'read' && b && !rec.retracted &&
b.textContent.indexOf('已读不回') >= 0) {
b.innerHTML = '<span style="opacity:.5;font-size:12px">' + escTxt(rec.text || '已读不回') + '</span>';
}
}
// #1010：尾部切片平移过（winShift≠0）时窗口已贴到最新——不再走尾部增量追加，否则会按旧 grown
// 把同一批记录再画一遍（屏上两份＋随后 prune 削节点＝用户看到的「记录整批闪一下再恢复」）。
if (grown > 0 && !winShift) {
// 尾部增量追加（复用滚动加载的增量路径：新条目照常渲染/锚定/prune，已有节点零重建）；
// 追加没补齐（异常）返回 false，调用方整窗重建兜底（renderWindow 清空重来，状态自洽）
for (let r = 0; r < Math.ceil(grown / LOAD_STEP) + 1 && renderEnd < len; r++) loadNewerIncremental(len);
if (renderEnd !== len) return false;
windowRenderedN = len; // 凭据随增量补齐——loadNewerIncremental 只更 renderEnd，不补此处则下次收尾 grown 错位仍整窗（自纠）
}
return true;
}
// FIX 2026-09-13 #402：归一化收尾的窗口内原位补丁——只重渲 normChangedIdxs 命中且在
// 屏上窗口内的下标（renderMsg + replaceChild 同步换节点，同一同步任务无中间绘制），
// 其余节点零重建＝不触发整窗重解码重排，视口不跳。守卫链对齐 inplacePatchIfSameWindow：
// ① DOM [data-idx] 恰为 start..windowRenderedN-1 齐整（有裁剪/位移/脏节点即放弃）；
// ② 存在 pendingRead 已读占位节点则放弃（占位收尾属 inplacePatchIfSameWindow 职责）；
// ③ 任一节点渲染异常即恢复现场返回 false，调用方整窗重建兜底（状态自洽）。
// 高度差补偿与 #245 liteUpgrade 同口径：原在底部→贴底跟随；不在底部→scrollTop 按高度差
// 平移，视口内内容不动。返回 true=已原位补丁（或屏上无命中无需动）；false=整窗兜底。
function patchChangedInPlace(changedIdxs, start) {
// 诊断钩子（__mochiProf 同族）：记录每次收尾补丁的判定路径，供真机/无头排查
const __plog = function (tag) { try { (window.__patch402Log = window.__patch402Log || []).push(tag); } catch (e) {} };
if (!Array.isArray(changedIdxs) || !changedIdxs.length) { __plog('noop-empty'); return true; }
let n = start;
let hasPending = false;
for (let k = 0; k < body.children.length; k++) {
const el = body.children[k];
if (!el.dataset || el.dataset.idx === undefined) continue;
if (Number(el.dataset.idx) !== n) { __plog('fail-idx@' + k); return false; }
if (el.dataset.pendingRead === '1') hasPending = true;
n++;
}
// FIX 2026-09-13 #402 自纠：屏上窗口可能是「整窗渲染后增量追加/上翻」的拼接态——凭据
// windowRenderedN 只在整窗渲染时登记（loadNewerIncremental 只更 renderEnd 不补凭据），
// 拿它当屏上窗口终点会把合法拼接态误判回退整窗重建（无头实测 rm303+ad200 复现）。
// 改用 DOM 推导的连续 idx 终点 n，并要求与 renderStart..renderEnd 区间严格一致
// （时间分隔线无 data-idx 不计；prune 前后两端区间与 DOM 恒同步）。
if (n !== renderEnd - renderStart) { __plog('fail-range n=' + n + ' re=' + renderEnd + ' rs=' + renderStart); return false; }
if (n > msgs.length) { __plog('fail-len'); return false; }
if (hasPending) { __plog('fail-pending'); return false; }
const idxs = changedIdxs.filter(i => i >= start && i < n && i < msgs.length).sort((a, b) => a - b);
if (!idxs.length) { __plog('noop-outside'); return true; } // 改动都不在屏上窗口＝无需动 DOM
collectInplaceDrafts();
const wasNearBottom = chatNearBottom();
const prevTop = body.scrollTop;
const prevH = body.scrollHeight;
const prevPendingOut = pendingOutScroll;
batchRendering = true;
for (let u = 0; u < idxs.length; u++) {
const ui = idxs[u];
// 不限定 .msg 类——拍一拍/红包等消息节点类名各异（msg-poke/msg-rp…），data-idx 才是
// 渲染路径统一写入的定位属性（旧版 fail-node@0 cls=msg-poke 实证）
const old = body.querySelector('[data-idx="' + ui + '"]');
if (!old) { batchRendering = false; restoreInplaceDrafts(); __plog('fail-node@' + ui); return false; }
let nu = null;
try { nu = renderMsg(msgs[ui], ui); } catch (e) { nu = null; } // #1326：原位补丁同样带真实下标（旧写法在构建在飞时会被误判成迟到节点）
if (!nu || nu.dataset.idx === undefined) { batchRendering = false; restoreInplaceDrafts(); __plog('fail-render@' + ui); return false; }
nu.dataset.idx = ui;
old.parentNode.replaceChild(nu, old);
if (Array.isArray(windowRenderedLite)) windowRenderedLite = windowRenderedLite.filter(x => x !== ui);
}
__plog('ok:' + idxs.length);
batchRendering = false;
pendingOutScroll = prevPendingOut;
restoreInplaceDrafts();
const dH = body.scrollHeight - prevH;
if (dH) {
if (wasNearBottom) scrollChatBottom(); // 原在底部：升级后保持贴底
else body.scrollTop = prevTop + dH; // 不在底部：按高度差补偿，视口内内容不跳
}
suppressScrollUntil = Date.now() + 200;
if (chatPinnedBottom) chatEntrySettle(); // #841d：归一化原位换节点后同样有迟到长高，重开同帧贴底窗
return true;
}
// FIX 2026-09-17 #675：归一化「结构性删除」（normCollapseRange 删相邻重复）的原位收敛——
// 旧路径 finish 一律 renderWindow 整窗重建＝rem+add ~200 节点同批、全部 img 销毁重建逐张
// 重新解码＝打开聊天 ~250ms 后「消息全部弹一下再恢复」（#402 只收了无删除的字段级路径，
// 本条是同族最后一条整窗路径）。做法：按「记录 → 原始下标」（normOrigIdx）找到被删节点
// 原地移除，幸存节点 data-idx 按「原始下标 − 前方删除数」回推到新下标系（含窗口凭据
// renderStart/renderEnd/windowRenderedN/windowRenderedLite 同步平移），其余节点零重建＝
// 图片不重新解码、视口不弹。删除只让相邻间距变大＝既有时间分隔线判定不会失效，仅可能
// 出现两枚胶囊相邻/尾悬——同批顺手去堆叠。任一守卫不满足返回 false，调用方整窗兜底。
function patchNormRemovalsInPlace(removedRecs) {
if (!removedRecs || !removedRecs.length) return true; // 无删除＝无需动 DOM
if (!normOrigIdx) return false;
// 归一化运行期间可能有新消息追加（addRec 尾部 append，data-idx 已是新下标系）——以快照尾
// 节点为界分段：界前(含)＝原始系节点（按「原始下标 − 前方删除数」回推），界后＝追加系节点
// （下标已正确，不动）。快照尾已不在屏上＝运行期窗口被整体重建过＝下标系已换，保守整窗兜底。
const tailEl = normSnapTail;
if (!tailEl || !body.contains(tailEl)) return false;
const removedIdx = [];
for (let i = 0; i < removedRecs.length; i++) {
const oi = normOrigIdx.get(removedRecs[i]);
if (typeof oi !== 'number') return false; // 身份对不上＝保守整窗兜底
removedIdx.push(oi);
}
removedIdx.sort(function (a, b) { return a - b; });
const shiftsBefore = function (idx) {
let c = 0;
for (let i = 0; i < removedIdx.length && removedIdx[i] < idx; i++) c++;
return c;
};
const rmSet = new Set(removedIdx);
// 分段收集（时间分隔线无 data-idx 不计）
const origNodes = [], appNodes = [];
for (let k = 0; k < body.children.length; k++) {
const el = body.children[k];
if (!el.dataset || el.dataset.idx === undefined) continue;
if (el === tailEl || (el.compareDocumentPosition(tailEl) & Node.DOCUMENT_POSITION_FOLLOWING)) origNodes.push(el); // FOLLOWING＝tailEl 在 el 之后＝el 属界前原始系
else appNodes.push(el);
}
// 干跑：先算出每个节点的动作与最终下标序（新系须从平移后的 renderStart 起连续、终点贴权威
// 末条），任何不齐（裁剪/位移/脏节点/追加系序衔接不上/已读占位在场）＝放弃，回退整窗兜底
const plan = [];
let expect = renderStart - shiftsBefore(renderStart);
let hasPending = false;
for (let k = 0; k < origNodes.length; k++) {
const el = origNodes[k];
if (el.dataset.pendingRead === '1') hasPending = true;
const oi = Number(el.dataset.idx);
if (rmSet.has(oi)) { plan.push({ el: el, rm: true }); continue; }
const ni = oi - shiftsBefore(oi);
if (ni !== expect) return false;
plan.push({ el: el, rm: false, ni: ni });
expect++;
}
for (let k = 0; k < appNodes.length; k++) {
const v = Number(appNodes[k].dataset.idx);
if (v !== expect) return false; // 追加系下标与回推序衔接不上（追加后又发生过删除位移）＝整窗兜底
plan.push({ el: appNodes[k], rm: false, ni: v });
expect++;
}
if (hasPending || expect !== msgs.length) return false;
collectInplaceDrafts();
const wasNearBottom = chatNearBottom();
const prevTop = body.scrollTop;
const prevH = body.scrollHeight;
const prevPendingOut = pendingOutScroll;
batchRendering = true;
try {
for (let k = 0; k < plan.length; k++) {
const p = plan[k];
if (p.rm) { if (p.el.parentNode) p.el.parentNode.removeChild(p.el); }
else if (p.el.dataset.idx !== String(p.ni)) p.el.dataset.idx = String(p.ni);
}
} catch (e) {
batchRendering = false; pendingOutScroll = prevPendingOut; restoreInplaceDrafts();
return false;
}
batchRendering = false;
pendingOutScroll = prevPendingOut;
// 分隔线去堆叠：删除后可能「两枚时间胶囊相邻」或「分隔线悬在窗口尾」——只删多余胶囊，
// 不重算（删除只会让相邻间距变大，现存判定不会失效）
try {
const kids = body.children;
for (let k = kids.length - 2; k >= 0; k--) {
if (kids[k].classList && kids[k].classList.contains('msg-time-divider') &&
kids[k + 1].classList && kids[k + 1].classList.contains('msg-time-divider')) {
kids[k].parentNode.removeChild(kids[k]);
}
}
while (body.lastChild && body.lastChild.classList && body.lastChild.classList.contains('msg-time-divider')) {
body.removeChild(body.lastChild);
}
} catch (e) {}
restoreInplaceDrafts();
renderStart -= shiftsBefore(renderStart);
renderEnd = msgs.length;
windowRenderedN = msgs.length; // 凭据同步平移（否则下次同窗补丁 grown 错位又整窗）
if (Array.isArray(windowRenderedLite)) {
windowRenderedLite = windowRenderedLite
.filter(x => !rmSet.has(x))
.map(x => x - shiftsBefore(x));
}
chatWinKeysSync(); // #1010：归一化结构删除后窗口下标平移，身份凭据同步
const dH = body.scrollHeight - prevH;
if (dH) {
if (wasNearBottom) scrollChatBottom(); // 原贴底：删除后保持贴底
else body.scrollTop = prevTop + dH; // 不在底部：按高度差平移，视口内内容不跳
}
suppressScrollUntil = Date.now() + 200;
return true;
}
function loadOlderIncremental() {
if (batchRendering) return; // #874b：构建中途重入会把 appendTarget 改道（自身 frag 在空 body 下整批丢弃）并把 renderStart 白前移＝finishSwap 首批被甩到列表尾＝底部永远是旧记录
const len = msgs.length;
if (renderStart <= 0 || renderStart >= len) {
// #722：已到已加载历史的顶部——头部冷块还有货就先 rebase（并入+位移下标），并入后
// renderStart>0，本次直接继续走增量；冷块还在后台取回时先触发取回，等下一轮滚动。
if (renderStart <= 0 && !chatRebased) {
if (chatColdHead.length) { chatRebaseCold(); loadOlderIncremental(); return; }
if (!chatColdDone) chatColdEnsureHydrated();
}
if (renderStart <= 0 || renderStart >= len) return;
}
const newStart = Math.max(0, renderStart - LOAD_STEP);
if (newStart === renderStart) return;
const beforeTop = body.scrollTop;
const preNum = body.children.length;
const anchor = body.children[0] || null;
batchRendering = true;
const frag = document.createDocumentFragment();
appendTarget = frag;
appendAvatarBatch(true);
// FIX 2026-09-29 #1389（用户第五次复报同一句话「把浏览器挂着后台一段时间，然后回来，聊天里依旧不显示回来后
// 新发的聊天消息，一片空白，页面看起来可以滑动飞出屏幕，要重新刷新网页才恢复正常」，明说其他设备型号也有、
// 要求不要覆盖式修补）：判据只取一个事实——「一条记录画不出来，不许把渲染器从此改道」。零机型／零 UA 分支。
// 根因（无头确定性复现＝tools/verify-1389-incremental-render-blackhole.mjs，红侧读数逐字就是症状本体：
// flying:true 而 stalled:true→false 恒假、屏上节点恒 200、msgs 400→402、新发的两条永不落屏、8s 后仍不自愈）：
// 这两个**同步增量轮**与 renderWindow 的分帧轮同构（同样 batchRendering=true、同样把 appendTarget 改道进一块
// DocumentFragment），却既没有 #919a/#1313 的逐条 try/catch，也没有 finally。一条记录把 renderMsg 弄抛
// （#919a 注释里留着真机 buildChunk→renderMsg「reading 'side'」的实锤），异常一路抛出函数外
// ⇒ batchRendering 永久为真、appendTarget 永久指向那块没人会挂上去的 fragment ⇒ 此后每一条新消息都被
// appendMsg 写进这个黑洞（appendMsg 结尾就是 `(appendTarget || body).appendChild(m)`）＝用户所见「回来后新发的
// 消息不显示、只有刷新恢复」。而 #1313 那轮的看门狗结构上救不到这一发：chatPumpStalled() 第一行
// `if (!batchRendering || !chatPump) return false;`——泵只在分帧整窗轮登记，同步增量轮根本没有泵，于是「在飞」
// 恒真而「停滞」恒假，于是所有让路闸（#874a/b/c 入口、armWindowHoleHeal、回场复核 heal、#716 贴底看门狗、
// #841 进页收尾）永久早退；屏上还留着上一次的窗口而它已对不上内存，就是「一片空白＋能滑出屏幕」那一半。
// 前四轮各补了一条循环（分帧 4515、同步整窗 4595、原位补丁 4743 与 4825），漏的正是这两条——所以症状一直在，
// 而每一轮的尺子都绿：它们量的都是「节点在不在 DOM 里」，没有一总量过「渲染器有没有被永久改道」。
// 改法＝把这两条循环补齐成与 #1313 同一形态：逐条 try/catch（坏记录跳过并留证，口径同 threwIdx，刻意不喂
// armWindowHoleHeal＝避免「重画→又抛→又排」的 700ms 空转）＋ finally 无条件把头像批／appendTarget／
// batchRendering 交回，让「抛出去」不再是一种能持久的状态。
let _incrThrew = 0;
try {
for (let i = newStart; i < renderStart; i++) {
try {
maybeInsertDivider(i); // 时间分隔线：新批首条与前一条间距大时补胶囊
const m = renderMsg(msgs[i], i); // #1326：同上——下插/追加批也要在挂载前落定真实下标
m.dataset.idx = i;
} catch (eThrow) { _incrThrew++; } // #1389：单条记录不许带走整批，更不许把 appendTarget 留在半路上
}
} finally {
appendAvatarBatch(false);
appendTarget = null;
batchRendering = false;
}
renderStart = newStart;
chatWinKeysSync(); // #1010：上翻增量改了窗口头，身份凭据同步
if (_incrThrew) { windowStale = true; chatRenderIncident('incr-older-throw', 0, _incrThrew); } // #1389：屏上确实少一条＝作废同窗凭据＋留证（不排自愈，见上）
if (preNum > 0 && anchor) {
// FIX 2026-09-13 #396（红米 K80 Chrome 等多机型「聊天/群聊滑动屏幕会弹」）：旧补偿式
// beforeTop + anchor.offsetTop 读的是插入后首元素的 offsetTop＝插入高度 + .chat-body
// padding-top，每批上翻固定把视口多推 14px＝视觉跳一下；锚定 auto（#316）只能兜住
// 图片迟到解码那部分、兜不住这 14px（无头实测：Δsh=8903 补偿误差恒 -14px 视觉跳变）。
// 改锚点前后差值＝纯插入高度，对齐群聊 loadEarlier 的 scrollHeight 差值口径（实测误差 0）。
const anchorTopBefore = anchor.offsetTop;
body.insertBefore(frag, anchor);
body.scrollTop = beforeTop + (anchor.offsetTop - anchorTopBefore);
} else {
body.scrollTop = body.scrollHeight; // 原窗口为空，直接滚到底
}
if (renderEnd - renderStart > WINDOW_MAX) pruneWindowBottom();
suppressScrollUntil = Date.now() + 200;
}
function loadNewerIncremental(targetLen) {
if (batchRendering) return; // #874c：同 #874b——增量下插/追加在构建期改道 appendTarget 会踩乱换装顺序
const len = msgs.length;
// FIX 2026-09-07 #241：可选 targetLen——原地补丁的尾部增量一次补到权威长度（不传=
// 滚动加载语义不变，每批 LOAD_STEP）
const want = (typeof targetLen === 'number' && targetLen > 0) ? Math.min(targetLen, len) : len;
if (renderEnd >= want) return;
const newEnd = Math.min(want, renderEnd + LOAD_STEP);
if (newEnd === renderEnd) return;
batchRendering = true;
let anchor = null;
const frag = document.createDocumentFragment();
appendTarget = frag;
appendAvatarBatch(true);
// FIX 2026-09-20 #918（红米 K80 Chrome 实报「进聊天弹闪一下才恢复、没有加载动画」，多机型同现）：
// 屏上下标一次成表、循环内改查表。旧写法每补一条都 body.querySelector('[data-idx=i]') 全表扫描，
// 屏上没有更新的下标时还要把 i+1..len 再逐个扫一遍找锚点——「LS 尾部快照 → 权威全量」的进页补尾
// 按 LOAD_STEP 分批 × 每批 100 条 × 数百次全表扫，600 条历史无头实测单轮 querySelector 自耗 3.2s
// 纯主线程冻结（画面停在 40 条旧快照、进度条也画不动，解冻瞬间一次性落成全量画面＝肉眼「闪一下才恢复」；
// 无头取证：两侧都没有 renderWindow 的清空重画，闪的成因是这段冻结本身，不是重建）。
// 命中判定与锚点选取口径与 #766 的纯属性选择器一字不差（同一份 body 子树快照），只换查找方式。
const onScreen = new Map(); // #918a：屏上 data-idx 索引（一轮 O(DOM) 建表，替代循环内全表 querySelector）
for (const el of body.querySelectorAll('[data-idx]')) {
const k = parseInt(el.dataset.idx, 10);
if (Number.isFinite(k) && !onScreen.has(k)) onScreen.set(k, el);
}
let _incrThrew = 0; // #1389：见 loadOlderIncremental 上方那段批注（同一根因的第二条循环）
try {
for (let i = renderEnd; i < newEnd; i++) {
// FIX 2026-09-18 #766：幂等守卫改**纯属性选择器**。旧写法 `.msg[data-idx="i"]` 只认 .msg 类，而
// 拍一拍/系统提示/游戏结算等节点类名各异（msg-poke / msg-rps / msg-pong / msg-center…）不带 .msg
// ⇒ 这类消息「已经画过」查不出来 ⇒ 缺口补画时原样再画一遍＝用户看到的「一条消息变多条」。
// data-idx 是渲染路径统一写入的定位属性（见 renderMsg 头部与 pruneWindow/querySelectorAll('[data-idx]')
// 既有口径），按属性查与类名彻底解耦，今后新增消息类型也自动受保护。anchor 定位同理。
if (onScreen.has(i)) continue; // #766a：守卫口径不变（#918 把「查 DOM」换成「查上面那张表」）
if (!anchor) {
for (let j = i + 1; j < len && !anchor; j++) anchor = onScreen.get(j) || null; // #918b：锚点同批改查表（旧写法每个未命中下标都全表扫一次）
}
try {
maybeInsertDivider(i);
const m = renderMsg(msgs[i], i); // #1326：同上——下插/追加批也要在挂载前落定真实下标
m.dataset.idx = i;
} catch (eThrow) { _incrThrew++; } // #1389：单条记录不许带走整批，更不许把 appendTarget 留在半路上
}
} finally {
appendAvatarBatch(false);
appendTarget = null;
batchRendering = false;
}
renderEnd = newEnd;
if (_incrThrew) { windowStale = true; chatRenderIncident('incr-newer-throw', 0, _incrThrew); } // #1389：屏上少一条＝作废同窗凭据＋留证（刻意不排自愈，同 #1313 的 threwIdx 口径）
if (anchor) body.insertBefore(frag, anchor);
else if (frag.childNodes.length) body.appendChild(frag);
if (newEnd - renderStart > WINDOW_MAX) pruneWindowTop();
suppressScrollUntil = Date.now() + 200;
}
// FIX 2026-09-21 #972：裁剪/钳位循环要能「按消息归属」看待时间分隔线——分隔线自身没有 data-idx，
// 它归属紧随其后的那条消息（插入时就是插在该条前面）。旧口径对无 data-idx 的节点一律当「可删」，
// 在分隔线已正确穿插之后会把「第一条被保留消息」头上的那枚分隔线一起削掉（丢时间轴标记）。
// 归属取不到（分隔线后面没有消息行，正常不该出现）＝undefined，沿用旧口径当可删。
function nodeKeepIdx(f) {
if (!f) return undefined;
if (f.dataset && f.dataset.idx !== undefined) return parseInt(f.dataset.idx, 10);
const nx = f.nextElementSibling;
if (nx && nx.dataset && nx.dataset.idx !== undefined) return parseInt(nx.dataset.idx, 10);
return undefined;
}
// FIX 2026-09-21 #1004：渲染窗「记录位空洞」自愈——#919a/#919b 的 continue 保护了分帧链不被单条坏记录
// 打断，但被跳过的下标此后没有任何补画入口（窗口是连续区间，增量路径只补两端），屏上就永久少一条。
// 这里在这些位**全部变成真记录**之后补一次整窗重画：仍是空洞（数据侧确实缺记录）就直接返回
// ＝不排队＝自终止，绝不空转。一次只排一枪，构建在飞/离开聊天页不落发。
let _holeHealT = null;
function armWindowHoleHeal(idxs) {
if (_holeHealT) return;
_holeHealT = setTimeout(function () {
_holeHealT = null;
if (batchRendering || !chatVisible()) return;
for (let k = 0; k < idxs.length; k++) { const m = msgs[idxs[k]]; if (!m || typeof m !== 'object') return; }
renderWindow(true, false);
}, 700);
}
function pruneWindowBottom() {
const targetEnd = renderStart + WINDOW_MAX;
if (renderEnd <= targetEnd) return;
while (body.lastChild) {
const last = body.lastChild;
const idx = nodeKeepIdx(last); // #972：分隔线按其后那条消息的归属下标判
if (idx !== undefined && idx < targetEnd) break; // 已到应保留区
body.removeChild(last);
}
renderEnd = targetEnd;
chatWinKeysSync(); // #1010：窗口尾变了，身份凭据同步
}
function pruneWindowTop() {
const targetStart = renderEnd - WINDOW_MAX;
if (renderStart >= targetStart) return;
while (body.firstChild) {
const f = body.firstChild;
const idx = nodeKeepIdx(f); // #972：同上
if (idx !== undefined && idx >= targetStart) break; // 已到应保留区
body.removeChild(f);
}
renderStart = targetStart;
chatWinKeysSync(); // #1010：窗口头变了，身份凭据同步
}
// v3.27.x #846「发完消息闪一下」专用钳位：与 pruneWindowTop 同为裁顶，但带上「视口不动」两件事
// ——①只删 scrollTop 之上的节点（屏上可见区一个节点都不碰，故无重建无重解码）；②按删掉的高度
// 补偿 scrollTop，删完画面纹丝不动。调用方随后照常增量追加新消息。
function trimWindowTopQuiet(maxN) {
const targetStart = Math.max(0, renderEnd - maxN);
if (renderStart >= targetStart) return;
const h0 = body.scrollHeight;
while (body.firstChild) {
const f = body.firstChild;
const idx = nodeKeepIdx(f); // #972：分隔线按其后那条消息的归属下标判（别削掉被保留消息头上的那枚）
if (idx !== undefined && idx >= targetStart) break; // 已到应保留区
body.removeChild(f);
}
renderStart = targetStart;
chatWinKeysSync(); // #1010：窗口头变了，身份凭据同步
const cut = h0 - body.scrollHeight;
if (cut > 0) body.scrollTop = Math.max(0, body.scrollTop - cut);
suppressScrollUntil = Date.now() + 200; // 本次程序化 scrollTop 写入不算用户滚动（否则补偿位会误触发上翻加载）
}
let bodyScrollTimer = null;
let _chatScrollActTs = 0; // #765：列表最近一次滚动时刻（手指拖动/抬手后的惯性滑行/滚轮都算），看门狗据此让路
body.addEventListener('scroll', function () {
_chatScrollActTs = Date.now(); // #765：写在抑制判定之前——程序写入与用户滑动同样需要让路
if (Date.now() < suppressScrollUntil) return;
if (bodyScrollTimer) return;
bodyScrollTimer = setTimeout(function () {
bodyScrollTimer = null;
if (!chatVisible()) return;
if (batchRendering) return; // #874a：分帧整窗重建的空窗期（body 已清空、新窗未换装）里到达的 scroll 不作数——清空旧滚动位被钳回 0 必发事件，防抖 100ms 撞上慢设备构建时长就误触发上翻加载
if (body.scrollTop < TOP_THRESHOLD) {
loadOlderIncremental();
} else if (renderEnd < msgs.length && body.scrollHeight - body.scrollTop - body.clientHeight < TOP_THRESHOLD) {
loadNewerIncremental();
}
// FIX #378：解钉后用户手动滚回贴底＝回钉，自动跟底恢复——旧口径解钉后只有自己发
// 一条消息才会重新钉住，期间联系人来消息全部不跟底（表现「不自动滚到最新」）
// FIX #416：回钉只认「真的滚到底」（≤8px）——旧阈值 120px 把「上翻读最新一条就停下」
// 也当回钉，每次点滑动都被拽回最底下（见 chatAtBottom 注释）
// FIX 2026-09-20 #933（iPhone 12 Pro Max Safari 实报「聊天记录上划太用力还是会错位，跑到屏幕
// 上半位置，下半是空的，但点击屏幕即可恢复」，用户点名多机型同现、勿致其他机型回归）：
// 回钉不再当场写。上划用力＝抬手后惯性还在走/底部橡皮筋回弹中，而本回调是 100ms 防抖
//（#716 只挡「手指在屏」的手势期，抬手后的惯性滑行照样算解钉态），撞进这段时间窗就把
// scrollTop 写在动画中途；#871 真机结论＝中途写会让 WebKit 滚动树停在旧偏移（内容整块上移、
// 下方留白），且此刻 pinned 已置、#706 看门狗只认「离底 >8px 没到底」这一种失底（scrollTop
// 超界/撕裂时 scrollTop ≥ max 恒不成立）永不复查 ⇒ 只有轻点 touchend 的
// chatAtBottom()→scrollChatBottom() 写得回来＝「点屏幕即可恢复」。
// 修法＝钉住标记当场置（自动跟底语义零回退），几何写入交下方 chatScrollRealignQuiet 落定锁：
// 滚动/惯性/几何全静默后只写一枪。零机型分支：写发生在静默期，健康引擎只是重写同一个值。
else if (!chatPinnedBottom && !chatTouchActive && chatAtBottom()) { // #716：手势进行中不回钉（防刚离底 ≤8px 被误判「滚回贴底」拽回）
chatPinnedBottom = true; body.classList.remove('scroll-anchor-auto'); chatScrollRealignQuiet();
}
}, 100);
}, { passive: true });
// FIX #162：用户手动触摸/滚轮滚动＝解除贴底钉住，之后的自动复写不再抢滚动权
// FIX #316：解钉同时开回浏览器滚动锚定（见上方 unpinChatAndAnchor 注释）
// FIX #378：解钉只认「真实滚动意图」——轻点消息区（点气泡/长按入口，位移<10px）且
// 仍贴底时回钉，自动跟底不再被一次轻点永久杀死；拖动/惯性滚动仍正常解钉，滚回贴底
// 由下方 scroll 监听回钉
// FIX #416：轻点回钉同样只认「真的贴到底」——旧 chatNearBottom（离底<120px）让用户
// 上翻看最新消息时随便一点气泡就被拽回最底
let chatUnpinTsY = 0;
let chatTouchActive = false; // #716：触摸手势进行中——手势刚开始、离底还 ≤8px 时，「解钉后滚回贴底＝回钉」防抖会误判回钉，随后 #706 看门狗每 250ms 把进行中的上滑拽回底＝「反复回弹」（红米 K80 实报：刚开始滑动最明显）。手势期两个自动回钉都让路
body.addEventListener('touchstart', function (e) {
try { chatUnpinTsY = e.touches[0].clientY; } catch (err) { chatUnpinTsY = 0; }
chatTouchActive = true;
if (!batchRendering) unpinChatAndAnchor(); // #874d：空窗期屏上没有列表可翻，进度条期的一次上滑不该把贴底永久解掉（finishSwap 落底全看 pinned）
}, { passive: true, capture: true });
body.addEventListener('touchend', function (e) {
chatTouchActive = false; // #716：手势结束才恢复自动回钉资格
try {
const dy = Math.abs(e.changedTouches[0].clientY - chatUnpinTsY);
if (dy < 10 && chatAtBottom()) scrollChatBottom();
} catch (err) {}
}, { passive: true });
body.addEventListener('touchcancel', function () { chatTouchActive = false; }, { passive: true }); // #716
body.addEventListener('wheel', function () { if (!batchRendering) unpinChatAndAnchor(); }, { passive: true }); // #874e：与 #874d 同闸
// FIX #466（红米/小米 Chrome 等多机型报「发送消息时界面闪到最顶上半部分再恢复」）：
// 安卓键盘弹出/收起会让 mobile-adapt 按 visualViewport 高度改 .phone 高度，聊天 scrollTop
// 却不会随之更新＝消息列表长期被键盘顶到上半区、最新消息被盖住，到发送/收键盘那刻才被
// scrollChatBottom 拽回＝观感「闪一下再恢复」。补钉住守卫的回钉：视口高度变化（键盘/地址栏
// 显隐）且仍贴底钉住时回到底部；用户手动滚动解钉即停，与 #162 闸同名语义，零机型分支。
// #871：这里的「60ms 单次防抖」改走 chatRepinAfterSettle()（见下方同闸助手）——不再自己定时刻，
// 而是等几何真正落定后只写一次；函数名与 vv resize 接线保持原样（哨兵 #466 锚点）。
function refreshKbRepin() {
chatRepinAfterSettle();
}
(function () {
const vv466 = window.visualViewport;
if (vv466) vv466.addEventListener('resize', refreshKbRepin);
})();
// FIX 2026-09-16 #643（iPhone 17 Pro Edge 等多机型报「发消息后消息和屏幕都上移，最新消息不在
// 底部而跑到屏幕上半部分」，用户要求勿致其他机型回归）：#466 的回钉只挂 visualViewport resize——
// 两个洞：①iOS 键盘收起偶发**不派发**该事件（程序化 blur/完成键收起最易触发，发送时清空聚焦的
// contenteditable 正中此路，mobile-adapt「键盘状态自愈」注释同款场景）；②事件先到、mobile-adapt
// 恢复 .phone 高度**后到**（失焦后 250ms 轮询兜底才 restore），60ms 防抖回钉算出的还是旧
// clientHeight，最终布局落地后无人再补滚 ⇒ 列表停在旧 scrollTop、最新消息悬在半屏、下方一大片
// 空白。改挂 **chat-body 自身盒子** 的 ResizeObserver：无论高度变化来自键盘收起、地址栏/工具条、
// 还是 .phone 内联高度恢复，「盒子真变了」这一事实发生时才回钉，天然躲开事件时序竞态；仍受
// chatPinnedBottom 闸约束（用户翻历史＝解钉，绝不拽底，#162 契约不变）。无 ResizeObserver 的
// 老内核保留 #466 原路，零回退。scrollChatBottom 只写 scrollTop、不改 chat-body 盒子，不会自激励成环。
let _cbBoxChangeTs = 0; // 聊天盒自身最近一次变尺寸时刻（下面 #643 的 RO 里记；无 RO 的老内核恒 0＝不成为闸）
(function () {
const cb643 = document.getElementById('chat-body');
if (!cb643 || typeof ResizeObserver === 'undefined') return;
new ResizeObserver(function () {
// #871：盒子变化本身＝「还在变形」的最新证据，先记时刻再交给同闸助手（旧写法 60ms 后照写，
// 而 mobile-adapt 恢复 .phone 内联高是分步到位的，那一枪常打在中间态高度上＝回弹）。
_cbBoxChangeTs = Date.now();
chatRepinAfterSettle();
}).observe(cb643);
})();
// FIX 2026-09-17 #706（iPhone 17 Safari 26.6 iOS 独立应用实报「聊天里所有消息不贴底、
// 一直停在上半屏/中部，输入栏只有打字（键盘压缩布局）时才可见」，用户明说多机型同现，
// 要求勿致其他机型回归）：#466/#643 两级回钉都是「事件触发 + 60ms 单次防抖」——事件只在
// 几何变化的**某一帧**发一次，iOS 26 Safari 起 viewport meta 的 interactive-widget=
// resizes-content 被真正执行（键盘期 innerHeight 本体也参与变形、vv/inner 分多帧落位），
// 回钉写入常落在中间态布局上，此后事件不再发、RO 也定格 ＝ 无人再校正，列表永久停错位。
// 修法：**几何看门狗**——聊天页可见且钉住态时周期复核「scrollTop 是否等于贴底目标
// （chatScrollMax，行隐藏态口径）」，不等于且视口变形已落定（最近 180ms 无 vv/inner 变化）
// 就补钉。只认几何事实、不认任何事件，机型/内核零分支；仍受 #162 钉住闸约束（用户翻历史
// ＝解钉，绝不拽底）、#416 口径（≤8px 算贴底不折腾）、平滑滚动/批量渲染期让路。「变形中
// 不写、落定后一次校正」同时消掉发消息瞬间「低栏弹跳」的钳位回弹（写入不再落在瞬态布局上）。
// #765（iOS 收口，判定口径不变）：#716 的 chatTouchActive 只覆盖到 touchend，抬手后的**惯性滑行**
// 期列表照旧在滚，此时看门狗仍会写 scrollTop＝「往上滑被拽回底部」在 iPhone 上的残根。故再加一
// 闸：滚动落定（200ms 内无 scroll 事件）前一律让路，与「变形中不写」同构、零机型分支。
let _vvGeomChangeTs = 0;
(function () {
const vv706 = window.visualViewport;
const mark706 = function () { _vvGeomChangeTs = Date.now(); };
if (vv706) { vv706.addEventListener('resize', mark706); vv706.addEventListener('scroll', mark706); }
window.addEventListener('resize', mark706);
})();
// FIX 2026-09-19 #871（红米 K80 实报「发送消息后收起输入法弹窗，聊天消息还是会闪屏回弹一下、
// 然后恢复正常」，用户点名其他型号同现，并说明「主动开/关全屏模式」也闪）：#466/#643 两个
// 快速回钉各自 60ms 单发，而一次键盘收起/全屏切换的几何变化是**分多帧、多步**落地的（vv resize
// 先响、mobile-adapt 随后分步恢复 .phone 内联高、聊天盒跟着再变）。60ms 那一枪常打在中间态
// 高度上＝按「假底部」写 scrollTop，等真布局落地后 #706 看门狗再校正一次＝肉眼所见「弹一下
// 再恢复」。修法＝两个回钉不再自己定时刻，统一走下面这把与 #706 **同闸**的落定锁：几何
// （视口/盒子）与列表滚动都静默够久才写，且一次变形只写一枪；静默不了 1200ms 就彻底放弃，
// 交回看门狗周期复核——绝不与用户滑动/触摸对打（#716/#765 契约不变），零机型分支。
let _kbSettleT = null;
let _kbSettleDeadline = 0;
function chatRepinQuietEnough(now) {
return now - _vvGeomChangeTs >= 180 && now - _cbBoxChangeTs >= 180 && now - _chatScrollActTs >= 200 && !batchRendering && !_ccSmoothT && !chatTouchActive;
}
function chatRepinAfterSettle() {
if (!chatVisible() || !chatPinnedBottom || _kbSettleT) return; // 已有一枪在膛：由它负责复查，不重复排队
_kbSettleDeadline = Date.now() + 1200;
_kbSettleT = setTimeout(chatRepinStep, 120);
}
function chatRepinStep() {
_kbSettleT = null;
const now = Date.now();
if (!chatVisible() || !chatPinnedBottom) return; // #162：用户已解钉（翻历史/触摸）＝绝不拽底
if (!chatRepinQuietEnough(now)) { if (now < _kbSettleDeadline) _kbSettleT = setTimeout(chatRepinStep, 120); return; }
const cb868 = document.getElementById('chat-body');
if (cb868 && chatScrollMax() - cb868.scrollTop > 8) scrollChatBottom(); // #416：≤8px 不折腾
}
setInterval(function () {
if (!chatVisible() || batchRendering || _ccSmoothT || chatTouchActive) return; // #716：触摸手势进行中不让路=看门狗与用户上滑对打
if (Date.now() - _chatScrollActTs < 200) return; // #765：列表滚动中（含抬手后的惯性滑行）不让路，落定后再复核
if (Date.now() - _vvGeomChangeTs < 180) return; // 视口变形进行中不写，等落定
if (Date.now() - _cbBoxChangeTs < 180) return; // #871：聊天盒还在变尺寸（mobile-adapt 分步恢复中）同样不写
const cb706 = document.getElementById('chat-body');
if (!cb706) return;
// FIX 2026-09-21 #998：解钉态周期复核——「用户自己滚回真底部（≤8px）」＝「他在看历史」这个前提已消失，
// 恢复自动跟底。这条语义 #378 早就写进了滚动监听，但那条是「滚动事件 + 100ms 防抖」的一次性判据：
// 判完即止、副作用一过再没人复核，手势期一撞 chatTouchActive 就放弃且不续期＝钉住态永久丢失的根
// （无头实证：上滑翻两下→滑回最底→按住停一下才抬手，抬手后停在最底 gap=0，来消息却不再跟底、
// 连发 gap 累积到 133.7px）。这里补成周期复核，与下面「钉住态离底即补钉」同形对称。
// 不在 touchend 就地回钉：抬手那一瞬惯性还没开始走（从底部往上甩时读数仍贴底），那时置钉会被本
// 看门狗把用户的惯性滑行整段拽回底部＝#416/#716「往上滑被拽回最底」复发；本复核要等滚动/触摸/
// 几何全静默（惯性走完）才判，天然不误判甩动。判据与写方同尺（chatAtBottom ⇒ 距真最大值 ≤8px）：
// 只有贴底才回钉，绝不拽正在上翻的用户（#162/#416 零改动），写入交落定锁。零机型分支：写只发生在
// 健康态重写同一个值。
if (!chatPinnedBottom) {
if (!chatAtBottom()) return;
chatPinnedBottom = true; cb706.classList.remove('scroll-anchor-auto'); chatScrollRealignQuiet();
return;
}
if (cb706.scrollTop < chatScrollMax() - 8) scrollChatBottom();
}, 250);
// FIX 2026-09-20 #933：滚动会话落定重对齐（缺陷面见上方 scroll 回调回钉分支的注释）——
// 与 #871 chatResyncScrollQuiet 同形同闸（复用 #861 那把落定锁 chatRepinQuietEnough：滚动/触摸/
// 几何都静默才写、一次会话只写一枪、1200ms 静默不了就放弃交回看门狗周期复核），判据换成
// 「贴底/钉住」：①仍在贴底（含橡皮筋超界——chatAtBottom 对超界同样判真）或本次会话已回钉
// ⇒ scrollChatBottom() 同值重落一枪＝强制内核滚动树对新几何重对齐（#871 真机实证：WebKit 表现
// 层旧偏移正是靠这一枪拉回，同时把超界的 scrollTop 显式钳回；Blink/Gecko 同值写零副作用）；
// ②用户已翻历史（解钉态）⇒ 转 #871 解钉态钳回/同值重落，绝不拽底（#162/#416 契约不变）。
// 零机型分支：写只发生在滚动全静默之后，健康引擎只是重写同一个值。
let _rsAlignT = null;
let _rsAlignDeadline = 0;
function chatScrollRealignQuiet() {
if (_rsAlignT) return; // 已有一枪在膛：由它负责复查，不重复排队
_rsAlignDeadline = Date.now() + 1200;
_rsAlignT = setTimeout(chatScrollRealignStep, 120);
}
function chatScrollRealignStep() {
_rsAlignT = null;
const now = Date.now();
if (!chatVisible()) return;
if (!chatRepinQuietEnough(now)) { if (now < _rsAlignDeadline) _rsAlignT = setTimeout(chatScrollRealignStep, 120); return; }
const cb = document.getElementById('chat-body');
if (!cb) return;
if (chatPinnedBottom || chatAtBottom()) { scrollChatBottom(); return; }
chatResyncScrollQuiet('scroll');
}
// FIX #162：消息图片是 loading=lazy，加载完成晚于滚底，加载后内容长高会把视图从底部顶开
//（iPadOS 26 Safari 尤其明显＝「回一条滑一次」）——钉住期间任何消息图片 onload 后回到底部
body.addEventListener('load', (e) => {
const t = e.target;
if (!t || t.tagName !== 'IMG') return;
if (!chatPinnedBottom || batchRendering || !chatVisible()) return;
// #871：滚动/触摸进行中不再当场写（与用户手势对打＝贴底轻划错位源），交 #861 落定锁；
// 静默态保持原双写快路（#504 契约：同步写当帧即修正，rAF 兜部分内核丢弃同步写）
if (Date.now() - _chatScrollActTs < 200 || chatTouchActive) { chatRepinAfterSettle(); return; }
scrollChatBottom(); requestAnimationFrame(scrollChatBottom); // FIX #504：同步写当帧即修正（load 先于新尺寸首帧绘制），rAF 留作部分内核丢弃同步写的兜底
}, true);
// FIX 2026-09-06 #202 表情/图片加载失败占位：#186 只覆盖了媒体池令牌缺失，其余失败路径
// （远程 http 图断网/原图失效/混合内容拦截、dataURL 解码失败、parts 混合消息里的图）此前
// 同样渲染成无声空白气泡（iQOO12 Chrome 断网时联系人发表情空白实证）。error 后延时 1.5s
// 复核 naturalWidth 仍为 0 才把 img 换成占位——给池观察器改写 src（#186 竞态）和慢网加载
// 留窗口，不误伤正在加载或已被观察器救回的图；只替换 img 节点，不动引用块/情绪 chip。
// FIX 2026-09-10 #262 「表情内容为空」误报（iPhone 17 Safari 反馈：消息提示内容为空，
// 按提示去字卡库却无可清理表情包）。根因不在阈值而在「判空对象」：canvas 画动画图只画得出
// 第一帧，而表情包 GIF 的首帧经常就是全透明清屏帧（字卡库 GIF 直存原图保留动画，
// chatcard.js v3.7.x）→ 正在正常播放的动图被整块换成占位文案。无头 Chrome 与 WebKit 实测
// 同果＝与机型无关的通用误报（iQOO/红米等同款字卡库设备一起中招）。三道防线：
//   ①alphaCheckable 先证「这是静态图」才采样：多帧 GIF / APNG / 远程图 / webp·svg·未知格式 /
//     超阈值文件一律不判（真空白图压完必然极小，故只嗅探小文件字节头，零成本避开所有动图）；
//   ②两次独立采样都为全 0 才下结论，兜未知引擎「解码未就绪画成空」的时序差；
//   ③占位带「点此恢复显示」出口 + 文案不再把用户单方面指向字卡库。
// 口径同 #186/#247：宁可不报，绝不误报——漏判只是回到 #205 之前的空白气泡，误判却把坏图
// 的帽子扣在正常表情上，还引导用户去清理根本不存在的坏分组。
const EMPTY_SNIFF_MAX_B64 = 96 * 1024;
function alphaSampleEmpty(im) {
try {
const S = 24;
const c = document.createElement('canvas');
c.width = S; c.height = S;
const x = c.getContext('2d');
if (!x) return false;
x.drawImage(im, 0, 0, S, S);
const d = x.getImageData(0, 0, S, S).data;
for (let i = 3; i < d.length; i += 4) { if (d[i] !== 0) return false; } // 有任一非透明像素=有画面
return true;
} catch (e) { return false; } // 跨域污染/取不到像素=不可判，按有画面放行
}
// true=已确证静态位图（才允许判空）；false=可能是动图或无法确证，一律不出占位
function alphaCheckable(src) {
if (typeof src !== 'string' || src.indexOf('data:image/') !== 0) return false;
const comma = src.indexOf(',');
if (comma < 0 || src.indexOf(';base64') < 0) return false;
const b64 = src.slice(comma + 1);
if (!b64.length || b64.length > EMPTY_SNIFF_MAX_B64) return false;
let bin;
try { bin = atob(b64); } catch (e) { return false; }
if (!bin || bin.length < 8) return false;
const o = (i) => bin.charCodeAt(i);
if (bin.slice(0, 3) === 'GIF') {
// 单帧 GIF 至多 1 个图形控制扩展（21 F9 04），≥2＝多帧动图。LZW 流里偶然撞出该序列只会
// 把它误判成动图＝放行，方向安全
let n = 0, i = bin.indexOf('\x21\xF9\x04');
while (i >= 0) { n++; if (n >= 2) return false; i = bin.indexOf('\x21\xF9\x04', i + 3); }
return true;
}
if (o(0) === 137 && o(1) === 80 && o(2) === 78 && o(3) === 71) {
// PNG 块表从第 8 字节起；APNG 的 acTL 按规范必在首个 IDAT 之前 → 先走到 IDAT 即静态图
let p = 8;
while (p + 8 <= bin.length) {
const len = ((o(p) << 24) >>> 0) + (o(p + 1) << 16) + (o(p + 2) << 8) + o(p + 3);
const type = bin.slice(p + 4, p + 8);
if (type === 'acTL') return false;
if (type === 'IDAT' || type === 'IEND') return true;
if (!/^[A-Za-z]{4}$/.test(type) || len < 0 || p + 12 + len > bin.length) return false; // 结构异常=不判
p += 12 + len;
}
return false;
}
return false; // JPEG 无透明通道（永远采不出全 0）；webp/svg/未知格式不冒险
}
// FIX 2026-09-21 #963 内联图片（data: URI）解码失败的一次性换路重试——真机诊断实证（iPhone 14
// Plus Safari）：错误环 20 条全是 <img> data:image/…;base64,… 加载失败，其中同一张 jpeg 失败 56 次
// ＝同一条消息里的图每渲染一次报一次，用户侧就是「图片位置一直空着/报加载失败」。同一份字节换
// blob: 交付（WebKit 对 blob 图走另一条解码与内存路径；且同一张图全站共享一个 objectURL＝56 个
// <img> 只驻留一份字节，这正是 data: 逐份内联最贵的地方）。零机型分支：只按「加载失败且载荷是
// data: URI」这一事实分路——成功即留图，仍失败才回 #202 占位，并在 __jsErrors 留一条能点名真因的
// 诊断（MIME/字节数/base64 头），下次报障不必再猜是 HEIC 未解码、截断还是超大图。
const _chatBlobCache = new Map(); // payload 头 -> objectURL（LRU，超出即 revoke）
const _chatImgFailSeen = Object.create(null); // 诊断去重：同一份载荷只写一条
const CHAT_BLOB_CACHE_MAX = 24;
// data URL 头解析（纯函数，便于行为校验）：{ mime, b64 } / null
function chatDataUrlParts(s) {
if (typeof s !== 'string' || s.slice(0, 5).toLowerCase() !== 'data:') return null;
const comma = s.indexOf(',');
if (comma < 0) return null;
const head = s.slice(5, comma);
return { mime: (head.split(';')[0] || '').trim(), b64: /;base64(;|$)/i.test(head) };
}
function chatBlobRetry(im, s) {
const p = chatDataUrlParts(s);
if (!p) return '';
if (typeof URL === 'undefined' || !URL.createObjectURL || typeof Blob === 'undefined') return '';
const comma = s.indexOf(',');
const key = s.slice(0, 96);
try {
let u = _chatBlobCache.get(key);
if (!u) {
let bytes;
if (p.b64) {
const bin = atob(s.slice(comma + 1));
const arr = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
bytes = arr;
} else {
bytes = decodeURIComponent(s.slice(comma + 1));
}
u = URL.createObjectURL(new Blob([bytes], { type: p.mime || 'application/octet-stream' }));
_chatBlobCache.set(key, u);
if (_chatBlobCache.size > CHAT_BLOB_CACHE_MAX) {
const k0 = _chatBlobCache.keys().next().value;
try { URL.revokeObjectURL(_chatBlobCache.get(k0)); } catch (e0) {}
_chatBlobCache.delete(k0);
}
}
im.dataset.blobTried = '1'; // 只换一次路（失败由下一轮 error 兜底，绝不成环）
im.src = u;
return u;
} catch (e) {
return '';
}
}
function chatImgFailNote(s, im) {
const p = chatDataUrlParts(s) || { mime: '?' };
const comma = s.indexOf(',');
const body = comma >= 0 ? s.slice(comma + 1) : '';
return '[图片加载失败] mime=' + p.mime + ' 字节≈' + Math.round(body.length * 3 / 4) + ' base64头=' + body.slice(0, 12) +
(im && im.naturalWidth ? ' 尺寸=' + im.naturalWidth + 'x' + im.naturalHeight : ' 未能解码');
}
function chatImgFailNoteOnce(s, im) {
const key = s.slice(0, 96);
if (_chatImgFailSeen[key]) return;
_chatImgFailSeen[key] = 1;
try { if (window.__jsErrors) window.__jsErrors.push(chatImgFailNote(s, im)); } catch (e) {}
}
function bindMediaFailPlaceholder(b) {
b.querySelectorAll('.msg-img').forEach(im => {
if (im.dataset.errBound) return;
im.dataset.errBound = '1';
im.addEventListener('error', () => {
setTimeout(() => {
if (!im.isConnected || !im.complete) return;
if (im.naturalWidth !== 0) return;
const s = im.getAttribute('src') || '';
const isTok = window.mochiMediaIsToken && window.mochiMediaIsToken(s);
if (isTok) {
// FIX 2026-09-14 #439 池权威判定：令牌 src 404 只是浏览器把令牌当 URL 请求失败的噪音，
// 池解图走观察器异步取回（慢机/大库/#397 取回限流下 1.5s 远不够）——旧逻辑凭 1.5s 超时
// 即替换＝把「取回慢」误杀成「数据丢失」（红米K80 等「图片依旧说丢失」的主体），且占位
// 换掉后 #423 重建自愈只重写 img 摸不到占位＝「点了重建还是丢失」。改为轮询池官方判定：
// 解出→观察器已改写不动；确认缺失→才换占位并登记（mochiMediaPhRegister，池补回后由
// mochiMediaPhRestore 原位换回真图自愈）；4s 仍无判定→保留 img 交给观察器/下次渲染。
const h = s.slice(4);
let n = 0;
const iv = setInterval(() => {
if (!im.isConnected) { clearInterval(iv); return; }
if (window.mochiMediaExpand && window.mochiMediaExpand(s)) { clearInterval(iv); return; }
if (window.mochiMediaTokenMissing && window.mochiMediaTokenMissing(s)) {
clearInterval(iv);
const ph = document.createElement('span');
ph.style.cssText = 'opacity:.5;font-size:12px';
ph.textContent = '（图片丢失：媒体数据缺失，可到设置→查看存储→媒体池「重建媒体池」恢复，或导入含图片的完整备份）';
im.replaceWith(ph);
try { if (window.mochiMediaPhRegister) window.mochiMediaPhRegister(h, ph, im); } catch (e2) {}
return;
}
if (++n >= 8) clearInterval(iv);
}, 500);
return;
}
// FIX 2026-09-21 #963 内联载荷解码失败：先用同一份字节换 blob: 通路重试一次（成功即留图），
// 仍失败才回占位；并把这张图的形态写进诊断（同一份载荷只写一条，不刷屏）。
if (!im.dataset.blobTried && chatBlobRetry(im, s)) return;
chatImgFailNoteOnce(s, im);
const ph = document.createElement('span');
ph.style.cssText = 'opacity:.5;font-size:12px';
ph.textContent = '（表情/图片加载失败：网络不通或原图已失效）';
im.replaceWith(ph);
}, 1500);
});
// FIX 2026-09-06 #205 全透明空图检测：图片「加载成功但内容本身没有画面」（导入字卡包里的
// 全透明图/空白图——多设备共用同一批字卡库时会同时表现为空气泡，且不产生任何加载错误）
// 是加载失败之外最后一类真空白。24×24 采样 alpha，全 0 才判空（有字/有内容即放行）。
// 同批 #262：判空前必过静态图门禁 + 二次采样确认 + 可恢复出口（见上方 FIX 注释）。
im.addEventListener('load', () => {
if (im.dataset.alphaChecked) return;
if (!alphaCheckable(im.getAttribute('src') || '')) return;
im.dataset.alphaChecked = '1';
if (!im.complete || !im.naturalWidth) return;
if (!alphaSampleEmpty(im)) return;
setTimeout(() => {
if (!im.isConnected || !im.complete || !im.naturalWidth) return;
if (!alphaSampleEmpty(im)) return; // 复采有画面＝首采遇解码未就绪，撤销判定
const ph = document.createElement('span');
ph.style.cssText = 'opacity:.5;font-size:12px';
const lb = document.createElement('span');
lb.textContent = '（这张表情图没有画面：空白图/全透明图，可长按撤回；要根治请到字卡库或「我的表情包」删掉这张）';
const undo = document.createElement('span');
undo.textContent = '点此恢复显示';
undo.style.cssText = 'text-decoration:underline;margin-left:4px';
const tap = (e) => {
e.stopPropagation(); // 不吃到气泡 click（否则点恢复反而弹出操作面板）
im.dataset.alphaChecked = '1'; // 用户已判定=不再复判，误判也有永久出口
ph.replaceWith(im);
};
// 整行可点：手机端文字提示本身就窄，只把 4 个字做成按钮容易点不中
ph.style.cursor = 'pointer';
ph.addEventListener('click', tap);
ph.appendChild(lb);
ph.appendChild(undo);
im.replaceWith(ph);
}, 350);
});
});
}
// FIX 2026-09-15 #491 渲染期消息身份锚（「引用的消息和显示的消息完全不对」EC-PAD01 SE Chrome
// 等多机型同报，#407 同族残留洞）：#407 的快照在【开菜单时】按 data-idx 取 rec——但 msgs 可能
// 在【开菜单之前】已中段位移（权威读库合并/回放/补投递按 ts 插删，#220 不贴底时有意跳过重渲
// 防闪）＝陈旧下标把别的消息快照进来，resolveActiveMsg 四级重定位的输入本身就是错的，救不回。
// msgKeyOf 是消息内容身份（ts|side|type|text80），renderMsg 渲染每个气泡时写进 data-mk＝
// 「这个节点当时画的是哪条」永不随数组位移变化；开菜单按 mk 反查真实那条（查询 key 冲突
// 只在同文案同毫秒消息间发生＝引用内容也相同，无感）。
// #1477：时间位与 normCell 盖章走同一条 fallback 链——无 ts 的存量记录画时按 rpTs 等自身事件时间
// 取键、盖章后 ts=rpTs 仍取同一值 ⇒ data-mk 不因盖章失效；末段拼卡片身份字段（chatRecCardExtra，
// #796 同一套）＝红包/礼物这类「正文为空、身份在专用字段上」的卡，同毫秒同侧两张不同卡也分得开。
// 写（renderMsg 的 data-mk）与读（#491 菜单快照、#1477 msgRecFromEl）同用本函数。
function msgRecTsOf(rec) {
return (rec && (rec.ts || rec.rpTs || rec.askTs || rec.surveyTs || rec.dAt)) || 0;
}
function msgKeyOf(rec) {
if (!rec) return '';
return msgRecTsOf(rec) + '|' + (rec.side || '') + '|' + (rec.type || '') + '|' + String(rec.text || '').slice(0, 80) + chatRecCardExtra(rec);
}
// #1477：互动卡点击的记录解析——下标快路径＋身份校正。msgs 可能在卡片画好之后被重排（权威读库
// 合并/尾巴日志回放/空权威重建按 ts 插删＋normCell 给无 ts 存量盖章；#407 同族：中段插入删除 ⇒
// 下标整体位移而 DOM 未重渲），旧 data-idx 会读到别的消息＝「联系人发的红包点了没反应」（点击
// 实际读到一条别的消息，special 对不上就静默返回）。data-mk 是渲染期身份锚（#491），永不随数组
// 位移变化：下标取到的记录对不上锚就按锚反查真实那条，命中时顺手把节点下标修回真值（后续按
// idx 就地补丁的调用方才能找到节点）。反查也无（记录真被删了）才回退旧下标语义＝保守回退。
// 带 prefer 时先取「下标处的记录与锚一致且状态吻合」的快路径；快路径不满足再全量扫同身份候选。
function msgRecFromEl(item, prefer) {
if (!item || item.dataset.idx === undefined) return null;
const _i = Number(item.dataset.idx);
const _mk = item.dataset.mk || '';
let rec = (_i >= 0 && _i < msgs.length) ? msgs[_i] : null;
const okFast = !!(rec && _mk && msgKeyOf(rec) === _mk);
if (okFast && typeof prefer !== 'function') return { rec: rec, idx: _i };
if (_mk) {
// 同身份可能不止一份（快照回滚链会把「已领」的记录又并回一份「待领」克隆，绿/红两侧实测皆有）：
// 带 prefer 时优先取与卡片当前显示状态一致的那份——用户看得见的卡片状态就是本次点击的真相。
let best = -1, first = -1;
for (let j = 0; j < msgs.length; j++) {
const m = msgs[j];
if (!m || msgKeyOf(m) !== _mk) continue;
if (first < 0) first = j;
if (typeof prefer === 'function' && prefer(m)) { best = j; break; }
}
const j = (best >= 0) ? best : first;
if (j >= 0) { item.dataset.idx = String(j); return { rec: msgs[j], idx: j }; }
}
if (okFast) return { rec: rec, idx: _i };
return rec ? { rec: rec, idx: _i } : null;
}
// v3.33.x #521：批量问卷长卡片（special:'ask-survey'）——观感对齐单题 ask-card（同宽/同圆角/
// 同阴影/同字号；标题、逐题答案、底部提示一一对应，无 emoji、无独立进度徽标，进度并入底部提示）。
// 题列表/状态/答案全部以快照字段持久化在消息记录上（surveyQs/surveyStatus/surveyAnswers），
// 作答进度由 ta-ask.js 经 chatSyncSurveyCard 回写；渲染只读 rec 字段，不依赖问卷实时状态
// （撤回问卷重置为草稿后，历史卡片仍保留最后一次快照，合理）。
function surveyCardHtml(rec) {
const qs = Array.isArray(rec.surveyQs) ? rec.surveyQs : [];
const answers = Array.isArray(rec.surveyAnswers) ? rec.surveyAnswers : [];
const done = rec.surveyStatus === 'done';
const nDone = answers.filter(a => typeof a === 'string' && a.trim()).length;
let rows = '';
qs.forEach((q, i) => {
const a = answers[i] || '';
rows += '<div class="msg-survey-item' + (a ? ' answered' : '') + '">' +
'<div class="msg-survey-q">' + (i + 1) + '. ' + escTxt(q.text || '') + '</div>' +
(Array.isArray(q.options) && q.options.length
// #1415：多选题的答案是「A、B」整串——原来拿它去和单个选项比全文，多选题永远一个都不亮
? '<div class="msg-survey-opts">' + q.options.map(o => '<span class="msg-survey-opt' + (window.mochiAnswerHits && window.mochiAnswerHits(o, a) ? ' sel' : '') + '">' + escTxt(o) + '</span>').join('') + '</div>'
: '') +
(a ? '<div class="msg-survey-a">' + (window.taFit ? window.taFit('TA：') : 'TA：') + escTxt(window.taFit ? window.taFit(a) : a) + '</div>' : '') +
'</div>';
});
return '<div class="msg-survey-card' + (done ? ' done' : '') + '">' +
'<div class="msg-survey-head">你发出的问卷 · ' + qs.length + ' 题</div>' +
'<div class="msg-survey-list">' + (rows || '<div class="msg-survey-item">（问卷内容缺失）</div>') + '</div>' +
// #1005 底部提示行尾加一枚右向箭头＝「整张卡片可点」的暗示（提示文案本就写着「点击查看…」，
// 心形改为点卡片才浮现后，卡片得自己把「能点」摆出来）；收藏心形默认隐藏，由 body click 的
// surveyCard 分支加 .show-fav 浮现
'<div class="msg-survey-tip">' + (done ? '已交卷 · 点击查看问卷详情' : 'TA 正在作答 · 已答 ' + nDone + '/' + qs.length + '，点击查看进度') + '<span class="msg-survey-chev">\u203A</span></div>' +
favHeartHtml(rec) +
'</div>';
}
// v3.33.x #521：问卷进度回写——ta-ask.js 在 TA 每答一题/交卷时调用，按 surveyTs 定位
// 聊天记录里的 ask-survey 卡片更新快照；卡片在当前渲染窗口内时原地重画 innerHTML，
// 不在窗口内（上翻历史/未渲染）只落库，下次渲染自然带新状态。
window.chatSyncSurveyCard = function (surveyTs, status, answers) {
if (!surveyTs) return;
for (let i = msgs.length - 1; i >= 0; i--) {
const r = msgs[i];
if (r && r.special === 'ask-survey' && r.surveyTs === surveyTs) {
r.surveyStatus = status;
r.surveyAnswers = Array.isArray(answers) ? answers : [];
saveMsgs();
const el = body.querySelector('.msg-survey[data-idx="' + i + '"]');
if (el) el.innerHTML = surveyCardHtml(r);
return;
}
}
};
// #891 小游戏结算卡片名册：五子棋 / 四子棋 / 合作扫雷 / 连连看 / 消消乐 / 心意币拍卖会的 special 此前
// 在 renderMsg 里一个分支都没有，结算消息直接掉进通用气泡＝用户报「游戏结束没有卡片显示
// 输赢，只发了一条聊天消息」（Pong/打砖块/记忆翻牌/贪吃蛇/猜拳早有卡）。图标与 arcade.js 游乐室名册一致。
// rec.game ＝ 游戏侧结算时带出的 { icon, name, outcome, result, stats[] }；
// 历史消息没有该字段（当时压根没传）时按正文降级成两行卡。
const GAME_CHAT_CARDS = {
  gomoku: { icon: '⚫', name: '五子棋' },
  c4: { icon: '🔵', name: '四子棋' },
  ms: { icon: '💣', name: '合作扫雷' },
  linkup: { icon: '🔗', name: '连连看' },
  match3: { icon: '🍬', name: '消消乐' },
  auction: { icon: '🔨', name: '心意币拍卖会' }
};
// v3.28.x #1316（红米 K80 Chrome 实报「礼物卡片我已经点击【送他】，但是送完礼物这个按钮还是没有消失」，
// 用户明说其他设备型号也有出现、要求不要覆盖式修补）：心愿卡的「已送出」必须是一条**记在这张卡片记录上
// 的事实**，不能只是「渲染时按 TA 心愿单此刻还有没有这件商品」的实时推断，再叠一个只作用于「点按钮那
// 一下捕获到的节点」的一次性补丁。纯 HEAD 实测到三条失效（都跟机型无关，是同一处状态口径）：
//   ① 同一件商品的两张心愿卡共用同一个 wishGiftId：买掉一张后另一张仍挂着【送 TA】，再点只 toast
//      「心愿单里已经没有这件啦」、按钮永不消失（实测 dom:["0:BUY","1:done"] 且余额不动）；
//   ② 那次性补丁写的是开弹窗前捕获的 wItem，中途任何一次整窗重画（回场复核／分帧构建／退出重进的同窗
//      补丁）都让它落在脱离文档的旧节点上＝静默失效，只有刷新能恢复；
//   ③ TA 日后重新许愿同一件商品时，早已送出的旧卡会重新长出【送 TA】，再点一次就再扣一次钱
//      （实测余额 49500→48250、心意柜 2→3 件）。
// 判据零机型／零 UA 分支：wishSent 只在「这件心愿确实被兑现」那一步落下，渲染与换装问的是同一把尺子。
function wishCardIsPending(rec) {
if (!rec || rec.special !== 'wish') return false;
if (rec.wishSent) return false; // 卡片自己记着的既成事实，优先于任何实时推断
return !window.giftTaWishHas || window.giftTaWishHas(rec.wishGiftId);
}
function wishDoneHtml() {
// 此处不能用 renderMsg 局部的 T()，用同层其它提示的 taFit 口径（失焦/兜底同理）
return '<div class="msg-wish-done">\u2713 ' + escTxt(window.taFit ? window.taFit('已送出') : '已送出') + '</div>';
}
// 心愿被兑现这一刻：把事实记到该商品的每一张心愿卡记录上，再按**新数据**重画屏上的心愿卡（一张都不落）。
// 刻意不接「点按钮时捕获的那个节点」，也刻意不只看 TA 心愿单此刻的数据——成交那一刻屏上可能已经是另一批
// 节点（中途重画过），而同一件商品的兄弟卡片问的是同一个 id，只有按数据逐张重判才两者都盖住。
// gift-shop 在 wishTaRemove（心愿清单被消费掉的唯一收口）处调用，聊天卡／市集心愿单／直接买下 TA 正许愿
// 的礼物这三扇门因此走同一条路。
function chatWishSettled(giftId) {
try {
if (giftId) {
let marked = false;
for (let i = 0; i < msgs.length; i++) {
const r = msgs[i];
if (!r || r.special !== 'wish' || r.wishGiftId !== giftId || r.wishSent) continue;
r.wishSent = Date.now();
marked = true;
}
if (marked) saveMsgs();
}
} catch (e) {}
try {
const els = document.querySelectorAll('#chat-body .msg-wish');
for (let i = 0; i < els.length; i++) {
const idx = Number(els[i].dataset.idx);
if (!isFinite(idx) || idx < 0 || idx >= msgs.length) continue; // 认不出记录就不动＝绝不凭空宣告已送出
const r = msgs[idx];
if (!wishCardIsPending(r)) {
const acts = els[i].querySelector('.msg-wish-acts');
if (acts) acts.outerHTML = wishDoneHtml();
}
}
} catch (e) {}
}
window.chatWishSettled = chatWishSettled;
function renderMsg(rec, atIdx) {
const m = document.createElement('div');
m.dataset.mk = msgKeyOf(rec); // FIX 2026-09-15 #491 身份锚随渲染写入，批量渲染只覆盖 data-idx 不动它
// FIX 2026-09-18 #766（用户报障：聊天里我发/TA 发的消息「莫名其妙一条变多条」，点发送那一刻就两条、
// 刷新还在、有的机型有有的没有）：身份锚必须在**创建节点时**统一写入。此前 data-idx 散落在各分支
// 里手写（invite/ask/红包等写了，poke·ask-msg/call/rps/pong/brick/memory/snake 等提前 return 的分支
// 从未写过），函数末尾那句兜底（`side==='in'||'out'` 才写）对这些提前 return 的分支根本不可达 ⇒
// 这些节点在 DOM 里「无下标」⇒ 补画缺口的幂等守卫查不到它 ⇒ **同一条消息被原样再画一遍**。
// 批量/整窗渲染侧本就按真实下标覆盖（见 renderWindow 与 loadOlder/loadNewerIncremental 的
// `m.dataset.idx = i`），此处预写 msgs.length-1 与旧兜底句口径一致、零新语义。
// FIX 2026-09-27 #1326：但「预写 msgs.length-1」只对**尾部增量**（addRec 画的正是新尾）成立；
// 整窗/分帧/原位补丁那几条路径的调用方手里有真实下标，必须传进来（atIdx）。旧写法让调用方在
// renderMsg **返回之后**才覆盖，而 renderMsg 内部各分支的 appendMsg 挂载在这之前就跑完了 ⇒
// 分帧构建期每挂一格都被 #1004 的「迟到节点」判据（下标 ≥ 开轮条数）看成迟到，整批改道进
// batchDefer.q，连真迟到的那条一起按到达顺序排在最前＝新消息被挂到列表**头部**（用户实报：
// 「对方正在输入中」之后不出消息，退出聊天再进来才显现；无头实测 head=[300] tail=[299]）。
// 下面 13 处分支各自重写一遍下标（#766 的口径），全部改读 __msgAt＝「这一格到底是哪一格」。
const __msgAt = Number.isFinite(atIdx) ? atIdx : msgs.length - 1;
m.dataset.idx = __msgAt;
// 消息方向锚：in=对方 / out=我。与下标锚同时写入，所有分支（含提前 return 的卡片）共用；
// 聊天设置→美化「对方互动卡透明度」据 [data-side="in"] 只淡化对方发来的礼物/提问卡。
m.dataset.side = rec.side === 'out' ? 'out' : 'in';
// #878：msg-enter 不在此处加——下面各分支的 m.className=… 整体覆盖会把它抹掉，
// 统一由 appendMsg 挂载前补加（见其定义处注释）。
const __fit = rec.side !== 'out' && !!window.taFit;
const __taNm = chatPartnerName();
const __meNm = chatUserName();
// v3.26.x：拍一拍人称修复——taFit（称呼）期间把 {ta}/{me} 掩成控制符，先替换称呼再回填昵称，
// 昵称（含默认 TA、含「他」的名字）永不被称呼功能改写成 他/ta/她；字卡文案里的独立
// ta/TA/他（非占位符）仍按称呼替换（字卡库中性占位设计不变）
const T = (s) => {
let t = s;
if (__fit && typeof t === 'string') {
const hasPh = t.indexOf('{ta}') >= 0 || t.indexOf('{me}') >= 0;
if (hasPh) t = t.split('{ta}').join('\u0002').split('{me}').join('\u0003');
t = window.taFit(t);
if (hasPh) t = t.split('\u0002').join(__taNm).split('\u0003').join(__meNm);
return t;
}
if (typeof t === 'string' && t.indexOf('{ta}') >= 0) t = t.split('{ta}').join(__taNm);
if (typeof t === 'string' && t.indexOf('{me}') >= 0) t = t.split('{me}').join(__meNm);
return t;
};
if (rec.special === 'invite') {
m.className = 'msg-ask';
m.dataset.idx = __msgAt; // #1326：分支重写读调用方给的这一格
const answered = rec.inviteStatus === 'answered';
m.innerHTML = '<div class="msg-ask-card' + (answered ? ' answered' : '') + '">' +
'<div class="msg-ask-q">' + T('邀请TA') + ' · ' + escTxt(rec.inviteContent || rec.text || '') + '</div>' +
(answered
? '<div class="msg-ask-a">✓ ' + escTxt(T(askCardReplyClean(rec.inviteAnswer) || 'TA 回应了你')) + '</div>'
: '<div class="msg-ask-tip">' + T('等待 TA 回应…') + '</div>') +
favHeartHtml(rec) +
'</div>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
if (rec.special === 'ask') {
m.className = 'msg-ask';
m.dataset.idx = __msgAt; // #1326：分支重写读调用方给的这一格
const answered = rec.askStatus === 'answered';
// #1415：多选题与单选题在「等 TA 从选项里挑」这一点上是同一件事，提示语共用一句
const askIsPick = rec.askType === 'single' || rec.askType === 'multi';
m.innerHTML = '<div class="msg-ask-card' + (answered ? ' answered' : '') + '">' +
'<div class="msg-ask-q">' + T('问问TA') + ' · ' + escTxt(rec.askQuestion || '') + '</div>' +
(answered
? '<div class="msg-ask-a">✓ ' + T('TA：') + escTxt(T(rec.askAnswer || '回答了你')) + '</div>' + (rec.askReply ? '<div class="msg-choose-r">' + T('TA：') + escTxt(T(askCardReplyClean(rec.askReply))) + '</div>' : '')
: '<div class="msg-ask-tip">' + (askIsPick ? T('等待 TA 选择…') : T('等待 TA 回答…')) + '</div>') +
favHeartHtml(rec) +
'</div>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
if (rec.special === 'call' || rec.special === 'call-reply' || rec.special === 'invite-reply') {
m.className = 'msg-center';
m.innerHTML = '<div class="msg-center-card">' + escTxt(T(rec.text)) + '</div>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
if (rec.special === 'poke' || rec.special === 'ask-msg') {
m.className = 'msg-poke' + (rec.mailNotice ? ' mail-notice' : '');
// FIX 2026-09-16 #616：昵称事件消息（nickKeep）**原样呈现**，不走 pokePersonMap——
// 那样会把「我把 TA 的昵称换成了「小满」」里的泛指 TA 也回填成新昵称，整句变成
// 「我把 小满 的昵称换成了「小满」」（自己说自己，用户读不出发生了什么）。
// 这类消息的正文本身就是「谁把昵称改成了什么」的记录，泛指词保持泛指才不歧义。
// v3.30.x：拍一拍人称昵称制——不再走 T()（taFit 称呼替换），改用 pokePersonMap：
// {ta}/{me} 与字卡里写死的 TA/ta/他/她 一律按 我的昵称/联系人昵称 回填
m.innerHTML = '<span>' + (rec.nickKeep ? escTxt(rec.text) : pokeIconHtml(pokePersonMap(rec.text, __taNm, __meNm))) + '</span>' +
(rec.img ? '<img class="msg-poke-img" src="' + attrEsc(rec.img) + '" alt="新头像">' : '');
if (rec.mailNotice) {
m.addEventListener('click', () => { if (window.openMailPage) window.openMailPage(); });
}
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
if (rec.special === 'rps') {
m.className = 'msg-rps';
const rpsIco = {
rock: '<svg viewBox="0 0 256 256"><path fill="currentColor" d="M200 80h-16V64a32 32 0 0 0-56-21.13a32 32 0 0 0-55.79 17.55A32 32 0 0 0 24 88v40a104 104 0 0 0 208 0v-16a32 32 0 0 0-32-32m-48-32a16 16 0 0 1 16 16v16h-32V64a16 16 0 0 1 16-16M88 64a16 16 0 0 1 32 0v40a16 16 0 0 1-32 0ZM40 88a16 16 0 0 1 32 0v16a16 16 0 0 1-32 0Zm176 40a88 88 0 0 1-175.92 3.75A31.93 31.93 0 0 0 80 125.13a31.93 31.93 0 0 0 44.58 3.35a32.2 32.2 0 0 0 11.8 11.44A47.88 47.88 0 0 0 120 176a8 8 0 0 0 16 0a32 32 0 0 1 32-32a8 8 0 0 0 0-16h-16a16 16 0 0 1-16-16V96h64a16 16 0 0 1 16 16Z"/></svg>',
scissors: '<svg viewBox="0 0 256 256"><path fill="currentColor" d="M212.24 30A28 28 0 0 0 161 36.77l-13 48.32l-12.95-48.32A28 28 0 1 0 81 51.26l9.38 35l-8.73-1.68a28 28 0 0 0-24.85 47.8a27.86 27.86 0 0 0-8.8 20.49V160a80 80 0 0 0 80 80h.61c43.78-.33 79.39-36.62 79.39-80.9v-3.34a55.88 55.88 0 0 0-11.77-34.27L215 51.26A27.8 27.8 0 0 0 212.24 30M97.61 38a12 12 0 0 1 22 2.9l14.77 55.15a28 28 0 0 0-14 4.77a2 2 0 0 0-.16-.26A27.65 27.65 0 0 0 108 90.35L96.42 47.12A11.94 11.94 0 0 1 97.61 38m-33.36 71.6a12 12 0 0 1 14.25-9.34l20.71 4a12 12 0 0 1 9.36 14.16a12 12 0 0 1-14.25 9.34l-20.75-4a12 12 0 0 1-9.32-14.15Zm0 40.72a12 12 0 0 1 14-9.37l10.11 2a12 12 0 0 1 9.36 14.15a12 12 0 0 1-14.2 9.35l-10-2a12 12 0 0 1-9.34-14.16ZM192 159.1c0 35.53-28.49 64.64-63.5 64.9a64.08 64.08 0 0 1-61.56-44.78a31 31 0 0 0 3.48.95l10 2a28.3 28.3 0 0 0 5.61.57a28 28 0 0 0 24.16-42.14c.79-.43 1.57-.89 2.32-1.4l.16.26a27.82 27.82 0 0 0 17.78 12l6.32 1.26a36 36 0 0 0 9.53 32.49A8 8 0 0 0 157.71 174a20 20 0 0 1-3.31-23.51a8 8 0 0 0-5.46-11.66l-15.34-3.07a12 12 0 0 1-9.35-14.15a12 12 0 0 1 14.18-9.35l21.41 4.28A40.1 40.1 0 0 1 192 155.76Zm7.59-112l-16.62 62a55.6 55.6 0 0 0-20-8.28l-2.5-.5l15.93-59.41a12 12 0 1 1 23.18 6.21Z"/></svg>',
paper: '<svg viewBox="0 0 256 256"><path fill="currentColor" d="M188 88a27.75 27.75 0 0 0-12 2.71V60a28 28 0 0 0-41.36-24.6A28 28 0 0 0 80 44v6.71A27.75 27.75 0 0 0 68 48a28 28 0 0 0-28 28v76a88 88 0 0 0 176 0v-36a28 28 0 0 0-28-28m12 64a72 72 0 0 1-144 0V76a12 12 0 0 1 24 0v44a8 8 0 0 0 16 0V44a12 12 0 0 1 24 0v68a8 8 0 0 0 16 0V60a12 12 0 0 1 24 0v68.67A48.08 48.08 0 0 0 120 176a8 8 0 0 0 16 0a32 32 0 0 1 32-32a8 8 0 0 0 8-8v-20a12 12 0 0 1 24 0Z"/></svg>'
};
const rpsName = { rock: '石头', scissors: '剪刀', paper: '布' };
const resTxt = rec.rpsResult > 0 ? '你赢了' : rec.rpsResult < 0 ? '你输了' : '平局';
m.innerHTML = '<div class="msg-rps-card">' +
'<div class="msg-rps-hands">' +
'<span class="msg-rps-hand"><span class="msg-rps-ico">' + (rpsIco[rec.rpsMine] || '') + '</span><span class="msg-rps-name">你 · ' + escTxt(rpsName[rec.rpsMine] || '') + '</span></span>' +
'<span class="msg-rps-vs">VS</span>' +
'<span class="msg-rps-hand"><span class="msg-rps-ico">' + (rpsIco[rec.rpsTa] || '') + '</span><span class="msg-rps-name">' + T('TA') + ' · ' + escTxt(rpsName[rec.rpsTa] || '') + '</span></span>' +
'</div>' +
'<div class="msg-rps-result">' + escTxt(resTxt) + '</div>' +
'</div>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
if (rec.special === 'pong') {
m.className = 'msg-pong';
m.innerHTML = '<div class="msg-pong-card">' +
'<div class="msg-pong-label">' + T('双人 Pong') + '</div>' +
'<div class="msg-pong-result">' + escTxt(T(rec.text || '')) + '</div>' +
'</div>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
if (rec.special === 'brick') {
m.className = 'msg-pong msg-brick';
// #1028：正文剥掉与卡片标签重复的「双人打砖块 · 」句首（存值不改，旧记录同样生效）
m.innerHTML = '<div class="msg-pong-card">' +
'<div class="msg-pong-label">🧱 ' + T('双人打砖块') + '</div>' +
'<div class="msg-pong-result">' + escTxt(T((rec.text || '').replace(/^双人打砖块\s*·\s*/, ''))) + '</div>' +
'</div>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
// v3.16.x：记忆翻牌结算卡片（memory-game.js endGame 调用 chatAddSystem special:'memory'）
if (rec.special === 'memory') {
m.className = 'msg-pong msg-memory';
m.innerHTML = '<div class="msg-pong-card">' +
'<div class="msg-pong-label">🧠 ' + T('记忆翻牌') + '</div>' +
'<div class="msg-pong-result">' + escTxt(T(rec.text || '')) + '</div>' +
'</div>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
// #891 五子棋/四子棋/合作扫雷/连连看/消消乐结算卡片（同 pong/brick/memory 的 .msg-pong-card 形态）
if (GAME_CHAT_CARDS[rec.special]) {
const gc = GAME_CHAT_CARDS[rec.special];
const gg = rec.game && typeof rec.game === 'object' ? rec.game : null;
const gRaw = String(rec.text || '');
// 无 rec.game（本批之前的历史消息）时按「游戏名 · 结论」正文切出结论行
const gCut = gRaw.indexOf(' · ');
const gRes = gg && gg.result ? String(gg.result) : (gCut > 0 ? gRaw.slice(gCut + 3) : gRaw);
const gOut = (gg && gg.outcome) || (/你赢/.test(gRes) ? 'win' : (/平/.test(gRes) ? 'draw' : (/赢/.test(gRes) ? 'lose' : 'clear')));
const gStats = gg && Array.isArray(gg.stats) ? gg.stats.filter((x) => x && String(x).trim()).slice(0, 6) : [];
m.className = 'msg-pong msg-game';
m.innerHTML = '<div class="msg-pong-card msg-game-card">' +
'<div class="msg-pong-label">' + gc.icon + ' ' + escTxt(T(gg && gg.name ? String(gg.name) : gc.name)) + '</div>' +
'<div class="msg-game-result game-' + gOut + '">' + escTxt(T(gRes)) + '</div>' +
(gStats.length ? '<div class="msg-game-stats">' + gStats.map((x) => '<div class="msg-game-stat">' + escTxt(T(String(x))) + '</div>').join('') + '</div>' : '') +
'</div>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
if (rec.special === 'snake') {
m.className = 'msg-rps';
const snkResTxt = rec.snkResult === 'win' ? '你赢了' : rec.snkResult === 'lose' ? T('TA 赢了') : '平局';
const snkClr = rec.snkResult === 'win' ? '#34c759' : rec.snkResult === 'lose' ? '#ff6b6b' : '#888';
m.innerHTML = '<div class="msg-rps-card msg-snake-card">' +
'<div class="msg-snake-title">🐍 双人贪吃蛇</div>' +
'<div class="msg-snake-row"><span class="msg-snake-side">你</span><span>长度 ' + rec.snkPLen + '</span><span>食物 ' + rec.snkPFood + '</span><span>' + rec.snkPScore + '分</span></div>' +
'<div class="msg-snake-row"><span class="msg-snake-side">' + T('TA') + '</span><span>长度 ' + rec.snkOLen + '</span><span>食物 ' + rec.snkOFood + '</span><span>' + rec.snkOScore + '分</span></div>' +
'<div class="msg-rps-result" style="color:' + snkClr + '">存活 ' + rec.snkTime + 's · ' + escTxt(snkResTxt) + '</div>' +
'</div>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
if (rec.special === 'redpacket') {
m.className = 'msg-rp';
m.dataset.idx = __msgAt; // #1326：分支重写读调用方给的这一格
const sideTxt = rec.side === 'out' ? '我' : chatPartnerName();
const cls = rpStatusCls(rec);
const rpIco = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9c3 2 6 3 9 3s6-1 9-3"/><circle cx="12" cy="9" r="1.4"/></svg>';
m.innerHTML = '<div class="msg-rp-card' + (cls ? ' ' + cls : '') + '">' +
'<div class="msg-rp-top"><span class="msg-rp-ico">' + rpIco + '</span><span class="msg-rp-label">红包 · 心意币</span></div>' +
'<div class="msg-rp-amt">¥' + escTxt(Number(rec.rpAmount || 0).toFixed(2)) + '</div>' +
'<div class="msg-rp-wish">' + escTxt(rec.rpWish || '心意') + '</div>' +
'<div class="msg-rp-foot">' +
'<span class="msg-rp-side">' + escTxt(sideTxt) + ' 发出</span>' +
'<span class="msg-rp-status">' + escTxt(rpStatusText(rec)) + '</span>' +
'</div>' +
favHeartHtml(rec) +
'</div>';
if (rec.rpCover) {
const cover = rpCoverGet(rec.side);
if (cover) {
const card = m.querySelector('.msg-rp-card');
if (card) {
card.classList.add('has-cover');
card.style.backgroundImage = 'url("' + cover + '")';
}
}
}
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
// v3.15.x：TA 向 Mochi 申请心意币的回执卡（金额与红包同款随机分布）
if (rec.special === 'askcoin') {
m.className = 'msg-poke';
m.innerHTML = '<span>🪙 ' + escTxt(chatPartnerName()) + ' 向 Mochi 申请了心意币 ¥' + (Number(rec.askFen || 0) / 100).toFixed(2) + '</span>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
if (rec.special === 'flower') {
m.className = 'msg-flower';
m.dataset.idx = __msgAt; // #1326：分支重写读调用方给的这一格
const sideTxt = rec.side === 'out' ? '我' : chatPartnerName();
m.innerHTML = '<div class="msg-flower-card">' +
'<div class="msg-flower-bar"></div>' +
'<div class="msg-flower-emoji">' + escTxt(rec.flEmoji || '\uD83C\uDF37') + '</div>' +
'<div class="msg-flower-name">' + escTxt(rec.flName || '\u82B1') + '</div>' +
'<div class="msg-flower-divider"><span></span>\u2739<span></span></div>' +
'<div class="msg-flower-wish">\u201C' + escTxt(rec.flWish || '\u9001\u7ED9\u4F60~') + '\u201D</div>' +
'<div class="msg-flower-foot"><span>' + escTxt(sideTxt) + ' \u9001\u51FA</span></div>' +
favHeartHtml(rec) +
'</div>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
if (rec.special === 'gift') {
m.className = 'msg-gift';
m.dataset.idx = __msgAt; // #1326：分支重写读调用方给的这一格
const sideTxt = rec.side === 'out' ? '我 送出' : (rec.giftSelf ? (chatPartnerName() + ' 自己买的') : (chatPartnerName() + ' 送来'));
const gc = ((window.GIFT_CAT_COLOR || {})[rec.giftCat]) || '#f2f2f5';
m.innerHTML = '<div class="msg-gift-card">' +
'<div class="msg-gift-emoji" style="background:' + escTxt(gc) + '">' + (rec.giftImg ? '<img class="msg-gift-img" src="' + escTxt(rec.giftImg) + '" alt="">' : escTxt(rec.giftEmoji || '\uD83C\uDF81')) + '</div>' +
'<div class="msg-gift-name">' + escTxt(rec.giftName || '礼物') + '</div>' +
'<div class="msg-gift-divider"></div>' +
'<div class="msg-gift-wish">\u201C' + escTxt(rec.giftWish || '心意') + '\u201D</div>' +
'<div class="msg-gift-foot"><span class="mg-side">' + escTxt(sideTxt) + '</span>' +
'<span class="msg-gift-price">\u00A5' + escTxt(Number(rec.giftPrice || 0).toFixed(2)) + '</span></div>' +
giftCardReplHtml(rec) +
giftCardActsHtml(rec) +
favHeartHtml(rec) +
'</div>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
// v3.26.x #660：TA 的心愿卡——gift-shop.js 在「TA 把商品加进自己心愿单」那一刻按概率发出，
// 让我点【送 TA】买下送出。是否还「待买」按 TA 心愿单的实时数据判定（window.giftTaWishHas
// 由 gift-shop 提供；买下即从 TA 心愿单移除），所以记录里不写状态、卡片下次渲染自动转「已送出」。
// gift-shop.js 在 jsFiles 里排在 chat.js 之后，但本分支只在渲染时取用该全局（脚本全部执行完
// 才有渲染），取不到时按「还在心愿单里」处理（宁可多给一次【送 TA】）。
if (rec.special === 'wish') {
m.className = 'msg-gift msg-wish';
m.dataset.idx = __msgAt; // #1326：分支重写读调用方给的这一格
const wStill = wishCardIsPending(rec); // #1316：卡片自己记的 wishSent 优先，其次才是「TA 心愿单此刻还有这件」
const wgc = ((window.GIFT_CAT_COLOR || {})[rec.wishGiftCat]) || '#f2f2f5';
m.innerHTML = '<div class="msg-gift-card msg-wish-card">' +
'<div class="msg-wish-tag">' + escTxt(T('TA 的心愿')) + '</div>' +
'<div class="msg-gift-emoji" style="background:' + escTxt(wgc) + '">' + (rec.wishGiftImg ? '<img class="msg-gift-img" src="' + escTxt(rec.wishGiftImg) + '" alt="">' : escTxt(rec.wishGiftEmoji || '\uD83C\uDF81')) + '</div>' +
'<div class="msg-gift-name">' + escTxt(rec.wishGiftName || '礼物') + '</div>' +
'<div class="msg-gift-divider"></div>' +
'<div class="msg-gift-wish">\u201C' + escTxt(T(rec.text || '想要这个')) + '\u201D</div>' +
'<div class="msg-gift-foot"><span class="mg-side">' + escTxt(chatPartnerName() + T(' 许愿')) + '</span>' +
'<span class="msg-gift-price">\u00A5' + escTxt(Number(rec.wishGiftPrice || 0).toFixed(2)) + '</span></div>' +
(wStill
? '<div class="msg-wish-acts"><button class="msg-wish-buy" type="button">' + T('送 TA') + '</button></div>'
: '<div class="msg-wish-done">\u2713 ' + T('已送出') + '</div>') +
favHeartHtml(rec) +
'</div>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
if (rec.special === 'dish') {
m.className = 'msg-gift msg-dish';
m.dataset.idx = __msgAt; // #1326：分支重写读调用方给的这一格
const sideTxt = rec.side === 'out' ? '我 烹饪送出' : (chatPartnerName() + ' 烹饪送来');
const stars = rec.dishQuality === 'perfect' ? '★★★' : rec.dishQuality === 'good' ? '★★' : '★';
m.innerHTML = '<div class="msg-gift-card msg-dish-card">' +
'<div class="msg-gift-emoji" style="background:#fff3e0">' + escTxt(rec.dishEmoji || '\uD83C\uDF7D\uFE0F') + '</div>' +
'<div class="msg-gift-name">' + escTxt(rec.dishName || '菜肴') + ' <span class="dish-stars">' + stars + '</span></div>' +
'<div class="msg-gift-divider"></div>' +
'<div class="msg-gift-wish">\u201C' + escTxt(rec.dishWish || '尝尝手艺') + '\u201D</div>' +
'<div class="msg-gift-foot"><span class="mg-side">' + escTxt(sideTxt) + '</span>' +
'<span class="msg-gift-price">\u00A5' + escTxt(Number(rec.dishPrice || 0).toFixed(2)) + '</span></div>' +
favHeartHtml(rec) +
'</div>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
if (rec.special === 'ask-choose') {

m.className = 'msg-ask';
m.dataset.idx = __msgAt; // #1326：分支重写读调用方给的这一格
const answered = rec.choiceStatus === 'answered';
m.innerHTML = '<div class="msg-choose-card' + (answered ? ' answered' : '') + '">' +
'<div class="msg-ask-q">' + escTxt(rec.choiceQuestion || rec.text || '') + '</div>' +
(answered
? '<div class="msg-ask-a">✓ 你选择了：' + escTxt(rec.choiceAnswer) + '</div><div class="msg-choose-r">' + T('TA：') + escTxt(T(askCardReplyClean(rec.choiceReply))) + '</div>'
: '<div class="msg-ask-tip">点击选择你的答案</div>') +
favHeartHtml(rec) +
'</div>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
if (rec.special === 'ask-curious') {
m.className = 'msg-ask';
m.dataset.idx = __msgAt; // #1326：分支重写读调用方给的这一格
const answered = rec.curiousStatus === 'answered';
m.innerHTML = '<div class="msg-choose-card' + (answered ? ' answered' : '') + '">' +
'<div class="msg-ask-q">' + escTxt(rec.curiousQuestion || rec.text || '') + '</div>' +
(answered
? '<div class="msg-ask-a">✓ 你：' + escTxt(rec.curiousAnswer) + '</div><div class="msg-choose-r">' + T('TA：') + escTxt(T(askCardReplyClean(rec.curiousReply))) + '</div>'
: '<div class="msg-ask-tip">' + T('点击回答 TA 的好奇') + '</div>') +
favHeartHtml(rec) +
'</div>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
if (rec.special === 'ask-roast') {
m.className = 'msg-ask';
m.dataset.idx = __msgAt; // #1326：分支重写读调用方给的这一格
const answered = rec.roastStatus === 'answered';
m.innerHTML = '<div class="msg-choose-card' + (answered ? ' answered' : '') + '">' +
'<div class="msg-ask-q">' + escTxt(rec.roastText || rec.text || '') + '</div>' +
(answered
? '<div class="msg-ask-a">✓ 你：' + escTxt(rec.roastAnswer) + '</div><div class="msg-choose-r">' + T('TA：') + escTxt(T(askCardReplyClean(rec.roastReply))) + '</div>'
: '<div class="msg-ask-tip">' + T('点击回 TA 一句') + '</div>') +
favHeartHtml(rec) +
'</div>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
if (rec.special === 'ask-survey') {
m.className = 'msg-ask msg-survey';
m.dataset.idx = __msgAt; // #1326：分支重写读调用方给的这一格
m.innerHTML = surveyCardHtml(rec);
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
if (rec.special === 'ask-card') {
m.className = 'msg-ask';
m.dataset.idx = __msgAt; // #1326：分支重写读调用方给的这一格
const answered = rec.askStatus === 'answered';
const isSingle = rec.askType === 'single' || (rec.type === 'single' && Array.isArray(rec.options) && rec.options.length);
// #1415：多选题的提示要说出这一拍的规则（勾完要点提交，点一下不会落地）
const isMulti = rec.askType === 'multi' || (rec.type === 'multi' && Array.isArray(rec.options) && rec.options.length);
m.innerHTML = '<div class="msg-ask-card' + (answered ? ' answered' : '') + '">' +
'<div class="msg-ask-q">' + escTxt(rec.askQuestion || rec.text) + '</div>' +
(answered
? '<div class="msg-ask-a">✓ 已回答：' + escTxt(rec.askAnswer) + '</div>' + (rec.askReply ? '<div class="msg-choose-r">' + T('TA：') + escTxt(T(askCardReplyClean(rec.askReply))) + '</div>' : '')
// #1480：题自带「最多N」的卡，提示直接把限选数说出来（勾选那侧同受这道闸）
: '<div class="msg-ask-tip">' + (isMulti ? ((rec.askMultiMax >= 2 && rec.askMultiMax <= 6) ? '最多选 ' + rec.askMultiMax + ' 个，选完点「提交」' : '可多选，选完点「提交」') : isSingle ? '点击选择你的答案' : T('点击回答 TA 的提问')) + '</div>') +
favHeartHtml(rec) +
'</div>';
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
m.className = 'msg ' + (rec.side === 'out' ? 'msg-out' : 'msg-in');
const timeHtml = rec.ts ? '<span class="msg-time">' + fmtTime(rec.ts) + '</span>' : '';
const side = '<div class="msg-side"><div class="msg-av"></div>' + timeHtml + '</div>';
m.innerHTML = rec.side === 'out'
? '<div class="msg-bubble"></div>' + side
: side + '<div class="msg-bubble"></div>';
const av = m.querySelector('.msg-av');
const b = m.querySelector('.msg-bubble');
if (rec.special === 'read') {
// v3.26.x #220：idle 分支只有 {side,special}（读不到正文）——渲染成占位文本并打
// pendingRead 标记，权威读库收尾的原地补丁（inplacePatchIfSameWindow）据此把
// 「已读不回」替换成真实内容，替代旧的整窗重建路径
b.innerHTML = '<span style="opacity:.5;font-size:12px">已读不回</span>';
m.dataset.pendingRead = '1';
} else if (rec.retracted) {
// v3.16.x：撤回分支必须先于 sticker/image/voice/parts 类型分支——
// 否则表情包/图片/语音被撤回后任何全量重渲染（renderWindow/loadMsgs/切会话）
// 都会命中类型分支，把原内容（表情包 img 等）重新渲染出来，撤回形同失效
b.dataset.orig = rec.orig || retractSafeHtml(rec); // FIX #572d：仍是「快照优先」，无快照才走安全兜底（不再裸直出 rec.text）
b.innerHTML = '<span style="opacity:.6;font-size:12px;cursor:pointer">' + (rec.side === 'out' ? '我' : '对方') + '撤回了一条消息</span>';
bindToggle(b, rec.side);
} else if (rec.type === 'sticker' || rec.type === 'image') {
b.style.padding = '6px';
b.style.background = '';
b.style.border = '';
b.style.boxShadow = '';
b.innerHTML = (rec.quote ? quoteHtml(rec.quote, rec.qside) : '') + (rec.type === 'image'
? '<img class="msg-img msg-img-big" src="' + attrEsc(rec.text) + '" alt="图片" loading="lazy" decoding="async">'
: '<img class="msg-img msg-img-sm" src="' + attrEsc(rec.text) + '" alt="表情" loading="lazy" decoding="async">');
if (rec.type === 'image') {
b.querySelector('.msg-img-big').addEventListener('click', (e) => {
e.stopPropagation();
if (window.viewChatImage) window.viewChatImage(rec.text);
});
}
// FIX 2026-09-06 #186→#202 媒体加载失败占位统一走 bindMediaFailPlaceholder：
// 令牌缺失（池数据被误删/备份未带池键）、远程图断网/失效/混合内容拦截、dataURL 解码失败
// 都不再是无声空白气泡；竞态防线（#186 E3 实证 404 抢跑观察器改写）由 1.5s 延时复核承担
bindMediaFailPlaceholder(b);
} else if (rec.type === 'voice' || (String(rec.text || '').indexOf('|||') >= 0 && /@@m:[0-9a-f]{32}$/.test(String(rec.text || ''))) || chatIsDataAudioSrc(rec.text)) {
// FIX 2026-09-13 #395 渲染侧补认「名称|||@@m:hash」令牌语音（存量消息归一化未跑完时首屏也不直出令牌串）
// FIX 2026-09-20 #948 同口径补认整条内联 data:audio 载荷（旧判定大小写敏感＋语音令牌化未跑完时直出 base64）
b.style.padding = '8px 10px';
b.style.background = '';
b.style.border = '';
b.style.boxShadow = '';
fillVoiceBubble(b, rec.text, rec.quote ? quoteHtml(rec.quote, rec.qside) : '');
} else if (rec.parts && rec.parts.length) {
const imgs = rec.parts.filter(p => p.k === 'img').map(p => p);
const textPart = rec.parts.filter(p => p.k === 'text').map(p => p.v).join(' ');
let inner = '';
if (imgs.length) {
inner += '<div class="msg-parts-imgs' + (imgs.length > 1 ? ' multi' : '') + '">' +
imgs.map(p => {
const isSticker = p.sub === 'sticker';
return '<img class="msg-img' + (isSticker ? ' msg-img-sm' : ' msg-img-big') + '" src="' + attrEsc(p.v) + '" alt="' + (isSticker ? '表情' : '图片') + '" loading="lazy" decoding="async">';
}).join('') + '</div>';
}
if (textPart && textPart.trim()) {
// FIX 2026-09-13 #394 parts 文本走内嵌令牌助手（同 #385，令牌嵌正文中间不再直出）
inner += '<span style="opacity:.85;word-break:break-word">' + (window.mochiInlineTextHtml ? window.mochiInlineTextHtml(T(textPart)) : escTxtBr(T(textPart))) + '</span>';
}
b.innerHTML = rec.quote
? quoteHtml(rec.quote, rec.qside) + inner
: inner;
// FIX 2026-09-05 #185 空白兜底：parts 只有空白文本且无图时 inner 为空串，渲染成空气泡
if (!inner) b.innerHTML = '<span style="opacity:.5;font-size:12px">（空白消息）</span>';
b.querySelectorAll('.msg-img-big').forEach(img => {
img.addEventListener('click', (e) => {
e.stopPropagation();
if (window.viewChatImage) window.viewChatImage(img.src);
});
});
bindMediaFailPlaceholder(b); // FIX 2026-09-06 #202 parts 混合消息里的图同样挂失败占位
} else if (rec.retractedSegs && rec.retractedSegs.length) {
const segs = splitCardSegs(rec.text);
const rcs = rec.retractedSegs || [];
let segHtml = '';
for (let i = 0; i < segs.length; i++) {
if (!rcs.some(r => r.idx === i)) {
if (segHtml) segHtml += ' ';
segHtml += window.mochiInlineTextHtml(T(segs[i]));
}
}
let sub = '';
rcs.forEach(r => { sub += '<div style="padding:2px 0">（已撤回）' + escTxt(r.text || '') + '</div>'; });
b.innerHTML = (rec.quote ? quoteHtml(rec.quote, rec.qside) : '') +
'<span style="opacity:.85;word-break:break-word">' + (segHtml || '…') + '</span>' +
'<div style="margin-top:6px;text-align:left">' +
'<span class="msg-poke-seg" data-rc="1">' + (rec.side === 'out' ? '我' : '对方') + '撤回了 ' + rcs.length + ' 条字卡 ▾</span>' +
'<div class="msg-poke-seg-detail" style="display:none">' + sub + '</div>' +
'</div>';
const tip = b.querySelector('.msg-poke-seg');
if (tip) {
tip.addEventListener('click', (e) => {
e.stopPropagation();
const d = tip.nextElementSibling;
if (d) d.style.display = d.style.display === 'block' ? 'none' : 'block';
chatRetractToggleAfter('rc'); // #871：字卡明细开合同样是滚动区高度突变
});
}
} else {
// FIX 2026-09-05 #185 渲染端空白兜底：历史数据里已存在的空文本消息（无类型/无 special）
// 旧逻辑渲染成空壳气泡；改为显示占位，已存空白记录的设备更新后也能看出消息非空壳丢失
const __rawText = typeof rec.text === 'string' ? rec.text : '';
const __blankMsg = !__rawText.trim();
// FIX 2026-09-15 #534 存量图片直链自愈：一条只有图片 URL 的历史消息（#533 前被当文字卡
// 抽中、以 type:'text' 落库）不再把整段链接糊在气泡里，就地按图片渲染；渲染端不等归一化
// 跑完（首屏原始数据也能正确显示），点击看大图与 type:'image' 消息同款。零机型分支。
// FIX 2026-09-20 #948 同一自愈口扩到「整条 text 就是内联 dataURL 图片载荷」：漏进文字通道
// 的图片（TA 回应直传/parts 丢失/存量自愈未跑完/大小写与前导空白让旧判定全漏过）在消费者
// 边界就地按图片渲染，不再整屏铺 base64＝用户所见「图片变成长乱码」。判据与 #534 同源、
// 仍零机型分支（不猜内核，只把「这是不是一张图」判稳）。
const __imgSrc = !__blankMsg && chatIsImgSrcLike(__rawText) ? __rawText.trim() : '';
const __bodyHtml = __blankMsg
? '<span style="opacity:.5;font-size:12px">（空白消息）</span>'
: (__imgSrc
? '<img class="msg-img msg-img-big" src="' + attrEsc(__imgSrc) + '" alt="图片" loading="lazy" decoding="async">'
: '<span style="opacity:.85;word-break:break-word">' + window.mochiInlineTextHtml(T(__rawText)) + '</span>');
b.innerHTML = rec.quote
? quoteHtml(rec.quote, rec.qside) + __bodyHtml
: __bodyHtml;
if (__imgSrc) {
const __uImg = b.querySelector('.msg-img-big');
if (__uImg) __uImg.addEventListener('click', (e) => { e.stopPropagation(); if (window.viewChatImage) window.viewChatImage(__uImg.src); });
bindMediaFailPlaceholder(b); // FIX #948 内联载荷解不出图时不再空白（#202 同款占位）
}
}
if (rec.mood && rec.mood.length && !rec.retracted) {
const mm = document.createElement('div');
mm.className = 'msg-moods';
const recalled = [];
rec.mood.forEach((md, mi) => {
if (rec.retractedMood && rec.retractedMood.indexOf(mi) >= 0) { recalled.push(md); return; }
if (srcTagHidden(md && md.tag)) return; // #1236 总闸关着＝这枚来源 chip 不显示（数据不动）
      // #349/#843：不再做统一映射——tag 按「词典/词典拼句/词典拼词/词典逐卡连发」原样渲染
      //（词典=一条消息只装一张字卡；词典拼句=多张卡全部 >4 字整句；词典拼词=多张卡含 1~4 字短卡）
      const mt = escTxt(T(md.tag)), ml = escTxt(T(md.label));
      // v3.16.x：来源标签 chip（opts.tag 生成）的 label 恒等于气泡正文，不再重复渲染右侧文案，
      // 否则「字卡一行 + 标签行同文」内容重复（摸鱼抓包等）；真实情绪字卡 label≠正文不受影响
      const dupBody = md.label != null && String(md.label) !== '' && String(md.label) === String(rec.text == null ? '' : rec.text);
      if (md.tag === '交流意图') {
        mm.innerHTML += '<div class="msg-mood msg-intent"><span class="msg-mood-tag">' + mt + '</span>' + (dupBody ? '' : '<span>' + ml + '</span>') + '</div>';
      } else {
        mm.innerHTML += '<div class="msg-mood"><span class="msg-mood-tag">' + mt + '</span>' + (dupBody ? '' : '<span>' + ml + '</span>') + '</div>';
      }
});
if (recalled.length) {
mm.innerHTML += '<div style="margin-top:2px">' +
'<span class="msg-poke-seg" data-rcm="1">' + (rec.side === 'out' ? '我' : '对方') + '撤回了 ' + recalled.length + ' 条情绪字卡 ▾</span>' +
'<div class="msg-poke-seg-detail" style="display:none">' +
recalled.map(md => '<div style="padding:2px 0">（已撤回）' + escTxt(md.tag || '') + '：' + escTxt(md.label || '') + '</div>').join('') +
'</div></div>';
}
if (mm.children.length) b.appendChild(mm);
const rctip = mm.querySelector('.msg-poke-seg[data-rcm]');
if (rctip) {
rctip.addEventListener('click', (e) => {
e.stopPropagation();
const d = rctip.nextElementSibling;
if (d) d.style.display = d.style.display === 'block' ? 'none' : 'block';
chatRetractToggleAfter('rcm'); // #871：情绪字卡明细开合同样是滚动区高度突变
});
}
}
fillAvatar(av, rec.side === 'out' ? 'cs-avatar-user' : 'cs-avatar-partner');
if (rec.side === 'in') {
av.style.cursor = 'pointer';
av.title = T('对 TA 拍一拍');
// FIX 2026-09-14 #G1 点联系人头像打不开拍一拍（多机型同报、含内嵌浏览器；要求零机型分支防复发）：
// 纯 click 监听在部分内核/内嵌浏览器上不可靠——点按期消息区 DOM 重渲把目标拆走、滚动回弹期按位漂移、
// 长按候选判定吞 click 等都会让合成 click 丢失。改「touch 布点 + pointer 布点 + click 兜底」五保险
// （#152 继续按钮 pointerdown 方案同款思路，零机型分支）：
//   ① touchstart/touchend 路——无 PointerEvent 的旧内核/内嵌 WebView（国产浏览器壳、旧 WebView）只派发
//      touch 事件，pointer 监听永不触发，click 又是被吞的重灾区，touch 路是这类内核唯一可靠入口；
//   ② pointerdown/pointerup 路——现代内核轻点判定（位移<=12px 且 <=450ms，滚动历史不误伤）；
//   ③ click 兜底——鼠标与以上两路均失效的场景最后防线。
// 三路共用 pokeTapGuard 防重入：任一路打开面板后，其余路在 800ms 内直接让位，杜绝双开/刚开即关。
let pokeTapT = null;    // touch 路布点
let pokeTapP = null;    // pointer 路布点
let pokeTapGuard = 0;   // 三路共用防重入
av.addEventListener('touchstart', (e) => {
if (Date.now() < pokeTapGuard) return; // 已由其他路开过，让位
const t = e.changedTouches && e.changedTouches[0];
if (!t) return;
pokeTapT = { x: t.clientX, y: t.clientY, t: Date.now(), id: t.identifier };
}, { passive: true });
av.addEventListener('touchend', (e) => {
const t = e.changedTouches && e.changedTouches[0];
if (!pokeTapT || !t || t.identifier !== pokeTapT.id || Date.now() < pokeTapGuard) return;
const dt = Date.now() - pokeTapT.t;
const dx = t.clientX - pokeTapT.x;
const dy = t.clientY - pokeTapT.y;
pokeTapT = null;
if (dx * dx + dy * dy > 144 || dt > 450) return; // 滑动/按住不算点（与 pointer 路同口径，文本异形护哨兵唯一）
pokeTapGuard = Date.now() + 800;
openPokeCard(true); // FIX #511：手势开路 → 布点击闸，吞掉紧随的合成 click
}, { passive: true });
av.addEventListener('touchcancel', () => { pokeTapT = null; }, { passive: true });
av.addEventListener('pointerdown', (e) => {
if (e.pointerType === 'mouse' || Date.now() < pokeTapGuard) return;
pokeTapP = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
});
av.addEventListener('pointerup', (e) => {
if (!pokeTapP || e.pointerId !== pokeTapP.id || e.pointerType === 'mouse' || Date.now() < pokeTapGuard) return;
const dx = e.clientX - pokeTapP.x;
const dy = e.clientY - pokeTapP.y;
const dt = Date.now() - pokeTapP.t;
pokeTapP = null;
if (dt > 450 || dx * dx + dy * dy > 144) return; // 滑动/按住不算点，滚动照常
pokeTapGuard = Date.now() + 800;
openPokeCard(true); // FIX #511：同 touch 路——手势开路布闸，防合成 click 落进面板
});
av.addEventListener('pointercancel', () => { pokeTapP = null; });
av.addEventListener('click', (e) => {
// touch/pointer 已开过：吞掉补发 click，防 document 层「点外关闭」把面板刚开即关
if (Date.now() < pokeTapGuard) { e.preventDefault(); e.stopPropagation(); return; }
e.stopPropagation();
openPokeCard();
});
}
if (rec.side === 'in' && rec.initiative && !rec.retracted) {
try {
const c = cfg();
if (cfgn(c, 'as-badge', 1) === 1 && !b.querySelector('.msg-hi-heart') && !b.querySelector('.msg-hi-mark')) {
// FIX 2026-09-18 #727 用户直派「联系人主动发送的消息，现在是小爱心的标识，
// 帮我新增，可以用别的标识和自定义标识」：标识池由 reply-settings.js #727 段提供
//（window.asBadgePool 读 cfg 的内置五枚 + 自定义，只取 on=1）。口径：
//  · 池为空（全关）→ 兜底回爱心，保证「开着总开关就一定有标识」的既有观感；
//  · 单枚 → 直接用它；多枚 → as-badge-rand=1 每次随机、=0 按消息序号轮换（同一条稳定）；
//  · 爱心沿用原 SVG（保留既有 path 与 .msg-hi-heart 的绝对定位/配色语义，零视觉回归），
//    其余内置与自定义均为文本节点（.msg-hi-mark，样式见 chat-main.css）。
let pool = [];
try { pool = (window.asBadgePool ? window.asBadgePool(c) : []) || []; } catch (e) { pool = []; }
if (!pool.length) pool = [{ s: '♥', builtin: 1 }];
let pick = pool[0];
if (pool.length > 1) {
  if (cfgn(c, 'as-badge-rand', 1) === 1) {
    pick = pool[Math.floor(Math.random() * pool.length)];
  } else {
    // 按顺序轮换：用消息时间戳做稳定索引（同一条消息重渲仍是同一枚，不会闪变）
    const seed = Number(rec.ts) || 0;
    pick = pool[Math.abs(Math.floor(seed / 1000)) % pool.length];
  }
}
if (pick && pick.builtin === 1 && pick.s === '♥') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'msg-hi-heart');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z');
  svg.appendChild(path);
  b.insertBefore(svg, b.firstChild);
} else if (pick && pick.s) {
  const mk = document.createElement('span');
  mk.className = 'msg-hi-mark';
  mk.setAttribute('aria-hidden', 'true');
  mk.textContent = String(pick.s);
  b.insertBefore(mk, b.firstChild);
}
}
} catch (e) {}
}
if (rec.side === 'in' || rec.side === 'out') m.dataset.idx = __msgAt; // #1326：分支重写读调用方给的这一格
try {
const ts = rec.ts || Date.now();
m.querySelectorAll('img').forEach(img => {
if (img.complete) return;
img.addEventListener('load', () => {
if (Date.now() - ts < 6000 && chatVisible()) maybeScrollChatBottom(rec.side);
});
});
} catch (e) {}
appendMsg(m);
maybeScrollChatBottom(rec.side);
return m;
}
function performPoke() {
let action = '';
const dcfg = (window.defaultCardCfg && window.defaultCardCfg()) || {};
const useChat = window.defaultCardUse ? window.defaultCardUse('chat') : true;
const touchOn = window.defaultCardCat ? window.defaultCardCat('touch') : true;
if (dcfg.enabled && useChat && touchOn && dcfg.probs && (dcfg.probs.touch || 0) > 0) {
const d = (window.getDefaultCards && window.getDefaultCards()) || null;
if (d && d.type === 'poke') action = d.text;
}
if (!action) {
const cards = pokeAllCards();
action = cards.length ? pick(cards) : '拍了拍你';
}
// v3.26.x：TA 主动拍一拍同样存 {ta}/{me} 占位符（与 sendPoke 一致），昵称渲染期回填、不受称呼改写
let text;
if (action.indexOf('你') >= 0) {
if (action.charAt(0) === '你' || action.charAt(0) === '我') {
text = '{ta} ' + action.slice(1).replace(/你(?![们])/g, '{me}');
} else {
text = '{ta} ' + action.replace(/你(?![们])/g, '{me}');
}
} else if (action.charAt(0) === '我') {
text = '{ta} ' + action.slice(1);
} else {
text = '{ta} ' + action;
}
addIn(text, { special: 'poke' });
}
function chatUnread() { try { return parseInt(store.get('chat-unread'), 10) || 0; } catch (e) { return 0; } }
function incChatUnread() {
try { store.set('chat-unread', String(chatUnread() + 1)); } catch (e) {}
updateChatBadge();
}
function clearChatUnread() {
try { store.set('chat-unread', '0'); } catch (e) {}
updateChatBadge();
}
function updateChatBadge() {
const n = chatUnread();
if (window.setDeskBadge) { window.setDeskBadge('chat', n); return; }
const badge = document.getElementById('chat-badge');
if (!badge) return;
badge.hidden = n === 0;
badge.textContent = n > 99 ? '99+' : String(n);
}
window.clearChatHistory = function () {
msgs = [];
pendingLocal = null;
sessionChangedIdx.clear();
chatDbReady = true;
renderStart = 0; // v3.6.x：分页窗口起点复位（消息已清空）
// v3.26.x #220：消息清空＝屏上窗口作废（#220 同窗补丁凭据一并复位，防误判同窗）
windowRenderedN = 0; windowRenderedPrefix = null; windowStale = false; windowRenderedNicks = ''; windowRenderedLite = null; normChangedIdxs = null; normChangedRecs = []; normRemovedRecs = []; normOrigIdx = null; normSnapTail = null; // FIX #402/#675 随窗复位
cancelPersist();
chatArchClearBaseline(); // FIX 2026-09-17 #127：清空＝基准段作废
// v3.26.x #90：用户主动清空＝合法归零，账本必须同步（否则缩水守卫会一直拒绝后续保存）
try { chatLedger[window.activePrefix()] = 0; } catch (e) {}
try { store.remove('chat-msgs'); } catch (e) {}
try { store.remove('chat-arch'); } catch (e) {} // FIX 2026-09-17 #127：增量日志一并清（否则刷新后回放复活）
try { store.remove('chat-meta'); } catch (e) {}
try {
// #722：分块格式的块键与索引一并清（否则清空后刷新，blk-idx 回放复活全部历史）。
// 走扫盘助手而非内存索引——本次会话没读过该桌面时 chatBlkIdx 是 null，只看内存会漏删。
chatBlkPurgePrefix(window.activePrefix());
} catch (e) {}
chatBlkResetState(); // #722：分块状态复位（此后保存走旧格式/重新分块）
chatTailClear(); // #180：清空记录＝日志一并清（否则刷新后已清内容回放复活）
if (body) body.innerHTML = '';
clearChatUnread();
};
window.chatExportMsgs = function () {
if (window.chatFlushSave) window.chatFlushSave();
return (msgs || []).slice();
};
window.chatImportMsgs = function (arr) {
if (!Array.isArray(arr)) return false;
msgs = arr.filter(m => m && typeof m === 'object');
pendingLocal = null;
sessionChangedIdx.clear();
chatDbReady = true;
renderStart = 0;
// v3.26.x #220：整包导入替换＝屏上窗口作废（同窗补丁凭据复位）
windowRenderedN = 0; windowRenderedPrefix = null; windowStale = false; windowRenderedNicks = ''; windowRenderedLite = null; normChangedIdxs = null; normChangedRecs = []; normRemovedRecs = []; normOrigIdx = null; normSnapTail = null; // FIX #402/#675 随窗复位
cancelPersist();
chatTailClear(); // #180：整包导入替换＝旧日志作废
chatArchClearBaseline(); // FIX 2026-09-17 #127：整包替换＝旧基准段/日志作废
try {
// #722：导入替换＝旧分块状态与磁盘块全部作废（扫盘删，不依赖内存索引；漏删会让旧 blk-idx
// 遮蔽刚导入的整包＝用户看到导入「没生效」）
chatBlkPurgePrefix(window.activePrefix());
} catch (e) {}
chatBlkResetState(); // #722：导入=全新历史，块状态复位（persistChatHistory 按新数组重新分块）
try { store.remove('chat-arch'); } catch (e) {}
try { if (window.idbSet) persistChatHistory(window.activePrefix(), msgs, true); } catch (e) {}
writeLsSnapshot(msgs, undefined, true);
// v3.26.x #90：主动整包替换＝合法，账本直接对齐新条数（旧的高账本不得继续拦后续保存）
try { chatLedgerSave(window.activePrefix(), msgs.length, msgsBytes(msgs)); } catch (e) {}
if (body) body.innerHTML = '';
clearChatUnread();
if (chatVisible() && msgs.length) {
renderWindow(false, true);
scrollChatBottom();
}
return true;
};
const deskMsgEl = document.getElementById('desk-msg');
const deskMsgAv = document.getElementById('desk-msg-av');
const deskMsgName = document.getElementById('desk-msg-name');
const deskMsgText = document.getElementById('desk-msg-text');
let deskMsgTimer = null;
let deskMsgAction = null; // v3.5.107：横幅点击回调（聊天进聊天页 / 信箱进信箱 / 朋友圈进朋友圈）
let deskMsgCloseAnimTimer = null; // v3.5.136：关闭滑出动画定时器（防止与新横幅竞态）
let deskMsgRevertTimer = null;    // v3.5.136：回弹动画定时器
function deskMsgEnabled() {
const v = store.get('desk-msg-en');
return v === null || v === undefined || v === '' ? true : v === '1';
}
function showDeskPopup(opts) {
opts = opts || {};
let t = String(opts.text || '');
const phOf = function () {
if (opts.type === 'voice') return '[语音]';
if (opts.imgSub === 'sticker' || opts.type === 'sticker') return '[表情包]';
return '[图片]';
};
if (!t && opts.img) t = phOf();
if (!t) return;
// FIX 2026-09-20 #948 判据大小写/前导空白不敏感（旧写法精确匹配 'data:' 开头，变体形态整串
// 载荷会带着 base64 进桌面弹窗/通知预览）
if (chatIsInlineDataSrc(t)) t = phOf();
else if (/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i.test(t)) t = t.replace(/data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[附件]');
else if (t.indexOf('|||') >= 0) t = t.split('|||')[0].replace(/\.[^.]+$/, '').trim() || '[语音]';
else if (t.indexOf('<svg') >= 0) t = t.replace(/<[^>]*>/g, '').trim();
// FIX 2026-09-13 #403 桌面弹窗清洗链补媒体池令牌（含令牌消息预览不再直出 @@m:hash 乱码）
if (t.indexOf('@@m:') >= 0) t = t.replace(/@@m:[0-9a-f]{32}/g, '[图片]');
if (t.length > 40) t = t.slice(0, 40) + '…';
let notifyT = t;
if (opts.img && notifyT.indexOf('[图片]') < 0 && notifyT.indexOf('[表情包]') < 0 && notifyT.indexOf('[语音]') < 0 && notifyT.indexOf('[附件]') < 0) {
notifyT = notifyT + ' ' + phOf();
}
const isHidden = opts.isHidden === true;
if (isHidden) {
if (window.bgNotifyCheck) {
window.bgNotifyCheck(notifyT, opts.deliveredAt || Date.now(), { name: opts.name, img: opts.img, av: opts.av, avFixed: opts.avFixed === true, deliveredAt: opts.deliveredAt || 0, msgTs: opts.msgTs || 0, kind: opts.notifyKind || 'msg', cid: opts.notifyCid || '' });
}
return;
}
// FIX 2026-09-19 #795：横幅是「桌面层」通知，桌面页不在屏上（用户在聊天/信箱/日历等页）时
// 不再弹出——此时横幅会盖在该页顶栏上、6s 后自己消失＝信箱回信后回聊天「屏幕闪一下」的
// 直接来源（addRec 在聊天页隐藏时落系统消息 → showDeskMsg 弹横幅，用户随后回聊天恰好撞上）。
// 后台态（isHidden）走上面 bgNotifyCheck 系统通知链路，不受此闸影响；桌面可见时行为一字不变。
{
const _pp = document.getElementById('page-phone');
if (_pp && _pp.hidden) return;
}
if (!deskMsgEl || !deskMsgEnabled()) return;
if (deskMsgText) deskMsgText.textContent = notifyT;
if (deskMsgName) deskMsgName.textContent = opts.name || chatPartnerName();
if (deskMsgAv) {
if (opts.av && typeof opts.av === 'string' && opts.av.indexOf('data:') === 0) {
const img = document.createElement('img');
img.src = opts.av;
img.alt = '';
deskMsgAv.innerHTML = '';
deskMsgAv.appendChild(img);
deskMsgAv.__avApplied = opts.av;
} else {
fillAvatar(deskMsgAv, 'cs-avatar-partner'); 
}
}
deskMsgAction = (typeof opts.onClick === 'function') ? opts.onClick : null;
if (deskMsgCloseAnimTimer) { clearTimeout(deskMsgCloseAnimTimer); deskMsgCloseAnimTimer = null; }
if (deskMsgRevertTimer) { clearTimeout(deskMsgRevertTimer); deskMsgRevertTimer = null; }
deskMsgEl.style.transition = '';
deskMsgEl.style.transform = '';
deskMsgEl.style.opacity = '';
deskMsgEl.hidden = false;
clearTimeout(deskMsgTimer);
deskMsgTimer = setTimeout(() => { if (deskMsgEl) deskMsgEl.hidden = true; }, 6000);
}
function extractDeskMsg(rec) {
let text = rec.text || '';
// v3.26.x：拍一拍/系统消息存 {ta}/{me} 占位符，桌面弹窗预览需回填昵称
// （renderMsg 走 T() 替换，此处同义；不走 taFit 称呼改写，避免昵称被改成 他/她）
// v3.30.x：拍一拍人称昵称制——poke/ask-msg 整体走 pokePersonMap（{ta}/{me} 与字卡写死的
// TA/ta/他/她 一律按昵称回填，与聊天内渲染一致；须在回填前整体替换，防昵称含 TA/他/她 被二次改写）
// FIX 2026-09-16 #616：nickKeep 的昵称事件消息除外——桌面横幅预览与聊天内渲染同口径原样呈现
if ((rec.special === 'poke' || rec.special === 'ask-msg') && !rec.nickKeep && typeof text === 'string') {
text = pokePersonMap(text, chatPartnerName(), chatUserName());
} else {
if (typeof text === 'string' && text.indexOf('{ta}') >= 0) text = text.split('{ta}').join(chatPartnerName());
if (typeof text === 'string' && text.indexOf('{me}') >= 0) text = text.split('{me}').join(chatUserName());
}
let img = rec.img || '';
let imgSub = '';
if (rec.parts && rec.parts.length) {
const ims = rec.parts.filter(p => p.k === 'img');
if (ims.length) {
img = ims[0].v || '';
imgSub = ims[0].sub || '';
}
const tp = rec.parts.filter(p => p.k === 'text').map(p => p.v).join(' ');
if (tp) text = tp;
} else if (chatIsDataImgSrc(text) ||
((rec.type === 'sticker' || rec.type === 'image') && /^https?:\/\//i.test(text))) {
img = text;
text = '';
imgSub = rec.type === 'sticker' ? 'sticker' : (rec.type === 'image' ? 'image' : '');
}
if (rec.type === 'voice') {
const vname = String(text || '').split('|||')[0] || '';
text = vname.replace(/\.[^.]+$/, '').trim() || '语音消息';
}
// FIX 2026-09-27 #1347（同上批，与角标那条闸是同一件事的两半）：卡片类收件的正文不住在 rec.text
// 里——红包是 rpAmount/rpWish、礼物是 giftName、送花是 flName、查岗是 askQuestion——预览串拿到空，
// 下游 showDeskPopup 那句「说不出就不弹」（if (!t) return;）于是把桌面横幅与后台系统通知一起静默
// 丢掉。#660 当年写的「未读角标 / 桌面横幅 / 系统通知三处都能看懂」对礼物这一类无 text 的卡片其实
// 一直不成立（实测：礼物卡角标 +1 而横幅不弹）。这里补一句不含卡片类型的通用文案：判据只有「这是
// 聊天里新出的一条卡片」＋「预览说不出它的内容」两个事实，不按类型建表＝以后新增任何卡片形态要么
// 自带可预览正文、要么落这句，绝不会再出现「屏上多了一张卡而任何地方都不吭声」。
if (!text && !img && rec.special && rec.special !== 'read') text = '发来一条新消息，点开看看';
return { text: text, img: img, imgSub: imgSub };
}
function showDeskMsg(rec) {
const info = extractDeskMsg(rec);
const name = chatPartnerName();
const isHidden = document.visibilityState === 'hidden';
if (isHidden) {
showDeskPopup({ name: name, text: info.text, type: rec.type, img: info.img, imgSub: info.imgSub, msgTs: rec.ts || 0, isHidden: true });
return;
}
if (chatVisible()) return;
showDeskPopup({ name: name, text: info.text, type: rec.type, img: info.img, imgSub: info.imgSub, msgTs: rec.ts || 0, deliveredAt: rec.dAt || 0, isHidden: false });
}
function hideDeskMsg() {
clearTimeout(deskMsgTimer);
if (deskMsgCloseAnimTimer) { clearTimeout(deskMsgCloseAnimTimer); deskMsgCloseAnimTimer = null; }
if (deskMsgRevertTimer) { clearTimeout(deskMsgRevertTimer); deskMsgRevertTimer = null; }
deskMsgAction = null;
if (deskMsgEl) {
deskMsgEl.style.transition = '';
deskMsgEl.style.transform = '';
deskMsgEl.style.opacity = '';
deskMsgEl.hidden = true;
}
}
window.showDeskPopup = showDeskPopup;
window.hideDeskMsg = hideDeskMsg;
if (deskMsgEl) deskMsgEl.addEventListener('click', () => {
if (deskMsgSuppressClick) { deskMsgSuppressClick = false; return; }
const action = deskMsgAction;
hideDeskMsg();
if (action) action();
else if (!chatVisible()) enterChat();
});
// FIX 2026-09-19 #795（红米 K80 Chrome 等多机型报「信箱回信后回到聊天页，屏幕闪一下」，用户明说
// 其他设备型号也有）：回信落「你给 X 回了一封信」进聊天时聊天页正隐藏（用户在信箱页）→ addRec
// 走 showDeskMsg 弹**桌面横幅**（#desk-msg 是 body 级固定层，最长挂 6s 才自动消失）。用户随后
// 关信箱回聊天——桌面图标（enterChat）与返回键直显（tabs.js popstate）两条路都**不经过任何横幅
// 清理**，横幅正好盖在聊天页顶栏上，几秒后自动消失＝用户看到的「闪一下」。修法＝横幅回归
// 「桌面层通知」本位：桌面页（page-phone）一旦隐藏就收走横幅（复用 hideDeskMsg，幂等；点横幅
// 跳页的老路径本就先 hideDeskMsg 再动作，零冲突）。桌面可见时横幅行为一字不变；信箱/日历等
// 其余页面同样被这条覆盖（横幅不再浮在任何非桌面页之上）。零机型分支：纯 DOM 可见性判据。
(function () {
const pp = document.getElementById('page-phone');
if (!pp || typeof MutationObserver === 'undefined') return;
new MutationObserver(function () {
if (pp.hidden && deskMsgEl && !deskMsgEl.hidden) window.hideDeskMsg();
}).observe(pp, { attributes: true, attributeFilter: ['hidden'] });
})();
let deskMsgSuppressClick = false;
let deskMsgSuppressTimer = null;
let dDrag = null;
function deskMsgDragStart(cx, cy) {
if (!deskMsgEl || deskMsgEl.hidden) return;
dDrag = { x: cx, y: cy, moved: false, speed: 0, lastX: cx, lastT: Date.now() };
deskMsgEl.style.transition = 'none'; // 拖拽过程中不带动画，实时跟手
}
function deskMsgDragMove(cx, cy) {
if (!dDrag) return false;
if (!deskMsgEl || deskMsgEl.hidden) { dDrag = null; return false; }
const dx = cx - dDrag.x;
const dy = cy - dDrag.y;
const now = Date.now();
if (now - dDrag.lastT >= 60) {
dDrag.speed = (cx - dDrag.lastX) / (now - dDrag.lastT);
dDrag.lastX = cx;
dDrag.lastT = now;
}
if (Math.abs(dx) > 4 && Math.abs(dx) > Math.abs(dy) * 1.2) {
deskMsgEl.style.transform = 'translateX(' + dx + 'px) scale(' + Math.max(0.92, 1 - Math.abs(dx) / 500) + ')';
deskMsgEl.style.opacity = String(Math.max(0, 1 - Math.abs(dx) / 140));
dDrag.moved = true;
return true; // 调用方据此 preventDefault，阻止浏览器手势接管
}
return false;
}
function deskMsgDragEnd(cx) {
if (!dDrag) return;
const dx = cx - dDrag.x;
const wasMoved = dDrag.moved;
const speed = dDrag.speed || 0;
dDrag = null;
if (!wasMoved || !deskMsgEl) return;
deskMsgSuppressClick = true;
clearTimeout(deskMsgSuppressTimer);
deskMsgSuppressTimer = setTimeout(() => { deskMsgSuppressClick = false; }, 350);
const shouldClose = Math.abs(dx) > 30 || Math.abs(speed) > 0.6;
if (shouldClose) {
deskMsgSuppressClick = false;
clearTimeout(deskMsgSuppressTimer);
deskMsgEl.style.transition = 'transform .18s ease, opacity .18s ease';
deskMsgEl.style.transform = 'translateX(' + (dx >= 0 ? 160 : -160) + 'px)';
deskMsgEl.style.opacity = '0';
deskMsgCloseAnimTimer = setTimeout(hideDeskMsg, 180);
} else {
deskMsgEl.style.transition = 'transform .25s cubic-bezier(.25,.8,.35,1), opacity .25s ease';
deskMsgEl.style.transform = '';
deskMsgEl.style.opacity = '';
deskMsgRevertTimer = setTimeout(() => { if (deskMsgEl) deskMsgEl.style.transition = ''; }, 260);
}
}
if (deskMsgEl) {
deskMsgEl.addEventListener('touchstart', (e) => {
const t = e.touches && e.touches[0];
if (t) deskMsgDragStart(t.clientX, t.clientY);
}, { passive: true });
window.addEventListener('touchmove', (e) => {
if (!dDrag) return;
const t = e.touches && e.touches[0];
if (t && deskMsgDragMove(t.clientX, t.clientY)) {
try { e.preventDefault(); } catch (err) {}
}
}, { passive: false });
const endTouch = (e) => {
const c = e.changedTouches && e.changedTouches[0];
deskMsgDragEnd(c ? c.clientX : (dDrag ? dDrag.x : 0));
};
window.addEventListener('touchend', endTouch);
window.addEventListener('touchcancel', endTouch);
deskMsgEl.addEventListener('mousedown', (e) => deskMsgDragStart(e.clientX, e.clientY));
window.addEventListener('mousemove', (e) => { if (dDrag) deskMsgDragMove(e.clientX, e.clientY); });
window.addEventListener('mouseup', (e) => deskMsgDragEnd(e.clientX));
}
const deskMsgToggle = document.getElementById('desk-msg-en');
if (deskMsgToggle) {
deskMsgToggle.checked = deskMsgEnabled();
deskMsgToggle.addEventListener('change', () => {
try { store.set('desk-msg-en', deskMsgToggle.checked ? '1' : '0'); } catch (e) {}
});
}
// #1015 夜间模式收件总闸（设置里开启后 22:00–7:00 生效），口径＝只拦「TA 主动发起」：
// 判据是 rec.initiative（TA 自发的收件为真）——被动回复链不带此标记，所以「你自己发消息、
// TA 照常回」夜里依旧即时送达，只有 TA 自发的打扰被拦（主动消息/拍一拍/邀请/互动卡/换头像
// 换昵称/换位/送礼/朋友圈提示/跨桌面回放），各自的定时链另有源头闸、此处是最后一层兜底。
// rec.nightAllow 是显式豁免通道，留给「用户当刻操作引发」的记录（红包领取退回、战绩、存钱罐、
// 决定结果等）。时段外/开关关零影响。（前身 #876 的总闸被一次并行全量上传抹掉，本批按用户
// 口径补回：夜间只拦 TA 主动，你自己发的消息与 TA 的回复照常。）
function nightBlocksIn(initiative, nightAllow) {
if (nightAllow) return false;
if (!initiative) return false;
if (window.__nightReplyOpen && Date.now() - window.__nightReplyOpen < 180000) return false;
return !!(window.nightModeActive && window.nightModeActive());
}
// #1015 夜间对话窗口：你自己发消息 / 点「继续说」/ 点「让TA邀请我」三处都调它——窗口内 TA 在
// 这条对话里的追加动作（如【TA的心情】分享卡）与「形态上是主动」的当刻回应照常落地；被动回复
// 链本身不带 initiative，不看本窗。时段外/开关关时是空操作。
function nightOpenReply() {
if (window.nightModeActive && window.nightModeActive()) window.__nightReplyOpen = Date.now();
}
// ==== #1438（作者 2026-09-29 直派「聊天里联系人发送的卡片，如果我没有回答，刷新重新打开网页，
// 聊天里的卡片会消失，没有显示」＋「总之不要丢失我的记录」）====
// 洞是不对称，不是渲染：回答那侧处处走 `saveMsgsNow()`（#489 注释原话「回答即落盘……切桌面
// flush 前不止内存一份」），而**建卡**这侧只有 `saveMsgs()`＝空闲回调＋最小间隔合并的低频整包落盘
// （v3.26.x 止血留下的），第二副本仅尾巴日志一条——而尾巴日志对互动卡并不保险：
// `chatTailAppend` 有「序列化超 3000 字符宁可不兜底」那道拒收，实测第一张查岗卡（整包 437 字节）
// 就没进日志。于是「还没答的卡」在整包落盘之前被刷新／杀进程／系统回收打断，IDB 与 LS 快照里
// 都没有它，重开时权威读库判它「不存在」，从此彻底消失（往上翻也没有）；答过的因为早强制落过盘，
// 永远在。作者看到的「只有没回答的卡会消失」正是这一条，与机型无关。
// 修法＝把建卡拉到与答卡同一档位：这类记录一进 msgs 就把待写的整包 flush 掉。
// 刻意不另开写路径——仍走 saveMsgs→schedulePersist 那个闭包，#88「本会话没读到权威就不整包写」
// 与 #90 条数账本两道守卫一字不动；权威未到手时 saveMsgs 自己走「暂存 pendingLocal＋LS 有损快照＋
// 重试读回」那条分支，此刻没有待写手，flush 自然空转（不会把半截内存写成整包）。
const PENDING_CARD_STATUS_FIELD = {
'ask-card': 'askStatus', ask: 'askStatus', 'ask-choose': 'choiceStatus', 'ask-curious': 'curiousStatus',
'ask-roast': 'roastStatus', invite: 'inviteStatus', survey: 'surveyStatus', redpacket: 'rpStatus'
};
// 已落定的取值枚举：互动卡答完是 'answered'，问卷 'done'，红包被领/过期/退回都不再是「等人来操作」
const PENDING_CARD_SETTLED = { answered: 1, done: 1, received: 1, expired: 1, returned: 1 };
function isPendingCardRec(rec) {
if (!rec) return false;
const f = PENDING_CARD_STATUS_FIELD[rec.special];
if (!f) return false;
// 没有这个字段也算「未落定」：ck-question 发卡时根本不传 askStatus（回答后才写），
// 拿「字段缺失」当已落定＝把最容易丢的那一类（刚发来、没人碰过）漏在闸外
return !PENDING_CARD_SETTLED[rec[f]];
}
function addRec(rec) {
if (rec.side === 'in' && nightBlocksIn(rec.initiative, rec.nightAllow)) return null;
if (rateBlocksIn(rec)) return null; // #1180 总量限流兜底（chatAddGift 等不过 addIn 的入口也走这里）
if (!rec.ts) rec.ts = Date.now();
chatRecStampUid(rec); // FIX #776：出生号——同一条消息被哪条通道克隆回去，认号不认正文
const len = msgs.length;
// FIX 2026-09-18 #744（HUAWEI Mate 40 Pro + Edge 等跨机型偶发「联系人消息重复一条变两条」）：
// 结构性双写守卫——同一条 rec「对象引用」被原样塞进 msgs 两次（某条投递链对同一对象两次进入
// 本函数）时，直接丢弃第二次，绝不产生双气泡/双写盘。零误伤：每条合法消息都是新对象，同一对象
// 引用连续出现只可能来自真实的重复投递 bug，不可能来自两条「内容相同」的合法消息（#437 语义
// 不变）。触发时记进 window.__mochiDupAdd 供后续定位双写来源（诊断用、不断言、不弹窗）。
if (len && msgs[len - 1] === rec) {
try { (window.__mochiDupAdd = window.__mochiDupAdd || []).push(Date.now() + ':' + String((rec.text != null) ? rec.text : '').slice(0, 24) + ':' + String(rec.side || '')); } catch (eD) {}
return null;
}
// FIX 2026-09-18 #776（vivo X200 + Edge 151 等跨机型「一条变两/三条、越用越多」）：#744 只挡
// 「同一个对象」被塞两次，挡不住**带着同一 ts 的克隆副本**再次投递（回复链重投、整页冻结解冻后
// 积压重放、跨页补投递）。而下方 #256 正文去重对 `special` 卡片类是整条跳过的（`if (!p ||
// p.special || rec.special) continue`）——所以拍一拍/互动卡/提醒/结算卡这类**唯一没有实时防重**
// 的消息，恰好就是「卡片显示两条」报障里反复出现的一类。
// 判据用副本键（ts+side+special+type ＋「松散正文签名相同」或「出生号 uid 相同」），不能用裸
// ts+side：批量发送 sendBatchItem 在同一个同步循环里逐条 addRec，同一毫秒同侧 N 条是用户真发了
// N 条（正文各不同、出生号也各不同，两条判据都分得开）。
// 先比廉价 kindKey（每加一条只多算一次 stringify），命中再比正文，避免整窗全量重算。
const _kk = chatRecKindKey(rec);
if (_kk) {
for (let i = len - 1, n = 0; i >= 0 && n < 200; i--, n++) {
const p = msgs[i];
if (!p || chatRecKindKey(p) !== _kk) continue;
if (!chatRecKeysShare(p, rec)) continue; // 同毫秒不同类型的合法批量：留着
try { (window.__mochiDupAdd = window.__mochiDupAdd || []).push('id:' + Date.now() + ':' + String((rec.text != null) ? rec.text : '').slice(0, 24) + ':' + String(rec.side || '')); } catch (eD) {}
return null;
}
}
// FIX 2026-09-19 #796（跨机型「礼物卡/红包/互动卡/拍一拍发送那一刻就变两条」残余通道收口）：
// #776 出生号闸门只在**同一毫秒**命中（chatRecIdKey=ts|side），#256 正文窗又把 special 卡**整条
// 跳过**（`if (p.special || rec.special) continue`）——内核补发合成 click、低端机长任务把第二次
// 派发压后 150~606ms（#359/#401 实测量级）哪怕只晚 1ms，卡片族就毫无实时拦截。这正是「全部
// 类型都有、卡片最多」在 #744/#776/#766 之后仍复发的通道：文字/图片/表情/语音早有发守卫＋
// 800ms 窗双层（#437 口径），唯独 special 卡两层都轮不到。
// 补一层【跨毫秒同内容短闩】：out 侧 special 卡与拍一拍（我方手势、存 in 侧、菜单发出即收起）
// 在 800ms 内出现「同侧同 special＋指纹（松散签名＋卡片身份字段）相同」的第二份＝同一手势的
// 双派发，丢弃并 toast（#437 同窗口同文案：面板发出即关，人为重发同内容必须重开面板 ≈≥1s，
// 800ms 只吞机械双派发；红包金额/礼物名字等指纹不同＝两张不同的卡，照常放行）。
// 零机型分支；dedupExempt 照 #544 豁免；in 侧其余 special（TA 批量/回执，1.2~2.8s 间隔）
// 一律不碰——宁漏不误删，合法批量（sendBatchItem，无 special）也不经过本层。
const _lk = (rec.special && !rec.dedupExempt && ((rec.side || '') === 'out' || rec.special === 'poke')) ? (chatRecLooseSig(rec) + chatRecCardExtra(rec)) : '';
if (_lk) {
for (let i = len - 1, n = 0; i >= 0 && n < 60; i--, n++) {
const p = msgs[i];
if (!p || (p.side || '') !== (rec.side || '') || p.special !== rec.special) continue;
const _dts = (rec.ts || 0) - (p.ts || 0);
if (_dts <= 0 || _dts > 800) continue; // 同毫秒归上一层闸门；>800ms 的人为重发归用户本意
if (chatRecLooseSig(p) + chatRecCardExtra(p) !== _lk) continue;
try { (window.__mochiDupAdd = window.__mochiDupAdd || []).push('lk:' + Date.now() + ':' + rec.special + ':' + String(rec.side || '')); } catch (eD2) {}
try { if ((rec.side || '') === 'out' && !rec.silent && typeof toast === 'function') toast('同样的内容刚发送过，未重复发送'); } catch (e) {}
return null;
}
}
// #256：实时去重改与刷新归一化同口径——mediaTxtEq 跨形式比对 + dupGapMs 统一窗口
// （sticker/image/voice 型收件侧 60000ms，覆盖多字卡回复条间隔 randInt(1200,2800)；
// 旧 1200ms 窗整体漏过该间隔＝同款表情包一批两张，刷新后才被归一化删掉一张）。
// FIX 2026-09-15 #544：rec.dedupExempt＝用户主动触发的决定答案（帮我决定/多人决定发到聊天）
// 豁免本扫描——同一问题快速重跑且抽中同结果时，答案带【帮我决定】前缀同文撞进 in 侧 2500ms
// 窗被静默吞（in 侧无 toast 反馈＝用户视角「联系人消息被吞了几条」），且扫描只看最近 5 条的
// 时间差，第 1 条被吞后窗口不闭合会连锁吞掉后续同文答案。豁免只对带标记的决定答案生效，
// TA 批次/用户消息的 #256/#437 去重契约零改动（normCollapseRange 刷新侧同口径豁免）。
// FIX 2026-09-19 #814（荣耀畅玩40 Plus + 夸克等多机型报「我发的/联系人发的消息莫名被吞」）：
// 本正文窗**收件侧不再去重**。这扇窗当年为拦 TA 批次/回复链的重投副本而设（#256「同款表情包
// 一批两张」），而副本通道此后已全部收口到身份级——尾巴日志/LS 快照/chat-arch/热片/psync
// 重投一律保留原 ts，由 #744（同对象）/#776（出生号）/#796（卡片短闩）实时拦下、刷新侧由
// collapseIdentityRange＋normCollapseRange（#814b 同 ts 判据）收回。于是本窗现在命中不再是
// 「副本」，而是「真的又发了同样内容的合法第二条」——in 侧文本 2500ms/媒体 60000ms 窗且
// 静默无 toast，正是 #544「联系人消息被吞了几条」里 dedupExempt 救不全的另一半（TA 连抽两张
// 同卡、提醒功能同句再提醒、同款表情真想发两次…全被吞）。观感「同款两张」改在取卡源头重掷
//（#814c genOneReply），绝不再吃掉已生成消息。发件侧 800ms 机械双派发守卫（#401/#437/#359
// 实测 150~606ms 双派发）原样保留（含 toast）。零机型分支。
for (let i = len - 1; i >= Math.max(0, len - 5) && !rec.dedupExempt && (rec.side || '') === 'out'; i--) {
const p = msgs[i];
if (!p || p.special || rec.special) continue;
if ((p.side || '') !== (rec.side || '')) continue;
if (!!p.img !== !!rec.img) continue;
if (!mediaTxtEq(p.text, rec.text)) continue;
const dts = (rec.ts || 0) - (p.ts || 0);
if (dts >= 0 && dts <= dupGapMs(rec)) {
chatMsgCutMark('g814out', rec); // #814d：发件侧 800ms 短闩命中留痕（正常只应见机械双击；频出＝发守卫层有回归）
saveMsgs();
// FIX 2026-09-14 #437：发件侧命中去重给反馈不再静默——#401 家族教训「守卫放行、去重吞掉、
// 音效照放、气泡 0 条＝用户以为发送坏了」。收件侧（TA 自动回复批）与静默补投递照旧无声。
try { if ((rec.side || '') === 'out' && !rec.silent && typeof toast === 'function') toast('同样的内容刚发送过，未重复发送'); } catch (e) {}
return null;
}
}
msgs.push(rec);
// #1341 限流的两处记账（都只在「真落进 msgs」这一刻做，被上面任一去重闸退回时都不做）：
// ① 你自己发出一条＝给用户说话那一刻盖章（out 侧所有入口都收在这里：文字/表情/字卡/语音/拍一拍）；
// ② 这一发是靠保底落地的＝把这份窗口（同一次 rlUserSpokeAt）的保底用掉，每发用户消息至多一次。
if ((rec.side || '') === 'out') rlUserSpokeAt = Date.now();
if (rec.rlReserveUsed) rlReserveFor = rlUserSpokeAt;
// FIX 2026-09-16 #571 实测回复延迟遥测：只记「我方发送触发的回复链」第一条收件卡落地耗时，
// 与 __rsDrawS（本次掷到的设定延迟）一并进诊断——实测≈设定＝回复速度就是设定值（非卡顿）；
// 实测明显大于设定＝回复链有额外等待，报障时按现场定位。零行为改动。
try {
if ((rec.side || '') === 'in' && !rec.special && window.__replyWaitT0) {
const __ms = Date.now() - window.__replyWaitT0;
window.__replyLatLog = window.__replyLatLog || [];
window.__replyLatLog.push(__ms);
if (window.__replyLatLog.length > 6) window.__replyLatLog.shift();
window.__replyWaitT0 = null;
}
} catch (eRL) {}
chatTailAppend(rec); // #180：同步尾巴日志先落 LS，再交低频整包落盘
// FIX 2026-09-18 #780：给消息打「首次投递」身份标（写在 chatTailAppend 之后 → 尾巴日志
// 与本条整包都带上，跨重载仍成立）——dAt＝投递到页面的时刻，dVis＝那一刻用户是否在场
// （页面可见且在聊天页/桌面横幅可显示）。治的形态：整页冻结后解冻，积压的回复链一口气
// 重投，而 bg-keep 的三道内容去重窗口（5min/2min/3min）起点全是 Date.now()，冻结一会儿
// 就全部过期 → 用户刚在聊天里看过的内容被当新消息连弹进通知栏（「切后台突然弹前几分钟
// 看过的消息」）。内容指纹这条路 v3.20.x 已证明是两难（加宽就误吞同文案的真消息），故
// 改按【消息身份】判：ts+side 命中且此前有一次在场投递 ⇒ 永不再发系统通知，与文案、与
// 隔多久都无关。只新增两个字段，不动 ts/side/text，渲染与落盘管线一字未改。
try {
rec.dAt = Date.now();
rec.dVis = (document.visibilityState === 'visible' && (chatVisible() || !!document.getElementById('desk-msg'))) ? 1 : 0;
} catch (eDM) {}
// 按身份回读本条此前的投递记录；同 200ms 内算同一次投递链（返回 null＝无先前投递），
// 供 bg-keep 的通知闸门与 tools/verify-bg-freeze.mjs 复用
window.__mochiMsgDelivered = function (ts, side) {
try {
const arr = msgs;
const now = Date.now();
for (let i = arr.length - 1, n = 0; i >= 0 && n < 200; i--, n++) {
const m = arr[i];
if (!m || !m.dAt) continue;
if ((m.ts || 0) !== (ts || 0) || (m.side || '') !== (side || '')) continue;
if (now - m.dAt < 200) return null;
return { at: m.dAt, vis: m.dVis ? 1 : 0, nAt: m.nAt || 0 };
}
} catch (eP) {}
return null;
};
// 按身份给本条打「已弹过系统通知」标（bg-keep 在受理成功后回写）——内容指纹的 2 分钟
// 已发窗口会被冻结时长熬过期，消息自身的身份标记不会：同一条再被任何机制投一次也弹不出第二遍
window.__mochiMsgNotified = function (ts, side) {
try {
const arr = msgs;
for (let i = arr.length - 1, n = 0; i >= 0 && n < 200; i--, n++) {
const m = arr[i];
if (!m || !m.dAt) continue;
if ((m.ts || 0) !== (ts || 0) || (m.side || '') !== (side || '')) continue;
m.nAt = Date.now();
return true;
}
} catch (eN) {}
return false;
};
saveMsgs();
// #1438：未落定的互动卡当场把待写整包 flush 掉（建卡与答卡同一持久性档位；为什么必须这样，
// 见上面 PENDING_CARD_STATUS_FIELD 那段注释——作者报的「没回答的卡刷新就没了」＝这条不对称）
try { if (isPendingCardRec(rec)) flushPersistNow(); } catch (ePC) {}
	// FIX 2026-09-27 #1347（OPPO 一加12 PJD110／Chrome 153 桌面 PWA 实报「主动发的消息在桌面消息
	// （软件内部的消息）弹出有问题，主动发的消息桌面的【聊天】角标会不显示数字」＋「这个问题其他
	// 设备型号也有出现，不要覆盖修改」）：下面这条「值得提醒」判据原来是【卡片类型名白名单】——
	// side in 且 special 属于那几个名字才弹横幅＋计未读。TA 定时主动发送那条链发的是纯文本／字卡
	// （无 special），命中名单，所以那一路一直好使；而聊天里真真切切多出来的卡片只要名字不在名单里
	// 就双双装死。无头逐项实测（纯 tip 副本、桌面页在屏上、逐条投递读 #chat-badge 与 #desk-msg）：
	// 查岗提问卡／提问提示行／问卷／三选一／自动红包／送花／小游戏结算 各＝角标 +0 且横幅不弹，
	// 同一场对照普通文本＝角标 +1 且横幅照弹——差异 100% 由 rec.special 这一个字符串决定，与机型／
	// UA／内核无关（＝「其他型号也有出现」的成因：不是某些设备坏了，是这些卡片形态在任何设备上都
	// 从没进过名单）。判据换成记录自身的两个事实：①「聊天列表因此多出一条 TA 的内容吗」＝side 是
	// in；②「它是不是纯状态回声」——已读回执不是内容，其余（含以后新增的任何卡片形态）一律算内容。
	// 类型名一个不看＝以后新增任何卡片形态自动被覆盖，不再往名单里补名字（#660 补 wish 那一类
	// 逐例打补丁，本批把这层名单整撤）。
	const notable = rec.side === 'in' && rec.special !== 'read';
	// v3.19.x：rec.silent（psync 跨桌面补投递）——消息进聊天+未读角标，但不触发
	// 桌面横幅/系统通知：补投递的是同步队列里其他时刻/其他桌面的旧内容，弹通知
	// 会形成"一堆看过的消息重叠弹窗 + 错误联系人名"
	if (notable && !rec.silent && (!chatVisible() || document.visibilityState === 'hidden')) {
	if (!chatVisible()) incChatUnread();
	showDeskMsg(rec);
	} else if (notable && rec.silent && !chatVisible()) {
	incChatUnread();
	}
// v3.26.x #211 聊天闪动修复：窗口超限判定从 RENDER_MAX 收紧到 WINDOW_MAX 硬上限
//（与 loadOlderIncremental→pruneWindowBottom 同一口径）。旧条件在每次钳位渲染后
//（renderStart=len−RENDER_MAX）只要再来一条消息就恒为真——历史超过 200 条的桌面
// 每收发一条消息都整窗重建 200 个气泡（img 节点全部重建重新解码＝肉眼可见闪一下，
// iQOO12 等多机型报障「打开聊天偶尔闪动+对方回复消息闪一下」；历史 ≤200 条的桌面
// renderStart=0 从不命中＝同版本却不闪，假象为机型相关）。收紧后常规收发全部走
// renderMsg 增量追加，仅当用户上翻加载旧消息使窗口真正越过 WINDOW_MAX(400) 时
// 才重钳位到最新 RENDER_MAX——与滚动加载侧的裁剪语义一致，DOM 上限不变。
if (renderStart > 0 && msgs.length - renderStart > WINDOW_MAX &&
(rec.side === 'out' || chatNearBottom())) {
// v3.27.x #846（红米 K80 Chrome 实报「消息发出去之后屏幕还会闪一下」，多机型同现）：这里原来
// 走 renderWindow 整窗重建＝屏上 400 个节点全删、同步重造最新 200 个气泡，img/头像全部重建
// 重新解码＝肉眼整屏闪一下（无头实证一次发送 rm=400/add=200 节点、scrollTop 26086→12686）。
// 历史 ≤400 条的桌面从不命中＝看着像"偶尔/机型相关"。钳位改裁视口外的顶部节点（DOM 上限照旧
// 是 RENDER_MAX），新消息与常规收发同样走下面 renderMsg 增量追加。
trimWindowTopQuiet(RENDER_MAX);
}
maybeInsertDivider(msgs.length - 1);
const el = renderMsg(rec);
if (renderEnd >= msgs.length - 1) renderEnd = msgs.length;
// v3.26.x #220：增量追加后屏上窗口已比整窗登记多出尾部消息——把登记条数对齐到
// 「新消息真实下标+1」（renderMsg 内按 msgs.length-1 落的 idx），让「聊过天→退出
// →重开」（重开路径不走 addRec）也能命中同窗补丁。批量渲染期（appendTarget 挂在
// frag 上、屏上尾节点还是旧消息）跳过——整窗渲染路径自带登记。
try {
if (!batchRendering && el) {
windowRenderedN = Number(el.dataset.idx) + 1;
windowStale = false;
chatWinKeysSync(); // #1010：增量追加到新尾，身份凭据同步（否则下次收尾判不出前缀）
}
} catch (e) {}
return el;
}
function addIn(text, opts) {
opts = opts || {};
  // #1015 夜间静默：音效在本函数开头就播、早于 addRec 的收件总闸，必须在最前面拦——
  // 否则夜里「响一声却没有消息」（收件被总闸拦掉、音效已经响了）。判据与总闸同源。
  if (nightBlocksIn(opts.initiative, opts.nightAllow)) return null;
  // #1180：音效在本函数里、addRec 之前播，所以限流闸必须与夜间闸一样在这儿再拦一次——
  // 否则超额的那条「响一声却没有消息」（addRec 里的兜底闸来得太晚）。判据同源。
  // #1341：判据改吃整份 opts（豁免位拆成夜间/限流两把钥匙后，rateAllow 才决定限流放不放行）
  if (rateBlocksIn({ side: 'in', special: opts.special, rateAllow: opts.rateAllow })) return null;
  // v3.26.x：联系人发消息音效——TA 主动消息/系统通知统一在 addIn 触发「联系人发送和回复消息」音效
  // （sfx-in）。此前只有群聊播 in 音效、单聊从未触发，所有手机单聊收 TA 消息都静音（红米 Turbo4Pro
  // + Via 反馈）。silent（小游戏互动/后台批量/静默通知）与已读回执（special:'read'）不打扰，不播放。
  // #1042：opts.sfx === true 单独放开音效闸门——silent 的既有语义是「免桌面横幅/系统通知」，
  // 但它顺手把音效一起摁掉了（#968 同族根因）。词典逐条连发每条气泡都是一条独立收件：免横幅不免音效。
  if (window.playSfx && (!opts.silent || opts.sfx === true) && opts.special !== 'read') {
    try { window.playSfx('in'); } catch (e) {}
  }
  // v3.14.x：opts.tag = 来源标注（如「经期关心/喝水提醒/吃饭提醒」）——系统功能直接发进
  // 聊天的字卡带一枚标签 chip（复用 rec.mood 渲染与持久化链路，重进聊天仍在），
  // 用户能看出这条消息是哪个功能触发的，不再是无来由的普通气泡
  // v3.15.x：opts.tagNoDup = 只留来源 chip，不把正文重复写进 mood label（摸鱼抓包回应用：
  // 正文本身就是一张完整字卡，label 再渲染一遍会上下两行内容重复）
  const _tagMood = opts.tag ? [{ tag: String(opts.tag), label: opts.tagNoDup ? '' : String(text) }] : null;
  // v3.43.x #677 来源 chip 共存：opts.tagExtra = 附加来源 chip 数组（[{tag,label}]），与 opts.tag 并列
  // 追加、互不替换——同一回复同时命中「多字卡回复」与「词典/词典拼字」时两枚 tag 都要显示（词典 tag
  // 仍由调用方按各自口径走 opts.tag 传入，本参数只补挂，不影响 tagNoDup 与 opts.mood 的优先级）
  const _tagExtra = Array.isArray(opts.tagExtra) ? opts.tagExtra.filter(md => md && String(md.tag || '').trim()).map(md => ({ tag: String(md.tag), label: md.label == null ? '' : String(md.label) })) : null;
  const _tagMerged = (_tagExtra && _tagExtra.length) ? (_tagMood ? _tagMood.concat(_tagExtra) : _tagExtra) : _tagMood;
  // v3.16.x：gInv = 联系人主动邀请的游戏类型（pong/snake/rps），随消息持久化供小游戏记录识别
	return addRec({ side: 'in', text: text, initiative: opts.initiative, special: opts.special, rateAllow: opts.rateAllow, game: opts.game, quote: opts.quote, qidx: opts.qidx, type: opts.type, img: opts.img, parts: opts.parts, mailNotice: opts.mailNotice, gInv: opts.gInv, silent: opts.silent, nightAllow: opts.nightAllow, askQuestion: opts.askQuestion, askStatus: opts.askStatus, askOptions: opts.askOptions, askType: opts.askType, choiceQuestion: opts.choiceQuestion, choiceOptions: opts.choiceOptions, choicePref: opts.choicePref, choiceCat: opts.choiceCat, choiceStatus: opts.choiceStatus, choiceAnswer: opts.choiceAnswer, choiceReply: opts.choiceReply, choiceMatch: opts.choiceMatch, curiousQuestion: opts.curiousQuestion, curiousQuick: opts.curiousQuick, curiousReplies: opts.curiousReplies, curiousFollowup: opts.curiousFollowup, curiousQid: opts.curiousQid, curiousCat: opts.curiousCat, curiousStatus: opts.curiousStatus, curiousAnswer: opts.curiousAnswer, curiousReply: opts.curiousReply, roastText: opts.roastText, roastCat: opts.roastCat, roastStatus: opts.roastStatus, roastAnswer: opts.roastAnswer, roastReply: opts.roastReply, rpAmount: opts.rpAmount, rpWish: opts.rpWish, rpStatus: opts.rpStatus, rpTs: opts.rpTs, rpCover: opts.rpCover, askFen: opts.askFen, askTs: opts.askTs, deskCk: opts.deskCk, deskCkDir: opts.deskCkDir, surveyTs: opts.surveyTs, surveyQs: opts.surveyQs, surveyStatus: opts.surveyStatus, surveyAnswers: opts.surveyAnswers, dedupExempt: opts.dedupExempt, nickKeep: opts.nickKeep, mood: opts.mood || _tagMerged || undefined });
}
// v3.27.x：对话型回复补「正在输入」过渡——TA 回应先 showTyping 再落地，消除气泡凭空冒出的突兀感。
// items 可为单条文本或数组（数组=逐条连发，条与条之间再出一次 typing）。仅当前桌面生效：期间切走
// （activeCid 变化）则 hideTyping 并放弃，不补投递（跨桌面链路由调用方自己的 chatDeskCardReply 处理）。
// 系统通知/poke/已读回执等非对话消息不要走此助手，维持原 setTimeout 直发。
function addInTyped(items, opts, firstDelay) {
	try {
		const myCid = window.__activeCid || 'default';
		const same = () => (window.__activeCid || 'default') === myCid;
		const arr = Array.isArray(items) ? items.filter(function (s) { return typeof s === 'string' && s; }) : [items];
		if (!arr.length) return;
		let i = 0;
		const step = () => {
			if (!same()) { hideTyping(); return; }
			showTyping();
			setTimeout(() => {
				if (!same()) { hideTyping(); return; }
				hideTyping();
				addIn(arr[i], opts);
				i++;
				if (i < arr.length) setTimeout(step, 400);
			}, Math.max(400, i === 0 ? (firstDelay || randInt(800, 1400)) : randInt(700, 1300)));
		};
		step();
	} catch (e) {}
}
// FIX 2026-09-15 #514：把真实「连发多条」链路（showTyping → hideTyping+addIn → 400ms → 下一条）
// 暴露给回归脚本（同 window.chatAddIn / window.__lsMergeSig 口径）——tools/verify-chat-multi-scroll.mjs
// 直接驱动产品函数断言「连发期间 chat-body 不出现逐帧回退/跳变」，而不是复刻一遍实现（复刻＝测不到真身）
window.chatAddInTyped = function (items, opts, firstDelay) { return addInTyped(items, opts, firstDelay); };
function addOut(text) {
// #1015：你自己发消息＝这条对话是活的——置 3 分钟对话窗口，窗口内 TA 在这条对话里的追加动作
//（如【TA的心情】分享卡）照常落地（被动回复本身不带 initiative，不看本窗）。
nightOpenReply();
return addRec({ side: 'out', text: text });
}
// FIX 2026-09-18 #775d：聊天页不可见时（在「聊天设置」里改名后点返回＝cs-back 只把
// page-chat 的 hidden 翻回 false，**不走 enterChat**，也就没有任何重渲时机）不整窗重建
//（隐藏期重建既把 scrollTop 归零、又白画 200 个气泡），只把带昵称的系统消息原位换成新名
// 节点，其余气泡零改动；原位守卫不过（窗口被裁/位移）就放弃，靠 #775b 的昵称签名让下次
// 进聊天页走整窗重建——两条路合起来保证「回到聊天看到的就是新昵称」。
function refreshNickNodesInPlace() {
try {
const idxs = [];
const from = Math.max(0, renderStart);
for (let i = from; i < msgs.length && i < renderEnd; i++) {
if (msgs[i] && !msgs[i].nickKeep && sysNickSweepable(msgs[i])) idxs.push(i);
}
if (!idxs.length) return;
patchChangedInPlace(idxs, from);
} catch (e) {}
}
// v3.25.x：改名钩子（chat-settings 联系人昵称 / contacts 联系人改名同步 lbl-partner）。
// 记录 hist 并立即清扫当前桌面内存 msgs + 重渲染聊天窗；非当前桌面由 contacts 只记
// hist（chatSysNickChanged 不感知），等该桌面下次 loadMsgs 惰性补扫。
// FIX 2026-09-18 #775c：加 slot 形参（'ta' 默认＝联系人，'me'＝我的昵称），两套 hist/swept
// 各走各的；#775b：聊天页当前不可见时不再只是「等下次重进」——除整窗重渲外还作废同窗补丁
// 凭据（windowRenderedNicks 随渲染更新），下次进聊天必然按新昵称重画。
window.chatSysNickChanged = function (oldName, slot) {
try {
if (typeof oldName !== 'string' || !oldName) return;
const S = sysNickSlot(slot);
const cur = S.cur();
const hist = sysNickHistGet(store, slot);
if (hist.indexOf(oldName) < 0) hist.push(oldName);
if (hist.indexOf(cur) < 0) hist.push(cur);
store.set(S.histKey, JSON.stringify(hist));
if (oldName === cur) { store.set(S.sweptKey, String(hist.length)); return; }
// 权威未就绪（开屏极早期）：只记 hist 不动 msgs、不推进 swept——否则清扫后的文本
// 与 IDB 权威里的原文本签名不同，finalize 合并会当成两条重复记录；交给补扫。
if (!chatDbReady) return;
store.set(S.sweptKey, String(hist.length));
// 改名后无论清扫是否有改动都要重渲染：系统消息显示走占位符→当前名替换，有改动时旧名
// 已换成占位符、无改动（连续改名）时旧渲染缓存的名字已过期——不重渲染 DOM 会停留在旧名
if (sysNickSweepMsgs(msgs, oldName, slot)) saveMsgs();
try { chatTailSweepNick(oldName, slot); } catch (e) {} // FIX 2026-09-16 #626 尾巴日志同步清扫（防 chatTailMerge 用旧名原文补回一条重复）
try { if (chatVisible()) renderWindow(true); else refreshNickNodesInPlace(); } catch (e) {}
// FIX 2026-09-18 #775i：改名基线换成「屏上实际显示名」（可能是联系人名片名）后，早期历史里
// 写死的字面默认称呼「TA」就没人扫了（旧实现基线恰好是 'TA'，顺带扫成 {ta}）。该默认词记在
// 槽表 legacy 上，没进过 hist 时按**同一条钩子**补扫一遍（记账/清扫/尾巴/重渲染不复制第二套）；
// me 槽无 legacy——'我'/'你' 是人称代词，见 sysNickSweepSkip。
if (S.legacy && oldName !== S.legacy && hist.indexOf(S.legacy) < 0) window.chatSysNickChanged(S.legacy, slot);
} catch (e) {}
};
window.chatAddSystem = function (text, opts) {
opts = opts || {};
// #673：silent 透传——此前本函数只挑白名单字段转发，调用方传的 { silent: true } 被就地吞掉：
// 凡是想「进聊天但不响消息提示音」的系统台词（音乐互动等）都照样响铃。chatAddIn 是一路
// 透传 opts 的，所以同款写法在那边有效、在这边无声失效（本批实测：音乐互动传了 silent，
// 播放时仍响 3 次提示音）。既无调用方依赖「silent 被忽略」，补上即恢复 silent 的既定语义。
// #616：nickKeep 透传（见 sysNickSweepable——昵称池的「换成了「XXX」」是事件记录，豁免改名清扫）
// #1015：nightAllow 透传——夜间收件总闸在 addRec/addIn，用户当刻操作引发的系统记录（存钱罐、
// 音乐互动等）经此处放行；不透传则调用方写的豁免标记会被本函数的白名单就地吞掉。
opts.nightAllow = opts.nightAllow === true;
	opts.rateAllow = opts.rateAllow === true; // #1341：限流的豁免位同要经本白名单透传
return addIn(text, { special: opts.special || 'poke', silent: opts.silent, nightAllow: opts.nightAllow, rateAllow: opts.rateAllow, img: opts.img, mailNotice: opts.mailNotice, nickKeep: opts.nickKeep, game: opts.game, askQuestion: opts.askQuestion, askStatus: opts.askStatus, askOptions: opts.askOptions, askType: opts.askType, askTs: opts.askTs, choiceQuestion: opts.choiceQuestion, choiceOptions: opts.choiceOptions, choicePref: opts.choicePref, choiceCat: opts.choiceCat, choiceStatus: opts.choiceStatus, choiceAnswer: opts.choiceAnswer, choiceReply: opts.choiceReply, choiceMatch: opts.choiceMatch, curiousQuestion: opts.curiousQuestion, curiousQuick: opts.curiousQuick, curiousReplies: opts.curiousReplies, curiousFollowup: opts.curiousFollowup, curiousQid: opts.curiousQid, curiousCat: opts.curiousCat, curiousStatus: opts.curiousStatus, curiousAnswer: opts.curiousAnswer, curiousReply: opts.curiousReply, roastText: opts.roastText, roastCat: opts.roastCat, roastStatus: opts.roastStatus, roastAnswer: opts.roastAnswer, roastReply: opts.roastReply, rpAmount: opts.rpAmount, rpWish: opts.rpWish, rpStatus: opts.rpStatus, rpTs: opts.rpTs, rpCover: opts.rpCover, askFen: opts.askFen, askTs: opts.askTs, deskCk: opts.deskCk, deskCkDir: opts.deskCkDir, surveyTs: opts.surveyTs, surveyQs: opts.surveyQs, surveyStatus: opts.surveyStatus, surveyAnswers: opts.surveyAnswers });
};
window.chatAddIn = function (text, opts) {
// FIX 2026-09-15 #492：opts.follow = 用户主动通道（帮我决定/多人决定结果发到聊天）——落聊天
// 后按 out 侧同权跟底（见 maybeScrollChatBottom 的 chatUserFollowScroll），仅显式传入生效，
// TA 自发消息不受影响
if (opts && opts.follow) chatUserFollowScroll = true;
const r = addIn(text, opts);
if (opts && opts.enter && !chatVisible()) enterChat();
return r;
};
window.chatAddGift = function (rec) { if (!rec.ts) rec.ts = Date.now(); return addRec(rec); };
// ===== #985 礼物卡的【领取】与【追加回复】（用户 2026-09-21 直派）=====
// 三条口径：
// ①「联系人送我礼物」的卡片可点击领取——未点＝待领取（卡片与心意柜都标出来）；礼物本身早已
//   进心意柜，没点也不会丢（用户选定「数据不丢＋状态仪式」，与红包那种硬闸门不同）。
// ②卡片上可追加回复：这条回复同时 ①发进聊天消息 ②贴在这张礼物卡上 ③写进心意柜那件礼物。
// ③联系人收礼后的自动回话（gift-shop #848）同样贴到「我送出」那张卡与心意柜上。
// 领取态与追加回复的唯一来源＝心意柜那件记录（卡片只带 giftBoxId 指针，见 gift-shop.js 的
// giftGiftMeta 注释：聊天大包对「改已有记录的字段」表达不出增量，写回聊天记录会被基线合并盖回去
// ——实测连回两条后只剩后一条）。存量记录没有 giftBoxId（旧版自动收下的礼物）＝不出动作区。
function giftMetaOf(rec) {
  if (!rec || !rec.giftBoxId || !window.giftGiftMeta) return null;
  try { return window.giftGiftMeta(rec.giftBoxId); } catch (e) { return null; }
}
function giftReplList(rec) {
  const m = giftMetaOf(rec);
  if (!m || !Array.isArray(m.replies)) return [];
  return m.replies.filter(function (r) { return r && typeof r.text === 'string' && r.text; });
}
function giftWhoLabel(who) { return who === 'me' ? '我' : chatPartnerName(); }
function giftReplRows(rec) {
  return giftReplList(rec).map(function (r) {
    return '<div class="mg-repl-row"><span class="mg-repl-who">' + escTxt(giftWhoLabel(r.who)) + '</span><span class="mg-repl-tx">' + escTxt(r.text) + '</span></div>';
  }).join('');
}
// 只有「真·联系人送我的礼物」有动作区：TA 自己买的礼物（giftSelf）不是送我，不收也不回；
// 没有心意柜指针（存量卡）也没有可写的地方，同样不给动作区
function giftIsIncoming(rec) { return !!(rec && rec.side === 'in' && !rec.giftSelf && rec.giftBoxId); }
function giftCardActsInner(rec) {
  if (!giftIsIncoming(rec)) return '';
  const meta = giftMetaOf(rec);
  // #985 审查补：心意柜那件记录读不到（导入后的残卡、被清理、或别的桌面还没回填）＝没有可写的地方，
  // 整块动作区都不给——否则会留下一个「点了回复、回复却无处存」的死按钮（用户视角＝回复发出去就没了）
  if (!meta) return '';
  const claim = meta.claimed === 0
    ? '<button class="msg-gift-claim" type="button">领取</button>'
    : (meta.claimed === 1 ? '<span class="msg-gift-got">\u2713 已领取</span>' : '');
  return claim + '<button class="msg-gift-reply" type="button">回复</button>';
}
function giftCardActsHtml(rec) { return giftIsIncoming(rec) ? '<div class="msg-gift-acts">' + giftCardActsInner(rec) + '</div>' : ''; }
function giftCardReplHtml(rec) {
  return '<div class="msg-gift-repl"' + (giftReplList(rec).length ? '' : ' hidden') + '>' + giftReplRows(rec) + '</div>';
}
// 卡片就地打补丁（不整窗重建，同红包 #230/#517 口径）：只换动作区与回复区两个子块，其余节点零触碰
function giftPatchCard(idx) {
  const rec = msgs[idx];
  if (!rec || rec.special !== 'gift' || !body) return false;
  const el = body.querySelector('.msg-gift[data-idx="' + idx + '"]');
  if (!el) return false;
  const card = el.querySelector('.msg-gift-card');
  if (!card) return false;
  const anchorOf = function () { return card.querySelector('.msg-fav-heart'); };
  const acts = card.querySelector('.msg-gift-acts');
  const wantsActs = giftCardActsHtml(rec);
  if (acts) {
    if (wantsActs) acts.innerHTML = giftCardActsInner(rec);
    else acts.remove();
  } else if (wantsActs) {
    const an = anchorOf();
    if (an) an.insertAdjacentHTML('beforebegin', wantsActs); else card.insertAdjacentHTML('beforeend', wantsActs);
  }
  const repl = card.querySelector('.msg-gift-repl');
  if (repl) { repl.innerHTML = giftReplRows(rec); repl.hidden = !giftReplList(rec).length; }
  else if (giftReplList(rec).length) {
    // 插入位必须与渲染分支同序（回复区 → 动作区 → 心形）：锚定动作区，没有才回落到心形
    const an2 = card.querySelector('.msg-gift-acts') || anchorOf();
    if (an2) an2.insertAdjacentHTML('beforebegin', giftCardReplHtml(rec)); else card.insertAdjacentHTML('beforeend', giftCardReplHtml(rec));
  }
  return true;
}
function giftClaimNow(idx) {
  const rec = msgs[idx];
  if (!giftIsIncoming(rec)) return false;
  const meta = giftMetaOf(rec) || {};
  if (meta.claimed === 1) return true;
  // 领取态只写心意柜那件（同步落盘，可靠）；卡片按同一份数据重画
  if (!window.giftBoxMarkClaimed) return false;
  try { window.giftBoxMarkClaimed(rec.giftBoxId); } catch (e) { return false; }
  try { if (window.giftBoxLiveRefresh) window.giftBoxLiveRefresh(); } catch (e) {}
  giftPatchCard(idx);
  // 聊天留痕（与 #517 同一口径：反馈落在卡片状态与留痕上，不弹黑色浮层）
  try { addIn('你收下了 ' + (rec.giftName || '礼物'), { special: 'poke' }); } catch (e2) {}
  return true;
}
function giftReplyNow(idx) {
  const rec = msgs[idx];
  if (!giftIsIncoming(rec)) return false;
  if (!window.openModal) return false;
  // #1029（用户 2026-09-22 实报，原话「里面的内容错了啊，里面本来就是联系人的文案，为什么我要
  // 用联系人的文案」）：回复框**不再预填送礼人的文案**——追加回复必须是我自己写的那一句。旧口径
  // （#985③ 的「预填原文→删掉它／留着它接在后面」）把**对方的话**塞进我的输入框，用户视角＝
  // 「要我拿 TA 那句当我的回复」，已当场否掉，勿回退。
  // 礼物原本的文案改为在输入框上方**只读展示**（#985③「原本礼物的文案就显示」照旧成立，卡片上
  // 本来就一直显示着）；聊天里只发我新写的这句，卡片上「原本文案 ＋ 我的回复」两处都在。
  const orig = String(rec.giftWish || '').trim();
  window.openModal('回复 ' + chatPartnerName(), '', function (v) {
    const text = String(v == null ? '' : v).trim();
    if (!text) return;   // 没写＝这次不追加任何内容，不产生空回复
    addOut(text);                                  // ① 只把我写的这句发进聊天消息
    // ② 写进心意柜那件礼物（唯一存处，同步可靠）→ 卡片按同一份数据重画，原文与回复并排显示
    try { if (rec.giftBoxId && window.giftBoxAttachReply) window.giftBoxAttachReply(rec.giftBoxId, 'me', text); } catch (e) {}
    giftPatchCard(idx);
    try { if (window.giftBoxLiveRefresh) window.giftBoxLiveRefresh(); } catch (e) {}
  }, { placeholder: '写一句你的回复', staticText: '这件礼物原本的文案：「' + (orig || '心意') + '」——这句是送礼人写的，卡片上会一直显示。\n在下面写你自己的一句就好：聊天里只发你这句，卡片上「原本文案 ＋ 你的回复」两处都在。' });
  return true;
}
// #1530：心意柜详情里的【领取】落柜后由 gift-shop 调回——按心意柜指针把屏上同一件的聊天卡走
// giftPatchCard 就地重画（领取态读柜记录＝单一事实源，这里不写任何状态），并补一条与卡上领取
// 同款的聊天留痕「你收下了 …」。聊天卡可能已不存在（被删／清空／丢指针）＝只留痕，柜子照常领取。
// rateAllow 同 #1341 口径：这是用户当刻操作引发的记录，额度满也不许吞。
window.chatGiftClaimSync = function (boxId, giftName) {
  if (!boxId) return false;
  let rec = null;
  try {
    if (body) for (let i = 0; i < msgs.length; i++) {
      const r = msgs[i];
      if (r && r.special === 'gift' && r.giftBoxId === boxId) { giftPatchCard(i); if (!rec) rec = r; }
    }
  } catch (e) {}
  try { addIn('你收下了 ' + ((rec && rec.giftName) || giftName || '礼物'), { special: 'poke', rateAllow: true }); } catch (e2) {}
  return true;
};
// #985：给 gift-shop 的 TA 回话贴卡用（回话只写那件礼物的心意柜记录＝卡片渲染的数据源）。
// 延迟窗（0.9~2.4s）里用户可能已切桌面——跨桌面先在那张卡上认出心意柜指针（chatDeskCardReply
// 的读改写含 #127 增量日志合并与 #90 空库守卫），再按 cid 写那个桌面的心意柜。
window.chatGiftAttachReplyTo = function (cid, giftTs, who, text, recRef) {
  try {
    if (!giftTs || !text) return false;
    const whoNorm = who === 'me' ? 'me' : 'ta';
    if ((window.__activeCid || 'default') === cid) {
      let rec = null, idx = -1;
      if (recRef && msgs.indexOf(recRef) >= 0) { rec = recRef; idx = msgs.indexOf(recRef); }
      if (!rec) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const r = msgs[i];
          if (r && r.special === 'gift' && r.ts === giftTs) { rec = r; idx = i; break; }
        }
      }
      if (!rec) return false;
      if (!rec.giftBoxId) return false;   // 存量卡没有心意柜指针＝没有可写的地方（不出动作区，同渲染口径）
      if (window.giftBoxAttachReply) window.giftBoxAttachReply(rec.giftBoxId, whoNorm, text, cid);
      giftPatchCard(idx);
      return true;
    }
    if (!window.chatDeskCardReply) return false;
    // 跨桌面：先在那张卡上认出它的心意柜指针，再写那个桌面的心意柜（giftBoxAttachReply 按 cid 写回）
    window.chatDeskCardReply(cid, 'gift', giftTs, '', function (hit) {
      if (hit && hit.giftBoxId && window.giftBoxAttachReply) window.giftBoxAttachReply(hit.giftBoxId, whoNorm, text, cid);
    }, null, null);
    return true;
  } catch (e) { return false; }
};
// v3.14.x：跨桌面安全追加一条系统消息到指定联系人的聊天记录——
// call.js notifyCallEnd / feed.js notifyFeedPostToChat / mail.js notifyMailToChat 共用。
// 旧实现各自「idbGet → push → idbSet 整包写回」，idbGet 超时兜底返回 undefined 时
// 会把该桌面全部历史覆盖成 [这一条]（与 loadMsgs 同款破坏面）。这里统一：
// ① 当前桌面走内存链路（实时渲染/未读角标/防抖统一落盘）；
// ② 非当前桌面先读后写，读到的 undefined 先用 idbGetAllKeys 复核是「确认无历史」
//    还是「这次读取失败」——失败则 1.5s 后重试（最多 3 次），仍失败放弃写入：
//    宁可丢一条系统提示，绝不冒覆盖整个聊天记录的风险。
// FIX 2026-09-12 #358 跨桌面投递「确认空库」账本矛盾守卫（两条 append 路径共用）：
// idbHasKey/idbGetAllKeys 在冷启动早期窗口会对已存在的键谎报「不存在」（TASKS #133），
// 此刻 writeArr([一条]) 会把该联系人全部历史覆盖成一条＝「翻旧记录丢了一大半，媒体型
// 字卡还被 #206 日志拒收回放，最后只剩互动卡片」（摩托罗拉 G100 Edge 等多机型报障）。
// 探测说空库、而条数账本小键 <prefix>:chat-meta（几百字节，大键读失败时它几乎不会读失败）
// 说有历史＝探测在说谎：按读取失败重试，绝不覆盖。账本也确认没有（真无历史）才放行写入。
function deskAppendMissGuard(cid, tries, onRetry, writeOne, onExhaust) {
  const ledKey = 'xy-home-v2:' + cid + ':chat-meta';
  window.idbGet(ledKey).then(function (lv) {
    let ledN = 0;
    try {
      const o = typeof lv === 'string' ? JSON.parse(lv) : lv;
      if (o && typeof o.n === 'number') ledN = o.n;
    } catch (e) {}
    try { ledN = Math.max(ledN, chatLedger['xy-home-v2:' + cid] || 0); } catch (e) {}
    // #1200：耗尽＝既不能写整包（#358 防覆盖）也等不到键出现，旧实现静默丢＝弹窗已发、聊天永无此卡；转中转箱兜底
    if (ledN > 0) { if (tries < 5) setTimeout(onRetry, 2000); else if (onExhaust) onExhaust(); return; }
    writeOne();
  }).catch(function () { if (tries < 3) setTimeout(onRetry, 1500); else if (onExhaust) onExhaust(); });
}
// FIX 2026-09-29 #1443a：跨桌面整包写回必须认 IndexedDB 的回执。idbSet 是会 resolve(false) 的
//   （事务 onabort/onerror/超时——页面被冻结或被系统回收时最容易中止），而旧写法三处 writeArr
//   全是「发完不管」，于是通知已经弹出去、那张卡一个字都没存住：iPhone 12 Pro／iOS 17.1.1 实报
//   「后台通知写着 某角色查岗：刚才有没有感觉到我？点进去所有角色页面都没有这条消息（以前都是有
//   记录的）」，同屏诊断单两条读数正是这一发的现场——LS 整域写恒抛（writeArr 里那发 localStorage
//   兜底同样落不进去）、本页被系统回收 26 次。判据只取「库回没回话」这一个内核事实，零机型／零 UA。
//   onFail 由调用方定：追加类交既有 #1200 中转箱（进该桌面聊天时 chatDeskInboxMerge 按身份去重回流，
//   回执迟到造成重复也不会落两条）；就地改写类重跑一次「读-改-写」，不凭空补气泡。
// 追加类未提交的兜底动作＝把「这一发」交中转箱（不是整包），两条跨桌面追加路径共用这一句，
// 也顺便让回归针有一处唯一落点（两处调用原文同形＝钉成哑哨兵）
function deskAppendLastToInbox(cid, arr) {
if (!arr || !arr.length) return;
try { deskAppendInbox(cid, [arr[arr.length - 1]]); } catch (e) {}
}
function deskWriteAck(key, val, onFail) {
let p = null;
try { p = window.idbSet(key, val); } catch (e) { p = null; }
const fail = function () { try { if (onFail) onFail(); } catch (e2) {} };
if (!p || !p.then) { fail(); return false; }
p.then(function (ok) { if (!ok) fail(); }, fail);
return true;
}
const CHAT_DESK_INBOX_MAX = 200; // #1200：中转箱容量上限（异常堆积时保最近 200 条）
function deskAppendInbox(cid, recs) {
  const key = 'xy-home-v2:' + cid + ':chat-desk-inbox';
  let list = [];
  try { const raw = localStorage.getItem(key); if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) list = a; } } catch (e) {}
  const persist = function () {
    list = list.slice(-CHAT_DESK_INBOX_MAX);
    const s = JSON.stringify(list);
    try { window.idbSet(key, s); } catch (e) {}
    try { localStorage.setItem(key, s); } catch (e) {} // 小记录；IDB 读不到时排空侧回退 LS 副本
    if ((window.__activeCid || 'default') === cid && chatDbReady) { try { chatDeskInboxMerge('xy-home-v2:' + cid); } catch (e) {} } // #1200：写箱时该桌面已切回且权威就绪＝就地排空，不等下次进聊天
  };
  if (list.length || !window.idbGet) { list = list.concat(recs); persist(); return; }
  window.idbGet(key).then(function (v) {
    try {
      if (v !== undefined && v !== null) {
        const a = typeof v === 'string' ? JSON.parse(v) : v;
        if (Array.isArray(a) && a.length > list.length) list = a;
      }
    } catch (e) {}
    list = list.concat(recs);
    persist();
  }).catch(function () { list = list.concat(recs); persist(); });
}
function chatDeskInboxMerge(forPrefix) {
  try {
    const prefix = forPrefix || window.activePrefix();
    const key = prefix + ':chat-desk-inbox';
    let cand = [];
    try {
      const raw = localStorage.getItem(key);
      if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) cand = a; }
    } catch (e) {}
    const consume = function (arr) {
      cand = cand.concat(arr || []).filter(function (m) { return m && typeof m === 'object'; });
      const seenC = new Set();
      cand = cand.filter(function (m) { const s = chatTailId(m); if (seenC.has(s)) return false; seenC.add(s); return true; });
      const clearAll = function () {
        try { localStorage.removeItem(key); } catch (e) {}
        if (cand.length && window.idbDelete) { try { window.idbDelete(key); } catch (e) {} }
      };
      if (!cand.length) { clearAll(); return; }
      if (window.activePrefix() !== prefix || !chatDbReady || !Array.isArray(msgs)) return; // 条件未齐＝不清箱，下次权威加载再兜
      const haveId = new Set(msgs.map(chatTailId));
      const copies = new Set();
      msgs.forEach(function (m) { chatRecKeysAdd(copies, m); });
      const add = cand.filter(function (m) { return !haveId.has(chatTailId(m)) && !chatRecKeysHit(copies, m); });
      clearAll();
      if (!add.length) return;
      msgs = msgs.concat(add).sort(function (a, b) { return ((a && a.ts) || 0) - ((b && b.ts) || 0); });
      saveMsgs();
      try {
        if (chatVisible() && chatNearBottom()) {
          if (!inplacePatchIfSameWindow()) { renderWindow(false, true); scrollChatBottom(); }
        } else if (chatVisible()) windowStale = true;
      } catch (e) {}
    };
    if (!window.idbGet) { consume([]); return; }
    window.idbGet(key).then(function (v) {
      let a = [];
      try { if (v !== undefined && v !== null) { a = typeof v === 'string' ? JSON.parse(v) : v; } } catch (e) { a = []; }
      consume(Array.isArray(a) ? a : []);
    }).catch(function () { consume([]); });
  } catch (e) {}
}
// FIX 2026-09-30 #1441c：进场「要不要重读库」的第三条证据＝本文档之外的同源上下文写过这一桌的聊天。
// #1441a 把「在桌面待够 8 秒」从判据里摘掉以后，这一路不能靠时间冒充：localStorage 的 storage 事件只在
// **别的**同源文档里派发（写入方自己收不到），正是「外部落过笔」的直接读数——命中本命名空间的聊天键就
// 记一笔账，下一趟进场照旧真读、读完销账。零机型／零 UA 分支；不轮询、不新增定时器（#1318 口径），
// 只在浏览器已经推给我们的这一发事件上盖章。
let chatXtxWriteSeen = false;
window.addEventListener('storage', function (e) {
try {
const k = e && e.key ? String(e.key) : '';
const pre = window.activePrefix();
if (!k || !pre) return;
if (k === pre + ':chat-msgs' || k === pre + ':chat-desk-inbox' || k === pre + ':chat-tail' || k.indexOf('chat-blk') >= 0) chatXtxWriteSeen = true;
} catch (err) {}
});
window.chatXtxWriteSeenForDebug = function () { return chatXtxWriteSeen; }; // 只读：供 verify 脚本判「这一发证据有没有被消费掉」
window.chatAppendToDeskMsg = function (cid, text, opts) {
opts = opts || {};
const cur = window.__activeCid || 'default';
if (cid === cur) {
if (window.chatAddSystem) window.chatAddSystem(text, { special: opts.special, img: opts.img, mailNotice: opts.mailNotice });
return;
}
if (!window.idbGet || !window.idbSet) return;
const key = 'xy-home-v2:' + cid + ':chat-msgs';
let tries = 0;
const writeArr = function (arr) {
// #1443a：认库的回执——没提交就把这一发交 #1200 中转箱，进该桌面聊天时回流，不再静默丢
deskWriteAck(key, JSON.stringify(arr), function () { deskAppendLastToInbox(cid, arr); });
try { localStorage.setItem(key, JSON.stringify(arr)); } catch (e) {}
// v3.26.x #90：跨桌面追加后同步条数账本（下次冷启动大键读失败时它就是守卫依据）
try { chatLedgerSave('xy-home-v2:' + cid, arr.length, msgsBytes(arr)); } catch (e) {}
};
const mkRec = function () { return { side: 'in', special: opts.special || 'poke', text: text, ts: Date.now(), mailNotice: !!opts.mailNotice }; };
const attempt = function () {
tries++;
if (tries > 5) { deskAppendInbox(cid, [mkRec()]); return; } // #1200：重试预算耗尽改落中转箱，不再静默丢（弹窗已发＝消息必须可达）
window.idbGet(key).then(function (v) {
if (v !== undefined && v !== null) {
let arr = [];
let readOk = true;
try { arr = typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { arr = []; readOk = false; }
if (!Array.isArray(arr)) { arr = []; readOk = false; }
// v3.26.x #90：读到有值却解析失败＝库里有历史只是读不懂，写回 [这一条] 等于删光，绝不写
if (!readOk) return;
arr.push(mkRec());
writeArr(arr);
return;
}
// undefined：复核键是否真的不存在
// v3.26.x #90：改走严格三态探测 idbHasKey，只有确认「库里没有」(false) 才允许新建只含
// 一条的数组；true（读取失败）与 null（探测本身失败）都按未知处理，安排重试。
const confirmMiss = window.idbHasKey
? window.idbHasKey(key).then(function (has) { return has === false; })
: (window.idbGetAllKeys
? window.idbGetAllKeys().then(function (keys) {
return !(keys || []).some(function (k) { return k === key; });
}).catch(function () { return false; })
: Promise.resolve(true));
confirmMiss.then(function (isMiss) {
if (!isMiss) { if (tries < 3) setTimeout(attempt, 1500); return; }
// #1200：#722 分块联系人的整包键已删且读侧永不看它——旧实现重试 5 次后静默丢＝「弹窗提示有互动卡、点进聊天什么都没有」（分块阈值按数据量到，零机型分支）
window.idbGet('xy-home-v2:' + cid + ':chat-blk-idx').then(function (bv) {
if (bv !== undefined && bv !== null) { deskAppendInbox(cid, [mkRec()]); return; }
deskAppendMissGuard(cid, tries, attempt, function () { writeArr([mkRec()]); }, function () { deskAppendInbox(cid, [mkRec()]); });
}).catch(function () { deskAppendMissGuard(cid, tries, attempt, function () { writeArr([mkRec()]); }, function () { deskAppendInbox(cid, [mkRec()]); }); });
});
}).catch(function () { if (tries < 3) setTimeout(attempt, 1500); else deskAppendInbox(cid, [mkRec()]); }); // #1200：读键连续抛错＝整包面不可写，同落中转箱
};
attempt();
};
// v3.19.x：安全的「非当前桌面」追加任意 rec（含 ask-card 互动卡）。先读后写，读到
// undefined 时用 idbGetAllKeys 复核是「确认无历史」还是「读取失败」——失败则重试
//（最多 3 次），绝不冒覆盖整个聊天记录的风险（与 chatAppendToDeskMsg 同款安全逻辑）。
// 当前桌面直接走内存链路 addRec（实时渲染 + 统一落盘）。
window.chatAppendDeskRec = function (cid, rec) {
  const cur = window.__activeCid || 'default';
  rec = rec || {};
  if (!rec.ts) rec.ts = Date.now();
  if (cid === cur) return addRec(rec);
  if (!window.idbGet || !window.idbSet) return;
  const key = 'xy-home-v2:' + cid + ':chat-msgs';
  let tries = 0;
  const writeArr = function (arr) {
    // #1443a：认库的回执——没提交就把这一发交 #1200 中转箱，进该桌面聊天时回流，不再静默丢
    deskWriteAck(key, JSON.stringify(arr), function () { deskAppendLastToInbox(cid, arr); });
    try { localStorage.setItem(key, JSON.stringify(arr)); } catch (e) {}
    // v3.26.x #90：跨桌面追加后同步条数账本（下次冷启动大键读失败时它就是守卫依据）
    try { chatLedgerSave('xy-home-v2:' + cid, arr.length, msgsBytes(arr)); } catch (e) {}
  };
  const attempt = function () {
    tries++;
    if (tries > 5) { deskAppendInbox(cid, [rec]); return; } // #1200：重试预算耗尽改落中转箱，不再静默丢
    window.idbGet(key).then(function (v) {
      if (v !== undefined && v !== null) {
        let arr = [];
        let readOk = true;
        try { arr = typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { arr = []; readOk = false; }
        if (!Array.isArray(arr)) { arr = []; readOk = false; }
        // v3.26.x #90：读到有值却解析失败＝库里有历史只是读不懂，写回 [这一条] 等于删光，绝不写
        if (!readOk) return;
        arr.push(rec);
        writeArr(arr);
        return;
      }
      // v3.26.x #90：同 chatAppendToDeskMsg——改走严格三态探测 idbHasKey，只有确认库里
      // 没有（false）才新建只含一条的数组；true/null 一律按读取失败重试。后台通知回到
      // 浏览器瞬间 IDB 事务最容易未热，这条路径正是「记录自己消失」最像的触发点。
      const confirmMiss = window.idbHasKey
        ? window.idbHasKey(key).then(function (has) { return has === false; })
        : (window.idbGetAllKeys
          ? window.idbGetAllKeys().then(function (keys) {
              return !(keys || []).some(function (k) { return k === key; });
            }).catch(function () { return false; })
          : Promise.resolve(true));
      confirmMiss.then(function (isMiss) {
        if (!isMiss) { if (tries < 3) setTimeout(attempt, 1500); return; }
        // #1200：分块桌面（#722）没有整包键且读侧永远不看它＝整包读写必丢，检出分块索引即转中转箱
        window.idbGet('xy-home-v2:' + cid + ':chat-blk-idx').then(function (bv) {
          if (bv !== undefined && bv !== null) { deskAppendInbox(cid, [rec]); return; }
          deskAppendMissGuard(cid, tries, attempt, function () { writeArr([rec]); }, function () { deskAppendInbox(cid, [rec]); });
        }).catch(function () { deskAppendMissGuard(cid, tries, attempt, function () { writeArr([rec]); }, function () { deskAppendInbox(cid, [rec]); }); });
      });
    }).catch(function () { if (tries < 3) setTimeout(attempt, 1500); else deskAppendInbox(cid, [rec]); }); // #1200：读键连续抛错＝同落中转箱
  };
  attempt();
};
// v3.26.x #489：问问TA/邀请TA 发出后，TA 的回应落地时用户已切到别的桌面——旧实现
// sameCid() 直接 return＝回应被永久取消，切回后卡片永远停在「等待 TA 回答/回应…」
//（用户报障：文字题联系人已回答，切桌面再切回变未回复）。现按 ts 定位原桌面的
// pending 卡片落回答状态并补回应气泡（读改写骨架同 chatAppendDeskRec：读到 undefined
// 先 idbHasKey 复核、解析失败/读取失败绝不写回）。补投递落库瞬间用户已切回原桌面时
// 改走 onBack()（内存链路），两条路有且只有一条生效。
window.chatDeskCardReply = function (cid, cardSpecial, cardTs, statusKey, patch, bubbles, onBack) {
  if (cid === (window.__activeCid || 'default')) { if (onBack) onBack(); return; }
  if (!window.idbGet || !window.idbSet || !cardTs) return;
  const key = 'xy-home-v2:' + cid + ':chat-msgs';
  // FIX 2026-09-17 #127：增量日志键——卡可能只落在日志段里（异常退出后的桌面），
  // 读侧必须先合并再查找；写回的是合并全量，日志键随作废（防下次重复拼接）。
  const archKey = 'xy-home-v2:' + cid + ':chat-arch';
  let tries = 0;
  const writeArr = function (arr) {
    // #1443a：改写类认库的回执＝重跑一次「读-改-写」（库里那条卡没被改成就还是没改成，不凭空补气泡）
    deskWriteAck(key, JSON.stringify(arr), function () { if (tries < 3) setTimeout(attempt, 1500); });
    try { localStorage.setItem(key, JSON.stringify(arr)); } catch (e) {}
    try { if (window.idbDelete) window.idbDelete(archKey); } catch (e) {}
    // v3.26.x #90：跨桌面写回后同步条数账本（同 chatAppendDeskRec）
    try { chatLedgerSave('xy-home-v2:' + cid, arr.length, msgsBytes(arr)); } catch (e) {}
  };
  const attempt = function () {
    tries++;
    // 回到原桌面：放弃直写（内存链路接手），防双写/写错桌面
    if ((window.__activeCid || 'default') === cid) { if (onBack) onBack(); return; }
    const handleArr = function (arr) {
      let hit = null;
      for (let i = arr.length - 1; i >= 0; i--) {
        const r = arr[i];
        if (r && r.special === cardSpecial && r.ts === cardTs && !r.retracted) { hit = r; break; }
      }
      // 卡不在 / 已被回答过（幂等闸）＝无事可做，不凭空补气泡
      if (!hit || hit[statusKey] === 'answered') return;
      if (patch) patch(hit);
      (bubbles || []).forEach(function (b) { arr.push(Object.assign({ side: 'in', ts: Date.now() }, b)); });
      writeArr(arr);
    };
    const mergeArch = function (arr, av) {
      let arch = [];
      try { arch = typeof av === 'string' ? JSON.parse(av) : av; } catch (e) { arch = []; }
      if (Array.isArray(arch) && arch.length) {
        const seen = new Set();
        arr.forEach(function (m) { if (m) seen.add((m.ts || 0) + '|' + (m.side || '') + '|' + (m.special || '')); });
        arch.forEach(function (m) { if (m && !seen.has((m.ts || 0) + '|' + (m.side || '') + '|' + (m.special || ''))) arr.push(m); });
        arr.sort(function (a, b) { return (((a && a.ts) || 0) - ((b && b.ts) || 0)); });
      }
      handleArr(arr);
    };
    window.idbGet(key).then(function (v) {
      if (v !== undefined && v !== null) {
        let arr = [];
        let readOk = true;
        try { arr = typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { arr = []; readOk = false; }
        if (!Array.isArray(arr)) { arr = []; readOk = false; }
        // v3.26.x #90：读到有值却解析失败＝库里有历史只是读不懂，写回等于删光，绝不写
        if (!readOk) return;
        try { window.idbGet(archKey).then(function (av) { mergeArch(arr, av); }).catch(function () { handleArr(arr); }); }
        catch (e) { handleArr(arr); }
        return;
      }
      // undefined：确认真没历史＝卡片已随记录清空，无卡可答，放弃（不新建只含气泡的数组）
    }).catch(function () { if (tries < 3) setTimeout(attempt, 1500); });
  };
  attempt();
};
// v3.26.x #489：把一条提问记录补写进指定桌面的 invite-ask-history（小键尽力而为：
// LS 先读、空则 IDB 补读，写回 LS+IDB；失败静默——提问记录页少一条，不影响聊天）
window.chatDeskHistPush = function (cid, entry) {
  const key = 'xy-home-v2:' + cid + ':invite-ask-history';
  const write = function (list) {
    list.unshift(entry);
    if (list.length > 200) list.length = 200;
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) {}
    try { window.idbSet(key, JSON.stringify(list)); } catch (e) {}
  };
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null && raw !== undefined) { write(JSON.parse(raw) || []); return; }
  } catch (e) {}
  if (!window.idbGet) return;
  window.idbGet(key).then(function (v) {
    let list = [];
    try { list = (typeof v === 'string' ? JSON.parse(v) : v) || []; } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    write(list);
  }).catch(function () {});
};
// v3.19.x：把一张跨桌面查岗卡（带 deskCk + deskCkDir 双方向）写入指定联系人桌面聊天。
// 后台收到查岗通知切回浏览器后，到该联系人即可看到并回答（incoming-requests 后台分支调用）。
window.chatAppendDeskCkTo = function (cid, q) {
  const field = (window.buildDeskCkCard ? window.buildDeskCkCard(q) : null)
    || { deskCkDir: 'toMe', text: '在干嘛呢？想你了。', hint: 'TA 来查岗了。', opts: null, askType: 'text' };
  window.chatAppendDeskRec(cid, {
    side: 'in', special: 'ask-card', text: field.text,
    askQuestion: field.text, askOptions: field.opts, askType: field.askType,
    deskCk: true, deskCkDir: field.deskCkDir
  });
};
// v3.19.x：把一句「求聊天」开场白写入指定联系人桌面聊天（后台命中求聊天时调用）。
window.chatAppendDeskTextTo = function (cid, text) {
  window.chatAppendDeskRec(cid, { side: 'in', special: 'poke', text: text || '想你了，来聊聊天吧。' });
};
function saveMsgsNow() {
// v3.26.x #88：与 saveMsgs 同一条守卫。调用方都是作答/回应后触发，msgs 必非空，
// 所以 v3.14.x 的「只挡空数组」在这里等于没挡——未读到权威的窗口照旧整包覆盖全部历史。
const authOk = chatDbReady && authLoadedPrefix === window.activePrefix();
if (!authOk) {
try { pendingLocal = msgs.slice(); } catch (e) {}
if (msgs.length) mergeLsSnapshotWith(msgs, undefined); // #245：合并而非覆盖，保住 LS 里的历史快照
try { scheduleIdbRetry(); } catch (e) {}
return;
}
// v3.26.x 止血：合并到低频空闲落盘（不再立即同步写整包），离页 flushSave 兜底
const myPrefix = window.activePrefix();
schedulePersist(() => {
  if (authLoadedPrefix !== myPrefix) return;
  // v3.26.x #90：条数缩水守卫（同 saveMsgs）
  if (!chatLedgerGuard(myPrefix, msgs)) return;
  // FIX 2026-09-17 #127：能复用基准段就只写增量日志（否则整包重写，同旧行为）
  try { if (window.idbSet) persistChatHistory(myPrefix, msgs); } catch (e) {}
  writeLsSnapshot(msgs, myPrefix, true);
});
}
window.chatChooseReply = function (msgIdx, answer, opt, match) {
const rec = msgs[msgIdx];
if (!rec || rec.special !== 'ask-choose' || rec.choiceStatus === 'answered') return;
const ownReplies = (function () {
if (!opt) return [];
if (Array.isArray(opt.reply) && opt.reply.length) return opt.reply.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
if (typeof opt.reply === 'string' && opt.reply.trim()) return [opt.reply.trim()];
return [];
})();
const pool = ownReplies.filter(c => !(window.isDefaultCardOff && window.isDefaultCardOff('interact', c)));
const liked = !!(opt && (opt.liked === true || opt.liked === 'true'));
const matched = typeof match === 'string' && match.indexOf('刚好想到在了一起') >= 0;
let reply;
if (matched || liked) {
reply = pool.length ? pool[Math.floor(Math.random() * pool.length)] : (window.pickAskCardReply ? window.pickAskCardReply() : '');
} else {
const preset = pool.length ? pool[Math.floor(Math.random() * pool.length)] : '';
reply = preset ? (window.pickAskCardReply ? window.pickAskCardReply([preset]) : preset) : (window.pickAskCardReply ? window.pickAskCardReply() : '');
}
rec.choiceStatus = 'answered';
rec.choiceAnswer = answer;
rec.choiceReply = reply;
if (match) rec.choiceMatch = match;
saveMsgs();
saveMsgsNow();
addOut(answer);
addInTyped(reply || '…');
taFavCard(rec);
const el = body.querySelector('.msg-ask[data-idx="' + msgIdx + '"]');
if (el) {
el.innerHTML = '<div class="msg-choose-card answered"><div class="msg-ask-q">' + escTxt(rec.choiceQuestion || rec.text || '') + '</div><div class="msg-ask-a">✓ 你选择了：' + escTxt(answer) + '</div><div class="msg-choose-r">' + (window.taFit ? window.taFit('TA：') : 'TA：') + escTxt(window.taFit ? window.taFit(askCardReplyClean(reply) || '…') : (askCardReplyClean(reply) || '…')) + '</div>' + favHeartHtml(rec) + '</div>';
}
};
window.chatCuriousReply = function (msgIdx, answer, reply, followup) {
const rec = msgs[msgIdx];
if (!rec || rec.special !== 'ask-curious' || rec.curiousStatus === 'answered') return;
rec.curiousStatus = 'answered';
rec.curiousAnswer = answer;
rec.curiousReply = reply || '…';
saveMsgs();
saveMsgsNow();
addOut(answer);
addInTyped(followup ? [reply || '…', followup] : (reply || '…'));
taFavCard(rec);
const el = body.querySelector('.msg-ask[data-idx="' + msgIdx + '"]');
if (el) {
el.innerHTML = '<div class="msg-choose-card answered"><div class="msg-ask-q">' + escTxt(rec.curiousQuestion || rec.text || '') + '</div><div class="msg-ask-a">✓ 你：' + escTxt(answer) + '</div><div class="msg-choose-r">' + (window.taFit ? window.taFit('TA：') : 'TA：') + escTxt(window.taFit ? window.taFit(askCardReplyClean(reply) || '…') : (askCardReplyClean(reply) || '…')) + '</div>' + favHeartHtml(rec) + '</div>';
}
};
window.chatRoastReply = function (msgIdx, answer, reply) {
const rec = msgs[msgIdx];
if (!rec || rec.special !== 'ask-roast' || rec.roastStatus === 'answered') return;
rec.roastStatus = 'answered';
rec.roastAnswer = answer;
rec.roastReply = reply || '…';
saveMsgs();
saveMsgsNow();
addOut(answer);
addInTyped(reply || '…');
taFavCard(rec);
const el = body.querySelector('.msg-ask[data-idx="' + msgIdx + '"]');
if (el) {
el.innerHTML = '<div class="msg-choose-card answered"><div class="msg-ask-q">' + escTxt(rec.roastText || rec.text || '') + '</div><div class="msg-ask-a">✓ 你：' + escTxt(answer) + '</div><div class="msg-choose-r">' + (window.taFit ? window.taFit('TA：') : 'TA：') + escTxt(window.taFit ? window.taFit(askCardReplyClean(reply) || '…') : (askCardReplyClean(reply) || '…')) + '</div>' + favHeartHtml(rec) + '</div>';
}
};
window.chatAskReply = function (msgIdx, answer, reply, opts) {
// FIX 2026-09-17 #653：自动弹窗→作答隔着异步间隙（loadMsgs IDB 合并 / chatTailMerge 回放
// 插入都会让 msgs 下标位移，#407 已注明「回放插入=下标位移」），弹窗手里攥着的 msgIdx 可能
// 已不指向那张卡——此前这里直接静默 return＝回答整个丢失、聊天卡片纹丝不动，用户必须再点
// 一次卡片重答（跨桌面查岗「要不要来查查我呀？」点【好呀】卡片不更新报障根因）。槽位失效
// 时从末尾回退找最近的未作答 ask-card 重定位（ta-ask.js locateCardIdx v3.6.x 同款守卫；
// 自动弹窗场景卡片就是当时最新一条），彻底找不到才维持原静默返回。
let rec = msgs[msgIdx];
if (!rec || rec.special !== 'ask-card' || rec.askStatus === 'answered') {
rec = null;
for (let _i = msgs.length - 1; _i >= 0; _i--) {
const _r = msgs[_i];
if (_r && _r.special === 'ask-card' && _r.askStatus !== 'answered') { msgIdx = _i; rec = _r; break; }
}
if (!rec) return;
}
rec.askStatus = 'answered';
rec.askAnswer = answer;
let preset = '';
if (Array.isArray(reply) && reply.length) {
const arr = reply.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
if (arr.length) preset = arr[Math.floor(Math.random() * arr.length)];
} else if (typeof reply === 'string' && reply.trim()) {
preset = reply.trim();
}
let taReply;
if (opts && opts.raw && preset) {
// v3.32.x #335：raw 直传——问问TA文字题「接聊天字卡/词典」开关路径（ta-ask.js
// taAskTextReply 已按普通聊天同源逻辑生成整条回应），不再走 pickAskCardReply 90/10 混合
taReply = preset;
} else {
taReply = preset
? (window.pickAskCardReply ? window.pickAskCardReply([preset]) : preset)
: (window.pickAskCardReply ? window.pickAskCardReply() : '收到你的回答。');
}
// v3.17.x：桌面查岗卡（跨桌面「来消息」触发，带 deskCk 标记）回答后——
// 按概率从「桌面查岗」回应字卡池抽 1~5 张、空格分隔，作为 TA 的回应。
//（用户要求：回复后概率触发查岗我的那个联系人的回复字卡，最多 5 张、每张中间空一格；
//  字卡池用 公用字卡 + 该联系人桌面的专属字卡 合并，见 getCustomCardsFor。）
let deskReply = '';
if (rec && rec.deskCk) {
try {
// v3.19.x：按方向取池——deskCkDir 'meToTa'（联系人申请我查 TA）抽「联系人申请我
// 对联系人查岗」，否则（toMe/旧数据）抽「联系人对我查岗」；拒绝查岗时回一句固定失落话
const dir = rec.deskCkDir === 'meToTa' ? 'meToTa' : 'toMe';
// v3.32.x #132：查岗回应概率接 dcf-deskcheck（字卡库【查岗】页可调，默认 50%=原值）
let _dkP = 50;
try { if (window.dcfGet) _dkP = window.dcfGet('deskcheck'); } catch (e) {}
const pool = (window.getDeskCheckPool ? window.getDeskCheckPool(dir) : []).concat(
  (window.getCustomCardsFor ? window.getCustomCardsFor(window.__activeCid || 'default') : []).filter(function (c) {
    // FIX 2026-09-13 #388 媒体池令牌卡不进查岗回应文字池（同 chat.js #383 第三道守卫）
    // FIX 2026-09-15 #533 链接导入的媒体字卡（裸 http(s) 图链）同款排除
    return typeof c === 'string' && c.trim() && c.indexOf('data:') !== 0 && !/^https?:\/\//i.test(c) && !(window.mochiMediaIsToken && window.mochiMediaIsToken(c));
  })
);
if (dir === 'meToTa' && /不要|不用|下次|不了|算了|no/i.test(String(answer))
  && (Math.random() * 100 < 50)) {
deskReply = ['那好吧，下次想查随时来呀。', '没事，那我把自己交给你保管。', '不查也行，反正我总是会来找你。'][Math.floor(Math.random() * 3)];
} else if (pool.length && Math.random() * 100 < _dkP) {
const n = 1 + Math.floor(Math.random() * Math.min(5, pool.length));
const used = {};
const picked = [];
let guard = 0;
while (picked.length < n && guard++ < 50) {
const c = pool[Math.floor(Math.random() * pool.length)];
if (used[c]) continue;
used[c] = true;
picked.push(c);
}
if (picked.length) deskReply = picked.join(' ');
}
} catch (e) {}
}
const finalReply = deskReply || taReply;
rec.askReply = finalReply;
saveMsgs();
saveMsgsNow();
addOut(answer);
addInTyped(finalReply);
taFavCard(rec);
const el = body.querySelector('.msg-ask[data-idx="' + msgIdx + '"]');
if (el) {
el.innerHTML = '<div class="msg-ask-card answered"><div class="msg-ask-q">' + escTxt(rec.askQuestion || rec.text || '') + '</div><div class="msg-ask-a">✓ 已回答：' + escTxt(answer) + '</div><div class="msg-choose-r">' + (window.taFit ? window.taFit('TA：') : 'TA：') + escTxt(window.taFit ? window.taFit(askCardReplyClean(finalReply)) : askCardReplyClean(finalReply)) + '</div>' + favHeartHtml(rec) + '</div>';
}
return finalReply;
};
// #890（用户直派）：TA 发消息后命中撤回不再是固定 900ms「秒撤」，改 1~3 秒随机，更像真人犹豫
function retractDelayMs() { return 1000 + Math.floor(Math.random() * 2001); }
function retractMsg(msgEl, side, idxOverride) {
// FIX 2026-09-13 #407：可选 idxOverride——菜单路径由 resolveActiveMsg 重定位后显式传入，
// 防 msgs 重排后 msgEl.dataset.idx 陈旧撤错条；其他调用方不传参行为不变
const idx = (typeof idxOverride === 'number' && idxOverride >= 0) ? idxOverride : parseInt(msgEl.dataset.idx, 10);
let target = msgEl;
if (!msgEl.isConnected && body) {
const cur = body.querySelector('.msg[data-idx="' + idx + '"]');
if (cur) target = cur; else return;
}
const b = target.querySelector('.msg-bubble');
if (!b) return;
if (!isNaN(idx) && msgs[idx]) {
msgs[idx].retracted = true;
msgs[idx].orig = b.innerHTML;
sessionChangedIdx.add(idx); // v3.6.x：标记本会话变更，防 loadMsgs 合并回滚撤回
chatTailDrop(msgs[idx]); // #180：撤回消息从尾巴日志摘除，防刷新后回放复活
saveMsgs();
if (msgs[idx].side === 'out') syncLastMineText();
}
b.dataset.orig = b.innerHTML; // FIX #572d：撤回瞬间把渲染快照留住（原行为），点开就地展开这份快照
b.innerHTML = '<span style="opacity:.6;font-size:12px;cursor:pointer">' + (side === 'out' ? '我' : '对方') + '撤回了一条消息</span>';
bindToggle(b, side);
}
function splitCardSegs(text) {
const str = String(text || '').trim();
if (!str) return [];
const isWord = (ch) => /[\u4e00-\u9fffA-Za-z0-9]/.test(ch);
const out = [];
let cur = '';
for (let i = 0; i < str.length; i++) {
const ch = str[i];
if ('。！？；\n!?;'.indexOf(ch) >= 0) {
cur += ch;
if (cur.trim()) out.push(cur.trim());
cur = '';
continue;
}
if (ch === ' ' || ch === '，' || ch === ',') {
const seg = cur.trim();
const nextStart = str.slice(i + 1).trimStart()[0] || '';
const segEnd = seg[seg.length - 1] || '';
const canSplit = seg.length >= 2 && isWord(segEnd) && isWord(nextStart);
if (canSplit) {
if (seg) out.push(seg);
cur = '';
} else {
cur += ch; // 并入当前段（保护颜文字/符号）
}
continue;
}
cur += ch;
}
if (cur.trim()) out.push(cur.trim());
const filtered = [];
out.forEach(s => {
if (s.length <= 1 && filtered.length) filtered[filtered.length - 1] += ' ' + s;
else filtered.push(s);
});
if (filtered.length < 2 && str.trim()) return [str.trim()];
return filtered;
}
function partialRetractMsg(msgEl, side) {
const idx = parseInt(msgEl.dataset.idx, 10);
let target = msgEl;
if (!msgEl.isConnected && body) {
const cur = body.querySelector('.msg[data-idx="' + idx + '"]');
if (cur) target = cur; else return;
}
const rec = (idx >= 0 && msgs[idx]) ? msgs[idx] : null;
if (!rec || rec.retracted || rec.parts || rec.type === 'sticker' || rec.type === 'image' || rec.type === 'voice') { retractMsg(target, side); return; }
const segs = splitCardSegs(rec.text);
if (segs.length > 1) {
rec.retractedSegs = rec.retractedSegs || [];
const remain = [];
for (let i = 0; i < segs.length; i++) {
if (!rec.retractedSegs.some(r => r.idx === i)) remain.push(i);
}
if (remain.length) {
const n = 1 + Math.floor(Math.random() * Math.min(remain.length, 3));
const k = Math.min(n, remain.length);
for (let r = 0; r < k; r++) {
const si = remain.splice(Math.floor(Math.random() * remain.length), 1)[0];
rec.retractedSegs.push({ text: segs[si], idx: si });
}
sessionChangedIdx.add(idx); // v3.6.x：标记本会话变更，防 loadMsgs 合并回滚局部撤回
chatTailDrop(rec); // #180：局部撤回后日志原文不得回放（与撤回同口径）
saveMsgs();
const m = renderMsg(rec, idx); // #1326：局部撤回重画的是「原来那一格」，下标交给调用方才是真的
m.dataset.idx = idx;
if (target.parentNode) target.parentNode.replaceChild(m, target);
return;
}
}
if (rec.mood && rec.mood.length) {
rec.retractedMood = rec.retractedMood || [];
const remain = [];
for (let i = 0; i < rec.mood.length; i++) {
// #332 来源 chip（词典拼字/梦角造句等 opts.tag + tagNoDup → mood.label 恒空串）不是情绪字卡，
// 不进「撤回情绪字卡」候选——否则联系人局部撤回会错误撤掉来源标签
if (!(rec.mood[i] && String(rec.mood[i].label || '').trim())) continue;
if (rec.retractedMood.indexOf(i) < 0) remain.push(i);
}
if (remain.length) {
const pick = remain[Math.floor(Math.random() * remain.length)];
rec.retractedMood.push(pick);
sessionChangedIdx.add(idx); // v3.6.x：标记本会话变更，防 loadMsgs 合并回滚局部撤回
chatTailDrop(rec); // #180：局部撤回后日志原文不得回放（与撤回同口径）
saveMsgs();
const m = renderMsg(rec, idx); // #1326：局部撤回重画的是「原来那一格」，下标交给调用方才是真的
m.dataset.idx = idx;
if (target.parentNode) target.parentNode.replaceChild(m, target);
return;
}
}
retractMsg(target, side);
}
// v3.26.x：字卡池为空的最终兜底——原单条硬编码「收到～」会让联系人在没有可用
// 字卡时每条回复都一模一样（用户反馈联系人一直/重复发【收到~】）。改用一个小型
// 通用池随机抽，避免机械复读；真实的根因仍要查该联系人的字卡库是否为 & 默认字卡开关。
const FALLBACK_REPLY_POOL = ['收到～', '好呀', '好～', '嗯嗯', '知道啦', '好哒', '嗯嗯，我在听'];
// FIX 2026-09-05 #185 空白字卡防空气泡：池里可能混入空串/纯空白/零宽字符字卡（导入包/手编），
// 旧单抽 '' 有 || 兜底但 ' ' 这类 truthy 空白会直接发出；抽取时跳过空白，20 次抽不中回空串走上层兜底
function pickNonBlank(arr) {
let v = '', g = 0;
do { v = pick(arr); g++; } while (g < 20 && !(typeof v === 'string' && v.trim()));
return (typeof v === 'string' && v.trim()) ? v : '';
}
// FIX 2026-09-24 #1212（用户实报「(இωஇ) 这种末尾颜文字明明放得下也另起一行；我的意思是行末放不下、
// 防止截断才换行」）：#1051 的连接符是**无条件**硬换行——只要命中「文字卡＋颜文字卡」就顶到下一行，
// 完全不看行末放不放得下，短颜文字也跟着换行。本函数把这一判交回排版引擎实测：拿当前气泡的真实
// 可用宽排一次「文字卡␣颜文字卡」，行数没多、气泡也没横向溢出＝放得下，用空格相接（同一行）；
// 多出一行、或溢出气泡宽（＝#1051 实报的「末行显示不全」形态，软换行点被内核无视时就是这个样子）
// 才回硬换行。零机型/零 UA 分支：判据是同内核自己量出的几何结果，不是猜哪台机器宽容；聊天页还没
// 布局（后台生成的主动消息、切在别的页面）量不到时保持 #1051 的安全形态＝硬换行。
// 探针节点用完即摘（同一任务内插入→量→移除，不上屏），所以既不参与滚动高度、也不被贴底/加载条
// 那套按 #chat-body 子树计数的逻辑看见。群聊借 window.chatKaoJoinSep 同一份测量，不再各写一份。
let kaoProbeEl = null;
function chatKaoJoinSep(text, kj, pageEl, boxEl) {
if (!text || !kj) return '\n';
const box = boxEl || body;
const page = pageEl || document.getElementById('page-chat');
const bw = box.clientWidth;
if (!page || !(bw > 0)) return '\n'; // 拿不出真实宽度＝不赌排版，走安全形态
const bcs = getComputedStyle(box);
const avail = Math.floor(bw - (parseFloat(bcs.paddingLeft) || 0) - (parseFloat(bcs.paddingRight) || 0));
if (!(avail > 80)) return '\n';
if (!kaoProbeEl) {
kaoProbeEl = document.createElement('div');
kaoProbeEl.setAttribute('aria-hidden', 'true');
kaoProbeEl.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none';
kaoProbeEl.innerHTML = '<div class="msg msg-in"><div class="msg-side"><div class="msg-av"></div></div>' +
'<div class="msg-bubble"><span style="opacity:.85;word-break:break-word"></span></div></div>';
}
const probe = kaoProbeEl;
const bub = probe.querySelector('.msg-bubble');
const sp = bub.querySelector('span');
probe.style.width = avail + 'px';
page.appendChild(probe);
try {
sp.textContent = text;
const h1 = bub.offsetHeight, o1 = bub.scrollWidth - bub.clientWidth;
sp.textContent = text + ' ' + kj;
const h2 = bub.offsetHeight, o2 = bub.scrollWidth - bub.clientWidth;
return (h2 > h1 || o2 > o1 + 1) ? '\n' : ' ';
} catch (e) {
return '\n';
} finally {
if (probe.parentNode === page) page.removeChild(probe);
}
}
window.chatKaoJoinSep = chatKaoJoinSep; // group-chat.js 同源共用
function genReplyText(c) {
const pool = getPool();
let reply = '', type = 'text';
// #851 本条气泡实际拼出的文字字卡张数（普通回复＝1，追加颜文字卡＝2）；上层据此挂来源 tag
let replyCards = 1;
// FIX 2026-09-16 #624 表情包概率与图片概率独立判定（原为 if/else if 互斥）：两者同时命中时
// 不再只出其一，而是同一条消息里带「表情包 + 图片」两张图（来源＝字卡库 公用+专属 的
// 【表情包】/【图片】池，getMediaCards 本就合并双作用域）。仅命中其一时行为与旧版逐个分支
// 完全一致（整条媒体消息）；两者都未命中时才继续 emoji/语音/文字优先级链。
const stHit = !!(pool.sticker.length && hit(c['sticker-prob']));
const imHit = !!(pool.image.length && hit(c['image-prob']));
if (stHit && imHit) {
const _st = pickNonBlank(pool.sticker), _im = pickNonBlank(pool.image);
if (_st && _im) return { text: _st, type: 'text', parts: [
{ k: 'img', v: _st, sub: 'sticker' },
{ k: 'img', v: _im, sub: 'image' }
] };
}
if (stHit) {
reply = pickNonBlank(pool.sticker); type = 'sticker';
} else if (pool.emoji.length && hit(c['emoji-prob'])) {
reply = pickNonBlank(pool.emoji); type = 'emoji';
} else if (imHit) {
reply = pickNonBlank(pool.image); type = 'image';
} else if (pool.voice.length && hit(c['voice-prob'])) {
reply = pickNonBlank(pool.voice); type = 'voice';
} else {
reply = pickNonBlank(pool.text) || pick(FALLBACK_REPLY_POOL);
}
// #1203 「多字卡回复」总开关关闭＝这条气泡只用一张字卡：颜文字卡不再追加（旧写法只认 kaomoji-prob
// ＝关了总开关仍有 5% 的回复被拼成两张卡并挂「多字卡回复」chip＝用户实报「全关了还是有多字卡回复」）
if (type === 'text' && c['py-en'] === 1 && pool.kaomoji.length && hit(c['kaomoji-prob'])) {
const kj = pickNonBlank(pool.kaomoji);
if (kj) { reply += chatKaoJoinSep(reply, kj) + kj; replyCards = 2; } // #851 文字卡＋颜文字卡＝一条气泡两张卡；#1051 行末会被裁＝放不下才换；#1212 「放得下」交给实测（chatKaoJoinSep），放不下/量不到才回 '\n'→<br> 硬换行
}
return { text: reply, type: type, cards: replyCards };
}
// FIX 2026-09-29 用户直派「我发一句，联系人发一堆消息」→ 你连发的那几条算**一轮**；
// 复报「这样做之后会出现几分钟联系人不回消息」→ 同一批里我引进的两处静默一并收掉：
// ① 轮做成**每个联系人各排各的**（replyTurns 按 cid 存）。早先一版是全站一个槽位：你切到另一个
//    联系人发一句，就把上一个联系人那一轮的定时器 clearTimeout 掉＝那一轮永远不回，只能等 TA
//    主动发送那一路（分钟级）——正是「几分钟不回」最长的那条。旧写法（每发一条各排一批）天然
//    没这个问题，所以这是我该修的回归，不是「一轮」这个口径本身。
// ② 已读不回仍**一轮只掷一次**，但掷在**轮起手**那一刻：屏上那枚「已读不回」小字（渲染见
//    special==='read'／#220 的 pendingRead 原地替换）1~4 秒内就出现。早先一版把它挪到到点之后，
//    「回复速度最长」默认能抽到 40 秒，于是变成「发完话半天只等来一枚已读」＝看着像没人理。
// 抽样口径一字不改（最短~最长随机；TA 在忙时那一段会拉长）；条数只取决于 TA 这一轮有几句话要
// 说，不再按你发了几条放大；引用取轮内末尾那句。每多一条把到点往后推 TURN_HOLD、封顶 TURN_HOLD_MAX。
const TURN_HOLD = 1500, TURN_HOLD_MAX = 8000;
const replyTurns = {}; /* cid -> { due, cap, timer } */
window.__replyTurnKeys = function () { try { return Object.keys(replyTurns); } catch (e) { return []; } }; // 只读诊断：此刻有哪几个联系人各排着一轮
// 回复机制两条并存，由设置里「连发的算一轮」（turn-en，**默认关闭**）选一条：
// 关＝mochi 原机制一字不变（每发一条各排一批，且受「总量限流」计数与拦）；
// 开＝nova 式并轮（每个联系人各排一轮、骰子掷在轮上，且**不走总量限流**，见 rateLimitFull 的 turn-en 早退）。
function scheduleReply() {
if (Number(cfg()['turn-en']) === 1) return scheduleReplyTurn();
return scheduleReplyMochi();
}
// ---------- mochi 原机制（默认；下面的函数体与开关上线前逐字相同） ----------
function scheduleReplyMochi() {
const myCid = window.__activeCid || 'default';
const sameCid = () => (window.__activeCid || 'default') === myCid;
syncLastMineText();
const quoteSrc = lastMineQuote;
const quoteSrcIdx = lastMineIdx;
const quoteKey = quoteSrc && typeof quoteSrc === 'object' ? String(quoteSrc.t || '') + '\n' + (quoteSrc.imgs || []).join() : String(quoteSrc || '');
const c = cfg();
// FIX 2026-09-16 #571 字卡回复延迟遥测：用户报「字卡延迟反应卡顿5、6秒/3、4秒」（iPhone 14 Pro
//   Safari 等多 iOS 机型）——现场诊断 63fps/无长任务/字卡库仅 11KB，回复等待全部来自本函数
//   的「回复速度」设定随机（默认 rs-min=1~rs-max=40 秒），把设定值与实测落地耗时打进
//   设置→复制诊断信息，下次报障可一眼区分「设定即此延迟」与「真处理卡顿」。零行为改动。
try { window.__replyWaitT0 = Date.now(); } catch (eRW) {}
if (hit(c['rn-prob'])) {
setTimeout(() => { if (!sameCid()) return; addIn('', { special: 'read' }); }, randInt(1000, 4000));
return;
}
const delay = (c['rs-min'] + Math.random() * Math.max(1, c['rs-max'] - c['rs-min'])) * 1000;
try { window.__rsDrawS = Math.round(delay / 100) / 10; } catch (eRD) {} // #571 本次掷到的设定延迟（秒）
showTyping();
setTimeout(() => {
if (!sameCid()) { hideTyping(); return; }
hideTyping();
if (hit(c['touch-prob'])) {
performPoke();
return;
}
    deliverTurn(c, sameCid, quoteSrc, quoteSrcIdx, quoteKey);
}, delay);
}
// ---------- nova 式并轮（turn-en 打开后走这一路） ----------
function scheduleReplyTurn() {
const myCid = window.__activeCid || 'default';
const nowT = Date.now();
syncLastMineText(); // 每发一条都刷新「我最后那句」，到点那一刻再取快照＝轮内末尾那条
try { window.__replyWaitT0 = Date.now(); } catch (eRW) {} // #571 起点＝你话音落下这一刻，与到点无关
const c = cfg();
let t = replyTurns[myCid];
if (t && t.silent) {
// 这一轮起手已判「已读不回」：你补的那几句不再另掷一次、也不演「正在输入」，只把这轮的释放往后推
t.due = Math.min(t.cap, Math.max(t.due, nowT + TURN_HOLD));
clearTimeout(t.timer);
t.timer = setTimeout(() => { if (replyTurns[myCid] === t) delete replyTurns[myCid]; }, Math.max(0, t.due - nowT));
return;
}
if (!t) {
const draw = (c['rs-min'] + Math.random() * Math.max(1, c['rs-max'] - c['rs-min'])) * 1000;
try { window.__rsDrawS = Math.round(draw / 100) / 10; } catch (eRD) {} // #571 本次掷到的设定延迟（秒）
t = replyTurns[myCid] = { due: nowT + draw, cap: nowT + draw + TURN_HOLD_MAX, timer: 0 };
if (hit(c['rn-prob'])) {
// 整轮只掷这一次：起手 1~4 秒落「已读不回」那枚小字，槽位守到原来到点才释放（期间补的话不另掷）
t.silent = 1;
setTimeout(() => { if ((window.__activeCid || 'default') === myCid) addIn('', { special: 'read' }); }, randInt(1000, 4000));
t.timer = setTimeout(() => { if (replyTurns[myCid] === t) delete replyTurns[myCid]; }, Math.max(0, t.due - nowT));
return;
}
} else {
// 不早于原计划（已经等到点就别倒回去），不晚于这一轮的封顶（你一直发也有个上限）
t.due = Math.min(t.cap, Math.max(t.due, nowT + TURN_HOLD));
}
showTyping();
clearTimeout(t.timer); // 只撤自己这一轮，别的联系人排着的轮照旧
t.timer = setTimeout(() => { if (replyTurns[myCid] === t) delete replyTurns[myCid]; runReplyTurn(myCid); }, Math.max(0, t.due - nowT));
}
// 共用尾段：一条/一批到点后「掷条数 → 逐条投递」。两条机制都调这里（改动只落一处，
// 也让「replyGuideHint 接了几处」这类按次数判定的回归断言不被复制体顶偏）。
function deliverTurn(c, sameCid, quoteSrc, quoteSrcIdx, quoteKey) {
const rpMin = Math.max(1, Number(c['reply-min']) || 1);
const rpMax = Math.max(rpMin, Number(c['reply-max']) || 2);
// #167 多字卡回复(py-en)是总开关：关闭时回复条数强制 1 条（关=彻底只回一条），开启才按「回复条数」拆条
const count = (c['py-en'] === 1) ? randInt(rpMin, rpMax) : 1;
// v3.27.x #218 互动频率引导：一次回多条=多字卡概率行为，提醒用户可自行调低/关闭（reply-settings.js 定义）
if (count >= 2 && window.replyGuideHint) window.replyGuideHint('py');
try { console.log('[mochi-reply] scheduleReply count=%s rpMin=%s rpMax=%s raw reply-min=%s reply-max=%s', count, rpMin, rpMax, c['reply-min'], c['reply-max']); window.__replyDiag = (window.__replyDiag||0)+1; window.__replyOnceDiag = 0; } catch(e){}
const wantQuote = hit(c['quote-prob']) && !!quoteSrc;
for (let i = 0; i < count; i++) {
setTimeout(() => {
if (!sameCid()) return;
hideTyping();
const q = (wantQuote && i === 0 && quoteKey && quoteKey !== lastQuotedText) ? quoteSrc : null;
if (q) lastQuotedText = quoteKey;
replyOnce(c, q, i > 0, q ? quoteSrcIdx : -1);
if (i < count - 1) showTyping();
if (i === count - 1) {
setTimeout(() => { if (!sameCid()) return; if (window.maybeMusicRequest) window.maybeMusicRequest(); }, 2000);
}
}, i * randInt(1200, 2800));
}
}
// 一轮到点：这一轮你那几条一起结算，剩下的骰子掷的是轮，不是你某一句
function runReplyTurn(myCid) {
const sameCid = () => (window.__activeCid || 'default') === myCid;
const quoteSrc = lastMineQuote;
const quoteSrcIdx = lastMineIdx;
const quoteKey = quoteSrc && typeof quoteSrc === 'object' ? String(quoteSrc.t || '') + '\n' + (quoteSrc.imgs || []).join() : String(quoteSrc || '');
const c = cfg();
if (!sameCid()) { hideTyping(); return; }
hideTyping();
if (hit(c['touch-prob'])) {
performPoke();
return;
}
    deliverTurn(c, sameCid, quoteSrc, quoteSrcIdx, quoteKey);
}
async function replyOnce(c, quote, silent, quoteIdx) {
try { console.log('[mochi-reply] replyOnce #%s quote=%s silent=%s', (window.__replyOnceDiag=(window.__replyOnceDiag||0)+1), !!quote, !!silent); } catch(e){}
try { await ensureReplyCardsReady(); } catch (e) {}
const myCid = window.__activeCid || 'default';
const sameCid = () => (window.__activeCid || 'default') === myCid;
let rep = genOneReply(c);
// FIX 2026-09-16 #624 多图消息（parts 里是图片、text 为媒体载荷）不参与经期温柔语态改写——
// 否则会给 data: 串加上前后缀，污染 rec.text（气泡仍走 parts，但横幅/引用/通知文本变乱）。
// #677 本批是否由「多字卡回复」抽卡分支产生（genOneReply 置位；FIX 2026-09-18 #726：词典逐卡连发
// 每条气泡只装一张卡、来源即词典，该形态不挂此 chip）
// FIX 2026-09-19 #851 温柔前缀/动作本身是一张独立字卡（与正文空格相接）＝这条气泡两张卡，
// 故在取用判定之前置位 pyMultiDrawn（与下方 py-en 抽卡分支同口径挂来源 tag）。
// #1203 温柔前缀/后缀本身也是一张独立字卡（空格相接）＝两张卡同挂此 chip，故一并收进总开关：关时不改写
if (rep && c['py-en'] === 1 && rep.type === 'text' && typeof rep.text === 'string' && rep.text.indexOf('data:') !== 0 && window.periodWarmText) {
try { const _w0 = rep.text, _w = window.periodWarmText(rep.text); if (_w) { rep.text = _w; if (_w !== _w0) pyMultiDrawn = true; } } catch (e) {}
}
// FIX 2026-09-19 #851 口径从「抽卡分支命中」改为「这条气泡实际拼了 ≥2 张文字字卡」：颜文字卡/
// 连接词卡/经期温柔卡／词典单气泡拼字都是两张以上卡，一律挂此 tag（用户口径＝看气泡里有几张卡）。
const pyMultiHit = pyMultiDrawn;
// #298 词典拼字：开关开启时按「拼字概率」把本条回复换成「语录字卡抽卡拼字」；
// #323 双形态混合（共用同一拼字概率，各自可开关，双开 50/50 掷币）：
//   one:true  = 单气泡形态——几张字卡空格连成一条消息发进同一个聊天气泡；
//   one:false = 多回复形态——每张字卡单独一条气泡逐条连发（不受「回复条数」限制，
//   #1236 起本模块整体受 py-en 约束（py-en 关＝两种形态都不触发），一条气泡带「词典拼字」tag）。
// 旧版返回纯数组仍兼容为逐卡连发。
let spellSegs = null;
let spellOne = false;
// #451：spell 换血前的原回复图片段（表情/图片），逐卡连发末气泡重建 parts 时复用
let spellImgParts = null;
// #451：按最终正文重建 parts（文本段=正文，保留原回复图片段；无图片段返回 null 维持
// 「纯文本消息不带 parts」的存储口径，气泡回落 text 分支与引用/收藏同源）
function spellPartsSync(text, prevParts) {
const imgs = (prevParts || []).filter(p => p && p.k === 'img');
return imgs.length ? [{ k: 'text', v: text }].concat(imgs) : null;
}
try {
const _sp = (window.quoteSpellPick && window.quoteSpellPick(c)) || null;
if (_sp && Array.isArray(_sp.segs)) { spellSegs = _sp.segs; spellOne = !!_sp.one; }
else if (Array.isArray(_sp)) { spellSegs = _sp; }
// #1451 拼字现场账：命中时记下本批抽到几张、走哪个形态（n＋单/连），随诊断【回复字卡池】
// 节回放——「拼字一直只发 N 张」类报障一眼分清是设置区间所致还是抽卡异常；零行为改动
if (spellSegs && spellSegs.length) {
window.__spellLog = window.__spellLog || [];
window.__spellLog.push(spellSegs.length + (spellOne ? '单' : '连'));
if (window.__spellLog.length > 6) window.__spellLog.shift();
}
} catch (e) {}
if (spellSegs && spellSegs.length > 1) {
// #451：正文换血必须同步重建 parts——气泡渲染 parts 优先于 text（#202 混合消息链路），
// 引用快照/收藏/回复引用读 text，两轨不同步＝「消息显示 A、引用预览显示 B」（iOS Chrome
// 等多机型同报，词典拼字/梦角自由造句同族）。口径：文本段=最终正文（与 addIn 文本一致：
// 单气泡＝#650 连接符池 join（#1451 起 addIn 也吃这一份）、逐卡连发末气泡=本卡），原回复掷中的表情/图片段原样保留。
const __spText = spellOne ? pyJoinCards(spellSegs, c) : spellSegs.join(''); // #650 单气泡连接符同走符号池
const __spImgs = (rep.parts || []).filter(p => p && p.k === 'img');
spellImgParts = __spImgs;
rep = { text: __spText, type: 'text', spell: spellSegs, spellOne: spellOne,
parts: __spImgs.length ? [{ k: 'text', v: __spText }].concat(__spImgs) : null };
}
// #317 梦角自由造句：开关开启时按「触发概率」把本条回复换成「梦角语料抽卡→截断几字重造句」，
// 新句异步入库（自定义聊天字卡「梦角自由造句」分类，下次可再被抽用）；气泡下挂
// 「梦角自由造句」tag（与情绪 chip 同链路持久化）；词典拼字命中时让位（同一回复不叠加两种玩法）
let mjf = null;
if (!spellSegs) {
try { mjf = (window.dreamFreePick && window.dreamFreePick(c)) || null; } catch (e) { mjf = null; }
if (mjf && mjf.text) {
// #451：同上——造句新句换血 text 后 parts 同步重建，杜绝气泡（parts）与引用/收藏（text）两轨
rep = { text: mjf.text, type: 'text', mjFree: true, parts: spellPartsSync(mjf.text, rep.parts) };
setTimeout(() => { try { if (window.dreamFreeSave && mjf.text) window.dreamFreeSave(mjf.text); } catch (e) {} }, 800);
}
}
let m = null;
// #349/#350/#843 tag 规则：单气泡＝按抽到的字卡长度（全部 >4 字整句→「词典拼句」；含 1~4 字短卡→「词典拼词」）；
// 多回复逐卡连发＝每条气泡只装一张卡，按「一条消息一张卡」口径挂「词典」，另带「词典逐卡连发」标玩法
const dictTag = (rep.spell && rep.spell.every(t => (t || '').length > 4)) ? '词典拼句' : '词典拼词';
// #677 「多字卡回复」来源 tag（与词典/词典拼字 tag 并存，不替换）：单气泡形态（一条气泡里多张卡，
// 语义与「每条消息使用多字卡回复」相符）直接并列挂上。FIX 2026-09-18 #726 逐卡连发形态不再挂它
// （用户实报「出现词典逐卡连发时错误的也显示了多字卡回复」）——逐卡连发每条气泡只装一张词典卡、
// 来源就是词典，再挂「多字卡回复」是与内容不符的来源标注；单气泡拼字保持两枚并列（#693 用户口径）。
// 渲染侧 msg-mood 逐条渲染 rec.mood，chip 并列不丢；tag 随消息持久化，重进聊天仍在。
// FIX 2026-09-19 #851 词典拼字单气泡无条件并列挂此 chip（spellSegs>1 才会进 rep.spell 形态＝气泡里
// 必然 ≥2 张卡）：此前只在底层那次 genOneReply 恰好也命中多字卡抽卡时才挂，多数情况漏标。
// #956 口径不动这一层：来源 chip 判据＝「气泡里实际有几张卡」（#851/#693/#726 用户口径），
// 与「多字卡回复」总开关无关；本批只把「拼接随机标点」收进总开关（见 pyJoinCards #956a）。
const pyMultiExtra = (pyMultiHit || (rep.spell && rep.spellOne)) ? [{ tag: '多字卡回复', label: '' }] : null;
// FIX 2026-09-16 #553 撤回先掷签后投递（#345 同族收口②：回复链）——rc-prob 原在 addIn 之后
// 才掷：桌面横幅/系统通知已把内容承诺给用户（如「早安」），900ms 后 partialRetractMsg 撤回＝
// 进聊天只剩撤回墓碑/缺段正文＋同批其它字卡＝「弹窗说的那句话压根没有，是别的字卡」（OPPO
// Reno6 雨见/红米 K80 等多机型同现，与设备无关；scheduleReply/continueChat/拍一拍追问共经此
// 路径）。对齐 tryAutoSend #345 口径：投递前定生死——命中撤回的本条 silent 静默落地（不弹
// 横幅/系统通知、不播音效，未读角标照增——墓碑也是未读事件），1~3 秒随机（retractDelayMs）后照常撤回；rc-refix
// 补发保持正常投递（此刻弹通知名正言顺，内容不会再消失）。
const willRetractR = hit(c['rc-prob']);
if (rep.spell && rep.spellOne) {
// FIX 2026-09-29 #1451 单气泡拼字正文改用 rep.text（＝pyJoinCards 的连接符池结果）——旧写法用
// 单空格硬拼，让「拼接随机标点」在这条路上从未生效（设置页却写着单气泡形态也用同一套符号池，
// #650 的注释也自称已接上）；且 `parts`（混排图片时气泡渲染以 parts 优先）用的正是符号池版、
// 引用/收藏读的却是空格版＝两轨打架（#451 同族）。改后气泡＝引用＝收藏同吃一支正文；
// py-en/py-punct-en 任一关时 pyJoinCards 回退单空格＝与旧观感一致。
m = addIn(rep.text, {
quote: quote,
qside: 'out',
qidx: quote ? quoteIdx : undefined,
type: 'text',
parts: rep.parts,
 silent: silent || willRetractR,
 tag: dictTag,
 tagExtra: pyMultiExtra,
 tagNoDup: true
 });
} else if (rep.spell) {
for (let si = 0; si < rep.spell.length; si++) {
if (si) {
showTyping();
await new Promise(r => setTimeout(r, randInt(900, 1800)));
if (!sameCid()) { hideTyping(); return; }
hideTyping();
}
m = addIn(rep.spell[si], {
quote: si === 0 ? quote : null,
qside: 'out',
qidx: (si === 0 && quote) ? quoteIdx : undefined,
type: 'text',
parts: si === rep.spell.length - 1 ? spellPartsSync(rep.spell[si], spellImgParts) : null,
silent: si > 0 ? true : (silent || willRetractR),
// #1042 逐条连发＝一条气泡一条收件（卡与卡之间还各走一次「正在输入」），收件音效按条响：
// 旧写法 si>0 一律 silent ⇒ 三张卡只响首条一声；当本批落在「多字卡回复」第 2 条及以后
// （replyOnce 自身带 silent = i > 0）时整批一声都不响＝用户实报「词典逐条连发没有触发音效」。
// silent 原样保留（横幅/系统通知仍整批只承诺一次，不刷屏）；命中撤回（willRetractR）时
// 整批照旧全静默落地，#553「内容会消失的本条不播音效」契约不受本批改影响。
 sfx: !willRetractR,
// #350/#843：逐卡连发的每条气泡只装一张词典字卡，按「一条消息一张卡」口径挂「词典」tag，
// 玩法标记「词典逐卡连发」用 tagExtra 并列（chip 随消息持久化重进聊天仍在）
// FIX 2026-09-18 #726 本路不挂「多字卡回复」来源 chip（#677 曾挂在本批首条）：逐卡连发
// 每条气泡只有一张词典卡，来源就是词典；只有单气泡拼字才并列挂词典 tag＋多字卡回复两枚。
 tag: '词典',
 tagExtra: [{ tag: '词典逐卡连发', label: '' }],
 tagNoDup: true
 });
}
} else if (rep.mjFree) {
// #317 梦角自由造句：单气泡发送，来源 tag「梦角自由造句」（chip 持久化，重进聊天仍在）
m = addIn(rep.text, {
quote: quote,
qside: 'out',
qidx: quote ? quoteIdx : undefined,
type: 'text',
parts: rep.parts,
silent: silent || willRetractR,
 tag: '梦角自由造句',
 tagExtra: pyMultiExtra,
 tagNoDup: true
 });
} else {
// #677 普通回复路径：多字卡回复命中时补挂来源 tag（无词典/梦角 tag 时它就是唯一 chip）
m = addIn(rep.text, { quote: quote, qside: 'out', qidx: quote ? quoteIdx : undefined, type: rep.type, parts: rep.parts, silent: silent || willRetractR, tag: pyMultiHit ? '多字卡回复' : undefined, tagNoDup: true });
}
const _favProbMsg = (window.favCfg ? window.favCfg().taMsg : 30);
if (lastMineText && Math.random() * 100 < _favProbMsg) {
const fav = getFav();
// v3.26.x：只与 TA 自己的收藏判重——「我」收藏过同一条不应挡住 TA 的自动收藏（两个 tab 独立）
if (!fav.some(f => f.by === 'ta' && f.side === 'out' && f.text === lastMineText)) {
// FIX 2026-09-12 #356 媒体池令牌也是图片载荷：TA 自动收藏落库时 text 已可能被令牌化为
// @@m:hash，旧判定只认 data: 开头→存成 type:text，收藏页把令牌串当文字直出
let favType = chatIsImgSrcLike(lastMineText) ? 'image' : 'text'; // FIX #948 统一判据（裸令牌/大写 MIME/前导空白不再当文字收藏）
let favParts = undefined;
for (let i = msgs.length - 1; i >= 0; i--) {
const mm = msgs[i];
if (mm && mm.side === 'out' && mm.text === lastMineText) {
if (mm.type && mm.type !== 'text') favType = mm.type;
if (mm.parts && mm.parts.length) favParts = mm.parts.map(p => ({ k: p.k, v: p.v, sub: p.sub }));
break;
}
}
fav.push({ side: 'out', text: lastMineText, type: favType, ts: Date.now(), by: 'ta', parts: favParts });
saveFav(fav);
setTimeout(() => { if (!sameCid()) return; toast('TA 收藏了你的一条消息'); }, 1200);
}
}
	if (rep.type === 'text' || rep.type === 'sticker' || rep.type === 'image') {
	if (window.addChatCount) window.addChatCount();
	// v3.16.x：【TA的心情】低概率主动分享——正常回复后小概率额外追加一条
	// 独立分享（内容来自 TA 的心情字卡库，非情绪链；自带总冷却 + 同类冷却）
	// #390：10% 概率来源 tag 显示「你的心情」而非「TA的心情」——TA 有时发这张卡
	// 实际是想问对方的心情，tag 恒为「TA的心情」表达不清
	try {
	const tm = (window.tryTaMoodShare && window.tryTaMoodShare()) || null;
	if (tm && tm.content) {
	const tmTag = Math.random() * 100 < 10 ? '你的心情' : 'TA的心情';
	setTimeout(() => {
	if (!sameCid()) return;
	addIn(tm.content, { initiative: true, tag: tmTag, tagNoDup: true });
	}, randInt(1500, 3500));
	}
	} catch (e) {}
	const chain = (window.triggerEmotionChain && window.triggerEmotionChain()) || null;
if (chain && chain.length) {
const typeName = { mood: '情绪', heart: '心意', intent: '交流意图' };
setTimeout(() => {
	// FIX 2026-09-13 #412 情绪链崩溃：m 可能为 null（addRec 实时去重命中时返回 null）
	// ——定时器触发时对 null 调 querySelector＝page-chat「Cannot read properties of null
	// (reading 'querySelector')」反复报错（荣耀/OPPO/华为等多机型同现，诊断实测）
	if (!sameCid() || !m) return;
	const bm = m.querySelector('.msg-bubble');
	if (bm) {
let mm = bm.querySelector('.msg-moods');
if (!mm) {
mm = document.createElement('div');
mm.className = 'msg-moods';
bm.appendChild(mm);
}
chain.forEach(it => {
const tag = typeName[it.type] || '情绪';
mm.innerHTML += '<div class="msg-mood' + (it.type === 'intent' ? ' msg-intent' : '') + '"><span class="msg-mood-tag">' + tag + '</span><span>' + it.content + '</span></div>';
});
const idx2 = Number(m.dataset.idx);
if (!isNaN(idx2) && msgs[idx2]) {
msgs[idx2].mood = msgs[idx2].mood || [];
chain.forEach(it => {
msgs[idx2].mood.push({ tag: typeName[it.type] || '情绪', label: it.content });
});
saveMsgs();
}
}
}, 500);
}
// v3.14.x：移除 20% 预掷门控——与 checkCare 内部概率叠加后第 2 天起触发率仅 ~12%，体感「只有第一天会关心」；防刷屏由其内部同日一条冷却兜底
try { window.periodCheckCare && window.periodCheckCare(); } catch (e) {}
}
if (willRetractR) {
	setTimeout(() => {
	// FIX 2026-09-13 #412 同源守卫：m 为 null（去重命中）时 partialRetractMsg 读 dataset 也会崩
	if (!sameCid() || !m) return;
	partialRetractMsg(m, 'in');
if (c['rc-en'] !== 0 && hit(c['rc-refix'])) {
showTyping();
setTimeout(() => { if (!sameCid()) return; hideTyping(); replyOnce(c, null); }, 600);
}
}, retractDelayMs());
}
setTimeout(() => { if (!sameCid()) return; if (window.callMaybeTrigger) window.callMaybeTrigger(); }, 3500);
setTimeout(() => { if (!sameCid()) return; trySystemAutoSend(); trySystemAskMochi(); tryCollectPending(); if (window.maybeAutoGift) window.maybeAutoGift(); }, 2500);
}
window.continueChat = function () {
// #1015：点「继续说」＝用户当刻要求的回应，夜间照常（同你自己发消息，置对话窗口）。
nightOpenReply();
const myCid = window.__activeCid || 'default';
const sameCid = () => (window.__activeCid || 'default') === myCid;
const c = cfg();
let delay, count;
if (c['cs-normal'] === 1) {
const rsMin = Math.max(1, Number(c['rs-min']) || 1);
const rsMax = Math.max(rsMin, Number(c['rs-max']) || rsMin);
delay = (rsMin + Math.random() * (rsMax - rsMin)) * 1000;
const rpMin = Math.max(1, Number(c['reply-min']) || 1);
const rpMax = Math.max(rpMin, Number(c['reply-max']) || 2);
// #167 同 scheduleReply：py-en 总开关关闭时「让对方继续说」也只回一条
count = (c['py-en'] !== 1) ? 1 : randInt(rpMin, rpMax);
} else {
delay = randInt(300, 1000); count = 1;
}
showTyping();
setTimeout(() => {
if (!sameCid()) { hideTyping(); return; }
hideTyping();
for (let i = 0; i < count; i++) {
setTimeout(() => {
if (!sameCid()) return;
hideTyping();
// FIX 2026-09-22 #1023（用户实报「点击【让对方继续说】的功能，聊天记录没有自动滑动」，单聊与
// 群聊同现）：点「继续说」是**用户当刻主动要的回应**，与 #492 决策结果、拍一拍同族——置一次性
// 跟底标记（chatUserFollowScroll），由 maybeScrollChatBottom 在本条 in 侧落地时消费。此前它没走
// 这条通道，只吃 in 侧「TA 自发消息不打扰」的钉住闸：用户上翻看过历史＝解钉态
//（chatPinnedBottom=false）时 TA 的回复气泡落在视口下方、永远不滑过来，正是报障形态（无头实测：
// 解钉态 gap 400→486px、气泡底边在消息区下方 +458px；贴底态本就在底部故看不出问题）。每轮回复
// 各置一次（多字卡连发时后面几条也跟）；TA 自发消息的 #162/#378/#416 不打扰契约零改动——此键
// 只在本函数内置位，别处不受影响。
chatUserFollowScroll = true; // #1023 用户主动要的回应：本条落地即贴底（上翻态也滑过来）
replyOnce(c, null, i > 0);
if (i < count - 1) showTyping();
if (i === count - 1) setTimeout(() => { if (!sameCid()) return; if (window.maybeMusicRequest) window.maybeMusicRequest(); }, 2000);
}, i * randInt(1200, 2800));
}
}, delay);
};
if (pname) {
pname.addEventListener('click', () => {
const c = cfg();
if (c['cs-trigger-name'] === 1 && window.continueChat) window.continueChat();
});
}
const csBtn = document.getElementById('chat-continue-btn');
// #152：安卓键盘收起与点按手势重叠时（打字后立刻点「继续说」最典型），输入栏随视口
// 回弹下移，touchend 的二次命中测试落在位移后的别的元素上，合成 click 被派发到错误
// 元素——按钮监听器不触发、无报错、无回复（iQOO Neo10Pro/多安卓机型报障，无头复现实证）。
// 触摸改 pointerdown「按下即触发」：目标是真实按压元素，不经历触摸后的二次命中测试，
// 键盘怎么收都吞不掉；1.2s 防重入挡住随后补发的合成 click（干净点按双事件只回一次）。
// 鼠标仍走 click（不响应按下半程）；无 PointerEvent 的老内核 click 路径照常兜底。
let _csFiredAt = 0;
function csFireContinue() {
  const now = Date.now();
  if (now - _csFiredAt < 1200) return;
  _csFiredAt = now;
  if (window.continueChat) window.continueChat();
}
if (csBtn) {
  csBtn.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') return; csFireContinue(); });
  csBtn.addEventListener('click', () => { csFireContinue(); });
}
// FIX 2026-09-29 #1419（一加 12/OPPO Chrome 实报「打开了聊天栏继续说按钮，刷新重开又恢复原样」的第二半）：
// 判据改问存储键本身，别再经过 window.replyCfg。合并顺序里 reply-settings.js 排在本文件之后，
// 而站内只有两个重画时机（mochi-restore-done 回填完成、mochi-wrj-heal 小键自愈），这两发都可能落
// 在它把 window.replyCfg 定义出来之前——那时 cfg() 返回 {}，开关明明开着也被算成「关」，而两发都已
// 用完、此后再没有重画口＝按钮一直藏着（无头账本实测：整场只有一次 applyContinueSayUI，它读到的 cfg
// 是 undefined、before/after 都是 none，而同一时刻存档里躺着 '1'）。同排的麦克风/批量发送两枚本来就是
// 直读 store，故无此病；这里向它们看齐。replyCfg 已就绪时仍走它（保留 NaN 兜底与默认值那套语义）。
function contSayOn(key) {
try { if (window.replyCfg) return window.replyCfg()[key] === 1; } catch (e) {}
try { return Number(store.get('reply-' + key)) === 1; } catch (e) { return false; }
}
// 群聊那一排要问同一把尺（它自己那行原来读的是裸键 cs-trigger-bar＝全站没人写的一枚，见 group-chat.js）
window.mochiContinueBarOn = function () { return contSayOn('cs-trigger-bar'); };
window.applyContinueSayUI = function () {
try {
if (pname) pname.title = contSayOn('cs-trigger-name') ? '点击让对方继续说' : '';
if (csBtn) csBtn.style.display = contSayOn('cs-trigger-bar') ? '' : 'none';
document.dispatchEvent(new Event('continue-say-changed')); // 群聊输入栏「继续说」按钮跟随同一开关
} catch (e) {}
};
window.applyContinueSayUI();
// FIX 2026-09-17 #660附（本批输入栏按钮位置实测暴露的旧 bug）：这一行是本文件初始化末尾的
// 首次计算，但 jsFiles 顺序里 reply-settings.js 排在本文件之后 —— 此刻 window.replyCfg 还没
// 定义，cfg() 返回 {}，于是 c['cs-trigger-bar'] === 1 恒为假，设置里开着「聊天栏继续说按钮」
// 也被置成 display:none；而冷启动之后没有任何一次重算时机（只有切联系人 chat.js:91 或再动
// 一次那个开关 reply-settings.js:419 才重算）＝「开关明明是开的，继续说按钮要切一下联系人才
// 肯出现」（旧产物实测复现，与 #660 同批）。mic/batch 两个按钮读 store 直取故无此问题，
// 但它们同样只有初始化那一次同步——localStorage 被清、值由 IDB 回填（iOS 常见）时也会停在
// 隐藏态。三者在数据就绪（回填完成，idb.js 保证必派发）后统一补算一次：此时 replyCfg 与
// 存档值都是最终值。
// FIX 2026-09-29 #1419（一加 12/OPPO Chrome 实报「打开了聊天栏继续说按钮，刷新重开又恢复原样」，多机型同现）：
// 上面那条「数据就绪后补算」只救得了【LS 那一格空着】的设备——回填的判据是「LS 没值才抄库里的」，
// 而这一型是「LS 有值，但那一次磁盘提交被内核回滚成了旧值」：回填见 LS 有值且没标脏，就让位了。
// 真正把新值追回来的是 idb.js 的每键标记合并（wrjMergeFromIdb），它只改 store＋LS，然后派发
// mochi-wrj-heal。输入栏此前没订这一路 ⇒ 库里/存档已是用户刚设的那份、屏上仍按进场时的旧值画，
// 用户视角就是「每次改完重开都回原样」（无头实测：自愈后 store 读到新序且 replyCfg 里 bar=1，
// 而那一排的 flex order 仍是旧序、继续说按钮仍 display:none）。判据零机型／零 UA 分支：
// 只问「自愈那一发落没落」，站内的全站开关 UI 重同步本就统一走这一条广播。
function syncInputBarSwitches() {
try { syncMicBtn(); } catch (e) {}
try { syncBatchBtn(); } catch (e) {}
try { if (window.applyContinueSayUI) window.applyContinueSayUI(); } catch (e) {}
}
document.addEventListener('mochi-restore-done', syncInputBarSwitches);
document.addEventListener('mochi-wrj-heal', syncInputBarSwitches); // FIX 2026-09-29 #1419 自愈落库后输入栏三枚开关型按钮要重画（mic/batch/继续说）
const pAv = document.getElementById('chat-partner-av');
if (pAv) {
pAv.addEventListener('click', (e) => {
e.stopPropagation();
// FIX 2026-09-15 #529 再次点顶部头像＝收起寻踪半框：原恒调 openCkPanel()（内部恒 hidden=false），
// 面板已开时再点纹丝不动＝用户报「再次点击顶部栏头像无法关闭」。改 toggle（开着则关），
// 点外关闭由 p2-features.js 的 #ck-panel document 关闭器负责。无 toggle 时回退旧行为。
if (window.toggleCkPanel) window.toggleCkPanel();
else if (window.openCkPanel) window.openCkPanel();
});
}
const moreCk = document.getElementById('more-ck');
if (moreCk) {
moreCk.addEventListener('click', (e) => {
e.stopPropagation();
if (morePanel) morePanel.hidden = true;
// 聊天「更多功能」寻踪：全屏打开寻踪页（返回时回聊天）
if (window.openCheckinPage) {
window.__ckFrom = 'chat';
window.openCheckinPage();
} else toast('寻踪加载失败');
});
}
const moreCjian = document.getElementById('more-cjian');
if (moreCjian) {
moreCjian.addEventListener('click', (e) => {
e.stopPropagation();
if (morePanel) morePanel.hidden = true;
if (window.openCjian) {
window.__cjianFrom = 'chat';
try { window.openCjian(); } catch (err) {
try { if (window.__jsErrors) window.__jsErrors.push('openCjian: ' + (err && err.message || err)); } catch (e2) {}
toast('此间打开出错，请刷新页面重试');
}
} else toast('此间加载失败，请刷新页面重试');
});
}
let lastMineText = '';
let lastMineIdx = -1;
let lastMineQuote = '';
let lastQuotedText = '';
function syncLastMineText() {
for (let i = msgs.length - 1; i >= 0; i--) {
const m = msgs[i];
if (m && m.side === 'out' && !m.retracted && typeof m.text === 'string' && m.text) {
lastMineText = m.text;
lastMineQuote = quoteSnapOf(m);
lastMineIdx = i;
return;
}
}
lastMineText = '';
lastMineQuote = '';
lastMineIdx = -1;
}
// ===== #650 多字卡「拼接随机标点」：多条字卡拼一条时的中间连接符 =====
// 「拼接随机标点」总开关（py-punct-en，默认开）开启时，每两条字卡的中间从「拼接符号」池
//（py-punct-space 空格 / py-punct-dou ，/ py-punct-per 。/ py-punct-ex ！/ py-punct-q ？/
// py-punct-el ...... / #712 py-punct-dash ——（默认开））随机抽一个相连，每处独立随机。
// 设置页七选 N、至少保留一个（内置+自定义合计）；#712 起另有自定义符号：cfg 附带的
// py-punct-custom＝JSON [{s,on}] 串（reply-py-punct-custom 键原样随读，见 reply-settings.js
// #650 段），只取 on=1 入池。总开关关或池意外全空＝回退单个空格（原行为）。消费点：
// genOneReply（多字卡回复）/ replyOnce 词典拼字单气泡 / genChatStyleReply（ta-ask 同源回应）；
// 设置 UI 在 reply-settings.js #650 段。
// #1198 新增内置「换行」（py-punct-nl，默认关）：抽中即下一张字卡另起一行。同一套符号池自本批起
// 被信箱（ml-punct-en）/朋友圈（fd-punct-en）共用，但各场景自带开关、不吃聊天的 py-en 闸门＝
// 走第三个参数 sceneOn（true＝用符号池 / false＝只用空格）。
// 媒体段（表情包/图片：dataURL、@@m 令牌、sticker:/image: 前缀、http 链接）两侧恒用空格：
// 内联图正则按 [^\s"'<>]+ 取 URL，把标点或换行贴到 URL 尾部会一起吞进去＝图裂。
function pyJoinCards(segs, c, sceneOn) {
if (!Array.isArray(segs) || !segs.length) return '';
if (segs.length === 1) return String(segs[0] == null ? '' : segs[0]);
let pool = null;
// #956 多字卡回复（py-en）是拼卡总开关：「拼接随机标点」是它的子项，总开关关闭时一并失效
//（退回单个空格）。旧口径只看 py-punct-en＝关掉「多字卡回复」后，词典拼字单气泡等形态仍按
// 标点池拼卡＝用户实报「多字卡回复关闭了、拼接随机标点没关，还是能触发多字卡回复」。
const pyJoinOn = !!(c && c['py-en'] === 1 && c['py-punct-en'] === 1); // #956a
// #1198 调用方给了第三参＝本场景自带开关（信箱/朋友圈），不再叠聊天的 py-en/py-punct-en
const usePool = sceneOn === undefined ? pyJoinOn : !!sceneOn;
if (usePool) {
pool = [];
if (c['py-punct-space'] === 1) pool.push(' ');
if (c['py-punct-dou'] === 1) pool.push('，');
if (c['py-punct-per'] === 1) pool.push('。');
if (c['py-punct-ex'] === 1) pool.push('！');
if (c['py-punct-q'] === 1) pool.push('？');
if (c['py-punct-el'] === 1) pool.push('......');
if (c['py-punct-dash'] === 1) pool.push('——'); // #712 内置「——」（默认开）
if (c['py-punct-nl'] === 1) pool.push('\n'); // #1198 内置「换行」（默认关）
// #712 用户自定义符号（reply-py-punct-custom＝[{s,on}] JSON 串；只取 on=1，
// 关掉的自定义符号不进随机池）
let pyc = null;
try { pyc = JSON.parse(c['py-punct-custom'] || '[]'); } catch (e) {}
if (Array.isArray(pyc)) pyc.forEach(it => { if (it && typeof it.s === 'string' && it.s && it.on === 1) pool.push(it.s); });
}
if (!pool || !pool.length) pool = [' '];
const isMediaSeg = s => typeof s === 'string' && (s.indexOf('data:') === 0 || s.indexOf('http') === 0 || s.indexOf('sticker:') === 0 || s.indexOf('image:') === 0 || s.indexOf('@@m:') === 0 || (typeof window !== 'undefined' && !!(window.mochiMediaIsToken && window.mochiMediaIsToken(s))));
let out = String(segs[0] == null ? '' : segs[0]);
for (let i = 1; i < segs.length; i++) out += (isMediaSeg(segs[i]) || isMediaSeg(segs[i - 1]) ? ' ' : pool[Math.floor(Math.random() * pool.length)]) + String(segs[i] == null ? '' : segs[i]);
return out;
}
window.pyJoinCards = pyJoinCards; // 各文件独立作用域：ta-ask.js 互动卡回应/文字题同源复用走 window
// FIX 2026-09-18 #773c 历史错标签自愈（用户要求「清理历史气泡的错标签」）：#773 前一张卡的
// 气泡也可能把「多字卡回复」chip 写进 rec.mood 随消息持久化，判定修好后旧标签不会自己消失。
// 消费点＝normCell 逐条体检（#451 同款存量治愈：幂等，清过不再触发，无需全局 swept 标志；
// 改动走 #402 原位补丁不整窗重建）。判据＝按 #650 连接符池反推拼出的张数：切不出 ≥2 个
// 非空段就视作一张卡。正文自身含连接符的单卡会保守留标——宁残留不误摘（摘错＝真信息丢失，
// 残留只是多一枚旧 chip），与 #773「一张卡的气泡不该标多字卡」同口径。零机型分支。
function pyChipSingleCardText(t, c) {
if (typeof t !== 'string' || !t.trim()) return true; // 空文/纯空白＝不是拼出来的多张
if (t.indexOf('data:') === 0 || (window.mochiMediaIsToken && window.mochiMediaIsToken(t))) return true; // 整条媒体载荷
let seps = null;
if (c && c['py-punct-en'] === 1) {
seps = [];
if (c['py-punct-space'] === 1) seps.push(' ');
if (c['py-punct-dou'] === 1) seps.push('，');
if (c['py-punct-per'] === 1) seps.push('。');
if (c['py-punct-ex'] === 1) seps.push('！');
if (c['py-punct-q'] === 1) seps.push('？');
if (c['py-punct-el'] === 1) seps.push('......');
if (c['py-punct-dash'] === 1) seps.push('——');
try { const pyc = JSON.parse(c['py-punct-custom'] || '[]'); if (Array.isArray(pyc)) pyc.forEach(it => { if (it && typeof it.s === 'string' && it.s && it.on === 1) seps.push(it.s); }); } catch (e) {}
if (!seps.length) seps = null;
}
if (!seps) seps = [' '];
// FIX 2026-09-19 #851 空格恒在切分集内：连接词卡/经期温柔卡固定用空格相接（不走「拼接
// 随机标点」池），用户取消空格或该形态绕开符号池时，只按现池切分会把两张卡切成一段＝误判一张卡、
// 把刚挂上的合法 chip 摘掉。判据方向不变＝宁残留不误摘。
else if (seps.indexOf(' ') < 0) seps.push(' ');
// FIX 2026-09-23 #1051 硬换行恒在切分集内：末尾颜文字卡改 '\n' 相接（根治「末行显示不全」）后，
// 它同样绕开符号池——不把 '\n' 放进切分集，颜文字两卡气泡会被自愈误摘 chip（verify D3）。
if (seps.indexOf('\n') < 0) seps.push('\n');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pieces = t.split(new RegExp(seps.map(esc).sort((a, b) => b.length - a.length).join('|')));
let n = 0;
for (let i = 0; i < pieces.length; i++) if (pieces[i].trim()) n++;
return n < 2;
}
function pyChipDropIfSingle(r) {
try {
if (!r || r.side !== 'in' || !Array.isArray(r.mood) || !r.mood.length) return false;
if (!r.mood.some(md => md && md.tag === '多字卡回复')) return false; // 先走最便宜的门禁，再读 cfg
if (!pyChipSingleCardText(r.text, cfg())) return false;
const kept = r.mood.filter(md => !(md && md.tag === '多字卡回复'));
r.mood = kept.length ? kept : undefined;
return true;
} catch (e) { return false; }
}
// FIX 2026-09-25 #1236「关不掉」观感收口（用户 iPhone17Pro/iOS27 直派「关掉＝造句与标签全停」）：
//   来源 chip 的**显示**跟随各自的总闸——总闸关着时，历史气泡上残留的「多字卡回复 / 词典系列 /
//   梦角自由造句」标签不再渲染出来（此前只有开关开着时才看得到，用户关掉开关仍满屏这些标签，
//   就判定「关不掉」）。只在显示层过滤、不改写 rec.mood 存储：把开关再打开，旧标签原样回来。
//   词典系列 tag 在 qs-en 或 py-en 任一关闭时隐藏＝与 quoteSpellPick 的出牌口径一致（#1236 起
//   py-en 是拼字总闸）。判据只取存储值，零机型／零 UA 分支。
function srcTagHidden(tag) {
if (tag !== '梦角自由造句' && tag !== '多字卡回复' && tag !== '词典' && tag !== '词典拼字' &&
tag !== '词典拼句' && tag !== '词典拼词' && tag !== '词典逐卡连发') return false;
try {
const n = (k, d) => { const v = store.get('reply-' + k); if (v === null || v === undefined || v === '') return d; const x = Number(v); return isNaN(x) ? d : x; };
const pyOn = n('py-en', 1) === 1, qsOn = n('qs-en', 1) === 1, mjfOn = n('mjf-en', 1) === 1;
if (tag === '梦角自由造句') return !mjfOn;
if (tag === '多字卡回复') return !pyOn;
return !qsOn || !pyOn;
} catch (e) { return false; }
}

// v3.43.x #677 「多字卡回复」来源 tag 判定：genOneReply 内 多字卡回复(py-en) 抽卡分支命中且掷到
// ≥2 张时置位（每次生成先重置），replyOnce 据此给本条（批）气泡挂 tag；与词典/词典拼字 tag 共存
let pyMultiDrawn = false;
// FIX 2026-09-19 #814c 「同款两张」改在取卡源头重掷（配套 #814 收件侧内容窗停吞）：回复链每条
// 气泡各调一次 genOneReply，连续两次抽中完全同一张卡（贴纸池小、文字池撞车）过去靠 #256 内容窗
// 事后折回一张——代价是把合法第二条一起吞掉（本批报障主因）。现改为源头防：本次抽卡与本桌面
// 上一条回复「同正文＋同类型＋同图段指纹」时重掷一次；重掷仍同（池子就一张）接受两张同款展示，
// 绝不删。零存储、零机型分支。
let __genLastCid = null, __genLastSig = '';
function chatGenRepSig(r) {
if (!r) return '';
let s = (r.type || '') + '|' + (typeof r.text === 'string' ? r.text : '');
try {
const ps = r.parts;
if (Array.isArray(ps)) for (let i = 0; i < ps.length; i++) { const p = ps[i]; if (p && p.k === 'img') s += '|i:' + (p.sub || '') + ':' + (typeof p.v === 'string' ? p.v.slice(0, 96) : ''); }
} catch (e) {}
return s;
}
function genOneReply(c) {
let rep = genOneReplyDraw(c), sig = chatGenRepSig(rep);
try {
const cid = window.__activeCid || 'default';
if (sig && cid === __genLastCid && sig === __genLastSig) {
const rep2 = genOneReplyDraw(c), sig2 = chatGenRepSig(rep2);
if (sig2 && sig2 !== sig) { rep = rep2; sig = sig2; } // 池子太小仍掷不出第二张＝接受同款，不删已生成消息
}
__genLastCid = cid; __genLastSig = sig;
} catch (e) {}
return rep;
}
function genOneReplyDraw(c) {
const pool = getPool();
let t, type = 'text';
pyMultiDrawn = false;
if (c['py-en'] === 1 && hit(c['py-prob']) && pool.text.length) {
const nbTextPool = pool.text.filter(s => typeof s === 'string' && s.trim()); // FIX 2026-09-05 #185 多字卡拼接前先滤空白卡（否则 join 出纯空格空气泡）
const n = randInt(c['py-min'], c['py-max']);
const segs = pickN(nbTextPool.length ? nbTextPool : pool.text, n);
// #677 掷到 1 张（用户把多字卡回复设成 1~1）不挂 tag：单个字卡与普通回复无从区分，标了反而误读
// FIX 2026-09-18 #773 判据改用实际拼出的 segs.length，不用掷出的 n：pickN 无放回、池空即停，
// 可用文字卡不足 n 张时只拼出更少张（旧写法 n>=2 就挂 tag＝一张卡的气泡标「多字卡回复」）
if (segs.length >= 2) pyMultiDrawn = true;
t = pyJoinCards(segs, c); // #650 中间连接符走「拼接随机标点」符号池（关＝空格，原样）
} else {
const r = genReplyText(c);
t = r.text;
type = r.type;
// FIX 2026-09-19 #851 普通回复里按「颜文字概率」追加一张颜文字卡＝这条气泡也是两张字卡，
// 与多字卡抽卡分支同口径挂来源 tag（此前该形态永远不标，用户实报「两张字卡却没有多字卡回复」）
if (r.cards >= 2) pyMultiDrawn = true;
// FIX 2026-09-16 #624 表情包+图片概率同时命中时 genReplyText 已组好「两张图一条消息」的
// parts，直接原样返回——不再走下方默认字卡覆盖（会把文本换掉）与单图追加（会再叠一张）。
if (r.parts && r.parts.length) return { text: t, type: 'text', parts: r.parts };
}
if (type === 'sticker' || type === 'image' || type === 'voice') {
return { text: t, type: type };
}
// #370c：csp-cust「自定义字卡占比」——TA 的纯文字回复里多大比例保留自定义字卡。
// getDefaultCards() 命中时本会用预设默认字卡覆盖刚抽好的自定义文本；这里按 csp-cust
// 掷签：命中（保留自定义，默认 50%）就跳过默认字卡覆盖，未命中才让默认字卡覆盖。
const cspCust = Number(c['csp-cust'] !== undefined ? c['csp-cust'] : 50);
const keepCustomText = isFinite(cspCust) && hit(cspCust);
const defs = (window.getDefaultCards && window.getDefaultCards()) || null;
if (defs && !keepCustomText && defs.type === 'text' && defs.text) {
	// FIX 2026-09-18 #773 整条换成一张默认字卡＝已不是多字卡，来源 tag 必须一起回冲
	t = defs.text; pyMultiDrawn = false;
}
const replyWord = (window.getReplyCard && window.getReplyCard()) || '';
if (replyWord) {
t = replyWord; pyMultiDrawn = false; // FIX 2026-09-18 #773 同上：聊天回应字卡整条替换成一张
}
// FIX 2026-09-05 #185 最终非空兜底：固定回复字卡（getReplyCard）/默认主字卡（defs.text）被设成
// 空白内容时会无条件覆盖抽好的回复，必须在此拦下，否则联系人持续发空气泡
// FIX 2026-09-18 #773b 全空白池拼出空文即将被下面兜底换成一张＝回冲，一张卡不得挂「多字卡回复」
//（#185 原行一字未动＝其哨兵 needle 仍钉在原形态上）
if (pyMultiDrawn && (typeof t !== 'string' || !t.trim())) pyMultiDrawn = false;
if (typeof t !== 'string' || !t.trim()) t = pick(FALLBACK_REPLY_POOL);
// #1203 总开关关闭＝这条气泡只用一张字卡：末尾不再追加连接词卡（旧写法只认 cf-prob＝关了总开关仍有 20%
// 的回复被拼上第二张、还挂「多字卡回复」chip＝本次报障主因，每五条中一次）；「整条替换成一张回应字卡」不受影响
if (c['py-en'] === 1 && hit(window.dcpEff ? window.dcpEff(c['cf-prob']) : c['cf-prob'])) { // FIX 2026-09-15 #518 连接词追加套系统预设字卡总档
const w = (window.getFollowupWord && window.getFollowupWord(t)) || '';
// FIX 2026-09-19 #851 连接词是一张独立字卡（空格相接）＝这条气泡两张卡，同口径挂来源 tag
if (w) { t += ' ' + w; pyMultiDrawn = true; }
}
const parts = [{ k: 'text', v: t }];
if (hit(c['sticker-prob'] || 0)) {
const st = (window.getMediaCards && window.getMediaCards('sticker')) || [];
if (st.length) parts.push({ k: 'img', v: st[Math.floor(Math.random() * st.length)], sub: 'sticker' });
} else if (hit(c['image-prob'] || 0)) {
const im = (window.getMediaCards && window.getMediaCards('image')) || [];
if (im.length) parts.push({ k: 'img', v: im[Math.floor(Math.random() * im.length)], sub: 'image' });
}
return { text: t, type: 'text', parts: parts.length > 1 ? parts : null };
}
// v3.43.x #447：互动卡片「接聊天字卡」同源回应生成器——ta-ask.js 文字题/单选题开启开关后
// 按普通聊天完整链路生成一条回应（与 replyOnce 同序）：公用+专属字卡（getPool 按 py-en
// 概率抽卡）→ genReplyText 兜底 → 系统字卡（csp-cust 概率让位默认字卡）→ 固定回复字卡/
// 追问/表情贴图，再词典拼字（quoteSpellPick，qs-en 总开关）命中整条替换。返回纯文本
//（拼字 segs 空格连，固定单气泡形态）；理论上 genOneReply 必有兜底文本，异常才返回 null。
window.genChatStyleReply = function () {
let rep = null;
try { rep = genOneReply(cfg()); } catch (e) {}
try {
const _sp = (window.quoteSpellPick && window.quoteSpellPick(cfg())) || null;
const segs = _sp && Array.isArray(_sp.segs) ? _sp.segs : (Array.isArray(_sp) ? _sp : null);
if (segs && segs.length) return pyJoinCards(segs, cfg()); // #650 连接符同走符号池
} catch (e) {}
// FIX 2026-09-16 #624 多图消息（text 是图片载荷 + parts）没有可当文字用的正文——
// 不把 data: 串当「聊天字卡文本」返回（否则 ta-ask 会把它当文本发出）。
// FIX 2026-09-20 #948 补齐 #624f 漏掉的「单张」形态：genOneReply 抽中一张表情包/图片/语音
// 卡时返回 {text: 整个媒体载荷, type:'sticker'|'image'|'voice'}（没有 parts），旧守卫的条件
// 带 rep.parts 判定，单卡形态整串 base64 就这样被当「文字回应」raw 直传进 addInTyped＝用户
// 所见「聊天里的图片变成长乱码」。本函数契约是「返回一条纯文字回应」，任何媒体形态一律不返回。
const t = rep && typeof rep.text === 'string' ? rep.text.trim() : '';
const _isMediaRep = !!(rep && (rep.type === 'sticker' || rep.type === 'image' || rep.type === 'voice' ||
(rep.parts && rep.parts.length && chatIsMediaPayload(rep.text)) || chatIsMediaPayload(rep.text)));
return (t && !_isMediaRep) ? t : null;
};
let autoTimer = null;
function scheduleAutoSend() {
clearTimeout(autoTimer);
const c = cfg();
if (cfgn(c, 'as-en', 1) !== 1) {
autoTimer = setTimeout(scheduleAutoSend, 30000);
return;
}
let asMin = Math.min(600, Math.max(1, Number(cfgn(c, 'as-min', 5)) || 5)) * 60;
let asMax = Math.min(600, Math.max(1, Number(cfgn(c, 'as-max', 10)) || 10)) * 60;
if (cfgn(c, 'dnd-en', 0) === 1) { asMin = 30 * 60; asMax = 180 * 60; }
if (asMax < asMin) asMax = asMin;
const delay = (asMin + Math.random() * Math.max(1, asMax - asMin)) * 1000;
autoTimer = setTimeout(() => {
tryAutoSend();
scheduleAutoSend();
}, delay);
}
window.rescheduleAutoSend = function () { try { scheduleAutoSend(); } catch (e) {} };
document.addEventListener('contact-switched', function () {
try { if (window.replyCfg) scheduleAutoSend(); } catch (e) {}
});
// FIX 2026-09-30 #1465 主动发送「回前台补掷一轮」：整条主动消息链是页面内 setTimeout（scheduleAutoSend），
// 后台被冻结/丢弃（Edge 睡眠标签页/Chrome 内存节省程序/ROM 省电整页冻结/iOS 挂起）期间错过的轮次永远丢失，
// 回前台还要重新等满间隔才掷第一签——ta-ask 互动卡/备忘录/经期关心/心意币申请都有回前台补触发通道，
// 唯独主动发送没有（报障形态＝「概率设了 60%，一天都没触发」，页面死多久就欠多久，机型无关）。
// 补掷判据（纯时序、零机型/零 UA 分支）：①本页寿命内真见过一次 hidden（冷启动没离开过不补，首轮仍由正常
// 定时器出；唯一例外＝document.wasDiscarded 回载——页面是被浏览器丢掉后才重载的，回来即视同长离场）；
// ②离场时长 ≥ 当前口径的最短间隔（含免打扰 30 分钟档）＝期间确实欠了一轮；③距上一轮开掷 ≥ 同阈值
//（后台节流迟到的旧定时器先跑就让它赢＝双通道天然去重，回场瞬间不双掷）。补掷动作＝清掉过期挂起定时器
// → tryAutoSend() → scheduleAutoSend() 重排下一轮；夜间模式/开关/概率/字卡池判定全部复用原链路，本处不加新分支。
let asHiddenAt = 0, asLastTryAt = 0, asCatchupAt = 0, asCatchupTries = 0;
function asCatchupMinMs(c) {
if (cfgn(c, 'dnd-en', 0) === 1) return 30 * 60000; // 免打扰档与 scheduleAutoSend 的 30 分钟下限同源
return Math.min(600, Math.max(1, Number(cfgn(c, 'as-min', 5)) || 5)) * 60000;
}
function asForegroundCatchup() {
try {
if (document.visibilityState !== 'visible') return;
const now = Date.now();
if (now - asCatchupAt < 5000) return; // 一次回场多通道报到只算一次（页面可见性切换／后台保活统一信号）
if (!window.replyCfg) { if (++asCatchupTries <= 6) setTimeout(asForegroundCatchup, 1500); return; } // 回复设置未就绪不空掷（空配置会拿默认 30% 冒充用户设的概率）；合并戳在闸后再盖＝重试不被 5 秒窗吞掉
asCatchupAt = now;
if (!asHiddenAt && document.wasDiscarded !== true) return; // 冷启动起就没离开过＝没有「错过的轮」可补
const away = asHiddenAt ? now - asHiddenAt : Infinity;
asHiddenAt = 0;
const c = cfg();
if (cfgn(c, 'as-en', 1) !== 1) return;
const minMs = asCatchupMinMs(c);
if (away < minMs) return; // 短离场：正常定时器还挂着，不抢
if (now - asLastTryAt < minMs) return; // 上一轮刚开掷过（含后台节流迟到的旧定时器先跑）＝不双掷
clearTimeout(autoTimer);
tryAutoSend();
scheduleAutoSend();
try { console.log('[mochi-auto] fg catchup fired, away_ms=%s', away); } catch (e) {}
} catch (e) {}
}
document.addEventListener('visibilitychange', function () {
if (document.visibilityState === 'hidden') asHiddenAt = Date.now();
else asForegroundCatchup();
});
document.addEventListener('mochi-fg-resume', asForegroundCatchup); // bg-keep 统一信号：覆盖只发 focus/pageshow 的内核与 bfcache 恢复
if (typeof document.wasDiscarded !== 'undefined' && document.wasDiscarded === true) setTimeout(asForegroundCatchup, 4000); // 被丢弃后重载＝长离场回场（手动刷新不走这里）
window.__asCatchupProbe = { fire: asForegroundCatchup, state: function () { return { hiddenAt: asHiddenAt, lastTry: asLastTryAt, catchupAt: asCatchupAt }; } }; // 供 verify 脚本/诊断只读探测
// FIX 2026-09-04 #158 本池是「我」拒绝 TA 邀请后自己发的婉拒话术，逐条必须是拒绝者视角；原第二条「等会儿再陪我玩好不好」是邀请者(TA)口吻（陪我玩=要对方陪），用户误以为该由联系人发送，改为「等会儿再陪你玩好不好」
// v3.14.x：贴贴邀请（cuddle）——正常情侣贴贴互动（贴/抱/牵手/靠着），没有游戏半框：
// 同意后轻震动一下（体感反馈），TA 稍后回应一句贴贴的话；婉拒用专属文案
// #1422（作者 2026-09-29「把没在库里的 6 个预设池加进系统预设页」）：这三池的预设语**单一数据源**
//   已迁至 default-cards-data.js 的 DEFAULT_CARD_DATA.interact（同名分组「游戏邀请·婉拒」
//   「贴贴·婉拒」「贴贴·回应」），字卡库→系统预设字卡→其他互动功能字卡→互动回应 同源展示、
//   逐句开关（dc-off-interact:<文案>）与整组停用都生效；下面三个数组只留作**数据缺失时的兜底**
//   （同 v3.14.x 经期关心的做法，勿当数据源改）。取用一律走 presetReplyPick(分组名, 兜底)——
//   ⚠ 必须在调用时取：本文件先于 default-cards.js 加载，模块初始化时窗口出口还不存在。
const INVITE_DECLINE = ['下次吧，现在不太想玩~', '等会儿再陪你玩好不好', '先不玩啦，待会儿再说', '现在没状态，下次一定'];
const CUDDLE_DECLINE = ['下次再贴吧，先记着这笔~', '等会儿补给你，说话算数', '先欠着，攒到晚上一起还~', '今天想先自己待会儿，明天加倍还你'];
const CUDDLE_REPLIES = ['嗯……蹭到了。暖暖的，很喜欢。', '那我要贴很久哦，不许偷偷跑掉。', '手被握住了，就这样待一会儿。', '感觉到了，你在旁边。很安心。', '贴贴充电中……好，满格了。'];
// #1422：取一句该组现存的预设语。返回空串＝用户把这一组逐句关掉/整组停用（＝真停用），
//   调用方必须「什么都不说」，不许回落兜底句、更不许抓别的组顶上。
function presetReplyPick(group, fallback) {
try {
if (typeof window.getPresetGroupLines === 'function') {
const l = window.getPresetGroupLines(group, fallback);
return l.length ? pick(l) : '';
}
} catch (e) {}
return fallback.length ? pick(fallback) : '';
}
// v3.26.x(#122)：注册聊天内置系统回应池跨分类搜索（字卡库列表页搜索同源可查，不再搜不到）
// #1422：三池已进系统预设，chatcard.js 的「默认聊天字卡」登记项会遍历 DEFAULT_CARD_DATA 全部分类
//   自动收录它们（标成「[互动回应] 分组名」），此处再列一遍＝同一句搜出两行，故只留没进库的那池。
window.__cardSearchFns = window.__cardSearchFns || [];
window.__cardSearchFns.push({ name: '聊天系统回应', fn: function (kw) {
  const out = [];
  try {
    FALLBACK_REPLY_POOL.forEach(c => { if (String(c).toLowerCase().indexOf(kw) >= 0) out.push({ t: String(c), cat: '兜底回复' }); });
  } catch (e) {}
  return out;
} });
// FIX 2026-09-15 #510 邀请确认弹窗支持 onDecline 可选回调（仅贴贴传入）：用户报「联系人发来的
// 亲亲/贴贴申请弹窗，我同意后系统消息里没有相关消息」——口径对齐换头像邀请（avatar-lib replyMeInvite）
// 与听歌邀请（music-player sm-req-*）：同意/拒绝都写一条 chatAddSystem 留痕。
// 猜拳/游戏类邀请不传 onDecline，保持原样（对局结束另有系统消息，避免同一件事留痕两次）。
function openInviteConfirm(title, staticText, onAccept, declinePool, declineGroup, onDecline) {
const mask = document.getElementById('modal-mask');
if ((mask && !mask.hidden) || !window.openModal) { onAccept(); return; }
window.openModal(title, '', (v) => {
if (v === '1') onAccept();
else if (typeof onDecline === 'function') onDecline();
// #1422：婉拒句改从系统预设取（分组名随邀请类型走），整组/逐句关掉就什么都不发——
//   这句是「我」发的婉拒，关掉后留空比抓别的组顶上去诚实。
else { const _dl = presetReplyPick(declineGroup || '游戏邀请·婉拒', declinePool || INVITE_DECLINE); if (_dl) addOut(_dl); }
}, {
noInput: true,
lock: true,
pills: [{ label: '同意', value: '1' }, { label: '拒绝', value: '0' }],
pill: '1', // v3.16.x：邀请弹窗默认选中「同意」，无需手动点选直接确定
staticText: staticText
});
}
// ==== #1435：贴贴邀请的「挂起等待」：弹窗本体（形态抄 openInviteConfirm，一字不差：锁屏、
// 默认选中「同意」、不自动关）＋ 挂起状态机（落盘/重投时机/超时）。====
// 为什么必须拆开：旧链路里那一句 `if ((mask && !mask.hidden) ...) { onAccept(); return; }`
// 是「弹窗没弹出来却算用户同意了」的根因——屏幕上已有别的层时，贴贴直接静默通过；页面在后台、
// 被冻结、或 700~1400ms 那一跳正好赶上刷新，回调就永远不跑，这条邀请彻底消失（聊天里只留一句
// 「TA 想贴贴」）。现在：同意/拒绝都只由这条弹窗的回调落一次，弹不出去＝挂着重投，不算任何结局。
// 挂起键 records-cuddle-pending 与主页记录 records-cuddle 都走联系人桌面命名空间，
// 「切后台回来还能看到」因此同时覆盖同一会话内切走、切桌面、以及刷新/冷启动三种情形。
const CP_KEY = 'records-cuddle-pending';
const CP_HOLD_MS = 10 * 60 * 1000; // 作者选的那档：10 分钟内回来就还在，超时＝错过未回应
const CP_TICK_MS = 20 * 1000;       // 只在有挂起时才跑的心跳；没有挂起自动停
let _cpLive = null;                 // 当前挂在屏上的那一条：{ ts, title }
function _cpStore(cid) { return (cid && window.storeFor) ? window.storeFor(cid) : store; }
function _cpLoad(cid) {
try { const v = _cpStore(cid).get(CP_KEY); if (!v) return null; const p = JSON.parse(v); return (p && p.ts) ? p : null; } catch (e) { return null; }
}
function _cpSave(cid, p) { try { _cpStore(cid).set(CP_KEY, JSON.stringify(p)); } catch (e) {} }
function _cpClear(cid) { try { _cpStore(cid).remove(CP_KEY); } catch (e) {} }
// 别的层占屏＝让路（不是同意）；与跨桌面那族的 layerBusy 同一批选择器，含应用锁
function _cpBusy() {
return ['modal-mask', 'tc-mask', 'qa-mask', 'call-mask', 'applock-mask'].some(function (id) {
const el = document.getElementById(id);
return el && !el.hidden;
});
}
// 这一条现在是不是就在我眼前（用于「已在屏上就别重开」与「被顶掉后要能再投」）
function _cpOnScreen(ts) {
if (!_cpLive || (ts && _cpLive.ts !== ts)) return false;
const mask = document.getElementById('modal-mask');
const tEl = document.getElementById('modal-title');
return !!(mask && !mask.hidden && tEl && tEl.textContent === _cpLive.title);
}
let _cpTimer = null;
function _cpStart() { if (!_cpTimer) _cpTimer = setInterval(_cpTick, CP_TICK_MS); }
function _cpStop() { if (_cpTimer) { clearInterval(_cpTimer); _cpTimer = null; } }
function _cpCids() {
const out = [window.__activeCid || 'default'];
try { (window.getContacts() || []).forEach(function (c) { if (c && c.id && out.indexOf(c.id) < 0) out.push(c.id); }); } catch (e) {}
return out;
}
function _cpAny() { return _cpCids().some(function (cid) { return !!_cpLoad(cid); }); }
function _cpTick() {
_cpCids().forEach(_cpPump);
if (!_cpAny()) _cpStop(); // 全部落定（答完/过期）就撤掉心跳，不留常驻定时器
}
// 一次投喂：过期就收尾成「错过未回应」；不是当前桌面/在后台/有别的层就继续等
function _cpPump(cid) {
const p = _cpLoad(cid);
if (!p) return false;
if (Date.now() - (p.ts || 0) > CP_HOLD_MS) {
_cpClear(cid);
try { if (window.setCuddleRecordResult) window.setCuddleRecordResult(cid, p.ts, 'missed'); } catch (e) {}
return false;
}
if (cid !== (window.__activeCid || 'default')) return false;
if (document.hidden) return false;
// 先认自己那条：已经在屏上就是「没关、还在等」，什么都不做（顺序不能倒——判占屏会把自己也算进去）
if (_cpOnScreen(p.ts)) return true;
if (_cpBusy()) return false;
return _cpOpen(p, cid);
}
// 弹窗本体：只在这条挂起确实归当前桌面、且屏幕空得下来时开
function _cpOpen(p, cid) {
if (!window.openModal) return false;
const name = p.name || chatPartnerName();
const title = name + ' 的贴贴邀请';
_cpLive = { ts: p.ts, title: title };
window.openModal(title, '', (v) => {
_cpLive = null;
const accepted = v === '1';
// 系统消息先落（记录动作），TA 的回应/婉拒随后——顺序沿用 #510 的口径
try { if (window.chatAddSystem) window.chatAddSystem(accepted ? '你接受了 ' + name + ' 的贴贴邀请' : '你拒绝了 ' + name + ' 的贴贴邀请'); } catch (e) {}
try { if (window.setCuddleRecordResult) window.setCuddleRecordResult(cid, p.ts, accepted ? 'replied' : 'declined'); } catch (e) {}
try { if (window.clearCuddleInvitePending) window.clearCuddleInvitePending(cid, p.ts); } catch (e) {}
if (accepted) { try { openInvitePanelFor('cuddle', name); } catch (e) {} }
else { try { const _cl = presetReplyPick('贴贴·婉拒', CUDDLE_DECLINE); if (_cl) addOut(_cl); } catch (e) {} }
}, {
noInput: true,
lock: true,
pills: [{ label: '同意', value: '1' }, { label: '拒绝', value: '0' }],
pill: '1', // 与 openInviteConfirm 同款默认选中「同意」
staticText: name + ' ' + (p.text || '')
});
return true;
}
window.queueCuddleInvite = function (payload) {
try {
payload = payload || {};
const cid = payload.cid || window.__activeCid || 'default';
const p = { ts: payload.ts || Date.now(), text: payload.text || '', name: payload.name || '' };
_cpSave(cid, p);
// 主页「邀请贴贴」那一行先以「待回应」落账，结局由 _cpOpen 的回调或超时改写（同一 ts，不另起行）
try { if (window.addCuddleRecordFor) window.addCuddleRecordFor(cid, { ts: p.ts, text: p.text, res: 'pending' }); } catch (e) {}
_cpPump(cid);
_cpStart();
return true;
} catch (e) { return false; }
};
window.clearCuddleInvitePending = function (cid, ts) {
try {
const p = _cpLoad(cid);
if (p && (!ts || p.ts === ts)) _cpClear(cid);
if (!_cpAny()) _cpStop();
return true;
} catch (e) { return false; }
};
// 供外部（探针/其他补弹通道）查询：某一条贴贴弹窗此刻是不是挂在屏上
window.cuddleInvitePopupLive = function (ts) { return _cpOnScreen(ts); };
// 回前台（bg-keep 统一信号）／切桌面／数据回填完成——三个「屏幕大概空得下来」的时刻各补投一次
['mochi-fg-resume', 'contact-switched', 'mochi-restore-done'].forEach(function (ev) {
try {
document.addEventListener(ev, function () {
_cpPump(window.__activeCid || 'default');
if (!_cpAny()) _cpStop();
});
} catch (e) {}
});
try { if (window.mochiOnDataReady) window.mochiOnDataReady(function () { _cpPump(window.__activeCid || 'default'); if (_cpAny()) _cpStart(); }); } catch (e) {}
function openInvitePanelFor(kind, name) {
if (kind === 'cuddle') {
try { if (navigator.vibrate) navigator.vibrate([30, 60, 90]); } catch (e) {}
try { const _cr = presetReplyPick('贴贴·回应', CUDDLE_REPLIES); if (_cr) addInTyped(name + ' ' + _cr); } catch (e) {}
return;
}
if (kind === 'rps') { if (window.openRpsPanel) window.openRpsPanel(); return; }
if (kind === 'pong') {
const ids = ['poke-card', 'emoji-panel', 'chat-ask-panel', 'chat-search', 'chat-divine-panel', 'chat-decision-panel', 'chat-rps-panel', 'chat-rp-panel', 'chat-call-panel'];
ids.forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
if (window.closeAvlib) window.closeAvlib();
if (window.openPongPanel) window.openPongPanel();
return;
}
if (kind === 'snake') { if (window.openSnakePanel) window.openSnakePanel(); return; }
// #301：四款新游戏邀请直达（面板 open 前游戏文件各自收兄弟半框）
if (kind === 'gomoku') { if (window.openGomokuPanel) window.openGomokuPanel(); return; }
if (kind === 'linkup') { if (window.openLinkupPanel) window.openLinkupPanel(); return; }
if (kind === 'match3') { if (window.openMatch3Panel) window.openMatch3Panel(); return; }
if (kind === 'auction') { if (window.openAuctionPanel) window.openAuctionPanel(); return; }
}
const INVITE_KIND_META = {
rps: { title: '猜拳邀请' },
pong: { title: '游戏邀请' },
snake: { title: '游戏邀请' },
gomoku: { title: '游戏邀请' },
linkup: { title: '游戏邀请' },
match3: { title: '游戏邀请' },
auction: { title: '游戏邀请' },
cuddle: { title: '贴贴邀请' }
};
function sendTaInvite(inv, name) {
const meta = INVITE_KIND_META[inv && inv.kind] || INVITE_KIND_META.rps;
// v3.16.x：邀请消息带 gInv 游戏类型字段（渲染仍走 poke），供聊天统计「小游戏记录」识别 TA 主动邀请
addIn(name + ' ' + (inv.text || ''), { special: 'poke', initiative: true, gInv: inv.kind });
showTyping();
setTimeout(() => {
hideTyping();
// FIX 2026-09-15 #510 贴贴邀请：同意（你接受了…）/拒绝（你拒绝了…）各落一条系统消息，
// 与听歌邀请、换头像邀请同款留痕；原链路同意只震动+TA 回应一句、拒绝只发婉拒话术，
// 聊天记录里没有任何系统消息 → 用户报「同意后系统消息里没有相关消息」。
// 顺序：系统消息先落（记录动作），TA 的回应/婉拒话术随后，时间线符合直觉。
const _cuddleInv = inv.kind === 'cuddle';
// #1435（作者「邀请贴贴弹窗是和其他提问弹窗一样不会自己关闭，切换后台回来也能看到」）：
// 贴贴这一路改走「先落挂起＋主页记录，再尽力弹窗」——弹不出去（别的层占屏／页面在后台／
// 正好被冻结刷新）不算回答，由本文件下方那份挂起状态机（CP_KEY 那段）在 10 分钟内挑屏幕
// 空得下来的时机重投，超时才记「错过未回应」。挂起与状态机都收在 chat.js：它要读 openInvitePanelFor/
// CUDDLE_DECLINE/chatAddSystem 这些只有聊天页才有的东西，放 ta-invite.js（纯题库模块）就得把这些反向暴露出去。
// window.queueCuddleInvite 缺失（本文件没装载到的极端场景）才退回旧链路，至少不静默吞掉这次邀请。
if (_cuddleInv && window.queueCuddleInvite) {
try { window.queueCuddleInvite({ name: name, text: inv.text || '' }); } catch (e) {}
return;
}
openInviteConfirm(name + ' 的' + meta.title, name + ' ' + (inv.text || ''), () => {
if (_cuddleInv && window.chatAddSystem) window.chatAddSystem('你接受了 ' + name + ' 的贴贴邀请');
openInvitePanelFor(inv.kind, name);
}, _cuddleInv ? CUDDLE_DECLINE : null, _cuddleInv ? '贴贴·婉拒' : '游戏邀请·婉拒', _cuddleInv ? () => {
if (window.chatAddSystem) window.chatAddSystem('你拒绝了 ' + name + ' 的贴贴邀请');
const _cl = presetReplyPick('贴贴·婉拒', CUDDLE_DECLINE); if (_cl) addOut(_cl);
} : null);
}, randInt(700, 1400));
}
window.sendTaInvite = sendTaInvite;
function tryActiveInvite(c) {
if (!chatVisible()) return false;
const name = chatPartnerName();
let inv = null;
if (window.taInviteDraw) {
inv = window.taInviteDraw(c);
} else {
if (cfgn(c, 'ai-rps-en', 1) === 1 && hit(cfgn(c, 'ai-rps-prob', 8))) inv = { kind: 'rps', text: '想和你猜拳，来一局？' };
else if (cfgn(c, 'ai-game-en', 1) === 1 && hit(cfgn(c, 'ai-game-prob', 5))) { // #301：邀请池扩到六款（原 pong/snake 二选一）
const GINV_POOL = [
{ kind: 'pong', text: '想和你玩一局 Pong，来吗？' },
{ kind: 'snake', text: '想和你玩双人贪吃蛇，来吗？' },
{ kind: 'gomoku', text: '想和你玩一局五子棋，来吗？' },
{ kind: 'linkup', text: '来玩连连看嘛，一起清完整张棋盘' },
{ kind: 'match3', text: '一起玩消消乐呀，冲个目标分' },
{ kind: 'auction', text: '拍卖会上新啦，来跟我抢拍品呀' }
];
inv = GINV_POOL[Math.floor(Math.random() * GINV_POOL.length)]; }
}
if (!inv || !inv.text) return false;
sendTaInvite(inv, name);
return true;
}
window.triggerTaInviteNow = function () {
// #1015：点「让TA邀请我」——邀请记录带 initiative（形态上是 TA 主动发起的邀请），夜里必须
// 显式放行，否则「点了没反应」。置对话窗口，与 continueChat 同口径。
nightOpenReply();
try {
const name = chatPartnerName();
const inv = window.taInvitePickAny ? window.taInvitePickAny() : null;
if (!inv || !inv.text) { toast('TA的邀请题库没有可用内容'); return false; }
sendTaInvite(inv, name);
if (window.replyGuideHint) window.replyGuideHint('inv'); // v3.27.x #218 互动频率引导（邀请半框弹出时提醒可调）
return true;
} catch (e) { return false; }
};
// v8.29 #1003：贴贴邀请手动触发（聊天「更多功能 → TA的提问 → 贴贴」）。走 taInvitePickKind('cuddle')
// 只在贴贴池里抽——不复用上面的 taInvitePickAny（全类型随机，那是「邀请」那枚的口径，
// 用户要的是点贴贴就一定是贴贴）。其余链路与「邀请」完全同源：同一个 sendTaInvite
// （猜拳类开半框／贴贴类弹同意-拒绝确认、同意轻震+TA 回应、拒绝写系统消息+婉拒话术）。
window.triggerTaCuddleNow = function () {
try {
const name = chatPartnerName();
const inv = window.taInvitePickKind ? window.taInvitePickKind('cuddle') : null;
if (!inv || !inv.text) { toast('TA的邀请题库里没有可用的贴贴话术'); return false; }
sendTaInvite(inv, name);
if (window.replyGuideHint) window.replyGuideHint('inv');
return true;
} catch (e) { return false; }
};
window.tryActiveInvite = tryActiveInvite;
function tryAutoSend() {
try {
asLastTryAt = Date.now(); // #1465 补掷去重锚：任何一轮真实开掷（含后台节流迟到的旧定时器）先盖章，回前台补掷据此让位
// 夜间模式（设置里开启后 22:00–7:00 生效）：联系人不再主动发消息（拍一拍/邀请/查岗同链一并暂停）
if (window.nightModeActive && window.nightModeActive()) { try { console.log('[mochi-auto] night mode, skip'); } catch(e){} return; }
const c = cfg();
// FIX 2026-09-05 #187 专属字卡串桌面：tryAutoSend 异步链（await 取回字卡可数秒+每条消息
// setTimeout 再数百~2600ms）此前无 sameCid 守卫——B 桌面触发的主动消息在用户切到 A 桌面后
// 才发出，B 池的专属字卡落进 A 桌面聊天（vivo/多机型报障，与设备无关；scheduleReply/
// replyOnce 均有守卫，唯独主动消息漏了）。入口捕获 cid，await 后与每个定时器逐层拦截。
const autoCid = window.__activeCid || 'default';
const sameAutoCid = () => (window.__activeCid || 'default') === autoCid;
try { console.log('[mochi-auto] tryAutoSend called as-en=%s as-prob=%s as-min=%s as-max=%s', cfgn(c,'as-en',1), cfgn(c,'as-prob',30), cfgn(c,'as-min',5), cfgn(c,'as-max',10)); } catch(e){}
if (cfgn(c, 'as-en', 1) !== 1) { try { console.log('[mochi-auto] as-en OFF, skip'); } catch(e){} return; }
let prob = cfgn(c, 'as-prob', 30);
if (!(prob > 0)) prob = 30;
if (cfgn(c, 'dnd-en', 0) === 1) prob = 10;
if (!hit(prob)) return;
if (hit(cfgn(c, 'touch-prob', 5))) { performPoke(); return; }
if (tryActiveInvite(c)) return;
if (window.ckQuestionTry && window.ckQuestionTry(c)) return;
// v3.27.x：主动发送前先确保字卡池就绪——冷启动挂起大键时同步读池是空库，
// 主动消息也会落「在吗？」兜底；等待取回完成再构建 pool（专属优先、上限 8s 对齐 IDB）
(async () => {
try { await ensureReplyCardsReady(); } catch (e) {}
if (!sameAutoCid()) return; // FIX #187 取回期间已切桌面：池子是旧桌面的，整条主动消息放弃
const pool = getPool();
const autoMsg = () => {
// v3.26.x #163：主动消息此前完全不走默认字卡概率——dc-overall-chat（如 85%）只管
// genOneReply 文本覆盖路径，TA 主动发的消息仍 85% 是自定义（45% 固定从仅有的几张
// 文字卡里抽+15% 固定那 1 张 emoji+25% 自家贴纸/图片），用户体感「默认概率调到
// 八九十还是总发我自己设置的字卡，反复出现」。对齐回复路径口径：先掷 getDefaultCards
// （内部按场景概率+分类占比抽，总开关/聊天使用/分类/单卡开关同源生效），命中非拍一拍
// 即用默认字卡，未掷中才落自定义池原比例。
try {
const defs = (window.getDefaultCards && window.getDefaultCards()) || null;
if (defs && defs.type !== 'poke' && defs.text) return { text: defs.text, type: 'text' };
} catch (e) {}
// FIX 2026-09-15 #531：空池不再顶替他人概率段。原实现是固定累计阈值（15/25/40/55）——
// 贴纸/图片池为空时 `pool.sticker.length &&` 短路，颜文字的判定区间前移到 0~40（40%）、
// emoji 到 40~55，用户体感「联系人连发颜文字」。改为「只有可用分类参与」的设计权重
//（贴纸15/图片10/颜文字15/emoji15/文字45）归一化抽取：空池权重自动归回文字，比例不失真。
const _bands = [
[pool.sticker.length ? 15 : 0, () => ({ text: pick(pool.sticker), type: 'sticker' })],
[pool.image.length ? 10 : 0, () => ({ text: pick(pool.image), type: 'image' })],
[pool.kaomoji.length ? 15 : 0, () => ({ text: pick(pool.kaomoji), type: 'text' })],
[pool.emoji.length ? 15 : 0, () => ({ text: pick(pool.emoji), type: 'text' })],
[45, () => ({ text: pick(pool.text) || '在吗？', type: 'text' })]
];
let _bRoll = Math.random() * _bands.reduce((a, b) => a + b[0], 0);
for (let i = 0; i < _bands.length; i++) {
_bRoll -= _bands[i][0];
if (_bRoll < 0) return _bands[i][1]();
}
return { text: pick(pool.text) || '在吗？', type: 'text' };
};
const acMin = Math.max(1, Number(cfgn(c, 'as-count-min', 1)) || 1);
const acMax = Math.max(acMin, Number(cfgn(c, 'as-count-max', 2)) || 2);
const count = randInt(acMin, acMax);
for (let i = 0; i < count; i++) {
setTimeout(() => {
if (!sameAutoCid()) return; // FIX #187
hideTyping();
const am = autoMsg();
// FIX 2026-09-12 #345 撤回先掷签后投递：横幅/系统通知在 addIn 同步链内发出（切后台=系统通知），
// 旧实现 900ms 后才掷 rc-prob 撤回签——通知已把内容承诺给用户，撤回（rc-refix 未命中不补发）
// 后进聊天只剩「对方撤回了一条消息」＝「TA 刚主动发的消息被吞」（红米 K80 Chrome 报障：后台
// 保活存活期消息到达+通知已弹，进聊天没有；全机型同现，与设备无关）。改为投递前定生死：
// 命中撤回的本条静默落地（不弹横幅/系统通知，未读角标照增——墓碑也是未读事件），1~3 秒随机后
// 照常撤回；rc-refix 命中的补发消息走正常投递（此刻弹通知名正言顺，内容不会再消失）。
const willRetract = hit(c['rc-prob']);
const m = addIn(am.text, { type: am.type, initiative: true, silent: i > 0 || willRetract });
if (i === 0 && window.replyGuideHint) window.replyGuideHint('as'); // v3.27.x #218 互动频率引导（首条主动消息落地时提醒可调）
try { console.log('[mochi-auto] 主动发送消息: type=%s initiative=true retract=%s', am.type, willRetract); } catch(e){}
if (willRetract && m) {
setTimeout(() => {
if (!sameAutoCid()) return; // FIX #187
retractMsg(m, 'in');
if (c['rc-en'] !== 0 && hit(c['rc-refix'])) {
showTyping();
setTimeout(() => { if (!sameAutoCid()) return; hideTyping(); addIn(pick(pool.text) || '…', { initiative: true }); }, 600);
}
}, retractDelayMs());
}
if (i < count - 1) showTyping();
}, i * randInt(900, 2600));
}
setTimeout(() => { if (!sameAutoCid()) return; if (window.callMaybeTrigger) window.callMaybeTrigger(); }, count * 2600 + 3500);
setTimeout(() => { if (!sameAutoCid()) return; trySystemAutoSend(); trySystemAskMochi(); tryCollectPending(); if (window.maybeAutoGift) window.maybeAutoGift(); }, count * 2600 + 2500);
})();
} catch (e) {
try {
const errArr = (window.__jsErrors = window.__jsErrors || []);
errArr.push('autoSend:' + (e && e.message || e));
} catch (x) {}
}
}
const chatApp = document.querySelector('.app[data-app="chat"]');
const chatPage = document.getElementById('page-chat');
function scrollToBottom() {
body.scrollTop = body.scrollHeight;
}
// FIX #504（红米 K80 Chrome 等多机型报「从桌面点开聊天，聊天记录回弹一下再恢复」）：
// 进页贴底后，视口内 loading=lazy 图片迟至 ~400ms 才加载完成、内容一次性长高数百 px
// （无头 390×844 实测 sh 16811→17324@397ms）——旧固定 400ms 复写定时器只是「碰巧」盖住
// 这一下，真机解码更慢时长高落在 400ms 之后＝当帧以旧 scrollTop 绘制（#199 已关内核
// 滚动锚定、#162 图片 onload 补偿是 rAF 下一帧才写）＝可见回弹一拍。改 rAF 稳定窗：
// 进页后 1.2s 内每帧比对 scrollHeight，变高【当帧】同步回钉（rAF 回调先于本帧绘制、
// 读 scrollHeight 即强制布局＝同帧修正，不等下一帧）；用户触摸解钉/离页即停＝#162
// 「不打扰」契约零改动；零机型分支、零视觉改动。
let chatEntrySettleToken = 0;
function chatEntrySettle() {
if (!window.requestAnimationFrame) return;
const my = ++chatEntrySettleToken;
let lastH = body.scrollHeight;
const t0 = Date.now();
let alive = t0; // #841h：稳定窗「距最后一次长高 3s」滚动续期（真机图片解码/字体回填可拖到 2s+，固定 1.2s 必漏尾），8s 硬顶防异常空转
const tick = function () {
if (my !== chatEntrySettleToken || !chatVisible() || !chatPinnedBottom) return;
const h = body.scrollHeight;
if (h !== lastH) { lastH = h; scrollChatBottom(); alive = Date.now(); }
if (Date.now() - alive < 3000 && Date.now() - t0 < 8000) requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
}
// FIX 2026-09-20 #930（Vivo Y35/摩托罗拉 G100 等 Android Edge 独立应用实报「打开聊天/回到应用，
// 停在几分钟前的消息，看不到现在的消息」，多机型同现）：回前台贴底复核闸。保活应用常驻数天，
// 两个失底通道都不经过 enterChat（#742 复位只在点图标进聊天时触发）：①后台期间消息照常投递、
// rAF/定时器被内核冻结节流，贴底写入丢失或被 hidden 期布局钳位；②用户离场前在历史位（解钉态），
// 重开应用回到聊天页＝永远停在旧位置。修法＝visibilitychange/pageshow 回前台时按「离场时长」
// 分档：超过 60s 的重回场视同一次「进聊天」（与 #742 同语义＝复位钉住回底）；60s 内的短离场
// 只在「仍处于钉住态且几何落定后离底 >8px」时补一枪（后台冻结丢写的兜底），#162「用户在翻
// 历史就不打扰」契约零改动（短离场解钉态不拽）。长离场也复用 #868 落定闸思路：350ms 后几何
// 静默才写，随后 chatEntrySettle 接管迟到长高。纯时序判据、零机型分支。
let chatHiddenAt = 0;
let chatResumeRepinT = null;
const CHAT_RESUME_FRESH_MS = 60000; // 离场超过此值＝长离场，回场视同重新进聊天
function chatResumeRepin() {
if (document.visibilityState !== 'visible' || !chatVisible()) return;
const gone = (typeof window.__chatHiddenAgeMs === 'number') ? window.__chatHiddenAgeMs : (chatHiddenAt ? Date.now() - chatHiddenAt : 0); // override 仅供 verify 脚本注入
const awaitLongAway = gone > CHAT_RESUME_FRESH_MS;
if (awaitLongAway) {
chatPinnedBottom = true;
body.classList.remove('scroll-anchor-auto');
}
if (!chatPinnedBottom) return;
// FIX 2026-09-24 #1202（用户实报「把浏览器放在后台一段时间再切回来，聊天里新的聊天消息无法显示」，
// 明说其他设备型号也有出现——#1067 上线后仍复发的就是下面这一面）：#1067 那一发强制重读挂在本函数
// 350ms 的一次性回调里，而回调开头是 `if (!chatVisible() || !chatPinnedBottom || batchRendering) return;`。
// 真机回场最常撞上的就是 batchRendering：后台/锁屏期本 tab 被冻结或深度节流（隐藏标签里链式
// setTimeout(fn,0) 被压到约 1 次/分钟），那半轮 renderWindow 分帧构建根本没跑完，解冻后它还要再飞
// 一会儿 ⇒ 350ms 到点时构建仍在飞＝重读连同贴底一起作废；而 chatResumeRepinT 此刻已清空、同一次离场
// 不会再有第二次 visibilitychange ⇒ **没有任何补口**，后台落库的新消息永远进不了内存。无头实证（纯
// HEAD 红侧，tools/verify-1202-resume-reconcile.mjs）：构建在飞→障碍清除之后，权威键读取次数 = 0，
// 新消息 20s 内始终不上屏（只有退出重进/刷新才画＝用户原话）。
// 第二面：就算这发读库跑成了，它落地那一眼若正撞回场几何风暴（用户被判定为「不在底部」），loadMsgs
// 收尾只走 `windowStale = true`＝消息进了内存、屏上不画，而此后没有任何重画入口（#951 的窗口自愈只
// 跑 6×250ms 就永久放弃）。
// 修法＝「一次性一枪」换成**有界复核状态机**（轮询口径同 #978 chatResumeRealign）：①等障碍（在飞的
// 整窗构建）清 → ②真读一发权威（就是 #1067 那发 forceIdb 子弹，绕开 8s 时间闸）→ ③等它落地
// （lastIdbLoadAt 前移）→ ④屏/模型一致性复核：只在「屏上尾部确实落后于权威尾部／空屏／被 windowStale
// 判成作废」时补画（差几条走 #918 幂等增量补尾，落后一大截或空屏才整窗重建），已追平则零动作。
// 250ms 步进、6s 死线、一次离场只开一轮；#162（解钉态不拽底）、#416、#1067「短离场≤60s 零重读」
// 契约一字不动。纯时序判据、零机型/UA 分支。
chatResumeReconcileArm(awaitLongAway);
if (chatResumeRepinT) clearTimeout(chatResumeRepinT);
chatResumeRepinT = setTimeout(function () {
chatResumeRepinT = null;
if (!chatVisible() || !chatPinnedBottom) return; // 回场期用户已翻页/已解钉＝不抢
// FIX 2026-09-30 #1476（用户第五次复报同一症状「挂后台回来聊天不贴底、下半空白、要刷新才恢复」；#1202
// 的注释原话「重读＋贴底一起作废」只修了一半——重读搬进了复核状态机，贴底这一枪仍是一次性闸口，被这里的
// batchRendering 早退吞掉后同一次离场再无第二次 visibilitychange＝无人再挂）。修法＝batchRendering 不再是
// 丢枪理由：chatResumeRealign 自带静默轮询（chatRepinQuietEnough 含 !batchRendering），构建在飞时挂枪等它清，
// 清掉＋几何静默后照写；真写永远发生在静默后＝健康态重写同值零副作用，撕裂态＝#871 同值重落强制内核重对齐。
chatResumeRealign('repin350'); // #978：回场贴底改「几何落定后同值重落一枪」——350ms 当场裸写正打在回场几何恢复风暴中段＝撕裂源
if (!batchRendering) chatEntrySettle(); // #930 保留：迟到长高（懒加载图/字体回填）当帧回钉；构建在飞时不当场抢——分帧收尾 finishSwap 自会调（#841b）
}, 350);
}
let _rcTimer = null;
let _rcDeadline = 0;
let _rcArmAt = 0;
let _rcPhase = 0; // 0=等构建在飞清 1=读已开枪等落地 2=等几何落定 3=已复核（本轮结束）
let _rcReadAt = 0;
const CHAT_RESUME_RECONCILE_MS = 6000; // 整轮复核预算（障碍清得掉就用不到，清不掉到点也要做一致性复核）
const CHAT_RESUME_RECONCILE_HARD_MS = 15000; // #1294b 硬顶：软死线后只给「读库链仍在飞」续期到这里（大历史真读十几秒＝#716 实测形态），到点仍收尾
function chatResumeReconcileArm(longAway) {
if (!longAway) return; // 短离场（≤60s）行为零变化＝不抢主线程（#1067 C1 契约）
const now = Date.now();
if (now - _rcArmAt < 5000) return; // 一次离场只开一轮：visibilitychange／pageshow／mochi-fg-resume 三通道重复报到不叠加
_rcArmAt = now;
_rcPhase = 0;
if (_rcTimer) clearTimeout(_rcTimer);
_rcDeadline = now + CHAT_RESUME_RECONCILE_MS;
_rcTimer = setTimeout(chatResumeReconcileStep, 250);
}
function chatResumeReconcileStep() {
_rcTimer = null;
if (document.visibilityState !== 'visible' || !chatVisible() || !chatPinnedBottom) return; // 又离场／用户已翻历史＝这轮作废（#162）
const now = Date.now();
const overdue = now >= _rcDeadline;
if (_rcPhase === 0) {
// FIX 2026-09-26 #1294a（用户第三次复报同一症状，红米 K80 Chrome，明说其他设备型号也有出现）：
// 旧形态在 6s 软死线到点时若那半轮整窗构建仍在飞，就直接跳过这一发权威重读（_rcPhase=2 只补画）。
// 而真机解冻风暴（回前台重排＋数百气泡分帧构建在慢机上）恰恰最常拖过 6s ⇒ 子弹掉弹、屏/模型复核
// 又因 batchRendering 在 heal 开头早退＝这一轮零重读；同一次离场不会有第二次 visibilitychange，
// 后台落库的新消息永远进不了内存（无头实证见 tools/verify-1294-resume-deadline.mjs 红侧 D1 reads=[]）。
// 修＝数据重读与构建在飞无关（loadMsgs 不直写 DOM，落地渲染收尾自带 #220/#951h 的在飞作废闸），
// 让路的只该是补画那一半：死线到点照开枪，然后照样进 ①→③ 等落地。短离场契约与「软死线前让路」零改动。
if (batchRendering && !overdue) { _rcTimer = setTimeout(chatResumeReconcileStep, 250); return; } // ① 那半轮整窗构建还在飞＝死线前让路（旧写法在这里连子弹一起丢掉）
_rcPhase = 1;
_rcReadAt = lastIdbLoadAt;
// FIX 2026-09-23 #1067（长挂后台/锁屏回前台，后台期由别的上下文落进同一 origin 聊天存储的新消息不显示、
// 要刷新才正常）：本状态机的②就是那一发子弹——forceIdb 绕开 IDB_RELOAD_MIN_GAP(8s) 时间闸，大历史只重读
// blk-idx + 热片，合并新消息后走既有渲染；无新消息则 changed=false 只补快照、零副作用。
try { if (chatDbReady) loadMsgs(true); } catch (e) {} // 权威未达时由 #967 chatResumeRearmRead 那条路负责
}
if (_rcPhase === 1) {
// FIX 2026-09-26 #1294b：软死线到点但读库链仍在飞（#716 红米 K80 实报 41.2MB 历史、真读可达十几秒）＝
// 有界续期到硬顶，别让④拿旧模型复核出「已追平」的假绿；到硬顶仍按现形态收尾（子弹落地时 loadMsgs
// 收尾自带渲染兜底）。
if (lastIdbLoadAt === _rcReadAt && (!overdue || (_lmChainBusy === window.activePrefix() && now < _rcArmAt + CHAT_RESUME_RECONCILE_HARD_MS))) { _rcTimer = setTimeout(chatResumeReconcileStep, 250); return; } // ③ 读库链是异步的：等它真落地
_rcPhase = 2;
_rcDeadline = Date.now() + 3000; // 下面要写 DOM＝按 #978 同口径再给 3s 让几何落定
}
if (_rcPhase === 2) {
if (!overdue && !chatRepinQuietEnough(now)) { _rcTimer = setTimeout(chatResumeReconcileStep, 250); return; }
_rcPhase = 3;
chatResumeReconcileHeal();
}
}
// ④ 屏/模型一致性复核：权威已在内存里、屏上却还停在旧窗口（#1067 之后仍然复发的那一半）。
// 判据只用「屏上最后一条 data-idx vs 权威条数」＋ windowStale 凭据，二者都对＝零动作。
function chatResumeReconcileHeal() {
try {
if (!chatVisible() || !chatPinnedBottom) return; // #162
// FIX 2026-09-26 #1313（红米 K80 Chrome 第四次复报「挂后台再回来聊天一片空白、要刷新才恢复」）：这一行
// 旧形态把「整窗构建在飞」当成让路理由，而在飞的那个状态在卡死态**永远为真**——分帧链一旦不再回来，
// batchRendering 就永久停在 true（#1313 的取证见 renderWindow 上方那段），于是这道让路闸成了本状态机
// 最后一步的死路：权威读到了、屏上却什么都不画，而且同一次离场不会有第二次 visibilitychange＝无人再管。
// 修法＝把尺子从「在不在飞」换成「有没有在推进」：停滞的那一轮先接管收装（把已构建的部分落屏），
// 接管失败才维持旧行为。健康的分帧轮（一秒内还在动）照旧让路，#162／换装期不写 DOM 的契约零改动。
if (batchRendering && !chatPumpStalled()) return; // 换装期不写 DOM（泵确实还在推进＝让路）
if (batchRendering) chatPumpRescue('resume-heal'); // 停滞泵接管：先把那一轮已经构建好的部分换装落屏
if (batchRendering) { chatResumeRealign('heal-stall'); return; } // 接管没成（收尾自身抛）＝本轮不写 DOM（旧行为）；#1476 补一条：贴底枪照挂——realign 静默闸含 !batchRendering，泵被 #1313 看门狗接管收装后它自己写，卡死则到死线放弃，两侧都不越权
const len = msgs.length;
if (!len) return;
let lastIdx = -1;
const kids = body.children;
for (let i = kids.length - 1; i >= 0; i--) {
const v = kids[i] && kids[i].dataset ? parseInt(kids[i].dataset.idx, 10) : NaN;
if (isFinite(v)) { lastIdx = v; break; }
}
if (lastIdx >= len - 1 && !windowStale) { chatResumeRealign('heal-even'); return; } // #1476：屏上已追平＝只差滚动对齐——旧形态在这里直接 return，#1202 吞掉的贴底枪（350ms 撞 batchRendering）自此再无补口，#978 撕裂态停留到刷新；同值重落健康态零副作用
chatSettleHoldArm(); // #1010：补画期间视口媒体解码由进度条兜住
if (windowStale || lastIdx < 0 || len - 1 - lastIdx > LOAD_STEP) renderWindow(false, true); // 空屏／整窗落后一大截／凭据作废＝整窗重建（与「长离场视同重新进聊天」同语义）
else loadNewerIncremental(len); // 只差尾部几条＝#918 幂等增量补尾，不闪
scrollChatBottom();
chatSettleHoldSettle();
chatResumeRealign('heal-draw'); // 补画改了几何＝交回 #978 落定闸同值重落一枪
chatEntrySettle(); // #841h：迟到长高当帧回钉
} catch (e) {}
}
// FIX 2026-09-21 #978（用户实报附截图「切后台然后再切回浏览器页面，聊天记录不贴底部输入栏上面了、
// 最新消息整块顶到上半屏、下半全空」；同族第三发：#871 几何变动中途写⇒内核滚动树停旧偏移、#933
// 回钉当场写，本次触发面＝回前台）：#930 的回场复核在固定 350ms 后**当场裸写** scrollChatBottom()——
// 回场瞬间正是浏览器自身几何恢复风暴（系统栏回归/瓦片重建/视口复核），中途写 scrollTop ⇒ 滚动树停
// 在旧偏移＝「内容整块上移、下方留白」。且撕裂态 scrollTop 读数 ≥ max−8（写其实落了，只有滚动树/
// 绘制错位）：本函数旧「离底>8 才补」判据、#706 看门狗「scrollTop<max−8 才写」全数失明 ⇒ 用户停在
// 坏态，只有轻点屏幕（touchend 同值写）才救得回。修法＝回场这一枪改「落定后写、写必同值重落」：
// 几何/滚动全静默后才 scrollChatBottom()——健康态＝重写同一个值零副作用；撕裂态＝#871 真机实证的
// 同值重落强制内核滚动树对新几何重对齐；3000ms 静默不了就放弃（交回 #706 看门狗/触摸恢复），一次
// 回场只写一枪。#162（解钉态不拽底）、#416（≤8px 语义）零改动。纯时序判据、零机型分支。
let _rsResumeT = null;
let _rsResumeDeadline = 0;
let _rsResumeWhy = ''; // #1476：挂枪来源（repin350/heal-even/heal-stall/heal-draw），随取证环落诊断单
function chatResumeRealign(why) {
if (_rsResumeT) return; // 已有一枪在膛：由它负责复查，不重复排队
_rsResumeWhy = why || '';
_rsResumeDeadline = Date.now() + 8000; // #1476：3s→8s 与 chatEntrySettle/#841h 同级——回场几何风暴＋大历史媒体解码可拖过 3s（#841h 实证解码 2s+），死线内放弃＝撕裂态再无救兵；轮询零几何读（chatRepinQuietEnough 只看时间戳与标志），多等的只有成本
_rsResumeT = setTimeout(chatResumeRealignStep, 120);
}
function chatResumeRealignStep() {
_rsResumeT = null;
const now = Date.now();
// #1476 取证：挂了枪却没写成＝三种去向各留一条（离场/解钉是正常语义，死线放弃才是丢枪），下份诊断单
// 直接可见「枪挂了没、写了没、怎么没的」——本症状五连报靠的正是「无头模拟不出真机形态」，留证不再盲猜
const _rk = (k) => { try { const cb = document.getElementById('chat-body'); chatWinRingMark(k, cb ? cb.scrollTop : 0, cb ? chatScrollMax() : 0, _rsResumeWhy); } catch (e) {} };
if (!chatVisible()) { _rk('realign-drop'); return; }
if (!chatPinnedBottom) { _rk('realign-drop'); return; } // #162：回场期用户已翻历史＝绝不拽底
if (!chatRepinQuietEnough(now)) {
if (now < _rsResumeDeadline) { _rsResumeT = setTimeout(chatResumeRealignStep, 120); return; }
_rk('realign-miss'); return; // #1476：死线放弃＝这一枪彻底丢了，留证
}
if (chatPinnedBottom) { scrollChatBottom(); _rk('realign'); } // 同值重落：健康态重写同一个值；撕裂态＝强制内核滚动树重对齐
}
document.addEventListener('visibilitychange', function () {
if (document.visibilityState === 'hidden') { chatHiddenAt = Date.now(); if (chatResumeRepinT) { clearTimeout(chatResumeRepinT); chatResumeRepinT = null; } }
else chatResumeRepin();
});
window.addEventListener('pageshow', function (e) { if (e.persisted) chatResumeRepin(); }); // bfcache 恢复同闸（pageshow 时 visibilityState 已是 visible）
// FIX 2026-09-21 #967：回前台补读。用户实报「挂后台切回来会卡、聊天里什么也看不到」——后台期
// 那半条读库链的 IDB 回调/定时器被内核冻结节流，回前台旧实现只做贴底复核（chatResumeRepin），
// 没有任何重新起读的入口；若重试已耗尽就永久停在空屏。这里在「聊天页可见 + 权威未达 + 非空库」
// 时补一发真读（forceIdb 绕过去重闸），权威已在手时零动作（正常回前台行为一字不变）。
function chatResumeRearmRead() {
try {
if (!chatVisible() || chatAuthSettled()) return;
stopChatAuthWatch();
loadMsgs(true);
} catch (e) {}
}
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') chatResumeRearmRead(); });
document.addEventListener('mochi-fg-resume', chatResumeRearmRead); // bg-keep 回前台统一信号（与 ta-ask/memo 同款通道）
window.addEventListener('pageshow', function (e) { if (e.persisted) chatResumeRearmRead(); });
// FIX 2026-09-24 #1202：复核闸的第三条报到路。部分内核回前台只发 focus/pageshow、不发 visibilitychange
// （bg-keep 正因如此才有 mochi-fg-resume 统一信号，#967 也挂了三通道）——那种设备上 chatResumeRepin
// 整条路都不跑，本批的闸也就无从挂起。这里只认 bg-keep 实测的「真后台时长」判据（≥60s 才算长离场，
// 与 CHAT_RESUME_FRESH_MS 同口径），短停留照旧零动作。
document.addEventListener('mochi-fg-resume', function () {
try {
if (chatHiddenAt || !window.bgLateCatchup) return; // visibilitychange 报过到＝由上面那条路负责，本路只兜「内核不发 visibilitychange」的设备
if (!chatVisible() || !chatPinnedBottom) return; // #162：用户离场前在翻历史＝不打扰
chatResumeReconcileArm(window.bgLateCatchup(CHAT_RESUME_FRESH_MS) === true);
} catch (e) {}
});
// FIX 2026-09-22 #1017（用户实报：「进入桌面，然后点击进入聊天，还是没有加载动画缓冲啊，导致页面卡几秒」；
// 同批原提交 e78960b 落在侧分支 fix-1015-selfcheck-durations 上、从未并入 main ⇒ 用户 2026-09-22 复报
// 「首次加载进入开屏，打开聊天页面……依旧没有动画缓冲」＝本条）：
// 进聊天页的重活（loadMsgs 里同步 parse LS 快照、权威回读收尾、整窗重建、贴底收尾）此前与
// 「切页 + 顶进度条」同处**一个任务**：进度条 #703 置位之后，#841j 同窗补丁命中又在同一任务里
// 当场撤掉它——浏览器连一个中间帧都没有机会画。无头实测（1× 节流、300 条历史、屏上已同窗、
// 探针用访问器只观测不改写）：进度条 hidden 由 false 到 true 相隔 **1ms**，全程 **0 帧可见**；
// 4× 节流下同类场景也只活 5ms。用户所见正是「没有缓冲动画、页面定住几秒，然后内容直接出来」。
// 修法（零机型分支、零新状态）：把 enterChat 拆成「切页＋顶进度条」与「重活」两段，中间等一帧
// 真正上屏——rAF 回调跑在绘制之前，故第一帧先把聊天页与进度条画出去，第二个 rAF 里才跑重活；
// 重活那 100~900ms 主线程被占住期间，进度条卡片已经画在屏上（CSS 动画走 transform 合成器路径，
// 见 chat-main.css 的 chatLoadSlide）。重活整段与旧版逐字节相同、只是晚一帧开始，撤销仍由既有
// updateChatLoading / renderWindow 收尾逻辑负责，不新增标志、不动机型。
function chatEnterPaintThen(fn) {
let ran = false;
const run = function () { if (ran) return; ran = true; fn(); }; // 不吞异常：重活里抛错照旧冒到 window.onerror/__jsErrors（#939 口径），诊断链不断
if (!window.requestAnimationFrame) { setTimeout(run, 16); return; }
requestAnimationFrame(function () { requestAnimationFrame(function () { setTimeout(run, 0); }); });
setTimeout(run, 120); // 保险丝：后台标签/页面不可见时 rAF 会被节流甚至不派发，重活不能因此不跑
}
// FIX 2026-09-23 #1151c 回场「一次性动画重播」总闸（与 #1151a/b 摘类互补，兜住摘不得的那一类）：
// 整页 hidden → 可见时内核会把窗口内**所有** CSS 动画从头重播（全内核一致的行为，与机型无关）。挂在
// .msg-enter 这类纯动画类上的已由摘类消掉，但挂在「身份类」上的一次性动画摘不得——类一掉样式就丢
// （猜拳 .msg-rps 的 rpsFadeIn .35s both、拍小花 .msg-flower-emoji 的 flowerFloat 3s×3、搜索跳转
// 高亮 .msg.highlight 的 msg-flash 1.2s×2），从聊天设置/市集/桌面图标回到聊天时看到的还是那一下。
// 本闸在 hidden 翻回可见的同一任务里（变异观察器回调＝微任务，绘制之前）把这些动画直接落到终态：
// 终态与「动画正常播完」逐像素相同＝对播放中的动画零影响；无限循环动画（语音波形、打字点、加载圈）
// 必须跳过——finish() 对 infinite 时间轴会抛，且它们本就每帧重画、不构成「闪一下」。
function settleReplayedChatAnim(onlyPaused) {
if (!document.getAnimations) return 0;
// FIX 2026-09-26 #1300b 枚举面从「整篇文档」收到「聊天消息列表子树」：回前台那一路原本每次
//   document.getAnimations() 取全站动画＋对每条 target 跑 body.contains()。本机 430×932 真机
//   诊断现场 DOM=35388 节点、img 931 张，全站枚举＋祖先链判定＝#1151c/#1181b 这闸**自己**成了
//   回场一帧的耗时项（它和摘 #913 暂停类、#1195e 大键释放、iOS 重开 IDB 连接全落在同一次可见性
//   翻转里）。容器沿用既有的 body（=chat-body，第 6 行）＝被收的集合与旧写法逐条相同，只是不再
//   先问全站要一遍，零机型／零 UA 分支。老内核不认 {subtree:true} 时 body 那次只会问出空表，
//   空表证不了「窗内确实没有」——落回 document 那份再数一遍（＝旧行为，宁多走一步也不静默不修）。
let all;
const sub = body.getAnimations ? body.getAnimations({ subtree: true }) : null;
if (sub && sub.length) all = sub;
else all = body.getAnimations && body.getAnimations().length ? sub : document.getAnimations();
let n = 0;
for (let i = 0; i < all.length; i++) {
const a = all[i];
if (typeof a.animationName !== 'string') continue; // 只管 CSS 动画：过渡不会在显隐切换时重播，别去动它
if (onlyPaused && a.playState !== 'paused') continue; // #1181b：回前台这一路只收「被 #913 暂停类冻住」的那批，正在正常播的（用户可能看得见）一律不动
const ef = a.effect;
const tg = ef && ef.target;
if (!tg || !(tg === body || body.contains(tg))) continue; // 只管聊天窗口内（含窗口自身）
let iter = Infinity;
try { iter = ef.getComputedTiming().iterations; } catch (e) {}
if (iter === Infinity) continue; // #1151c：无限循环者不落终态（波形/打点/加载圈）
try { a.finish(); n++; } catch (e) {}
}
return n;
}
if (chatPage) {
new MutationObserver(function () {
if (!chatVisible()) return;
settleReplayedChatAnim(); // #1151c：回场一帧在绘制之前落终态＝看不见这一帧
}).observe(chatPage, { attributes: true, attributeFilter: ['hidden'] });
}
// FIX 2026-09-24 #1181b 回前台总闸（#1151c 的同族补口，触发面换成「浏览器切后台再切回」）：
// #1151c 只挂在 chatPage 的 hidden 属性变异上＝只覆盖站内切页；浏览器整页进后台不碰这个属性，
// 而 #913 在 document.hidden 时给全站挂 `animation-play-state: paused`，于是聊天窗口里每一个
// 未播完的一次性动画都被冻在冻结那一刻，回前台摘类的同一瞬集体补播＝用户实报「把浏览器切到
// 后台再切回来，聊天消息会闪屏弹跳一下然后恢复正常」。这里在回前台事件里（本文件注册早于
// mobile-adapt.js 摘类，同一任务内、绘制之前）把**仍处 paused** 的一次性动画直接 finish 到终态：
// 只收冻住的、正常在播的一律不动（避免从别的窗口点回来时误掐用户看得见的动画）；无限循环者由
// 下面既有守卫跳过（波形/打字点/加载圈本就该继续跑）。零机型分支——判据全取动画自身状态。
function chatResumeSettleAnim() { try { settleReplayedChatAnim(true); } catch (e) {} }
// #1326：「正在输入」的到期复核走与 #1181c 同一组回前台通道（visibilitychange／bg-keep 统一信号／
// bfcache pageshow）——冻结期连自家的看门狗定时器一起冻住，只在 setTimeout 上收口等于没修。
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') chatTypingReconcile('fg'); });
document.addEventListener('mochi-fg-resume', function () { chatTypingReconcile('fg'); });
window.addEventListener('pageshow', function (e) { if (e.persisted) chatTypingReconcile('fg'); });
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') chatResumeSettleAnim(); });
document.addEventListener('mochi-fg-resume', chatResumeSettleAnim); // bg-keep 统一信号：覆盖「只发 focus / bfcache 恢复」的内核（与 #967 同款双通道）
window.addEventListener('pageshow', function (e) { if (e.persisted) chatResumeSettleAnim(); });

function enterChat() {
document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
const phoneTab = document.querySelector('.tab[data-page="page-phone"]');
if (phoneTab) phoneTab.classList.add('active');
document.querySelectorAll('.page').forEach(p => { if (!p.hidden) p.hidden = true; }); // FIX #336 同值写也发 mutation，44 页全扫=唤醒全部页面观察器
chatPage.hidden = false;
	// FIX 2026-09-18 #742（HUAWEI Mate 40 Pro + Edge 等多机型报「进聊天不自动到最新、像跳到旧记录、
	// 滑动乱跳、加载完还得自己翻」）：进聊天页必须复位「贴底钉住」并关回原生滚动锚定——
	// 上次会话若在聊天里滚动过（unpinChatAndAnchor 已把 .scroll-anchor-auto 挂上、chatPinnedBottom
	// 置 false），本会话重开聊天走「同窗补丁」路径（inplacePatchIfSameWindow 命中＝不整窗重建）
	// 时，聊天停在旧 scrollTop＋原生锚定（overflow-anchor:auto）开着→图片迟到解码/懒加载重排时
	// 视图被拽回旧记录、又不回底。此处复位钉住态 + 摘掉锚定类，使重开聊天恒以「最新消息」收尾
	//（钉住时期全部 scrollChatBottom 链、image onload 补滚、chatEntrySettle 1.2s 补齐全部生效）。
	// 零机型分支：只在进聊天这一瞬复位，用户进语音/后台期间聊天内滚动语义（#162/#378/#416）不变。
	chatPinnedBottom = true;
	body.classList.remove('scroll-anchor-auto');
fillAvatar('chat-user-av', 'cs-avatar-user');
fillAvatar('chat-partner-av', 'cs-avatar-partner');
if (window.applyChatSettings) window.applyChatSettings();
clearChatUnread();
chatRebuilding = true; // #841i：进页即有一段「屏上还没有任何列表」的空窗（LS/权威异步读取、首帧未渲），进度条顶上，renderWindow 接手时由 #841e/f 交接、同步收尾就地交回
updateChatLoading(); // #703：先于 loadMsgs 置位——loadMsgs 里同步 parse LS 快照可能上百毫秒，先让进度条就位
// FIX 2026-09-22 #1039（用户实报「莫名其妙聊天记录会突然跳到前面」＋「是刚进聊天就跳」）：
// 进页首帧必须就落在**底部**。第一段只切页+顶进度条，此刻屏上是「桌面期预渲的那一窗」——
// 它的 scrollTop 是 0（隐藏期没有布局），而把视口写到最底的那几笔（scrollToBottom 三连 /
// renderWindow 收尾）都在**重活之后**。于是「切页 → 重活（真机数秒）」这段里被画出去的第一帧
// 是「窗口最上面那一条＝两百条前的旧记录」，等重活跑完才跳到最新＝用户所见「刚进聊天就跳」。
// 无头实证（1200 条 × 2KB 正文、8× CPU 节流）：修复前首个可见帧 scrollTop≈0（距底 569548px）、
// 停 3.6s 才跳到底；同条件无「先上屏一帧」的旧版首帧直接出现在冻结之后、已在底部（gap≈-0.7）。
// 这里在第一段（yield 之前）先写一笔贴底，首帧即为底部；重活跑完照旧再写（语义不变）。
scrollChatBottom();
// #1017：置位只是「标志」。下面这一帧必须留给浏览器真的把聊天页与进度条画出去，重活（取字卡库、
// loadMsgs、整窗重建/同窗补丁、贴底收尾）挪进第二个 rAF——两段之间没有任何中间绘制（实测 1ms）
// 才是用户说的「没有加载动画缓冲」。切页/头像/聊天设置/已读角标仍在上面第一段，保证首帧内容正确。
chatEnterPaintThen(function () {
// v3.28.x：进入聊天页即按需取回字卡库（冷启动挂起大键）——专属字卡优先（回复池主源），
// 公用随后；配合 replyOnce 内的等待，避免首条/持续回复落兜底卡。
try { if (window.hydrateLibScopes) window.hydrateLibScopes(['own', 'public']); } catch (e) {}
// FIX 2026-09-30 #1441（红米 K80 Chrome 实报「退出聊天页面回到桌面，再回聊天页面，来回切换时聊天页面
// 的数据总是会重新加载并闪屏」，用户明说其他设备型号也有出现、点名不要覆盖式修补）：这一发 loadMsgs
// 过去只由 IDB_RELOAD_MIN_GAP(8s) 时间闸决定读不读——「在桌面待够 8 秒」被当成了「库里可能比内存新」
// 的证据。可页内切页本身不是外部写入面：桌面期 TA 的新消息本来就进 msgs；真后台回场另有 #967／#1067／
// #1294 三条各自挂 forceIdb 的路；切联系人与大历史未预读会把 authLoadedPrefix 归位。于是对「历史很大」
// 的存档，这一发恒等于每次进场重新起一轮读库（本机实测：在桌面停 12 秒再进＝4 发 idbGet，读库期间
// chatAuthPending 就是屏上那条「正在加载聊天记录」），读完的合并收尾还可能再画一遍＝用户所见「数据重新
// 加载＋整屏闪」。
// 判据换成四条现成事实，任何一条成立就照旧真读：① 本命名空间权威从未落定（authLoadedPrefix 不匹配＝
// 冷启动／切联系人／大历史懒读那一路，#951「未预读就是诚实反馈」的边界一字不动）；② 内存里还没有这一桌
// 的历史（msgs 空＝屏上本来就没东西，读它零代价，绝不许「静默不读」把空屏坐实——verify-chat-entry-load-window
// 从旁路灌库测的正是这一支）；③ 本文档之外的同源上下文写过这一桌的聊天（storage 事件，见 chatXtxWriteSeen：
// 浏览器只在**别的**同源文档里派发，写入方自己收不到＝规范行为、与机型无关）；④ 跨桌面中转箱有货（#1200，
// 同步可读的小键，排空它必须走权威落定那一段）。四条都不成立＝屏上就是这一桌的权威窗，不必再读。
// 零机型／零 UA 分支：只问这四件事实，不问停留了多久，更不问浏览器是谁家的。
let csAuthHere = false;
try { csAuthHere = authLoadedPrefix === window.activePrefix() && msgs.length > 0 && !chatXtxWriteSeen; } catch (e) {}
if (!csAuthHere) { chatXtxWriteSeen = false; loadMsgs(); } // 起读＝消费掉这一发证据：一趟只认一次，读完由权威落定那一段重新记账
else {
let csInboxHas = true; // 量不动＝保守起读（不把「读不到」当成「没有」）
try {
const csRawInbox = localStorage.getItem(window.activePrefix() + ':chat-desk-inbox');
csInboxHas = false;
if (csRawInbox) { const csArrInbox = JSON.parse(csRawInbox); csInboxHas = Array.isArray(csArrInbox) ? csArrInbox.length > 0 : csRawInbox.length > 2; }
} catch (e) { csInboxHas = true; }
if (csInboxHas) loadMsgs();
}
// v3.26.x #220 聊天重开不闪：屏上消息区仍与当前 msgs 同窗同貌（同桌面、同条数、
// 渲染后归一化没改过窗口内容、窗口未裁剪——顶部上翻裁剪后 renderStart>0 不满足）
// 时，重复进入聊天页不再整窗重建 200 气泡（img 全部重新解码=肉眼跳动，小米15Pro
// /Chrome 报障「消息先跳动一下才显示正常」，用户明说其他机型也有）。跳过时只把
// 程序化滚底三连打满（与旧路径视觉结果一致）；不满足则照旧整窗渲染。
if (inplacePatchIfSameWindow()) { chatRebuilding = false; updateChatLoading(); } // #841j：同窗补丁命中＝零重建无空窗，就地交回标志（不等 renderWindow 接手）
else renderWindow(false, true);
scrollToBottom();
if (window.requestAnimationFrame) {
requestAnimationFrame(scrollToBottom);
requestAnimationFrame(() => requestAnimationFrame(scrollToBottom));
}
chatEntrySettle();
chatResumeRealign('enter'); // #1523b 站内切页回聊天不发 visibilitychange＝#978/#1476 那四把回场枪一把都不经过；同窗补丁命中时零重建，撕裂态没有任何补口（整窗重画才治得好，正是用户所见「TA 一回就整屏闪一下」）
chatTypingReconcile('enter'); // #1326：进页先把过期的承诺收掉——否则每次重进聊天页都把那句「正在输入」重新点亮（用户口径的「退出再进来还是不动」）
if (typingOn && chatVisible()) {
typingEl.hidden = false; // FIX 2026-09-15 #514 进页同款：只切可见性、不写 scrollTop（上面三连已在行隐藏态贴到底）
}
// FIX #907：进聊天页也是一次预热时机——多数用户是「打开应用→进聊天→才点开面板」，
// 只靠 load+4s 那一班会在面板无几何时白跑（mochiPrewarmEmojiPanel 有 page-chat hidden 守卫）。
schedulePanelPrewarm(2500);
}); // #1017 第二段（重活）结束
}
if (chatApp && chatPage) {
chatApp.addEventListener('click', () => {
const editing = Array.from(document.querySelectorAll('.app-grid'))
.some(g => g.classList.contains('editing'));
if (editing) return;
enterChat();
});
}
const back = document.getElementById('chat-back');
if (back) {
back.addEventListener('click', () => {
const phonePage = document.getElementById('page-phone');
if (phonePage) {
document.querySelectorAll('.page').forEach(p => { if (!p.hidden) p.hidden = true; }); // FIX #336 同值写也发 mutation，44 页全扫=唤醒全部页面观察器
phonePage.hidden = false;
}
});
}
const csOpenBtn = document.getElementById('chat-settings-btn');
const csPage = document.getElementById('page-chat-settings');
if (csOpenBtn && csPage) {
csOpenBtn.addEventListener('click', () => {
document.querySelectorAll('.page').forEach(p => { if (!p.hidden) p.hidden = true; }); // FIX #336 同值写也发 mutation，44 页全扫=唤醒全部页面观察器
csPage.hidden = false;
});
}
const csBack = document.getElementById('cs-back');
if (csBack) {
csBack.addEventListener('click', () => {
document.querySelectorAll('.page').forEach(p => { if (!p.hidden) p.hidden = true; }); // FIX #336 同值写也发 mutation，44 页全扫=唤醒全部页面观察器
chatPage.hidden = false;
});
}
const morePanel = document.getElementById('chat-more-panel');
const moreBtn = document.getElementById('chat-more-btn');
if (moreBtn && morePanel) {
const moreGridFun = document.getElementById('more-grid-fun');
const moreGridAsk = document.getElementById('more-grid-ask');
// v3.15.x：功能增多后顶部改为分类 chips（互动/小游戏/工具/TA的提问），
// 按钮元素与 ID 全部保留只做过滤显示；每个功能只归属一个分类、分类间不重复
const MORE_CATS = ['chat', 'game', 'tool', 'ask'];
// v3.26.x：群聊打开共享面板时进入「群聊模式」——只保留【工具】分类，且只留 帮我决定/多人决定/搜索记录/占卜；
// 禁止在群聊里使用【小游戏】【TA的提问】【互动】功能。聊天页打开时关闭该模式、恢复全部分类。
let moreGroupMode = false;
const GROUP_MORE_ITEM_IDS = new Set(['more-decide', 'more-gdecide', 'more-search', 'more-divine']);
function applyMoreCat(cat, group) {
if (group === true || group === false) moreGroupMode = group;
if (moreGroupMode) cat = 'tool'; // 群聊模式强制锁定「工具」分类
if (MORE_CATS.indexOf(cat) < 0) cat = 'chat';
document.querySelectorAll('#more-tabs .more-tab').forEach(t => {
const showTab = !moreGroupMode || t.dataset.mcat === 'tool'; // 群聊模式隐藏其余分类 tab
t.hidden = !showTab;
t.classList.toggle('sel', t.dataset.mcat === cat);
});
if (moreGridAsk) moreGridAsk.hidden = cat !== 'ask';
if (moreGridFun) {
moreGridFun.hidden = cat === 'ask';
moreGridFun.querySelectorAll('.more-item').forEach(it => {
if (moreGroupMode) it.hidden = !GROUP_MORE_ITEM_IDS.has(it.id); // 群聊模式只显允许的 4 项
else it.hidden = it.dataset.mcat !== cat || (it.id === 'more-ck' && window.checkinEnabled && !window.checkinEnabled()); // #823 寻踪关闭时收起「更多功能」里的寻踪
});
}
if (!moreGroupMode) store.set('more-cat', cat);
}
// v3.16.x：群聊页打开共享更多面板时复用同一分类过滤
window.applyMoreCat = applyMoreCat;
// v3.26.x：群聊打开/关闭共享面板时切换群聊过滤模式
window.setMoreGroupMode = (on) => { moreGroupMode = !!on; applyMoreCat('tool', !!on); };
document.querySelectorAll('#more-tabs .more-tab').forEach(t => t.addEventListener('click', (e) => { e.stopPropagation(); applyMoreCat(t.dataset.mcat); }));
moreBtn.addEventListener('click', (e) => {
e.stopPropagation();
if (morePanel.hidden) {
let tab = 'chat';
try {
const saved = store.get('more-cat');
if (saved && MORE_CATS.indexOf(saved) >= 0) tab = saved;
else if (store.get('more-tab') === 'ask') tab = 'ask'; // 旧两页签记忆迁移
} catch (err) {}
applyMoreCat(tab, false); // v3.26.x：聊天页打开面板关闭群聊过滤模式，恢复全部分类
closeIme(); // v3.5.116：收起输入法，面板不被键盘遮挡
// v3.16.x：聊天页打开共享更多面板时隐藏 @群成员 按钮（仅群聊打开时显示）
const tb = document.getElementById('gc-more-at');
if (tb) tb.hidden = true;
}
morePanel.hidden = !morePanel.hidden;
});
document.addEventListener('click', (e) => {
if (!morePanel.hidden && !morePanel.contains(e.target) && e.target !== moreBtn && !moreBtn.contains(e.target)) {
morePanel.hidden = true;
}
});
}
const pokeCard = document.getElementById('poke-card');
const pokeList = document.getElementById('poke-list');
const pokeClose = document.getElementById('poke-card-close');
const pokeName = document.getElementById('poke-partner-name');
// FIX 2026-09-15 #511 点气泡头像「没打开页面就直接发出拍一拍」+「打开拍一拍页默认弹输入法」：
// touch/pointer 路在 touchend 里同步打开面板并渲染字卡/输入行，紧接着浏览器补发的合成 click
// 落点已经在面板内部——落在字卡上就是「面板一闪而过 + 拍一拍已发出」，落在输入框上就会聚焦
// 并弹出输入法（只在「我的拍一拍」tab 出现：输入行仅该 tab 显示）。落点无法预知，故拦截范围
// 取整个面板（字卡 + 分组 chip + tab + 输入行）：手势后的极短窗内吞掉第一次 click，吞掉即失效
// （不影响用户随后的真实点击），时间窗兜底防呆。旧实现只声明了 pokeOpenClickGate 却从未赋值
// （闸恒为 0）＝拦截器形同虚设，本条即用户报障复发的直接原因。
let pokeOpenClickGate = 0;
function pokeArmClickGate() { pokeOpenClickGate = performance.now() + 700; }
function pokeGateActive() { return pokeOpenClickGate > 0 && performance.now() < pokeOpenClickGate; }
function pokeDisarmClickGate() { pokeOpenClickGate = 0; }
if (pokeCard) {
pokeCard.addEventListener('click', (e) => {
if (!pokeGateActive()) return;
pokeDisarmClickGate();
e.preventDefault();
e.stopPropagation();
if (e.stopImmediatePropagation) e.stopImmediatePropagation();
}, true);
// 部分内核对 input 的聚焦在 touchstart 阶段就已决定，click 层 preventDefault 拦不住 →
// 补 focusin 兜底：闸内被聚焦的输入框（含 mobile-adapt 转出的 .ce-box 代理）主动收回焦点。
pokeCard.addEventListener('focusin', (e) => {
if (!pokeGateActive()) return;
const t = e.target;
if (t && typeof t.blur === 'function') { try { t.blur(); } catch (err) {} }
}, true);
}
const POKE_PRESETS = {
ta: ['拍了拍我', '戳了戳我的脸蛋', '弹了一下我的额头', '揉了揉我的头发', '捏了捏我的脸颊', '拍了拍我的肩膀'],
mine: ['拍了拍你', '戳了戳你的脸蛋', '弹了一下你的额头', '揉了揉你的头发', '捏了捏你的脸颊', '拍了拍你的肩膀']
};
function pokeUserGroupsKey(kind) { return window.activePrefix() + ':poke-groups-' + kind; }
function pokeUserGroupsLoad(kind) {
try {
const v = JSON.parse(store.get('poke-groups-' + kind) || 'null');
if (Array.isArray(v)) return v.filter(g => Array.isArray(g) && Array.isArray(g[1]));
} catch (e) {}
return null;
}
// 用户改过分组后置位：防止启动期 IDB 兜底恢复把会话内的修改回滚掉（如删光后又复活）
const pokeDirty = { ta: false, mine: false };
function pokeUserGroupsSave(kind) {
pokeDirty[kind] = true;
try {
const data = JSON.stringify(pokeUserGroups[kind]);
store.set('poke-groups-' + kind, data);
if (window.idbSet) window.idbSet(pokeUserGroupsKey(kind), data);
} catch (e) {}
}
// v3.26.x：初始化只读不写。手机端 LS 缺键（iOS 系统清理/quota 写失败脏键/启动回填
// 未完成）时，旧实现会用「默认空数据」同步回写 LS+IDB，把 IDB 备份覆盖掉——
// 「我的拍一拍」新增条目永久丢失，版本更新刷新重开即复现。数据落库只在用户
// 实际改动时发生（pokeUserGroupsSave），空默认不落盘。
function pokeUserGroupsInit(kind) {
const loaded = pokeUserGroupsLoad(kind);
if (loaded) return loaded;
let legacy = [];
try {
const v = JSON.parse(store.get('poke-user-' + kind) || 'null');
if (Array.isArray(v)) legacy = v.filter(x => typeof x === 'string' && x.trim());
} catch (e) {}
return [['我的新增', legacy]];
}
const pokeUserGroups = { ta: pokeUserGroupsInit('ta'), mine: pokeUserGroupsInit('mine') };
function pokeGroupsCardCount(groups) {
let n = 0;
(groups || []).forEach(g => { if (Array.isArray(g) && Array.isArray(g[1])) n += g[1].length; });
return n;
}
// IDB 兜底恢复：备份条目总数多于内存时采用。旧条件「分组数更多」在单分组数据下
// 永不成立，救不回 1 组 N 条的常见数据。会话内已改过（pokeDirty）则跳过防回滚。
function pokeAdoptFromIdb(kind) {
if (pokeDirty[kind] || !window.idbGet) return Promise.resolve(false);
return window.idbGet(pokeUserGroupsKey(kind)).then(v => {
if (!v || pokeDirty[kind]) return false;
let arr = null;
try { arr = JSON.parse(v); } catch (e) { return false; }
if (!Array.isArray(arr)) return false;
if (pokeGroupsCardCount(arr) > pokeGroupsCardCount(pokeUserGroups[kind])) {
pokeUserGroups[kind] = arr.filter(g => Array.isArray(g) && Array.isArray(g[1]));
return true;
}
return false;
}).catch(() => false);
}
function pokeAdoptAllRerender() {
Promise.all([pokeAdoptFromIdb('ta'), pokeAdoptFromIdb('mine')]).then(adopted => {
if ((adopted[0] || adopted[1]) && pokeCard && !pokeCard.hidden) renderPokeCard();
});
}
if (window.__mochiDataReady) pokeAdoptAllRerender();
else document.addEventListener('mochi-restore-done', pokeAdoptAllRerender);
function pokeKindOf(card) {
if (typeof card !== 'string') return 'mine';
if (card.indexOf('你') >= 0) return 'mine';
if (card.indexOf('我') >= 0) return 'ta';
return 'mine';
}
// FIX 2026-09-17 #648g 拍一拍池媒体守卫——拍一拍短语池（预设+poke-groups 自建+字卡库【拍一拍】
// 分类）混入的媒体形态卡（@@m: 令牌/图链/|||/data:）不得被抽中拼进「TA 拍了拍你 …」＝气泡直出
function pokeTextOnly(x) {
if (typeof x !== 'string' || !x.trim()) return false;
if (x.indexOf('data:') === 0 || x.indexOf('|||') >= 0 || x.indexOf('@@m:') >= 0) return false;
if (/^https?:\/\//i.test(x)) return false;
return true;
}
function pokeAllCards() {
const out = [];
(POKE_PRESETS.ta || []).forEach(x => out.push(x));
(POKE_PRESETS.mine || []).forEach(x => out.push(x));
['ta', 'mine'].forEach(kind => {
(pokeUserGroups[kind] || []).forEach(g => {
if (Array.isArray(g) && Array.isArray(g[1])) g[1].forEach(x => { if (pokeTextOnly(x)) out.push(x); });
});
});
try { ((window.getPokeCards && window.getPokeCards()) || []).forEach(x => out.push(x)); } catch (e) {}
return out;
}
let pokeMode = 'ta';            // 当前 tab：public=公用 / ta=联系人昵称的拍一拍 / mine=我的拍一拍
let pokeCurGroup = '__preset';  // 当前选中分组（'__preset' = 预设）
const pokeTabsRow = document.createElement('div');
pokeTabsRow.className = 'poke-tabs-row';
const pokeTabPub = document.createElement('button');
pokeTabPub.className = 'poke-tab poke-tab-pub';
pokeTabPub.type = 'button';
pokeTabPub.dataset.ptab = 'public';
const pokeTabTa = document.createElement('button');
pokeTabTa.className = 'poke-tab sel poke-tab-ta';
pokeTabTa.type = 'button';
pokeTabTa.dataset.ptab = 'ta';
const pokeTabMine = document.createElement('button');
pokeTabMine.className = 'poke-tab poke-tab-mine';
pokeTabMine.type = 'button';
pokeTabMine.dataset.ptab = 'mine';
pokeTabsRow.appendChild(pokeTabPub);
pokeTabsRow.appendChild(pokeTabTa);
pokeTabsRow.appendChild(pokeTabMine);
const pokeGroupsBar = document.createElement('div');
pokeGroupsBar.className = 'poke-groups';
const pokeInputRow = document.createElement('div');
pokeInputRow.className = 'poke-input-row';
const pokeInput = document.createElement('input');
pokeInput.className = 'poke-input';
pokeInput.type = 'text';
pokeInput.placeholder = '输入拍一拍文字，如：拍了拍你的脸蛋';
pokeInput.setAttribute('autocomplete', 'off');
pokeInput.setAttribute('autocorrect', 'off');
pokeInput.setAttribute('autocapitalize', 'off');
pokeInput.setAttribute('spellcheck', 'false');
const pokeInputSave = document.createElement('button');
pokeInputSave.className = 'poke-input-save';
pokeInputSave.type = 'button';
pokeInputSave.textContent = '存入';
pokeInputSave.title = '存到当前选中的分组';
const pokeInputGo = document.createElement('button');
pokeInputGo.className = 'poke-input-go';
pokeInputGo.type = 'button';
pokeInputGo.textContent = '发送';
// 存入：把输入的文字保存到当前选中分组（预设分组不可写，自动落到第一个用户分组）
function pokeTargetGroup() {
const groups = pokeUserGroups.mine;
let target = groups.find(g => g[0] === pokeCurGroup) || groups[0];
if (!target) { target = ['我的新增', []]; groups.push(target); }
return target;
}
function savePokeInput() {
const v = (pokeInput && pokeInput.value || '').trim();
if (!v) { toast('先输入拍一拍文字'); return; }
const target = pokeTargetGroup();
if (target[1].indexOf(v) >= 0) { toast('「' + target[0] + '」已有相同的拍一拍'); return; }
target[1].push(v);
pokeUserGroupsSave('mine');
pokeCurGroup = target[0];
savePokePref();
renderPokeCard();
if (pokeInput) pokeInput.value = '';
toast('已存入「' + target[0] + '」');
}
function doPokeInput() {
const v = (pokeInput && pokeInput.value || '').trim();
if (!v) { toast('先输入拍一拍文字'); return; }
sendPoke(v);
if (pokeInput) pokeInput.value = '';
closePokeCard();
}
pokeInputSave.addEventListener('click', (e) => {
e.stopPropagation();
savePokeInput();
});
pokeInputGo.addEventListener('click', (e) => {
e.stopPropagation();
doPokeInput();
});
pokeInput.addEventListener('keydown', (e) => {
if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
e.stopPropagation();
doPokeInput();
}
});
pokeInputRow.appendChild(pokeInput);
pokeInputRow.appendChild(pokeInputSave);
pokeInputRow.appendChild(pokeInputGo);
if (pokeCard) {
pokeCard.insertBefore(pokeTabsRow, pokeList);
pokeCard.insertBefore(pokeGroupsBar, pokeList);
// 输入行放面板最底部（footer）：键盘弹起面板收缩时它是最后一行，离键盘最近、不会被盖住
pokeCard.appendChild(pokeInputRow);
}
function sendPoke(action) {
// FIX 2026-09-17 #648g 面板单点防御：媒体形态串（存量导入/令牌化产物）不当拍一拍短语发出
if (!pokeTextOnly(action)) { toast('这条不是文字拍一拍，已跳过'); return; }
// v3.26.x：存 {me}/{ta} 占位符而非字面昵称——渲染 T() 回填「我的昵称 + TA 的昵称」
// （跟随改名），称呼功能（taFit）不再把昵称槽位改写成 他/ta/她
let text;
if (action.indexOf('你') >= 0) {
if (action.charAt(0) === '你') {
text = '{me}' + action.slice(1).replace(/我(?![们])/g, '{ta}');
} else if (action.charAt(0) === '我') {
text = action.replace(/你(?![们])/g, '{ta}');
} else {
text = '{me} ' + action.replace(/你(?![们])/g, '{ta}');
}
} else if (action.indexOf('我') >= 0) {
if (action.charAt(0) === '我') {
text = '{me} ' + action.slice(1).replace(/我(?![们])/g, '{ta}');
} else {
text = '{me} ' + action.replace(/我(?![们])/g, '{ta}');
}
} else {
text = '{me} ' + action;
}
// FIX 2026-09-17 拍一拍发出不跟底：用户主动触发的 in 侧消息（同 #492 决策结果），置一次性
// 跟底标记——否则上翻过聊天＝解钉态，拍一拍气泡永远落在视口下方不自动滚到最底
chatUserFollowScroll = true;
addRec({ side: 'in', text: text, special: 'poke', rateAllow: true, nightAllow: true });
if (window.logFish) window.logFish();
setTimeout(() => {
const c2 = cfg();
if (hit(c2['rn-prob'])) {
addIn('', { special: 'read' });
return;
}
showTyping();
setTimeout(() => {
hideTyping();
if (hit(c2['touch-prob'])) { performPoke(); return; }
const r = genOneReply(c2);
// #693 多字卡回复 tag 同口径：拍一拍追问也走 genOneReply 抽卡链路，命中多字卡回复时补挂来源 chip
const rMulti = pyMultiDrawn;
// FIX 2026-09-16 #553 撤回先掷签（#345 同族收口③：拍一拍追问）——原与 #345 修复前的
// tryAutoSend 同病：addIn 弹横幅/系统通知后才掷 rc-prob，900ms 后 retractMsg＝通知已承诺的
// 内容进聊天没有。投递前定生死：命中撤回的本条静默落地（未读角标照增），1~3 秒随机后照常撤回。
const willRetractP = hit(c2['rc-prob']);
const m2 = addIn(r.text, { type: r.type, silent: willRetractP, tag: rMulti ? '多字卡回复' : undefined, tagNoDup: true });
if (willRetractP && m2) {
setTimeout(() => { retractMsg(m2, 'in'); }, retractDelayMs());
}
}, randInt(800, 2000));
}, randInt(600, 1200));
}
function savePokePref() {
try { store.set('poke-tab', pokeMode); } catch (e) {}
try { store.set('poke-group-' + pokeMode, pokeCurGroup); } catch (e) {}
}
(function () {
try {
const p = store.get('poke-tab');
if (p === 'mine' || p === 'public') pokeMode = p;
} catch (e) {}
try {
const g = store.get('poke-group-' + pokeMode);
if (typeof g === 'string' && g) pokeCurGroup = g;
} catch (e) {}
})();
function pokeTabLabel(kind) {
if (kind === 'public') return '公用拍一拍';
if (kind === 'ta') {
const n = chatPartnerName();
return n + ' 的拍一拍';
}
const n = chatUserName();
return (n === '我' ? '我的' : n + ' 的') + '拍一拍';
}
function pokeTabGroups(kind) {
const out = [];
if (kind === 'public' || kind === 'ta') {
let legacy = [];
try { legacy = (window.getScopedGroups && window.getScopedGroups('poke', kind)) || []; } catch (e) {}
legacy.forEach(g => {
if (!Array.isArray(g) || !Array.isArray(g[1]) || !g[0]) return;
out.push({ key: g[0], label: g[0], cards: g[1].slice() });
});
return out;
}
const presets = (POKE_PRESETS.mine || []).slice();
out.push({ key: '__preset', label: '预设', cards: presets });
(pokeUserGroups.mine || []).forEach(g => {
if (!Array.isArray(g) || !Array.isArray(g[1]) || !g[0]) return;
out.push({ key: g[0], label: g[0], cards: g[1].slice(), user: true });
});
return out;
}
function pokeCardEl(c, opts) {
const d = document.createElement('div');
d.className = 'cc-item glass';
d.innerHTML = '<div class="cc-txt"><div class="t">' + c + '</div></div>';
d.addEventListener('click', () => { sendPoke(c); closePokeCard(); });
if (opts && opts.editable) {
const ops = document.createElement('div');
ops.className = 'poke-card-ops';
const eb = document.createElement('button');
eb.type = 'button';
eb.className = 'poke-card-op poke-op-edit';
eb.title = '修改';
eb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
eb.addEventListener('click', (e) => {
e.stopPropagation();
pokeEditCard(opts.groupKey, opts.idx, c);
});
const db = document.createElement('button');
db.type = 'button';
db.className = 'poke-card-op poke-op-del';
db.title = '删除';
db.textContent = '✕';
db.addEventListener('click', (e) => {
e.stopPropagation();
pokeDelCard(opts.groupKey, opts.idx, c);
});
ops.appendChild(eb);
ops.appendChild(db);
d.appendChild(ops);
}
return d;
}
function pokeEditCard(groupKey, idx, old) {
const groups = pokeUserGroups.mine;
const g = groups.find(x => x[0] === groupKey);
if (!g || !Array.isArray(g[1]) || idx < 0 || idx >= g[1].length) return;
window.openModal('修改拍一拍', old, (v) => {
v = (v || '').trim();
if (!v) { toast('请输入拍一拍文字'); return; }
const g2 = groups.find(x => x[0] === groupKey);
if (!g2 || !Array.isArray(g2[1]) || idx < 0 || idx >= g2[1].length) return;
if (g2[1][idx] === v) { toast('内容未变化'); return; }
if (g2[1].indexOf(v) >= 0) { toast('该分组已有相同的拍一拍'); return; }
g2[1][idx] = v;
pokeUserGroupsSave('mine');
renderPokeCard();
toast('已修改');
});
}
function pokeDelCard(groupKey, idx, c) {
const groups = pokeUserGroups.mine;
const g = groups.find(x => x[0] === groupKey);
if (!g || !Array.isArray(g[1]) || idx < 0 || idx >= g[1].length) return;
window.openModal('删除这条拍一拍？', '', () => {
const g2 = groups.find(x => x[0] === groupKey);
if (!g2 || !Array.isArray(g2[1]) || idx < 0 || idx >= g2[1].length) return;
g2[1].splice(idx, 1);
pokeUserGroupsSave('mine');
renderPokeCard();
toast('已删除');
}, { noInput: true, staticText: '「' + c + '」\n\n删除后无法恢复。' });
}
function renderPokeGroupsBar(groups) {
if (!pokeGroupsBar) return;
pokeGroupsBar.innerHTML = '';
if (!groups.some(g => g.key === pokeCurGroup)) pokeCurGroup = groups.length ? groups[0].key : '__preset';
groups.forEach(g => {
const c = document.createElement('span');
c.className = 'emoji-g-chip' + (pokeCurGroup === g.key ? ' sel' : '');
c.textContent = g.label + g.cards.length;
c.addEventListener('click', (e) => {
e.stopPropagation();
pokeCurGroup = g.key;
savePokePref();
renderPokeCard();
});
pokeGroupsBar.appendChild(c);
});
if (pokeMode === 'mine') {
const add = document.createElement('span');
add.className = 'emoji-g-chip poke-g-add';
add.textContent = '＋ 分组';
add.title = '新建拍一拍分组';
add.addEventListener('click', (e) => {
e.stopPropagation();
pokeNewGroupAction();
});
pokeGroupsBar.appendChild(add);
}
}
function renderPokeCard() {
const name = chatPartnerName();
if (pokeName) pokeName.textContent = name;
pokeTabPub.textContent = pokeTabLabel('public');
pokeTabTa.textContent = pokeTabLabel('ta');
pokeTabMine.textContent = pokeTabLabel('mine');
pokeTabPub.classList.toggle('sel', pokeMode === 'public');
pokeTabTa.classList.toggle('sel', pokeMode === 'ta');
pokeTabMine.classList.toggle('sel', pokeMode === 'mine');
if (pokeInputRow) pokeInputRow.hidden = pokeMode !== 'mine';
pokeInput.placeholder = '输入拍一拍文字，如：拍了拍你的脸蛋';
const groups = pokeTabGroups(pokeMode);
renderPokeGroupsBar(groups);
if (!pokeList) return;
pokeList.innerHTML = '';
if (!groups.length) {
// FIX 2026-09-16 #575：字卡还在从 IDB 取回（iOS 挂后台杀连接时 6~14s）→ 出加载占位，
// 不把「暂无拍一拍字卡」空态挂上去（会被当成字卡丢了）；取回完成由 done 回调重渲替换
pokeList.innerHTML = ccPanelsFetching
? ccLoadRowHtml('正在加载拍一拍字卡…')
: (pokeMode === 'public'
? '<div class="cc-empty">暂无公用拍一拍<br>请到 字卡库 → 公用字卡 → 拍一拍 添加</div>'
: pokeMode === 'ta'
? '<div class="cc-empty">暂无拍一拍字卡<br>请到 字卡库 → 专属字卡 → 拍一拍 添加</div>'
: '<div class="cc-empty">暂无拍一拍字卡<br>在下方输入文字，点「存入」添加</div>');
return;
}
const cur = groups.find(g => g.key === pokeCurGroup) || groups[0];
if (!cur.cards.length) {
pokeList.innerHTML = ccPanelsFetching
? ccLoadRowHtml('正在加载该分组拍一拍…')
: (pokeMode === 'public'
? '<div class="cc-empty">该分组暂无公用拍一拍<br>请到 字卡库 → 公用字卡 → 拍一拍 添加</div>'
: pokeMode === 'ta'
? '<div class="cc-empty">该分组暂无拍一拍字卡<br>请到 字卡库 → 专属字卡 → 拍一拍 添加</div>'
: '<div class="cc-empty">该分组暂无拍一拍<br>在下方输入文字，点「存入」添加到该分组</div>');
return;
}
cur.cards.forEach((c, i) => {
const editable = pokeMode === 'mine' && cur.key !== '__preset' && cur.user;
pokeList.appendChild(pokeCardEl(c, editable ? { editable: true, groupKey: cur.key, idx: i } : null));
});
}
function closePokeCard() {
if (pokeCard) pokeCard.hidden = true;
}
pokeTabPub.addEventListener('click', (e) => {
e.stopPropagation();
if (pokeMode !== 'public') { pokeMode = 'public'; savePokePref(); renderPokeCard(); }
});
pokeTabTa.addEventListener('click', (e) => {
e.stopPropagation();
if (pokeMode !== 'ta') { pokeMode = 'ta'; savePokePref(); renderPokeCard(); }
});
pokeTabMine.addEventListener('click', (e) => {
e.stopPropagation();
if (pokeMode !== 'mine') { pokeMode = 'mine'; savePokePref(); renderPokeCard(); }
});
// 新建分组：入口在分组栏尾部的「＋ 分组」chip（renderPokeGroupsBar），仅我的拍一拍显示
function pokeNewGroupAction() {
window.openModal('新建拍一拍分组（当前为「' + pokeTabLabel(pokeMode) + '」）', '', (v) => {
v = (v || '').trim();
if (!v) { toast('请输入分组名'); return; }
const groups = pokeUserGroups[pokeMode];
if (groups.some(g => g[0] === v)) { toast('分组「' + v + '」已存在'); return; }
groups.push([v, []]);
pokeUserGroupsSave(pokeMode);
pokeCurGroup = v;
savePokePref();
renderPokeCard();
toast('已新建分组「' + v + '」');
});
}
document.addEventListener('contact-switched', function () {
try { pokeDirty.ta = false; pokeDirty.mine = false; pokeUserGroups.ta = pokeUserGroupsInit('ta'); pokeUserGroups.mine = pokeUserGroupsInit('mine'); pokeAdoptAllRerender(); } catch (e) {}
try { if (pokeCard) pokeCard.hidden = true; } catch (e) {}
});
const morePoke = document.getElementById('more-poke');
if (morePoke) {
morePoke.addEventListener('click', (e) => {
e.stopPropagation();
openPokeCard();
});
}
// 摸一摸：互动面板入口。复用拍一拍的发送链路（sendPoke＝同一套 {me}/{ta} 占位与 TA 回拍逻辑），
// 只换一组「摸」的动作短语；点选即发（pillSubmit），无需再点确定。
const moreTouch = document.getElementById('more-touch');
if (moreTouch) {
moreTouch.addEventListener('click', (e) => {
e.stopPropagation();
if (morePanel) morePanel.hidden = true;
if (!window.openModal) { sendPoke('摸一摸你'); return; }
const TOUCH_ACTS = ['摸摸头', '捏捏脸', '戳戳脸颊', '揉揉头发', '牵起手', '抱一下', '蹭一蹭', '拍拍肩膀'];
window.openModal('摸一摸', '', (v) => {
const a = TOUCH_ACTS[Number(v)];
if (a) sendPoke(a);
}, { noInput: true, pillSubmit: true, pills: TOUCH_ACTS.map((label, value) => ({ label: label, value: value })) });
});
}
const rpsPanel = document.getElementById('chat-rps-panel');
const rpsCloseBtn = document.getElementById('chat-rps-close');
// #306 全屏：猜拳面板 fixed 满屏（共享 .game-fs 类）。重开面板先退出，防全屏残留
const rpsFsBtn = document.getElementById('rps-fs');
let rpsIsFs = false;
function rpsToggleFs() {
if (!rpsPanel) return;
rpsIsFs = !rpsIsFs;
rpsPanel.classList.toggle('game-fs', rpsIsFs);
if (rpsFsBtn) rpsFsBtn.textContent = rpsIsFs ? '⤢' : '⛶';
}
if (rpsFsBtn) rpsFsBtn.addEventListener('click', (e) => { e.stopPropagation(); rpsToggleFs(); });
const rpsScoreEl = document.getElementById('rps-score');
const rpsHintEl = document.getElementById('rps-hint');
const rpsNameEl = document.getElementById('rps-partner-name');
function rpsReadScore() {
try { return JSON.parse(store.get('rps-score') || '{"w":0,"l":0,"d":0}'); }
catch (e) { return { w: 0, l: 0, d: 0 }; }
}
function rpsWriteScore(s) { store.set('rps-score', JSON.stringify(s)); }
function rpsRenderScore() {
if (!rpsScoreEl) return;
const s = rpsReadScore();
rpsScoreEl.textContent = '胜 ' + s.w + ' · 负 ' + s.l + ' · 平 ' + s.d;
}
function openRpsPanel() {
if (!rpsPanel) return;
try { if (rpsIsFs) rpsToggleFs(); } catch (e) {}
const pc = document.getElementById('poke-card'); if (pc) pc.hidden = true;
const ep = document.getElementById('emoji-panel'); if (ep) ep.hidden = true;
const askP = document.getElementById('chat-ask-panel'); if (askP) closeChatAskPanel();
const cs = document.getElementById('chat-search'); if (cs) cs.hidden = true;
const dv = document.getElementById('chat-divine-panel'); if (dv) dv.hidden = true;
const dp = document.getElementById('chat-decision-panel'); if (dp) dp.hidden = true;
if (window.closeAvlib) window.closeAvlib();
if (morePanel) morePanel.hidden = true;
if (rpsNameEl) rpsNameEl.textContent = chatPartnerName();
if (rpsHintEl) rpsHintEl.textContent = '选择你要出的拳';
rpsRenderScore();
rpsPanel.hidden = false;
}
function closeRpsPanel() { if (rpsPanel) rpsPanel.hidden = true; }
// v3.16.x：导出到 window——联系人猜拳邀请同意后 openInvitePanelFor 走 window.openRpsPanel，
// 此前只导出 pong/snake 忘了 rps，导致猜拳邀请同意后不开面板（历史 bug，自 v3.13.x 引入）
window.openRpsPanel = openRpsPanel;
window.closeRpsPanel = closeRpsPanel;
function rpsJudge(a, b) {
if (a === b) return 0;
if ((a === 'rock' && b === 'scissors') ||
(a === 'scissors' && b === 'paper') ||
(a === 'paper' && b === 'rock')) return 1;
return -1;
}
function sendRps(mine) {
closeRpsPanel();
const mineName = { rock: '石头', scissors: '剪刀', paper: '布' }[mine] || '';
addRec({ side: 'in', special: 'poke', text: '我出了 ' + mineName + '，等 TA 出拳…', nightAllow: true, rateAllow: true });
showTyping();
setTimeout(() => {
hideTyping();
const ta = ['rock', 'scissors', 'paper'][Math.floor(Math.random() * 3)];
const judge = rpsJudge(mine, ta);
const s = rpsReadScore();
if (judge > 0) s.w++; else if (judge < 0) s.l++; else s.d++;
rpsWriteScore(s);
addRec({ side: 'in', special: 'rps', rpsMine: mine, rpsTa: ta, rpsResult: judge, nightAllow: true, rateAllow: true });
// v3.15.x 二调：奖励对齐红包金额体系——胜 70% ¥5.2 / 30% ¥13.14，平 ¥1.3（日封顶 ¥26）
// v3.16.x：石头剪刀布改为双方同步同额入账（不再只给赢家），记赚钱流水「石头剪刀布」
try {
const rpsWinFen = Math.random() < 0.3 ? 1314 : 520;
const real = rpGameCoinGrant('rps', judge > 0 ? rpsWinFen : judge < 0 ? 520 : 130, 2600);
if (real > 0) {
const w = rpWalletGet();
w.myBalance += real; w.systemBalance += real;
rpWalletSet(w);
try { if (window.giftCoinLedgerAdd) window.giftCoinLedgerAdd('earn', real, real, '石头剪刀布'); } catch (e2) {}
setTimeout(() => addIn('🪙 双方心意币各 +¥' + (real / 100).toFixed(2), { special: 'poke', nightAllow: true, rateAllow: true }), randInt(800, 1600));
}
} catch (e) {}
if (window.logFish) window.logFish();
}, randInt(900, 1600));
}
const moreRps = document.getElementById('more-rps');
if (moreRps) {
moreRps.addEventListener('click', (e) => { e.stopPropagation(); openRpsPanel(); });
}
if (rpsCloseBtn) {
rpsCloseBtn.addEventListener('click', (e) => { e.stopPropagation(); closeRpsPanel(); });
}
if (rpsPanel) {
rpsPanel.querySelectorAll('.rps-choice').forEach(btn => {
btn.addEventListener('click', (e) => {
e.stopPropagation();
const v = btn.dataset.rps;
if (v) sendRps(v);
});
});
}
const rpPanel = document.getElementById('chat-rp-panel');
const rpCloseBtn = document.getElementById('chat-rp-close');
const rpNameEl = document.getElementById('rp-partner-name');
const rpQixiTag = document.getElementById('rp-qixi-tag');
const rpQixiSection = document.getElementById('rp-qixi-section');
const rpRandVal = document.getElementById('rp-rand-val');
const rpCustomInput = document.getElementById('rp-custom');
const rpWishInput = document.getElementById('rp-wish');
const rpSendBtn = document.getElementById('rp-send-btn');
const rpSettingsBtn = document.getElementById('rp-settings-btn');
const rpSettings = document.getElementById('rp-settings');
const rpSettingsDone = document.getElementById('rp-settings-done');
const rpScrollEl = rpPanel ? rpPanel.querySelector('.poke-card-scroll') : null;
let rpSide = 'out';
let rpPickedAmt = null;
const QIXI_DATES = ['2024-08-10','2025-08-29','2026-08-19','2027-08-08','2028-08-26','2029-08-15','2030-08-04'];
function isQixiToday() {
const d = new Date();
const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
return QIXI_DATES.indexOf(k) >= 0;
}
function openRpPanel() {
if (!rpPanel) return;
const pc = document.getElementById('poke-card'); if (pc) pc.hidden = true;
const ep = document.getElementById('emoji-panel'); if (ep) ep.hidden = true;
const askP = document.getElementById('chat-ask-panel'); if (askP) closeChatAskPanel();
const cs = document.getElementById('chat-search'); if (cs) cs.hidden = true;
const dv = document.getElementById('chat-divine-panel'); if (dv) dv.hidden = true;
const dp = document.getElementById('chat-decision-panel'); if (dp) dp.hidden = true;
const rpsP = document.getElementById('chat-rps-panel'); if (rpsP) rpsP.hidden = true;
if (window.closeAvlib) window.closeAvlib();
if (morePanel) morePanel.hidden = true;
if (rpNameEl) rpNameEl.textContent = chatPartnerName();
if (isQixiToday()) {
if (rpQixiTag) rpQixiTag.hidden = false;
if (rpQixiSection) { rpQixiSection.hidden = false; rpQixiSection.classList.add('qixi-today'); }
if (rpWishInput) rpWishInput.placeholder = '七夕快乐';
} else {
if (rpQixiTag) rpQixiTag.hidden = true;
if (rpQixiSection) { rpQixiSection.hidden = true; rpQixiSection.classList.remove('qixi-today'); }
if (rpWishInput) rpWishInput.placeholder = '心意';
}
rpSide = 'out';
rpPickedAmt = null;
if (rpCustomInput) rpCustomInput.value = '';
if (rpWishInput) rpWishInput.value = '';
if (rpRandVal) rpRandVal.textContent = '';
rpPanel.querySelectorAll('.rp-side').forEach(b => b.classList.toggle('sel', b.dataset.rpside === 'out'));
rpPanel.querySelectorAll('.rp-amt').forEach(b => b.classList.remove('sel'));
closeIme();
rpRenderBalance();
rpRenderCover();
closeRpSettings();
rpPanel.hidden = false;
}
function closeRpPanel() { if (rpPanel) rpPanel.hidden = true; closeRpSettings(); }
// v3.29.x：红包半框「设置」→ TA 自动发红包（概率/每日上限）。设置区默认收起，
// 打开时同步一次显示值；「完成」或关闭面板均回到红包主界面。
function openRpSettings() {
  if (!rpSettings) return;
  if (window.csRpSettingsSync) { try { window.csRpSettingsSync(); } catch (e) {} }
  if (rpBalanceEl) rpBalanceEl.hidden = true;
  if (rpScrollEl) rpScrollEl.hidden = true;
  rpSettings.hidden = false;
}
function closeRpSettings() {
  if (!rpSettings) return;
  rpSettings.hidden = true;
  if (rpBalanceEl) rpBalanceEl.hidden = false;
  if (rpScrollEl) rpScrollEl.hidden = false;
}
if (rpSettingsBtn) rpSettingsBtn.addEventListener('click', (e) => { e.stopPropagation(); openRpSettings(); });
if (rpSettingsDone) rpSettingsDone.addEventListener('click', (e) => { e.stopPropagation(); closeRpSettings(); });
if (rpPanel) {
rpPanel.querySelectorAll('.rp-side').forEach(btn => {
btn.addEventListener('click', (e) => {
e.stopPropagation();
rpSide = btn.dataset.rpside || 'out';
rpPanel.querySelectorAll('.rp-side').forEach(b => b.classList.toggle('sel', b === btn));
rpRenderCover();
});
});
rpPanel.querySelectorAll('.rp-amt').forEach(btn => {
btn.addEventListener('click', (e) => {
e.stopPropagation();
const v = btn.dataset.rpamt;
if (v === 'rand') {
const r = Math.round(Math.random() * 20000 + 1) / 100;
rpPickedAmt = r;
if (rpRandVal) rpRandVal.textContent = '本次随机：¥' + r.toFixed(2);
if (rpCustomInput) rpCustomInput.value = '';
rpPanel.querySelectorAll('.rp-amt').forEach(b => b.classList.remove('sel'));
btn.classList.add('sel');
return;
}
rpPickedAmt = parseFloat(v);
if (rpRandVal) rpRandVal.textContent = '';
if (rpCustomInput) rpCustomInput.value = '';
rpPanel.querySelectorAll('.rp-amt').forEach(b => b.classList.remove('sel'));
btn.classList.add('sel');
});
});
if (rpCustomInput) {
rpCustomInput.addEventListener('input', () => {
rpPanel.querySelectorAll('.rp-amt').forEach(b => b.classList.remove('sel'));
if (rpRandVal) rpRandVal.textContent = '';
});
}
}
// v3.15.x 二轮：钱包读写委托 gift-shop 的【全局一本账】（根键 xy-home-v2:gift-wallet，跨桌面共用）；
// 本地 ns 逻辑仅作 gift-shop 未加载时的兜底。新用户默认双方各 ¥520。
const RP_WALLET_KEY = 'gift-wallet';
const RP_LEGACY_WALLET_KEY = 'rp-wallet';
const RP_WALLET_DEFAULT_FEN = 52000;
const RP_DAILY_PREFIX = 'ml2_rp_daily_';
function rpWalletGet() {
if (typeof window.giftWalletGet === 'function') return window.giftWalletGet();
try {
const w = JSON.parse(store.get(RP_WALLET_KEY) || '');
if (typeof w.myBalance === 'number' && typeof w.systemBalance === 'number') {
if (w.myBalance === 99999999 && w.systemBalance === 99999999) {
const nw = { myBalance: RP_WALLET_DEFAULT_FEN, systemBalance: RP_WALLET_DEFAULT_FEN };
store.set(RP_WALLET_KEY, JSON.stringify(nw));
return nw;
}
return w;
}
} catch (e) {}
let seed = { myBalance: RP_WALLET_DEFAULT_FEN, systemBalance: RP_WALLET_DEFAULT_FEN };
try {
const o = JSON.parse(store.get(RP_LEGACY_WALLET_KEY) || '');
if (typeof o.myBalance === 'number' && typeof o.systemBalance === 'number') seed = { myBalance: o.myBalance, systemBalance: o.systemBalance };
} catch (e) {}
store.set(RP_WALLET_KEY, JSON.stringify(seed));
return seed;
}
function rpWalletSet(w) {
if (typeof window.giftWalletSet === 'function') { window.giftWalletSet(w); return; }
store.set(RP_WALLET_KEY, JSON.stringify(w));
}
const RP_EXPIRY_MS = 24 * 60 * 60 * 1000;
const RP_SPECIAL_FEN = [520, 5200, 52000, 520000, 1314, 131400]; // 5.2/52/520/5200/13.14/1314 元
function rpDailyKey() { return RP_DAILY_PREFIX + rpLocalDay(); } // FIX 2026-09-25 #1256：日计数改本地日期键（UTC 口径「每天」实际早 8 点才翻篇；同 FIX 2026-09-16 游戏奖励口径，rpLocalDay 声明在下、函数整体提升）
function rpDailyCount() {
return Number(store.get(rpDailyKey())) || 0;
}
function rpDailyIncr() {
const k = rpDailyKey();
store.set(k, String((Number(store.get(k)) || 0) + 1));
}
// v3.15.x：小游戏联动心意币——按日封顶发放（fen），返回实际入账分值（0=今日已到顶）
// FIX 2026-09-16：日封顶键 UTC 日期改本地日期（UTC 口径下北京时间 0-8 点的奖励记到前一天）
function rpLocalDay() { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
function rpGameCoinGrant(gameKey, fen, capFen) {
if (!fen || fen <= 0) return 0;
const k = 'ml2_coin_' + gameKey + '_' + rpLocalDay();
const cur = Number(store.get(k)) || 0;
if (cur >= capFen) return 0;
const real = Math.min(fen, capFen - cur);
store.set(k, String(cur + real));
return real;
}
function rpCoinTxt(real, toTa) {
return '🪙 ' + (toTa ? chatPartnerName() + ' 的心意币' : '我的心意币') + ' +¥' + (real / 100).toFixed(2);
}
function genRpAmount(systemBalanceFen) {
let amt;
if (Math.random() < 0.4) {
amt = RP_SPECIAL_FEN[Math.floor(Math.random() * RP_SPECIAL_FEN.length)];
} else if (Math.random() < 0.8) {
const max = Math.min(5200000, systemBalanceFen); // 52000 元 = 5200000 分
amt = Math.floor(Math.random() * max) + 1;
} else {
amt = Math.floor(Math.random() * systemBalanceFen) + 1;
}
return Math.min(amt, systemBalanceFen);
}
function rpStatusText(rec) {
const st = rec.rpStatus || 'pending';
if (st === 'received') return '已领取';
if (st === 'expired') return '已过期·退回';
if (st === 'returned') return '已退回';
return rec.side === 'out' ? (window.taFit ? window.taFit('待TA领取') : '待TA领取') : '待领取'; // #1477：side 缺失的历史卡与渲染的「联系人 发出」同侧＝待我领取
}
function rpStatusCls(rec) {
const st = rec.rpStatus || 'pending';
if (st === 'received') return 'opened';
if (st === 'expired' || st === 'returned') return 'expired';
return '';
}
// FIX 2026-09-07 #230 红包状态流转闪屏：领取/退回/TA领取/TA退回此前一律 renderWindow
// 整窗重建——body.innerHTML='' 后全部气泡（img 重新解码）＝肉眼整屏闪一下，是 #211/#220
// 同根因（整窗重建闪动）家族的最后一条未收口路径；领红包必经此处＝所有机型每次必闪
//（与机型、历史条数无关，#211/#220 的窗口闸拦不到它，无头实测点击即 add31/rem31）。
// 改原地补丁：只更新该卡片的 opened/expired class 与状态文案（卡片尺寸不变＝无布局跳动，
// childList 零变动＝零闪动）；卡片不在当前渲染窗口（历史被裁剪出窗口等）时回退调用方的
// 原整窗渲染，行为与旧版一致。
function rpPatchStatusInPlace(idx) {
const rec = msgs[idx];
if (!rec || rec.special !== 'redpacket') return false;
if (!body) return false;
const el = body.querySelector('.msg-rp[data-idx="' + idx + '"]');
if (!el) return false;
const card = el.querySelector('.msg-rp-card');
if (!card) return false;
card.classList.remove('opened', 'expired');
const cls = rpStatusCls(rec);
if (cls) card.classList.add(cls);
const st = card.querySelector('.msg-rp-status');
if (st) st.textContent = rpStatusText(rec);
return true;
}
// v3.28.x：TA 每日发红包上限次数可设——对话设置「TA 每日发红包上限」cs-rp-daily-max
// （每联系人独立，默认 5，0=不限），chat-settings.js 写同一键
function rpDailyMax() {
try { const v = parseInt(store.get('cs-rp-daily-max'), 10); if (isFinite(v) && v >= 0) return v; } catch (e) {}
return 5;
}
function trySystemAutoSend() {
// #1015 夜间静默：TA 自动红包夜间不生成——钱包扣款发生在投递前，必须在源头拦（总闸拦消息
// 会造成「扣了钱没红包」）。同口径：trySystemAskMochi / gift-shop 的 maybeAutoGift。
if (window.nightModeActive && window.nightModeActive()) return;
if (rateLimitFull()) return; // #1341：同一条口径补到总量限流——额度满时这一发压根不生成，别扣了钱再让卡片被闸拦掉（红包卡是唯一领取入口）
const rpMax = rpDailyMax(); if (rpMax > 0 && rpDailyCount() >= rpMax) return; // FIX 2026-09-25 #1256：0＝不限是设置页承诺——旧式 max=0 时 0>=0 恒真＝自动红包被整日封死（同 trySystemAskMochi 的 askMax>0 守卫）
// v3.6.x：TA 自动红包概率可调——读对话设置「红包-自动发红包概率」cs-rp-auto-prob（每联系人独立，默认 4%）
let baseRate = 0.04;
try { const ap = window.activeStore ? window.activeStore().get('cs-rp-auto-prob') : null; const pv = parseFloat(ap); if (pv !== null && isFinite(pv)) baseRate = Math.max(0, Math.min(100, pv)) / 100; } catch (e) {}
const qixi = isQixiToday();
if (qixi) baseRate *= 2;
if (Math.random() >= baseRate) return;
// v3.15.x：TA 自动红包不再受余额约束——余额不足也照发（可透支为负），金额上限维持原 ¥52000 档
let amtFen, wish;
if (qixi && Math.random() < 0.6) {
const qixiPool = [777, 7777, 77777];
if (qixiPool.length) {
amtFen = pick(qixiPool);
wish = pick(['七夕快乐', '七夕快乐呀', '宝宝七夕快乐', '今天七夕，给你花']);
} else {
amtFen = genRpAmount(5200000);
wish = '七夕快乐';
}
} else {
amtFen = genRpAmount(5200000);
wish = pick(['心意', '给你花', '小礼物', '辛苦啦', '开心一下']);
}
if (amtFen < 1) return;
const wallet = rpWalletGet();
wallet.systemBalance -= amtFen;
rpWalletSet(wallet);
rpDailyIncr();
const amt = amtFen / 100;
const myCid = window.__activeCid || 'default';
setTimeout(() => {
if ((window.__activeCid || 'default') !== myCid) return;
addIn('', { special: 'redpacket', rateAllow: true, rpAmount: amt, rpWish: wish, rpStatus: 'pending', rpTs: Date.now(), rpCover: rpCoverGet('in') ? 1 : 0 });
if (window.logFish) window.logFish();
}, randInt(800, 2000));
}
const ASK_DAILY_PREFIX = 'ml2_ask_daily_';
function askDailyCount() {
const k = ASK_DAILY_PREFIX + new Date().toISOString().slice(0, 10);
return Number(store.get(k)) || 0;
}
function askDailyIncr() {
const k = ASK_DAILY_PREFIX + new Date().toISOString().slice(0, 10);
store.set(k, String((Number(store.get(k)) || 0) + 1));
}
// v3.15.x：TA 也会随机「向 Mochi 申请」心意币——金额与红包同款随机分布（genRpAmount），
// 概率门读红包半框设置的申请概率（默认 4%，不沿用红包七夕加成）；
// v3.29.x：概率与每日上限改为「每个联系人单独设」——红包半框「设置」写 cs-rp-ask-prob /
// cs-rp-ask-daily-max（与自动发红包两行同域同口径）。该联系人没单独设过时回退旧的存钱罐
// 全局根键（piggy-coin-prob.ask / piggy-coin-ask-limit），历史设置不丢。
// 取值挂 window 供 chat-settings.js 复用，防两处默认值漂移。入 TA 的 systemBalance，聊天留 askcoin 卡片
function rpAskProbRate() {
let v = NaN;
try { v = parseFloat(store.get('cs-rp-ask-prob')); } catch (e) {}
if (isFinite(v)) return Math.max(0, Math.min(100, v)) / 100;
try { const p = JSON.parse((window.xyStore('xy-home-v2')).get('piggy-coin-prob') || 'null'); if (p && typeof p.ask === 'number') return Math.max(0, Math.min(1, p.ask)); } catch (e) {}
return 0.04;
}
function rpAskDailyMax() {
let v = NaN;
try { v = parseInt(store.get('cs-rp-ask-daily-max'), 10); } catch (e) {}
if (isFinite(v) && v >= 0) return v;
try { const g = parseInt((window.xyStore('xy-home-v2')).get('piggy-coin-ask-limit'), 10); if (isFinite(g) && g >= 0) return g; } catch (e) {}
return 0;
}
window.rpAskProbRate = rpAskProbRate;
window.rpAskDailyMax = rpAskDailyMax;
function trySystemAskMochi() {
// #1015 夜间静默：TA 主动申请心意币夜间不生成（同 trySystemAutoSend，须在入账前拦）。
if (window.nightModeActive && window.nightModeActive()) return;
if (rateLimitFull()) return; // #1341：同口径补到总量限流——askDailyIncr 与入账都发生在投递前，额度满时这一发不生成
const askMax = rpAskDailyMax();
if (askMax > 0 && askDailyCount() >= askMax) return;
if (Math.random() >= rpAskProbRate()) return;
const amtFen = genRpAmount(5200000);
if (amtFen < 1) return;
	askDailyIncr();
	const wallet = rpWalletGet();
	wallet.systemBalance += amtFen;
	rpWalletSet(wallet);
	// v3.16.x：TA 自动申请同步记入主页申请流水
	try { if (window.giftCoinLedgerAdd) window.giftCoinLedgerAdd('ask', 0, amtFen, 'TA自动申请'); } catch (e) {}
	const myCid = window.__activeCid || 'default';
setTimeout(() => {
if ((window.__activeCid || 'default') !== myCid) return;
addRec({ side: 'in', special: 'askcoin', rateAllow: true, askFen: amtFen, askTs: Date.now() });
saveMsgsNow();
}, randInt(800, 2400));
}
// 回前台补触发（与 ta-ask 同款通道），避免后台期间错过的申请永远丢失
// FIX 2026-09-15 #494：原守卫 if (!sameCid()) 引用的 sameCid 仅是 scheduleReply/replyOnce 函数内
// 局部 const，顶层作用域无定义＝每次回前台 ReferenceError 被行内 catch 静默吞，trySystemAskMochi
// 的回前台补触发通道自上线即失效（无头 pauseOnExceptions 实锤 index.html:33351）。顶层回前台
// 监听没有「注册时桌面」语义，守卫去除；归属由 trySystemAskMochi 内部走当前命名空间自理
//（同 ta-ask.js:373 / memo-app.js:553 回前台监听口径）。
document.addEventListener('mochi-fg-resume', function () {
try { setTimeout(function () { trySystemAskMochi(); }, randInt(2000, 6000)); } catch (e) {}
});
function rpThanksMsg() {
return pick(['谢谢亲爱的～', '收到啦❤', '嘿嘿谢谢宝宝', '爱你哟', '🥰 谢谢', '开心！谢谢～', '么么哒']);
}
// v3.29.x #807：我领了 TA 的红包后 TA 的搭话池（方向与上行「谢谢」相反——这是 TA 看到红包
// 被我领走后的反应，别和 rpThanksMsg 混用）
function rpThxInMsg() {
return pick(['被你领走啦～', '就知道你会手快', '嘿嘿，被你抢到了', '我的红包还合口味吗', '领了我的红包，说点好听的～', '手速可以呀😉']);
}
// v3.29.x #807：红包领后捎一句话——dir='out'=TA 领了我的红包（谢谢/回一句），dir='in'=我领了
// TA 的红包（TA 主动搭话）。开关/概率读回复设置「红包互动」（reply-rp-thx-en 默认开、
// reply-rp-thx-prob 默认 60%，未写盘走 reply-settings DEFAULTS）。固定只发一条、不经回复管线，
// 不读「回复条数」（reply-min/reply-max）也不参与逐卡连发＝不受多条回复上限限制；
// 总开关关＝两个方向都静默。命中概率后说什么由 rp-thx-mode 决定：0=只用系统预设话术、
// 1=和正常聊天一样回复（单卡生成）、2=混合（默认，六成走预设池、四成走单卡生成）
function rpCollectFeedback(dir) {
let mode = 2;
try {
const c = cfg();
if (Number(c['rp-thx-en']) !== 1) return;
let prob = Number(c['rp-thx-prob']);
if (!isFinite(prob)) prob = 60;
if (Math.random() * 100 >= Math.max(0, Math.min(100, prob))) return;
mode = Number(c['rp-thx-mode']);
if (mode !== 0 && mode !== 1) mode = 2;
} catch (e) {}
const myCid = window.__activeCid || 'default';
if (mode === 0 || (mode === 2 && Math.random() < 0.6)) {
setTimeout(() => { if ((window.__activeCid || 'default') !== myCid) return; addIn(dir === 'in' ? rpThxInMsg() : rpThanksMsg(), { silent: true, nightAllow: true, rateAllow: true }); }, randInt(600, 1800));
} else {
setTimeout(() => {
if ((window.__activeCid || 'default') !== myCid) return;
try {
const c = cfg();
const rep = genOneReply(c);
addInTyped(rep.text, { type: rep.type, parts: rep.parts, tag: pyMultiDrawn ? '多字卡回复' : undefined, tagNoDup: true });
} catch (e) {}
}, randInt(800, 2000));
}
}
function handleSendResponse(msg) {
const idx = msgs.indexOf(msg);
if (idx < 0) return;
const rec = msgs[idx];
if (!rec || rec.rpStatus !== 'pending') return;
const myCid = window.__activeCid || 'default';
const r = Math.random();
const wallet = rpWalletGet();
const amtFen = Math.round((rec.rpAmount || 0) * 100);
if (r < 0.2) {
rec.rpStatus = 'returned';
wallet.myBalance += amtFen;
rpWalletSet(wallet);
saveMsgsNow();
if (!rpPatchStatusInPlace(idx)) renderWindow(false, true); // FIX 2026-09-07 #230 红包状态流转不整窗重建（闪屏）
setTimeout(() => { if ((window.__activeCid || 'default') !== myCid) return; addIn('TA 退回了你的红包（心意币 ¥' + Number(rec.rpAmount || 0).toFixed(2) + '）', { special: 'poke', nightAllow: true, rateAllow: true }); }, randInt(500, 1200));
} else if (r < 0.9) {
rec.rpStatus = 'received';
rec.rpOpenedAt = Date.now();
wallet.systemBalance += amtFen;
rpWalletSet(wallet);
saveMsgsNow();
if (!rpPatchStatusInPlace(idx)) renderWindow(false, true); // FIX 2026-09-07 #230 红包状态流转不整窗重建（闪屏）
const amtTxt = '（心意币 ¥' + Number(rec.rpAmount || 0).toFixed(2) + '）';
setTimeout(() => { if ((window.__activeCid || 'default') !== myCid) return; addIn('TA 领取了你的红包' + amtTxt, { special: 'poke', nightAllow: true, rateAllow: true }); }, randInt(400, 1000));
rpCollectFeedback('out');
}
}
function tryCollectPending() {
if (Math.random() >= 0.08) return;
const idx = msgs.findIndex(m => m && m.special === 'redpacket' && m.side === 'out' && m.rpStatus === 'pending');
if (idx < 0) return;
const rec = msgs[idx];
rec.rpStatus = 'received';
rec.rpOpenedAt = Date.now();
const wallet = rpWalletGet();
wallet.systemBalance += Math.round((rec.rpAmount || 0) * 100);
rpWalletSet(wallet);
saveMsgsNow();
if (!rpPatchStatusInPlace(idx)) renderWindow(false, true); // FIX 2026-09-07 #230 红包状态流转不整窗重建（闪屏）
const amtTxt = '（心意币 ¥' + Number(rec.rpAmount || 0).toFixed(2) + '）';
const myCid = window.__activeCid || 'default';
setTimeout(() => { if ((window.__activeCid || 'default') !== myCid) return; addIn('TA 领取了你的红包' + amtTxt, { special: 'poke', nightAllow: true, rateAllow: true }); }, randInt(400, 1000));
rpCollectFeedback('out');
}
function rpExpireCheck() {
const now = Date.now();
const wallet = rpWalletGet();
let changed = false;
for (let i = 0; i < msgs.length; i++) {
const rec = msgs[i];
if (rec && rec.special === 'redpacket' && rec.rpStatus === 'pending' && rec.rpTs) {
if (now - rec.rpTs > RP_EXPIRY_MS) {
rec.rpStatus = 'expired';
rec.expiredAt = now;
const amtFen = Math.round((rec.rpAmount || 0) * 100);
if (rec.side === 'out') wallet.myBalance += amtFen;
else wallet.systemBalance += amtFen;
changed = true;
}
}
}
if (changed) { rpWalletSet(wallet); saveMsgsNow(); }
}
function rpRenderBalance() {
const el = document.getElementById('rp-balance');
if (!el) return;
const w = rpWalletGet();
el.textContent = '心意币 ¥' + (w.myBalance / 100).toFixed(2) + ' · ' + chatPartnerName() + ' ¥' + (w.systemBalance / 100).toFixed(2) + ' · 向 Mochi 申请心意币';
}
// v3.15.x：余额行改为「向 Mochi 申请心意币」——不再直接改账本数值；
// 选收款方（我/TA）输入申请金额，确定即模拟 Mochi 打款并入账（累加），留空点【完成】结束
function rpEditWallet() {
if (!window.openModal) return;
const taName = window.taFit ? window.taFit('TA') : 'TA';
const LBL = { my: '我的心意币', ta: taName + '的心意币' };
let side = 'my';
let doneAny = false;
const fmtYuan = (n) => (Math.round(n * 100) / 100).toFixed(2);
const hintTxt = () => {
const w = rpWalletGet();
return '当前：心意币 ¥' + (w.myBalance / 100).toFixed(2) + ' · ' + taName + ' ¥' + (w.systemBalance / 100).toFixed(2) +
(doneAny ? '\n已到账，可继续为' + LBL[side] + '申请；留空点【完成】结束' : '\n选择收款方，输入申请金额点【申请】，Mochi 打款后自动入账；留空点【完成】结束');
};
let ctl = null;
ctl = window.openModal('向 Mochi 申请心意币', '', (arg) => {
const picked = (arg === 'my' || arg === 'ta');
const el = document.getElementById('modal-input');
const raw = String(picked ? ((el && el.value) || '') : (arg == null ? '' : arg)).trim();
const target = picked ? arg : side;
if (raw === '') return; // 留空确定 = 结束本次申请（stay 未置位，正常关闭）
const n = parseFloat(raw);
if (isNaN(n) || n <= 0) { toast('申请金额需大于 0'); return; }
const fen = Math.round(n * 100);
const w = rpWalletGet();
	if (target === 'my') w.myBalance += fen;
	else w.systemBalance += fen;
	rpWalletSet(w); rpRenderBalance();
	// v3.16.x：聊天侧申请同步记入主页申请流水
	try { if (window.giftCoinLedgerAdd) window.giftCoinLedgerAdd('ask', target === 'my' ? fen : 0, target === 'ta' ? fen : 0, '聊天申请'); } catch (e) {}
	toast('Mochi 已打款，' + LBL[target] + ' +¥' + fmtYuan(fen / 100));
doneAny = true;
side = target === 'my' ? 'ta' : 'my';
if (ctl) {
ctl.stay();
const pbs = document.querySelectorAll('#modal-pills .pill');
const flip = pbs[side === 'my' ? 0 : 1];
if (flip) flip.click(); // 同步胶囊高亮与内部选中态（下一轮确认仍走 pills 分支）
ctl.text('');
ctl.hint(hintTxt());
ctl.okText('完成');
}
}, {
staticText: hintTxt(),
pills: [{ value: 'my', label: '我的心意币' }, { value: 'ta', label: taName + ' 的心意币' }],
pill: 'my',
placeholder: '输入申请金额（元），留空结束',
inputmode: 'decimal'
});
if (ctl) ctl.okText('申请');
}
const rpBalanceEl = document.getElementById('rp-balance');
if (rpBalanceEl) rpBalanceEl.addEventListener('click', (e) => { e.stopPropagation(); rpEditWallet(); });
function rpCoverKey(side) { return 'rp-cover-' + (side || 'out'); }
function rpCoverGet(side) { return store.get(rpCoverKey(side)) || ''; }
function rpCoverSet(side, dataUrl) {
	const k = rpCoverKey(side);
	if (dataUrl) {
		store.set(k, dataUrl);
		try { if (window.idbSet) window.idbSet(window.activePrefix() + ':' + k, dataUrl); } catch (e) {}
	} else {
		try { store.remove(k); } catch (e) {}
		try { if (window.idbSet) window.idbSet(window.activePrefix() + ':' + k, ''); } catch (e) {}
	}
}
function rpCompressCover(src) {
	// FIX 2026-09-25 #1270：原实现 new Image() 直接整幅解码 reader 的多 MB base64（48MP 照片＝192MB
	// 位图）且没有任何像素闸，就是「导入照片白屏大退」的那条路；改走统一解码闸，File 直接进闸。
	if (!window.mochiImgCompressTo) return Promise.resolve(null);
	return window.mochiImgCompressTo(src, { maxSide: 400, quality: 0.8, tag: 'rp-cover' });
}
const rpCoverPreview = document.getElementById('rp-cover-preview');
const rpCoverUploadBtn = document.getElementById('rp-cover-upload');
const rpCoverDelBtn = document.getElementById('rp-cover-del');
// FIX 2026-09-18 #755：rpCoverFileInput（detached 单例）已随该入口改走 window.mochiFilePick 移除
function rpRenderCover() {
	const side = rpSide;
	const cover = rpCoverGet(side);
	const who = side === 'out' ? '我的' : (chatPartnerName() + '的');
	if (rpCoverUploadBtn) rpCoverUploadBtn.textContent = '上传' + who + '封面';
	if (rpCoverDelBtn) rpCoverDelBtn.textContent = '删除' + who + '封面';
	if (cover) {
		if (rpCoverPreview) {
			rpCoverPreview.style.backgroundImage = 'url("' + cover + '")';
			const sp = rpCoverPreview.querySelector('span'); if (sp) sp.style.display = 'none';
		}
		if (rpCoverDelBtn) rpCoverDelBtn.hidden = false;
	} else {
		if (rpCoverPreview) {
			rpCoverPreview.style.backgroundImage = '';
			const sp = rpCoverPreview.querySelector('span'); if (sp) { sp.style.display = ''; sp.textContent = '未设置' + who + '封面'; }
		}
		if (rpCoverDelBtn) rpCoverDelBtn.hidden = true;
	}
}
if (rpCoverUploadBtn) {
rpCoverUploadBtn.addEventListener('click', (e) => {
e.stopPropagation();
// FIX 2026-09-18 #755：原实现 detached（从未挂文档，且没有 appendChild）——iOS 对未挂载
// file input 不派发 change，部分安卓内核合成 click 静默失效。统一走 window.mochiFilePick。
window.mochiFilePick({
id: 'mochi-rp-cover-pick', accept: 'image/*', btn: rpCoverUploadBtn,
onFiles: (files) => {
const f = files && files[0];
if (!f) { toast('没有取到图片，请再选一次'); return; }
if (!window.mochiImgCompressTo) { toast('图片处理组件没加载上（缓存过旧或离线），请重新打开页面再试'); return; }
// FIX 2026-09-25 #1270：不再先 readAsDataURL 造多 MB base64 字符串（UTF-16 下再翻一倍内存）；File 直接进闸
rpCompressCover(f).then(data => {
if (!data) { toast('这张图本机浏览器处理不了，请换一张小图或用系统相机默认尺寸重拍'); return; }
rpCoverSet(rpSide, data);
rpRenderCover();
toast('封面已设置');
});
}
});
});
}
if (rpCoverDelBtn) {
rpCoverDelBtn.addEventListener('click', (e) => {
e.stopPropagation();
rpCoverSet(rpSide, '');
rpRenderCover();
toast('已恢复默认封面');
});
}
function sendRedpacket() {
let amt = rpPickedAmt;
if (rpCustomInput && rpCustomInput.value) {
const cv = parseFloat(rpCustomInput.value);
if (!isNaN(cv) && cv >= 0) amt = Math.round(cv * 100) / 100;
}
if (amt == null || isNaN(amt) || amt < 0) { toast('先选择或输入红包金额'); return; }
const wish = (rpWishInput && rpWishInput.value || '').trim() || (isQixiToday() ? '七夕快乐' : '心意');
const amtFen = Math.round(amt * 100);
// v3.15.x：余额不足也照发——心意币直接透支为负数，不再拦截
const wallet = rpWalletGet();
if (rpSide === 'out') {
wallet.myBalance -= amtFen;
} else {
wallet.systemBalance -= amtFen;
}
rpWalletSet(wallet);
const cover = rpCoverGet(rpSide);
const rec = { side: rpSide, special: 'redpacket', rpAmount: amt, rpWish: wish, rpStatus: 'pending', rpTs: Date.now(), rpCover: cover ? 1 : 0 };
addRec(rec);
if (window.logFish) window.logFish();
if (rpSide === 'out') {
setTimeout(() => handleSendResponse(rec), randInt(3000, 8000));
}
closeRpPanel();
}
if (rpSendBtn) rpSendBtn.addEventListener('click', (e) => { e.stopPropagation(); sendRedpacket(); });
if (rpCloseBtn) rpCloseBtn.addEventListener('click', (e) => { e.stopPropagation(); closeRpPanel(); });
const moreRp = document.getElementById('more-rp');
if (moreRp) {
moreRp.addEventListener('click', (e) => { e.stopPropagation(); openRpPanel(); });
}
const chatDivinePanel = document.getElementById('chat-divine-panel');
const chatDivineBody = document.getElementById('chat-divine-body');
const chatDivineClose = document.getElementById('chat-divine-close');
let chatDivineMode = 'tarot';
let chatDivineCount = 3;
function openChatDivine() {
if (!chatDivinePanel) return;
const pc = document.getElementById('poke-card');
if (pc) pc.hidden = true;
const ep = document.getElementById('emoji-panel');
if (ep) ep.hidden = true;
const askP = document.getElementById('chat-ask-panel');
if (askP) closeChatAskPanel();
const cs = document.getElementById('chat-search');
if (cs) cs.hidden = true;
if (window.closeAvlib) window.closeAvlib();
chatDivinePanel.hidden = false;
try {
const chatAuto = document.getElementById('div-chat-auto-send');
if (chatAuto) chatAuto.checked = !!(window.divineAutoGet && window.divineAutoGet());
} catch (err) {}
try {
const histList = document.getElementById('div-chat-history');
if (histList && !histList.hidden && window.divineHistLoad) renderChatHistory();
} catch (err) {}
try { if (window.divineRenderTargets) window.divineRenderTargets('div-chat-targets'); } catch (err) {}
}
const moreDivine = document.getElementById('more-divine');
if (moreDivine) {
moreDivine.addEventListener('click', (e) => {
e.stopPropagation();
if (morePanel) morePanel.hidden = true;
openChatDivine();
});
}
if (chatDivineClose) chatDivineClose.addEventListener('click', (e) => { e.stopPropagation(); chatDivinePanel.hidden = true; });
if (chatDivineBody) {
chatDivineBody.querySelectorAll('[data-chatmode]').forEach(b => {
b.addEventListener('click', (e) => {
e.stopPropagation();
chatDivineMode = b.getAttribute('data-chatmode');
chatDivineBody.querySelectorAll('[data-chatmode]').forEach(x => x.classList.toggle('sel', x === b));
if (chatDrawCancel) { try { chatDrawCancel(); } catch (err) {} chatDrawCancel = null; }
const drawBtn2 = document.getElementById('div-chat-draw');
if (drawBtn2) drawBtn2.textContent = '抽牌';
const r = document.getElementById('div-chat-result');
if (r) r.innerHTML = '<div class="div-result-empty">点击上方按钮开始抽牌</div>';
});
});
chatDivineBody.querySelectorAll('[data-chatcount]').forEach(b => {
b.addEventListener('click', (e) => {
e.stopPropagation();
chatDivineCount = Number(b.getAttribute('data-chatcount'));
chatDivineBody.querySelectorAll('[data-chatcount]').forEach(x => x.classList.toggle('sel', x === b));
if (chatDrawCancel) { try { chatDrawCancel(); } catch (err) {} chatDrawCancel = null; }
const drawBtn2 = document.getElementById('div-chat-draw');
if (drawBtn2) drawBtn2.textContent = '抽牌';
const r = document.getElementById('div-chat-result');
if (r) r.innerHTML = '<div class="div-result-empty">点击上方按钮开始抽牌</div>';
});
});
function renderChatHistory() {
const listEl = document.getElementById('div-chat-history');
if (!listEl) return;
let list = [];
try { list = (window.divineHistLoad && window.divineHistLoad()) || []; } catch (err) {}
if (!Array.isArray(list)) list = [];
if (!list.length) {
listEl.innerHTML = '<div class="div-result-empty" style="padding:14px 0">暂无占卜记录</div>';
return;
}
const fmt = (ts) => {
const d = new Date(ts);
const p = (n) => (n < 10 ? '0' + n : '' + n);
return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
};
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
listEl.innerHTML = list.map((h, i) =>
'<div class="div-chat-hist-item">' +
'<div class="div-chat-hist-q">' + (h.mode === 'tarot' ? '塔罗' : '雷诺曼') + ' · ' + h.count + ' 张' +
(h.question ? ' · 问：' + esc(h.question) : '') + '</div>' +
'<div class="div-chat-hist-meta">' + fmt(h.ts) + ' · ' +
(Array.isArray(h.cards) ? h.cards.map(c => esc((c && c.name) || '') + (c && c.rev ? '(逆)' : '')).join('、') : '') +
'</div>' +
'<div class="div-chat-hist-acts">' +
'<button class="div-chat-hist-view" data-hi="' + i + '">查看</button>' +
'<button class="div-chat-hist-del" data-hi="' + i + '">删除</button>' +
'</div></div>').join('');
listEl.querySelectorAll('.div-chat-hist-view').forEach(b2 => b2.addEventListener('click', (e) => {
e.stopPropagation();
let cur = [];
try { cur = (window.divineHistLoad && window.divineHistLoad()) || []; } catch (err) {}
const h = cur[parseInt(b2.dataset.hi, 10)];
if (h && Array.isArray(h.cards)) {
const sr = document.getElementById('div-chat-result');
if (sr) { sr.innerHTML = chatDivineResultHtml(h.cards, h.mode, h.question, h.summary || ''); bindChatCopy(sr, h.cards, h.mode, h.question, h.summary || ''); }
}
}));
listEl.querySelectorAll('.div-chat-hist-del').forEach(b2 => b2.addEventListener('click', (e) => {
e.stopPropagation();
let cur = [];
try { cur = (window.divineHistLoad && window.divineHistLoad()) || []; } catch (err) {}
cur.splice(parseInt(b2.dataset.hi, 10), 1);
if (window.divineHistSave) { try { window.divineHistSave(cur); } catch (err) {} }
renderChatHistory();
}));
}
function chatDivineResultHtml(cards, mode, question, summary) {
const icons = mode === 'tarot' ? (window.__TAROT_ICONS__ || {}) : (window.__LENO_ICONS__ || {});
const labels = ((window.__MODE_LABELS__ || {})[mode] || {})[cards.length] || [];
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
let html = '<div class="div-spread">';
cards.forEach((c, i) => {
html += '<div class="div-mini">' +
(labels[i] ? '<div class="div-mini-tag">' + labels[i] + '</div>' : '') +
'<div class="div-card-face">' +
'<div class="div-card-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + (icons[c.icon] || '') + '</svg></div>' +
'<div class="div-card-name">' + esc(c.name) + (c.rev ? '（逆）' : '') + '</div>' +
'</div>' +
'<div class="div-card-meaning">' + esc(c.meaning) + '</div>' +
'</div>';
});
html += '</div>';
if (summary) html += '<div class="div-summary">' + esc(summary) + '</div>';
if (question) html += '<div class="div-card-meaning" style="opacity:.6;text-align:center;margin-top:8px">问：' + esc(question) + '</div>';
html += '<div class="div-result-actions"><button class="div-copy-btn" id="div-chat-copy-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;vertical-align:-3px;margin-right:6px"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>点击复制文字</button></div>';
return html;
}
function bindChatCopy(el, cards, mode, question, summary) {
const b = el && el.querySelector && el.querySelector('#div-chat-copy-btn');
if (!b) return;
b.addEventListener('click', (e) => {
e.stopPropagation();
if (window.divineCopyResultText && window.divineBuildResultText) {
window.divineCopyResultText(window.divineBuildResultText(mode, cards, summary, question));
}
});
}
const chatAuto = document.getElementById('div-chat-auto-send');
if (chatAuto) {
chatAuto.addEventListener('change', () => {
if (window.divineAutoSet) window.divineAutoSet(chatAuto.checked);
});
}
chatDivineBody.querySelectorAll('.dec-inp-clear').forEach(btn => {
btn.addEventListener('click', (e) => {
e.stopPropagation();
const ta = document.getElementById(btn.dataset.clear);
if (!ta) return;
const box = ta.__ceBox;
if (box) box.textContent = '';
else ta.value = '';
ta.focus();
toast('已清空');
});
});
const histToggle = document.getElementById('div-chat-hist-toggle');
if (histToggle) {
histToggle.addEventListener('click', (e) => {
e.stopPropagation();
const listEl = document.getElementById('div-chat-history');
if (!listEl) return;
const show = listEl.hidden;
listEl.hidden = !show;
histToggle.textContent = show ? '📜 占卜记录 ▴' : '📜 占卜记录 ▾';
if (show) renderChatHistory();
});
}
const histClear = document.getElementById('div-chat-hist-clear');
if (histClear) {
histClear.addEventListener('click', (e) => {
e.stopPropagation();
if (window.openModal) {
window.openModal('清空本桌面的全部占卜记录？（不可恢复）', '', () => {
if (window.divineHistSave) { try { window.divineHistSave([]); } catch (err) {} }
renderChatHistory();
toast('占卜记录已清空');
});
}
});
}
const divDraw = document.getElementById('div-chat-draw');
let chatDrawCancel = null;
if (divDraw) {
const divDrawIdleHTML = divDraw.innerHTML;
divDraw.addEventListener('click', (e) => {
e.stopPropagation();
const r = document.getElementById('div-chat-result');
if (!r) return;
if (divDraw.textContent.indexOf('重新抽牌') !== -1) {
if (chatDrawCancel) { try { chatDrawCancel(); } catch (err) {} chatDrawCancel = null; }
r.innerHTML = '<div class="div-result-empty">点击上方按钮开始抽牌</div>';
divDraw.innerHTML = divDrawIdleHTML;
return;
}
if (chatDrawCancel) { try { chatDrawCancel(); } catch (err) {} chatDrawCancel = null; }
const question = (document.getElementById('div-chat-question') || {}).value || '';
const snapMode = chatDivineMode, snapCount = chatDivineCount;
// v3.26.x：快照点击时的占卜对象——流程期间切换对象不影响本次记录归属
const snapTarget = (window.divineGetTarget && window.divineGetTarget()) || '';
const deck = snapMode === 'tarot' ? (window.__TAROT__ || []) : (window.__LENO__ || []);
if (!window.startDivineDraw || !deck.length) { r.innerHTML = '<div class="div-result-empty">占卜牌库加载中…</div>'; return; }
divDraw.textContent = '抽牌中…';
chatDrawCancel = window.startDivineDraw(r, {
deck: deck,
count: snapCount,
labels: ((window.__MODE_LABELS__ || {})[snapMode] || {})[snapCount] || [],
tarot: snapMode === 'tarot',
onDone: (cards) => {
chatDrawCancel = null;
divDraw.textContent = '重新抽牌';
const summary = (window.divineBuildSummary && window.divineBuildSummary(cards, snapMode, question)) || '';
r.innerHTML = chatDivineResultHtml(cards, snapMode, question, summary);
bindChatCopy(r, cards, snapMode, question, summary);
if (window.divineAutoGet && window.divineAutoGet() && window.divineSendResult) {
setTimeout(() => { try { window.divineSendResult(snapMode, cards, summary, question); } catch (err) {} }, 600);
}
if (window.divineHistSave && window.divineHistLoad) {
try {
const record = { ts: Date.now(), mode: snapMode, count: snapCount, question: question, cards: cards, summary: summary };
if (snapTarget && window.divineTargetName) record.target = window.divineTargetName(snapTarget);
const list = window.divineHistLoad();
if (!Array.isArray(list)) { if (window.divineHistSave) window.divineHistSave([]); }
else {
list.unshift(record);
window.divineHistSave(list);
}
// v3.26.x：选了对象（或不选）→ 同步写入该对象/当前桌面的主页「占卜记录」
if (window.divineSaveToHomeHistory) { try { window.divineSaveToHomeHistory(record, snapTarget); } catch (err2) {} }
} catch (err) {}
try { renderChatHistory(); } catch (err) {
try { if (window.__jsErrors) window.__jsErrors.push('divineHist: ' + (err && err.message)); } catch (e2) {}
}
}
}
});
});
}
}
function bindTaNow(id, fn) {
const btn = document.getElementById(id);
if (btn) {
btn.addEventListener('click', (e) => {
e.stopPropagation();
if (morePanel) morePanel.hidden = true;
if (fn) fn();
});
}
}
bindTaNow('more-ask-now', () => { if (window.triggerTaAskNow) window.triggerTaAskNow(); });
bindTaNow('more-choose-now', () => { if (window.triggerTaChooseNow) window.triggerTaChooseNow(); });
bindTaNow('more-curious-now', () => { if (window.triggerTaCuriousNow) window.triggerTaCuriousNow(); });
bindTaNow('more-roast-now', () => { if (window.triggerTaRoastNow) window.triggerTaRoastNow(); });
bindTaNow('more-invite-now', () => { if (window.triggerTaInviteNow) window.triggerTaInviteNow(); });
// v8.29 #1003：三枚新增手动触发口（用户直派「回复设置里的贴贴邀请 / 邀请TA主动查岗 /
// 邀请跨桌面查岗也是点击之后让联系人立即触发的功能」）——各自接自己那条既有入口，
// 不新开触发链路：贴贴＝按类型抽贴贴话术后走 sendTaInvite；
// 查岗＝字卡库「让TA现在查岗一次」同一个 triggerCkQuestion（题库/冷却/闸门口径全一致）；
// 跨桌面查岗＝incoming-requests 的 triggerIncomingCheckinNow（挑一个开着查岗的其他桌面）。
// FIX-REGRESSION #1003：贴贴这枚务必留在 taInvitePickKind('cuddle') 上，接回
// taInvitePickAny 就变回「随机挑一种邀请」，用户点贴贴却收到猜拳＝本条的复发形态。
bindTaNow('more-cuddle-now', () => { if (window.triggerTaCuddleNow) window.triggerTaCuddleNow(); });
bindTaNow('more-ck-now', () => { if (window.triggerCkQuestion) window.triggerCkQuestion(); });
bindTaNow('more-xck-now', () => { if (window.triggerIncomingCheckinNow) window.triggerIncomingCheckinNow(); });
const moreDecide = document.getElementById('more-decide');
if (moreDecide) {
moreDecide.addEventListener('click', (e) => {
e.stopPropagation();
if (morePanel) morePanel.hidden = true;
if (window.openDecision) {
const pc = document.getElementById('poke-card');
if (pc) pc.hidden = true;
const ep = document.getElementById('emoji-panel');
if (ep) ep.hidden = true;
const askP = document.getElementById('chat-ask-panel');
if (askP) closeChatAskPanel();
const cs = document.getElementById('chat-search');
if (cs) cs.hidden = true;
const dv = document.getElementById('chat-divine-panel');
if (dv) dv.hidden = true;
if (window.closeAvlib) window.closeAvlib();
window.openDecision();
} else toast('帮我决定加载失败');
});
}
const chatDecisionClose = document.getElementById('chat-decision-close');
if (chatDecisionClose) {
chatDecisionClose.addEventListener('click', (e) => {
e.stopPropagation();
const dp = document.getElementById('chat-decision-panel');
if (dp) dp.hidden = true;
});
}
function maybeFollowupAskCard() {
if (Math.random() >= 0.35) return;
const roll = Math.random();
try {
if (roll < 0.25 && window.triggerTaAskNow) { window.triggerTaAskNow(); return; }
if (roll < 0.5 && window.triggerTaChooseNow) { window.triggerTaChooseNow(); return; }
if (roll < 0.75 && window.triggerTaCuriousNow) { window.triggerTaCuriousNow(); return; }
if (window.triggerTaRoastNow) window.triggerTaRoastNow();
} catch (e) {}
}
const chatAskPanel = document.getElementById('chat-ask-panel');
const chatAskTitle = document.getElementById('chat-ask-title');
const chatAskInput = document.getElementById('chat-ask-input');
const chatAskOk = document.getElementById('chat-ask-ok');
const chatAskCancel = document.getElementById('chat-ask-cancel');
const chatAskClose = document.getElementById('chat-ask-close');
let chatAskMode = 'invite'; // invite / ask
let chatAskType = 'text'; // ask 模式回复类型：text 文字回复 / single 单选题 / multi 多选题（#1415）
// #1415：切题型时选项框那句话跟着改口——同一格里写「TA 会选一个」去出多选题是指错地方。
const ASK_OPTS_PH = {
single: '单选题选项：每行一个；可写 选项~TA回应，TA会选一个并用该回应回复',
multi: '多选题选项：每行一个；可写 选项~TA回应，TA会按「最多选几个」选若干个并用该回应回复'
};
function ensureChatAskTypeRow() {
if (!chatAskPanel || chatAskPanel.querySelector('.chat-ask-type')) return;
const askBody = chatAskPanel.querySelector('.chat-ask-body');
if (!askBody) return;
const typeRow = document.createElement('div');
typeRow.className = 'chat-ask-type';
typeRow.hidden = true;
typeRow.innerHTML =
'<button class="chat-ask-type-btn sel" data-atype="text">文字回复</button>' +
'<button class="chat-ask-type-btn" data-atype="single">单选题</button>' +
'<button class="chat-ask-type-btn" data-atype="multi">多选题</button>';
const optsWrap = document.createElement('div');
optsWrap.className = 'dec-inp-wrap chat-ask-opts-wrap';
optsWrap.hidden = true;
const opts = document.createElement('textarea');
opts.id = 'chat-ask-opts';
opts.className = 'chat-ask-opts';
opts.rows = 3;
opts.placeholder = ASK_OPTS_PH.single;
opts.hidden = true;
const optsClear = document.createElement('button');
optsClear.type = 'button';
optsClear.className = 'dec-inp-clear';
optsClear.dataset.clear = 'chat-ask-opts';
optsClear.setAttribute('aria-label', '清空');
optsClear.setAttribute('title', '清空');
optsClear.textContent = '✕';
optsWrap.appendChild(opts);
optsWrap.appendChild(optsClear);
optsClear.addEventListener('click', (e) => {
if (e) e.stopPropagation();
const box = opts.__ceBox;
if (box) box.textContent = '';
else opts.value = '';
opts.focus();
toast('已清空');
});
const actions = askBody.querySelector('.chat-ask-actions');
if (actions) { askBody.insertBefore(typeRow, actions); askBody.insertBefore(optsWrap, actions); }
else { askBody.appendChild(typeRow); askBody.appendChild(optsWrap); }
const syncOptsHidden = () => {
const show = chatAskType === 'single' || chatAskType === 'multi';
opts.placeholder = ASK_OPTS_PH[chatAskType] || ASK_OPTS_PH.single;
syncAskMultiRow();
optsWrap.hidden = !show;
opts.hidden = !show;
if (opts.__ceBox) opts.__ceBox.style.display = show ? 'block' : 'none';
else if (optsWrap.querySelector('.ce-box')) optsWrap.querySelector('.ce-box').style.display = show ? 'block' : 'none';
const obox = opts.__ceBox || optsWrap.querySelector('.ce-box') || opts;
try { obox.style.transform = show ? 'translateZ(0)' : ''; } catch (e) {}
};
typeRow.querySelectorAll('.chat-ask-type-btn').forEach(btn => {
btn.addEventListener('click', () => {
chatAskType = btn.dataset.atype === 'single' || btn.dataset.atype === 'multi' ? btn.dataset.atype : 'text';
typeRow.querySelectorAll('.chat-ask-type-btn').forEach(b => b.classList.toggle('sel', b === btn));
syncOptsHidden();
askBoxes().forEach(({ box }) => {
if (!askBoxNeedsLayerFix(box)) return; // #538：原生输入框不进整页 reflow
try {
box.style.transform = '';
void box.offsetHeight;
box.style.transform = 'translateZ(0)';
} catch (e) {}
});
});
});
}
function resetChatAskType() {
chatAskType = 'text';
const typeRow = chatAskPanel ? chatAskPanel.querySelector('.chat-ask-type') : null;
if (typeRow) {
typeRow.hidden = chatAskMode !== 'ask';
typeRow.querySelectorAll('.chat-ask-type-btn').forEach(b => b.classList.toggle('sel', b.dataset.atype === 'text'));
}
const opts = document.getElementById('chat-ask-opts');
if (opts) {
opts.hidden = true;
const wrap = opts.parentElement && opts.parentElement.classList && opts.parentElement.classList.contains('chat-ask-opts-wrap') ? opts.parentElement : null;
if (wrap) wrap.hidden = true;
if (opts.__ceBox) opts.__ceBox.style.display = 'none';
else if (opts.previousElementSibling && opts.previousElementSibling.classList && opts.previousElementSibling.classList.contains('ce-box')) opts.previousElementSibling.style.display = 'none';
}
syncAskMultiRow();
}
// ==== #1415 多选题（作者直派「问问TA 没有联系人答题可多选」「批量问卷也不能多选」）单一口径 ====
// 两枚助手都在 chat.js 顶层定义并挂 window：ta-ask.js（批量问卷、TA 的题库）与本页（问问TA 半框、
// 点卡作答）读写同一把尺，避免出现「半框里最多选 3 个、问卷里另算一套」。
// 「最多选几个」与 #809 思考时间同为 per-cid 裸键（store 即当前桌面命名空间）。
function askMultiMaxLoad() {
try { const n = parseInt(store.get('ask-multi-max'), 10); return (n >= 2 && n <= 6) ? n : 3; } catch (e) { return 3; }
}
function askMultiMaxSave(n) {
try { store.set('ask-multi-max', String(n >= 2 && n <= 6 ? n : 3)); } catch (e) {}
}
window.askMultiMaxLoad = askMultiMaxLoad;
window.askMultiMaxSave = askMultiMaxSave;
// 随机抽 count 个不重复下标：count 在「2 ~ min(上限, 选项数)」之间现掷，选项不足 2 时退回 1 个
// （多选题理论上≥2 选项，这里兜住脏数据免得吐出空答案）。返回按选项原序排好的下标，
// 于是答案串念出来永远是「火锅、烧烤」这种题目里的顺序，不会每次换个读法。
function mochiPickMulti(len, maxPick) {
const n = Number(len) || 0;
if (n <= 0) return [];
const hi = Math.min(Math.max(2, Number(maxPick) || 2), n);
const lo = Math.min(2, n);
const count = lo + Math.floor(Math.random() * (hi - lo + 1));
const idx = [];
for (let i = 0; i < n; i++) idx.push(i);
for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
return idx.slice(0, count).sort((a, b) => a - b);
}
window.mochiPickMulti = mochiPickMulti;
// 已答态回显判据：多选题的答案是「、」连接的整串，按段全等才算被选中；单选/老记录仍是整串相等。
// 选项自身含「、」时按段切会切坏它，那一格退化成不高亮（答案整行文字照旧正确）——不另存一份
// 选中下标，是为了让 surveyAnswers / askAnswer 的形状一字不动，老卡片与跨桌面补投递照旧能读。
function mochiAnswerHits(optText, answer) {
const o = String(optText == null ? '' : optText).trim();
const a = String(answer == null ? '' : answer).trim();
if (!o || !a) return false;
if (a === o) return true;
const segs = a.split('、').map(s => s.trim()).filter(Boolean);
if (segs.length <= 1) return false;
return segs.indexOf(o) >= 0;
}
window.mochiAnswerHits = mochiAnswerHits;
// v3.26.x #809：问问TA「思考时间（秒）」——同帮我决定/多人决定的 stepper（1~10 秒），
// per-cid 持久化（store 即当前桌面命名空间），默认 3 秒＝原随机 1.5~4 秒的常用档；
// 只在 ask（问问TA）模式显示，invite（邀请TA）模式隐藏（.gs-row[hidden] 已有 #727 兜底）。
function askThinkSecsLoad() {
try { const n = parseInt(store.get('ask-think-secs'), 10); return (n >= 1 && n <= 10) ? n : 3; } catch (e) { return 3; }
}
function ensureChatAskThinkRow() {
if (!chatAskPanel) return;
const askBody = chatAskPanel.querySelector('.chat-ask-body');
if (!askBody) return;
let row = chatAskPanel.querySelector('.chat-ask-think-row');
if (!row) {
row = document.createElement('div');
row.className = 'gs-row chat-ask-think-row';
row.innerHTML = '<span>思考时间（秒）</span><div class="stepper" id="chat-ask-think" data-min="1" data-max="10" data-step="1"><button type="button" class="stp-min">−</button><input class="stp-val" id="chat-ask-think-val" readonly><button type="button" class="stp-max">+</button></div>';
const actions = askBody.querySelector('.chat-ask-actions');
if (actions) askBody.insertBefore(row, actions); else askBody.appendChild(row);
const val = row.querySelector('.stp-val');
const clampSave = () => {
let n = parseInt(val.value, 10);
if (!(n >= 1 && n <= 10)) n = 3;
val.value = n;
store.set('ask-think-secs', String(n));
};
row.querySelector('.stp-min').addEventListener('click', (e) => { if (e) e.stopPropagation(); val.value = (parseInt(val.value, 10) || 3) - 1; clampSave(); });
row.querySelector('.stp-max').addEventListener('click', (e) => { if (e) e.stopPropagation(); val.value = (parseInt(val.value, 10) || 3) + 1; clampSave(); });
}
row.hidden = chatAskMode !== 'ask';
row.querySelector('.stp-val').value = askThinkSecsLoad();
}
// #1415：多选题的「最多选几个」——只在选了「多选题」那一档时出现（单选题只抽 1 个，用不到这根杆）。
// TA 自己那一路（批量问卷、TA 题库里的多选题）读的是同一个 per-cid 键，两处不会各量一把尺。
function syncAskMultiRow() {
const row = chatAskPanel ? chatAskPanel.querySelector('.chat-ask-multi-row') : null;
if (!row) return;
row.hidden = !(chatAskMode === 'ask' && chatAskType === 'multi');
const val = row.querySelector('.stp-val');
if (val) val.value = askMultiMaxLoad();
}
function ensureChatAskMultiRow() {
if (!chatAskPanel) return;
const askBody = chatAskPanel.querySelector('.chat-ask-body');
if (!askBody) return;
let row = chatAskPanel.querySelector('.chat-ask-multi-row');
if (!row) {
row = document.createElement('div');
row.className = 'gs-row chat-ask-multi-row';
row.innerHTML = '<span>最多选几个</span><div class="stepper" id="chat-ask-mmax" data-min="2" data-max="6" data-step="1"><button type="button" class="stp-min">−</button><input class="stp-val" readonly><button type="button" class="stp-max">+</button></div>';
const think = chatAskPanel.querySelector('.chat-ask-think-row');
if (think && think.parentElement) think.parentElement.insertBefore(row, think.nextSibling);
else {
const actions = askBody.querySelector('.chat-ask-actions');
if (actions) askBody.insertBefore(row, actions); else askBody.appendChild(row);
}
const val = row.querySelector('.stp-val');
// 越界钉回端点而不是打回默认值：拖过头那一下应当停在 6，跳回 3 等于把人刚做的选择抹掉
const clampSave = () => {
let n = parseInt(val.value, 10);
if (isNaN(n)) n = 3;
else n = n < 2 ? 2 : (n > 6 ? 6 : n);
val.value = n;
askMultiMaxSave(n);
};
row.querySelector('.stp-min').addEventListener('click', (e) => { if (e) e.stopPropagation(); val.value = (parseInt(val.value, 10) || 3) - 1; clampSave(); });
row.querySelector('.stp-max').addEventListener('click', (e) => { if (e) e.stopPropagation(); val.value = (parseInt(val.value, 10) || 3) + 1; clampSave(); });
}
syncAskMultiRow();
}
function askBoxes() {
const arr = [chatAskInput, document.getElementById('chat-ask-opts')];
return arr.filter(Boolean).map(el => ({ inp: el, box: el.__ceBox || el }));
}
// FIX 2026-09-15 #538 合成层补救是「安卓 ce-box 专用」，iOS 不得参与。
// 用户报障（iPhone 17 Safari，明说其他设备型号也有）：「向他提问板块的输入框一直上弹，
// 无法直接拉到顶部停留输入问题」+「信件板块输入框输入文字后一直上弹，每个字符输入都会闪字」。
// 根因：mobile-adapt 只在安卓把文本输入框转成 contenteditable .ce-box（iOS 保留原生输入框）；
// 半框被键盘平移时 ce-box 的**文字合成层**会停在旧位（文字与框分离），故这里给 box 贴
// transform:translateZ(0) 建层、并在 vv.resize/.phone 高度变化时反复 `transform='' →
// 强制 offsetHeight 整页 reflow → 再贴回`。这套手段对安卓 ce-box 是对的，但它没有任何
// 平台/能力判定，iOS 也照跑：被反复 toggle 的是**聚焦中的原生 input**，每次触发一次同步
// 整页重排、并把它提成独立合成层与布局脱同步 → 肉眼就是「输入框一直上弹、逐字闪」。
// 判定不靠机型：原生输入框（无 __ceBox）本来就没有「合成层文字与框分离」问题——只有
// ce-box 才需要这套补救，无 ce-box 时整段为 no-op，其所属设备行为完全不变。
function askBoxNeedsLayerFix(box) { try { return !!(box && box.__ceInp); } catch (e) { return false; } }
function applyAskComposeLayers() {
askBoxes().forEach(({ box }) => {
if (!askBoxNeedsLayerFix(box)) return;
try { box.style.transform = 'translateZ(0)'; box.style.willChange = 'transform'; } catch (e) {}
});
}
function clearAskComposeLayers() {
askBoxes().forEach(({ box }) => {
if (!askBoxNeedsLayerFix(box)) return;
try { box.style.transform = ''; box.style.willChange = ''; } catch (e) {}
});
}
let askKbRefreshStop = null;
function startAskKbRefresh() {
if (askKbRefreshStop) return;
// 没有需要救的 ce-box 就不装监听/定时器（iOS 原生输入框场景＝零开销、零 reflow）
if (!askBoxes().some(({ box }) => askBoxNeedsLayerFix(box))) return;
const vv = window.visualViewport;
if (!vv) return;
let t = null;
const refresh = () => {
if (t) clearTimeout(t);
t = setTimeout(() => {
t = null;
askBoxes().forEach(({ box }) => {
if (!askBoxNeedsLayerFix(box)) return; // #538：原生输入框不进整页 reflow
try {
box.style.transform = '';
void box.offsetHeight; // 强制 reflow，浏览器按新位置重建合成层
box.style.transform = 'translateZ(0)';
} catch (e) {}
});
}, 160);
};
vv.addEventListener('resize', refresh);
let phMo = null, lastPhH = null;
try {
const phEl = document.querySelector('.phone');
if (phEl && typeof MutationObserver === 'function') {
lastPhH = phEl.style.height;
phMo = new MutationObserver(() => {
const h = phEl.style.height;
if (h !== lastPhH) { lastPhH = h; refresh(); }
});
phMo.observe(phEl, { attributes: true, attributeFilter: ['style'] });
}
} catch (e) {}
askKbRefreshStop = () => {
if (t) clearTimeout(t);
if (phMo) { try { phMo.disconnect(); } catch (e) {} phMo = null; }
vv.removeEventListener('resize', refresh);
askKbRefreshStop = null;
};
}
function openChatAskPanel(mode) {
if (!chatAskPanel) return;
chatAskMode = mode || 'invite';
ensureChatAskTypeRow();
ensureChatAskThinkRow();
ensureChatAskMultiRow();
resetChatAskType();
if (chatAskTitle) chatAskTitle.textContent = chatAskMode === 'invite' ? '邀请TA' : '问问TA';
if (chatAskInput) {
chatAskInput.placeholder = chatAskMode === 'invite' ? '想邀请TA做什么？' : '你的问题？';
chatAskInput.value = '';
}
// v3.26.x：邀请TA 模式显示「我的邀请」字卡库（分组栏 + 字卡 + 存入按钮）；问问TA 模式隐藏
const invGroups = document.getElementById('invite-groups');
const invList = document.getElementById('invite-list');
const invSave = document.getElementById('chat-ask-save');
const isInvite = chatAskMode === 'invite';
	if (invGroups) invGroups.hidden = !isInvite;
	if (invList) invList.hidden = !isInvite;
	if (invSave) invSave.hidden = !isInvite;
	// v3.26.x：批量设置问卷按钮只在「问问TA」模式显示（邀请TA 模式隐藏）
	const bulkBtn = document.getElementById('chat-ask-bulk');
	if (bulkBtn) bulkBtn.hidden = isInvite;
	// #1188：邀请记录块只在「邀请TA」模式显示（问问TA 模式与批量问卷按钮同款收法）；
	// 每次打开都复位成「列表收起 + 只准备露最近 5 个历史日期组 + 历史日期全部收起」
	const invHist = document.getElementById('chat-ask-hist');
	if (invHist) invHist.hidden = !isInvite;
	if (isInvite) {
	  const ihList = document.getElementById('chat-ask-hist-list');
	  if (ihList) ihList.hidden = true;
	  ihPastShown = IH_PAGE_DAYS;
	  Object.keys(ihOpenDays).forEach(k => { delete ihOpenDays[k]; });
	  renderInviteHist();
	}
if (isInvite) {
myInviteAdoptFromIdb().then(() => { if (chatAskMode === 'invite') renderInviteBank(); });
}
const pc = document.getElementById('poke-card');
if (pc) pc.hidden = true;
const ep = document.getElementById('emoji-panel');
if (ep) ep.hidden = true;
if (window.closeAvlib) window.closeAvlib();
chatAskPanel.hidden = false;
closeIme(); // v3.5.116：收起输入法，半框完整不被键盘遮挡
applyAskComposeLayers();
startAskKbRefresh();
setTimeout(() => {
if (!chatAskInput) return;
chatAskInput.focus();
}, 80);
}
function askDismissIme() {
// FIX 2026-09-15 #512：关面板前显式收起输入法（先 blur、再隐藏面板）。用户报（红米 K80
// Chrome，明说其他机型也有）：「问问TA 发送卡片后手机输入法弹窗收起很慢，一直看到输入法
// 位置那半边灰屏」。
// 根因：本面板的输入框（#chat-ask-input/#chat-ask-opts 转 .ce-box 后）此刻正持有焦点，
// 旧实现直接 `hidden = true` ＝把「聚焦中的可编辑元素」从布局里摘掉，键盘是「被元素移除
// 带走」而不是「失焦收起」——一批内核/输入法不为这种移除派 focusout、也不派（或迟很多才派）
// visualViewport.resize：移动适配的收起链（focusout 置 _aClosing → 收起动画期只写 .phone
// 高度跟随 vv → vv 回基准复原）与 250ms 轮询因此全不动作 → .phone 内联收缩高停在键盘期
// 数值，输入法位置一直露 body 灰底；只能靠 1s 看门狗的「2.2s 无任何活动」兜底才会复原，
// 用户接着点/滑就永远不满足＝「一直看到半边灰屏」。
// 修法：显式 blur 走标准失焦链（同 #331 搜索结果「点结果先收键盘」先例）——focusout 必派发、
// _aClosing 闸门当场挂上、收起动画期零强制布局读取，灰底不再出现。
// 零机型分支：无聚焦时 blur 是空操作，键盘机制健全的内核行为完全不变（收起链本就工作）。
try { askBoxes().forEach(({ box }) => { try { if (box && box.blur) box.blur(); } catch (e) {} }); } catch (e) {}
closeIme(); // 兜底：面板之外仍聚焦的输入框（主聊天输入栏等）一并收起
// FIX 2026-09-15 #512（第二道·有界兜底）：向移动适配层报备「这次收键盘是程序化主动请求」。
// 第一道 blur 本身已让健康内核走标准失焦链；但确有内核/输入法在「聚焦元素被隐藏带走」式
// 收键盘下连 focusout 都不派（或极迟才派），移动层四条复原路（syncAndroidKb 的 vv 回基准 /
// focusout 400ms 复查 / 250ms 轮询 / #209·#236 看门狗）全要「vv 回基准」或「2.2s 无任何活动」
// 作证据 → .phone 内联收缩高继续卡在键盘期数值，输入法位置一直露 body 灰底。
// 报备后移动层武装**一次**有界兜底：800ms 时仍满足「无活文本焦点 + 报备后无新聚焦 + 视口读数
// 500ms 未变 + 收缩高未清」才按「键盘已收」复原（动作与 #209·#236 清扫完全一致）。条件任一不成立
// 即放弃＝健康内核零行为变化；不做任何机型判断（同一份代码全机型通用，不覆盖他机修复）。
if (window.mochiKbDismiss) { try { window.mochiKbDismiss(); } catch (e) {} }
}
function closeChatAskPanel() {
if (askKbRefreshStop) { try { askKbRefreshStop(); } catch (e) {} }
clearAskComposeLayers();
askDismissIme();
if (chatAskPanel) chatAskPanel.hidden = true;
}
function submitChatAsk() {
if (!chatAskInput) return;
const content = (chatAskInput.value || '').trim();
if (!content) { toast('请输入内容'); return; }
let askOpts = null;
if (chatAskMode === 'ask' && (chatAskType === 'single' || chatAskType === 'multi')) {
const multi = chatAskType === 'multi';
const optsEl = document.getElementById('chat-ask-opts');
askOpts = String(optsEl ? optsEl.value || '' : '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(line => {
const i = line.indexOf('~');
return i >= 0 ? { t: line.slice(0, i).trim(), reply: line.slice(i + 1).trim() } : { t: line, reply: '' };
});
if (!askOpts.length) { toast((multi ? '多选题' : '单选题') + '请填写选项，每行一个'); return; }
// #1415：多选题只给 1 个选项就没什么可「多」的——按题型的实际含义拦一下
if (multi && askOpts.length < 2) { toast('多选题至少填 2 个选项'); return; }
}
closeChatAskPanel();
if (chatAskMode === 'invite') {
sendInviteContent(content);
} else {
addRec({ side: 'out', text: '问：' + content, special: 'ask', askQuestion: content, askType: askOpts ? chatAskType : 'text', askOptions: askOpts, askStatus: 'pending' });
const askIdx = msgs.length - 1;
// v3.26.x #489：卡片 ts 作定位键——回答延迟窗内 loadMsgs 可能重建 msgs（索引错位，
// 同 ta-ask.js locateCardIdx 的防御理由）；跨桌面补投递也按它定位
const askRecTs = (msgs[askIdx] && msgs[askIdx].special === 'ask') ? msgs[askIdx].ts : 0;
// v3.26.x #489：按 ts 重新定位未回答的提问卡，找不到再退回旧索引（顺带修索引陈旧指向别张卡）
const locateAsk = () => {
  if (askRecTs) {
    // askStatus 取值 'pending'/'answered'（发卡即写 pending），判未回答必须比对 answered
    for (let i = msgs.length - 1; i >= 0; i--) { const r = msgs[i]; if (r && r.special === 'ask' && r.ts === askRecTs && r.askStatus !== 'answered') return i; }
  }
  if (msgs[askIdx] && msgs[askIdx].special === 'ask' && msgs[askIdx].askStatus !== 'answered') return askIdx;
  return -1;
};
if (window.logFish) window.logFish();
const recTs = Date.now();
const myCid = window.__activeCid || 'default';
const sameCid = () => (window.__activeCid || 'default') === myCid;
// v3.26.x #489：回应内容在发送时当场抽定——延迟落地时用户可能已在别的桌面，
// 那时 getInteractPool/pickAskCardReply 抽的是别的联系人的池子
const defs = window.getInteractPool
? window.getInteractPool('问问TA·回应', ['嗯嗯', '我想想…', '应该吧', '好呀', '我陪你', '可以的', '那挺好呀', '我觉得可以', '听你的', '当然可以', '我很乐意'])
: ['嗯嗯', '我想想…', '应该吧', '好呀', '我陪你', '可以的', '那挺好呀', '我觉得可以', '听你的', '当然可以', '我很乐意'];
let text;
if (askOpts && askOpts.length) {
// #1415：多选题一次抽「2 ~ min(最多选几个, 选项数)」个、按题目原序念出来；单选保持抽 1 个
if (chatAskType === 'multi') {
text = mochiPickMulti(askOpts.length, askMultiMaxLoad()).map(k => String(askOpts[k].t || '')).join('、');
} else {
text = String(askOpts[Math.floor(Math.random() * askOpts.length)].t || '');
}
} else {
text = (window.pickAskCardReply ? window.pickAskCardReply(defs) : defs[Math.floor(Math.random() * defs.length)]);
}
setTimeout(() => {
// v3.26.x #489：回应落地时已切到别的桌面——不再取消（旧实现 return＝回答永久丢失，
// 切回后卡片永远「等待 TA 回答…」），改跨桌面补投递：原桌面卡片落 answered + 补回应
// 气泡 + 提问记录；补投递期间切回则走内存链路（onBack），两条路只生效一条
if (!sameCid()) {
window.chatDeskCardReply(myCid, 'ask', askRecTs, 'askStatus', function (rec) { rec.askStatus = 'answered'; rec.askAnswer = text; }, [{ side: 'in', text: text }], applyAskAnswer);
try { window.chatDeskHistPush(myCid, { type: 'ask', q: content, a: text, ts: recTs }); } catch (err) {}
return;
}
function applyAskAnswer() {
const i = locateAsk();
const rec = i >= 0 ? msgs[i] : null;
if (rec) {
rec.askStatus = 'answered';
rec.askAnswer = text;
saveMsgs();
saveMsgsNow(); // v3.26.x #489：回答即落盘（同 chatAskReply 先例），切桌面 flush 前不止内存一份
const el = body.querySelector('.msg-ask[data-idx="' + i + '"]');
if (el) {
el.innerHTML = '<div class="msg-ask-card answered"><div class="msg-ask-q">' + (window.taFit ? window.taFit('问问TA') : '问问TA') + ' · ' + escTxt(content) + '</div><div class="msg-ask-a">✓ ' + (window.taFit ? window.taFit('TA：') : 'TA：') + escTxt(window.taFit ? window.taFit(text) : text) + '</div>' + favHeartHtml(rec) + '</div>';
}
}
addInTyped(text);
try {
const list = JSON.parse(store.get('invite-ask-history') || '[]');
// v3.26.x #489：按 ts 去重——跨桌面补投递路径可能已记过同一条
if (!list.some(x => x && x.ts === recTs)) {
list.unshift({ type: 'ask', q: content, a: text, ts: recTs });
if (list.length > 200) list.length = 200;
store.set('invite-ask-history', JSON.stringify(list));
}
} catch (err) {}
if (window.renderAskRecords) window.renderAskRecords();
setTimeout(() => { if (!sameCid()) return; maybeFollowupAskCard(); }, 1200);
}
applyAskAnswer();
}, askThinkSecsLoad() * 1000); // #809：思考时间用户可调（1~10 秒），默认 3 秒；原 1500+rand*2500
}
}
// v3.26.x：邀请发送逻辑从 submitChatAsk 抽出，供「我的邀请」字卡点卡直接复用（可重复发送，
// 行为与手动输入一致：TA 接受/拒绝/未回应，随消息持久化）
function sendInviteContent(content) {
closeChatAskPanel();
addRec({ side: 'out', text: '邀请：' + content, special: 'invite', inviteContent: content, inviteStatus: 'pending' });
const inviteIdx = msgs.length - 1;
// v3.26.x #489：同 submitChatAsk——ts 定位键 + 索引重定位（延迟窗内 msgs 可能重建）
const inviteRecTs = (msgs[inviteIdx] && msgs[inviteIdx].special === 'invite') ? msgs[inviteIdx].ts : 0;
const locateInvite = () => {
  if (inviteRecTs) {
    // inviteStatus 取值 'pending'/'answered'（发卡即写 pending），判未回应必须比对 answered
    for (let i = msgs.length - 1; i >= 0; i--) { const r = msgs[i]; if (r && r.special === 'invite' && r.ts === inviteRecTs && r.inviteStatus !== 'answered') return i; }
  }
  if (msgs[inviteIdx] && msgs[inviteIdx].special === 'invite' && msgs[inviteIdx].inviteStatus !== 'answered') return inviteIdx;
  return -1;
};
if (window.logFish) window.logFish();
const histKey = 'invite-ask-history';
const recTs = Date.now();
const myCid = window.__activeCid || 'default';
const sameCid = () => (window.__activeCid || 'default') === myCid;
// v3.26.x #489：接受/拒绝与话术在发送时当场掷定（延迟落地时可能已在别的桌面，
// pickAskCardReply/chatPartnerName 取的是别的联系人的池子/名字）
const myName = chatPartnerName();
const roll = Math.random();
let status, answer, reply = null;
if (roll < 0.6) {
status = '接受';
answer = myName + ' 接受了你的邀请';
const pool = window.getInteractPool
? window.getInteractPool('邀请TA·接受', ['好，我答应你。', '可以呀。', '我陪你。', '走吧。', '嗯，陪你。'])
: ['好，我答应你。', '可以呀。', '我陪你。', '走吧。', '嗯，陪你。'];
reply = (window.pickAskCardReply ? window.pickAskCardReply(pool) : pool[Math.floor(Math.random() * pool.length)]);
} else if (roll < 0.85) {
status = '拒绝';
answer = myName + ' 拒绝了你的邀请';
const pool = window.getInteractPool
? window.getInteractPool('邀请TA·拒绝', ['这次不行。', '下次吧。', '抱歉。', '今天不方便。'])
: ['这次不行。', '下次吧。', '抱歉。', '今天不方便。'];
reply = (window.pickAskCardReply ? window.pickAskCardReply(pool) : pool[Math.floor(Math.random() * pool.length)]);
} else {
status = '未回应';
answer = myName + ' 暂时没有回应';
}
setTimeout(() => {
// v3.26.x #489：决定落地时已切桌面——跨桌面补投递（接受/拒绝的回应气泡一并落库）
if (!sameCid()) {
window.chatDeskCardReply(myCid, 'invite', inviteRecTs, 'inviteStatus', function (rec) { rec.inviteStatus = 'answered'; rec.inviteAnswer = answer; }, reply ? [{ side: 'in', text: reply }] : [], applyInviteResult);
try { window.chatDeskHistPush(myCid, { type: 'invite', q: content, a: reply || status, st: status, ts: recTs }); } catch (err) {}
return;
}
function applyInviteResult() {
const i = locateInvite();
const rec = i >= 0 ? msgs[i] : null;
if (rec) {
rec.inviteStatus = 'answered';
rec.inviteAnswer = answer;
saveMsgs();
saveMsgsNow(); // v3.26.x #489：结果即落盘，切桌面 flush 前不止内存一份
taFavCard(rec);
const el = body.querySelector('.msg-ask[data-idx="' + i + '"]');
if (el) {
el.innerHTML = '<div class="msg-ask-card answered"><div class="msg-ask-q">' + (window.taFit ? window.taFit('邀请TA') : '邀请TA') + ' · ' + escTxt(content) + '</div><div class="msg-ask-a">✓ ' + escTxt(window.taFit ? window.taFit(answer) : answer) + '</div>' + favHeartHtml(rec) + '</div>';
}
}
if (reply) addInTyped(reply, null, randInt(800, 1400));
try {
const list = JSON.parse(store.get(histKey) || '[]');
// v3.26.x #489：按 ts 去重——跨桌面补投递路径可能已记过同一条
if (!list.some(x => x && x.ts === recTs)) {
list.unshift({ type: 'invite', q: content, a: reply || status, st: status, ts: recTs });
if (list.length > 200) list.length = 200;
store.set(histKey, JSON.stringify(list));
}
} catch (err) {}
if (window.renderAskRecords) window.renderAskRecords();
setTimeout(() => { if (!sameCid()) return; maybeFollowupAskCard(); }, 1200);
}
applyInviteResult();
}, 1500 + Math.random() * 2500);
}
// ===================== #1188 邀请记录（「邀请TA」半框顶部） =====================
// 需求（用户直派）：「邀请卡片功能缺少邀请历史记录」＋「当天的历史记录只显示当天的，其他时间的
// 记录默认折叠，分页加载」。
// 数据源＝既有本桌面键 invite-ask-history 里 type==='invite' 的那些（我发出的邀请，由
// sendInviteContent 在 TA 的决定落地时写入），不新开键、不复制第二份——同一条记录在
// 「提问记录 → 邀请/问问」tab 里本来就有，本块只是把它按「今天 / 更早」分日收纳进半框。
// 展示口径：①今天（自然日）直接列出；②更早的按天各折成一行，点日期展开/收起；③日期组分页，
// 一次露 IH_PAGE_DAYS 组，其余藏在「加载更多（还有 N 天 · M 条）」后面；④「清空记录」只摘掉
// type==='invite' 的条目，同键里问问TA 的记录原样保留。
const IH_PAGE_DAYS = 5;
let ihPastShown = IH_PAGE_DAYS; // 已露出的「更早」日期组数（不含今天）
const ihOpenDays = {};          // 手动展开的更早日期组（key = 年-月-日）
function ihDayKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
function ihDayLabel(key) {
  const now = Date.now();
  if (key === ihDayKey(now)) return '今天';
  if (key === ihDayKey(now - 86400000)) return '昨天';
  const p = String(key).split('-');
  return Number(p[1]) + '月' + Number(p[2]) + '日';
}
// 读库 → 只留邀请 → ts 新→旧 → 按自然日分组（分组顺序跟随首次出现＝新日在前）
function ihGroups() {
  let list = [];
  try {
    const raw = JSON.parse(store.get('invite-ask-history') || '[]');
    if (Array.isArray(raw)) list = raw.filter(x => x && x.type === 'invite' && Number(x.ts));
  } catch (e) { list = []; }
  list.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  const groups = [];
  const byKey = {};
  list.forEach(x => {
    const k = ihDayKey(Number(x.ts));
    if (!byKey[k]) { byKey[k] = { key: k, items: [] }; groups.push(byKey[k]); }
    byKey[k].items.push(x);
  });
  return { groups, total: list.length };
}
function ihClock(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return p(d.getHours()) + ':' + p(d.getMinutes());
}
// 一条记录：邀请内容 + 结果（老记录没有 st，就只展示 TA 的话）+ 时刻
function ihItemHtml(x) {
  const st = (x.st === '接受' || x.st === '拒绝' || x.st === '未回应') ? x.st : '';
  const words = x.a && String(x.a) !== st ? String(x.a) : '';
  const verdict = !st ? '' : (st === '接受' ? '<span class="ih-ok">✓ TA 接受了</span>'
    : st === '拒绝' ? '<span class="ih-no">✕ TA 拒绝了</span>'
    : '<span class="ih-nu">… TA 未回应</span>');
  const tail = verdict && words ? ' · ' : '';
  const ta = words ? escTxt(window.taFit ? window.taFit(words) : words) : '';
  return '<div class="tc-listitem"><div class="tc-li-q">' + escTxt(x.q) + '</div>' +
    (verdict || ta ? '<div class="tc-li-line">' + verdict + tail + ta + '</div>' : '') +
    '<div class="tc-li-time">' + ihClock(Number(x.ts)) + '</div></div>';
}
function renderInviteHist() {
  const listEl = document.getElementById('chat-ask-hist-list');
  const toggle = document.getElementById('chat-ask-hist-toggle');
  if (!listEl || !toggle) return;
  const g = ihGroups();
  const todayKey = ihDayKey(Date.now());
  const today = g.groups.filter(x => x.key === todayKey);
  const past = g.groups.filter(x => x.key !== todayKey);
  const shown = past.slice(0, ihPastShown);
  const rest = past.slice(ihPastShown);
  const restItems = rest.reduce((n, x) => n + x.items.length, 0);
  toggle.textContent = '📜 邀请记录' + (g.total ? '（' + g.total + '）' : '') + (listEl.hidden ? ' ▾' : ' ▴');
  if (!g.total) {
    listEl.innerHTML = '<div class="ta-empty">还没有邀请记录——在下方点字卡或写一条发出去，就会留在这里</div>';
    return;
  }
  let html = '';
  // 今天：直接列出（今天一条都没有时给一行说明，避免打开后只见折叠行）
  html += today.length
    ? '<div class="ih-day ih-day-today">' + ihDayLabel(todayKey) + ' · ' + today[0].items.length + ' 条</div>' + today[0].items.map(ihItemHtml).join('')
    : '<div class="ih-day ih-day-today">' + ihDayLabel(todayKey) + ' · 0 条</div>';
  shown.forEach(x => {
    const open = !!ihOpenDays[x.key];
    html += '<button type="button" class="ih-day-btn" data-ihday="' + escTxt(x.key) + '">' + ihDayLabel(x.key) + ' · ' + x.items.length + ' 条<span class="ih-caret">' + (open ? '▴' : '▾') + '</span></button>';
    if (open) html += x.items.map(ihItemHtml).join('');
  });
  if (rest.length) html += '<button type="button" class="ih-more" id="ih-more">加载更多（还有 ' + rest.length + ' 天 · ' + restItems + ' 条）</button>';
  listEl.innerHTML = html;
  listEl.querySelectorAll('[data-ihday]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const k = b.getAttribute('data-ihday');
    if (ihOpenDays[k]) delete ihOpenDays[k]; else ihOpenDays[k] = 1;
    renderInviteHist();
  }));
  const more = document.getElementById('ih-more');
  if (more) more.addEventListener('click', (e) => {
    e.stopPropagation();
    ihPastShown += IH_PAGE_DAYS;
    renderInviteHist();
  });
}
const chatAskHistToggle = document.getElementById('chat-ask-hist-toggle');
if (chatAskHistToggle) chatAskHistToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  const listEl = document.getElementById('chat-ask-hist-list');
  if (!listEl) return;
  listEl.hidden = !listEl.hidden;
  renderInviteHist();
});
const chatAskHistClear = document.getElementById('chat-ask-hist-clear');
if (chatAskHistClear) chatAskHistClear.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!window.openModal) { toast('弹窗组件未就绪'); return; }
  window.openModal('清空本桌面的全部邀请记录？（不可恢复，问问TA 的记录不受影响）', '', () => {
    try {
      const all = JSON.parse(store.get('invite-ask-history') || '[]');
      const keep = Array.isArray(all) ? all.filter(x => x && x.type !== 'invite') : [];
      store.set('invite-ask-history', JSON.stringify(keep));
    } catch (err) {}
    ihPastShown = IH_PAGE_DAYS;
    Object.keys(ihOpenDays).forEach(k => { delete ihOpenDays[k]; });
    renderInviteHist();
    if (window.renderAskRecords) window.renderAskRecords(); // #625 汇总页同口径刷新
    toast('邀请记录已清空');
  }, { noInput: true });
});

// ===================== 我的邀请（邀请TA 字卡库，仿「我的拍一拍」） =====================
// v3.26.x：邀请TA 半框内置「我的邀请」——预设 + 用户分组存邀请字卡，点卡即发送（可重复），
// 输入框可「存入」当前分组；数据按当前桌面联系人命名空间隔离（activePrefix），
// 结构化写入 IndexedDB 兜底，防止 iOS 存储清理导致字卡丢失（同 pokeUserGroups 策略）。
const MY_INVITE_PRESETS = ['想和你猜拳，来一局？', '想和你玩一局 Pong，来吗？', '想和你玩双人贪吃蛇，来吗？', '想和你一起听歌'];
let myInviteDirty = false;
let myInviteCurGroup = '__preset';
let myInviteGroups = null;
function myInviteGroupsKey() { return window.activePrefix() + ':my-invite-groups'; }
function myInviteGroupsLoad() {
try {
const v = JSON.parse(store.get('my-invite-groups') || 'null');
if (Array.isArray(v)) return v.filter(g => Array.isArray(g) && Array.isArray(g[1]));
} catch (e) {}
return null;
}
function myInviteG() {
if (myInviteGroups === null) {
	myInviteGroups = myInviteGroupsLoad() || [];
	if (!myInviteGroups.some(g => g[0] === '我的新增')) myInviteGroups.push(['我的新增', []]);
	}
	// v3.28：预设分组持久化——系统内置字卡灌入 '__preset' 条目（首启自动），
	// 这样预设分组的字卡也能单独「修改/删除」，否则预设 cards 每次 view 实时重建、无持久化可写（用户反馈「无法单独编辑字卡」）
	if (!myInviteGroups.some(g => g[0] === '__preset')) {
	myInviteGroups.unshift(['__preset', MY_INVITE_PRESETS.slice()]);
	myInviteGroupsSave();
	}
	return myInviteGroups;
}
function myInviteGroupsSave() {
myInviteDirty = true;
try {
const data = JSON.stringify(myInviteGroups);
store.set('my-invite-groups', data);
if (window.idbSet) window.idbSet(myInviteGroupsKey(), data);
} catch (e) {}
}
function myInviteCount(arr) { return (arr || []).reduce((n, g) => n + (Array.isArray(g) && Array.isArray(g[1]) ? g[1].length : 0), 0); }
// IDB 兜底恢复：备份条目多于内存时采用；会话内已改过（myInviteDirty）则跳过防回滚
function myInviteAdoptFromIdb() {
if (myInviteDirty || !window.idbGet) return Promise.resolve(false);
return window.idbGet(myInviteGroupsKey()).then(v => {
if (!v || myInviteDirty) return false;
let arr = null;
try { arr = JSON.parse(v); } catch (e) { return false; }
if (!Array.isArray(arr)) return false;
if (myInviteCount(arr) > myInviteCount(myInviteG())) {
myInviteGroups = arr.filter(g => Array.isArray(g) && Array.isArray(g[1]));
return true;
}
return false;
}).catch(() => false);
}
function myInviteView() {
	const out = [];
	const pre = myInviteG().find(g => g[0] === '__preset');
	out.push({ key: '__preset', label: '预设', cards: ((pre && Array.isArray(pre[1])) ? pre[1].slice() : MY_INVITE_PRESETS.slice()).filter(c => !(typeof window.isDefaultCardOff === 'function' && window.isDefaultCardOff('interact', c))), preset: true });
	myInviteG().forEach(g => {
	if (g[0] === '__preset') return;
	if (!Array.isArray(g) || !Array.isArray(g[1]) || !g[0]) return;
out.push({ key: g[0], label: g[0], cards: g[1].slice(), user: true });
});
return out;
}
function myInviteCurGroupKey() {
const groups = myInviteView();
if (!groups.some(g => g.key === myInviteCurGroup)) myInviteCurGroup = groups.length ? groups[0].key : '__preset';
return myInviteCurGroup;
}
// v3.x：邀请TA ——批量管理模式态（预设为系统内置分组：仅自建分组可进批量，可重命名/删除分组）
let tiInviteBatch = false;   // 批量管理模式开关
let tiInviteSel = new Set(); // 批量勾选：当前自建分组内字卡下标集合
function renderInviteBank() {
const wrap = document.getElementById('invite-groups');
const list = document.getElementById('invite-list');
if (!wrap || !list) return;
myInviteCurGroupKey();
const groups = myInviteView();
const cur = groups.find(g => g.key === myInviteCurGroup) || groups[0] || { key: '__preset', cards: [] };
const curIsPreset = cur.key === '__preset';
// 预设为系统内置分组：切回预设时自动退出批量态
if (curIsPreset && tiInviteBatch) { tiInviteBatch = false; tiInviteSel.clear(); }
wrap.innerHTML = '';
groups.forEach(g => {
const chip = document.createElement('span');
chip.className = 'emoji-g-chip' + (myInviteCurGroup === g.key ? ' sel' : '');
if (tiInviteBatch && g.user) {
chip.innerHTML = escTxt(g.label) + g.cards.length +
'<span class="inv-g-op" data-op="rn">✎</span>' +
'<span class="inv-g-op" data-op="rm">✕</span>';
} else {
chip.textContent = g.label + g.cards.length;
}
const gkey = g.key, glabel = g.label;
chip.addEventListener('click', (e) => {
e.stopPropagation();
const op = e.target && e.target.closest ? e.target.closest('.inv-g-op') : null;
if (op) {
if (op.getAttribute('data-op') === 'rn') myInviteRenameGroup(gkey, glabel);
else if (op.getAttribute('data-op') === 'rm') myInviteRemoveGroup(gkey);
return;
}
if (myInviteCurGroup === gkey) return;
myInviteCurGroup = gkey;
tiInviteSel.clear();
renderInviteBank();
});
wrap.appendChild(chip);
});
const add = document.createElement('span');
add.className = 'emoji-g-chip poke-g-add';
add.textContent = '＋ 分组';
add.title = '新建我的邀请分组';
add.addEventListener('click', (e) => { e.stopPropagation(); myInviteNewGroup(); });
wrap.appendChild(add);
// v3.x：批量管理 chip（顶部分组栏右侧）——进入后批量勾选字卡，亦可在自建分组上 ✎重命名/✕删除
const batch = document.createElement('span');
batch.className = 'emoji-g-chip inv-g-batch' + (tiInviteBatch ? ' on' : '');
batch.textContent = tiInviteBatch ? '完成' : '批量管理';
batch.title = '批量管理：勾选字卡后可全选/删除/移动，也支持重命名/删除自建分组';
batch.addEventListener('click', (e) => { e.stopPropagation(); toggleInviteBatch(); });
wrap.appendChild(batch);
list.innerHTML = '';
if (tiInviteBatch && !curIsPreset) {
if (!cur.cards.length) {
list.innerHTML = '<div class="cc-empty">该分组暂无邀请字卡<br>在下方输入邀请内容，点「存入」添加</div>';
} else {
cur.cards.forEach((c, i) => {
const item = document.createElement('div');
item.className = 'cc-item glass invite-batch-item';
item.innerHTML = '<label class="inv-batch-cb"><input type="checkbox" class="inv-batch-cb-in" data-bidx="' + i + '"' + (tiInviteSel.has(i) ? ' checked' : '') + '></label><div class="cc-txt"><div class="t">' + escTxt(c) + '</div></div>';
const cb = item.querySelector('.inv-batch-cb-in');
if (cb) cb.addEventListener('change', () => {
if (cb.checked) tiInviteSel.add(i); else tiInviteSel.delete(i);
updateInviteBatchBarUI();
});
list.appendChild(item);
});
}
list.insertAdjacentHTML('beforeend',
'<div class="ti-batch-bar" id="inv-batch-bar">' +
'<span class="ti-batch-cnt" id="inv-batch-cnt">已选 <em>' + tiInviteSel.size + '</em> 条</span>' +
'<button class="ti-batch-btn" id="inv-batch-all">全选</button>' +
'<button class="ti-batch-btn" id="inv-batch-move"' + (tiInviteSel.size === 0 ? ' disabled' : '') + '>移动</button>' +
'<button class="ti-batch-btn ti-batch-del-btn" id="inv-batch-del"' + (tiInviteSel.size === 0 ? ' disabled' : '') + '>删除</button>' +
'<button class="ti-batch-btn" id="inv-batch-cancel">取消</button>' +
'</div>');
bindInviteBatchBar();
return;
}
if (!cur.cards.length) {
list.innerHTML = '<div class="cc-empty">暂无邀请字卡<br>在下方输入邀请内容，点「存入」添加</div>';
return;
}
cur.cards.forEach((c, i) => {
const item = document.createElement('div');
item.className = 'cc-item glass';
item.innerHTML = '<div class="cc-txt"><div class="t">' + escTxt(c) + '</div></div>';
	// v3.28：所有分组（含预设）的字卡都给「修改/删除」按钮——预设分组已持久化，myInviteEdit/myInviteDel 可直接写回（用户反馈预设字卡没法单独编辑）
	item.addEventListener('click', () => { sendInviteContent(c); });
	const ops = document.createElement('div');
ops.className = 'poke-card-ops';
const eb = document.createElement('button');
eb.type = 'button';
eb.className = 'poke-card-op poke-op-edit';
eb.title = '修改';
eb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
eb.addEventListener('click', (e) => { e.stopPropagation(); myInviteEdit(i, c); });
const db = document.createElement('button');
db.type = 'button';
db.className = 'poke-card-op poke-op-del';
db.title = '删除';
db.textContent = '✕';
db.addEventListener('click', (e) => { e.stopPropagation(); myInviteDel(i, c); });
ops.appendChild(eb);
	ops.appendChild(db);
	item.appendChild(ops);
	list.appendChild(item);
	});
}
function toggleInviteBatch() {
const groups = myInviteView();
const cur = groups.find(g => g.key === myInviteCurGroup);
if (!cur) return;
if (!tiInviteBatch && cur.key === '__preset') {
toast('预设为系统内置分组，请切换到自建分组后批量管理');
return;
}
tiInviteBatch = !tiInviteBatch;
tiInviteSel.clear();
renderInviteBank();
}
function myInviteCurGroupArr() {
const g = myInviteG().find(x => Array.isArray(x) && Array.isArray(x[1]) && x[0] === myInviteCurGroup);
return (g && Array.isArray(g[1])) ? g[1] : null;
}
function updateInviteBatchBarUI() {
const cnt = document.getElementById('inv-batch-cnt');
if (cnt) cnt.innerHTML = '已选 <em>' + tiInviteSel.size + '</em> 条';
const del = document.getElementById('inv-batch-del');
if (del) del.disabled = tiInviteSel.size === 0;
const mv = document.getElementById('inv-batch-move');
if (mv) mv.disabled = tiInviteSel.size === 0;
}
function bindInviteBatchBar() {
const curArr = myInviteCurGroupArr();
const n = curArr ? curArr.length : 0;
const all = document.getElementById('inv-batch-all');
if (all) all.addEventListener('click', () => {
if (tiInviteSel.size >= n) tiInviteSel.clear();
else for (let i = 0; i < n; i++) tiInviteSel.add(i);
renderInviteBank();
});
const cancel = document.getElementById('inv-batch-cancel');
if (cancel) cancel.addEventListener('click', () => {
tiInviteBatch = false; tiInviteSel.clear(); renderInviteBank();
});
const del = document.getElementById('inv-batch-del');
if (del) del.addEventListener('click', () => {
if (tiInviteSel.size === 0) { toast('请先勾选要删除的字卡'); return; }
const cnt = tiInviteSel.size;
window.openModal('删除选中的 ' + cnt + ' 条邀请字卡？', '', function () {
const arr = myInviteCurGroupArr();
if (!arr) return;
Array.from(tiInviteSel).sort((a, b) => b - a).forEach(i => { if (i >= 0 && i < arr.length) arr.splice(i, 1); });
myInviteGroupsSave();
tiInviteSel.clear();
tiInviteBatch = false;
myInviteCurGroupKey();
renderInviteBank();
toast('已删除 ' + cnt + ' 条');
}, { noInput: true, staticText: '此操作不可撤销。' });
});
const moveBtn = document.getElementById('inv-batch-move');
if (moveBtn) moveBtn.addEventListener('click', () => {
if (tiInviteSel.size === 0) { toast('请先勾选要移动的邀请字卡'); return; }
const groups = myInviteG().filter(g => Array.isArray(g) && Array.isArray(g[1]) && g[0] && g[0] !== myInviteCurGroup);
if (!groups.length) { toast('没有其他可移动的分组'); return; }
const opts = groups.map(g => ({ label: g[0], value: g[0] }));
const cnt = tiInviteSel.size;
window.openModal('移动到分组', '', function (v) {
const target = String(v || '');
if (!target) { toast('请选择目标分组'); return; }
const src = myInviteCurGroupArr();
if (!src) return;
let tArr = myInviteG().find(g => Array.isArray(g) && Array.isArray(g[1]) && g[0] === target);
if (!tArr) { tArr = [target, []]; myInviteG().push(tArr); }
let moved = 0;
Array.from(tiInviteSel).sort((a, b) => b - a).forEach(i => { if (i >= 0 && i < src.length) { tArr[1].push(src[i]); src.splice(i, 1); moved++; } });
myInviteGroupsSave();
tiInviteSel.clear();
tiInviteBatch = false;
myInviteCurGroupKey();
renderInviteBank();
toast('已移动 ' + moved + ' 条到「' + target + '」');
}, { pills: opts, pill: opts[0].value, noInput: true });
});
}
function myInviteRenameGroup(gk, oldLabel) {
window.openModal('重命名分组', oldLabel, function (v) {
v = (v || '').trim();
if (!v) { toast('请输入分组名'); return; }
const groups = myInviteG();
const g = groups.find(x => x[0] === gk);
if (!g) return;
if (v === gk) { toast('名称未变化'); return; }
if (groups.some(x => x[0] === v)) { toast('分组「' + v + '」已存在'); return; }
g[0] = v;
if (myInviteCurGroup === gk) myInviteCurGroup = v;
myInviteGroupsSave();
renderInviteBank();
toast('已重命名');
});
}
function myInviteRemoveGroup(gk) {
window.openModal('删除该分组？', '', function () {
const groups = myInviteG();
const g = groups.find(x => x[0] === gk);
if (!g) return;
const cnt = Array.isArray(g[1]) ? g[1].length : 0;
groups.splice(groups.indexOf(g), 1);
if (myInviteCurGroup === gk) myInviteCurGroup = null;
myInviteGroupsSave();
tiInviteSel.clear();
myInviteCurGroupKey();
renderInviteBank();
toast(cnt ? '已删除分组及 ' + cnt + ' 条字卡' : '已删除分组');
}, { noInput: true, staticText: '删除「' + gk + '」分组及其中的全部字卡？此操作不可撤销。' });
}
// end renderInviteBank
function saveInviteInput() {
const v = (chatAskInput && chatAskInput.value || '').trim();
if (!v) { toast('先输入邀请内容'); return; }
const groups = myInviteG();
let target = groups.find(g => g[0] === myInviteCurGroup);
if (!target) { target = ['我的新增', []]; groups.push(target); }
if (target[1].indexOf(v) >= 0) { toast('「' + target[0] + '」已有相同的邀请'); return; }
target[1].push(v);
myInviteGroupsSave();
myInviteCurGroup = target[0];
renderInviteBank();
if (chatAskInput) chatAskInput.value = '';
toast('已存入「' + target[0] + '」');
}
function myInviteNewGroup() {
window.openModal('新建「我的邀请」分组', '', (v) => {
v = (v || '').trim();
if (!v) { toast('请输入分组名'); return; }
const groups = myInviteG();
if (groups.some(g => g[0] === v)) { toast('分组「' + v + '」已存在'); return; }
groups.push([v, []]);
myInviteGroupsSave();
myInviteCurGroup = v;
renderInviteBank();
toast('已新建分组「' + v + '」');
});
}
function myInviteEdit(idx, old) {
const g = myInviteG().find(x => x[0] === myInviteCurGroup);
if (!g || !Array.isArray(g[1])) return;
window.openModal('修改邀请', old, (v) => {
v = (v || '').trim();
if (!v) { toast('请输入邀请内容'); return; }
const g2 = myInviteG().find(x => x[0] === myInviteCurGroup);
if (!g2 || !Array.isArray(g2[1]) || idx < 0 || idx >= g2[1].length) return;
if (g2[1][idx] === v) { toast('内容未变化'); return; }
if (g2[1].indexOf(v) >= 0) { toast('该分组已有相同的邀请'); return; }
g2[1][idx] = v;
myInviteGroupsSave();
renderInviteBank();
toast('已修改');
});
}
function myInviteDel(idx, c) {
const g = myInviteG().find(x => x[0] === myInviteCurGroup);
if (!g || !Array.isArray(g[1])) return;
window.openModal('删除这条邀请？', '', () => {
const g2 = myInviteG().find(x => x[0] === myInviteCurGroup);
if (!g2 || !Array.isArray(g2[1]) || idx < 0 || idx >= g2[1].length) return;
g2[1].splice(idx, 1);
myInviteGroupsSave();
renderInviteBank();
toast('已删除');
}, { noInput: true, staticText: '「' + c + '」\n\n删除后无法恢复。' });
}
document.addEventListener('contact-switched', function () {
myInviteDirty = false;
myInviteGroups = null;
myInviteCurGroup = '__preset';
tiInviteBatch = false;
tiInviteSel.clear();
});
const moreInvite = document.getElementById('more-invite');
if (moreInvite) {
moreInvite.addEventListener('click', (e) => {
e.stopPropagation();
if (morePanel) morePanel.hidden = true;
openChatAskPanel('invite');
});
}
const moreAsk = document.getElementById('more-ask');
if (moreAsk) {
moreAsk.addEventListener('click', (e) => {
e.stopPropagation();
if (morePanel) morePanel.hidden = true;
openChatAskPanel('ask');
});
}
if (chatAskOk) chatAskOk.addEventListener('click', (e) => { e.stopPropagation(); submitChatAsk(); });
if (chatAskCancel) chatAskCancel.addEventListener('click', (e) => { e.stopPropagation(); closeChatAskPanel(); });
if (chatAskClose) chatAskClose.addEventListener('click', (e) => { e.stopPropagation(); closeChatAskPanel(); });
// FIX 2026-09-20 #906：底部半框「点半框外关闭」收口成一分派器（用户报【帮我决定】【群聊决定】点屏幕其他地方关不掉）
// 现状：拍一拍/表情包/更多功能/批量/语音/寻踪/消息菜单/群聊两菜单早在各自文件手挂了 document click 点外关闭（#481/#529），
// 占卜、问问TA、聊天记录、猜拳、红包、帮我决定、多人决定这几枚同族底半框从来没挂＝点外没有任何关闭路径，只能点 ✕。
// 四条判据（各家手挂版没有的兜底，收在一起）：
// ①「刚打开那一击」不算点外——入口 click 与本监听同批派发（部分入口没 stopPropagation、touch 直驱还补发合成 click），
//    无此闩＝刚开即关（同 #522 弹窗 350ms 判据）；打开时刻用 hidden 属性观察器取，不侵入各面板的 open 函数；
// ②落在上层弹窗遮罩 .modal-mask 上不算点外（openModal 是全站唯一弹窗，点它＝关弹窗，不该连底下半框一起收）；
// ③走各面板自己的关闭函数（红包收设置区、问问TA 清键盘合成层），与点 ✕ 完全同一条路。
// ④（#1207）「在框内」按事件派发那一刻的路径算，不读实时 contains——被点的元素可能在同一记点击的
//    处理器里就被移出 DOM（占卜抽牌：牌背在抽中那一刻 removeChild 自己），那时 contains 已为假，
//    「点牌背抽一张」就被误判成「点半框外」＝用户实报「聊天里打开占卜，抽牌的时候自动退出」。
//    composedPath() 取派发开始时定下的路径链，不受中途 DOM 变更影响；取不到路径才回落旧口径。
// 刻意不接入：通话半框 #chat-call-panel 与小游戏对局半框——它们外面就是聊天气泡，
// 长按气泡要弹的消息菜单一点就把通话关掉/把对局弃掉，代价大于便利（✕ 仍是显式出口）。
window.mochiSheetOutsideClose = function (panel, close) {
if (!panel || typeof close !== 'function') return;
let openedAt = 0;
try {
if (window.MutationObserver) new MutationObserver(() => { if (!panel.hidden) openedAt = Date.now(); })
.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
} catch (e) {}
document.addEventListener('click', (e) => {
if (panel.hidden) return;
if (Date.now() - openedAt < 400) return;
const t = e.target;
if (!t) return;
// #1207 判据④：路径取派发那一刻的 composedPath()，被点元素在同一记点击里被摘走也不算点外
const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
if (path && path.length) {
for (let i = 0; i < path.length; i++) {
const n = path[i];
if (n === panel || (n.nodeType === 1 && n.classList && n.classList.contains('modal-mask'))) return;
}
} else if (panel.contains(t) || (t.closest && t.closest('.modal-mask'))) return;
close();
});
};
[['chat-divine-panel', () => { if (chatDivinePanel) chatDivinePanel.hidden = true; }],
['chat-ask-panel', () => closeChatAskPanel()],
['chat-search', () => closeChatSearch()],
['chat-rps-panel', () => closeRpsPanel()],
['chat-rp-panel', () => closeRpPanel()]].forEach((s) => {
window.mochiSheetOutsideClose(document.getElementById(s[0]), s[1]);
});
// v3.26.x：聊天页半框「批量设置问卷」按钮 → 打开批量问卷页（收起聊天 app，返回时回到聊天）
const chatAskBulkBtn = document.getElementById('chat-ask-bulk');
if (chatAskBulkBtn) chatAskBulkBtn.addEventListener('click', (e) => {
	if (e) e.stopPropagation();
	closeChatAskPanel();
	if (window.openAskSurvey) window.openAskSurvey();
	else toast('批量问卷加载失败');
});
// v3.26.x：聊天页半框主输入框「一键清空 ✕」（同帮我决定 .dec-inp-clear 逻辑）
const chatAskClearBtn = document.querySelector('#chat-ask-panel .dec-inp-clear[data-clear="chat-ask-input"]');
if (chatAskClearBtn) chatAskClearBtn.addEventListener('click', (e) => {
	if (e) e.stopPropagation();
	if (!chatAskInput) return;
	const box = chatAskInput.__ceBox;
	if (box) box.textContent = '';
	else chatAskInput.value = '';
	chatAskInput.focus();
	toast('已清空');
});
const chatAskSaveBtn = document.getElementById('chat-ask-save');
if (chatAskSaveBtn) chatAskSaveBtn.addEventListener('click', (e) => { e.stopPropagation(); saveInviteInput(); });
if (chatAskInput) chatAskInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.stopPropagation(); submitChatAsk(); } });
const chatSearchEl = document.getElementById('chat-search');
const chatSearchInput = document.getElementById('chat-search-input');
const chatSearchGo = document.getElementById('chat-search-go');
const chatSearchResults = document.getElementById('chat-search-results');
const chatSearchNew = document.getElementById('chat-search-new');
const chatSearchDateFrom = document.getElementById('chat-search-date-from');
const chatSearchDateTo = document.getElementById('chat-search-date-to');
const chatSearchDateClear = document.getElementById('chat-search-date-clear');
function openChatSearch() {
if (!chatSearchEl) return;
loadMsgs();
chatSearchEl.hidden = false;
chatSearchInput.value = '';
if (chatSearchDateFrom) chatSearchDateFrom.value = '';
if (chatSearchDateTo) chatSearchDateTo.value = '';
chatSearchResults.innerHTML = '<div class="chat-search-empty">输入关键词，或选择日期范围搜索聊天记录</div>';
setTimeout(() => chatSearchInput.focus(), 60);
}
function closeChatSearch() {
if (chatSearchEl) chatSearchEl.hidden = true;
}
function searchDateToTs(ds, inclusiveEnd) {
if (!ds) return null;
const parts = String(ds).split('-').map(Number);
if (parts.length !== 3 || parts.some(isNaN)) return null;
const d = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
if (isNaN(d.getTime())) return null;
return d.getTime() + (inclusiveEnd ? 86400000 : 0);
}
function fmtSearchTime(ts) {
if (!ts) return '';
const d = new Date(ts);
const p = (n) => (n < 10 ? '0' + n : '' + n);
return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
// ===== FIX 2026-09-28 #1360 搜索的尺子＝「这一桌的全部记录」，不是「此刻内存里的那一段」
// 现场（OPPO K13 Turbo Pro／Edge 153 桌面 PWA 实报「在搜索聊天记录里搜也搜不出来」）：本函数
// 原来只扫内存 msgs。而 #722 分块桌面在用户上滑到头之前 msgs 只有末尾热片（更早的整段还在
// chat-blk-* 块里）、整包读不成的设备 msgs 只是 localStorage 那条有损尾巴——这些形态下消息
// **确实在库里**，却与「这条没说过」同形，界面上还写着「没有找到」。
// 判据只取两个当场事实：① 扫的对象＝全量口径（已取回的头部先并进内存再扫，用的就是「上滑到
// 头」那一路现成的 chatRebaseCold——并完窗口/DOM data-idx 一起位移，点结果照样跳得到）；
// ② 还没取回的那一截不谎称「没有」：如实说「还在取回」，取回后自动重搜一次。零机型／零 UA 分支。
function chatSearchSource() {
try { if (!chatRebased && chatColdHead.length) chatRebaseCold(); } catch (e) {}
const all = window.getChatMsgs ? window.getChatMsgs() : msgs;
return Array.isArray(all) ? all : msgs;
}
let chatSearchRetryT = null;
let chatSearchRetries = 0;
function runChatSearch() {
if (!chatSearchResults) return;
const q = (chatSearchInput.value || '').trim();
const fromTs = searchDateToTs(chatSearchDateFrom ? chatSearchDateFrom.value : '', false);
const toTs = searchDateToTs(chatSearchDateTo ? chatSearchDateTo.value : '', true);
const dateLabel = fromTs != null && toTs != null ? (chatSearchDateFrom.value + ' 至 ' + chatSearchDateTo.value) :
fromTs != null ? (chatSearchDateFrom.value + ' 起') :
toTs != null ? ('截至 ' + chatSearchDateTo.value) : '';
if (!q && fromTs == null && toTs == null) {
chatSearchResults.innerHTML = '<div class="chat-search-empty">输入关键词，或选择日期范围搜索聊天记录</div>';
return;
}
loadMsgs();
const partnerName = chatPartnerName();
const myName = chatUserName();
const results = [];
const src = chatSearchSource(); // #1360：全量口径（下面命中项的 i 就是这个数组的下标；rebase 之后它与 msgs 同一份）
src.forEach((m, i) => {
if (!m || m.special) return;
if (fromTs != null && (!m.ts || m.ts < fromTs)) return;
if (toTs != null && (!m.ts || m.ts >= toTs)) return;
let txt = typeof m.text === 'string' ? m.text : '';
if (m.askQuestion) txt += ' ' + m.askQuestion;
if (m.choiceQuestion) txt += ' ' + m.choiceQuestion;
if (m.curiousQuestion) txt += ' ' + m.curiousQuestion;
if (m.roastText) txt += ' ' + m.roastText;
if (q && txt.indexOf(q) < 0) return;
results.push({ i: i, m: m, txt: txt });
});
const esc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
if (!results.length) {
// #1360：库里还有没取回的那一截（权威没到手／冷头还没并进来／账本说有更多条）时，「没有找到」
// 是把「读不到」报成「没有」——正是用户报的「搜也搜不出来」。这句改口：如实说还在取回，并自动重搜。
let _ledN2 = 0;
try { _ledN2 = chatLedger[window.activePrefix()] || 0; } catch (e) {}
const awaitingMore = !chatAuthSettled() || !chatColdDone || _ledN2 > src.length;
if (awaitingMore && chatSearchRetries < 3) {
chatSearchRetries++;
try { chatColdEnsureHydrated(); } catch (e) {}
chatSearchResults.innerHTML = '<div class="chat-search-empty">更早的记录还在取回，取回后自动再搜一次…</div>';
if (chatSearchRetryT) clearTimeout(chatSearchRetryT);
chatSearchRetryT = setTimeout(function () {
chatSearchRetryT = null;
try { if (chatSearchEl && !chatSearchEl.hidden && chatSearchInput && chatSearchInput.value.trim() === q) runChatSearch(); } catch (e) {}
}, 2000);
return;
}
const emptyMsg = q ? ('没有找到包含「' + esc(q) + '」' + (dateLabel ? '（' + dateLabel + '）' : '') + '的消息') : (dateLabel ? dateLabel + ' 没有聊天记录' : '输入关键词，或选择日期范围搜索聊天记录');
chatSearchResults.innerHTML = '<div class="chat-search-empty">' + emptyMsg + '</div>';
return;
}
chatSearchRetries = 0;
const hl = (x) => esc(x).split(q).join('<span class="chat-search-hl">' + esc(q) + '</span>');
let head = '共 ' + results.length + ' 条 · 点击结果跳转到对应消息';
if (dateLabel) head = dateLabel + ' · 共 ' + results.length + ' 条 · 点击结果跳转';
let html = '<div style="font-size:11px;color:var(--muted);margin:6px 2px 10px">' + esc(head) + '</div>';
results.slice(0, 80).forEach(r => {
const isImg = chatIsInlineDataSrc(r.txt) || (window.mochiMediaIsToken && window.mochiMediaIsToken(r.txt)); // #148 令牌化图片消息搜索结果不直出令牌串；#948 内联载荷判定收口统一口径
// FIX 2026-09-10 #283 语音消息（名称|||data:audio/名称|||@@m:令牌）搜索结果显示「[语音] 名称」，
// 不直出整串音频数据/令牌
const isVc = typeof r.txt === 'string' && /\|\|\|(?:data:audio\/|@@m:[0-9a-f]{32})/.test(r.txt);
const label = isVc ? ('[语音] ' + r.txt.split('|||')[0]) : (isImg ? '[图片]' : (r.txt.length > 60 ? r.txt.slice(0, 60) + '…' : r.txt));
const who = r.m.side === 'out' ? myName : partnerName;
const time = r.m.ts ? fmtSearchTime(r.m.ts) : '';
html += '<div class="tc-listitem" data-sidx="' + r.i + '" data-smk="' + attrEsc(msgKeyOf(r.m)) + '"><div class="tc-li-top"><span class="tc-li-q">' + who + '：' + (isImg ? '[图片]' : (q ? hl(label) : esc(label))) + '</span><span class="tc-li-time">' + time + '</span></div></div>';
});
if (results.length > 80) html += '<div class="ta-empty">还有 ' + (results.length - 80) + ' 条…</div>';
chatSearchResults.innerHTML = html;
chatSearchResults.querySelectorAll('.tc-listitem').forEach(el => {
el.addEventListener('click', () => {
const idx = Number(el.dataset.sidx);
const jk = el.dataset.smk || ''; // #1491：跳转带身份锚（扫描与点击之间数组若又位移过＝按锚校正真下标）
closeChatSearch();
// FIX 2026-09-11 #331：搜索时输入框持有焦点＝软键盘展开，点结果先收键盘、等面板关闭/失焦落定再起跳（部分内核在 visualViewport 回弹窗口期会取消 smooth 滚动）
try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
requestAnimationFrame(() => requestAnimationFrame(() => {
if (!jumpToMsg(idx, jk)) body.scrollTop = body.scrollHeight; // #1491：带锚校正后仍找不到＝真的没有这一条，才回底
}));
});
});
}
const moreSearch = document.getElementById('more-search');
if (moreSearch) {
moreSearch.addEventListener('click', (e) => {
e.stopPropagation();
if (morePanel) morePanel.hidden = true;
const pc = document.getElementById('poke-card');
if (pc) pc.hidden = true;
const askP = document.getElementById('chat-ask-panel');
if (askP) closeChatAskPanel();
if (window.closeAvlib) window.closeAvlib();
openChatSearch();
});
}
if (chatSearchGo) chatSearchGo.addEventListener('click', (e) => { e.stopPropagation(); runChatSearch(); });
if (chatSearchInput) chatSearchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.stopPropagation(); runChatSearch(); } });
if (chatSearchDateFrom) chatSearchDateFrom.addEventListener('change', (e) => { e.stopPropagation(); runChatSearch(); });
if (chatSearchDateTo) chatSearchDateTo.addEventListener('change', (e) => { e.stopPropagation(); runChatSearch(); });
if (chatSearchDateClear) chatSearchDateClear.addEventListener('click', (e) => {
e.stopPropagation();
if (chatSearchDateFrom) chatSearchDateFrom.value = '';
if (chatSearchDateTo) chatSearchDateTo.value = '';
chatSearchResults.innerHTML = '<div class="chat-search-empty">输入关键词，或选择日期范围搜索聊天记录</div>';
chatSearchInput.focus();
});
const chatSearchClose = document.getElementById('chat-search-close');
if (chatSearchClose) chatSearchClose.addEventListener('click', (e) => { e.stopPropagation(); closeChatSearch(); });
if (chatSearchNew) chatSearchNew.addEventListener('click', (e) => {
e.stopPropagation();
closeChatSearch();
scrollChatBottom();
const last = body.lastElementChild;
if (last) {
try { last.scrollIntoView({ behavior: 'smooth', block: 'end' }); } catch (e2) { last.scrollIntoView(); }
}
});
const chatCallPanel = document.getElementById('chat-call-panel');
const chatCallClose = document.getElementById('chat-call-close');
const callPanelName = document.getElementById('call-panel-name');
const callPanelStatus = document.getElementById('call-panel-status');
const callPanelDial = document.getElementById('call-panel-dial');
const callPanelHang = document.getElementById('call-panel-hang');
let callPanelTimer = null;
function fmtCallDur(sec) {
if (isNaN(sec) || sec < 0) return '00:00';
const m = Math.floor(sec / 60), s = sec % 60;
return (m < 10 ? '0' + m : '' + m) + ':' + (s < 10 ? '0' + s : '' + s);
}
function updateCallPanel() {
if (!chatCallPanel || chatCallPanel.hidden) return;
const pName = chatPartnerName();
if (callPanelName) callPanelName.textContent = pName;
let st = null;
try { st = (window.getCallState && window.getCallState()) || null; } catch (err) { st = null; }
if (st && st.status !== 'ended') {
if (callPanelStatus) {
callPanelStatus.textContent =
st.status === 'connected' ? ('与 ' + (st.name || pName) + ' 通话中 · ' + fmtCallDur(st.durationSec)) :
st.status === 'ringing' ? ((st.name || pName) + ' 来电…') :
st.status === 'calling' ? ('正在呼叫 ' + (st.name || pName) + '…') : '通话中';
}
if (callPanelDial) callPanelDial.hidden = true;
if (callPanelHang) callPanelHang.hidden = false;
} else {
if (callPanelStatus) callPanelStatus.textContent = '空闲 · 点击拨打语音通话';
if (callPanelDial) callPanelDial.hidden = false;
if (callPanelHang) callPanelHang.hidden = true;
}
}
function openChatCall() {
if (!chatCallPanel) return;
const pc = document.getElementById('poke-card'); if (pc) pc.hidden = true;
const ep = document.getElementById('emoji-panel'); if (ep) ep.hidden = true;
const askP = document.getElementById('chat-ask-panel'); if (askP) closeChatAskPanel();
const cs = document.getElementById('chat-search'); if (cs) cs.hidden = true;
const dv = document.getElementById('chat-divine-panel'); if (dv) dv.hidden = true;
const rp = document.getElementById('chat-rps-panel'); if (rp) rp.hidden = true;
if (window.closeAvlib) window.closeAvlib();
chatCallPanel.hidden = false;
closeIme();
updateCallPanel();
clearInterval(callPanelTimer);
callPanelTimer = setInterval(updateCallPanel, 1000);
}
function closeChatCall() {
if (chatCallPanel) chatCallPanel.hidden = true;
clearInterval(callPanelTimer);
callPanelTimer = null;
}
const moreCall = document.getElementById('more-call');
// #641：通话设置页「打开通话半框」跨页直达入口（call.js 调用）
window.openChatCallPanel = openChatCall;
if (moreCall) {
moreCall.addEventListener('click', (e) => {
e.stopPropagation();
if (morePanel) morePanel.hidden = true;
openChatCall();
});
}
const morePong = document.getElementById('more-pong');
if (morePong) {
morePong.addEventListener('click', (e) => {
e.stopPropagation();
if (morePanel) morePanel.hidden = true;
const pc = document.getElementById('poke-card'); if (pc) pc.hidden = true;
const ep = document.getElementById('emoji-panel'); if (ep) ep.hidden = true;
const askP = document.getElementById('chat-ask-panel'); if (askP) closeChatAskPanel();
const cs = document.getElementById('chat-search'); if (cs) cs.hidden = true;
const dv = document.getElementById('chat-divine-panel'); if (dv) dv.hidden = true;
const dp = document.getElementById('chat-decision-panel'); if (dp) dp.hidden = true;
const rpsP = document.getElementById('chat-rps-panel'); if (rpsP) rpsP.hidden = true;
const rpP = document.getElementById('chat-rp-panel'); if (rpP) rpP.hidden = true;
const callP = document.getElementById('chat-call-panel'); if (callP) callP.hidden = true;
if (window.closeAvlib) window.closeAvlib();
if (window.openPongPanel) window.openPongPanel();
});
}
const moreSnake = document.getElementById('more-snake');
if (moreSnake) {
moreSnake.addEventListener('click', (e) => {
e.stopPropagation();
if (morePanel) morePanel.hidden = true;
if (window.openSnakePanel) window.openSnakePanel();
});
}
// v3.15.x：补接双人钓鱼入口（按钮/面板锚点早已存在，此前无绑定是死入口）
const moreFish = document.getElementById('more-fish');
if (moreFish) {
moreFish.addEventListener('click', (e) => {
e.stopPropagation();
if (morePanel) morePanel.hidden = true;
if (window.openFishPanel) window.openFishPanel();
});
}
var moreBrick = document.getElementById('more-brick');
if (moreBrick) {
  moreBrick.addEventListener('click', function (e) {
    e.stopPropagation();
    if (morePanel) morePanel.hidden = true;
    var pc = document.getElementById('poke-card'); if (pc) pc.hidden = true;
    var ep = document.getElementById('emoji-panel'); if (ep) ep.hidden = true;
    var askP = document.getElementById('chat-ask-panel'); if (askP) closeChatAskPanel();
    var cs = document.getElementById('chat-search'); if (cs) cs.hidden = true;
    var dv = document.getElementById('chat-divine-panel'); if (dv) dv.hidden = true;
    var dp = document.getElementById('chat-decision-panel'); if (dp) dp.hidden = true;
    var rpsP = document.getElementById('chat-rps-panel'); if (rpsP) rpsP.hidden = true;
    var rpP = document.getElementById('chat-rp-panel'); if (rpP) rpP.hidden = true;
    var callP = document.getElementById('chat-call-panel'); if (callP) callP.hidden = true;
    var snkP = document.getElementById('chat-snake-panel'); if (snkP) snkP.hidden = true;
    if (window.closePongPanel) window.closePongPanel();
    if (window.openBrickPanel) window.openBrickPanel();
  });
}
window.sendSnakeResult = function (d) {
if (!d) return;
addRec({ side: 'in', special: 'snake', nightAllow: true, rateAllow: true, snkResult: d.result, snkPLen: d.pLen, snkOLen: d.oLen, snkPFood: d.pFood, snkOFood: d.oFood, snkPScore: d.pScore, snkOScore: d.oScore, snkTime: d.time });
// v3.15.x 二调：奖励对齐红包金额体系——胜 80% ¥13.14 / 20% ¥52，平 ¥5.2（日封顶 ¥104）
// v3.16.x：贪吃蛇改为双方同步同额入账（不再只给赢家），记赚钱流水「贪吃蛇」
try {
const snkWinFen = Math.random() < 0.2 ? 5200 : 1314;
// FIX 2026-09-16：幸运日（游乐室）奖励 ×2，仍受日封顶约束
const snkMult = (window.arcadeMult && window.arcadeMult('snake')) || 1;
const real = rpGameCoinGrant('snake', (d.result === 'draw' ? 520 : snkWinFen) * snkMult, 10400);
if (real > 0) {
const w = rpWalletGet();
w.myBalance += real; w.systemBalance += real;
rpWalletSet(w);
try { if (window.giftCoinLedgerAdd) window.giftCoinLedgerAdd('earn', real, real, '贪吃蛇'); } catch (e2) {}
setTimeout(() => addIn('🪙 双方心意币各 +¥' + (real / 100).toFixed(2), { special: 'poke', nightAllow: true, rateAllow: true }), randInt(800, 1600));
}
} catch (e) {}
if (window.logFish) window.logFish();
showTyping();
setTimeout(() => {
hideTyping();
const grp = d.result === 'win' ? '游戏失败·回应' : d.result === 'lose' ? '游戏胜利·回应' : '游戏平局·回应';
const pool = window.getInteractPool ? window.getInteractPool(grp, ['再来一局？']) : ['再来一局？'];
const say = pool.length ? pool[Math.floor(Math.random() * pool.length)] : ''; // #1515 整组停用＝静默（不再回落未入库兜底句）
if (say) addRec({ side: 'in', text: say, nightAllow: true, rateAllow: true });
}, randInt(900, 1600));
};
if (chatCallClose) chatCallClose.addEventListener('click', (e) => { e.stopPropagation(); closeChatCall(); });
if (callPanelDial) callPanelDial.addEventListener('click', (e) => {
e.stopPropagation();
if (window.placeCall) window.placeCall();
else {
const name = chatPartnerName();
addRec({ side: 'out', text: '拨打 ' + name + ' 语音通话', special: 'call' });
if (window.logFish) window.logFish();
}
setTimeout(updateCallPanel, 120);
});
if (callPanelHang) callPanelHang.addEventListener('click', (e) => {
e.stopPropagation();
if (window.hangupCall) window.hangupCall();
setTimeout(updateCallPanel, 120);
});
document.addEventListener('contact-switched', function () {
try { closeChatCall(); } catch (e) {}
});
if (pokeClose) pokeClose.addEventListener('click', (e) => { e.stopPropagation(); closePokeCard(); });
// 冷启动回填预算把字卡库大键挂起在 IDB（__xyIdbDeferredKeys）时，聊天页表情包/拍一拍
// 面板会读成空库。这里在面板打开时按需取回（复用字卡库同一套 hydrateLibScopes），
// 完成后若面板仍打开则重绘——不启动自动拉取，遵守「用户正在看的场景才拉」红线。
function hydrateCcForChatPanels(done) {
try {
if (window.libScopesDeferred && window.hydrateLibScopes &&
window.libScopesDeferred(['public', 'own'])) {
try { toast('字卡较多，正在加载…'); } catch (e) {}
// FIX 2026-09-16 #575：取回期间给面板「加载占位」，不再让「暂无表情包／暂无拍一拍字卡」
//   空态挂着——iOS 挂后台杀 IDB 连接时这段要等 6~14s，空态会被用户当成「我的字卡丢了」
//   （#574 字卡库同族）。ccPanelsFetching 让 renderEmojiPanel/renderPokeCard 改出占位行；
//   done 回来（或取回失败）即清标记并重渲一次，占位行必被真实内容/真空态替换。
ccPanelsFetching = true;
window.hydrateLibScopes(['public', 'own'], function () {
ccPanelsFetching = false;
try { if (done) done(); } catch (e) {}
});
try { if (done) done(); } catch (e) {} // 立即重渲一次：把当前空态换成加载占位
return true;
}
} catch (e) {}
return false;
}
// #575：取回中的统一占位行（.mochi-load-row 见 chat-pages.css，与字卡库 #574 同观感）
var ccPanelsFetching = false; // var：避开「函数先于 let 执行」的 TDZ 风险（历史事故族）
var myeLoading = false;
function ccLoadRowHtml(txt) {
return '<div class="mochi-load-row"><span class="mochi-spin"></span>' + txt + '</div>';
}
function openPokeCard(fromGesture) {
if (!pokeCard) return;
pokeAdoptAllRerender(); // 慢 IDB（iOS 挂后台杀连接）下 restore-done 兜底可能落空，开面板再补一次
const ep = document.getElementById('emoji-panel');
if (ep) ep.hidden = true;
if (window.closeAvlib) window.closeAvlib();
// FIX #511：仅「手势开路」（点头像的 touch/pointer 路）才布闸——鼠标点击与菜单入口打开后
// 用户随后的点击是真实操作，不该被吞。面板渲染在 touchend 里同步发生，合成 click 紧随其后
// 到达，arm 必须在面板显示之前完成。
if (fromGesture) pokeArmClickGate();
pokeCard.hidden = false;
if (morePanel) morePanel.hidden = true;
closeIme(); // v3.5.116：收起输入法，面板不被键盘遮挡
// FIX #511：开面板不该带焦点——「我的拍一拍」tab 会显示输入行（poke-input-row），
// 手势泄漏的合成 click 一旦落到它上面就会唤起输入法，故此处主动失焦兜底。
if (pokeInput) { pokeInput.value = ''; try { pokeInput.blur(); } catch (e) {} }
try { const p = store.get('poke-tab'); if (p === 'mine') pokeMode = 'mine'; else if (p === 'ta') pokeMode = 'ta'; } catch (e) {}
try { const g = store.get('poke-group-' + pokeMode); if (typeof g === 'string' && g) pokeCurGroup = g; } catch (e) {}
renderPokeCard();
hydrateCcForChatPanels(() => { if (pokeCard && !pokeCard.hidden) renderPokeCard(); });
}
document.addEventListener('click', (e) => {
if (pokeCard && !pokeCard.hidden && !pokeCard.contains(e.target)) closePokeCard();
});
const msgActions = document.getElementById('msg-actions');
let activeMsgEl = null;   // 当前操作的消息 DOM
let activeMsgSnap = null; // FIX 2026-09-13 #407：菜单打开时的消息身份快照（防 msgs 重排后 data-idx 错位）
let activeSide = 'in';    // 当前操作消息方向
let lastQuote = null;     // 待引用内容
// FIX 2026-09-26 #1309c：收藏的整包写入要等「这一键的权威」回话（同一台小米 14U/Edge 还报
//   「之前的收藏也没了」）。这条连一次读故障都不需要：那台机的 localStorage 整层写不进
//   （诊断单实读整域 192 键 ≈10MB 全是同源兄弟站点占的、站内 0 键），xyStore.get 的三路回落
//   （内存→LS→null）就只剩内存一路；启动回填还没轮到 fav-msgs（库里 chat-msgs 实报 26.4MB）
//   时 store.get 读出的就是 null。旧 saveFav 把 null 当成「一条收藏都没有」，用户此刻点一次
//   收藏 → store.set → xyStore.set 当场 window.idbSet 落盘 → IDB 里全部旧收藏被这一条整包抹掉
//   （永久救不回；本批电池在纯 HEAD 产物上实测 2 条 → 1 条）。
//   判据只取「这一键回没回话」这一个内核事实：idbGet 的 info.ambiguous ＋ idbHasKey 三态
//   （同 #90 严格清单契约、#187 feed 写闸、#229 有界重试、#785 就绪三态），零机型／零 UA 分支。
//   按 cid 分开暂存并在权威回话后才并集落盘＝切桌面不把 A 桌面的收藏并进 B（同 mail v3.8.x
//   串桌面教训）；本地优先、库里其次＝保住 #456/iOS「IDB 落后不许把最新收藏回滚成旧快照」语义。
const favAuth = {};      // cid → 'pending'＝这一键权威未回话（写闸关着）／'ok'＝回过话或按旧语义放行
const favPending = {};   // cid → 权威回话前用户写进来的整包收藏（只在内存，绝不落盘）
// FIX 2026-09-27 #1330b（荣耀50se／雨见＋多机型复报「收藏几百条被突然清空」）：
//   #1309 那把闸只看「本次权威读回没回话」，回话之后本地那一包到底是什么没人核。
//   两条真实形态都不需要任何读故障：① 权威读还没落地，restore-done／45s 兜底先把
//   favDrainAll 的闸放掉，favDrain 拿到的 idbRaw 恒为 null ⇒ baseRaw 退成「本地快照」，
//   而本地快照在 LS 整域写满（这台实测 4127 键 ≈10.0MB＝Gecko 系单源配额）的机器上
//   就是最后一次**同步写成功**的旧包（诊断单同键两个读数 9.1KB／4.3KB＝两侧已经不一致）；
//   ② 15838 那条补灌刻意「只在本地无收藏时补」，于是「本地有但比库里少」这一格永不修复
//   ——用户视角就是收藏凭空少掉几百条，而下一次 saveFav 把这一包整份 idbSet 回库，
//   库里那份全量当场没了＝不可追回。两格同源：对收藏这种「读-改-写整包」的数据，
//   「本地读到 N 条」从来不等价于「库里只有 N 条」。
//   判据只取「两边各有多少条」这一个事实（与 #172 表情包那把「内容更多才覆盖」同尺），
//   零机型／零 UA 分支；本会话用户自己写过（含批量删除／主动清空＝verify-1309 C2 的契约）
//   即永不再补＝修的是「没读到当成没有」，不是「删掉的又活过来」。
const favAuthRaw = {};   // cid → 任何一路权威读回到的库里原值（drain 时不再抓 null）
const favTouched = {};   // cid → 本会话本地写过收藏，此后不再拿库里的更多条目补回
let favAuthTries = 0;
const FAV_AUTH_BACKOFF = [800, 2000, 5000, 12000, 25000];
function favCid() { return window.__activeCid || 'default'; }
function favHold(cid) { return favAuth[cid] === 'pending'; }
function favUnion(base, extra) {
  const seen = {};
  const out = [];
  [base || [], extra || []].forEach(function (arr) {
    if (!Array.isArray(arr)) return;
    arr.forEach(function (x) { if (!x) return; const k = favItemKey(x); if (seen[k]) return; seen[k] = 1; out.push(x); });
  });
  return out;
}
function favCountOf(raw) {
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.length : -1; } catch (e) { return -1; }
}
// 库里这一包比本地多 ⇒ 本地是残缺快照：按 favItemKey 并集落盘（条目只增不减、幂等），
// 并完确实更多才写（本地已最新＝零写入零抖动）。主动写过收藏的桌面永不补＝C2 契约。
function favAdoptRicher(cid, idbRaw) {
  if (favTouched[cid] || !idbRaw || idbRaw.length <= 2) return false;
  try {
    const cs = cid === favCid() ? store : (window.storeFor ? window.storeFor(cid) : store);
    let localRaw = null;
    try { localRaw = cs.get('fav-msgs'); } catch (e) { return false; }
    const ii = favCountOf(idbRaw);
    let li = -1;
    try { li = localRaw ? favCountOf(localRaw) : -1; } catch (e) { return false; }
    if (ii < 0 || (li >= 0 && ii <= li)) return false;
    let ia = null, la = [];
    try { ia = JSON.parse(idbRaw); } catch (e) { return false; }
    try { la = localRaw ? (JSON.parse(localRaw) || []) : []; } catch (e) { la = []; }
    cs.set('fav-msgs', JSON.stringify(favUnion(Array.isArray(ia) ? ia : [], Array.isArray(la) ? la : [])));
    try { if (window.__mochiPhase) window.__mochiPhase('fav-adopt:' + ii); } catch (e) {}
    return true;
  } catch (e) { return false; }
}
function favDrain(cid, idbRaw) {
  const pend = favPending[cid];
  if (!pend) return;
  delete favPending[cid];
  if (!pend.length) return;
  try {
    const cs = cid === favCid() ? store : (window.storeFor ? window.storeFor(cid) : store);
    let localRaw = null;
    try { localRaw = cs.get('fav-msgs'); } catch (e) {}
    // #1330b：库里那一包只要回过话就用回过的，不再拿 null 当「库里没有」
    // 基包取「本地 ∪ 库里」而不是「本地优先」：pend 是用户在自己**看得见**的那包上改出来
    // 的，库里多出来的条目此刻根本没上过屏＝本会话不可能删过它，并进基包不会复活用户删掉
    // 的东西（同 #172 表情包保存闸门那把「取回全量与内存新增按分组去重合并」的尺子）。
    const raw = idbRaw || favAuthRaw[cid] || null;
    let cur = [], curLib = [];
    try { cur = (localRaw && localRaw.length > 2) ? JSON.parse(localRaw) : []; } catch (e) { cur = []; }
    try { curLib = (raw && raw.length > 2) ? JSON.parse(raw) : []; } catch (e) { curLib = []; }
    if (!Array.isArray(cur)) cur = [];
    if (!Array.isArray(curLib)) curLib = [];
    cs.set('fav-msgs', JSON.stringify(favUnion(favUnion(cur, curLib), pend)));
    // 只有「带权威基包落过盘」的这一发才算用户写过＝此后不再拿库里的更多条目补回；
    // blind（库里从没回过话）那一放本身就是一次读故障，留待迟到回话时再修（#1330b）
    if (raw) favTouched[cid] = true;
    try { scheduleFavImgPass(2500); } catch (e) {}
  } catch (e) {}
}
function favSeal(cid, idbRaw) {
  if (typeof idbRaw === 'string' && idbRaw.length > 2) favAuthRaw[cid] = idbRaw;
  favAuth[cid] = 'ok';
  favAdoptRicher(cid, favAuthRaw[cid] || null);
  favDrain(cid, favAuthRaw[cid] || null);
}
function favDrainAll() { Object.keys(favPending).forEach(function (c) { favAuth[c] = 'ok'; favDrain(c, favAuthRaw[c] || null); }); }
// 权威回话登记：v＝库里这一键的原值；info.ambiguous＝这一发没读到（≠库里没有）
function favNoteAuth(v, info) {
  const cid = favCid();
  if (typeof v === 'string' && v.length > 2) favAuthRaw[cid] = v;
  if (info && info.ambiguous) {
    if (!window.idbHasKey) { favAuthDelay(); return; }
    const myPrefix = window.activePrefix();
    try {
      window.idbHasKey(myPrefix + ':fav-msgs').then(function (exists) {
        if (window.activePrefix() !== myPrefix) return;
        if (exists === false) { favSeal(cid, null); return; } // 库里确无此键（新装）＝开门，第一收藏直接落盘
        favAuthDelay(); // 库里「有」这一键却读不回值：关着闸重试，绝不整包覆盖
      });
    } catch (e) { favAuthDelay(); }
    return;
  }
  favSeal(cid, typeof v === 'string' ? v : null);
}
function favAskAuth() {
  const cid = favCid();
  const myPrefix = window.activePrefix();
  favAuth[cid] = 'pending';
  if (!window.idbGet) { favSeal(cid, null); return; }
  const info = {};
  try {
    Promise.resolve(window.idbGet(myPrefix + ':fav-msgs', info)).then(function (v) {
      if (window.activePrefix() !== myPrefix) return; // 已切走：新桌面自己会重新发起
      favNoteAuth(v, info);
    }, function () { if (window.activePrefix() === myPrefix) favAuthDelay(); });
  } catch (e) { favSeal(cid, null); }
}
function favAuthDelay() {
  if (favAuthTries >= FAV_AUTH_BACKOFF.length) {
    // 有界重试耗尽＝这一会话读不回来了：按旧语义放行（宁可退回旧行为，也不把用户新收藏永久卡在内存）
    Object.keys(favAuth).forEach(function (c) { favAuth[c] = 'ok'; });
    favDrainAll();
    return;
  }
  const wait = FAV_AUTH_BACKOFF[favAuthTries++];
  try { if (window.__mochiPhase) window.__mochiPhase('fav-auth-retry:' + favAuthTries); } catch (e) {}
  setTimeout(favAskAuth, wait);
}
favAuth[favCid()] = 'pending';
if (!window.idbGet) favAuth[favCid()] = 'ok';
document.addEventListener('contact-switched', function () {
  // 回填还没跑完就切了桌面：新桌面同样先发权威读再开门；已就绪时不发这一读（稳态零额外开销）
  if (!window.__mochiDataReady) { try { favAskAuth(); } catch (e) {} }
});
if (window.mochiOnDataReady) window.mochiOnDataReady(favDrainAll);
else document.addEventListener('mochi-restore-done', favDrainAll);
setTimeout(favDrainAll, 45000); // 兜底：restore-done 与权威回话都到不了（IDB 彻底不可用）时按旧语义落盘
function getFav() {
  try {
    const base = JSON.parse(store.get('fav-msgs') || '[]');
    const cid = favCid();
    if (favHold(cid) && favPending[cid]) return favUnion(base, favPending[cid]);
    return base;
  } catch (e) { return []; }
}
function saveFav(list) {
  const cid = favCid();
  if (favHold(cid)) {
    // 权威没回话：只暂存内存，绝不 store.set——xyStore.set 会当场 window.idbSet 把整包覆盖进 IDB
    try { favPending[cid] = (list || []).slice(); } catch (e) {}
    try { if (window.__mochiPhase) window.__mochiPhase('fav-hold:' + ((list || []).length)); } catch (e) {}
    return;
  }
  // FIX 2026-09-28 #1361g/h：#1309/#1330 那把 favAuth 闸只问「本次权威读回没回话」；回过话之后
  // 这一格的同步读数还能再变空——收藏包跨过 200KB 就是 IDB-only（LS 那份被主动剥掉），切一次后台
  // #1195e 放掉内存副本、或页面被回收后启动回填还没轮到这一格，getFav() 拿到的都是「读空」。
  // 而小收藏包（被 #139/#142 压缩令牌化压回 200KB 以下）在「回填整轮 bail out」那一型里同样读空，
  // 大键那三格证据谁都看不见它 ⇒ 本条认的是「这一发读空了没有」：读数非空照旧直接落笔，读空就不许
  // 拿它当全量。旧写法直接整包写回＝库里几百条被这一发顶掉＝用户报的「收藏莫名其妙消失」（TA 自动
  // 收藏我发的动态／卡片时根本没有用户动作＝「莫名其妙」）。这里不新造暂存：退回本模块已有的
  // favPending 那一路，并补发一次权威问话（favAskAuth→favSeal→favDrain 按 favItemKey 并集落盘＝
  // 库里确认没有（'absent'→raw 为空）时那一发照样落地，不把闸门变成「存不进去」）。零机型／零 UA。
  if (store.get('fav-msgs') === null || window.xyBigWriteHold(store, 'fav-msgs')) {
    try { if (window.xyPackageEmptyRead(store, 'fav-msgs')) { try { if (store.requestBigKey) store.requestBigKey('fav-msgs'); } catch (e5) {} } } catch (e6) {}
    try { favPending[cid] = (list || []).slice(); } catch (e0) {}
    try { if (window.__mochiPhase) window.__mochiPhase('fav-blind-hold:' + ((list || []).length)); } catch (e1) {}
    favAuth[cid] = 'pending';
    setTimeout(favAskAuth, 1500);
    return;
  }
  favTouched[cid] = true; // #1330b：闸已开＝这一发是用户在自己看得见的列表上写的，此后不再补
  store.set('fav-msgs', JSON.stringify(list));
  try { scheduleFavImgPass(2500); } catch (e) {}
}
// v3.31.x #314 批量管理勾选身份：收藏无稳定 id，用「归属+类型+内容+时间戳」指纹做 key
// （与 favDup 判重同源）——getFav() 每次返回新解析的全新对象，按对象引用勾选会在
// renderFav 重渲染（点全选/切分类/切页签都触发）后全部失配，勾选静默清零＝多选失效
//（全机型复现，与设备无关）。key 里不含大载荷（text/parts 截断），只作会话内身份比对。
function favItemKey(f) {
  return (f.by || 'me') + '|' + (f.kind || 'msg') + '|' + (f.ts || 0) + '|' +
    String(f.q || '').slice(0, 120) + '|' + String(f.text || '').slice(0, 120) + '|' +
    (f.special || '') + '|' + (f.mailType || '') + '|' + ((f.side === 'out') ? 'o' : 'i');
}
// ===== v3.26.x #139：收藏图片压缩 =====
// 收藏把消息 parts / 图片 dataURL 原样整份进库，与聊天记录重复存同一批图（诊断实证
// fav-msgs 全桌面 ≈21MB）。压缩走「读-压缩-写前 CAS 比对」：压缩期间任何其他写入
// （再收藏/删除/换桌面）都会使快照失效并重排，绝不覆盖新数据，绝不丢收藏。
// 规则（宁可不压，不可压坏）：只压 data:image/*（GIF 保动画、SVG 矢量、<4KB 小图跳过）；
// 480px 上限（气泡显示宽度内）；优先 WebP（iOS canvas 不支持会回退返回 PNG，前缀检测后
// 改试 JPEG 白底）；结果必须比原图更小才采用；单张失败只影响该张，整批异常放弃本轮。
function compressFavDataUrl(src) {
return new Promise((resolve) => {
try {
if (typeof src !== 'string' || src.indexOf('data:image/') !== 0 || src.length < 4096) { resolve(null); return; }
if (/^data:image\/(gif|svg)/i.test(src)) { resolve(null); return; }
const img = new Image();
img.onload = () => {
try {
const scale = Math.min(1, 480 / Math.max(img.width, img.height));
const w = Math.max(1, Math.round(img.width * scale));
const h = Math.max(1, Math.round(img.height * scale));
const c = document.createElement('canvas');
c.width = w; c.height = h;
const ctx = c.getContext('2d');
ctx.drawImage(img, 0, 0, w, h);
let out = c.toDataURL('image/webp', 0.82);
if (out.indexOf('data:image/webp') !== 0) {
ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
ctx.drawImage(img, 0, 0, w, h);
out = c.toDataURL('image/jpeg', 0.82);
}
resolve(out.length < src.length ? out : null);
} catch (e) { resolve(null); }
};
img.onerror = () => resolve(null);
img.src = src;
} catch (e) { resolve(null); }
});
}
async function compressFavListImages(list) {
let changed = false;
const out = new Array(list.length);
for (let i = 0; i < list.length; i++) {
let f = list[i];
try {
if (f && typeof f.text === 'string' && f.text.indexOf('data:image/') === 0) {
const v = await compressFavDataUrl(f.text);
if (v) { f = Object.assign({}, f, { text: v }); changed = true; }
}
if (f && Array.isArray(f.parts) && f.parts.length) {
const parts = new Array(f.parts.length);
let pChanged = false;
for (let j = 0; j < f.parts.length; j++) {
const p = f.parts[j];
let np = p;
if (p && typeof p.v === 'string' && p.v.indexOf('data:image/') === 0) {
const v = await compressFavDataUrl(p.v);
if (v) { np = Object.assign({}, p, { v: v }); pChanged = true; }
}
parts[j] = np;
}
if (pChanged) { f = Object.assign({}, f, { parts: parts }); changed = true; }
}
} catch (e) {}
out[i] = f;
}
return changed ? out : null;
}
// #142：收藏图片令牌化——压缩后把 data:image 替换为媒体池引用（与聊天记录同一池，
// 同一张图聊天/收藏只存一份）。池落盘先于收藏落盘（mochiMediaFlush）。
async function tokenizeFavList(list) {
if (!window.mochiMediaTokenize) return null;
let changed = false;
const out = new Array(list.length);
for (let i = 0; i < list.length; i++) {
let f = list[i];
try {
if (f && typeof f.text === 'string' && f.text.indexOf('data:image/') === 0) {
const t = await window.mochiMediaTokenize(f.text);
if (t) { f = Object.assign({}, f, { text: t }); changed = true; }
}
// FIX 2026-09-10 #283 收藏语音令牌化：刚收藏的语音（池 pass 1.5s 延迟窗口内落库）与
// 历史收藏仍整份 data:audio 内联，这里与聊天记录同池收口（播放链路 fillVoiceBubble 已支持令牌）
if (f && typeof f.text === 'string' && f.text.length > 1024) {
const _bi = f.text.indexOf('|||');
if (_bi > 0 && f.text.indexOf('data:audio/', _bi + 3) === _bi + 3) {
const t = await window.mochiMediaTokenize(f.text.slice(_bi + 3));
if (t) { f = Object.assign({}, f, { text: f.text.slice(0, _bi + 3) + t }); changed = true; }
}
}
if (f && Array.isArray(f.parts) && f.parts.length) {
const parts = new Array(f.parts.length);
let pChanged = false;
for (let j = 0; j < f.parts.length; j++) {
const p = f.parts[j];
let np = p;
if (p && typeof p.v === 'string' && p.v.indexOf('data:image/') === 0) {
const t = await window.mochiMediaTokenize(p.v);
if (t) { np = Object.assign({}, p, { v: t }); pChanged = true; }
}
parts[j] = np;
}
if (pChanged) { f = Object.assign({}, f, { parts: parts }); changed = true; }
}
} catch (e) {}
out[i] = f;
}
return changed ? out : null;
}
let _favImgPassT = null, _favImgPassRetries = 0;
function scheduleFavImgPass(delay) {
clearTimeout(_favImgPassT);
_favImgPassT = setTimeout(favImgPass, delay || 3000);
}
// 返回 true=完整跑完一轮（无论是否压缩了内容）；false=期间有并发写入被 CAS 打断（已自动重排）
async function favImgPass() {
try {
const rawSnap = store.get('fav-msgs');
if (!rawSnap || rawSnap.length < 4096) return true;
let list;
try { list = JSON.parse(rawSnap); } catch (e) { return true; }
if (!Array.isArray(list)) return true;
const compressed = await compressFavListImages(list);
const tokened = await tokenizeFavList(compressed || list);
if (!compressed && !tokened) return true;
const out = tokened || compressed;
const _favPoolOk = await window.mochiMediaFlush(); // #142：池数据先落盘，收藏里的令牌才有据可查
// FIX 2026-09-22 #1038 写盘失败闸门（同聊天 normalize #186 / 字卡库令牌化 #554 口径）：mochiMediaFlush 返回 false＝池值没落进 IDB（idbSetAll 超时/连接丢失回队，#226/#665a）；旧实现忽略返回值照写令牌收藏＝「令牌入库而池缺数据」＝收藏图片丢失。没落盘则本批作废、排程重试、保留内联原图。
if (_favPoolOk !== true) { scheduleFavImgPass(8000); return false; }
const rawNow = store.get('fav-msgs');
if (rawNow !== rawSnap) {
// 压缩期间收藏被写过——以最新数据重排（最多 5 次，防极端高频写入空转）
if (++_favImgPassRetries < 5) { scheduleFavImgPass(5000); return false; }
return true;
}
_favImgPassRetries = 0;
store.set('fav-msgs', JSON.stringify(out));
return true;
} catch (e) { return true; }
}
// 存量一次性迁移：本桌面没跑过压缩/令牌化扫描才执行（新收藏由 saveFav 钩子触发增量处理）
function favImgMigrateIfNeed() {
try { if (store.get('fav-img-cmp-v1') === '1' && store.get('fav-media-v1') === '1') return; } catch (e) {}
favImgPass().then(function (settled) {
if (settled) { try { store.set('fav-img-cmp-v1', '1'); store.set('fav-media-v1', '1'); } catch (e) {} }
});
}
window.favImgPassNow = favImgPass; // 可测性/诊断钩子（verify-media-pool 用）
document.addEventListener('mochi-restore-done', function () { setTimeout(favImgMigrateIfNeed, 12000); });
document.addEventListener('contact-switched', function () { setTimeout(favImgMigrateIfNeed, 12000); });
function syncFavMsgText(oldText, newText) {
if (oldText === newText) return;
const fav = getFav();
let changed = false;
fav.forEach(f => {
if ((f.kind || 'msg') === 'msg' && f.side === 'out' && f.text === oldText) {
f.text = newText;
f.type = 'text';
changed = true;
}
});
if (changed) saveFav(fav);
}
function favDup(list, f, by) {
// v3.26.x：按归属判重——「我的收藏」与「联系人的收藏」是两个独立 tab，
// TA 自动收藏的副本不应挡住用户收藏同一内容（反之亦然）
return list.some(x => (x.by || 'me') === by && (x.kind || 'msg') === (f.kind || 'msg') &&
(x.q || '') === (f.q || '') && (x.text || '') === (f.text || '') && x.ts === f.ts);
}
window.addMyFavItem = function (f) {
const fav = getFav();
if (favDup(fav, f, 'me')) return false;
fav.push(Object.assign({ by: 'me' }, f));
saveFav(fav);
return true;
};
window.addTaFavItem = function (f) {
const fav = getFav();
if (favDup(fav, f, 'ta')) return false;
fav.push(Object.assign({ by: 'ta' }, f));
saveFav(fav);
return true;
};
function cardSnapshot(rec) {
if (!rec) return null;
let q = '', mine = '', ta = '', special = rec.special;
// FIX 2026-09-17 #648 收藏快照的 TA 回应同样清洗——收藏页/引用预览不再直出存量令牌串
if (special === 'ask-choose') { q = rec.choiceQuestion || rec.text || ''; mine = rec.choiceAnswer || ''; ta = askCardReplyClean(rec.choiceReply || ''); }
else if (special === 'ask-curious') { q = rec.curiousQuestion || rec.text || ''; mine = rec.curiousAnswer || ''; ta = askCardReplyClean(rec.curiousReply || ''); }
else if (special === 'ask-roast') { q = rec.roastText || rec.text || ''; mine = rec.roastAnswer || ''; ta = askCardReplyClean(rec.roastReply || ''); }
else if (special === 'ask-card') { q = rec.askQuestion || rec.text || ''; mine = rec.askAnswer || ''; ta = askCardReplyClean(rec.askReply || ''); }
else if (special === 'invite') { q = rec.inviteContent || ''; ta = askCardReplyClean(rec.inviteAnswer || ''); }
// v3.28.x 修复：以下卡片在 renderMsg 都渲染了收藏心形（favHeartHtml），但 cardSnapshot
// 未覆盖 → 点收藏静默无效（无 toast、不进收藏夹）。补齐快照，收藏夹按通用卡渲染。
else if (special === 'ask') { q = rec.askQuestion || rec.text || ''; mine = rec.askAnswer || ''; ta = askCardReplyClean(rec.askReply || ''); }
else if (special === 'redpacket') { mine = (rec.side === 'out' ? '我发出' : chatPartnerName() + '发出'); q = '红包 ¥' + Number(rec.rpAmount || 0).toFixed(2) + (rec.rpWish ? ' · ' + rec.rpWish : ''); }
else if (special === 'flower') { q = (rec.flName || '花') + (rec.flWish ? '：' + rec.flWish : ''); }
else if (special === 'gift') { q = (rec.giftName || '礼物') + (rec.giftWish ? '：“' + rec.giftWish + '”' : '') + (rec.giftPrice != null ? ' · ¥' + Number(rec.giftPrice || 0).toFixed(2) : ''); }
else if (special === 'dish') { q = (rec.dishName || '菜肴') + (rec.dishWish ? '：“' + rec.dishWish + '”' : '') + (rec.dishPrice != null ? ' · ¥' + Number(rec.dishPrice || 0).toFixed(2) : ''); }
// #660：TA 的心愿卡——补齐快照，收藏心形才不是「点了没反应」（同上面 #v3.28.x 那批的口径）
else if (special === 'wish') { q = (rec.wishGiftName || '礼物') + '（' + chatPartnerName() + '的心愿）' + (rec.wishGiftPrice != null ? ' · ¥' + Number(rec.wishGiftPrice || 0).toFixed(2) : ''); }
// #713 批量问卷整卡收藏快照：题目列表（qarr）与 TA 作答（aarr）随卡入库，收藏页按问卷卡重放；
// 题干/选项/答案各自截断，防大问卷把收藏键撑爆
else if (special === 'ask-survey') {
const sqs = Array.isArray(rec.surveyQs) ? rec.surveyQs : [];
const sans = Array.isArray(rec.surveyAnswers) ? rec.surveyAnswers : [];
const qarr = sqs.slice(0, 99).map(sq => {
const it = { t: String((sq && sq.text) || '').slice(0, 120) };
if (sq && Array.isArray(sq.options) && sq.options.length) it.o = sq.options.slice(0, 12).map(o => String(o).slice(0, 60));
return it;
});
q = '问卷 · ' + sqs.length + ' 题' + (qarr.length && qarr[0].t ? '：' + qarr[0].t : '');
return { kind: 'card', special: special, q: q, mine: '', ta: '', ts: rec.ts || Date.now(),
qarr: qarr, aarr: sans.slice(0, 99).map(a => String(a || '').slice(0, 300)) };
}
else return null;
return { kind: 'card', special: special, q: q, mine: mine, ta: ta, ts: rec.ts || Date.now() };
}
window.favCardFromMsg = function (idx) {
const rec = msgs[idx];
if (!rec) return;
const f = cardSnapshot(rec);
if (!f) return;
if (window.addMyFavItem(f)) toast('已收藏互动卡片');
else toast('已收藏过这张卡片');
};
// #1005 收藏心形一律默认隐藏、点卡片浮现（.show-fav，见 body click 里各卡片分支）：#713 当年
// 给问卷卡加的 always=true 常显按钮被用户点名「卡片直接显示了收藏的按钮」，现收回成与单题卡
// 同一套机制（问卷卡的浮现分支在 surveyCard 那里）。
function favHeartHtml(rec) {
const heart = '<button class="msg-fav-heart" title="收藏整张互动卡片"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>收藏</button>';
let time = '';
if (rec && rec.ts) {
const who = rec.side === 'out' ? chatUserName() : chatPartnerName();
time = '<div class="msg-fav-time">' + escTxt(who) + ' ' + fmtTime(rec.ts) + ' 发送</div>';
}
return heart + time;
}
function taFavCard(rec) {
const _favProbCard = (window.favCfg ? window.favCfg().taCard : 30);
if (!rec || Math.random() * 100 >= _favProbCard) return;
const f = cardSnapshot(rec);
if (!f) return;
if (window.addTaFavItem(f)) setTimeout(() => toast('TA 收藏了你们的互动卡片'), 1200);
}
function closeMsgActions() {
if (msgActions && typeof msgActions.__maFollowStop === 'function') { try { msgActions.__maFollowStop(); } catch (e) {} } // FIX 2026-09-16 #642 摘跟随监听
if (msgActions) msgActions.hidden = true;
activeMsgEl = null;
activeMsgSnap = null; // FIX 2026-09-13 #407 随菜单关闭清身份快照
}
function quoteTextOf(m) {
// #148：图片载荷判定加媒体池令牌（@@m:hash）——令牌化后的图片消息引用不出缩略图、
// 令牌串被当引用文本存进 quote，渲染端 data: 过滤再把缩略图整段丢掉
const isMedia = (s) => typeof s === 'string' && (chatIsInlineDataSrc(s) || /^https?:\/\//i.test(s) || (window.mochiMediaIsToken && window.mochiMediaIsToken(s))); // FIX #948 内联载荷判定收口到统一口径（大小写/前导空白不敏感）
const qi = (m.parts || []).filter(p => p.k === 'img').map(p => p.v).slice(0, 3);
if (!qi.length && (m.type === 'sticker' || m.type === 'image')
&& isMedia(m.text)) {
qi.push(m.text);
}
let qt = m.text;
if (m.type === 'voice') qt = '[语音] ' + String(qt || '').split('|||')[0];
else if (m.type === 'sticker') qt = '表情包';
else if (qi.length && isMedia(String(qt || ''))) qt = '图片';
// 兜底：type 仍是 text 却夹带 |||data: 载荷的记录（导入的字卡音频/历史数据）
else if (typeof qt === 'string' && qt.indexOf('|||') > 0 && qt.indexOf('data:') > 0) qt = qt.split('|||')[0];
return { text: qt, imgs: qi };
}
function quoteSnapOf(m) {
const q = quoteTextOf(m);
return q.imgs.length ? { t: q.text, imgs: q.imgs } : q.text;
}
function quoteEq(a, b) {
if (a === b) return true;
if (a && b && typeof a === 'object' && typeof b === 'object') return (a.t || '') === (b.t || '') && (a.imgs || []).join() === (b.imgs || []).join();
return false;
}
function resolveQuoteTarget(selfIdx) {
const rec = msgs[selfIdx];
if (!rec || !rec.quote) return -1;
const qs = rec.qside || 'out';
if (typeof rec.qidx === 'number' && rec.qidx >= 0 && rec.qidx < selfIdx) {
const t = msgs[rec.qidx];
// FIX 2026-09-30 #1491：qidx 是「按下引用那会儿的数组坐标」落库的，而数组会在屏外整体位移
//   （chatRebaseCold 并冷头＝全体 +n；权威合并／尾巴回放的中段插删同理）。旧快路径只比 side ⇒
//   位移后 qidx 命中同侧的别条消息，判据全过、画面跳到八竿子打不着的一条＝作者实报「点击引用的
//   消息有一部分无法到达原位置」。快路径必须把引用快照一起核掉，不符就交给下面的内容扫描。
//   零机型／零 UA 分支：只问「这一格是不是那条」。
if (t && !t.retracted && t.side === qs && quoteEq(rec.quote, quoteSnapOf(t))) return rec.qidx;
}
for (let i = selfIdx - 1; i >= 0; i--) {
const m = msgs[i];
if (!m || m.retracted || m.side !== qs) continue;
if (quoteEq(rec.quote, quoteSnapOf(m))) return i;
}
return -1;
}
// FIX 2026-09-30 #1491：内容扫描只看得见内存这一段；冷头还没取回时「找不到」＝「读不到」，不是
//   「那条没说过」。判据取两个当场事实（与 #1360 搜索那一路同口径）：头块尚未全部取回、或条数账本
//   比内存多。零机型／零 UA 分支。
function quoteScanOpen() {
try {
if (!chatRebased && chatColdHead.length) return false; // 已取回未并入＝并完就有答案，不算没取回
if (!chatColdDone) return true;
const led = chatLedger[window.activePrefix()] || 0;
return led > msgs.length;
} catch (e) { return false; }
}
function jumpToMsg(idx, key) {
// FIX 2026-09-30 #1491：下标→节点这一跳也认身份锚（#1477 红包那条链已证同一族：坐标会过期）。
//   解析完到真跳之间数组若又并过冷头／回放过，data-idx 指向的可能是别条记录＝「跳到了但不是那条」。
//   带 key 时先核数组那一头，不符按锚反查真下标；再核节点画的那一头（data-mk＝渲染期身份锚 #491），
//   不符＝屏上这一段落后于数据，原地重画一次当前窗口后按新下标再取。反查也无＝保守回退旧下标语义。
if (key) {
const at = (idx >= 0 && idx < msgs.length) ? msgs[idx] : null;
if (!at || msgKeyOf(at) !== key) {
let found = -1;
for (let i = 0; i < msgs.length; i++) { if (msgs[i] && msgKeyOf(msgs[i]) === key) { found = i; break; } }
if (found >= 0) idx = found;
}
}
let target = body.querySelector('.msg[data-idx="' + idx + '"]');
if (key && target && target.dataset.mk && target.dataset.mk !== msgKeyOf(msgs[idx])) {
try { renderWindow(true, false); } catch (e) {}
target = body.querySelector('.msg[data-idx="' + idx + '"]');
}
if (!target) {
if (idx < renderStart) {
renderStart = Math.max(0, idx - JUMP_VIEW);
renderWindow(true, false);
} else if (idx >= renderEnd && idx < msgs.length) {
// #268：目标落在裁剪区（窗口下界之外，常见于用户上翻裁剪后搜索老/新消息）。
// 向下增量展开到包含目标（内部按 LOAD_STEP 分批，循环补够）。增量会触发
// pruneWindowTop 顶上裁剪，只要目标位于展开后窗口内即可居中定位。
const limit = msgs.length;
while (renderEnd <= idx && renderEnd < limit) {
loadNewerIncremental(Math.min(idx + JUMP_VIEW + 1, limit));
}
}
target = body.querySelector('.msg[data-idx="' + idx + '"]');
}
if (!target) return false;
unpinChatAndAnchor(); // FIX 2026-09-11 #334：跳转=用户定位历史浏览，与手动上翻同权解除贴底钉住——钉住态下旧区 lazy 图 onload 触发 #162 图片补滚把视图拽回底部，搜索/引用跳转表现「点了没反应」
try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { target.scrollIntoView(); }
target.classList.add('highlight');
setTimeout(() => target.classList.remove('highlight'), 2200);
return true;
}
if (body) {
body.addEventListener('click', (e) => {
const qb = e.target.closest('.msg-quote');
if (!qb) return;
const item = qb.closest('.msg');
if (!item || item.dataset.idx === undefined) return;
// FIX 2026-09-30 #1491：目标可能住在「已取回但还没并入内存的冷头」里（记录确实在、往上翻就看到）。
//   先按 #1360 搜索那一路的现成口径并入（chatRebaseCold 同步搬窗口与 DOM 的 data-idx，被点的 item 也跟着搬，
//   所以并完必须重新读 item.dataset.idx），再解析。作者实报「显示未找到原消息，但上翻其实原消息是在的」＝
//   旧写法只扫内存这一截。零机型／零 UA 分支。
if (!chatRebased && chatColdHead.length) { try { chatRebaseCold(); } catch (err) {} }
const qIdxNow = Number(item.dataset.idx);
const qRec = msgs[qIdxNow];
const qTarget = resolveQuoteTarget(qIdxNow);
if (qTarget >= 0 && jumpToMsg(qTarget, qTarget < msgs.length && msgs[qTarget] ? msgKeyOf(msgs[qTarget]) : '')) return;
// 跳不到＝「读不到」还是「没有」两句分开说（#1360 同口径），不再一律「未找到原消息」
if (qTarget < 0 && quoteScanOpen() && qRec && !qRec._quoteHunted) {
try { if (qRec) qRec._quoteHunted = 1; } catch (e) {}
try { chatColdEnsureHydrated(); } catch (e) {}
toast('更早的记录还在取回，取回后再点一次');
return;
}
toast('未找到原消息');
});
}
if (body) {
// v3.26.x：消息操作菜单（引用/收藏/撤回/编辑/删除）支持「长按 + 轻点」双手势。
// 长按气泡弹出菜单，松开时抑制随之而来的轻点，避免菜单被立刻关闭；统一复用 openMsgActionsAt 打开逻辑。
let msgHoldTimer = null;
let msgHoldEl = null;
let msgHoldFired = false;
let msgSuppressClickUntil = 0;
let msgHoldX = 0, msgHoldY = 0; // FIX 2026-09-14 #G2 长按起始触点，判断是否算滑动
// FIX 2026-09-16 #642（iPhone 17 Pro Edge 等多机型报「点消息弹出的引用/操作条这一行乱跑，
// 飞到离气泡很远的地方」，用户要求勿致其他机型回归）：操作条是 position:fixed、此前只在打开
// 瞬间按气泡 getBoundingClientRect 定位一次；此后任何视口几何变化都会把「气泡」挪走而「操作条」
// 留在原地坐标上——①键盘收起/弹出的过渡动画（mobile-adapt 按 vv 高度改写 .phone 高度，点气泡
// 常伴随输入框失焦收键盘）；②Edge iOS 聚焦输入框后的 visualViewport 平移（window.scrollY 恒 0，
// fixed 元素不随内容平移）；③来消息自动贴底滚动（#162/#516）；④消息图 lazy 解码撑高后的补滚。
// 观感即「乱跑/飞到很远的地方」。修法与内核无关——打开后持续「跟随锚点气泡」：视口/滚动每次
// 几何变化都用气泡的**新鲜 rect** 重算位置，并用操作条自身 rect 做一次误差自校正（不假设 fixed
// 的包含块是布局视口还是可视视口、不猜 vv.offset 的内核语义）；锚点被重渲/删除（isConnected=false）
// 即关菜单。单聊/群聊共用（chat.js 先于 group-chat.js 载入，挂 window）。纯几何、零机型/内核分支。
window.mochiFollowActionBar = function (bar, anchor, onClose) {
if (!bar) return null;
let raf = 0;
let vv = window.visualViewport;
function place() {
if (bar.hidden) return;
if (!anchor || !anchor.isConnected) { stop(); if (onClose) onClose(); return; }
const b = anchor.getBoundingClientRect();
const v = window.visualViewport || vv;
const vw = v ? v.width : window.innerWidth;
const vh = v ? v.height : window.innerHeight;
const aw = bar.offsetWidth || 200;
const ah = bar.offsetHeight || 50;
let x = b.left + b.width / 2 - aw / 2;
x = Math.max(10, Math.min(vw - aw - 10, x));
let y = b.top - ah - 8;
const belowY = b.bottom + 8;
const aboveFits = y >= 50;
const belowFits = belowY + ah <= vh - 8;
y = aboveFits || !belowFits ? y : belowY;
bar.style.left = x + 'px';
bar.style.top = y + 'px';
// 自校正：量「目标视觉位置」与「实际渲染位置」的差并补掉——无论内核把 fixed 锚在布局视口
// 还是可视视口、有无 vv 平移，一次即收敛到「贴着气泡」
const m = bar.getBoundingClientRect();
const _maDx = x - m.left, _maDy = y - m.top;
if (_maDx < -1 || _maDx > 1 || _maDy < -1 || _maDy > 1) {
bar.style.left = (x + _maDx) + 'px';
bar.style.top = (y + _maDy) + 'px';
}
}
function stop() {
if (raf) { cancelAnimationFrame(raf); raf = 0; }
if (vv) { vv.removeEventListener('resize', req); vv.removeEventListener('scroll', req); }
window.removeEventListener('resize', req);
window.removeEventListener('scroll', req, true);
bar.__maFollowStop = null;
}
const req = () => {
if (bar.hidden || bar.__maFollowStop !== stop) return;
if (!raf) raf = requestAnimationFrame(() => { raf = 0; place(); });
};
if (typeof bar.__maFollowStop === 'function') { try { bar.__maFollowStop(); } catch (e) {} }
if (vv) { vv.addEventListener('resize', req); vv.addEventListener('scroll', req); }
window.addEventListener('resize', req);
// capture：scroll 事件不冒泡但走捕获期，window 上的捕获监听收得到所有容器（含 .chat-body）的滚动
window.addEventListener('scroll', req, true);
bar.__maFollowStop = stop;
return place;
};
function msgActionEligible(t) {
// 沿用原「点气泡弹菜单」的判定规则：可弹返回 {item, b}，不可弹返回 null（引用气泡/拍一拍/撤回/已读不回等）
// FIX 2026-09-15 #507 语音播放按钮不算「点气泡」——否则轻点/长按播放按钮都会布气泡轻点/长按
// （touchend 开消息菜单+布吞 click 窗口），播放按钮的 click 被吞（吞 click 族内核补发 click 根本
// 不来＝点播永远播不出；健康内核也菜单/播放双触发）。播放走 fillVoiceBubble 的 touch 直驱；
// 菜单入口保留在同气泡非按钮区（波纹/名称区），长按弹菜单原语义不丢。
const b = t.closest('.msg-bubble');
if (!b) return null;
if (t.closest('.msg-voice-play')) return null;
if (t.closest('.msg-quote')) return null;
const item = b.closest('.msg');
if (!item || item.classList.contains('msg-poke')) return null;
if (t.closest('.msg-poke-seg')) return null;
const txt = b.textContent;
if (txt.indexOf('撤回了一条消息') >= 0 || txt.indexOf('已读不回') >= 0) return null;
return { item, b };
}
function openMsgActionsAt(item, b) {
activeMsgEl = item;
// FIX 2026-09-13 #407 引用/收藏/编辑等按 data-idx 解析消息，但菜单打开后 msgs 可能被
// 权威读库合并/尾巴日志回放重排（中段插入/删除 ⇒ 后续下标整体位移）而 DOM 未重渲
//（不贴底跳过重渲的防闪路径），旧下标即指向另一条消息＝「引用预览显示的不是被引那条」
//（华为 P50E Edge 等多机型报障）。打开时快照身份：对象引用 + ts/side/text 签名，
// 执行动作时由 resolveActiveMsg 重新定位。
let _qi = (item && item.dataset && item.dataset.idx !== undefined) ? Number(item.dataset.idx) : -1;
const _mk = (item && item.dataset && item.dataset.mk) || '';
let _qr = (_qi >= 0 && msgs[_qi]) ? msgs[_qi] : null;
// FIX 2026-09-15 #491 渲染期身份锚优先解析——快照若按已位移的陈旧 data-idx 取，开场即锁错条
//（见 msgKeyOf 注释）；按气泡渲染时写入的 mk 反查真实那条，查无（原消息已被删）才回退旧下标。
if (_mk) {
const _j = msgs.findIndex(mkMsg => msgKeyOf(mkMsg) === _mk);
if (_j >= 0) { _qi = _j; _qr = msgs[_j]; }
}
activeMsgSnap = { idx: _qi, rec: _qr, mk: _mk, ts: _qr ? (_qr.ts || 0) : 0, side: _qr ? (_qr.side || '') : '', text: _qr ? String(_qr.text || '').slice(0, 80) : '' };
activeSide = item.classList.contains('msg-out') ? 'out' : 'in';
if (!msgActions) return;
msgActions.querySelectorAll('.ma-mine').forEach(b2 => b2.hidden = activeSide !== 'out');
const delBtn = msgActions.querySelector('.ma-del-ta');
if (delBtn) {
let delEn = false;
try { delEn = store.get('cs-del-ta-msg') === '1'; } catch (e) {}
delBtn.hidden = !(delEn && activeSide === 'in');
}
msgActions.hidden = false;
// FIX 2026-09-16 #642 打开即挂「跟随锚点」并立即定位一次：定位算法与旧块一致（上方居中、
// 放不下换下方、clamp 视口内），此后键盘开合动画/vv 平移/贴底滚动/图片撑高都会实时跟随气泡
// 重算（旧实现只定位一次＝视口一变操作条就留在原地「乱跑/飞远」）
const _maPlace = window.mochiFollowActionBar(msgActions, b, closeMsgActions);
if (_maPlace) _maPlace();
}
// FIX 2026-09-13 #407：菜单动作执行时按身份快照重新定位消息，防「msgs 重排 + DOM 未重渲」
// 窗口期里 data-idx 指向别的消息（引用预览串条/收藏串条/编辑串条/撤回错条）。解析顺序：
// ① 快路径——下标处对象就是快照对象（数组没动过，零开销）；② 对象同一性——重排后对象
// 仍在数组里（indexOf）；③ 签名唯一命中——权威读库合并会换成新解析对象（引用失效），
// 按 ts+side+text 前缀 80 全数组扫描，命中唯一才采信（防同文案多条误绑）；④ 全部失配
// 回退旧 data-idx 行为（宁可维持旧行为也不致无法操作）。
function resolveActiveMsg() {
const idx0 = activeMsgEl && activeMsgEl.dataset && activeMsgEl.dataset.idx !== undefined ? Number(activeMsgEl.dataset.idx) : -1;
const snap = activeMsgSnap;
if (idx0 >= 0 && msgs[idx0]) {
if (!snap || msgs[idx0] === snap.rec) return { idx: idx0, rec: msgs[idx0] };
}
if (snap && snap.rec) {
const i = msgs.indexOf(snap.rec);
if (i >= 0) return { idx: i, rec: snap.rec };
}
if (snap && (snap.ts || snap.text || snap.side)) {
let hit = -1, hits = 0;
for (let i = 0; i < msgs.length; i++) {
const m = msgs[i];
if (!m || (m.ts || 0) !== snap.ts || (m.side || '') !== snap.side) continue;
if (String(m.text || '').slice(0, 80) !== snap.text) continue;
hit = i; hits++;
if (hits > 1) break;
}
if (hits === 1 && hit >= 0) return { idx: hit, rec: msgs[hit] };
}
return (idx0 >= 0 && msgs[idx0]) ? { idx: idx0, rec: msgs[idx0] } : { idx: -1, rec: null };
}
body.addEventListener('contextmenu', (e) => {
// 长按/右键由应用接管：抑制系统默认菜单与文本选中，但不吞掉「引用气泡跳原消息」等其它元素自身行为
if (e.target.closest('.msg-bubble') && !e.target.closest('.msg-quote')) {
e.preventDefault();
// FIX 2026-09-14 #G2 长按气泡打不开引用/动作菜单（多机型同报；要求零机型分支防复发）：长按原由
// touchstart+500ms 定时器触发，但部分内核在按住期间会因手指微移发 touchmove、或长按手势被系统
// 接管（文本操作条/长按候选）先发 touchcancel，定时器被清、菜单永不打开。contextmenu 是内核对
// 长按的权威信号，在此同步打开动作菜单兜底；与定时器路径互斥（同一气泡已开则不重开，避免跳动），
// 松开后补发的 click 由 msgSuppressClickUntil 抑制；桌面右键同样弹动作菜单（原生长按/右键菜单
// 本就已被接管停用，行为是新增出口而非破坏）。
const ctxR = msgActionEligible(e.target);
if (ctxR) {
if (msgHoldTimer) { clearTimeout(msgHoldTimer); msgHoldTimer = null; }
msgSuppressClickUntil = Date.now() + 800;
if (!msgActions || msgActions.hidden || activeMsgEl !== ctxR.item) {
msgHoldFired = true;
openMsgActionsAt(ctxR.item, ctxR.b);
}
}
}
});
let msgTapStart = null; // FIX 2026-09-14 #480 轻点布点——气泡 touch 直驱开菜单入口（click 被吞族内核唯一可靠路）
let msgAnyTap = null;   // FIX 2026-09-14 #480 全局轻点布点——点外关闭菜单的 touch 路
body.addEventListener('touchstart', (e) => {
const r = msgActionEligible(e.target);
const mt0 = e.touches && e.touches[0];
if (mt0) { msgHoldX = mt0.clientX; msgHoldY = mt0.clientY; }
msgAnyTap = { x: msgHoldX, y: msgHoldY, t: Date.now() };
if (!r) { msgTapStart = null; return; }
msgTapStart = { x: msgHoldX, y: msgHoldY, t: Date.now(), item: r.item, b: r.b };
msgHoldEl = r.item;
msgHoldTimer = setTimeout(() => {
msgHoldTimer = null;
msgHoldFired = true;
msgSuppressClickUntil = Date.now() + 800; // 松开后抑制随之而来的轻点，防菜单被刚弹即关
if (window.getSelection) { try { const s = window.getSelection(); if (s && s.removeAllRanges) s.removeAllRanges(); } catch (err) {} }
openMsgActionsAt(msgHoldEl, r.b);
}, 500);
}, { passive: true });
function endMsgHold() { if (msgHoldTimer) { clearTimeout(msgHoldTimer); msgHoldTimer = null; } }
body.addEventListener('touchmove', (e) => {
// FIX 2026-09-14 #G2：手指按住时轻微呼吸性漂移（<12px）不算滑动、不取消长按——部分内核在
// 500ms 长按窗口内必发一两条小 touchmove，微移即清定时器＝菜单永不出现；真实滑动（滚动）仍照常取消。
if (msgHoldTimer && e.touches && e.touches[0]) {
const mt = e.touches[0];
const mdx = mt.clientX - msgHoldX;
const mdy = mt.clientY - msgHoldY;
if (mdx * mdx + mdy * mdy > 144) { endMsgHold(); msgTapStart = null; msgAnyTap = null; }
}
}, { passive: true });   // 手指滑动=滚动，取消长按（超过 12px 才算滑动）
body.addEventListener('touchend', (e) => {
endMsgHold();
// FIX 2026-09-14 #480 轻点 touch 直驱（「合成 click 被吞」族内核——Via/夸克等 WebView 壳，与 #G1
// 拍一拍同族——轻点气泡后内核 click 永不触发＝菜单打不开＝「无法引用消息」）。滑动或按住不算轻点，
// 与长按定时器路互斥（长按仍由 500ms 定时器开）；引擎若正常补发 click，由 msgSuppressClickUntil 吞掉防重入。
const mt = e.changedTouches && e.changedTouches[0];
if (!msgAnyTap || !mt) { msgTapStart = null; return; }
if (Date.now() - msgAnyTap.t > 450 || (mt.clientX - msgAnyTap.x) * (mt.clientX - msgAnyTap.x) + (mt.clientY - msgAnyTap.y) * (mt.clientY - msgAnyTap.y) > 144) { msgTapStart = null; msgAnyTap = null; return; } // 滑动/长按不算轻点
const ts = msgTapStart; msgTapStart = null; msgAnyTap = null;
if (ts) {
// FIX 2026-09-15 #481：吞 click 窗口只在「本次轻点真的开了消息菜单」时布点。原实现无条件布点，
// 轻点面板/空白处的普通 click 也被 body 层 stopPropagation 吞掉，document 层的面板外关闭监听
// （更多功能/表情包/拍一拍等）永远收不到＝点外面关不掉面板（全机型回归，#480 引入）。
msgSuppressClickUntil = Date.now() + 800; // 吞引擎补发 click，防刚开即关/防重入
if (msgActions && !msgActions.hidden && activeMsgEl === ts.item) return; // 该气泡菜单已开，不重开
openMsgActionsAt(ts.item, ts.b);
return;
}
// 轻点在气泡/菜单之外：touch 直驱关菜单（click 被吞内核的对称关闭路）。
// 仅当菜单确实被本次 touch 关闭时才布吞 click 窗口（防补发 click 走气泡路重开菜单）；
// 菜单没开＝与消息菜单无关的普通轻点，click 照常放行（#481）。
if (msgActions && !msgActions.hidden && !msgActions.contains(e.target) && !e.target.closest('.msg-bubble') && !e.target.closest('.msg-quote')) {
msgSuppressClickUntil = Date.now() + 800;
closeMsgActions();
}
});
body.addEventListener('touchcancel', endMsgHold);
body.addEventListener('click', (e) => {
if (msgSuppressClickUntil && Date.now() < msgSuppressClickUntil) { e.preventDefault(); e.stopPropagation(); return; }
const r = msgActionEligible(e.target);
if (!r) {
if (!e.target.closest('.msg-bubble') && !e.target.closest('.msg-quote')) closeMsgActions();
return;
}
e.stopPropagation();
openMsgActionsAt(r.item, r.b);
});
document.addEventListener('click', (e) => {
if (msgActions && !msgActions.hidden && !msgActions.contains(e.target)) closeMsgActions();
});
}
if (msgActions) {
// FIX 2026-09-14 #480 菜单按钮 touch 直驱——【引用】按钮原来只有 click 一条路，click 被吞族内核
// 上菜单开了点引用没反应＝「无法引用」。动作体提为 maRunAction，touchend 直驱执行 + maClickGuard
// 吞引擎补发 click 防双跑（桌面/鼠标仍走 click，行为不变）。
let maClickGuard = 0;
function maRunAction(btn) {
const act = btn.dataset.act;
// FIX 2026-09-13 #407：按身份快照重定位（msgs 重排+DOM 未重渲窗口期 data-idx 会串条）
const _act = resolveActiveMsg();
const idx = _act.idx;
const rec = _act.rec;
if (act === 'quote') {
if (rec) {
const qsnap = quoteTextOf(rec);
lastQuote = { side: rec.side, text: qsnap.text, type: rec.type, imgs: qsnap.imgs, idx: idx };
renderDraft();
}
closeMsgActions();
} else if (act === 'fav') {
if (rec) {
const fav = getFav();
// v3.26.x 修复（iOS 反馈：收藏 5 条页面只显示 3 条、再收藏提示已收藏过却没显示）：
// 判重只限「我的」收藏（TA 自动收藏的 by:'ta' 副本在另一个 tab，不应挡住我的收藏），
// 且加 ts 比较——同文案的不同消息（时间戳不同）允许分别收藏，仅拦截同一条消息重复点收藏
if (fav.some(f => (f.by || 'me') !== 'ta' && f.side === rec.side && (f.text || '') === (rec.text || '') && (!rec.ts || f.ts === rec.ts))) {
toast('已收藏过这条消息');
} else {
fav.push({ side: rec.side, text: rec.text, type: rec.type || 'text', ts: rec.ts || Date.now(), by: 'me', mood: (rec.mood || []).slice(), parts: rec.parts && rec.parts.length ? rec.parts.map(p => ({ k: p.k, v: p.v, sub: p.sub })) : undefined });
saveFav(fav);
toast('已收藏到我的收藏');
}
}
closeMsgActions();
} else if (act === 'copy') {
// 复制消息文字：复用 quoteTextOf（语音取名称、图片/表情只回文字），令牌先展开成原 dataURL 判空
if (rec) {
const qsnap = quoteTextOf(rec);
const _copyRaw = (window.mochiMediaExpand && window.mochiMediaExpand(qsnap.text)) || qsnap.text;
const _copyTxt = (_copyRaw || '').trim();
if (!_copyTxt || _copyRaw.indexOf('data:') === 0) {
toast('该消息没有可复制的文字');
} else {
try {
const ta = document.createElement('textarea');
ta.value = _copyTxt;
ta.setAttribute('readonly', '');
ta.style.cssText = 'position:fixed;left:-9999px;top:0;width:10px;height:10px;opacity:0;';
document.body.appendChild(ta);
try { ta.select(); } catch (e) {}
let ok = false;
try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
window.mochiKillCopySelection && window.mochiKillCopySelection(ta); // 防安卓原生全选条卡屏（device.js #261 同款）
setTimeout(function () { try { document.body.removeChild(ta); } catch (e2) {} }, 800);
if (!ok && navigator.clipboard && navigator.clipboard.writeText) {
navigator.clipboard.writeText(_copyTxt).then(() => toast('已复制')).catch(() => toast('复制失败'));
} else {
toast(ok ? '已复制' : '复制失败');
}
} catch (e) { toast('复制失败'); }
}
}
closeMsgActions();
} else if (act === 'retract') {
// FIX 2026-09-13 #407：撤回同走身份重定位（retractMsg 内部按 msgEl.dataset.idx 解析，
// 这里把 resolveActiveMsg 的正确下标显式传入，防 DOM 陈旧下标撤错条）
if (activeMsgEl) retractMsg(activeMsgEl, 'out', idx);
closeMsgActions();
} else if (act === 'edit') {
if (rec && window.openModal) {
const orig = rec.text;
// #142：媒体池令牌展开——图片消息 text 已令牌化（@@m:<hash>），编辑入口先解出
// 原 dataURL 判定图片消息（输入框置空）；否则令牌字符串会进输入框被当文字保存
const _origMedia = (window.mochiMediaExpand && window.mochiMediaExpand(orig)) || null;
const editEl = activeMsgEl;
window.openModal('编辑消息', (_origMedia || orig.indexOf('data:') === 0) ? '' : orig, (v) => {
const val = (v || '').trim();
if (!val) return;
rec.text = val;
rec.type = 'text';
// v3.26.x 修复（红米 K80 Chrome）：普通文字消息渲染走 rec.parts（renderMsg 的
// parts 分支优先于 rec.text）。旧逻辑只改 rec.text，发送新消息触发该气泡重渲染时，
// 老 parts 里的原文被重新渲染出来 → 编辑内容「变回编辑前」。重建 parts：保留图片段，
// 文字段替换为新值。
rec.parts = (Array.isArray(rec.parts) ? rec.parts.filter(p => p && p.k !== 'text') : []);
rec.parts.push({ k: 'text', v: val });
syncFavMsgText(orig, val); // v3.7.x：编辑后收藏夹里同一条消息快照同步更新（含 TA 收藏）
sessionChangedIdx.add(idx); // v3.6.x：标记本会话变更，防 loadMsgs 合并回滚编辑
saveMsgs();
syncLastMineText(); // v3.6.x：编辑后 TA 引用/收藏不再拿旧文本
const b = editEl && editEl.querySelector('.msg-bubble');
if (b) b.innerHTML = '<span style="opacity:.85">' + escTxt(val) + '</span>';
});
}
closeMsgActions();
} else if (act === 'del') {
if (activeMsgEl && idx >= 0 && msgs[idx] && msgs[idx].side === 'in') {
chatTailDrop(msgs[idx]); // FIX 2026-09-05 #185 删除消息同步从尾巴日志摘除，防刷新后 chatTailMerge 回放复活（与撤回同口径）
msgs.splice(idx, 1);
sessionChangedIdx.clear();
saveMsgs();
renderWindow(true);
toast('已删除该消息');
}
closeMsgActions();
}
}
msgActions.addEventListener('click', (e) => {
const btn = e.target.closest('.ma-btn');
if (!btn) return;
if (Date.now() < maClickGuard) return; // #480 touchend 已直驱执行，吞补发 click 防双跑
maRunAction(btn);
});
msgActions.addEventListener('touchend', (e) => {
const btn = e.target.closest('.ma-btn');
if (!btn || btn.hidden) return;
// FIX 2026-09-15 #522 长按→【编辑】弹窗刚开即被关（vivo X200s Edge 等多机型报障，几何相关：
// 弹窗居中、按钮在框外时必现，在框内时偶发）。根因：#480 touch 直驱在本 handler 里同步
// maRunAction → openModal 打开编辑弹窗后，健康内核仍会补发这次轻点的合成 click；click 目标按
// 「弹窗已打开」的新布局命中 #modal-mask（z-index 90 > #msg-actions 80），触发遮罩 click→close，
// 弹窗瞬间关闭＝编辑无反应。#480 的 maClickGuard 只吞得到 msgActions 自己的 click，拦不住落到
// 遮罩上的那颗。取消 touchend 默认行为＝从引擎层抑制本次合成 click（吞 click 族内核本就不发 click，
// 不受影响），保留 maClickGuard 作第二道防双跑。
e.preventDefault();
maClickGuard = Date.now() + 600; // 吞引擎补发 click 防双跑
maRunAction(btn); // touch 直驱执行——不依赖内核从 touch 合成 click
});
}
function toast(msg) {
let t = document.getElementById('cc-toast');
if (!t) {
t = document.createElement('div');
t.id = 'cc-toast';
document.body.appendChild(t);
}
t.textContent = msg;
t.className = 'cc-toast'; void t.offsetWidth; t.className = 'cc-toast show';
t.style.opacity = '';
clearTimeout(t._timer);
t._timer = setTimeout(() => { t.className = 'cc-toast'; }, 2000);
}
const favPage = document.getElementById('page-fav');
const favList = document.getElementById('fav-list');
let favTab = 'mine'; // mine=我的收藏 ta=联系人的收藏
let favKind = 'all'; // 收藏分类筛选：all=全部 msg=聊天消息 card=互动卡片 mail=信件 feed=朋友圈
let favBatch = false;   // v3.31.x 批量管理模式（多选删除）
let favBatchSel = [];   // #314 批量模式选中的 favItemKey 指纹（跨重渲染稳定，不再存对象引用）
let favBatchArr = null; // 当次渲染使用的收藏数组引用（批量删除直接改它，避免重复 getFav 解析导致引用失效）
let favBatchVis = [];   // 当前 tab+分类筛选下可见条目（全选用）
const FAV_KINDS = [
{ k: 'all', label: '全部', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>' },
{ k: 'msg', label: '聊天', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>' },
{ k: 'card', label: '互动', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 14h4"/></svg>' },
{ k: 'mail', label: '信件', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>' },
{ k: 'feed', label: '朋友圈', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5"/><circle cx="17" cy="9.5" r="2.2"/><path d="M14.5 19c0-2 2-3.5 4-3.5s2.5 1.5 2.5 3.5"/></svg>' }
];
// v3.31.x 批量管理：按当前勾选数同步底部操作栏（删除按钮文案/可用态 + 全选按钮文案）
function syncBatchBar() {
const delBtn = document.getElementById('fav-batch-del');
if (delBtn) {
delBtn.textContent = '删除' + (favBatchSel.length ? '(' + favBatchSel.length + ')' : '');
delBtn.disabled = !favBatchSel.length;
}
const allBtn = document.getElementById('fav-batch-all');
if (allBtn) allBtn.textContent = (favBatchVis.length && favBatchSel.length === favBatchVis.length) ? '取消全选' : '全选';
}
function renderFav() {    if (!favList) return;
const fav = getFav();
favList.innerHTML = '';
const partnerName = chatPartnerName();
const myName = chatUserName();
const myFav = fav.filter(f => f.by !== 'ta');
const taFav = fav.filter(f => f.by === 'ta');
const tabsEl = document.getElementById('fav-tabs');
if (tabsEl) {
tabsEl.querySelectorAll('.fav-tab').forEach(t => t.classList.toggle('sel', t.dataset.tab === favTab));
}
const list = favTab === 'ta' ? taFav : myFav;
const kindTabsEl = document.getElementById('fav-kind-tabs');
if (kindTabsEl) {
const counts = { all: list.length, msg: 0, card: 0, mail: 0, feed: 0 };
list.forEach(f => { const k = f.kind || 'msg'; if (k in counts) counts[k]++; });
kindTabsEl.querySelectorAll('.fav-tab').forEach(t => {
const k = t.dataset.kind;
t.classList.toggle('sel', k === favKind);
const n = counts[k] || 0;
const cnt = t.querySelector('.fav-tab-cnt');
if (cnt) cnt.textContent = n > 0 ? String(n) : '';
});
}
const list2 = favKind === 'all' ? list : list.filter(f => (f.kind || 'msg') === favKind);
list2.sort((a, b) => (b.ts || 0) - (a.ts || 0));
// v3.31.x 批量管理：记录本次渲染的数组与可见条目；勾选只保留当前筛选下仍可见的（切 tab/分类自动收窄）
// #314：勾选身份是 favItemKey 指纹而非对象引用——getFav() 每次 JSON.parse 生成全新对象，
// 按引用过滤在每次重渲染后必然全部失配（点全选/切分类/切页签即触发），勾选静默清零。
favBatchArr = fav;
favBatchVis = list2;
if (favBatch) {
  const visKeys = new Set(list2.map(favItemKey));
  favBatchSel = favBatchSel.filter(k => visKeys.has(k));
}
const manageBtn = document.getElementById('fav-manage-btn');
if (manageBtn) manageBtn.classList.toggle('sel', favBatch);
const barEl = document.getElementById('fav-batch-bar');
if (barEl) { barEl.hidden = !favBatch; syncBatchBar(); }
const title = favTab === 'ta' ? partnerName + ' 的收藏' : myName + ' 的收藏';
let empty = favTab === 'ta' ? 'TA 还没有收藏' : '暂无收藏';
if (favKind !== 'all') {
const K_EMPTY = { msg: '聊天消息', card: '互动卡片', mail: '信件', feed: '朋友圈' };
empty = (favTab === 'ta' ? 'TA 还没有收藏' : '暂无') + K_EMPTY[favKind];
}
const h = document.createElement('div');
h.className = 'cc-group-header';
h.innerHTML = '<span class="ccg-name">' + title + '</span><span class="ccg-count">' + list2.length + '</span>';
favList.appendChild(h);
if (!list2.length) {
favList.innerHTML += '<div class="fav-empty">' + empty + '</div>';
return;
}
const FAV_KIND_LABEL = {
'ask-choose': '小问题', 'ask-curious': '好奇', 'ask-roast': '吐槽',
'ask-card': '问问TA', 'invite': '邀请TA', 'ask': '问问TA', 'ask-survey': '问卷',
'redpacket': '红包', 'flower': '送花', 'gift': '礼物', 'dish': '佳肴'
};
function favTextHtml(s) {
const str = String(s || '');
let html = '';
// FIX 2026-09-12 #356 收藏令牌化后媒体池令牌 @@m:hash 也是图片载荷——信件/朋友圈收藏
// 文本里夹令牌时按图片渲染（文档级观察器解析成池数据），否则令牌串被当文字直出＝不明代码
const re = /((?:sticker|image):)?(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+|@@m:[0-9a-f]{32})/g;
let last = 0, mm;
while ((mm = re.exec(str))) {
html += escTxt(str.slice(last, mm.index));
html += '<img class="fav-item-img" src="' + mm[2] + '" alt="图片" loading="lazy" decoding="async">';
last = mm.index + mm[0].length;
}
html += escTxt(str.slice(last));
return html;
}
list2.forEach(f => renderFavItem(f));
function renderFavItem(f) {
const kind = f.kind || 'msg';
const m = document.createElement('div');
m.className = 'msg ' + (f.side === 'out' ? 'msg-out' : 'msg-in');
const timeHtml = f.ts ? '<span class="msg-time">' + fmtTime(f.ts) + '</span>' : '';
const side = '<div class="msg-side"><div class="msg-av"></div>' + timeHtml + '</div>';
if (kind === 'card') {
const label = FAV_KIND_LABEL[f.special] || '互动卡片';
let html = '<div class="fav-item-card">' +
'<span class="fav-item-tag">互动卡片 · ' + label + '</span>' +
'<div class="fav-item-q">' + (f.special === 'invite' ? (window.taFit ? window.taFit('邀请TA') : '邀请TA') + ' · ' : '') + escTxt(f.q || '') + '</div>';
// #713 批量问卷收藏重放：题目列表 + TA 作答（行内样式沿用问卷卡配色，零新 CSS）
if (f.special === 'ask-survey' && Array.isArray(f.qarr) && f.qarr.length) {
const aarr = Array.isArray(f.aarr) ? f.aarr : [];
html += '<div style="text-align:left;display:flex;flex-direction:column;gap:8px;margin-top:2px">' + f.qarr.map((x, i) => {
let r = '<div><div style="font-size:12px;font-weight:600;color:var(--ink);line-height:1.5;word-break:break-word">' + (i + 1) + '. ' + escTxt((x && x.t) || '') + '</div>';
if (x && Array.isArray(x.o) && x.o.length) r += '<div style="font-size:11px;color:var(--muted);margin-top:2px;word-break:break-word">选项：' + escTxt(x.o.join(' / ')) + '</div>';
if (aarr[i]) r += '<div class="fav-item-a" style="margin-top:2px;word-break:break-word">TA：' + escTxt(aarr[i]) + '</div>';
return r + '</div>';
}).join('') + '</div>';
} else {
if (f.mine) html += '<div class="fav-item-a">✓ 我：' + escTxt(f.mine) + '</div>';
if (f.ta) html += '<div class="fav-item-r">' + (window.taFit ? window.taFit('TA：') : 'TA：') + escTxt(window.taFit ? window.taFit(askCardReplyClean(f.ta)) : askCardReplyClean(f.ta)) + '</div>'; // #648g 存量收藏快照的媒体卡回应同样清洗
if (!f.mine && !f.ta) html += '<div class="fav-item-tip">等待回应…</div>';
}
html += '</div>';
m.innerHTML = html + side;
fillAvatar(m.querySelector('.msg-av'), 'cs-avatar-user');
} else if (kind === 'mail') {
const tag = f.mailType === 'received' ? '信箱来信' : '信箱回信';
let html = '<div class="fav-item-card">' +
'<span class="fav-item-tag">' + tag + (f.title ? ' · 《' + escTxt(f.title) + '》' : '') + '</span>' +
'<div class="fav-item-body">' + favTextHtml(f.text) + '</div>' +
'</div>';
// v3.26.x：信件收藏不显示头像——不再复用聊天行的 .msg-av 头像槽（时间保留），纯卡片观感
m.innerHTML = html + '<div class="msg-side">' + timeHtml + '</div>';
} else if (kind === 'feed') {
let html = '<div class="fav-item-card">' +
'<span class="fav-item-tag">朋友圈动态</span>' +
(f.text ? '<div class="fav-item-body">' + favTextHtml(f.text) + '</div>' : '') +
((f.imgs && f.imgs.length) ? '<div class="fav-item-imgs">' + f.imgs.map(u => '<img src="' + attrEsc(u) + '" alt="图片" loading="lazy" decoding="async">').join('') + '</div>' : '') +
'</div>';
m.innerHTML = html + side;
fillAvatar(m.querySelector('.msg-av'), 'cs-avatar-user');
} else {
m.innerHTML = f.side === 'out'
? '<div class="msg-bubble"></div>' + side
: side + '<div class="msg-bubble"></div>';
const b = m.querySelector('.msg-bubble');
if (f.parts && f.parts.length) {
const imgs = f.parts.filter(p => p.k === 'img');
const textPart = f.parts.filter(p => p.k === 'text').map(p => p.v).join(' ');
let inner = '';
if (imgs.length) {
inner += '<div class="msg-parts-imgs' + (imgs.length > 1 ? ' multi' : '') + '">' +
imgs.map(p => {
const isSticker = p.sub === 'sticker';
return '<img class="msg-img' + (isSticker ? ' msg-img-sm' : ' msg-img-big') + '" src="' + attrEsc(p.v) + '" alt="' + (isSticker ? '表情' : '图片') + '" loading="lazy" decoding="async">';
}).join('') + '</div>';
}
// FIX 2026-09-13 #394 收藏消息文本走内嵌令牌助手（同 #385）
if (textPart) inner += '<span style="opacity:.85;word-break:break-word">' + (window.mochiInlineTextHtml ? window.mochiInlineTextHtml(textPart) : escTxtBr(textPart)) + '</span>';
b.innerHTML = inner;
b.querySelectorAll('.msg-img-big').forEach(img => {
img.addEventListener('click', (e) => {
e.stopPropagation();
if (window.viewChatImage) window.viewChatImage(img.src);
});
});
} else {
// FIX 2026-09-12 #356 收藏令牌化收口：favImgPass 会把收藏里的 data:image / data:audio
// 换成媒体池令牌 @@m:hash（与聊天记录同池），渲染端必须与聊天同口径——令牌=图片载荷
// （文档级观察器解析），绝不能掉进文本分支把 @@m:串 当文字直出（=「不明代码」报障，
// 摩托罗拉 G100 Edge 等多机型复现，与设备无关）。bare data:audio（无 ||| 名称段的
// 旧存量）也归语音，避免被当 <img> 塞音频数据。
// FIX 2026-09-13 #397 语音判定必须带 ||| 分隔符——旧正则含 ^ 分支，裸令牌（图片载荷）
// 被误判成语音＝图片收藏渲染成语音条（iPhone 16 Safari 报障，多机型同现）
// FIX 2026-09-13 #400 收藏分类改「内容优先」——不再信任存储的 type 字段（历史误存/旧包
// 写坏的数据一律纠正）：只有内容真长得像语音（data:audio 或 名称|||令牌）才渲染语音条，
// 其余一律按图片/文本渲染
const looksVoice = typeof f.text === 'string' &&
(f.text.indexOf('|||') >= 0 && (chatIsDataAudioSrc(f.text.split('|||')[1] || '') || /@@m:[0-9a-f]{32}$/.test(f.text))) || chatIsDataAudioSrc(f.text); // FIX #948 判据大小写/空白不敏感
const isVoice = looksVoice;
const isImg = !isVoice && (f.type === 'sticker' || f.type === 'image' || chatIsImgSrcLike(f.text)); // FIX #948 同口径
if (isVoice) {
b.style.padding = '8px 10px';
fillVoiceBubble(b, f.text);
} else if (isImg) {
b.style.padding = '6px';
b.innerHTML = '<img class="msg-img" src="' + attrEsc(f.text) + '" alt="表情">';
} else {
b.innerHTML = '<span style="opacity:.85">' + (window.mochiInlineTextHtml ? window.mochiInlineTextHtml(f.text) : escTxtBr(f.text)) + '</span>'; // FIX 2026-09-13 #394 收藏单条文本内嵌令牌转图
}
}
if (f.mood && f.mood.length) {
  f.mood.forEach(md => {
    const dupFav = md.label != null && String(md.label) !== '' && String(md.label) === String(f.text == null ? '' : f.text);
    if (md.tag === '交流意图') {
      b.innerHTML += '<div class="msg-mood msg-intent"><span class="msg-mood-tag">' + md.tag + '</span>' + (dupFav ? '' : '<span>' + md.label + '</span>') + '</div>';
    } else {
      b.innerHTML += '<div class="msg-mood"><span class="msg-mood-tag">' + md.tag + '</span>' + (dupFav ? '' : '<span>' + md.label + '</span>') + '</div>';
    }
  });
}
fillAvatar(m.querySelector('.msg-av'), f.side === 'out' ? 'cs-avatar-user' : 'cs-avatar-partner');
}
if (kind === 'feed') {
m.querySelectorAll('.fav-item-imgs img').forEach(im => im.addEventListener('click', (e) => {
e.stopPropagation();
if (window.viewChatImage) window.viewChatImage(im.src);
}));
}
function matchFav(x) {
return (x.kind || 'msg') === kind &&
(x.q || '') === (f.q || '') && (x.text || '') === (f.text || '') && x.ts === f.ts;
}
// v3.31.x 批量管理：条目变多选——外侧加圆圈勾选，点击整条切换勾选；
// 用捕获阶段监听，抢先于气泡内图片的 click（查看大图）并 stopPropagation 拦下
if (favBatch) {
const fk = favItemKey(f); // #314 勾选身份=指纹 key（对象引用跨重渲染必失配）
const ck = document.createElement('div');
ck.className = 'fav-check' + (favBatchSel.indexOf(fk) >= 0 ? ' on' : '');
ck.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
if (f.side === 'out') m.appendChild(ck); else m.insertBefore(ck, m.firstChild);
m.addEventListener('click', (e) => {
e.stopPropagation();
const i = favBatchSel.indexOf(fk);
if (i >= 0) favBatchSel.splice(i, 1); else favBatchSel.push(fk);
ck.classList.toggle('on', favBatchSel.indexOf(fk) >= 0);
syncBatchBar();
}, true);
favList.appendChild(m);
return;
}
let pressTimer = null;
m.addEventListener('touchstart', (e) => {
pressTimer = setTimeout(() => {
const fav2 = getFav();
const idx2 = fav2.findIndex(matchFav);
if (idx2 >= 0) {
if (window.openModal) {
window.openModal('删除这条收藏？', '', () => {
fav2.splice(idx2, 1);
saveFav(fav2);
renderFav();
}, { noInput: true });
}
}
}, 600);
}, { passive: true });
m.addEventListener('touchend', () => clearTimeout(pressTimer));
m.addEventListener('touchmove', () => clearTimeout(pressTimer), { passive: true }); // #721 处理体只清定时器，被动化免低端机列表滚动被主线程阻塞
m.addEventListener('contextmenu', (e) => {
e.preventDefault();
const fav2 = getFav();
const idx2 = fav2.findIndex(matchFav);
if (idx2 >= 0 && window.openModal) {
window.openModal('删除这条收藏？', '', () => {
fav2.splice(idx2, 1);
saveFav(fav2);
renderFav();
}, { noInput: true });
}
});
favList.appendChild(m);
}
}
const favTabs = document.getElementById('fav-tabs');
if (favTabs) {
favTabs.addEventListener('click', (e) => {
const tb = e.target.closest('.fav-tab');
if (!tb) return;
favTab = tb.dataset.tab;
renderFav();
});
}
const favKindTabs = document.createElement('div');
favKindTabs.className = 'fav-tabs fav-kind-row';
favKindTabs.id = 'fav-kind-tabs';
favKindTabs.innerHTML = FAV_KINDS.map(o => '<button class="fav-tab" data-kind="' + o.k + '">' + o.icon + '<span class="fav-tab-label">' + o.label + '</span><span class="fav-tab-cnt"></span></button>').join('');
if (favTabs && favTabs.parentNode) favTabs.parentNode.insertBefore(favKindTabs, favTabs.nextSibling);
favKindTabs.addEventListener('click', (e) => {
const tb = e.target.closest('.fav-tab');
if (!tb) return;
favKind = tb.dataset.kind;
renderFav();
});
// v3.31.x 批量管理：顶栏入口 / 底部操作栏（取消 / 全选 / 删除）
const favManageBtn = document.getElementById('fav-manage-btn');
if (favManageBtn) {
favManageBtn.addEventListener('click', () => {
favBatch = !favBatch;
favBatchSel = [];
renderFav();
if (favBatch) toast('点选要删除的收藏');
});
}
const favBatchCancel = document.getElementById('fav-batch-cancel');
if (favBatchCancel) {
favBatchCancel.addEventListener('click', () => {
favBatch = false;
favBatchSel = [];
renderFav();
});
}
const favBatchAll = document.getElementById('fav-batch-all');
if (favBatchAll) {
favBatchAll.addEventListener('click', () => {
if (!favBatch) return;
const all = favBatchVis.length && favBatchSel.length === favBatchVis.length;
favBatchSel = all ? [] : favBatchVis.map(favItemKey); // #314 存指纹 key，不存对象引用
renderFav();
});
}
const favBatchDel = document.getElementById('fav-batch-del');
if (favBatchDel) {
favBatchDel.addEventListener('click', () => {
if (!favBatch || !favBatchSel.length) return;
const n = favBatchSel.length;
if (!window.openModal) return;
window.openModal('删除选中的 ' + n + ' 条收藏？', '', () => {
// #314 按指纹 key 匹配删除——对象引用在确认弹窗打开期间经 getFav 重排必然失配
const selKeys = new Set(favBatchSel);
if (favBatchArr) {
for (let i = favBatchArr.length - 1; i >= 0; i--) {
if (selKeys.has(favItemKey(favBatchArr[i]))) favBatchArr.splice(i, 1);
}
}
if (favBatchArr) saveFav(favBatchArr);
favBatchSel = [];
renderFav();
toast('已删除 ' + n + ' 条收藏');
}, { noInput: true });
});
}
window.renderFav = renderFav;
const favApp = document.querySelector('.app[data-app="note"]');
if (favApp && favPage) {
favApp.addEventListener('click', () => {
const editing = Array.from(document.querySelectorAll('.app-grid')).some(g => g.classList.contains('editing'));
if (editing) return;
document.querySelectorAll('.page').forEach(p => { if (!p.hidden) p.hidden = true; }); // FIX #336 同值写也发 mutation，44 页全扫=唤醒全部页面观察器
favPage.hidden = false;
renderFav();
});
}
const favBack = document.getElementById('fav-back');
if (favBack) {
favBack.addEventListener('click', () => {
favBatch = false; // v3.31.x 离开收藏页退出批量模式
favBatchSel = [];
document.querySelectorAll('.page').forEach(p => { if (!p.hidden) p.hidden = true; }); // FIX #336 同值写也发 mutation，44 页全扫=唤醒全部页面观察器
const phonePage = document.getElementById('page-phone');
if (phonePage) phonePage.hidden = false;
});
}
const emojiPanel = document.getElementById('emoji-panel');
const emojiList = document.getElementById('emoji-list');
const emojiClose = document.getElementById('emoji-close');
const emojiBtn = document.getElementById('chat-emoji-btn');
const emojiGroupsBar = document.getElementById('emoji-groups');
const emojiTools = document.getElementById('emoji-tools');
const emojiBatch = document.getElementById('emoji-batch');
const emojiBatchCount = document.getElementById('emoji-batch-count');
let emojiMode = 'ta';        // public（公用表情包）/ ta（联系人专属）/ mine（跨会话记住上次模式）
let emojiCurGroup = '';      // 联系人专属表情包分组筛选（记住上次打开的分组）
let pubCurGroup = '';        // 公用表情包分组筛选（记住上次打开的分组）
let myCurGroup = '';         // 我的表情包分组筛选（记住上次打开/上传进的分组）
let myBatchMode = false;     // 批量管理模式
let myGroups = [];           // 我的表情包 [[分组名, [dataURL...]], ...]
let mySel = new Set();       // 批量勾选：分组名\u0001索引
let emojiInsertCb = null;    // v3.6.x：写信/回信「插入模式」回调（点击表情插入信纸）
let emojiInsertAllowUrl = false;
// #691i：插入模式回调方开口径——群聊复用本面板且点卡片行为确实受 chat-textcard-direct 影响，
//   故传 textModeApplies:true 才显示面板内的模式切换按钮；写信/回信是「插进信纸」语义，
//   模式键对它无效，显示一个点了没用的按钮＝骗用户，默认不显示。
let emojiTextModeApplies = false;
const MYE_G_PREFIX = 'xy-home-v2';
function myEmojiStore() { return window.xyStore(MYE_G_PREFIX); }
function MYE_KEY() { return MYE_G_PREFIX + ':my-emoji-groups'; }
function taStickerHidden() {
try { if (window.xyStore) return window.xyStore(MYE_G_PREFIX).get('hide-ta-sticker') === '1'; } catch (e) {}
try { return store.get('hide-ta-sticker') === '1'; } catch (e) { return false; }
}
myGroups = myEmojiLoad();
// v3.26.x #636：表情包面板新增【颜文字】【emoji】两个分类——文字字卡，取字卡库同名分类的 公用/专属
//   两作用域 + 面板内自建的「我的」文字库（批量导入一行一个），与表情包 公用/TA/我的 同模式。
//   实现：emojiMode 语义不变（public/ta/mine 三作用域，作用域 tab 三类共用），另加一级分类行
//   emojiCat（sticker/kaomoji/emoji，JS 注入、template 不动）；emojiCat==='sticker' 的既有分支一律
//   不动，文字分类走 renderEmojiTextPanel 全新路径，互不纠缠。
let emojiCat = 'sticker';           // 面板第一级分类
let myTextGroups = { kaomoji: [], emoji: [] }; // 我的文字库（全局键 my-text-groups，与 my-emoji-groups 同为跨桌面共用）
let myTextBatch = false;            // 文字库批量管理模式
let myTextSel = new Set();          // 文字库批量勾选：分组名\u0001索引
let myTextHydrated = false;         // 本会话是否已从 IDB 取回过 my-text-groups
let textCurGroupMap = {};           // '分类\u0001作用域' -> 当前分组名（公用/专属可能同名，按作用域分键）
let emojiCatBar = null;             // 分类行 DOM（懒建一次）
let emojiTextTools = null;          // 文字库工具行 DOM（懒建一次）
let mytBatchBtn = null;
const MYT_KEY = MYE_G_PREFIX + ':my-text-groups';
function textCatHidden(cat) {
try { return window.xyStore(MYE_G_PREFIX).get(cat === 'kaomoji' ? 'hide-tab-kaomoji' : 'hide-tab-emoji') === '1'; } catch (e) {}
return false;
}
function textCurKey() { return emojiCat + '\u0001' + emojiMode; }
function textCurGroup() { return textCurGroupMap[textCurKey()] || ''; }
function textCurSet(v) { textCurGroupMap[textCurKey()] = v || ''; }
function textCatLabel() { return emojiCat === 'kaomoji' ? '颜文字' : (emojiCat === 'emoji' ? 'emoji' : '表情包'); }
// v3.26.x #691：颜文字/emoji 点击行为模式（用户直派）——「点击填入输入栏」(默认) 或
//   「点击直接发送」(聊天设置里手动开)。全局根键 xy-home-v2:chat-textcard-direct，
//   与同组的 hide-tab-kaomoji/hide-tab-emoji 同口径（面板跨桌面共用一份，不随联系人隔离）；
//   '1' = 直接发送，其余/缺省 = 填入输入栏。模式在点击时现读，设置改完立即生效。
//   设置行由 chat-settings.js 注入（锚 cs-hide-ta-sticker-row，template.html 不动）。
const TEXTCARD_DIRECT_KEY = 'chat-textcard-direct';
function textCardDirectMode() {
try { if (window.xyStore) return window.xyStore(MYE_G_PREFIX).get(TEXTCARD_DIRECT_KEY) === '1'; } catch (e) {}
try { return store.get(TEXTCARD_DIRECT_KEY) === '1'; } catch (e) { return false; }
}
try { window.textCardDirectMode = textCardDirectMode; } catch (e) {}
// 填入聊天输入栏：尾部追加，不清空用户已经打好的字；面板保持打开＝可连点多张，发不发由用户决定。
// 程序化写入不派发 input 事件，这里补一条（带 bubbles）让「最近输入快照」与所见内容同步——
// #215 发送瞬间内核撕文本时，readSendText 的快照兜底才认得出这段内容。
function insertTextToChatInput(t) {
const el = document.getElementById('chat-input');
if (!el || typeof t !== 'string' || !t) return;
el.textContent = (el.textContent || '') + t;
try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
}
function myTextOf() { if (!Array.isArray(myTextGroups[emojiCat])) myTextGroups[emojiCat] = []; return myTextGroups[emojiCat]; }
function myTextLoad() {
try { const v = JSON.parse(myEmojiStore().get('my-text-groups') || 'null'); if (v && typeof v === 'object') { myTextGroups.kaomoji = Array.isArray(v.kaomoji) ? v.kaomoji : []; myTextGroups.emoji = Array.isArray(v.emoji) ? v.emoji : []; } } catch (e) {}
}
function myTextSave() { try { myEmojiStore().set('my-text-groups', JSON.stringify(myTextGroups)); } catch (e) {} }
myTextLoad();
// 当前分类+作用域的分组列表；'mine' 走面板自建文字库，其余走字卡库同名分类（getScopedGroups 已滤停用分组）
function textScopeGroups() {
if (emojiMode === 'mine') return myTextOf();
return ((window.getScopedGroups && window.getScopedGroups(emojiCat, emojiMode === 'public' ? 'public' : 'own')) || []);
}
// 文字库很小（KB 级），不做 my-emoji-groups 那套大键 hydrate/防覆盖，只在首开时补一次 idbGet 兜底
function reloadMyTextFromIdb() {
if (myTextHydrated || !window.idbGet) return;
myTextHydrated = true;
window.idbGet(MYT_KEY).then(v => {
if (!v) return;
try {
const p = JSON.parse(v);
if (!p || typeof p !== 'object') return;
const pk = Array.isArray(p.kaomoji) ? p.kaomoji : [], pe = Array.isArray(p.emoji) ? p.emoji : [];
if (pk.length + pe.length > myTextGroups.kaomoji.length + myTextGroups.emoji.length) {
myTextGroups.kaomoji = pk; myTextGroups.emoji = pe;
try { if (emojiPanel && !emojiPanel.hidden) renderEmojiPanel(); } catch (e) {}
}
} catch (e) {}
}).catch(() => {});
}
// #636：分类行（表情包/颜文字/emoji）——JS 注入到 .emoji-head 之后，template 不动
function ensureEmojiCatBar() {
if (emojiCatBar || !emojiPanel) return;
const head = emojiPanel.querySelector('.emoji-head');
if (!head || !head.parentNode) return;
emojiCatBar = document.createElement('div');
emojiCatBar.className = 'emoji-cats';
[['sticker', '表情包'], ['kaomoji', '颜文字'], ['emoji', 'emoji']].forEach(([cat, label]) => {
const c = document.createElement('button');
c.className = 'emoji-cat-chip';
c.type = 'button';
c.dataset.ecat = cat;
c.textContent = label;
c.addEventListener('click', (e) => {
e.stopPropagation();
if (emojiCat === cat) return;
emojiCat = cat;
myTextBatch = false;
myTextSel.clear();
saveEmojiGroupPref();
renderEmojiPanel();
try { c.blur(); } catch (err) {}
});
emojiCatBar.appendChild(c);
});
head.parentNode.insertBefore(emojiCatBar, head.nextSibling);
}
// v3.26.x #691i：把「点击行为」开关也放到面板里（用户直派：「这个切换的按钮，需要直接在表情包
//   页面的【颜文字】和【emoji】里放一个按钮」）。与聊天设置里那一行读写同一个全局根键
//   chat-textcard-direct，两处状态永远一致：设置页每 500ms 自同步（csAddSync），面板每次重渲
//   现读；在面板里点了就写键 + 就地刷新按钮文案，不重渲整个网格（不打断已加载的图/lazy 状态）。
//   按钮只存在于【颜文字】【emoji】两个文字分类下（emojiCat!=='sticker'），表情包图片不受影响。
let emojiTextModeBar = null;
function setTextCardDirectMode(en) {
try { if (window.xyStore) { window.xyStore(MYE_G_PREFIX).set(TEXTCARD_DIRECT_KEY, en ? '1' : '0'); return; } } catch (e) {}
try { store.set(TEXTCARD_DIRECT_KEY, en ? '1' : '0'); } catch (e) {}
}
function ensureEmojiTextModeBar() {
if (emojiTextModeBar || !emojiCatBar || !emojiCatBar.parentNode) return;
// 幂等兜底：面板可能已被外部 DOM 重建/热重载（#574 家族），按 id 复用已有节点防重复插入
const exist = emojiPanel && emojiPanel.querySelector('#emoji-text-mode-btn');
if (exist) { emojiTextModeBar = exist; return; }
const b = document.createElement('button');
b.id = 'emoji-text-mode-btn';
b.type = 'button';
b.className = 'emoji-text-mode';
b.addEventListener('click', (e) => {
e.stopPropagation();
const next = !textCardDirectMode();
setTextCardDirectMode(next);
renderEmojiTextModeBar();
try { toast(next ? '已切换：点颜文字/emoji 直接发出' : '已切换：点颜文字/emoji 先填进输入栏，发不发由你定'); } catch (err) {}
try { b.blur(); } catch (err) {}
});
emojiCatBar.parentNode.insertBefore(b, emojiCatBar.nextSibling);
emojiTextModeBar = b;
}
// 文案即「小字写清楚」：主行说当前行为，副行说点它会变成什么——两行都在按钮里，不额外占版面
function renderEmojiTextModeBar() {
if (!emojiTextModeBar) return;
emojiTextModeBar.hidden = emojiCat === 'sticker' || !!(emojiInsertCb && !emojiTextModeApplies);
if (emojiTextModeBar.hidden) return;
const on = textCardDirectMode();
emojiTextModeBar.innerHTML =
on
? '<span class="etm-main">当前：点一下直接发送</span><span class="etm-sub">点这里切换为「先填进输入栏」，发不发由你点「发送」定</span>'
: '<span class="etm-main">当前：点一下填进输入栏</span><span class="etm-sub">可连点多条，点「发送」才发出；点这里切换为「直接发送」</span>';
}
// #636：文字库工具行（批量导入 / 批量管理）——插在图片工具行前面，同槽位互斥显示
function ensureEmojiTextTools() {
if (emojiTextTools || !emojiPanel) return;
const tools = emojiPanel.querySelector('.emoji-tools');
if (!tools || !tools.parentNode) return;
emojiTextTools = document.createElement('div');
emojiTextTools.id = 'emoji-text-tools'; // 快照/回归脚本按 id 定位
emojiTextTools.className = 'emoji-tools';
emojiTextTools.hidden = true;
const importBtn = document.createElement('button');
importBtn.className = 'emoji-tool';
importBtn.type = 'button';
importBtn.textContent = '批量导入';
mytBatchBtn = document.createElement('button');
mytBatchBtn.className = 'emoji-tool';
mytBatchBtn.type = 'button';
mytBatchBtn.textContent = '批量管理';
emojiTextTools.appendChild(importBtn);
emojiTextTools.appendChild(mytBatchBtn);
tools.parentNode.insertBefore(emojiTextTools, tools);
importBtn.addEventListener('click', (e) => { e.stopPropagation(); openMyTextImport(); });
mytBatchBtn.addEventListener('click', (e) => {
e.stopPropagation();
myTextBatch = !myTextBatch;
myTextSel.clear();
renderEmojiPanel();
});
}
// #636：批量导入（一行一个，【分组名】前缀可选指定分组）——语法与表情包「链接导入」一致
function openMyTextImport() {
if (!window.openModal) return;
const catName = textCatLabel();
const fallbackGroup = textCurGroup() || '常用';
window.openModal('批量导入' + catName + '（一行一个）', '', (raw, targetGroup) => {
const lines = String(raw || '').split(/\r?\n|\u2028|\u2029|\u0085/).map(s => s.replace(/[\u200b-\u200f\ufeff]/g, '').trim()).filter(Boolean);
if (!lines.length) { toast('没有可导入的内容（一行一个）'); return; }
const groups = myTextOf();
let newGroups = 0, added = 0, dup = 0, firstBucket = '';
const buckets = {};
const resolveBucket = (name) => {
if (!buckets[name]) {
let g = groups.find(x => x[0] === name);
if (!g) { g = [name, []]; groups.unshift(g); newGroups++; }
buckets[name] = { g: g, seen: new Set(g[1]) };
if (!firstBucket) firstBucket = name;
}
return buckets[name];
};
lines.forEach(line => {
const m = /^【([^】]+)】\s*([\s\S]+)$/.exec(line);
const val = (m ? m[2] : line).trim();
if (!val) { dup++; return; }
const b = resolveBucket(m ? m[1] : (targetGroup || fallbackGroup));
if (b.seen.has(val)) { dup++; return; }
b.seen.add(val);
b.g[1].push(val);
added++;
});
myTextSave();
if (added) { textCurSet(firstBucket); saveEmojiGroupPref(); }
renderEmojiPanel();
toast(added ? '已导入 ' + added + ' 个' + catName + (dup ? '，跳过 ' + dup + ' 行（重复/空行）' : '') + (newGroups ? '，新建 ' + newGroups + ' 个分组' : '') : '没有新增（全部重复或为空）');
}, {
textarea: true,
textareaPlaceholder: '一行一个，可粘贴多个批量导入\n可用【分组名】前缀指定分组，如：【开心】(｡♥‿♥｡)\n不写前缀进「' + fallbackGroup + '」分组',
groups: myTextOf().map(g => g[0])
});
}
function saveEmojiGroupPref() {
// v3.15.x：mode 一并持久化——每次打开表情包直接落在上次用的模式+分组，不用重复点
// #636：cat（分类行）与 tg（文字分类的「分类\u0001作用域→分组」表）一并持久化
store.set('emoji-last', JSON.stringify({ mode: emojiMode, ta: emojiCurGroup, mine: myCurGroup, pub: pubCurGroup, cat: emojiCat, tg: textCurGroupMap }));
}
// v3.26.x：把上次 tab/分组偏好恢复抽成函数，在模块初始化 + 每次打开面板 + 切换联系人时
// 都用 store 里的 emoji-last 重新落位——确保打开表情包永远落在「上次用的顶部分组 + 上次打开的表情包分组」，
// 不再因为 idbRestore 晚于模块初始化（回填前读空）或切换联系人后没重读而回退到默认「TA 的表情包」。
function loadEmojiPref() {
try {
const pref = JSON.parse(store.get('emoji-last') || 'null');
if (pref && typeof pref === 'object') {
if (pref.mode === 'public' || pref.mode === 'ta' || pref.mode === 'mine') emojiMode = pref.mode;
if (typeof pref.ta === 'string') emojiCurGroup = pref.ta;
if (typeof pref.mine === 'string') myCurGroup = pref.mine;
if (typeof pref.pub === 'string') pubCurGroup = pref.pub;
if (pref.cat === 'sticker' || pref.cat === 'kaomoji' || pref.cat === 'emoji') emojiCat = pref.cat;
if (pref.tg && typeof pref.tg === 'object') textCurGroupMap = pref.tg;
if (emojiCat !== 'sticker' && textCatHidden(emojiCat)) emojiCat = 'sticker'; // #636：上次停在的分类已被隐藏则回表情包
}
} catch (e) {}
}
loadEmojiPref();
function myEmojiLoad() {
// FIX 2026-09-21 #950：大包直存后 memoryCache 可能直驻数组，读回类型感知（不再假设字符串）
try {
const raw = myEmojiStore().get('my-emoji-groups');
const v = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw;
if (Array.isArray(v)) return v;
} catch (e) {}
return [];
}
// FIX 2026-09-05 #172 我的表情包刷新必丢：超启动回填预算的大键（实例 34.93MB）每次刷新都被
// idbRestore 挂起在 __xyIdbDeferredKeys，且大键从不落 localStorage 快照——store 三路全空，
// 唯一恢复链是裸 idbGet 固定 4s+4s 超时，低端机读不完即静默放弃 → 面板永远空（用户视角=
// 每次刷新全丢）；恢复失败期间保存还会把空态写回、把 IDB 全量顶掉。修复三件套（与字卡库
// hydrateScope 同机制）：
//   ① myeApplyIdb：读到 IDB 值后的统一应用（内容更多才覆盖 + 面板开着即重绘，原 tryRestore/
//      reloadMyEmojiFromIdb 两处重复逻辑收口）；
//   ② myeHydrateFallback：idbGet 读空时走 idbHydrateKey 按需取回（6s+8s 慢读友好、成功后
//      进驻存并移出挂起名单），tryRestore 重试穷尽 / reloadMyEmojiFromIdb 共用；
//   ③ myEmojiSave 防覆盖闸门：该键仍挂起（=本会话从未成功恢复全量）时先取回 IDB 全量与
//      内存新增按分组去重合并再写，防几十 MB 表情包被小包覆盖成真丢失。
function myeApplyIdb(v) {
try {
const data = typeof v === 'string' ? JSON.parse(v) : v;
if (!Array.isArray(data)) return false;
const cnt = (g) => { let n = 0; g.forEach(x => n += (Array.isArray(x[1]) ? x[1].length : 0)); return n; };
// #172：与内存面板态（myGroups）比张数——挂起场景下 hydrate 会把全量写进 store 层，
// 与内存脱节，若以 store 快照为基准会误判「同量不覆盖」→ 恢复永不落内存（面板仍空）
const lc = Array.isArray(myGroups) ? cnt(myGroups) : -1;
if (lc < 0 || cnt(data) > lc) {
myGroups = data;
if (!emojiPanel.hidden) renderEmojiPanel();
}
// FIX 2026-09-10 #281：本会话已成功应用 IDB 权威值——myEmojiSave 的防盲写闸门据此放行
//（启动取回延迟后，闸门条件从「在挂起名单」扩为「未应用过权威值 或 仍在挂起名单」）
window.__myeIdbApplied = true;
return true;
} catch (e) { return false; }
}
function myeHydrateFallback() {
if (!window.idbHydrateKey) return;
// FIX 2026-09-16 #575：取回期间保持等待态（面板开着已出占位行）；无论取回成功/失败/无值，
//   落定时都要重渲一次——否则占位行会永远挂在那里盖住真空态。
myeLoading = true;
try { if (emojiPanel && !emojiPanel.hidden && emojiMode === 'mine') renderEmojiPanel(); } catch (e) {}
window.idbHydrateKey(MYE_KEY()).then(ok => {
myeLoading = false;
try { const raw = myEmojiStore().get('my-emoji-groups'); if (ok === true && raw) myeApplyIdb(raw); } catch (e) {}
try { if (emojiPanel && !emojiPanel.hidden) renderEmojiPanel(); } catch (e) {}
});
}
function myeSaveJson() { try { return JSON.stringify(myGroups || []); } catch (e) { return '[]'; } }
// ===== FIX 2026-09-21 #950 表情包大包 IDB 数组直存（用户实指「表情包库能超几十 MB」；
// 既有实例 34.93MB/#172、18MB 级/#547。原保存链 myeSaveJson 整包 JSON.stringify 压主线程，
// 包越大点按帧冻结越久，防抖 #943b 只减次数不减单次重量）=====根因＝值以字符串形态走
// xyStore.set：串化是主线程同步的。IndexedDB 本身支持 structured clone 直存对象（在浏览器
// 内部线程完成，免主线程串化；聊天记录已同款直存数组）。修法＝保存按包体积分流：
// ≤2MB 维持原 store.set 字符串路径（串化便宜、全部既有读写/备份/合并链零变化）；
// >2MB 改 window.idbSet(MYE_KEY(), myGroups) 数组直存 + idbMemoSet 把同一数组驻进
// memoryCache（读端三处已兼容对象：myeApplyIdb/跨桌面 mergeInto 的 parseArr 本就双态，
// myEmojiLoad/闸门 merge 两处本次改类型感知）。读回 IDB 得到的是数组，JSON.parse 免了。
// 存储格式向后/向前兼容：老版本读到数组值时 JSON.parse(数组) 失败走 catch＝空态，由
// 防覆盖闸门 hydrate 兜回；新版读到老字符串照常 parse（myeApplyIdb 双态）。
const MYE_DIRECT_LIMIT = 2 * 1024 * 1024;
function myeBytesEst() {
try {
let n = 0;
(myGroups || []).forEach(g => {
if (!g || typeof g !== 'object') { n += 32; return; }
n += String(g[0] || '').length + 64;
const a = g[1];
if (Array.isArray(a)) a.forEach(s => { n += (typeof s === 'string' ? s.length : 64) + 8; });
else n += 64;
});
return n;
} catch (e) { return 0; }
}
function myePersist() {
if (myeBytesEst() > MYE_DIRECT_LIMIT && window.idbSet) {
try { window.idbSet(MYE_KEY(), myGroups || []); } catch (e) {}
try { if (window.idbMemoSet) window.idbMemoSet(MYE_KEY(), myGroups || []); } catch (e2) {}
return;
}
myEmojiStore().set('my-emoji-groups', myeSaveJson());
}
// FIX 2026-09-14 #434 我的表情包「添加后退出浏览器重进全丢」（荣耀10/Edge 多机型同发，
// 用户已关自动清数据）：Edge 杀进程会把最近一批未落盘提交整体回滚（idb.js #82/#88/#226/#229
// 家族，WRJ 写日志只护 ≤64KB 小键，表情包媒体键不在保护范围），叠加这些内核 IDB 事务偶发
// 挂起——xyStore.set 的 IDB 写是 fire-and-forget，加完马上退出浏览器时 LS 回滚+IDB 未提交
// ＝数据无任何持久副本。这里把「已发起写」升级为「已确认落盘」：保存后用 idbSet 结果作
// 持久性信号，失败按 1.5s×n 退避重发（每次重发取当前 myGroups 快照，绝不覆盖新数据），
// 穷尽后明确提示；回前台/离页（visibilitychange/pagehide）有未确认落盘的变更再补一发。
// 幂等：同一份数据多 put 一次无害；健康设备上仅多一次 IDB 事务（媒体添加是低频用户动作）。
let myeDurableTimer = null;
let myeDurablePending = false;
let myeDurableWarned = false;
let myeGateRetry = 0;
function myeEnsureDurable(tries) {
if (!window.idbSet) return;
clearTimeout(myeDurableTimer);
// FIX 2026-09-21 #950：与 myePersist 主写同形态——大包直存数组（重发退避链每轮都取当前
// myGroups 快照，原来每轮都整包 JSON.stringify 一次＝退避重试雪上加霜），小包维持字符串
const val = myeBytesEst() > MYE_DIRECT_LIMIT ? (myGroups || []) : myeSaveJson();
window.idbSet(MYE_KEY(), val).then(ok => {
if (ok) { myeDurablePending = false; myeDurableWarned = false; return; }
myeDurablePending = true;
if (tries < 5) { myeDurableTimer = setTimeout(function () { myeEnsureDurable(tries + 1); }, 1500 * (tries + 1)); return; }
if (!myeDurableWarned) {
myeDurableWarned = true;
try { toast('表情包暂时没能写入本机存储，稍后回到本页会自动补写；重要表情请尽快导出备份'); } catch (e0) {}
}
});
}
// 离页/回前台补写闸（#434）：有未确认落盘的变更就在离页事件里再发一次写
function myeDurableFlush() {
// FIX 2026-09-20 #943b：离页先把防抖中的表情包整包写当场落盘（否则 600ms 窗口内退出会丢这次保存）
try { if (myeSaveTimer) { clearTimeout(myeSaveTimer); myeSaveTimer = null; myEmojiSaveNow(); } } catch (e0) {}
if (myeDurablePending) myeEnsureDurable(0);
}
(function () {
try {
document.addEventListener('visibilitychange', myeDurableFlush);
window.addEventListener('pagehide', myeDurableFlush);
} catch (e) {}
})();
// FIX 2026-09-20 #943b：大包（实例 1.14MB）的 myeSaveJson 整包串化＋IDB put 不再压在面板
// 每次点按的当前帧——拖动排序/连点导入会连续触发 N 次整包写（perfcheck「点按响应最慢 466ms」
// 来源之一）。防抖 600ms trailing 合并成最后一次；离页/回前台由 myeDurableFlush 当场补发，
// 落盘语义不变（进库仍必达）。防盲写闸门逻辑原样保留在 myEmojiSaveNow 内。
var myeSaveTimer = null;
function myEmojiSave() {
if (myeSaveTimer) clearTimeout(myeSaveTimer);
myeSaveTimer = setTimeout(function () { myeSaveTimer = null; myEmojiSaveNow(); }, 600);
return true;
}
function myEmojiSaveNow() {
// #172 防覆盖闸门：挂起名单仍含本键 = 本会话没恢复过全量，盲写会顶掉 IDB 全量
// FIX 2026-09-10 #281：启动取回延迟后（见下方 bootRestore 调度），「尚未成功应用过 IDB
// 权威值」的窗口同样不得盲写——闸门从「在挂起名单」扩为「未应用过权威值 或 仍在挂起名单」
if (window.idbHydrateKey &&
(window.__myeIdbApplied !== true ||
(window.__xyIdbDeferredKeys && window.__xyIdbDeferredKeys.indexOf(MYE_KEY()) >= 0))) {
window.idbHydrateKey(MYE_KEY()).then(ok => {
// 取回失败不写回——防用小包覆盖 IDB 全量；键保持挂起，本会话内下次保存/开面板再试
// FIX #434：不再静默丢——失败退避重试整条保存链（重走闸门取回+合并+落笔），穷尽后提示
if (ok === false) {
myeDurablePending = true;
if (!myeDurableWarned) {
myeDurableWarned = true;
try { toast('表情包正在后台补写，请稍等几秒再退出本页'); } catch (e1) {}
}
if ((myeGateRetry || 0) < 4) { myeGateRetry = (myeGateRetry || 0) + 1; setTimeout(myEmojiSave, 1500 * myeGateRetry); }
return;
}
if (ok === true) {
try {
// FIX 2026-09-21 #950：大包直存后该键可能是数组（memoryCache 直驻对象），读回不再假设字符串
const rawGate = myEmojiStore().get('my-emoji-groups');
const full = typeof rawGate === 'string' ? JSON.parse(rawGate || 'null') : (rawGate || null);
if (Array.isArray(full)) {
full.forEach(g => {
if (!g || typeof g[0] !== 'string' || !Array.isArray(g[1])) return;
let t = myGroups.find(x => x[0] === g[0]);
if (!t) { myGroups.push([g[0], g[1].slice()]); return; }
g[1].forEach(item => { if (t[1].indexOf(item) < 0) t[1].push(item); });
});
}
} catch (e) {}
}
// FIX 2026-09-10 #281：true=取回合并完成；null=健康连接确认 IDB 无此键（新用户空库）。
// 两者之后内存值都可安全落笔，本会话不再走盲写闸门
window.__myeIdbApplied = true;
myeGateRetry = 0;
try { if (window.__mochiPhase) window.__mochiPhase('emoji-groups'); } catch (e0) {}
myePersist();
myeEnsureDurable(0);
});
return true;
}
try { if (window.__mochiPhase) window.__mochiPhase('emoji-groups'); } catch (e0) {}
myePersist();
myeEnsureDurable(0);
return true;
}
// FIX 2026-09-04 #154 朋友圈评论「我的表情包」与聊天面板不同步——把 chat 维护的
// 最新内存副本暴露给 feed.js：本副本经启动 tryRestore / 每次打开面板
// reloadMyEmojiFromIdb 以 IDB 权威值回读自愈；而 store 层对该键可能停在旧 LS 快照
//（大键不回写 LS、启动回填受驻留预算/LS 优先规则限制），朋友圈面板旧读法只看
// store 层，读不到 IDB 新值 → 两侧不同步。
window.getMyEmojiGroups = function () { return myGroups || []; };
(function () {
if (!window.idbGet) return;
let retry = 0;
function tryRestore() {
window.idbGet(MYE_KEY()).then(v => {
// #172：重试穷尽仍读空 → idbHydrateKey 兜底（大键挂起/慢读场景裸 idbGet 永远拿不到值）
if (!v) { if (retry < 3) { retry++; setTimeout(tryRestore, 800 * retry); } else myeHydrateFallback(); return; }
myeApplyIdb(v);
});
}
// FIX 2026-09-10 #281 刷新黑屏卡顿收口②（华为畅享20Pro+Edge 等「刷新黑屏卡顿几分钟」，多机型同现）：
// 启动取回改为「数据就绪后再延迟 4s」——原实现脚本求值即 idbGet(my-emoji-groups 大键，
// #172 实例 34.93MB / 诊断实例 17.26MB)＋主线程 JSON.parse 整包，秒级长任务恰好压在
// 开屏/桌面/聊天首屏渲染的启动关键窗口上（#250 切桌面卡死已同口径治理过 contact-switched，
// 启动路径漏了）。恢复语义不变：表情面板/朋友圈插入面板打开时本就 reloadMyEmojiFromIdb
// 现读权威（#172 防丢主链），保存走上方防盲写闸门；这里只把「整包读+解析」挪出关键窗口。
if (window.__mochiDataReady) setTimeout(tryRestore, 4000);
else document.addEventListener('mochi-restore-done', function () { setTimeout(tryRestore, 4000); });
})();
(function () {
const gStore = myEmojiStore();
let started = false;
const cntOf = (g) => { let n = 0; (g || []).forEach(x => n += (Array.isArray(x[1]) ? x[1].length : 0)); return n; };
function parseArr(v) {
try { const d = typeof v === 'string' ? JSON.parse(v) : v; if (Array.isArray(d)) return d; } catch (e) {}
return null;
}
function mergeInto(merged, src) {
(src || []).forEach(g => {
if (!g || typeof g[0] !== 'string' || !Array.isArray(g[1])) return;
let t = merged.find(x => x[0] === g[0]);
if (!t) { t = [g[0], []]; merged.push(t); }
g[1].forEach(item => { if (t[1].indexOf(item) < 0) t[1].push(item); });
});
}
// FIX 2026-09-28 #1371b：拆源与盖章是两件不可逆的事，收到「全局那一本确认落进库里」这一条回执之后
// 才做（顺序不可反＝#186／#1363 已入库验证的同一条纪律；idbSet 的 true＝oncomplete 已到）。
// 写库没回执＝源键原样留着、戳不盖＝下次开页再合一次（合并按组名并集＝幂等，不丢也不重）。
function myeMigCommit(json) {
const stamp = () => {
try {
(window.getContacts ? window.getContacts() : [{ id: 'default' }]).forEach(c => {
try { window.storeFor(c.id || 'default').remove('my-emoji-groups'); } catch (e0) {}
});
} catch (e1) {}
try { myEmojiStore().set('mye-global-migrated', '1'); } catch (e2) {}
};
if (!window.idbSet) { stamp(); return; }
let p = null;
try { p = window.idbSet(MYE_KEY(), json); } catch (e4) { p = null; }
if (p && p.then) p.then(ok => {
if (ok === true) stamp();
else { try { window.__myeMigHold = (window.__myeMigHold || 0) + 1; } catch (e5) {} }
}, () => { try { window.__myeMigHold = (window.__myeMigHold || 0) + 1; } catch (e6) {} });
else stamp();
}
// FIX 2026-09-28 #1371a：这一本一生只走一次，而原实现把「每一发都没读到」折叠成「库里没有」——
// merged 为空照样把每个桌面的 my-emoji-groups 删掉（xyStore.remove 在数据层是连 IndexedDB 权威副本
// 一起删的）再盖 mye-global-migrated 永不重跑＝用户所见「表情包什么的都没了」且再也回不来。
// 这台报障机「本页被系统回收过 100 次」＝每一发都可能没读到，而其他机型同现（与内核无关）。
// auth＝这一场每一发源键都有终态（读到值／健康连接确认无此键）；判据只问「这一发完成没有」。零机型／零 UA。
function finish(merged, auth) {
const n = cntOf(merged);
// FIX 2026-09-28 #1371a：auth=false（有源键这一发没读到）＝整件事一件都不做——不拆源、不盖章，
// 也**不写**全局那一本：写它＝xyStore.set 顺手 idbSet 把库里可能更全的那本顶掉＝#1361 那把尺正指着
// 的动作。源键原样留着，下次开页再合一次（按组名并集＝幂等，不丢也不重）。
if (!auth) { try { window.__myeMigHold = (window.__myeMigHold || 0) + 1; } catch (e) {} return; }
if (!n) { try { gStore.set('mye-global-migrated', '1'); } catch (e) {} return; } // 每一发都确认没有＝真没有
const json = JSON.stringify(merged);
gStore.set('my-emoji-groups', json);
if (n !== cntOf(myGroups)) {
myGroups = merged;
if (!emojiPanel.hidden) renderEmojiPanel();
}
myeMigCommit(json);
}
function run() {
if (started) return;
started = true;
try {
if (gStore.get('mye-global-migrated') === '1') return;
const cids = ((window.getContacts && window.getContacts()) || [{ id: 'default' }]).map(c => c.id || 'default');
const cur = window.__activeCid || 'default';
const order = cids.indexOf(cur) >= 0 ? [cur].concat(cids.filter(c => c !== cur)) : cids;
const merged = [];
order.forEach(c => { try { mergeInto(merged, parseArr(window.storeFor(c).get('my-emoji-groups'))); } catch (e) {} });
mergeInto(merged, parseArr(gStore.get('my-emoji-groups'))); // 顶层旧键快照（= 顶层键）
// FIX 2026-09-28 #1371a：没有 IDB 这一层时同步层就是全部真相（xyStore.get 读空＝确认没有）；
// 有 IDB 时同步读空只是「LS 那份被剥掉／回填还没轮到」，终态一律由下面那一批发决定。
if (!window.idbGet) { finish(merged, true); return; }
const reads = order.map(c => MYE_G_PREFIX + ':' + c + ':my-emoji-groups');
reads.push(MYE_KEY()); // 顶层旧键 IDB 权威
// FIX 2026-09-28 #1371a：旧写法 reads.map(k => idbGet(k).catch(() => null)) 把「事务挂起／连接被杀／
// 等待窗到点」与「库里真没有」压成同一个 null（#665a 给 idbGet 加的就是这个三态出口，本处一直没接）。
const amb = reads.map(() => ({}));
Promise.all(reads.map((k, i) => window.idbGet(k, amb[i]).catch(() => { amb[i].ambiguous = true; return undefined; }))).then(vals => {
let unread = 0;
vals.forEach((v, i) => { const d = parseArr(v); if (d) mergeInto(merged, d); else if (amb[i] && amb[i].ambiguous) unread++; });
finish(merged, unread === 0);
});
} catch (e) { try { window.__myeMigHold = (window.__myeMigHold || 0) + 1; } catch (e2) {} }
}
if (window.__mochiDataReady) run();
else document.addEventListener('mochi-restore-done', function h() {
document.removeEventListener('mochi-restore-done', h);
run();
});
})();
function quoteValue(q) {
if (!q) return null;
if (q.imgs && q.imgs.length) return { t: q.text, imgs: q.imgs };
return q.text;
}
function sendSticker(src) {
const inputEl = document.getElementById('chat-input');
const text = (inputEl ? (inputEl.textContent || '') : '').trim();
const quote = lastQuote ? { q: quoteValue(lastQuote), s: lastQuote.side, i: lastQuote.idx } : null;
if (quote) { lastQuote = null; renderDraft(); }
if (text) {
lastMineText = text;
const rec = { side: 'out', text: text, parts: [{ k: 'text', v: text }, { k: 'img', v: src, sub: 'sticker' }] };
if (quote) { rec.quote = quote.q; rec.qside = quote.s; if (typeof quote.i === 'number' && quote.i >= 0) rec.qidx = quote.i; }
addRec(rec);
if (inputEl) inputEl.textContent = '';
renderDraft();
if (window.logFish) window.logFish();
scheduleReply();
} else {
lastMineText = src;
const rec = { side: 'out', text: src, type: 'sticker', parts: [{ k: 'img', v: src }] };
if (quote) { rec.quote = quote.q; rec.qside = quote.s; if (typeof quote.i === 'number' && quote.i >= 0) rec.qidx = quote.i; }
addRec(rec);
if (window.logFish) window.logFish();
scheduleReply();
}
closeEmojiPanel();
}
// v3.42.x 表情面板图片懒加载——与字卡库同一机制（data-src + IntersectionObserver）：
// 联系人/公用户组里几十上百张全尺寸表情一次全量解码 = 低端/中端机型主线程卡死、图渲染不出
//（vivoX200S+Edge 跨机型报障：面板表情图加载不出，字卡库（懒加载）与聊天气泡（单张）却正常）。
// 只给进入视口的图补 src；dataURL 延迟解码，令牌 src 交给 media-pool 文档观察器解图。
// FIX 2026-09-14 #435 面板图「加载慢/迟迟不显示」（多机型同发，上一轮懒加载后仍现）：
// ①rootMargin 300px 是按字卡库近全屏列表定的，面板滚动区仅 max-height:40vh——上下各
//   300px 外扩后触发窗口≈3 屏，打开分组瞬间 40+ 张图同时进解码管线＝主线程长任务接连，
//   图反而迟迟画不出。收窄到 120px（面板小容器仍够预读半屏）；
// ②IO 回调一次性把触发区全部图同步补 src——改成泵式分批：进区图的排队列，每 50ms 补
//   一小批（4 张）让出主线程，先到先解码先显示，滚动时泵自然续上（能力不删、无 IO 兜底
//   全量补照旧，零机型分支）。
const emojiLazyQueue = [];   // 已进入触发区待补 src 的 img（FIFO）
let emojiLazyT = null;       // 泵定时器（null=未在泵）
function emojiLazyEnqueue(img, src) {
  // FIX 2026-09-20 #931 可选 src：借用本队列的外部容器（朋友圈贴纸面板）图源是几十 KB 的
  // dataURL，复制进 DOM 的 data-src 属性＝上百 KB×N 的字符串常驻标记里；这里只随队列入一个
  // JS 引用，泵取到该 img 时优先用它。缺省（本面板路径）仍走 data-src，行为一字不变。
  if (src) { try { img.__emojiLazySrc = src; } catch (e) {} }
  if (emojiLazyQueue.indexOf(img) >= 0) return;
  emojiLazyQueue.push(img);
  if (!emojiLazyT) emojiLazyT = setTimeout(emojiLazyPump, 50);
}
// FIX 2026-09-26 #1314：面板里「把 data-src 落到 src」的四处写入点（首屏 kick、懒加载泵、无
// IntersectionObserver 的即时补、后台预热）共用一把尺子＝令牌一律交回池（media-pool 的
// mochiMediaPaint），由池一次写成载荷。旧写法各处自己 im.setAttribute('src', 令牌)，为的是让池的
// 观察器按 img[src^="@@m:"] 捞到这一格、再重写真载荷——代价是每一格都先拿那 44 个字符当**相对
// URL** 真发一次必 404 的请求、随后再从零解码一遍＝用户实报「每次打开图片都闪和重新加载」。
// 空串与池没接入（本文件先于 media-pool 求值的极端情况）时逐字照旧赋值＝最坏情况等于今天，不会更坏。
function emojiPaintSrc(img, src, done) {
  if (src && window.mochiMediaPaint) {
    try { window.mochiMediaPaint(img, src, done || null); return; } catch (e) { img.__moPaint = 0; } // 池抛错：交回原写法
  }
  try { img.setAttribute('src', src || ''); } catch (e2) {}
  if (done) { try { done(true); } catch (e3) {} }
}
function emojiLazyPump() {
  emojiLazyT = null;
  for (let n = 0; n < 4 && emojiLazyQueue.length; n++) {
    const img = emojiLazyQueue.shift();
    if (!img || !img.isConnected) continue; // 重渲染已丢弃的节点不再补
    if ((img.__emojiLazySrc || (img.dataset && img.dataset.src)) && !img.getAttribute('src')) {
      emojiPaintSrc(img, img.__emojiLazySrc || img.dataset.src); // #1314 令牌交回池，不上屏
      if (img.dataset) img.removeAttribute('data-src');
      img.__emojiLazySrc = null; // #931：节点被回收池复活时不得带着上一轮的源
    }
    try { emojiImgObserver.unobserve(img); } catch (e) {}
  }
  if (emojiLazyQueue.length && emojiImgObserver) emojiLazyT = setTimeout(emojiLazyPump, 50);
}
const emojiImgObserver = (('IntersectionObserver' in window) && emojiList)
  ? new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const img = en.target;
      if (img && img.dataset && img.dataset.src) emojiLazyEnqueue(img);
    }
  }, { root: emojiList, rootMargin: '120px 0px' })
  : null;
function emojiAttachLazy(img) {
  if (!img) return;
  if (emojiImgObserver) { try { emojiImgObserver.observe(img); } catch (e) {} }
  else { emojiPaintSrc(img, img.dataset.src || ''); img.removeAttribute('data-src'); } // #1314 令牌交回池
}
// FIX 2026-09-14 #435 面板 img 统一创建：补 decoding="async"（字卡库 img 一直有、面板漏了
// ——大 dataURL 解码不再阻塞主线程渲染帧）
function emojiNewImg(src) {
  const img = document.createElement('img');
  img.decoding = 'async';
  img.dataset.src = src; // v3.42.x 懒加载：进入视口才解码，避免整组全量解码卡主线程
  img.alt = '表情';
  return img;
}
// FIX 2026-09-17 #662 表情包面板「打开/切分组时图片闪一下重新加载」（红米 K80 Chrome 等多机型，
//   用户明说其他设备型号也有）：#457（同内容连开短路）/ #508/#509（字卡库页回收池）/ #617
//   （池键令牌↔原文同身份）三轮都只收口了「连续两次渲染内容完全相同」这一条路径——只要内容签名
//   一变（切分组 A→B→A、切分类/作用域、最近使用区变化、后台令牌化翻转、IDB 回填后重渲…），面板
//   网格仍走 emojiList.innerHTML='' + 全部 img 新建：已解码节点被整批丢弃、浏览器必须从零重新
//   解析/解码每个 dataURL（无头 390×844 实测：G1→G2→G1 回到刚看过的分组，12 个 img 节点全部
//   新建、12 次 load ＝用户看到的「一闪 + 重新加载」）。
//   收口＝沿用字卡库页已实证的「回收池」口径：任何整格重写之前先把旧 img 按「令牌稳定身份」
//   (#547 ccMediaCardIdent：令牌↔原文同一身份) 收进模块级池，新建同身份卡时直接取回旧节点——
//   已解码的零重解码、只带 data-src 的保住排队状态。真正内容变化的卡取不到同身份节点＝照旧新建。
//   零机型 / 零内核分支、零视觉改动：只换「用哪个节点」，DOM 结构与事件绑定完全不变。
const emojiImgPool = new Map();     // 身份 -> [img 节点, ...]（重写前收、重建时取，跨 render 存活）
const EMOJI_IMG_POOL_MAX = 160;     // 池上限：超大库来回滚动时不无限留节点
const EMOJI_IMG_POOL_PER_KEY = 8;   // 同一身份最多留几个（重复卡 / 多分组同图）
function emojiPoolKey(src) {
  try { if (window.ccMediaCardIdent) return window.ccMediaCardIdent(src); } catch (e) {}
  return typeof src === 'string' ? src : String(src);
}
function emojiPoolTrim() {
  // Map 保序：超上限先丢最早收进来的（用户已滚远、最不可能马上回看的那些）
  let total = 0;
  emojiImgPool.forEach(list => { total += list.length; });
  if (total <= EMOJI_IMG_POOL_MAX) return;
  emojiImgPool.forEach((list, k) => { if (total > EMOJI_IMG_POOL_MAX) { total -= list.length; emojiImgPool.delete(k); } });
}
function emojiPoolHarvest() {
  if (!emojiList) return;
  emojiList.querySelectorAll('img').forEach(im => {
    const k = (im.dataset && im.dataset.emojiKey) || '';
    if (!k) return; // 不是本机制建的图（如加载占位行）不入池
    if (im.__pooled) return; // 幂等：同一次重写里被多次回收也只入池一次（防重复取回同一节点）
    im.__pooled = true;
    let list = emojiImgPool.get(k);
    if (!list) { list = []; emojiImgPool.set(k, list); }
    if (list.length < EMOJI_IMG_POOL_PER_KEY) list.push(im);
  });
  emojiPoolTrim();
}
function emojiAdoptImg(src) {
  const k = emojiPoolKey(src);
  const list = emojiImgPool.get(k);
  if (list && list.length) {
    const img = list.pop();
    if (!list.length) emojiImgPool.delete(k);
    img.__pooled = false;
    img.dataset.emojiKey = k;
    return img; // 复活旧节点：src 已解好的原样保留、只带 data-src 的保住排队状态
  }
  const img = emojiNewImg(src);
  img.dataset.emojiKey = k;
  return img;
}
// #662：面板所有「整格重写」统一入口——emojiList.innerHTML 的写入前一律先回收旧 img，
//   renderEmojiPanel / renderEmojiTextPanel 里十余处清空与空态写入（含今后新增的）都自动覆盖，
//   不必逐处改调用点，也就不会被后来的改动漏掉一处。只包这一个节点，作用域不外溢。
//   回收是幂等的（__pooled），与显式的 emojiPoolHarvest() 调用不会重复入池。
try {
  const _emojiIH = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  Object.defineProperty(emojiList, 'innerHTML', {
    get: _emojiIH.get,
    set: function (v) { emojiPoolHarvest(); _emojiIH.set.call(this, v); },
    configurable: true
  });
} catch (e) {}
// FIX 2026-09-14 #435 组内令牌批量预热：TA/公用大库贴纸卡以 @@m:hash 存在，面板图原路径
// =IO 补 src→media-pool 观察器→miss 读 IDB（8 并发排队）→重写 src→再解码，五段异步串行
// ＝冷启动图慢半拍。渲染分组后把组内令牌交给媒体池批量预热（map 命中后观察器同步重写）。
// 延迟 250ms 起——不与面板首屏解码抢主线程；接口内部分批读+会话内去重，重渲染零重复读。
function emojiWarmGroupTokens(arr) {
  if (!window.mochiMediaWarmTokens || !Array.isArray(arr)) return;
  const toks = [];
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i];
    if (typeof s === 'string' && s.indexOf('@@m:') === 0) toks.push(s.slice(4));
  }
  if (toks.length) setTimeout(function () { try { window.mochiMediaWarmTokens(toks); } catch (e) {} }, 250);
}
// FIX 2026-09-14 #457 表情面板每次打开图片重载（多机型同发，用户明说其他设备型号也有）：
// 根因=renderEmojiPanel 无条件 emojiList.innerHTML='' 重建全部 img——浏览器对新建 img 必重新
// 解码 dataURL/重请求令牌图，即使内容与上次完全相同。打开→关闭→再打开同一分组，img 全是
// 新建→每次都重载（低端机解码风暴、流量机型重复请求）。短路=算本次目标内容指纹，与上次成功
// 渲染一致且 DOM 仍在→跳过重建复用现有 img（零机型分支，懒加载/预热/批量管理能力不删）。
let emojiRenderSig = '';
let emojiRecNow = null; // #558 最近使用：renderEmojiPanel 每次渲染先解析一份，签名函数/分组条共用（#457 哨兵锚定本函数签名，参数不扩）
function emojiRenderSigTarget(hts, pn) {
  try {
    var rec = emojiRecNow;
    var grp = emojiMode === 'public' ? pubCurGroup : (emojiMode === 'ta' ? emojiCurGroup : myCurGroup);
    var sig = emojiMode + '|' + grp + '|' + (myBatchMode ? '1' : '0') + '|' + (hts ? '1' : '0') + '|' + (pn || '') + '|';
    var _ident = (typeof window.ccMediaCardIdent === 'function') ? window.ccMediaCardIdent : null;
    if (grp === '__recent__') { // #558 最近使用虚拟分组：内容=按身份回查三池的解析结果
      var rs = (rec && rec.srcs) ? rec.srcs : [];
      if (!rs.length) return sig + 'empty';
      var rl = 0;
      for (var r = 0; r < rs.length; r++) rl += (_ident ? _ident(rs[r]) : rs[r]).length;
      return sig + rs.length + '|' + rl + '|' + (_ident ? _ident(rs[0]) : rs[0]) + '|' + (_ident ? _ident(rs[rs.length - 1]) : rs[rs.length - 1]);
    }
    var arr = null;
    if (emojiMode !== 'mine') {
      var isPub = emojiMode === 'public';
      var groups = (window.getScopedGroups && window.getScopedGroups('sticker', isPub ? 'public' : 'own')) || [];
      for (var i = 0; i < groups.length; i++) { if (groups[i][0] === grp) { arr = groups[i][1]; break; } }
    } else {
      for (var j = 0; j < myGroups.length; j++) { if (myGroups[j][0] === grp) { arr = myGroups[j][1]; break; } }
    }
    if (!arr || !arr.length) return sig + 'empty';
    // FIX 2026-09-16 #547 签名按「令牌稳定身份」算：池视图卡被后台令牌化（dataURL→@@m:token）后
    // 原文变了但显示内容没变，按原文签名会误判内容变化→整面板重建→图片全部重新解析（#457 短路
    // 被翻转账废掉＝「每次开表情包都重新加载」复发）。ccMediaCardIdent（chatcard.js 提供）对两种
    // 形态算同一身份；缺失时退回原文，行为同旧版。
    var sumLen = 0;
    for (var k = 0; k < arr.length; k++) sumLen += (_ident ? _ident(arr[k] || '') : (arr[k] || '')).length;
    var _f = _ident ? _ident(arr[0] || '') : (arr[0] || '');
    var _l = _ident ? _ident(arr[arr.length - 1] || '') : (arr[arr.length - 1] || '');
    return sig + arr.length + '|' + sumLen + '|' + _f + '|' + _l;
  } catch (e) { return ''; }
}
// ===== #558 表情面板「最近使用」=====
// 点击表情（发送/插入信纸）时按「令牌稳定身份」（ccMediaCardIdent，#547 提供：原始大图卡与
// @@m: 令牌卡同一短指纹）记录最近用过的 N 张，全局根键 emoji-recent（跨桌面共享，同
// my-emoji-groups 口径；contacts.js EXCLUDE 已登记防 migrateLegacy 误迁进 default 并删根键）。
// 渲染时按身份回查三池（TA 专属/公用/我的）还原真实 src——令牌化翻转/换桌面后身份不变，
// 当前面板解析不到的表情自动跳过（不显示死项）。
const EMOJI_RECENT_KEY = 'emoji-recent';
const EMOJI_RECENT_MAX = 24;
function recentIdentsAt(key) {
try {
const v = JSON.parse(myEmojiStore().get(key) || '[]');
if (Array.isArray(v)) return v.filter(x => typeof x === 'string' && x).slice(0, EMOJI_RECENT_MAX);
} catch (e) {}
return [];
}
function recentSaveAt(key, ids) {
try { myEmojiStore().set(key, JSON.stringify(ids.slice(0, EMOJI_RECENT_MAX))); } catch (e) {}
}
function emojiRecentIdents() { return recentIdentsAt(EMOJI_RECENT_KEY); }
function emojiRecentSave(ids) { recentSaveAt(EMOJI_RECENT_KEY, ids); }
function emojiRecordRecent(src) {
if (typeof src !== 'string' || !src) return;
const id = (typeof window.ccMediaCardIdent === 'function') ? window.ccMediaCardIdent(src) : src.slice(0, 120);
const ids = emojiRecentIdents().filter(x => x !== id);
ids.unshift(id);
emojiRecentSave(ids);
}
// 最近使用解析：身份集合 → 三池扫描还原（ident 是常数级切片，全库扫描成本可控）；
// 同内容在多分组重复出现时只取首个，防最近区重复占位。
function emojiRecentResolved() {
const ids = emojiRecentIdents();
const srcs = [];
if (ids.length && typeof window.ccMediaCardIdent === 'function') {
const want = {};
ids.forEach((x, i) => { want[x] = i; });
const found = [];
const scan = (arr) => {
(arr || []).forEach(src => {
if (typeof src !== 'string' || !src) return;
const id = window.ccMediaCardIdent(src);
const oi = want[id];
if (oi !== undefined && oi >= 0) { found.push([oi, src]); want[id] = -1; }
});
};
((window.getScopedGroups && window.getScopedGroups('sticker', 'own')) || []).forEach(g => scan(g[1]));
((window.getScopedGroups && window.getScopedGroups('sticker', 'public')) || []).forEach(g => scan(g[1]));
(myGroups || []).forEach(g => scan(g[1]));
found.sort((a, b) => a[0] - b[0]);
found.forEach(x => srcs.push(x[1]));
}
return { ids: ids, srcs: srcs.slice(0, EMOJI_RECENT_MAX) };
}
// ===== #842 颜文字 / emoji 的「最近使用」（用户直派：这两类没有最近使用）=====
// 与 #558 同口径但各分类独立一键（emoji-recent-kaomoji / emoji-recent-emoji，同为全局根键，
// contacts.js EXCLUDE 已登记）。文字卡没有令牌化翻转问题，身份＝原文本身；解析时回查当前分类
// 三池（TA 专属 / 公用 / 我的文字库），池里已删掉的文字自动跳过＝不显示死项。
function textRecentKey() { return EMOJI_RECENT_KEY + '-' + emojiCat; }
function emojiRecordRecentText(t) {
if (typeof t !== 'string' || !t) return;
const key = textRecentKey();
const ids = recentIdentsAt(key).filter(x => x !== t);
ids.unshift(t);
recentSaveAt(key, ids);
}
function textRecentResolved() {
const ids = recentIdentsAt(textRecentKey());
const srcs = [];
if (ids.length) {
const want = {};
ids.forEach((x, i) => { want[x] = i; });
const found = [];
const scan = (arr) => {
(arr || []).forEach(t => {
if (typeof t !== 'string' || !t) return;
const oi = want[t];
if (oi !== undefined && oi >= 0) { found.push([oi, t]); want[t] = -1; }
});
};
((window.getScopedGroups && window.getScopedGroups(emojiCat, 'own')) || []).forEach(g => scan(g[1]));
((window.getScopedGroups && window.getScopedGroups(emojiCat, 'public')) || []).forEach(g => scan(g[1]));
(myTextGroups[emojiCat] || []).forEach(g => scan(g[1]));
found.sort((a, b) => a[0] - b[0]);
found.forEach(x => srcs.push(x[1]));
}
return { ids: ids, srcs: srcs.slice(0, EMOJI_RECENT_MAX) };
}
function renderEmojiGroupsBar(rec) {
if (!emojiGroupsBar) return;
emojiGroupsBar.innerHTML = '';
let list = [];
let cur = '';
if (emojiCat !== 'sticker') {
// #636：文字分类——分组取自当前作用域；没选过（或选的分组不在了）自动落到第一个非空分组
list = textScopeGroups();
cur = textCurGroup();
if (cur !== '__recent__' && (!cur || !list.some(g => g[0] === cur))) { const hit = list.find(g => g[1] && g[1].length); textCurSet(hit ? hit[0] : ''); cur = textCurGroup(); }
} else if (emojiMode === 'public') {
list = (window.getScopedGroups && window.getScopedGroups('sticker', 'public')) || [];
cur = pubCurGroup;
} else if (emojiMode === 'ta') {
list = (window.getScopedGroups && window.getScopedGroups('sticker', 'own')) || [];
cur = emojiCurGroup;
} else {
list = myGroups;
cur = myCurGroup;
}
// #558 「⏱最近使用」chip 排最前；可解析到内容的才显示；我的批量管理模式不显示
//（批量勾选只对分组原卡有意义，最近区走直发路径）；上次停在最近分组但本次不可解析时回落。
// #842：表情包/颜文字/emoji 三分类通用（各自一份根键）
const recChipShow = !!(rec && rec.srcs.length) && !(emojiMode === 'mine' && (emojiCat === 'sticker' ? myBatchMode : myTextBatch));
if (cur === '__recent__' && !recChipShow) cur = '';
if (cur && cur !== '__recent__' && !list.some(g => g[0] === cur)) cur = '';
const chips = (recChipShow ? [['__recent__', '⏱最近使用']] : [])
.concat(list.filter(g => emojiMode === 'mine' ? true : g[1].length).map(g => [g[0], g[0] + g[1].length]));
chips.forEach(([val, label]) => {
const c = document.createElement('span');
c.className = 'emoji-g-chip' + (cur === val ? ' sel' : '');
c.textContent = label;
c.addEventListener('click', (e) => {
e.stopPropagation();
if (emojiCat !== 'sticker') textCurSet(cur === val ? '' : val);
else if (emojiMode === 'public') pubCurGroup = (cur === val ? '' : val);
else if (emojiMode === 'ta') emojiCurGroup = (cur === val ? '' : val);
else myCurGroup = (cur === val ? '' : val);
saveEmojiGroupPref();
renderEmojiPanel();
});
emojiGroupsBar.appendChild(c);
});
}
function renderEmojiGroup(gname, arr, mode) {
const grid = document.createElement('div');
grid.className = 'emoji-grid';
emojiWarmGroupTokens(arr); // #435：组内令牌提前批量预热，不等逐图 miss 读排队
arr.forEach((src, i) => {
const d = document.createElement('div');
d.className = 'emoji-item';
if (mode === 'mine' && myBatchMode) {
const k = gname + '\u0001' + i;
const on = mySel.has(k);
		d.classList.toggle('sel', on);
const img = emojiAdoptImg(src); // #662：优先取回回收池里同身份的旧 img（已解码的零重解码），取不到才新建；#435 统一创建（decoding=async + 懒加载）
		d.appendChild(img);
	emojiAttachLazy(img);
if (on) {
const ck = document.createElement('span');
ck.className = 'emoji-check';
ck.textContent = '✓';
d.appendChild(ck);
}
d.addEventListener('click', () => {
if (mySel.has(k)) mySel.delete(k); else mySel.add(k);
updateBatchCount();
d.classList.toggle('sel', mySel.has(k));
let ck = d.querySelector('.emoji-check');
if (mySel.has(k)) {
if (!ck) { ck = document.createElement('span'); ck.className = 'emoji-check'; ck.textContent = '✓'; d.appendChild(ck); }
} else if (ck) {
ck.remove();
}
});
} else {
const img = emojiAdoptImg(src); // #662：优先取回回收池里同身份的旧 img（已解码的零重解码），取不到才新建；#435 统一创建（decoding=async + 懒加载）
	d.appendChild(img);
	emojiAttachLazy(img);
	d.addEventListener('click', () => {
	try { emojiRecordRecent(src); } catch (e0) {} // #558 最近使用：点击即记录（发送/插入都算）
	if (emojiInsertCb) {
if (!/^data:/i.test(src) && !emojiInsertAllowUrl) { toast('链接保存的表情暂不支持插入信纸，请发送消息使用'); return; }
const cb = emojiInsertCb;
emojiInsertCb = null;
emojiInsertAllowUrl = false;
cb(src);
closeEmojiPanel();
} else {
sendSticker(src);
}
});
}
grid.appendChild(d);
});
emojiList.appendChild(grid);
}
function updateBatchCount() {
if (emojiCat !== 'sticker') { if (emojiBatchCount) emojiBatchCount.textContent = '已选 ' + myTextSel.size + ' 个'; return; } // #636
if (emojiBatchCount) emojiBatchCount.textContent = '已选 ' + mySel.size + ' 张';
}
// ===== #636：颜文字 / emoji 文字分类渲染（无图、无懒加载，不走 #457 指纹短路） =====
function renderEmojiTextPanel(rec) {
const list = textScopeGroups();
const cur = textCurGroup();
const catName = textCatLabel();
if (cur === '__recent__') { // #842 文字分类最近使用虚拟分组（能解析到内容时优先于本作用域空态）
const srcs = (rec && rec.srcs) || [];
if (!srcs.length) {
emojiList.innerHTML = '<div class="emoji-empty">最近使用的' + catName + '不在这里了<br>去分组里点一次就会出现在这里</div>';
return;
}
renderEmojiTextGroup('__recent__', srcs);
return;
}
if (!list.length) {
emojiList.innerHTML = emojiMode === 'mine'
? '<div class="emoji-empty">暂无我的' + catName + '<br>点上方「批量导入」粘贴，一行一个</div>'
: (ccPanelsFetching
? ccLoadRowHtml('正在加载' + catName + '…')
: '<div class="emoji-empty">暂无' + (emojiMode === 'public' ? '公用' : '') + catName + '<br>请到 字卡库 → ' + (emojiMode === 'public' ? '公用字卡' : '专属字卡') + ' → ' + catName + ' 添加</div>');
return;
}
if (!cur || !list.some(x => x[0] === cur)) {
emojiList.innerHTML = '<div class="emoji-empty">点击上方分组查看</div>';
return;
}
const g = list.find(x => x[0] === cur);
if (!g || !g[1].length) { emojiList.innerHTML = '<div class="emoji-empty">该分组暂无内容</div>'; return; }
renderEmojiTextGroup(g[0], g[1]);
}
function renderEmojiTextGroup(gname, arr) {
const grid = document.createElement('div');
grid.className = 'emoji-grid emoji-grid-text' + (emojiCat === 'emoji' ? ' emoji-grid-emoji' : '');
arr.forEach((t, i) => {
const d = document.createElement('div');
d.className = 'emoji-item emoji-text-item';
d.textContent = t;
if (emojiMode === 'mine' && myTextBatch) {
const k = gname + '\u0001' + i;
if (myTextSel.has(k)) { d.classList.add('sel'); const ck = document.createElement('span'); ck.className = 'emoji-check'; ck.textContent = '✓'; d.appendChild(ck); }
d.addEventListener('click', (e) => {
e.stopPropagation();
if (myTextSel.has(k)) myTextSel.delete(k); else myTextSel.add(k);
updateBatchCount();
d.classList.toggle('sel', myTextSel.has(k));
let ck = d.querySelector('.emoji-check');
if (myTextSel.has(k)) { if (!ck) { ck = document.createElement('span'); ck.className = 'emoji-check'; ck.textContent = '✓'; d.appendChild(ck); } }
else if (ck) ck.remove();
});
} else {
d.addEventListener('click', (e) => {
e.stopPropagation();
try { emojiRecordRecentText(t); } catch (e0) {} // #842 最近使用：点击即记录（填入/直发/插入都算）
if (emojiInsertCb) { // 写信/回信插入模式（回调方决定落位，含群聊输入栏，行为不变）
const cb = emojiInsertCb;
emojiInsertCb = null;
emojiInsertAllowUrl = false;
cb(t, 'text');
closeEmojiPanel();
} else if (textCardDirectMode()) {
sendTextCard(t);
} else {
insertTextToChatInput(t); // #691：填入输入栏，面板不关（可连点），发送由用户决定
}
try { d.blur(); } catch (err) {}
});
}
grid.appendChild(d);
});
emojiList.appendChild(grid);
}
// #636：文字字卡发送——镜像 sendSticker 的引用/日志/回复链路，但载荷是纯文字
function sendTextCard(t) {
if (typeof t !== 'string' || !t) return;
lastMineText = t;
const quote = lastQuote ? { q: quoteValue(lastQuote), s: lastQuote.side, i: lastQuote.idx } : null;
if (quote) { lastQuote = null; renderDraft(); }
const rec = { side: 'out', text: t, parts: [{ k: 'text', v: t }] };
if (quote) { rec.quote = quote.q; rec.qside = quote.s; if (typeof quote.i === 'number' && quote.i >= 0) rec.qidx = quote.i; }
addRec(rec);
if (window.logFish) window.logFish();
scheduleReply();
closeEmojiPanel();
}
function renderEmojiPanel() {
if (!emojiList) return;
const hts = taStickerHidden();
// #636：分类行与文字库工具行（JS 注入，template 不动）；被「隐藏」的分类不可停留
ensureEmojiCatBar();
ensureEmojiTextTools();
if (emojiCat !== 'sticker' && textCatHidden(emojiCat)) emojiCat = 'sticker';
if (emojiCatBar) emojiCatBar.querySelectorAll('.emoji-cat-chip').forEach(c => {
const cat = c.dataset.ecat;
c.hidden = cat !== 'sticker' && textCatHidden(cat);
c.classList.toggle('sel', cat === emojiCat);
});
ensureEmojiTextModeBar(); // #691i：文字分类的「点击行为」切换按钮（分类行正下方，与设置里那行同键）
renderEmojiTextModeBar();
if (emojiCat === 'sticker') {
document.querySelectorAll('#emoji-panel .emoji-tab').forEach(t => { if (t.dataset.etab !== 'mine') t.hidden = hts; });
if (hts && emojiMode !== 'mine') emojiMode = 'mine';
}
document.querySelectorAll('#emoji-panel .emoji-tab').forEach(t => t.classList.toggle('sel', t.dataset.etab === emojiMode));
const taTabEl = document.querySelector('#emoji-panel .emoji-tab[data-etab="ta"]');
// #636：作用域 tab 文案跟随分类（公用表情包/公用颜文字/公用 emoji…）
const pubTabEl = document.querySelector('#emoji-panel .emoji-tab[data-etab="public"]');
const mineTabEl = document.querySelector('#emoji-panel .emoji-tab[data-etab="mine"]');
if (taTabEl) taTabEl.textContent = chatPartnerName() + ' 的' + textCatLabel();
if (pubTabEl) pubTabEl.textContent = '公用' + textCatLabel();
if (mineTabEl) mineTabEl.textContent = '我的' + textCatLabel();
if (emojiTools) emojiTools.hidden = !(emojiMode === 'mine' && emojiCat === 'sticker');
if (emojiTextTools) {
emojiTextTools.hidden = !(emojiMode === 'mine' && emojiCat !== 'sticker');
if (mytBatchBtn) mytBatchBtn.textContent = myTextBatch ? '退出批量' : '批量管理';
}
if (emojiBatch) emojiBatch.hidden = !(emojiMode === 'mine' && (emojiCat === 'sticker' ? myBatchMode : myTextBatch));
var rec = emojiCat === 'sticker' ? emojiRecentResolved() : textRecentResolved(); // #558：每次渲染解析一次最近使用（身份回查三池），bar 与最近分组/签名共用；#842 文字分类各解析自己那份
emojiRecNow = rec;
renderEmojiGroupsBar(rec);
if (emojiCat !== 'sticker') { // #636：颜文字/emoji 走文字网格（无图、无懒加载，不做 #457 指纹短路）
emojiList.innerHTML = '';
renderEmojiTextPanel(rec);
return;
}
	// FIX 2026-09-14 #457 内容指纹短路：目标与上次成功渲染一致且 DOM 仍在→跳过重建复用现有 img
	var _sigTarget = emojiRenderSigTarget(hts, taTabEl ? taTabEl.textContent : '');
	if (_sigTarget && _sigTarget === emojiRenderSig && emojiList.firstElementChild) return;
	if (emojiImgObserver) emojiList.querySelectorAll('img[data-src]').forEach(im => { try { emojiImgObserver.unobserve(im); } catch (e) {} }); // v3.42.x
	emojiLazyQueue.length = 0; // #435：重绘丢弃旧节点，待补队列与泵一并作废，防止补到游离节点
	if (emojiLazyT) { clearTimeout(emojiLazyT); emojiLazyT = null; }
	emojiList.innerHTML = '';
if (emojiMode !== 'mine') {
const isPub = emojiMode === 'public';
const groups = (window.getScopedGroups && window.getScopedGroups('sticker', isPub ? 'public' : 'own')) || [];
const emptyAll = isPub
? '<div class="emoji-empty">暂无公用表情包<br>请到 字卡库 → 公用字卡 → 表情包 上传</div>'
: '<div class="emoji-empty">暂无表情包<br>请到 字卡库 → 专属字卡 → 表情包 上传</div>';
if (!groups.length) {
// FIX 2026-09-16 #575：正在从 IDB 取回字卡（iOS 挂后台杀连接时 6~14s）→ 出加载占位，
// 不要把「暂无表情包」空态挂上去（用户会当成字卡丢了）。取回完成由 done 回调重渲替换。
emojiList.innerHTML = ccPanelsFetching ? ccLoadRowHtml('正在加载表情包…') : emptyAll;
if (ccPanelsFetching) { emojiRenderSig = null; return; } // 占位行在 DOM 里：作废 #457 指纹短路，防重渲被跳过
return;
}
const curn = isPub ? pubCurGroup : emojiCurGroup;
if (curn === '__recent__') { // #558 最近使用虚拟分组（渲染走 'ta' 直发路径，不进批量勾选）
if (!rec.srcs.length) {
emojiList.innerHTML = '<div class="emoji-empty">最近使用的表情不在当前桌面了<br>去分组里发一次就会出现在这里</div>';
return;
}
renderEmojiGroup('__recent__', rec.srcs, 'ta');
emojiRenderSig = _sigTarget; // #457 渲染成功保存指纹，下次同内容跳过重建
return;
}
if (!curn || !groups.some(x => x[0] === curn)) {
emojiList.innerHTML = '<div class="emoji-empty">点击上方分组查看表情包</div>';
return;
}
const g = groups.find(x => x[0] === curn);
if (!g || !g[1].length) {
emojiList.innerHTML = isPub
? '<div class="emoji-empty">该分组暂无公用表情包<br>请到 字卡库 → 公用字卡 → 表情包 上传</div>'
: '<div class="emoji-empty">该分组暂无表情包<br>请到 字卡库 → 专属字卡 → 表情包 上传</div>';
return;
}
renderEmojiGroup(g[0], g[1], 'ta');
emojiRenderSig = _sigTarget; // #457 渲染成功保存指纹，下次同内容跳过重建
} else {
// #558 最近使用放在「我的表情包是否为空」之前——最近区能解析 TA 专属/公用池的卡，
// 我的库为空时点它也该出内容（放后面会被「暂无我的表情包」早返回挡掉）
if (myCurGroup === '__recent__' && !myBatchMode) {
if (!rec.srcs.length) {
emojiList.innerHTML = '<div class="emoji-empty">最近使用的表情不在当前桌面了<br>去分组里发一次就会出现在这里</div>';
return;
}
renderEmojiGroup('__recent__', rec.srcs, 'ta');
emojiRenderSig = _sigTarget;
return;
}
if (!myGroups.length) {
// FIX 2026-09-16 #575：我的表情包大键（18MB 级、只进 IDB）取回中 → 同上出加载占位
emojiList.innerHTML = myeLoading
? ccLoadRowHtml('正在加载我的表情包…')
: '<div class="emoji-empty">暂无我的表情包<br>点击上方「添加」上传，或「新建分组」</div>';
if (myeLoading) { emojiRenderSig = null; return; }
return;
}
if (!myCurGroup) {
emojiList.innerHTML = '<div class="emoji-empty">点击上方分组查看表情包</div>';
return;
}
const g = myGroups.find(x => x[0] === myCurGroup);
if (!g || !g[1].length) {
emojiList.innerHTML = '<div class="emoji-empty">该分组暂无表情包<br>点击「添加」上传到该分组</div>';
return;
}
renderEmojiGroup(g[0], g[1], 'mine');
updateBatchCount();
emojiRenderSig = _sigTarget; // #457 渲染成功保存指纹，下次同内容跳过重建
}
}
let emojiShowToken = 0; // #692：面板「解码后再显示」的世代令牌——等待期间关闭/重开即作废，防空回调把面板又弹出来
function openEmojiPanel() {
if (!emojiPanel) return;
loadEmojiPref(); // v3.26.x：打开即按上次用的顶部分组+分组落位（覆盖 idbRestore 晚到 / 切换联系人未重读的场景）
reloadMyEmojiFromIdb();
reloadMyTextFromIdb(); // #636：文字库（颜文字/emoji）首开补一次 IDB 取回
const pc = document.getElementById('poke-card');
if (pc) pc.hidden = true;
if (window.closeAvlib) window.closeAvlib();
document.body.classList.remove('mail-emoji-mode');
myBatchMode = false;
mySel.clear();
myTextBatch = false; // #636
myTextSel.clear();
closeIme(); // v3.5.116：收起输入法，面板完整不被键盘遮挡
renderEmojiPanel();
// FIX 2026-09-17 #662：半框平时是 display:none 挂着的——图在隐藏期间浏览器可以回收已解码位图
//   （中端/低内存机型更积极，用户报的「其他设备型号也有」正对应这条），再打开时整格重新解码
//   ＝「每次打开都闪一下重新加载」。**这条节点身份测不出**（#457/#508/#509/#617 的断言都只看
//   节点有没有被替换，节点一直没换、照样闪），所以在显示前主动 decode 一次：位图还在时 decode
//   立即兑现（不可感知），被回收过时先解码完再显示＝不再出现空帧 / 逐格冒出。
//   #692：不再 120ms 强行显示——解码没完就显示＝用户看到的「空一格再逐张冒出/重新加载」，
//   正是手机端每次打开都闪的直接来源。改为解码结算后再显示；等待期间关闭/重开由世代令牌作废，
//   不会把已经关掉的面板又弹出来（兜底 1s，防 decode 不结算把面板挂死）。
const myToken = ++emojiShowToken;
const showEmoji = function () {
  if (myToken !== emojiShowToken) return; // 等待解码期间被关闭/重开：本次显示作废
  emojiPanel.hidden = false;
  scrollChatBottom();
  if (morePanel) morePanel.hidden = true;
};
emojiShowWhenDecoded(showEmoji, myToken);
hydrateCcForChatPanels(() => { if (emojiPanel && !emojiPanel.hidden) renderEmojiPanel(); });
}
// #662：把面板里已赋 src 的图 decode 完再执行 show（上面 openEmojiPanel 用；头像互动半框同款见
//   avatar-lib.js 的 avShowWhenDecoded）。decode() 只影响位图缓存，不改 src、不新建节点、不动布局。
// FIX 2026-09-17 #704：只等「首屏范围」的解码，不再等全部——旧实现对 emojiList 里所有 img[src]
//   逐张 await decode，大库（几十上百张，位图在隐藏期被低内存机型回收）总解码时长远超 1s 兜底，
//   兜底放行后剩余图逐张冒出＝用户看到的「每次打开所有图片都重新加载」（#692 的 1s 兜底恰是
//   大库机型的常规路径而非保险）。收口：①#704 前几张 data-src 图同步补 src（不等 50ms/4 张的泵，
//   首屏别干等）；②按 DOM 序前 EMOJI_DECODE_AWAIT_MAX 张（≈首屏两三行）await decode 后即显示；
//   ③其余已赋 src 的图 fire-and-forget 预热解码，不挡显示（滚动到时位图已就绪或按需即解）。
const EMOJI_DECODE_AWAIT_MAX = 24;
// FIX 2026-09-22 #1011 表情包面板「每次打开图片都会闪烁和重新加载」残留根因（红米 K80 Chrome
//   实报、用户明说其他设备型号也有；#457/#508/#509/#662/#692/#704/#716/#907 八轮之后仍现）。
//   上面那一串修复盯的是「节点有没有被重建」与「位图有没有被回收」，而真机上的那一拍其实是
//   **面板在图片还没就绪时就显示了**：旧等待只对「此刻已经有 src 的图」逐个 await decode()，
//   而首开/整页重载后这一拍一张 src 都没有——懒加载补 src 要等 IO 回调、池令牌解析要读 IDB，
//   jobs 为空 ⇒ 等待当场放行。面板随后才逐张走「令牌当相对 URL 请求→404→池读 IDB→重写 src→
//   解码」四段异步（无头 390×844 实测：面板可见当帧 24 张首屏里 8 张 src 还是 @@m: 令牌、仅 16
//   张解码就绪，可见之后仍发生 21 次 load＋7 次 404 error）＝用户看到的「闪一下再一张张加载」。
//   收口＝把等待判据从「有 src 就 await decode」换成「首屏每张图都拿到真载荷且解码完成」：
//   首屏令牌当场交给媒体池批量解析（不等 250ms 的整组预热班次）、非令牌载荷当场补 src（不等
//   懒加载泵），未就绪的图等自己的 load——池解析完重写 src 会触发 load，池确缺数据时 #397 的
//   「图片缺失」占位图同样会 load ⇒ 等待不再是空的，也不会被挂着不放。兜底 2.5s 不变；等待期间
//   面板不显示，故令牌解析中间态的裂图/alt 文案用户看不到。零机型分支、零新状态、零视觉改动。
function emojiPanelFirstScreen() {
  const out = [];
  if (!emojiList) return out;
  let imgs; try { imgs = emojiList.querySelectorAll('img'); } catch (e) { return out; }
  if (!imgs || !imgs.length) return out;
  let cr = null; try { cr = emojiList.getBoundingClientRect(); } catch (e) {}
  const byRect = !!(cr && cr.height > 4); // 隐藏期 keep-alive 下几何仍成立，首屏按可视区量（量不到退回前 N 张）
  for (let i = 0; i < imgs.length; i++) {
    if (out.length >= 48) break;
    const im = imgs[i];
    if (byRect) {
      let r = null; try { r = im.getBoundingClientRect(); } catch (e) {}
      if (r && r.top > cr.bottom + 80) break; // 视口下沿外的留给懒加载
      if (!r || r.bottom < cr.top - 80) continue; // 已滚上去的（本来就已解码）不占等待名额
      out.push(im);
    } else if (i < EMOJI_DECODE_AWAIT_MAX) out.push(im);
  }
  return out;
}
function emojiKickFirstScreen(imgs) {
  const toks = [];
  for (let i = 0; i < imgs.length; i++) {
    const im = imgs[i];
    let ds = ''; try { ds = (im.dataset && im.dataset.src) || ''; } catch (e) {}
    const pay = ds || im.getAttribute('src') || '';
    if (!pay) continue;
    const isTok = pay.indexOf('@@m:') === 0;
    if (ds && !im.getAttribute('src')) {
      // #1314 令牌不上屏：这一格要显示的是池载荷，就当池载荷一次落到 src（在飞标记 __moPaint 由池摆/由池收，
      //   emojiImgReady 读它）。旧写法先把 @@m:<hash> 这 44 个字符本身写进 src，只为让池的观察器／#435 预热
      //   按 src 捞到它再重写真载荷＝每格两次 src 赋值＋一发注定 404 的相对 URL 请求＋第二次从零解码＝用户
      //   实报「每次打开图片都闪和重新加载」（#1011 的 opacity:0 只藏坏帧，没拿走那发多余请求）。
      //   非令牌载荷（内联 dataURL／外链图）在 emojiPaintSrc 里逐字同旧写法＝一次赋值，行为不变。
      emojiPaintSrc(im, ds);
      try { im.removeAttribute('data-src'); } catch (e) {}
      try { if (emojiImgObserver) emojiImgObserver.unobserve(im); } catch (e) {}
    }
    if (isTok && pay.length > 4) toks.push(pay.slice(4));
  }
  if (toks.length && window.mochiMediaWarmTokens) { try { window.mochiMediaWarmTokens(toks); } catch (e) {} }
}
function emojiImgReady(im) {
  return new Promise(function (res) {
    let done = false;
    const okNow = function () { try { return !!(im.complete && im.naturalWidth > 0); } catch (e) { return false; } };
    const srcNow = function () { try { return im.getAttribute('src') || ''; } catch (e) { return ''; } };
    const off = function () { try { im.removeEventListener('load', settle); im.removeEventListener('error', settle); } catch (e) {} };
    const settle = function () {
      if (done) return;
      if (okNow()) { done = true; off(); res(true); return; }
      if (im.__moPaint) return; // #1314 池的回话还在飞（此刻 src 既没载荷也没令牌）：判「无源」会让面板带着没图的格子打开
      if (srcNow().indexOf('@@m:') !== 0) { done = true; off(); res(false); return; } // 真失败/无源：不挡显示
      // src 还是令牌：池解析完会重写 src 并再触发一次 load，继续等（确缺数据时占位图也会 load）
    };
    try { im.addEventListener('load', settle); im.addEventListener('error', settle); } catch (e) {}
    settle();
    setTimeout(function () { if (!done) { done = true; off(); res(okNow()); } }, 2400); // 单图上限，防个别令牌吊死
  }).then(function () { try { return im.decode ? im.decode().catch(function () {}) : null; } catch (e) { return null; } });
}
function emojiShowWhenDecoded(show, token) {
  let shown = false;
  const fin = function () {
    if (shown) return; shown = true;
    if (token !== undefined && token !== emojiShowToken) return; // #692 已关闭/已重开：本次显示作废
    try { show(); } catch (e) {}
  };
  if (!emojiList || !window.Promise) { fin(); return; }
  const first = emojiPanelFirstScreen();
  if (!first.length) { fin(); return; }
  emojiKickFirstScreen(first);
  const jobs = [];
  for (let i = 0; i < first.length; i++) jobs.push(emojiImgReady(first[i]));
  // 首屏外的图照旧 fire-and-forget 预热解码，不挡显示（#704 纪律不变）
  try {
    const all = emojiList.querySelectorAll('img');
    for (let i = 0; i < all.length; i++) {
      const im = all[i];
      if (first.indexOf(im) >= 0) continue;
      if (im.dataset && im.dataset.src && !im.getAttribute('src')) continue; // 交给懒加载泵
      try { if (im.decode) im.decode().catch(function () {}); } catch (e) {}
    }
  } catch (e) {}
  Promise.all(jobs).then(fin, fin);
  setTimeout(fin, 2500); // #692 兜底：decode 迟迟不结算也不把面板挂死；#716：1s→2.5s，上限仍在防挂死
}
function closeEmojiPanel() {
emojiShowToken++; // #692：作废未兑现的「解码后显示」——等图期间关掉面板不再被自动弹出
if (emojiPanel) emojiPanel.hidden = true;
emojiInsertCb = null;
emojiInsertAllowUrl = false;
}
// ===== FIX 2026-09-20 #907「进桌面前可选提前加载表情包/头像图片」（用户直派：「怎么样可以在
//   进入桌面前可选择进入一个提前加载」；红米 K80 Chrome 实报「每次打开图片都闪＋重新加载，
//   其他设备型号也有」，同族 #457/#508/#509/#662/#692/#704/#716 七轮已收口节点重建与解码时序，
//   残留根因＝hidden 期间位图回收（chat-main.css #907 keep-alive 已收）＋首开前位图从未就绪）。
//   本块＝数据就绪/切桌面后的**空闲预热**：面板没开时把当前分组内容先渲染进面板（#457 指纹
//   随之登记，打开时短路命中零重建）＋首屏 24 张补 src/预解码（位图在缓存里，openEmojiPanel 的
//   解码后显示立即兑现）。开关 chat-panel-prewarm 全局根键（chat-settings 注入行，默认开），
//   关掉＝零预热零开销。调度三点防 startup 抢主线程（#860 刚做完 core 外置，DCL 是红线）：
//   load 后 4s / contact-switched 后 3s / mochi-restore-done 后 6s，且 requestIdleCallback
//   让位（无该接口的内核退 setTimeout 800ms）。幂等：重复调度只保留最后一笔。
let mochiPrewarmT = null;
function chatPanelPrewarmOn() {
try { if (window.xyStore) return window.xyStore('xy-home-v2').get('chat-panel-prewarm') !== '0'; } catch (e) {}
return true; // 键缺失/读异常＝默认开（与设置行缺省一致）
}
function mochiPrewarmEmojiPanel() {
if (!emojiPanel || !emojiPanel.hidden) return; // 开着＝#662 解码后显示自己管
const pg = document.getElementById('page-chat');
if (!pg || pg.hidden) return; // 不在聊天页＝面板无几何，图解码了也进不了视口预热位
try { renderEmojiPanel(); } catch (e) {}
if (!emojiList) return;
const imgs = emojiList.querySelectorAll('img');
let n = 0;
for (let i = 0; i < imgs.length && n < 24; i++) {
const im = imgs[i];
if (im.dataset && im.dataset.src && !im.getAttribute('src')) {
emojiPaintSrc(im, im.dataset.src, function (ok) { if (ok) { try { if (im.decode) im.decode().catch(function () {}); } catch (eD) {} } }); // #1314 令牌交回池；解码发起挪到载荷真落地那一刻
im.removeAttribute('data-src');
n++;
try { if (emojiImgObserver) emojiImgObserver.unobserve(im); } catch (e) {}
}
if (im.getAttribute('src')) { try { if (im.decode) im.decode().catch(function () {}); } catch (e) {} } // #1314 只在「这一格此刻真有源」时解码；在飞的留给池的回话（上面那个 done）
}
}
function schedulePanelPrewarm(delay) {
if (!chatPanelPrewarmOn()) return;
if (mochiPrewarmT) clearTimeout(mochiPrewarmT);
mochiPrewarmT = setTimeout(function () {
mochiPrewarmT = null;
const run = function () {
mochiPrewarmEmojiPanel();
try { if (window.mochiPrewarmAvlib) window.mochiPrewarmAvlib(); } catch (e) {}
};
try { if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 4000 }); else setTimeout(run, 800); } catch (e) { setTimeout(run, 800); }
}, delay || 4000);
}
window.addEventListener('load', function () { schedulePanelPrewarm(4000); });
document.addEventListener('contact-switched', function () { schedulePanelPrewarm(3000); });
document.addEventListener('mochi-restore-done', function () { schedulePanelPrewarm(6000); });
window.schedulePanelPrewarm = schedulePanelPrewarm; // #907 导出：外置 js 经构建包装，顶层函数不上 window（verify 脚本/后续批也要能排班）
// FIX 2026-09-20 #931 把本面板这套图片机制导出给朋友圈贴纸面板复用（feed.js 单一实现、
// 不另起炉灶）：节点回收池（#662）、异步解码建图（#435）、分批补 src 的队列、令牌批量预热
//   （#435/#457）在聊天面板上已实证多轮，本面板复用后不再各写一套。
window.mochiEmojiLazyAdopt = emojiAdoptImg;        // 同身份取回旧节点（已解码的零重解码）
window.mochiEmojiLazyEnqueue = emojiLazyEnqueue;   // 进视口的图交给同一条分批泵（全局每 50ms 补 4 张）
window.mochiEmojiWarmGroupTokens = emojiWarmGroupTokens; // 组内令牌交给媒体池批量预热
function reloadMyEmojiFromIdb() {
if (!window.idbGet) return;
// FIX 2026-09-16 #547 开门闸：本会话已应用过 IDB 权威值且内存非空就不再整包重读——
// 大库设备（my-emoji-groups 18MB 级，只进 IDB 不进 LS）每次开面板都白付一次
// idbGet+JSON.parse（主线程卡顿+堆抖动＝「每次打开都像在加载」）。内存即最新：
// 写入路径（myEmojiSave/添加/删除）、切桌面（全局键不动）、启动链路（bootRestore/#281）
// 各有自己的取回入口，这里只负责「本会话第一次把权威值拉进内存」。
if (window.__myeIdbApplied === true && Array.isArray(myGroups) && myGroups.length) return;
// FIX 2026-09-16 #575：本会话还没拿到权威值且内存为空＝马上要等 idbGet（大键还要等 hydrate，
//    iOS 挂后台杀连接时合计 6~14s）。先进入等待态，面板若开着就出「正在加载我的表情包…」，
//    不再让「暂无我的表情包」空态挂在那儿被当成数据丢了。
if (!(Array.isArray(myGroups) && myGroups.length)) {
myeLoading = true;
try { if (emojiPanel && !emojiPanel.hidden && emojiMode === 'mine') renderEmojiPanel(); } catch (e) {}
}
window.idbGet(MYE_KEY()).then(v => {
// #172：读空（大键挂起/事务超时）不再静默放弃 → hydrate 按需取回
if (!v) { myeHydrateFallback(); return; }
myeLoading = false;
myeApplyIdb(v);
try { if (emojiPanel && !emojiPanel.hidden) renderEmojiPanel(); } catch (e) {}
}).catch(() => {
myeLoading = false;
try { if (emojiPanel && !emojiPanel.hidden) renderEmojiPanel(); } catch (e) {}
});
}
document.addEventListener('contact-switched', function () {
// FIX 2026-09-07 #250 切桌面卡死：my-emoji-groups 是全局键（MYE_G_PREFIX 恒 'xy-home-v2'，
// 不随桌面命名空间变），切桌面既不改变它也不清 myGroups——原监听每次切换都
// myEmojiLoad()+reloadMyEmojiFromIdb()，大表情库设备（#172 实例 34.93MB）每次切换
// 整包 JSON.parse ×2 + 重复 35MB 级 idbGet 事务，主线程卡死数秒。模块态与桌面无关，
// 这里只保留按桌面的 tab/分组偏好落位与开着面板的重绘。
loadEmojiPref(); // v3.26.x：切换联系人后按该桌面的上次 tab/分组偏好落位，不复用上一桌面状态
if (!emojiPanel.hidden) renderEmojiPanel();
});
document.addEventListener('hide-ta-sticker-changed', function () {
if (emojiPanel && !emojiPanel.hidden) renderEmojiPanel();
});
document.addEventListener('hide-tab-changed', function () { // #636：颜文字/emoji 分类显隐开关
if (emojiPanel && !emojiPanel.hidden) renderEmojiPanel();
});
window.openEmojiPanelForInsert = function (cb, opts) {
emojiInsertCb = cb || null;
emojiInsertAllowUrl = !!(opts && opts.allowUrl);
emojiTextModeApplies = !!(opts && opts.textModeApplies); // #691i：只有行为真受模式键支配的入口才显示面板内切换按钮
openEmojiPanel();
document.body.classList.add('mail-emoji-mode');
};
window.closeEmojiPanelForInsert = closeEmojiPanel; // #145：群聊表情按钮切换关闭复用（面板同属聊天页共享浮层）
window.closeIme = function () { try { closeIme(); } catch (e) {} };
if (emojiBtn) {
emojiBtn.addEventListener('click', (e) => {
e.stopPropagation();
if (emojiPanel && !emojiPanel.hidden) { closeEmojiPanel(); return; } // #145：再次点击=关闭（按钮切换开关）
emojiInsertCb = null; // 聊天入口始终是发消息
emojiInsertAllowUrl = false;
openEmojiPanel();
});
}
if (emojiClose) emojiClose.addEventListener('click', (e) => { e.stopPropagation(); closeEmojiPanel(); });
document.addEventListener('click', (e) => {
if (emojiPanel && !emojiPanel.hidden && !emojiPanel.contains(e.target) && !emojiBtn.contains(e.target)) closeEmojiPanel();
});
const batchPanel = document.getElementById('batch-panel');
const batchList = document.getElementById('batch-list');
const batchCount = document.getElementById('batch-count');
const batchText = document.getElementById('batch-text');
const batchBtn = document.getElementById('chat-batch-btn');
let batchItems = []; // [{type:'text'|'img'|'sticker', text?, src?}]
let batchPicking = false; // 文件选择器打开期间忽略「点击面板外关闭」，防选图后批量面板被误关
function batchEnabled() {
try { return store.get('cs-batch-send') === '1'; } catch (e) { return false; }
}
function closeBatchPanel() {
if (batchPanel) batchPanel.hidden = true;
try { if (batchText && document.activeElement === batchText) batchText.blur(); } catch (e) {}
}
function openBatchPanel(opts) {
if (!batchPanel) return;
if (opts && typeof opts.onSend === 'function') batchSendTarget = opts.onSend; else batchSendTarget = null;
const pc = document.getElementById('poke-card');
if (pc) pc.hidden = true;
closeEmojiPanel();
if (window.closeAvlib) window.closeAvlib();
closeIme(); // 收起输入法，面板完整不被键盘遮挡
renderBatchList();
batchPanel.hidden = false;
scrollChatBottom();
const morePanel = document.getElementById('chat-more-panel');
if (morePanel) morePanel.hidden = true;
}
// 外部（群聊等）打开批量面板并把条目发到自己的消息列表：window.openBatchPanelFor(onSend)
window.openBatchPanelFor = function (onSend) { openBatchPanel({ onSend: onSend }); };
function renderBatchList() {
if (!batchList) return;
if (batchCount) batchCount.textContent = batchItems.length + ' 条';
batchList.innerHTML = '';
if (!batchItems.length) {
batchList.innerHTML = '<div class="batch-empty">还没有要发送的消息<br>可添加文字 / 表情包 / 图片</div>';
return;
}
batchItems.forEach((it, i) => {
const row = document.createElement('div');
row.className = 'batch-item';
const idx = document.createElement('span');
idx.className = 'batch-item-idx';
idx.textContent = i + 1;
row.appendChild(idx);
if (it.type === 'text') {
const t = document.createElement('span');
t.className = 'batch-item-text';
t.textContent = it.text;
row.appendChild(t);
} else {
const img = document.createElement('img');
img.className = 'batch-item-media';
img.src = it.src;
img.alt = it.type === 'sticker' ? '表情包' : '图片';
row.appendChild(img);
}
const ty = document.createElement('span');
ty.className = 'batch-item-type';
ty.textContent = it.type === 'text' ? '文字' : (it.type === 'sticker' ? '表情包' : '图片');
row.appendChild(ty);
const x = document.createElement('button');
x.className = 'batch-item-x';
x.textContent = '✕';
x.addEventListener('click', () => { batchItems.splice(i, 1); renderBatchList(); });
row.appendChild(x);
batchList.appendChild(row);
});
}
function batchAddText() {
if (!batchText) return;
const v = (batchText.value || '').trim();
if (!v) { toast('请输入文字'); return; }
batchItems.push({ type: 'text', text: v });
batchText.value = '';
renderBatchList();
}
function batchAddImages(files) {
// #1270：走统一解码闸（720px／JPEG 0.85 口径不变）。两处收口：①旧链每张先 FileReader
// 读成 base64 再整幅解码（48MP 照片＝≈10.6MB 字符串＋≈192MB 位图，多选时逐张叠加＝
// 「发图片就卡死白屏」）；②解码失败/画布异常时把 reader 的原始结果整条推进批量条目
// ＝把整张原图塞进聊天记录，下次渲染再解一遍，卡死从此变成常态（与 personalize v3.6.x
// 「失败不再回退存原图」同口径）。现在失败就是失败：给一句实话，不再存那颗雷。
files.forEach(f => {
if (!window.mochiImgIngest) { toast('图片处理组件没加载上（缓存过旧或离线），请重新打开页面再试'); return; }
window.mochiImgIngest(f, { maxSide: 720, quality: 0.85, tag: 'chat-batch' }).then((r) => {
if (!r || r.st !== 'ok') { toast(window.mochiImgIngestMiss(r, '图片')); return; }
batchItems.push({ type: 'img', src: r.data });
renderBatchList();
});
});
}
function sendBatchItem(it) {
if (it.type === 'text') {
lastMineText = it.text;
addRec({ side: 'out', text: it.text, parts: [{ k: 'text', v: it.text }] });
} else if (it.type === 'img') {
lastMineText = it.src;
addRec({ side: 'out', text: it.src, parts: [{ k: 'img', v: it.src, sub: 'image' }] });
} else {
lastMineText = it.src;
addRec({ side: 'out', text: it.src, type: 'sticker', parts: [{ k: 'img', v: it.src }] });
}
}
let batchSendTarget = null; // 群聊等外部页面打开批量面板时设置：function(items) 负责把条目发到自己的消息列表
function sendBatchAll() {
if (!batchItems.length) { toast('还没有要发送的消息'); return; }
const items = batchItems.slice();
batchItems = [];
renderBatchList();
closeBatchPanel();
if (window.playSfx) window.playSfx('out');
if (batchSendTarget) { batchSendTarget(items); if (window.logFish) window.logFish(); toast('已批量发送 ' + items.length + ' 条消息'); return; }
items.forEach(sendBatchItem);
if (window.logFish) window.logFish();
scheduleReply();
toast('已批量发送 ' + items.length + ' 条消息');
}
function syncBatchBtn() {
if (!batchBtn) return;
batchBtn.style.display = batchEnabled() ? '' : 'none';
if (!batchEnabled()) closeBatchPanel();
}
if (batchBtn) {
batchBtn.addEventListener('click', (e) => { e.stopPropagation(); openBatchPanel(); });
}
const batchClose = document.getElementById('batch-close');
if (batchClose) batchClose.addEventListener('click', (e) => { e.stopPropagation(); closeBatchPanel(); });
const batchAdd = document.getElementById('batch-text-add');
if (batchAdd) batchAdd.addEventListener('click', (e) => { e.stopPropagation(); batchAddText(); });
if (batchText) {
batchText.addEventListener('keydown', (e) => {
if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); batchAddText(); }
});
}
const batchEmoji = document.getElementById('batch-emoji');
if (batchEmoji) {
batchEmoji.addEventListener('click', (e) => {
e.stopPropagation();
closeBatchPanel();
if (window.openEmojiPanelForInsert) {
window.openEmojiPanelForInsert((src) => {
batchItems.push({ type: 'sticker', src: src });
renderBatchList();
openBatchPanel(); // 重新打开批量面板，方便继续添加 / 发送
});
} else {
toast('表情包面板暂不可用');
}
});
}
const batchImg = document.getElementById('batch-img');
// FIX 2026-09-21 #1002：批量发送面板「插入图片」铺真·可点 input 层（owner＝统一入口的 input id）
if (batchImg && window.mochiFilePickSurface) window.mochiFilePickSurface(batchImg, { id: 'batch-img-tap', accept: 'image/*', multiple: true, owner: 'mochi-batch-img-pick' });
if (batchImg) {
batchImg.addEventListener('click', (e) => {
e.stopPropagation();
batchPicking = true;
// FIX 2026-09-18 #755：统一走 window.mochiFilePick（原来虽挂文档，但无 label 兜底、accept 迟到，
// 且每次点按现场 new 一个 input 再 remove——常驻复用后不随点按堆节点）
window.mochiFilePick({
id: 'mochi-batch-img-pick', accept: 'image/*', multiple: true,
onFiles: (files) => {
batchPicking = false;
if (files.length) batchAddImages(files);
else toast('没有取到图片，请再选一次');
}
});
});
}
const batchClear = document.getElementById('batch-clear');
if (batchClear) batchClear.addEventListener('click', (e) => { e.stopPropagation(); batchItems = []; renderBatchList(); });
const batchSendAll = document.getElementById('batch-send-all');
if (batchSendAll) batchSendAll.addEventListener('click', (e) => { e.stopPropagation(); sendBatchAll(); });
document.addEventListener('click', (e) => {
if (batchPicking) return;
if (batchPanel && !batchPanel.hidden && !batchPanel.contains(e.target) && batchBtn && !batchBtn.contains(e.target)) closeBatchPanel();
});
document.addEventListener('contact-switched', () => {
batchItems = [];
renderBatchList();
syncBatchBtn();
});
document.addEventListener('batch-send-changed', syncBatchBtn);
syncBatchBtn();
// ============================== v3.27.x #660：输入栏按钮位置（统一管理） ==============================
// 聊天设置 → 功能 →「输入栏按钮」：自定义底部输入栏这一排的左右顺序——含三个「开关型」按钮
// （麦克风 cs-voice-send / 继续说 cs-trigger-bar / 批量发送 cs-batch-send，各自开关打开后才
// 显示）与输入框本身；「发送」是固定收尾的动作按钮，恒在最后、不参与排序。
// 显隐与位置是两件互不影响的独立配置：开关只决定「显不显示」，本项只决定「排在哪里」——
// 开关关闭期间该按钮仍留在排序表里（面板上标「开关未开启」），打开后自动出现在保存的位置。
// 实现用 flex order，而不是把节点 insertBefore 搬来搬去：按钮的事件绑定、其他模块按 id 的
// 引用、以及 #page-chat > .chat-input-row 这条直系选择器依赖的结构全部原样不动，改序是纯
// 视觉层、随时可逆。聊天页与群聊输入栏共用同一份顺序（两处同名 data-io 令牌一批处理）。
// 保存键 cs-input-order（JSON 数组、每联系人独立，与 cs-voice-send/cs-batch-send 同域）。
const INPUT_IO_TOKENS = ['mic', 'continue', 'more', 'emoji', 'input', 'img', 'batch'];
const INPUT_IO_DEFAULT = INPUT_IO_TOKENS.slice();
const INPUT_IO_ORDER_BASE = 10;  // [data-io] 起始序，依次 +10；发送按钮固定 999＝恒在最后
const INPUT_IO_SEND_ORDER = 999;
// 归一化：只认已知令牌、去重，缺失的按默认顺序补齐——存档被改坏或版本增删令牌，
// 都不会让某一排按钮消失或叠在一起
function inputIoNormalize(raw) {
const out = [];
(Array.isArray(raw) ? raw : []).forEach((t) => {
if (INPUT_IO_TOKENS.indexOf(t) >= 0 && out.indexOf(t) < 0) out.push(t);
});
INPUT_IO_TOKENS.forEach((t) => { if (out.indexOf(t) < 0) out.push(t); });
return out;
}
function inputIoRead() {
try { return inputIoNormalize(JSON.parse(store.get('cs-input-order') || 'null')); } catch (e) { return INPUT_IO_DEFAULT.slice(); }
}
function inputIoIsDefault() {
return inputIoRead().join(',') === INPUT_IO_DEFAULT.join(',');
}
function applyInputBtnOrder() {
const order = inputIoRead();
document.querySelectorAll('.chat-input-row').forEach((row) => {
const items = row.querySelectorAll('[data-io]');
items.forEach((el) => {
const i = order.indexOf(el.getAttribute('data-io'));
el.style.order = String(INPUT_IO_ORDER_BASE + (i < 0 ? items.length : i) * 10);
});
const send = row.querySelector('.chat-send');
if (send) send.style.order = String(INPUT_IO_SEND_ORDER);
});
}
// 排序面板（chat-settings.js）经 window.mochiInputOrder 读写同一份顺序；改完派发事件，
// 聊天页与群聊输入栏即时重排（不必切页面，也不用刷新）
window.mochiInputOrder = {
TOKENS: INPUT_IO_TOKENS.slice(),
DEFAULT: INPUT_IO_DEFAULT.slice(),
read: inputIoRead,
isDefault: inputIoIsDefault,
write: function (arr) {
const norm = inputIoNormalize(arr);
try { store.set('cs-input-order', JSON.stringify(norm)); } catch (e) {}
document.dispatchEvent(new Event('chat-input-order-changed'));
return norm;
},
reset: function () {
try { store.remove('cs-input-order'); } catch (e) {}
document.dispatchEvent(new Event('chat-input-order-changed'));
return INPUT_IO_DEFAULT.slice();
},
apply: applyInputBtnOrder
};
document.addEventListener('chat-input-order-changed', applyInputBtnOrder);
document.addEventListener('contact-switched', applyInputBtnOrder);
// idbRestore 异步回填可能晚于本次初始化（回填后 store 里的键才是最终值），就绪后再重排一次
document.addEventListener('mochi-restore-done', applyInputBtnOrder);
// FIX 2026-09-29 #1419：回填只管「LS 空着」那一型；「LS 有值但被内核回滚成旧值」那一型是新值靠
// idb.js 每键标记合并追回来、追完只改 store＋LS 并广播 mochi-wrj-heal。这一排此前没订那一发 ⇒
// 存档已是用户自定义的序、屏上仍是进场时那份默认序（一加 12/OPPO Chrome 实报「刷新重开恢复原样」，
// 无头复现：自愈后 read() 已是新序而 style.order 未变）。零机型／零 UA 分支：只跟随自愈广播重排。
document.addEventListener('mochi-wrj-heal', applyInputBtnOrder); // FIX 2026-09-29 #1419 自愈落库后重排输入栏按钮位置
applyInputBtnOrder();
// ============================== v3.16.x：我可发送语音（录音 → 试听 → 发送） ==============================
// 聊天设置「我可发送语音」（cs-voice-send，每联系人独立）开启后，输入栏左侧显示「麦克风」按钮：
// 点击弹出底部录音半框——MediaRecorder 录音（最长 60 秒，到时自动停）→ 试听 → 以既有语音消息
// 格式「名称|||dataURL」(type:'voice') 入列，渲染/播放/撤回/引用/统计全部复用原语音链路。
const micBtn = document.getElementById('chat-mic-btn');
const voicePanel = document.getElementById('voice-panel');
const VOICE_MAX_MS = 60000;
let voiceStream = null, voiceRec = null, voiceChunks = [], voiceTimer = null, voiceStarting = false; // FIX 2026-09-05 #169 录音启动进行中闸门
let voiceStartTs = 0, voiceDataUrl = '', voiceDur = 0, voiceSilent = false, voicePreviewAudio = null, voiceVisHandler = null;
// FIX 2026-09-07 #228 停止链路兜底：voiceStopping=stop() 已发出但 onstop 未回（防连点偷走新录音机句柄）；
// voiceStopWatchdog=onstop 迟到/丢失 3s 自行结账；voiceStopSettled=本次停止已结账闩（onstop/看门狗/异常
// 三路只走一路）；voiceMimeFallback=指定容器录出空数据后下次改用浏览器默认容器（isTypeSupported 谎报的壳唯一退路）
let voiceStopping = false, voiceStopWatchdog = null, voiceStopSettled = false, voiceMimeFallback = false;
let voiceProbeSeq = 0; // FIX #1308 回执闸轮次号：内核那一窗的回话迟到时，只有「还是当前这一轮」才允许动面板
let voiceStopTs = 0; // FIX #6xx 停止时刻钉死：慢壳 onstop 迟到/看门狗收尾时用「点停止那一刻」算时长，不再按结账瞬间 Date.now() 虚涨（报障：录 3 秒点结束卡住后变 20 秒）
function voiceEnabled() {
try { return store.get('cs-voice-send') === '1'; } catch (e) { return false; }
}
function syncMicBtn() {
if (micBtn) micBtn.style.display = voiceEnabled() ? '' : 'none';
if (!voiceEnabled()) closeVoicePanel();
}
function voiceFmt(sec) {
const m = Math.floor(sec / 60), s = sec % 60;
return (m < 10 ? '0' + m : '' + m) + ':' + (s < 10 ? '0' + s : '' + s);
}
function voiceStopStream() {
if (voiceStream) { try { voiceStream.getTracks().forEach(t => t.stop()); } catch (e) {} voiceStream = null; }
}
function voiceStopPreview() {
if (voicePreviewAudio) { try { voicePreviewAudio.pause(); } catch (e) {} voicePreviewAudio = null; }
const pb = document.getElementById('voice-play-btn');
if (pb) pb.classList.remove('playing');
}
function renderVoiceIdle() {
if (!voicePanel) return;
voicePanel.classList.remove('recording');
const st = document.getElementById('voice-status');
if (st) st.textContent = '点下方按钮开始录音 · 最长 60 秒';
const tm = document.getElementById('voice-time');
if (tm) tm.textContent = '00:00';
const pv = document.getElementById('voice-preview');
if (pv) pv.hidden = true;
const rb = document.getElementById('voice-record-btn');
if (rb) { rb.textContent = '开始录音'; rb.classList.remove('rec'); }
const sb = document.getElementById('voice-send-btn');
if (sb) { sb.disabled = true; sb.textContent = '发送到聊天'; }
}
function closeVoicePanel() {
if (!voicePanel || voicePanel.hidden) return;
stopVoiceRec(true);
voiceStopPreview();
voiceDataUrl = ''; voiceDur = 0;
voicePanel.hidden = true;
renderVoiceIdle();
}
function openVoicePanel(opts) {
if (!voicePanel) return;
if (opts && typeof opts.onSend === 'function') voiceSendTarget = opts.onSend; else voiceSendTarget = null;
const pc = document.getElementById('poke-card');
if (pc) pc.hidden = true;
closeEmojiPanel();
if (window.closeAvlib) window.closeAvlib();
closeIme(); // 收起输入法，面板完整不被键盘遮挡
if (batchPanel) batchPanel.hidden = true;
const morePanel = document.getElementById('chat-more-panel');
if (morePanel) morePanel.hidden = true;
voiceDataUrl = ''; voiceDur = 0;
renderVoiceIdle();
voicePanel.hidden = false;
scrollChatBottom();
}
// 外部（群聊等）打开录音面板并把语音发到自己的消息列表：window.openVoicePanelFor(onSend)
window.openVoicePanelFor = function (onSend) { openVoicePanel({ onSend: onSend }); };
// v3.26.x：区分「标准安卓浏览器」与「iOS/安卓 WebView」——两者的录音格式与麦克风约束
// 偏好不同，荣耀 90/Edge 等标准 Chromium 对 audio/mp4(AAC) 的 MediaRecorder 路径会录出
//「滋啦滋啦」爆音（输入 48k 与 AAC 44.1k 采样率不匹配的已知内核缺陷），而其原生默认的
// audio/webm;codecs=opus 路径稳定无爆音、Chromium 也能正常播放；iOS Safari 只支持
// mp4/aac 可录可播，安卓 WebView（vivo/iQOO 的雨见、微信、QQ/UC/百度自带壳等）对
// webm/opus 能录却解不了（录出来试听/播放没声）——这两种环境仍须走 mp4/aac。
// v3.26.x 收口第二批：WebView 判定收口到 device.js env（mochiDevice.env.isAndroidWebView，
// UA 嗅探唯一处）——此前这里自拼 18 个壳特征的大正则，与 data-backup/music-player/
// bg-keep 各写一套，加新壳特征时容易改漏（收口清单项）。拿不到 UA 保守按 WebView
// 处理的语义保留在 device.js 侧（只影响音质不影响可用）。
function isAndroidWebView() {
try {
  return !!((window.mochiDevice || {}).env || {}).isAndroidWebView;
} catch (e) { return true; } // 拿不到判定源时保守按 WebView 处理（走 mp4/aac，只影响音质不影响可用）
}
// 标准安卓 Chromium（Chrome/Edge 等非内嵌壳）→ webm/opus 优先；iOS/安卓 WebView → mp4/aac 优先
function voiceMimePreferOpus() {
const md = (window.mochiDevice) || {};
return !!md.isAndroid && !isAndroidWebView();
}
function pickVoiceMime() {
if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
if (voiceMimeFallback) return ''; // FIX #228 上个指定容器没录到数据：这轮交浏览器自选默认容器
// 优先级：标准安卓浏览器把 webm/opus 放最前（Chromium 原生默认、稳且无爆音），mp4/aac 兜底；
// iOS/WebView 仍把 mp4/aac 放最前（iOS 唯一可录可播；WebView 对 webm 能录不能播）。
const list = voiceMimePreferOpus()
  ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg;codecs=opus']
  : ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
for (let i = 0; i < list.length; i++) {
try { if (MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (e) {}
}
return '';
}
// 获取麦克风轨道：标准安卓浏览器优先用最普通的 {audio:true}（AGC/降噪默认开，音质干净不爆音、
// 不削波），被设备拒绝再回退「关回声消除/降噪/自动增益 + 单声道」组合；iOS/安卓 WebView 仍先
// 以「关回声消除/降噪/自动增益 + 单声道」请求——这是 vivo/iQOO 等安卓机上「权限开了却录不到声/
// 录出来为空」的已知根因，若该约束组合不被设备支持（OverconstrainedError 等）再回退 {audio:true}，
// 绝不让报障机型彻底录不了。
async function acquireVoiceStream() {
const tries = voiceMimePreferOpus()
  ? [
      { audio: true },
      { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } }
    ]
  : [
      { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } },
      { audio: true }
    ];
let lastErr = null;
for (let i = 0; i < tries.length; i++) {
try { return await navigator.mediaDevices.getUserMedia(tries[i]); } catch (e) { lastErr = e; }
}
throw lastErr;
}
// FIX 2026-09-07 #228 麦克风启动看门狗：雨见等 Gecko 壳/权限委托异常时 getUserMedia 可能既不 resolve
// 也不 reject 永久挂起——#169 的 voiceStarting 闸门会因此永不复位，之后每次点「开始录音」都被静默忽略
// （面板看似点不动、零提示=报障「发不出去语音」）。到时先报错复位让用户能重试；迟到的流直接停轨防麦克风常驻占用。
function acquireVoiceStreamGuarded(ms) {
return new Promise((resolve, reject) => {
let settled = false;
const to = setTimeout(() => {
if (settled) return;
settled = true;
reject(Object.assign(new Error('microphone timeout'), { name: 'TimeoutError' }));
}, ms || 15000);
acquireVoiceStream().then((s) => {
if (settled) { try { s.getTracks().forEach((t) => t.stop()); } catch (e) {} return; } // 迟到的流防泄漏
settled = true; clearTimeout(to); resolve(s);
}).catch((e) => {
if (settled) return;
settled = true; clearTimeout(to); reject(e);
});
});
}
// FIX 2026-09-05 #169（用户报障 OPPO Reno6 5G+雨见浏览器「一直提示已达最长60秒」）：防重入包装。
// startVoiceRec 在 await getUserMedia 期间（慢壳开麦可达数秒，期间按钮文案未变，用户必然连点）
// 重复进入会整体覆盖 voiceRec/voiceStartTs 并把 voiceTimer 覆盖成新 id——旧计时器永久丢失成孤儿，
// 自上次 voiceStartTs 起 60 秒后开始每 250ms 误报「已达最长 60 秒」且永不自停（面板关了仍弹，
// 只能刷新页面），同时第一路 MediaRecorder+麦克风流被覆盖泄漏。进行中的启动直接忽略重复调用。
async function startVoiceRec() {
if (voiceStarting) return;
if (voiceStopping) { toast('正在停止录音，请稍候'); return; } // FIX #228 上一次停止还没结账，忽略本次启动
voiceStarting = true;
try { await startVoiceRecInner(); } finally { voiceStarting = false; }
}
async function startVoiceRecInner() {
voiceStopSettled = false; // FIX #228 新一轮录音：停止结账闩复位
voiceProbeSeq++; // FIX #1308 新一轮录音作废上一轮迟到的内核回执
voiceStopTs = 0; // FIX #6xx 新一轮录音：停止时刻清零，待 stop 时钉住
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
toast('当前浏览器不支持录音'); return;
}
let stream = null;
try {
stream = await acquireVoiceStreamGuarded(15000); // FIX #228 挂起壳 15s 无响应即报错复位，不再永久锁死 voiceStarting
} catch (e) {
toast(e && e.name === 'TimeoutError' ? '麦克风无响应，请检查录音权限或重启浏览器后重试' : (e && e.name === 'NotAllowedError' ? '麦克风权限被拒绝，请在浏览器设置里允许后重试' : '无法访问麦克风'));
return;
}
voiceStopPreview();
voiceStream = stream;
voiceChunks = [];
let rec = null;
try {
const mime = pickVoiceMime();
rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
} catch (e) {}
if (!rec) { voiceStopStream(); toast('当前浏览器不支持录音'); return; }
rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) voiceChunks.push(ev.data); };
rec.onerror = (ev) => {
  try {
    if (voiceTimer) { clearInterval(voiceTimer); voiceTimer = null; }
    if (voiceVisHandler) { document.removeEventListener('visibilitychange', voiceVisHandler); voiceVisHandler = null; }
    if (voiceStopWatchdog) { clearTimeout(voiceStopWatchdog); voiceStopWatchdog = null; } // FIX #228 出错后不会有 onstop，看门狗一并清
    voiceStopping = false;
    voiceStopSettled = true; // FIX #228 错误路径直接销账，不再等 onstop
    voiceStopStream();
    voiceRec = null;
    renderVoiceIdle();
  } catch (e) {}
  toast('录音设备出错，请检查麦克风后重试');
};
rec.onstop = onVoiceRecStop;
voiceRec = rec;
voiceStartTs = Date.now();
voiceSilent = false;
try { rec.start(); } catch (e) { voiceStopStream(); voiceRec = null; toast('录音启动失败'); return; }
voicePanel.classList.add('recording');
const st = document.getElementById('voice-status');
if (st) st.textContent = '正在录音…';
const pv = document.getElementById('voice-preview');
if (pv) pv.hidden = true;
const sb = document.getElementById('voice-send-btn');
if (sb) sb.disabled = true;
const rb = document.getElementById('voice-record-btn');
if (rb) { rb.textContent = '停止录音'; rb.classList.add('rec'); }
voiceVisHandler = () => {
if (document.visibilityState === 'hidden' && voiceRec && voiceRec.state === 'recording') {
stopVoiceRec(false); toast('页面切到后台，录音已停止');
}
};
document.addEventListener('visibilitychange', voiceVisHandler);
if (voiceTimer) { clearInterval(voiceTimer); voiceTimer = null; } // FIX #169 入场先清残留计时器
const voiceTid = setInterval(() => {
// FIX 2026-09-05 #169 计时器自证：非当前录音的孤儿计时器自毁；仅确认仍处 recording 态才判 60s——
// 历史上重复进入录音后，被覆盖丢弃的旧计时器会在停止 60 秒后每 250ms 误报「已达最长 60 秒」不止不休
if (voiceTimer !== voiceTid) { clearInterval(voiceTid); return; }
if (!voiceRec || voiceRec.state !== 'recording') { clearInterval(voiceTid); voiceTimer = null; return; }
const el = Math.floor((Date.now() - voiceStartTs) / 1000);
const tm = document.getElementById('voice-time');
if (tm) tm.textContent = voiceFmt(Math.min(el, 60));
if (Date.now() - voiceStartTs >= VOICE_MAX_MS) { stopVoiceRec(false); toast('已达最长 60 秒，自动停止'); }
}, 250);
voiceTimer = voiceTid;
}
function stopVoiceRec(silent) {
if (voiceTimer) { clearInterval(voiceTimer); voiceTimer = null; }
if (voiceVisHandler) { document.removeEventListener('visibilitychange', voiceVisHandler); voiceVisHandler = null; }
if (silent) voiceSilent = true;
if (voicePanel) voicePanel.classList.remove('recording');
const rb = document.getElementById('voice-record-btn');
if (rb) rb.classList.remove('rec');
if (voiceRec && voiceRec.state === 'recording') {
voiceStopping = true; // FIX #228 结账前挡住重入（连点停止/立刻再开始都会偷句柄）
voiceStopTs = Date.now(); // FIX #6xx 停止时刻钉死：时长按此刻算，不按结账瞬间（慢壳 onstop 迟到会虚涨）
armVoiceStopWatchdog(); // FIX #228 慢壳 onstop 迟到/丢失兜底
const st0 = document.getElementById('voice-status');
if (st0) st0.textContent = '正在停止录音…'; // FIX #6xx 立即反馈：onstop 迟到窗口不再显示定格「正在录音…」像卡死
try { voiceRec.stop(); } catch (e) { voiceFinalizeStop(); } // stop 都抛了就没有 onstop，直接结账（空数据走可见失败）
} else {
voiceStopStream();
}
}
// FIX 2026-09-07 #228：雨见等 Gecko 壳上 ondataavailable/onstop 可能迟到或不来——3 秒后仍未结账就用
// 已到的分片自行收尾；voiceFinalizeStop 幂等（voiceStopSettled 闩），onstop 与看门狗谁先到都只结一次账
function armVoiceStopWatchdog() {
if (voiceStopWatchdog) clearTimeout(voiceStopWatchdog);
voiceStopWatchdog = setTimeout(() => { voiceStopWatchdog = null; voiceFinalizeStop(); }, 3000);
}
function onVoiceRecStop() { voiceFinalizeStop(); }
// FIX 2026-09-07 #228 停止结账统一收口（原 onVoiceRecStop 主体）：空数据不再静默 return（面板永远停在
// 「正在录音…」、发送键永远灰=本次报障症状），改可见失败态+置 voiceMimeFallback 下次换默认容器；
// 录到数据则清兜底标记沿用当前 mime 策略。原「关面板静默丢弃/太短提示」语义保留。
function voiceFinalizeStop() {
if (voiceStopSettled) return;
voiceStopSettled = true;
if (voiceStopWatchdog) { clearTimeout(voiceStopWatchdog); voiceStopWatchdog = null; }
voiceStopping = false;
voiceStopStream();
voiceRec = null;
const wasSilent = voiceSilent;
voiceSilent = false;
// FIX #6xx 时长按「点停止那一刻」算，不按结账瞬间：慢壳 onstop 迟到/看门狗收尾期间 Date.now() 已流逝，
// 原来会导致「录 3 秒点结束→卡住→变 20 秒」的虚涨；voiceStopTs 由 stopVoiceRec 钉住，未钉住兜底 startTs
const stopTs = voiceStopTs || voiceStartTs;
const durSec = Math.max(1, Math.round((stopTs - voiceStartTs) / 1000));
const blob = new Blob(voiceChunks.length ? voiceChunks : [], { type: (voiceChunks[0] && voiceChunks[0].type) || 'audio/webm' });
voiceChunks = [];
const rb = document.getElementById('voice-record-btn');
if (rb) rb.textContent = '重新录音';
if (wasSilent || !blob.size) {
if (!wasSilent) {
voiceMimeFallback = true;
voiceDataUrl = ''; voiceDur = 0;
const sb0 = document.getElementById('voice-send-btn');
if (sb0) sb0.disabled = true;
const st0 = document.getElementById('voice-status');
if (st0) st0.textContent = '没录到声音数据，请重试';
if (rb) rb.textContent = '开始录音';
toast('录音失败：本浏览器没返回声音数据，请再录一次');
}
return; // 关闭面板打断的录音直接丢弃（原语义保留）
}
if (stopTs - voiceStartTs < 800) { toast('录音太短，请录满 1 秒以上'); return; }
// FIX #1308 发送前的内核回执闸：先问一句「这段字节你解得开吗」，解不开就不许进聊天记录。旧结账只看
// `blob.size`，而「只有 36 字节容器头 + 零填充」的空壳有好几 KB＝本次报障那条播不了的语音的真身；
// 一旦发出去就永久坏在历史里，用户每次点播放只得到一句不带原因的提示。三态口径见 chatVoiceReceipt：
// 'no' 才拦（并走 #228 的换容器退路），'unknown'（慢壳这一窗没回话）不许认死、照旧放行只留证。
let _vu = '';
try { _vu = (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(blob) : ''; } catch (e) {}
const _seq = voiceProbeSeq;
(_vu ? window.chatVoiceReceipt(_vu, VOICE_PROBE_MS) : Promise.resolve('unknown')).then((verdict) => {
if (_vu) { try { URL.revokeObjectURL(_vu); } catch (e) {} }
if (_seq !== voiceProbeSeq) return; // 期间已开新一轮录音：这份回执属于上一轮，不许再动面板
if (verdict === 'no') {
chatVoiceWitness('gate', { kind: blob.type || '?', bytes: blob.size });
voiceMimeFallback = true; // FIX #228 同一条退路：这个容器在这台机子上吐了空壳，下一轮交浏览器自选
voiceDataUrl = ''; voiceDur = 0;
const sbG = document.getElementById('voice-send-btn');
if (sbG) sbG.disabled = true;
const stG = document.getElementById('voice-status');
if (stG) stG.textContent = '这次没录到可播放的声音，请重录';
if (rb) rb.textContent = '开始录音';
toast('录音没成功：这次录到的文件里没有声音，请再录一次（下一轮已改用浏览器默认录音格式）');
return;
}
if (verdict === 'unknown') chatVoiceWitness('probe-unknown', { kind: blob.type || '?', bytes: blob.size });
voiceAcceptBlob(blob, durSec);
});
}
// 回执过了闸才把数据交给面板（原 voiceFinalizeStop 尾段，一字未改语义）：读成 dataURL、点亮试听/发送
function voiceAcceptBlob(blob, durSec) {
voiceMimeFallback = false; // FIX #228 本容器录到了可用数据：清兜底标记，沿用当前 mime 选择策略
const fr = new FileReader();
fr.onload = () => {
voiceDataUrl = String(fr.result || '');
voiceDur = durSec;
if (!voiceDataUrl) { toast('录音数据读取失败'); return; }
if (!voicePanel) return;
const tm = document.getElementById('voice-time');
if (tm) tm.textContent = voiceFmt(durSec);
const st = document.getElementById('voice-status');
if (st) st.textContent = '录制完成';
const txt = document.getElementById('voice-preview-txt');
if (txt) txt.textContent = '试听 · ' + durSec + '″';
const pv = document.getElementById('voice-preview');
if (pv) pv.hidden = false;
const sb = document.getElementById('voice-send-btn');
if (sb) { sb.disabled = false; sb.textContent = '发送到聊天'; }
};
fr.onerror = () => { toast('录音数据读取失败'); };
fr.readAsDataURL(blob);
}
async function toggleVoiceRecord() {
if (voiceStopping) return; // FIX #228 停止结账中（onstop 迟到窗口）忽略连点，防新录音机句柄被旧结账偷走
if (voiceRec && voiceRec.state === 'recording') stopVoiceRec(false);
else await startVoiceRec();
}
function toggleVoicePlay() {
if (!voiceDataUrl) { toast('还没有录音'); return; }
if (voicePreviewAudio && !voicePreviewAudio.paused) { voiceStopPreview(); return; }
voiceStopPreview();
const a = new Audio(voiceDataUrl);
voicePreviewAudio = a;
// v3.16.x 修复：把 Audio 元素挂到 DOM 再播——部分安卓 WebView（雨见等）对未挂载的
// Audio 会静默空放（play() 走完却不出声），挂进 DOM 走标准解码管线更稳；播完/出错即卸
a.style.display = 'none';
document.body.appendChild(a);
const detached = () => { try { if (a.parentNode) a.parentNode.removeChild(a); } catch (e) {} if (voicePreviewAudio === a) voicePreviewAudio = null; };
const pb = document.getElementById('voice-play-btn');
if (pb) pb.classList.add('playing');
const cleanup = () => { detached(); voiceStopPreview(); };
// FIX #1308 与气泡播放同一分流、同一判据（chatVoiceUnopenable）：试听是「还没发出去」的那一次机会，
// 说清「这次没录到声音」用户就会当场重录，而不是发进聊天记录后再永远播不了。
let failed = false;
const fail = () => {
if (failed) return;
failed = true;
const dead = chatVoiceUnopenable(a);
chatVoiceWitness(dead ? 'preview' : 'preview-load', Object.assign({ code: a.error ? a.error.code : 0 }, chatVoiceSrcInfo(voiceDataUrl)));
cleanup();
toast(dead ? VOICE_DEAD_MSG : '语音播放失败');
};
a.addEventListener('ended', () => { failed = true; detached(); voiceStopPreview(); });
a.addEventListener('error', fail);
a.play().catch(fail);
}
let voiceSendTarget = null; // 群聊等外部页面打开语音面板时设置：function(dataUrl, durSec) 把录好的语音发到自己的消息列表
function sendVoiceMsg() {
if (!voiceDataUrl) { toast('还没有录音'); return; }
if (voiceSendTarget) {
  const dataUrl = voiceDataUrl, dur = voiceDur;
  closeVoicePanel();
  voiceSendTarget(dataUrl, dur);
  return;
}
const name = '语音 ' + voiceDur + '″';
lastMineText = '[语音]';
addRec({ side: 'out', text: name + '|||' + voiceDataUrl, type: 'voice' });
closeVoicePanel();
if (window.playSfx) window.playSfx('out');
if (window.logFish) window.logFish();
scheduleReply();
}
if (micBtn) micBtn.addEventListener('click', (e) => {
e.stopPropagation();
if (!voicePanel) return;
if (voicePanel.hidden) openVoicePanel(); else closeVoicePanel();
});
const voiceCloseBtn = document.getElementById('voice-close');
if (voiceCloseBtn) voiceCloseBtn.addEventListener('click', (e) => { e.stopPropagation(); closeVoicePanel(); });
const voiceRecordBtnEl = document.getElementById('voice-record-btn');
if (voiceRecordBtnEl) voiceRecordBtnEl.addEventListener('click', (e) => { e.stopPropagation(); toggleVoiceRecord(); });
const voicePlayBtnEl = document.getElementById('voice-play-btn');
if (voicePlayBtnEl) voicePlayBtnEl.addEventListener('click', (e) => { e.stopPropagation(); toggleVoicePlay(); });
const voiceSendBtnEl = document.getElementById('voice-send-btn');
if (voiceSendBtnEl) voiceSendBtnEl.addEventListener('click', (e) => { e.stopPropagation(); sendVoiceMsg(); });
document.addEventListener('click', (e) => {
if (voicePanel && !voicePanel.hidden && !voicePanel.contains(e.target) && micBtn && !micBtn.contains(e.target)) closeVoicePanel();
});
document.addEventListener('contact-switched', () => { closeVoicePanel(); syncMicBtn(); });
document.addEventListener('voice-send-changed', syncMicBtn);
syncMicBtn();
document.querySelectorAll('.emoji-tab').forEach(t => t.addEventListener('click', (e) => {
e.stopPropagation();
emojiMode = t.dataset.etab;
myBatchMode = false;
mySel.clear();
saveEmojiGroupPref();
renderEmojiPanel();
try { t.blur(); } catch (err) {}
}));
// #1270：表情包导入走统一解码闸（img-ingest.js）。旧实现是「带闸的一派」——base64 >8MB
// 直接拒、>2600 万像素在整幅解码之后才拒：这台机子主摄随便一张就是 8000×6000／10.6MB
// base64，两张闸双双命中＝用户报的「给联系人单独添加的表情包和照片没办法导入」；而
// 「解码后才判」那一发已经先付了 ≈192MB 位图＝卡顿白屏。现在先用文件头算尺寸、超预算
// 边解边缩，产物口径（260px／PNG）一字未动。
function compressMyEmoji(src, maxSide) {
if (!window.mochiImgCompressTo) return Promise.resolve(null);
return window.mochiImgCompressTo(src, { maxSide: maxSide, mime: 'image/png', tag: 'myemoji' });
}
const myeNew = document.getElementById('mye-new');
if (myeNew) {
myeNew.addEventListener('click', (e) => {
e.stopPropagation();
if (window.openModal) {
window.openModal('新建表情包分组', '', (v) => {
const name = (v || '').trim();
if (!name) return;
if (myGroups.some(g => g[0] === name)) { toast('分组「' + name + '」已存在'); return; }
myGroups.unshift([name, []]);
myEmojiSave();
myCurGroup = name;
saveEmojiGroupPref();
renderEmojiPanel();
});
}
});
}
const myeAdd = document.getElementById('mye-add');
// FIX 2026-09-21 #1002：表情面板「添加」铺真·可点 input 层（owner＝统一入口的 input id）
if (myeAdd && window.mochiFilePickSurface) window.mochiFilePickSurface(myeAdd, { id: 'mye-add-tap', accept: 'image/*', multiple: true, owner: 'mochi-myemoji-pick' });
if (myeAdd) {
myeAdd.addEventListener('click', (e) => {
e.stopPropagation();
// FIX 2026-09-18 #755：统一走 window.mochiFilePick（原实现 detached＋无 label＋accept 迟到，
// 用户报「点了相册点了图片但没有任何反应」＝选完文件后回调链完全没被触发）
window.mochiFilePick({
id: 'mochi-myemoji-pick', accept: 'image/*', multiple: true,
onFiles: (files) => {
try {
if (!files.length) { toast('没有取到图片，请再选一次'); return; }
let g = null;
if (myCurGroup) g = myGroups.find(x => x[0] === myCurGroup) || null;
if (!g && myGroups.length) g = myGroups[0];
if (!g) { g = ['默认', []]; myGroups.unshift(g); }
let done = 0, okCount = 0;
files.forEach(f => {
const isGif = /image\/gif/i.test(f.type || '') || /\.gif$/i.test(f.name || '');
const miss = (msg) => { done++; if (done === files.length) { myEmojiSave(); renderEmojiPanel(); toast(msg); } };
const hit = (data) => {
g[1].push(data);
okCount++;
done++;
if (done === files.length) {
const ok = myEmojiSave();
myCurGroup = g[0];
saveEmojiGroupPref();
renderEmojiPanel();
if (!ok) toast('存储空间不足：表情已用备用存储，刷新后恢复。请清理不用的表情');
else toast('已添加 ' + okCount + ' 个表情');
}
};
// #1270：静态图不再先 FileReader 读成 base64（4800 万像素照片一份就是 ≈10.6MB 字符串，
// 多选时按张叠加），File 直接进统一解码闸；动图（GIF）保持原样整张存——压成 PNG 会丢掉
// 动画，那条链的 8MB 上限与提示文案一字未动。失败口径仍分两句话：图本身的问题 vs 组件没加载上。
if (!isGif) {
compressMyEmoji(f, 260).then(data => {
if (data) hit(data);
else miss(window.mochiImgCompressTo ? '图片过大或格式不支持，已跳过' : '图片处理组件没加载上（缓存过旧或离线），请重新打开页面再试');
});
return;
}
const reader = new FileReader();
reader.onload = () => {
if (reader.result.length > 8 * 1024 * 1024) { miss('动图过大，已跳过（请用 10MB 以内的 GIF）'); return; }
hit(reader.result);
};
reader.onerror = () => miss('部分图片读取失败');
reader.readAsDataURL(f);
});
} catch (err) { toast('添加表情失败，请重试'); }
}
});
});
}
function splitUrlItems(raw) {
return String(raw || '').split(/\r\n|\r|\n/)
.map(l => l.trim()).filter(Boolean)
.map(line => {
const m = line.match(/^[【\[](.*?)[】\]]\s*(.*)$/);
const rest = m ? (m[2] || '') : line;
const url = rest.trim().replace(/^[<("'\u300a\u201c]+|[>)"'\u300b\u201d]+$/g, '');
return { g: m && m[1].trim() ? m[1].trim() : '', url: url };
})
.filter(x => /^https?:\/\//i.test(x.url));
}
function fetchLinkImage(url, processData) {
const once = (u) => new Promise((resolve) => {
let settled = false;
const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
const timer = setTimeout(() => finish({ st: 'url', v: u }), 12000);
fetch(u, { mode: 'cors' }).then(res => {
if (!res.ok) throw new Error('http' + (res.status || ''));
return res.blob();
}).then(blob => {
if (!/^image\//i.test(blob.type || '')) throw new Error('notimage');
const fr = new FileReader();
fr.onload = () => {
const raw = String(fr.result || '');
if (/image\/gif/i.test(blob.type)) {
finish(raw.length > 8 * 1024 * 1024 ? { st: 'url', v: u } : { st: 'data', v: raw });
return;
}
processData(raw).then(d => finish(d ? { st: 'data', v: d } : { st: 'url', v: u }));
};
fr.onerror = () => finish({ st: 'fail', v: u });
fr.readAsDataURL(blob);
}).catch(err => {
const msg = (err && err.message) || '';
finish(/^notimage|^http/.test(msg) ? { st: 'fail', v: u } : { st: 'url', v: u });
});
});
if (location.protocol === 'https:' && /^http:\/\//i.test(url)) {
return once(url.replace(/^http:\/\//i, 'https://')).then(r => r.st === 'data' ? r : once(url));
}
return once(url);
}
function runLinkPool(urls, worker) {
const out = new Array(urls.length);
let i = 0;
function next() {
if (i >= urls.length) return Promise.resolve();
const idx = i++;
return worker(urls[idx]).then((res) => { out[idx] = res; return next(); });
}
return Promise.all([0, 1, 2, 3].map(() => next())).then(() => out);
}
let myeLinkBusy = false; // 防重复提交：上一批还在抓取时不允许叠开第二批
const myeAddLink = document.getElementById('mye-add-link');
if (myeAddLink) {
myeAddLink.addEventListener('click', (e) => {
e.stopPropagation();
if (myeLinkBusy) { toast('上一批链接还在导入中，请稍等'); return; }
if (!window.openModal) return;
window.openModal('链接导入表情（一行一个链接）', '', (raw, targetGroup) => {
const items = splitUrlItems(raw);
if (!items.length) { toast('没有可导入的图片链接（需以 http(s):// 开头）'); return; }
myeLinkBusy = true;
let newGroups = 0;
const buckets = {};
const resolveBucket = (name) => {
if (!buckets[name]) {
let g = myGroups.find(x => x[0] === name);
if (!g) { g = [name, []]; myGroups.unshift(g); newGroups++; }
buckets[name] = { g: g, seen: new Set(g[1]) }; // 分组内去重：已有表情 + 本次已导入都算重复
}
return buckets[name];
};
const jobs = items.map(it => ({ url: it.url, bucket: resolveBucket(it.g || targetGroup || myCurGroup || '默认') }));
let okData = 0, okUrl = 0, dup = 0, fail = 0, httpSaved = 0;
toast('开始导入 ' + jobs.length + ' 个链接…');
runLinkPool(jobs, (job) => fetchLinkImage(job.url, (d) => compressMyEmoji(d, 260))).then(results => {
results.forEach((res, i) => {
const b = jobs[i].bucket;
if (res.st === 'fail') fail++;
else if (b.seen.has(res.v)) dup++;
else {
b.seen.add(res.v);
b.g[1].push(res.v);
if (res.st === 'data') okData++;
else {
okUrl++;
if (/^http:\/\//i.test(jobs[i].url)) httpSaved++; // 升级 https 抓取也失败才落到这里
}
}
});
const ok = myEmojiSave();
myCurGroup = jobs[0].bucket.g[0];
saveEmojiGroupPref();
renderEmojiPanel();
myeLinkBusy = false;
const got = okData + okUrl;
if (!ok && got) toast('存储空间不足：表情已用备用存储，刷新后恢复。请清理不用的表情');
else toast('已导入 ' + got + ' 个表情' +
(okUrl ? '（其中 ' + okUrl + ' 个按链接保存，需联网显示' + (httpSaved ? '；含 ' + httpSaved + ' 个 http 链接，本站可能拦截不显示' : '') + '）' : '') +
(dup ? '，跳过重复 ' + dup + ' 个' : '') +
(fail ? '，失败 ' + fail + ' 个（非图片地址）' : '') +
(newGroups ? '，新建 ' + newGroups + ' 个分组' : ''));
}, () => {
myeLinkBusy = false;
toast('导入出错，请重试');
});
}, {
textarea: true,
textareaPlaceholder: 'https://example.com/sticker.png\n一行一个链接，可粘贴多个批量导入\n可用【分组名】前缀指定分组，如：【日常】https://…\n\n提示：优先尝试转存为本地图片；图床不允许跨域时按链接保存',
groups: myGroups.map(g => g[0])
});
});
}
const myeBatch = document.getElementById('mye-batch');
if (myeBatch) {
myeBatch.addEventListener('click', (e) => {
e.stopPropagation();
myBatchMode = true;
mySel.clear();
renderEmojiPanel();
});
}
const emojiBatchAll = document.getElementById('emoji-batch-all');
if (emojiBatchAll) {
emojiBatchAll.addEventListener('click', (e) => {
e.stopPropagation();
if (emojiCat !== 'sticker') { // #636：文字库全选当前分组
if (!textCurGroup()) { toast('请先点击上方分组'); return; }
const tkeys = [];
myTextOf().forEach(([gname, arr]) => { if (gname === textCurGroup()) arr.forEach((c, i) => tkeys.push(gname + '\u0001' + i)); });
if (myTextSel.size === tkeys.length && tkeys.length) myTextSel.clear();
else tkeys.forEach(k => myTextSel.add(k));
updateBatchCount();
renderEmojiPanel();
return;
}
if (!myCurGroup) { toast('请先点击上方分组'); return; }
const keys = [];
const list = myGroups.filter(g => g[0] === myCurGroup);
list.forEach(([gname, arr]) => arr.forEach((c, i) => keys.push(gname + '\u0001' + i)));
if (mySel.size === keys.length && keys.length) mySel.clear();
else keys.forEach(k => mySel.add(k));
renderEmojiPanel();
});
}
const emojiBatchDel = document.getElementById('emoji-batch-del');
if (emojiBatchDel) {
emojiBatchDel.addEventListener('click', (e) => {
e.stopPropagation();
if (emojiCat !== 'sticker') { // #636：文字库删除勾选项，顺带清掉删空的分组
if (!myTextSel.size) { toast('请先选择要删除的'); return; }
if (window.openModal) {
window.openModal('删除选中的 ' + myTextSel.size + ' 个？', '', () => {
myTextOf().forEach(([gname, arr]) => {
for (let i = arr.length - 1; i >= 0; i--) { if (myTextSel.has(gname + '\u0001' + i)) arr.splice(i, 1); }
});
myTextGroups[emojiCat] = myTextOf().filter(g => g[1].length);
myTextSel.clear();
myTextSave();
renderEmojiPanel();
}, { noInput: true });
}
return;
}
if (!mySel.size) { toast('请先选择要删除的表情'); return; }
if (window.openModal) {
window.openModal('删除选中的 ' + mySel.size + ' 个表情？', '', () => {
myGroups.forEach(([gname, arr]) => {
for (let i = arr.length - 1; i >= 0; i--) {
if (mySel.has(gname + '\u0001' + i)) arr.splice(i, 1);
}
});
mySel.clear();
myEmojiSave();
renderEmojiPanel();
}, { noInput: true });
}
});
}
const emojiBatchExit = document.getElementById('emoji-batch-exit');
if (emojiBatchExit) {
emojiBatchExit.addEventListener('click', (e) => {
e.stopPropagation();
if (emojiCat !== 'sticker') { myTextBatch = false; myTextSel.clear(); renderEmojiPanel(); return; } // #636
myBatchMode = false;
mySel.clear();
renderEmojiPanel();
});
}
let myMgMask = null;
function openMyEmojiManage() {
if (!myMgMask) {
myMgMask = document.createElement('div');
myMgMask.className = 'mg-mask';
myMgMask.innerHTML =
'<div class="mg-panel my-mg-panel">' +
'<div class="mg-head"><span>管理表情包分组</span><button class="mg-close">✕</button></div>' +
'<div class="mg-list"></div>' +
'<button class="mg-add"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><path d="M12 5v14M5 12h14"/></svg>新建分组</button>' +
'</div>';
document.body.appendChild(myMgMask);
myMgMask.querySelector('.mg-close').addEventListener('click', () => { myMgMask.hidden = true; });
myMgMask.addEventListener('click', (e) => { if (e.target === myMgMask) myMgMask.hidden = true; });
myMgMask.querySelector('.mg-add').addEventListener('click', () => {
if (window.openModal) {
window.openModal('新建表情包分组', '', (v) => {
const name = (v || '').trim();
if (!name) return;
if (myGroups.some(g => g[0] === name)) { toast('分组「' + name + '」已存在'); return; }
myGroups.unshift([name, []]);
myEmojiSave();
myCurGroup = name;
saveEmojiGroupPref();
myMgMask.hidden = true;
renderEmojiPanel();
});
}
});
}
function renderMyMgList() {
const listEl = myMgMask.querySelector('.mg-list');
if (!myGroups.length) { listEl.innerHTML = '<div class="mg-empty">暂无分组，点击下方新建</div>'; return; }
listEl.innerHTML = '';
myGroups.forEach((g, gi) => {
const row = document.createElement('div');
row.className = 'mg-row';
row.innerHTML = '<span class="mg-name">' + g[0] + '</span><span class="mg-count">' + (g[1] || []).length + ' 张</span>' +
'<button class="mg-rn">改名</button><button class="mg-del">✕</button>';
row.querySelector('.mg-rn').addEventListener('click', () => {
if (window.openModal) {
window.openModal('重命名分组', g[0], (v) => {
const name = (v || '').trim();
if (!name || name === g[0]) return;
if (myGroups.some(x => x[0] === name)) { toast('分组「' + name + '」已存在'); return; }
const oldName = g[0];
g[0] = name;
if (myCurGroup === oldName) { myCurGroup = name; saveEmojiGroupPref(); }
mySel.clear();
updateBatchCount();
myEmojiSave();
renderMyMgList();
renderEmojiPanel();
});
}
});
row.querySelector('.mg-del').addEventListener('click', () => {
if (window.openModal) {
window.openModal('删除分组「' + g[0] + '」及其全部表情？', '', () => {
myGroups.splice(gi, 1);
if (myCurGroup === g[0]) { myCurGroup = ''; saveEmojiGroupPref(); }
mySel.clear();
myEmojiSave();
renderMyMgList();
renderEmojiPanel();
}, { noInput: true });
}
});
listEl.appendChild(row);
});
}
myMgMask.hidden = false;
renderMyMgList();
}
const myeManage = document.getElementById('mye-manage');
if (myeManage) {
myeManage.addEventListener('click', (e) => {
e.stopPropagation();
openMyEmojiManage();
});
}
const input = document.getElementById('chat-input');
const send = document.getElementById('chat-send');
const draftEl = document.getElementById('chat-draft');
const draftItems = document.getElementById('chat-draft-items');
const quoteEl = document.getElementById('chat-draft-quote');
let draftImgs = []; // 待发送图片（表情包/图片 dataURL）
function renderQuoteBar() {
if (!quoteEl) return;
quoteEl.innerHTML = '';
if (!lastQuote) { quoteEl.hidden = true; return; }
quoteEl.hidden = false;
const bar = document.createElement('div');
bar.className = 'chat-draft-quote-bar';
const thumb = (lastQuote.imgs && lastQuote.imgs.length) ? lastQuote.imgs[0] : null;
if (thumb) {
const img = document.createElement('img');
img.className = 'chat-draft-quote-img';
img.src = thumb;
img.alt = '';
bar.appendChild(img);
}
const t = document.createElement('span');
t.className = 'chat-draft-quote-text';
const raw = quoteDisplayFit(quoteTextSafe(lastQuote.text || ''), lastQuote.side); // FIX 2026-09-15 #490 预览条与气泡同轨显示（taFit 称呼 + 昵称占位符）
const hidePh = !!(thumb && QUOTE_PLACEHOLDER.test(raw));
t.textContent = (raw.indexOf('data:') === 0 && raw.length > 64)
? (lastQuote.type === 'sticker' ? '表情包' : '图片')
: (hidePh ? '' : (raw || '图片'));
bar.appendChild(t);
const xBtn = document.createElement('button');
xBtn.className = 'chat-draft-x chat-draft-quote-x';
xBtn.textContent = '✕';
xBtn.addEventListener('click', () => {
lastQuote = null;
renderDraft();
});
bar.appendChild(xBtn);
quoteEl.appendChild(bar);
}
function renderDraft() {
if (!draftEl || !draftItems) return;
renderQuoteBar();
draftEl.hidden = !draftImgs.length && !lastQuote;
draftItems.innerHTML = '';
draftImgs.forEach((src, i) => {
const it = document.createElement('div');
it.className = 'chat-draft-item';
const img = document.createElement('img');
img.src = src;
img.alt = '';
const xBtn = document.createElement('button');
xBtn.className = 'chat-draft-x';
xBtn.dataset.i = i;
xBtn.textContent = '✕';
it.appendChild(img);
it.appendChild(xBtn);
xBtn.addEventListener('click', () => {
draftImgs.splice(i, 1);
renderDraft();
});
draftItems.appendChild(it);
});
}
const imgBtn = document.getElementById('chat-img-btn');
if (imgBtn) {
// FIX 2026-09-17 #677：file input 必须先挂进文档再 click()。iOS Safari 对【未挂载】的
//   file input 不保证派发 change / 不保证带上 files（用户报「聊天页发不了图片：加了图片会
//   消失、发不进聊天」，iPhone 13 Pro Max Safari＋主屏幕打开；控制台与诊断错误日志里一条
//   报错都没有＝典型的静默失败）。这里按全站最稳的一条现口径做：**常驻一个隐藏 input**
//   （与 avatar-lib.js bindPoolUpload 同款——那份上传在多机型上一直是正常的），而不是每次
//   新建——既不用在弹选择器期间回收节点（慢选择器上回收会打断选择），也不会随点按堆积。
//   每次 change 后清 value，保证「连着选同一张图」也会再次派发 change。
// FIX 2026-09-18 #753：**本入口当时漏接 #738 的原生 label 激活**（#677 只解决了「挂文档」，
//   没解决「小米系分叉内核忽略 JS 合成 click」）——用户 iPhone 13 Pro Max Safari 复报「聊天
//   界面的插入图片不是相册而是文件管理」。三个叠加原因，必须同时治：
//   ① 这里原写 `fi.style.display='none'`，是 #738 之后全站唯一还在用 display:none 的 file
//      input（avatar-lib #717/#738、personalize、chat-settings、group-chat、feed 都换成了
//      sr-only clip）。部分内核对 display:none 元素的激活更苛刻，且 display:none 是
//      #717/#738 明确点名要消灭的写法 ⇒ 统一回 sr-only clip。
//   ② 无 label 兜底：小米系内核忽略 JS click 时，这一枚按钮就彻底没反应。
//   ③ **属性顺序**：原 accept 写在 click 之前看似没事，但 iOS 首次激活时「accept 还没生效」
//      会退回通用文档选择器（Files），相册反而不在候选里——正是用户看到的现象。改为
//      「先设 accept/multiple 与常驻身份 → 再接 label → 最后才 click」，并在每次打开前重申
//      accept，杜绝任何「带着旧/空 accept 去激活」的窗口。
let chatImgInput = null;
function chatImgPicker() {
if (chatImgInput) {
// 重申 accept（历史版本/外部代码改过也纠回来）——激活前 accept 必须已生效
try { chatImgInput.accept = 'image/*'; } catch (e) {}
return chatImgInput;
}
const fi = document.createElement('input');
fi.type = 'file';
// FIX 2026-09-18 #753：常驻身份（诊断/测试句柄；#739 已立「新增选择入口给稳定 id」的先例）
fi.id = 'chat-img-pick';
// FIX 2026-09-18 #753：sr-only clip 写法（与 #738 五入口同一口径，不再用 display:none）
fi.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:1;margin:0;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;';
// accept 必须落在 click 之前（否则 iOS 首次激活退回文件管理器而非相册）
fi.accept = 'image/*'; fi.multiple = true;
fi.onchange = () => {
const files = Array.prototype.slice.call(fi.files || []);
fi.value = '';
// 空 FileList：iOS 上「选完却没带上文件」会走到这里，原来直接 return、一点反馈都没有
if (!files.length) { toast('没有取到图片，请再选一次'); return; }
files.forEach(addDraftImg);
};
document.body.appendChild(fi);
chatImgInput = fi;
// FIX 2026-09-18 #753：把输入框接上原生 label 激活层（必须等 input 挂进文档、id/accept 就位后）
if (window.mochiFilePickLabel && imgBtn) window.mochiFilePickLabel(imgBtn, fi);
// FIX 2026-09-21 #1002（第九波续）：铺「真·可点 input」层——手指物理落在真 input 上，选择器由浏览器
// 原生默认动作弹出，不再依赖 label 转发 / JS 合成 click / showPicker 任何一条腿。owner＝上面这个
// 常驻 input（它的 onchange 管线一字未改：多选、压缩、空 FileList 提示、发进聊天）。幂等：重复调用只补挂。
if (window.mochiFilePickSurface && imgBtn) window.mochiFilePickSurface(imgBtn, { id: 'chat-img-tap', accept: 'image/*', multiple: true, owner: fi });
return fi;
}
// #1002：输入栏若被别处整段重建，按钮是新节点、上面那层随旧节点消失 ⇒ 每次点按前经本桥幂等补挂一次
function chatImgSurfaceEnsure() {
try {
var fi2 = chatImgPicker();
var btn = document.getElementById('chat-img-btn');
if (window.mochiFilePickSurface && btn) window.mochiFilePickSurface(btn, { id: 'chat-img-tap', accept: 'image/*', multiple: true, owner: fi2 });
} catch (e) {}
}
// FIX 2026-09-18 #753：单聊输入栏可能被 #708「顶栏/底栏位置」等流程整段重建（innerHTML），
// 重建后按钮上是新节点、label 激活层随之丢失 ⇒ 每次点按先幂等补挂一次（不再重复 insert，
// 只在缺失时补），与 feed.js renderCover 重建后补挂同一口径。
function chatImgPickBridge() {
const fi = chatImgPicker();
try { if (window.mochiFilePickLabel && imgBtn) window.mochiFilePickLabel(imgBtn, fi); } catch (e) {}
return fi;
}
// 单张图片：读取 → 解码 → 压缩。任何一步失败都必须【可见】（#677）；#1270 起不再
// 「失败也落一张进草稿」——那一发把原图烤进聊天记录，正是越用越卡的存量雷，见函数内说明。
function addDraftImg(file) {
let settled = false;
const accept = (src, msg) => {
if (settled) return;
settled = true;
draftImgs.push(src);
renderDraft();
if (msg) toast(msg);
};
// FIX 2026-09-18 #677：失败一律可见（原实现 reader.onerror 没接线、解码无超时＝彻底静默空手而归）
// #1270：解码走统一解码闸（720px／JPEG 0.85 口径不变），并收掉这一族里最伤的一颗雷——
// 旧链有 3 条「按原图添加」的回退（解码超时／画布异常／解码报错），把 48MP 原图整张
// （base64 ≈10MB）塞进草稿随后落库；那张图每次渲染都要重新整幅解码，于是「发一次图
// 之后越来越卡、只能大退」变成常态。闸内已含 20 秒看门狗与「空画布不算成功」判定，
// 真解不出来时只提示、不再拿原图兜底。
if (!window.mochiImgIngest) { settled = true; toast('图片处理组件没加载上（缓存过旧或离线），请重新打开页面再试'); return; }
window.mochiImgIngest(file, { maxSide: 720, quality: 0.85, tag: 'chat-draft' }).then((r) => {
if (!r || r.st !== 'ok') { settled = true; toast(window.mochiImgIngestMiss(r, '图片')); return; }
accept(r.data);
});
}
// FIX 2026-09-21 #1002：**绑定时**就铺一次（放在点按处理器里＝第一次点按永远赶不上，用户第一下仍然没反应）
chatImgSurfaceEnsure();
imgBtn.addEventListener('click', (e) => {
e.stopPropagation();
// FIX 2026-09-18 #756：原「点源自 label 就直接 return」会在国产内核（label 存在但不转发）
// 时把 JS 兜底也一并跳过＝用户报的「点了相册点了图片完全没反应」。改为先给原生转发一个
// 窗口期，确认确实没弹出再补 JS click（与全站入口同一口径）。
// FIX 2026-09-20 #920：兜底腿改走全站统一三腿（showPicker→click；小米系对合成 click 静默不弹）
chatImgSurfaceEnsure(); // #1002：点按前幂等补挂真·可点 input 层（按钮被重建过也补回来）
var _fb = () => { window.mochiFilePickFire(chatImgPickBridge(), { onFail: () => toast('无法打开图片选择器，请重试') }); };
if (window.mochiFilePickGuard) window.mochiFilePickGuard(chatImgPickBridge(), _fb);
else _fb();
});
}
function buildParts(text) {
const parts = [];
const t = (text || '').trim();
if (t) parts.push({ k: 'text', v: t });
draftImgs.forEach(src => parts.push({ k: 'img', v: src, sub: 'image' }));
return parts;
}
const SEND_GUARD_MS = 2500;
let lastSendTxt = '', lastSendTs = 0;
// v3.26.x #115：守卫必须只挡「内核迟到写回」，绝不挡用户真实编辑。
// 原缺陷：三处防复活守卫的判据都是「内容与刚发送文本完全一致」——用户重打
// 同一条短句（「好的」「在吗」「嗯」这类）时，第一次 input 事件就命中并被
// 静默 textContent='' 吞掉（红米 K60 至尊版 + Edge 报「输入栏打字不显示、
// 空白、发不出去」，实测这条路径 100% 复现吞字）。
// 两者唯一可靠的区分信号：真实编辑之前一定有用户输入活动（keydown /
// compositionstart / insert 类 beforeinput），内核的迟到写回没有。
let lastUserEditAt = 0, clearAppliedAt = 0;
function userEditedAfterClear() { return lastUserEditAt > clearAppliedAt; }
// FIX 2026-09-17 #664：输入框「仍在聚焦」自记（focusin/focusout）。
// iOS Safari 在 contenteditable 聚焦时【常返回 document.activeElement === <body>】
// （mobile-adapt.js iOS 分支 _textFocused 就是为这同一个内核行为而存在的），
// 于是 clearChatInput 里 `document.activeElement === input` 这个焦点判据在 iOS 上
// 恒不成立 → 走「非聚焦直写 textContent=''」分支——正是本函数注释点名过的那条
// 「输入法把刚提交的组合文本整体写回输入框（迟到、且常不派发 input 事件）」的路径：
// 发出去的消息在输入栏里复活，要等 200ms 的迟到兜底才清掉 ⇒ 用户所见
// 「发消息时底部输入栏这一行弹跳一下然后才恢复正常」（iPhone 主屏幕打开，
// 安卓 activeElement 正常故取 execCommand 分支，无此现象）。
// 判据按【能力/状态】而非机型：只补一个与平台无关的焦点信号，真未聚焦时与改动前一致。
let inputFocused = false;
if (input) {
input.addEventListener('focusin', function () { inputFocused = true; });
input.addEventListener('focusout', function () { inputFocused = false; });
}
// 清空管线的焦点判据：activeElement 可靠时照旧；iOS 报 body 时用自记焦点兜底。
// 刻意【不拿 DOM 选区当判据】：程序化失焦（点卡片/批量发送/切页后）选区常仍留在
// 输入框里，用它判「聚焦」会误判 → 走 execCommand 分支并 input.focus()＝凭空弹输入法。
// focusin/focusout 是与平台无关的真实焦点信号（iOS 上同样可靠派发，见 mobile-adapt
// 的 _textFocused 同款取舍）。
function inputStillFocused() {
try {
return document.activeElement === input || inputFocused;
} catch (e) { return false; }
}
// v3.26.x #215：发送取值兜底——Edge/Chromium 部分内核在点发送的瞬间会把输入栏里
// 尚未提交的组合文本整体撕掉（composition cancel：DOM 直接清空、不派发任何
// input/beforeinput 事件），addMsg(input.innerText) 读到空串 → buildParts 为空 →
// 一条消息都不发出、用户刚打的字静默消失（华为 P50E+Edge 报「发消息气泡里没有
// 文字/文字消失了」，用户明说其他设备型号也有；无头复现：IME 提交文本→零事件
// 清空 DOM→点发送＝消息 0 条且字无踪）。#115 防复活守卫管「发送后内核迟到写回」，
// 管不了「发送瞬间撕文本」这一反向缺口。恢复依据 = 捕获阶段维护的最近输入快照
// _mLastTyped，仅在「innerText/textContent 两个口径都读空、且快照新鲜（真实编辑
// 发生在 15s 内、晚于上次清空）」时启用；正常路径与防重发/防复活守卫零改动。
function readSendText() {
try {
const t = (input.innerText || '').trim() || (input.textContent || '').trim();
if (t) return t;
} catch (e) {}
try {
const snap = (input._mLastTyped || '').trim();
if (snap && userEditedAfterClear() && Date.now() - lastUserEditAt < 15000) return snap;
} catch (e) {}
return '';
}
function clearChatInput() {
if (!input) return;
// 先挂复活守卫再清空——清空动作本身会同步派发 input 事件，守卫需已就位
input._mClearTxt = lastSendTxt || '';
// v3.26.x #215：快照随真实清空一并作废（防隔次发送/跨联系人被旧快照幻影重发）
try { input._mLastTyped = ''; } catch (e) {}
clearAppliedAt = Date.now();
const sentTxt = lastSendTxt || '';
// v3.14.x：vivo Edge 等内核实测——聚焦中的 contenteditable 直写 textContent=''
// 后，输入法会把刚提交的组合文本整体写回输入框（迟到、且常不派发 input 事件），
// 表现为「消息发出去了，聊天框还留着刚发的内容」。聚焦态改走 execCommand 编辑
// 管线删除（浏览器层面终结组合会话，写回无从发生）；非聚焦/不支持再退回直清。
try {
// #664：焦点判据见 inputStillFocused 注释——iOS 上 activeElement 报 body，
// 原判据恒假会把聚焦态误当非聚焦态直写（= 迟到写回复活窗口）
if (input.isContentEditable && inputStillFocused()) {
input.focus();
if (!(document.execCommand && document.execCommand('selectAll', false, null) &&
document.execCommand('delete', false, null))) {
input.textContent = '';
}
} else if (input.isContentEditable) {
input.textContent = '';
}
} catch (e) {
try { input.textContent = ''; } catch (e2) {}
}
try { input.value = ''; } catch (e) {}
// v3.14.x：迟到复活兜底——部分内核重组文本不派发 input（原守卫收不到），定时
// 复查两次；仅当内容与刚发送文本完全一致且仍在防重发窗口内才清，人工重打不受影响
// #664：首次复查提前到 60ms——写回若仍发生（内核不派发 focusin 等极少数情形），
// 复活窗口从 ~200ms 收到 1~2 帧，输入栏不再有肉眼可见的「弹一下」；判据与后两次
// 完全一致（内容全等 + 防重发窗口内 + 用户清空后无真实输入），不吞用户重打的字。
if (sentTxt && input.isContentEditable) {
[60, 200, 800].forEach((ms) => {
setTimeout(() => {
try {
if (!input || !input.isContentEditable) return;
const now = (input.innerText || '').trim();
if (now && now === sentTxt && Date.now() - lastSendTs < SEND_GUARD_MS && !userEditedAfterClear()) {
input.textContent = '';
input._mClearTxt = '';
}
} catch (e) {}
}, ms);
});
}
}
const addMsg = (text) => {
const t0 = (text || '').trim();
if (t0 && t0 === lastSendTxt && Date.now() - lastSendTs < SEND_GUARD_MS && !userEditedAfterClear()) {
// FIX 2026-09-14 #437：双击发送命中防重发守卫同样给反馈不再静默（守卫语义不变：机械双击
// 仍只发 1 条，防内核幽灵双 click＝#115/#215 家族防线；只是让「为什么没发出去」看得见）
try { toast('同样的内容刚发送过，未重复发送'); } catch (e) {}
clearChatInput();
draftImgs = [];
renderDraft();
return;
}
const parts = buildParts(text);
if (!parts.length) return;
const t = t0;
lastMineText = t || (draftImgs.length ? draftImgs[0] : '');
const rec = { side: 'out', text: lastMineText, parts: parts };
if (lastQuote) {
rec.quote = quoteValue(lastQuote);
rec.qside = lastQuote.side;
if (typeof lastQuote.idx === 'number' && lastQuote.idx >= 0) rec.qidx = lastQuote.idx;
lastQuote = null;
}
addRec(rec);
lastSendTxt = t;
lastSendTs = Date.now();
try { if (window.cjianNoteChat) window.cjianNoteChat(); } catch (err) {}
if (window.playSfx) window.playSfx('out');
clearChatInput();
draftImgs = [];
renderDraft();
if (window.logFish) window.logFish();
try { window.__replyOnceDiag = 0; console.log('[mochi-reply] addMsg 发送, 重置 replyOnce 计数'); } catch(e){}
scheduleReply();
};
if (send) {
// v3.30.x：点发送不收输入法——点按按钮的 mousedown 默认把焦点从输入框抢走（移动端键盘随即收起），
// preventDefault 阻止焦点转移；发送后回焦输入框兜底（部分内核 click 路径仍会失焦，见 FIX-REGRESSION #127）
send.addEventListener('mousedown', (e) => { e.preventDefault(); });
send.addEventListener('click', () => { addMsg(readSendText()); try { input.focus(); } catch (e) {} });
}
// v3.17.x：删除了此前的 pointerup 监听——它在 click 之前把 lastSendTs 刷新为当前时间，
// 使 addMsg 的防重发守卫（t0===lastSendTxt 且间隔<2.5s）对「用户重新输入相同文本后
// 再点发送」必然命中：消息被吞、输入框被清空（红米 K80 Chrome 反馈「点发送无法发送」，
// 发「嗯/好的/在吗」等重复短句必现）。双击防重仍由守卫承担：真实双击时第二次 click
// 距上次发送 <2.5s 且文本相同，同样会命中守卫，不会重复发送。
if (input) {
// v3.26.x #115：真实输入活动跟踪（守卫判据来源）——捕获阶段早于 input 事件，
// 用户敲的每一键/每一次组合开始/每一次插入式编辑都会刷新 lastUserEditAt；
// 内核的迟到写回不会（它没有对应的输入活动）。beforeinput 只认 insert* 类型，
// delete* 不算「把文本打进来」。老内核无 beforeinput 也不影响（前两类已覆盖）。
try {
input.addEventListener('keydown', () => { lastUserEditAt = Date.now(); }, true);
input.addEventListener('compositionstart', () => { lastUserEditAt = Date.now(); }, true);
input.addEventListener('beforeinput', (e) => {
if (!e || typeof e.inputType !== 'string' || e.inputType.indexOf('insert') === 0) lastUserEditAt = Date.now();
}, true);
// v3.26.x #215：最近输入快照（捕获阶段独立监听，守卫监听的 _mClearTxt 早退不影响它）——
// 每次输入事件都刷新，含手动全删（快照归空＝不可能幻影恢复）；内核撕文本不发事件，
// 撕掉前最后一次快照即恢复依据（见 readSendText）
input.addEventListener('input', function () { try { input._mLastTyped = input.innerText || ''; } catch (e) {} }, true);
} catch (e) {}
input.addEventListener('input', () => {
if (!input._mClearTxt) return;
const now = input.innerText.trim();
if (now === input._mClearTxt && Date.now() - lastSendTs < SEND_GUARD_MS) {
// 本次清空之后用户真打过字＝重发了同一条内容，放行（原实现在此静默清框，
// 用户看到的就是「输入的字不显示、空白」）；只有无输入活动的迟到写回才清。
if (userEditedAfterClear()) { input._mClearTxt = ''; return; }
input.textContent = '';
input._mClearTxt = '';
} else if (now && now !== input._mClearTxt) {
input._mClearTxt = '';
}
});
input.addEventListener('keydown', (e) => {
if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
// 聊天设置「回车键发送消息」关闭时不发送：不 preventDefault，安卓 ce-box 走原事件默认行为插入换行
try { if (store.get('cs-enter-send') === 'off') return; } catch (err) {}
e.preventDefault();
addMsg(readSendText());
}
});
}
function bootAutoSend() {
if (window.replyCfg) scheduleAutoSend();
else setTimeout(bootAutoSend, 500);
}
window.enterChat = enterChat;
// v3.17.x：跨桌面「来消息」用——incoming-requests.js 切桌面后轮询等待本桌面聊天
// 加载就绪（contact-switched 会把 msgs=[]、chatDbReady=false，loadMsgs 异步读完才置 true），
// 就绪后再让 TA 发话，保证消息落进刚加载好的记录里。
// v3.17.x：跨桌面「来消息」用——本桌面聊天是否已从 IDB 加载完成。
// 只依赖 chatDbReady（contact-switched 会置 false，loadMsgs 读完/保险丝到期才置 true），
// 不再比对 lastIdbLoadPrefix：无历史桌面（新联系人）走 confirmMiss 分支只置 chatDbReady、
// 不更新 lastIdbLoadPrefix，比对会误判「未就绪」导致跨桌面发卡永远等超时。
window.__chatDbReady = function () { return chatDbReady === true; };
// v3.17.x：跨桌面「来消息」用——返回最近一次成功加载聊天记录的桌面 id
//（lastIdbLoadPrefix 是 'xy-home-v2:<cid>' 形式，这里剥成 cid 供 goReply 比对当前桌面）
window.__chatDbLoadedPrefix = function () {
  try {
    const p = lastIdbLoadPrefix || '';
    return p.indexOf('xy-home-v2:') === 0 ? p.slice('xy-home-v2:'.length) : '';
  } catch (e) { return ''; }
};
bootAutoSend();
// FIX 2026-09-01 #120：启动不再无条件预读当前桌面聊天——大历史桌面（账本 b 超门槛）
// 冷启动跳过，进入聊天页才读（enterChat 会 loadMsgs），防低端机"打开网站"即崩溃。
// 小历史/账本缺失仍按原预读行为（数据零风险，见 chatPrefetchIfLight 说明）。
try { chatPrefetchIfLight(function () { loadMsgs(); }); } catch (e) {}
setTimeout(rpExpireCheck, 2000);
setInterval(rpExpireCheck, 60 * 60 * 1000);
// FIX 2026-09-14 #456：红包封面启动恢复此前引用未定义的 RP_COVER_KEY——ReferenceError 被
// 本层 try/catch 连同 promise 链静默吞掉＝恢复从未生效（#454 无头诊断实锤产物 36945 行）。
// 改为 out/in 双方向各自从 IDB 权威键回灌 LS，键名与 rpCoverSet 写入口径同构
//（<activePrefix>:rp-cover-<side> ↔ store.set('rp-cover-<side>')，模板同下方 fav-msgs 恢复段）；
// 切桌面后放弃写入。
try {
if (window.idbGet) {
['out', 'in'].forEach(function (side) {
const myPrefix = window.activePrefix();
window.idbGet(myPrefix + ':rp-cover-' + side).then(function (v) {
if (window.activePrefix() !== myPrefix) return;
if (v && typeof v === 'string' && v.length > 2) store.set('rp-cover-' + side, v);
});
});
}
} catch (e) {}
window.chatSendMsg = (text) => { if (typeof text === 'string' && text.trim()) addMsg(text.trim()); };
window.chatSendFlower = (emoji, name, wish, fromTA) => {
return addRec({ side: fromTA ? 'in' : 'out', special: 'flower', flEmoji: emoji, flName: name, flWish: wish || '' });
};
try {
if (window.idbGet) {
const myPrefix = window.activePrefix();
const favAuthInfo = {}; // #1309c：这一发同时充当「fav-msgs 这一键回没回话」的证人（写闸见上方 saveFav）
window.idbGet(myPrefix + ':fav-msgs', favAuthInfo).then(v => {
if (window.activePrefix() !== myPrefix) return;
try { favNoteAuth(v, favAuthInfo); } catch (e) {}
if (v && typeof v === 'string' && v.length > 2) {
// v3.26.x 修复（iOS 收藏丢失）：只在本地无收藏时从 IDB 补入，不再无条件覆盖——
// idbSet 是异步 fire-and-forget，iOS 杀后台时 IDB 可能落后于 localStorage，
// 无条件覆盖会把最新收藏回滚成旧快照（收藏 5 条重开后只剩 3 条）
let cur = null;
try { cur = store.get('fav-msgs'); } catch (e) {}
if (!cur || cur.length <= 2) store.set('fav-msgs', v);
}
});
}
} catch (e) {}
updateChatBadge();
document.addEventListener('ta-word-changed', function () {
try { if (msgs.length) renderWindow(false, false); } catch (e) {}
});
// v3.26.x #181：气泡 CSS 通用映射导出（单聊 chat-settings.js / 群聊 group-chat.js 共用）。
// 旧逻辑只认固定别名表，网页下载的气泡模板类名对不上时，整份模板替换后一条规则都匹配
// 不到节点 → 「已设置但气泡零变化」（EC-PAD01 SE/vivo Edge 等多机型反复反馈；与机型无关，
// 只与上传内容有关）。现行为：①别名表扩充（bubble-left/right、msg/message/chat-left/right、
// you/sent/received 等）；②剥离注释、跳过 keyframes 帧；③映射后若没有任何规则命中气泡 →
// 兜底把模板里全部声明块（含 --var 定义）抽出整体套用到双方气泡 !important，保证上传必有
// 可见变化；④:root/body/* 等命中不了气泡的选择器不原样注入，防全局重置泄漏污染整页。
window.mochiMapBubbleCss = function (css, scope) {
  scope = scope || '';
  var wrap = function (decls) {
    return scope + '.msg-out .msg-bubble{' + decls + '!important;}' +
           scope + '.msg-in .msg-bubble{' + decls + '!important;}';
  };
  css = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!css) return { out: '', hint: null };
  // 纯声明（无大括号）→ 直接套双方气泡
  if (css.indexOf('{') < 0) return { out: wrap(css), hint: null };
  var _mapBc = function (src, names, rep) {
    var r = src;
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      var re2 = new RegExp('\\.' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\-\\w])', 'g');
      r = r.replace(re2, rep);
    }
    return r;
  };
  var OUT_B = scope + '.msg-out .msg-bubble', IN_B = scope + '.msg-in .msg-bubble';
  var OUT_NAMES = [
    'message-sent', 'message-me', 'message-mine', 'chat-me', 'msg-me', 'msg-sent', 'sent',
    'mine', 'me', 'left', 'my-bubble', 'bubble-mine', 'bubble-self', 'self', 'myself', 'sender',
    'bubble-left', 'msg-left', 'message-left', 'chat-left'
  ];
  var IN_NAMES = [
    'message-received', 'received', 'message-you', 'message-friend', 'chat-you', 'chat-friend',
    'msg-you', 'msg-recv', 'msg-incoming', 'incoming', 'friend', 'other', 'right', 'you',
    'bubble-other', 'partner-bubble', 'them', 'recipient', 'guest', 'receiver',
    'bubble-right', 'msg-right', 'message-right', 'chat-right'
  ];
  var SH_NAMES = [
    'chat-bubble', 'message-bubble', 'text-bubble', 'word-bubble', 'chat-text',
    'bubble', 'message', 'msg'
  ];
  var out = '', hasMapped = false, fallbackDecls = [];
  var re = /([^{}]*)\{([^{}]*)\}/g, m;
  while ((m = re.exec(css))) {
    var sel = m[1].trim(), decls = m[2].trim();
    if (!decls) continue;
    if (!sel || /^(-?\d+\.?\d*%|from|to)$/i.test(sel)) { // 无选择器声明块 / keyframes 帧
      if (!sel) { out += wrap(decls); hasMapped = true; }
      continue;
    }
    var mapped = sel;
    mapped = _mapBc(mapped, ['msg-out'], scope + '.msg-out');
    mapped = _mapBc(mapped, ['msg-in'], scope + '.msg-in');
    mapped = _mapBc(mapped, ['mb.self'], OUT_B);
    mapped = _mapBc(mapped, ['mb.other'], IN_B);
    mapped = _mapBc(mapped, OUT_NAMES, OUT_B);
    mapped = _mapBc(mapped, IN_NAMES, IN_B);
    mapped = _mapBc(mapped, SH_NAMES, scope + '.msg-bubble.msg-bubble');
    if (/\.msg-bubble|\.msg-out|\.msg-in/.test(mapped)) {
      out += mapped + '{' + decls + '}';
      hasMapped = true;
    } else if (fallbackDecls.indexOf(decls) < 0) {
      fallbackDecls.push(decls);
    }
  }
  // 一条都没认出气泡类名 → 整包声明兜底（含 --var，var() 引用同元素可解析）
  if (!hasMapped && fallbackDecls.length) {
    return { out: wrap(fallbackDecls.join(';')), hint: '未认出模板里的气泡类名，已把全部样式整体套用到双方气泡' };
  }
  return { out: out, hint: null };
};
})();
