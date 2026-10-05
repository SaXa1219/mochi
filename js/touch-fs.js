(function () { try {
(function () {
'use strict';
var DAILY_MAX = 2;                 // 每天最多邀请 2 次
var INVITE_KEY = 'touch-inv-daily'; // 邀请计数（每联系人独立命名空间）
var ACCEPT_PROB = 0.72;            // 对方同意概率
function store() { try { return window.activeStore(); } catch (e) { return null; } }
function toast(t) { try { if (typeof window.toast === 'function') window.toast(t); } catch (e) {} }
function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function invCount() {
try {
var s = store(); if (!s) return 0;
var o = JSON.parse(s.get(INVITE_KEY) || 'null');
if (!o || o.d !== todayStr()) return 0;
return o.n | 0;
} catch (e) { return 0; }
}
function invBump() {
try {
var s = store(); if (!s) return;
var n = invCount() + 1;
s.set(INVITE_KEY, JSON.stringify({ d: todayStr(), n: n }));
} catch (e) {}
}
function partnerName() {
try { return (window.chatPartnerName && window.chatPartnerName()) || 'TA'; } catch (e) { return 'TA'; }
}
var FALLBACK_LINES = ['亲亲你', '再靠近一点点', '喜欢你这样', '别躲呀'];
var ACTS = [
{ key: 'kiss', label: '亲亲', prompt: '亲哪里？', options: ['额头', '脸颊', '嘴角', '鼻尖', '手背'], say: ['亲了亲你的{pos}', '在你{pos}落下一个吻', '轻轻碰了碰你的{pos}'] },
{ key: 'head', label: '摸头', prompt: '摸摸哪里？', options: ['头顶', '发梢', '后颈', '耳朵'], say: ['揉了揉你的{pos}', '顺着{pos}轻轻抚过', '摸了摸你的{pos}'] },
{ key: 'hug', label: '抱抱', prompt: '怎么抱？', options: ['轻轻抱住', '收紧一点', '从背后抱', '埋进怀里'], say: ['把你{pos}', '张开手臂{pos}', '{pos}，不想松手'] },
{ key: 'hand', label: '牵手', prompt: '牵哪只手？', options: ['左手', '右手', '十指扣住', '勾小指'], say: ['牵住了你的{pos}', '把你的{pos}握进掌心', '{pos}，不许放开'] },
{ key: 'rub', label: '蹭蹭', prompt: '蹭哪里？', options: ['脸颊', '肩膀', '手心', '额头'], say: ['在你{pos}蹭了蹭', '拿{pos}轻轻碰了碰你', '靠过去蹭着你的{pos}'] }
];
function cardGroups() {
try { if (window.mochiTouchCardGroups) return window.mochiTouchCardGroups() || []; } catch (e) {}
return [];
}
var root = null, built = false;
var els = {};
var groupKey = null;         // 当前选中的字卡组
var moveMode = false;        // 是否可自由移动底部功能
var dragging = null;
var session = null;          // 会话状态
var ended = false;           // 是否已弹出「出来了」防重入
var rAF = null;
function build() {
if (built) return;
built = true;
var phone = document.querySelector('.phone') || document.body;
root = document.createElement('div');
root.className = 'tfs';
root.id = 'touch-fs';
root.hidden = true;
root.innerHTML =
'<div class="tfs-top">' +
'<button class="tfs-close" id="tfs-close" title="关闭">✕</button>' +
'<div class="tfs-title" id="tfs-title">摸一摸</div>' +
'<div class="tfs-tools">' +
'<button class="tfs-tool" id="tfs-group-btn" title="选择亲亲用的字卡组">字卡组</button>' +
'<button class="tfs-tool tfs-move" id="tfs-move-btn" title="点击可以自由移动下面功能">✛</button>' +
'</div>' +
'</div>' +
'<div class="tfs-group-menu" id="tfs-group-menu" hidden></div>' +
'<div class="tfs-body">' +
'<div class="tfs-photo" id="tfs-photo"><span class="tfs-photo-hint" id="tfs-photo-hint">点击导入照片</span><div class="tfs-say" id="tfs-say" hidden></div></div>' +
'<div class="tfs-bars" id="tfs-bars"></div>' +
'</div>' +
'<div class="tfs-caption" id="tfs-caption">选择下面一个动作开始</div>' +
'<div class="tfs-chips" id="tfs-chips"></div>' +
'<div class="tfs-acts" id="tfs-acts"></div>' +
'<input type="file" id="tfs-file" accept="image/*" style="display:none">' +
'<div class="tfs-invite" id="tfs-invite" hidden><div class="tfs-invite-card">' +
'<div class="tfs-invite-spin" id="tfs-invite-spin"></div>' +
'<div class="tfs-invite-txt" id="tfs-invite-txt"></div>' +
'<button class="tfs-invite-ok" id="tfs-invite-ok" hidden>知道了</button>' +
'</div></div>' +
'<div class="tfs-climax" id="tfs-climax" hidden></div>';
phone.appendChild(root);
els.close = root.querySelector('#tfs-close');
els.title = root.querySelector('#tfs-title');
els.groupBtn = root.querySelector('#tfs-group-btn');
els.groupMenu = root.querySelector('#tfs-group-menu');
els.moveBtn = root.querySelector('#tfs-move-btn');
els.photo = root.querySelector('#tfs-photo');
els.photoHint = root.querySelector('#tfs-photo-hint');
els.say = root.querySelector('#tfs-say');
els.bars = root.querySelector('#tfs-bars');
els.caption = root.querySelector('#tfs-caption');
els.chips = root.querySelector('#tfs-chips');
els.acts = root.querySelector('#tfs-acts');
els.file = root.querySelector('#tfs-file');
els.invite = root.querySelector('#tfs-invite');
els.inviteSpin = root.querySelector('#tfs-invite-spin');
els.inviteTxt = root.querySelector('#tfs-invite-txt');
els.inviteOk = root.querySelector('#tfs-invite-ok');
els.climax = root.querySelector('#tfs-climax');
var barDefs = [
{ k: 'heart', label: '心跳', color: '#ff6f91' },
{ k: 'temp', label: '体温', color: '#ffa46b' },
{ k: 'desire', label: '欲度', color: '#c77dff' },
{ k: 'degree', label: '程度', color: '#ff4d6d' }
];
els.barsList = {};
barDefs.forEach(function (d) {
var row = document.createElement('div');
row.className = 'tfs-bar';
row.innerHTML = '<span class="tfs-bar-lb">' + d.label + '</span>' +
'<span class="tfs-bar-track"><i class="tfs-bar-fill" style="background:linear-gradient(90deg,' + d.color + 'aa,' + d.color + ')"></i></span>' +
'<span class="tfs-bar-val"></span>';
els.bars.appendChild(row);
els.barsList[d.k] = { fill: row.querySelector('.tfs-bar-fill'), val: row.querySelector('.tfs-bar-val'), color: d.color };
});
ACTS.forEach(function (a) {
var b = document.createElement('button');
b.className = 'tfs-act';
b.type = 'button';
b.dataset.act = a.key;
b.textContent = a.label;
b.addEventListener('click', function (e) { e.stopPropagation(); pickAct(a); });
els.acts.appendChild(b);
});
els.close.addEventListener('click', close);
els.photo.addEventListener('click', function () { if (!moveMode) els.file.click(); });
els.file.addEventListener('change', onPickPhoto);
els.groupBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleGroupMenu(); });
els.moveBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleMove(); });
els.inviteOk.addEventListener('click', function () { els.invite.hidden = true; close(); });
document.addEventListener('click', function (e) {
if (!els.groupMenu.hidden && !els.groupMenu.contains(e.target) && e.target !== els.groupBtn) els.groupMenu.hidden = true;
});
bindDrag();
}
function onPickPhoto() {
var f = els.file.files && els.file.files[0];
els.file.value = '';
if (!f) return;
var fr = new FileReader();
fr.onload = function () {
els.photo.style.backgroundImage = 'url("' + fr.result + '")';
els.photo.classList.add('has-img');
els.photoHint.hidden = true;
};
fr.readAsDataURL(f);
}
function toggleMove() {
moveMode = !moveMode;
els.moveBtn.classList.toggle('on', moveMode);
els.acts.classList.toggle('moving', moveMode);
els.photo.classList.toggle('locked', moveMode);
els.caption.textContent = moveMode ? '拖动下面的功能按钮摆到喜欢的位置' : '选择下面一个动作开始';
}
function bindDrag() {
var acts = els.acts;
acts.addEventListener('pointerdown', function (e) {
if (!moveMode) return;
dragging = { x: e.clientX, y: e.clientY, ox: acts.offsetLeft, oy: acts.offsetTop };
acts.style.position = 'relative';
try { acts.setPointerCapture(e.pointerId); } catch (err) {}
});
acts.addEventListener('pointermove', function (e) {
if (!dragging) return;
e.preventDefault();
acts.style.left = (dragging.ox + (e.clientX - dragging.x)) + 'px';
acts.style.top = (dragging.oy + (e.clientY - dragging.y)) + 'px';
});
function up(){ dragging = null; }
acts.addEventListener('pointerup', up);
acts.addEventListener('pointercancel', up);
}
function toggleGroupMenu() {
if (!els.groupMenu.hidden) { els.groupMenu.hidden = true; return; }
var gs = cardGroups();
els.groupMenu.innerHTML = '';
if (!gs.length) {
var e0 = document.createElement('div');
e0.className = 'tfs-group-empty';
e0.textContent = '暂无字卡组，先在 字卡库/拍一拍 里添加';
els.groupMenu.appendChild(e0);
} else {
if (!groupKey || !gs.some(function (g) { return g.key === groupKey; })) groupKey = gs[0].key;
gs.forEach(function (g) {
var b = document.createElement('button');
b.type = 'button';
b.className = 'tfs-group-item' + (g.key === groupKey ? ' on' : '');
b.textContent = (g.label || g.key) + '（' + ((g.cards && g.cards.length) || 0) + '）';
b.addEventListener('click', function (e) {
e.stopPropagation();
groupKey = g.key;
els.groupMenu.hidden = true;
toast('亲亲字卡组：' + (g.label || g.key));
});
els.groupMenu.appendChild(b);
});
}
els.groupMenu.hidden = false;
}
function pickLines() {
var gs = cardGroups();
var g = gs.filter(function (x) { return x.key === groupKey; })[0] || gs[0];
var pool = (g && Array.isArray(g.cards) && g.cards.length) ? g.cards.slice() : FALLBACK_LINES.slice();
return pool;
}
function pickAct(a) {
els.chips.innerHTML = '';
els.caption.textContent = a.prompt;
a.options.forEach(function (opt) {
var c = document.createElement('button');
c.type = 'button';
c.className = 'tfs-chip';
c.textContent = opt;
c.addEventListener('click', function (e) { e.stopPropagation(); doAct(a, opt); });
els.chips.appendChild(c);
});
}
function doAct(a, pos) {
var tpl = a.say[randInt(0, a.say.length - 1)].replace('{pos}', pos);
els.caption.textContent = tpl;
els.chips.innerHTML = '';
if (a.key === 'kiss') showSay(pos);
if (session) session.degree = Math.min(100, session.degree + randInt(2, 5));
if (session) session.desire = Math.min(100, session.desire + randInt(1, 4));
}
function showSay(pos) {
var pool = pickLines();
var n = randInt(1, 2);
var lines = [];
for (var i = 0; i < n; i++) lines.push(String(pool[randInt(0, pool.length - 1)]));
var s = els.say;
s.hidden = false;
s.textContent = lines.join('\n');
s.style.left = randInt(8, 52) + '%';
s.style.top = randInt(12, 62) + '%';
s.classList.remove('pop');
void s.offsetWidth;
s.classList.add('pop');
}
function stepBars(ts) {
if (!session) return;
if (!session.t0) session.t0 = ts;
var el = (ts - session.t0) / 1000;
var b = els.barsList;
var heart = 55 + 32 * Math.sin(el / 2.4);
var temp = Math.min(90, 45 + el * 0.9) + 3 * Math.sin(el / 3.1);
var desire = Math.min(96, session.desire + el * 0.5) + 4 * Math.sin(el / 2.0);
var degree = session.degree + (el / 1200) * 100;
session.heart = heart; session.temp = temp; session.desireNow = desire; session.degreeNow = degree;
setBar(b.heart, heart, Math.round(60 + heart * 0.6) + '/分');
setBar(b.temp, Math.min(100, temp), (36 + temp / 100 * 2.4).toFixed(1) + '℃');
setBar(b.desire, Math.max(0, Math.min(100, desire)), Math.round(Math.max(0, Math.min(100, desire))) + '%');
var dr = Math.min(100, degree);
setBar(b.degree, dr, Math.round(dr) + '%');
if (dr >= 100 && !ended) { ended = true; climax(); return; }
rAF = requestAnimationFrame(stepBars);
}
function setBar(o, v, txt) {
if (!o) return;
o.fill.style.width = Math.max(0, Math.min(100, v)) + '%';
o.val.textContent = txt;
}
function climax() {
if (rAF) { cancelAnimationFrame(rAF); rAF = null; }
els.climax.hidden = false;
els.climax.innerHTML = '<div class="tfs-climax-txt">出来了</div>';
setTimeout(function () {
var cont = Math.random() < 0.5;
if (cont) {
els.climax.innerHTML = '<div class="tfs-climax-txt">对方想继续…</div>';
setTimeout(function () {
els.climax.hidden = true;
ended = false;
session.degree = 55; session.t0 = 0;
session.desire = Math.max(30, session.desire - 25);
els.caption.textContent = '继续着，慢慢来';
rAF = requestAnimationFrame(stepBars);
}, 1400);
} else {
els.climax.innerHTML = '<div class="tfs-climax-txt">出来了</div><div class="tfs-climax-sub">对方结束了这次摸一摸</div>';
setTimeout(function () { els.climax.hidden = true; close(); }, 2000);
}
}, 1600);
}
function openInvite() {
els.invite.hidden = false;
els.inviteSpin.hidden = false;
els.inviteOk.hidden = true;
els.inviteTxt.textContent = '正在邀请 ' + partnerName() + ' 摸一摸…';
invBump();
var wait = randInt(1300, 2600);
setTimeout(function () {
els.inviteSpin.hidden = true;
if (Math.random() < ACCEPT_PROB) {
els.inviteTxt.textContent = partnerName() + ' 同意了';
setTimeout(function () { els.invite.hidden = true; enterMain(); }, 700);
} else {
els.inviteTxt.textContent = partnerName() + ' 拒绝了你的邀请\n今天还可以邀请 ' + Math.max(0, DAILY_MAX - invCount()) + ' 次';
els.inviteOk.hidden = false;
}
}, wait);
}
function enterMain() {
els.title.textContent = '摸一摸 · ' + partnerName();
ended = false;
session = { t0: 0, degree: randInt(6, 12), desire: randInt(18, 28) };
els.caption.textContent = '选择下面一个动作开始';
els.chips.innerHTML = '';
els.say.hidden = true;
els.climax.hidden = true;
els.invite.hidden = true;
if (!groupKey) { var gs = cardGroups(); if (gs.length) groupKey = gs[0].key; }
if (rAF) cancelAnimationFrame(rAF);
rAF = requestAnimationFrame(stepBars);
}
function close() {
if (!root) return;
ended = true;
if (rAF) { cancelAnimationFrame(rAF); rAF = null; }
session = null;
els.groupMenu.hidden = true;
els.invite.hidden = true;
els.climax.hidden = true;
root.hidden = true;
if (moveMode) toggleMove();
}
window.openTouchFs = function () {
build();
if (invCount() >= DAILY_MAX) {
toast('今天已经邀请过 ' + DAILY_MAX + ' 次了，明天再来吧');
return;
}
root.hidden = false;
openInvite();
};
window.closeTouchFs = close;
document.addEventListener('contact-switched', function () { if (root && !root.hidden) close(); });
})();
if (window.__mochiLoaded) window.__mochiLoaded.push("touch-fs.js");
} catch (__e) { if (window.__mochiErrLoaded) window.__mochiErrLoaded.push("touch-fs.js"); try { console.error("[JS] touch-fs.js", __e && __e.message || __e); } catch (x) {} if (window.__jsErrors) window.__jsErrors.push("[touch-fs.js] " + String(__e && __e.message || __e)); } })();