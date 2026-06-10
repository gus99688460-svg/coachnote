import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---------- 상태 ----------
let members = [];          // [{id, ...data}]
let currentId = null;      // 현재 보고 있는 회원 id
let unsub = null;          // firestore 구독 해제 함수

const $ = (id) => document.getElementById(id);
const esc = (s) => (s || "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const nl = (s) => esc(s).replace(/\n/g, "<br>");
const todayStr = () => new Date().toISOString().slice(0, 10);

// ---------- 인증 ----------
onAuthStateChanged(auth, (user) => {
  if (user) {
    $("loginScreen").classList.add("hidden");
    $("app").classList.remove("hidden");
    subscribeMembers();
  } else {
    $("app").classList.add("hidden");
    $("loginScreen").classList.remove("hidden");
    if (unsub) { unsub(); unsub = null; }
  }
});

$("loginBtn").onclick = async () => {
  $("loginError").textContent = "";
  try {
    await signInWithEmailAndPassword(auth, $("loginEmail").value.trim(), $("loginPw").value);
  } catch (e) {
    $("loginError").textContent = "로그인 실패 — 이메일/비밀번호를 확인하세요.";
  }
};
$("loginPw").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginBtn").click(); });
$("logoutBtn").onclick = () => signOut(auth);

// ---------- OT 상담 입력 옵션 & 칩 ----------
const OT_OPT = {
  motives: ["체중감량","체형교정","통증완화","체력향상","자세교정","대회준비","재활","자신감·멘탈"],
  experience: ["입문(운동 처음)","초급(가끔 혼자)","중급(루틴 있음)","경험자"],
  objections: ["가격 부담","시간 없음","효과 의심","혼자 가능 생각","타 센터 비교","지속 자신없음","낯가림"],
  availability: ["주 1~2회","주 3회","주 4회+"],
  budget: ["여유","보통","빠듯"],
  personality: ["감정·공감형","논리·데이터형","성과·목표형","관계·라포형"]
};
const OT_MULTI = new Set(["motives", "objections"]);

function renderChipsets(ot) {
  for (const key in OT_OPT) {
    const cont = $("ot_" + key);
    const cur = ot && ot[key] ? [].concat(ot[key]) : [];
    const sel = new Set(cur);
    cont.innerHTML = OT_OPT[key].map(v =>
      `<span class="chip ${sel.has(v) ? "on" : ""}" data-v="${esc(v)}">${esc(v)}</span>`).join("");
    cont.querySelectorAll(".chip").forEach(c => c.onclick = () => {
      if (OT_MULTI.has(key)) c.classList.toggle("on");
      else { cont.querySelectorAll(".chip").forEach(x => x.classList.remove("on")); c.classList.add("on"); }
    });
  }
}
function readChips(key) {
  const arr = [...$("ot_" + key).querySelectorAll(".chip.on")].map(c => c.dataset.v);
  return OT_MULTI.has(key) ? arr : (arr[0] || "");
}

// ---------- 회원 구분 토글 ----------
let memberType = "PT";
$("m_typeSeg").querySelectorAll("button").forEach(b => b.onclick = () => {
  memberType = b.dataset.type;
  $("m_typeSeg").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
});

// ---------- OT 상담 모달 ----------
function openOtModal(m) {
  const ot = m.ot || {};
  renderChipsets(ot);
  $("ot_goal").value = ot.goal || "";
  $("ot_body").value = ot.body || "";
  $("ot_reaction").value = ot.reaction || "";
  $("ot_nextDate").value = ot.nextDate || "";
  $("otModal").classList.remove("hidden");
}
$("saveOtBtn").onclick = async () => {
  if (!currentId) return;
  const ot = {
    motives: readChips("motives"),
    experience: readChips("experience"),
    objections: readChips("objections"),
    availability: readChips("availability"),
    budget: readChips("budget"),
    personality: readChips("personality"),
    goal: $("ot_goal").value.trim(),
    body: $("ot_body").value.trim(),
    reaction: $("ot_reaction").value.trim(),
    nextDate: $("ot_nextDate").value
  };
  await updateDoc(doc(db, "members", currentId), { ot });
  closeModals();
};

// ---------- OT → PT 전환 ----------
async function convertToPT(m) {
  if (!confirm(`'${m.name}'님을 PT 회원으로 전환할까요?\nOT 상담 기록은 그대로 유지됩니다.`)) return;
  const patch = { type: "PT" };
  if (!m.injury && m.ot?.body) patch.injury = m.ot.body;       // 통증 이슈 → 주의사항으로 승계
  if (!m.goalShort && m.ot?.goal) patch.goalShort = m.ot.goal; // 목표 승계
  await updateDoc(doc(db, "members", m.id), patch);
}

// ---------- 데이터 구독 (실시간 동기화) ----------
function subscribeMembers() {
  if (unsub) unsub();
  const q = query(collection(db, "members"), orderBy("name"));
  unsub = onSnapshot(q, (snap) => {
    members = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderList();
    if (currentId && !$("detailView").classList.contains("hidden")) renderDetail(currentId);
  });
}

// ---------- 회원 목록 ----------
function renderList() {
  const kw = $("searchInput").value.trim().toLowerCase();
  const list = members.filter(m => !kw || (m.name || "").toLowerCase().includes(kw));
  $("emptyHint").classList.toggle("hidden", members.length > 0);
  $("memberList").innerHTML = list.map(m => {
    const type = m.type || "PT";
    const isOT = type === "OT";
    const lessons = m.lessons || [];
    const last = lessons[0];
    const left = (m.left ?? "") !== "" ? Number(m.left) : null;
    const lowClass = left !== null && left <= 3 ? "low" : "";
    const warn = (m.injury || "").trim() ? `<span class="warn-dot" title="주의사항 있음">⚠️</span>` : "";
    const hasOt = m.ot && ((m.ot.motives && m.ot.motives.length) || m.ot.goal || m.ot.experience);
    const sub = isOT
      ? (hasOt ? "OT 상담 · 전환 방안 보기" : "OT 상담 입력 전")
      : (last ? `최근 ${esc(last.date)} · ${esc(last.topic || "수업")}` : "기록 없음");
    const typeChip = `<span class="mc-type ${isOT ? "ot" : "pt"}">${type}</span>`;
    const leftBadge = (!isOT && left !== null) ? `<div class="mc-badge ${lowClass}">잔여 ${left}</div>` : "";
    return `<div class="member-card" data-id="${m.id}">
      <div class="mc-left">
        <div class="mc-name">${esc(m.name)} ${warn}</div>
        <div class="mc-sub">${sub}</div>
      </div>
      <div class="mc-right">${leftBadge}${typeChip}</div>
    </div>`;
  }).join("");
  document.querySelectorAll(".member-card").forEach(el => {
    el.onclick = () => openDetail(el.dataset.id);
  });
}
$("searchInput").addEventListener("input", renderList);

// ---------- 회원 상세 ----------
function openDetail(id) {
  currentId = id;
  $("listView").classList.add("hidden");
  $("detailView").classList.remove("hidden");
  window.scrollTo(0, 0);
  renderDetail(id);
}
$("backBtn").onclick = () => {
  $("detailView").classList.add("hidden");
  $("listView").classList.remove("hidden");
  currentId = null;
};

function renderDetail(id) {
  const m = members.find(x => x.id === id);
  if (!m) { $("backBtn").click(); return; }
  if ((m.type || "PT") === "OT") renderOTDetail(m);
  else renderPTDetail(m);
}

// 수업 일지 타임라인 (PT·OT 공용)
function lessonTimeline(lessons) {
  if (!lessons.length) return `<div class="no-lesson">아직 기록이 없어요.</div>`;
  return lessons.map((l, i) => {
    const rows = [
      l.workout && `<div class="lesson-row"><span class="ico">💪</span><span class="txt">${nl(l.workout)}</span></div>`,
      l.condition && `<div class="lesson-row"><span class="ico">🩺</span><span class="txt">${nl(l.condition)}</span></div>`,
      l.emotion && `<div class="lesson-row"><span class="ico">💬</span><span class="txt">${nl(l.emotion)}</span></div>`,
      l.next && `<div class="lesson-row"><span class="ico">✅</span><span class="txt">${nl(l.next)}</span></div>`
    ].filter(Boolean).join("");
    return `<div class="lesson" data-idx="${i}">
      <div class="lesson-date">${esc(l.date)} <span>${l.session ? esc(l.session) + "회차 · " : ""}${esc(l.topic || "")}</span></div>
      ${rows}
    </div>`;
  }).join("");
}
function bindLessons() {
  const add = $("addLessonBtn");
  if (add) add.onclick = () => openLessonModal(null);
  document.querySelectorAll(".lesson").forEach(el => el.onclick = () => openLessonModal(Number(el.dataset.idx)));
}

// ===== PT 회원 상세 (기록 중심) =====
function renderPTDetail(m) {
  const cautions = [];
  if (m.injury) cautions.push(`<div class="kv"><b>부상·통증:</b> ${nl(m.injury)}</div>`);
  if (m.restriction) cautions.push(`<div class="kv"><b>운동 제약:</b> ${nl(m.restriction)}</div>`);
  if (m.personality) cautions.push(`<div class="kv"><b>성향:</b> ${nl(m.personality)}</div>`);
  const goals = [];
  if (m.goalShort) goals.push(`<div class="kv"><b>단기:</b> ${esc(m.goalShort)}</div>`);
  if (m.goalLong) goals.push(`<div class="kv"><b>장기:</b> ${esc(m.goalLong)}</div>`);

  $("detailContent").innerHTML = `
    <h2 class="detail-name">${esc(m.name)} <span class="edit-link" id="editMemberLink">정보 수정</span></h2>
    <div class="detail-meta">
      <span class="mc-type pt">PT</span>
      ${m.startDate ? " · 등록 " + esc(m.startDate) : ""}
      ${(m.total ?? "") !== "" ? " · 총 " + esc(String(m.total)) + "회" : ""}
      ${(m.left ?? "") !== "" ? " · 잔여 " + esc(String(m.left)) + "회" : ""}
    </div>
    ${cautions.length ? `<div class="block warn"><h4>⚠️ 핵심 주의사항</h4>${cautions.join("")}</div>` : ""}
    ${goals.length ? `<div class="block"><h4>🎯 목표</h4>${goals.join("")}</div>` : ""}
    ${(m.payment || m.contact) ? `<div class="block"><h4>📌 메모</h4>
      ${m.payment ? `<div class="kv"><b>재등록:</b> ${esc(m.payment)}</div>` : ""}
      ${m.contact ? `<div class="kv"><b>기타:</b> ${esc(m.contact)}</div>` : ""}</div>` : ""}
    <div class="section-head"><h4>📒 수업 일지</h4>
      <button class="btn-gold sm" id="addLessonBtn">+ 기록</button></div>
    ${lessonTimeline(m.lessons || [])}
  `;
  $("editMemberLink").onclick = () => openMemberModal(m);
  bindLessons();
}

// ===== OT 회원 상세 (전환 지도 중심) =====
function renderOTDetail(m) {
  const ot = m.ot;
  const hasData = ot && ((ot.motives && ot.motives.length) || ot.goal || ot.experience || (ot.objections && ot.objections.length));
  let body;
  if (!hasData) {
    body = `<div class="ot-empty">아직 OT 상담 정보가 없어요.<br>상담·체험에서 파악한 걸 입력하면<br><b>전환 방안</b>이 자동으로 만들어집니다.</div>
      <div class="btn-row"><button class="btn-gold" id="otInputBtn">＋ OT 상담 입력</button></div>`;
  } else {
    const p = generatePlan(ot);
    const mainMotive = (ot.motives && ot.motives[0]) || "목표";
    const when = ot.nextDate || "체험 후 24~48시간 내 (열기 식기 전)";
    const fill = p.level.c === "high" ? "#6cc08a" : p.level.c === "mid" ? "var(--gold)" : "var(--danger)";
    const nextScript = `"${esc(m.name)}님, 어제 ${esc(mainMotive)} 얘기가 계속 생각나서요 — 이렇게 시작하면 좋겠다 싶은 그림이 있어 연락드렸어요" (부담 없이 안부+제안 톤)`;
    body = `
      <div class="temp-card">
        <div class="temp-top"><span class="temp-label">전환 온도</span>
          <span class="temp-level ${p.level.c}">${p.level.t} · ${p.score}점</span></div>
        <div class="temp-bar"><div class="temp-fill" style="width:${p.score}%;background:${fill}"></div></div>
        <div class="temp-coach">${esc(p.coach)}</div>
      </div>
      <div class="plan-block"><h4>📦 추천 패키지·방향</h4>
        ${p.pkg.map(x => `<div class="plan-item"><span class="b">•</span><span>${esc(x)}</span></div>`).join("")}</div>
      ${p.angles.length ? `<div class="plan-block"><h4>🎯 공략 포인트</h4>
        ${p.angles.map(x => `<div class="plan-item"><span class="b">▸</span><span>${esc(x)}</span></div>`).join("")}</div>` : ""}
      ${p.objections.length ? `<div class="plan-block"><h4>🛡 이의제기 대응</h4>
        ${p.objections.map(o => `<div class="plan-obj"><div class="q">"${esc(o.q)}"</div><div class="a">${esc(o.a)}</div></div>`).join("")}</div>` : ""}
      <div class="plan-block"><h4>📞 다음 컨택</h4>
        <div class="plan-item"><span class="b">시점</span><span>${esc(when)}</span></div>
        <div class="plan-item"><span class="b">멘트</span><span>${nextScript}</span></div>
        ${p.persTone ? `<div class="plan-item"><span class="b">톤</span><span>${esc(p.persTone)}</span></div>` : ""}
      </div>
      <div class="btn-row">
        <button class="btn-ghost" id="otInputBtn">✏️ 상담 수정</button>
        <button class="btn-gold" id="toPtBtn">🏋️ PT 회원으로 전환</button>
      </div>
      <div class="section-head"><h4>📒 체험·수업 기록</h4>
        <button class="btn-gold sm" id="addLessonBtn">+ 기록</button></div>
      ${lessonTimeline(m.lessons || [])}
    `;
  }
  $("detailContent").innerHTML = `
    <h2 class="detail-name">${esc(m.name)} <span class="edit-link" id="editMemberLink">정보 수정</span></h2>
    <div class="detail-meta"><span class="mc-type ot">OT</span> · 전환 대상 회원</div>
    ${body}`;
  $("editMemberLink").onclick = () => openMemberModal(m);
  const ib = $("otInputBtn"); if (ib) ib.onclick = () => openOtModal(m);
  const pb = $("toPtBtn"); if (pb) pb.onclick = () => convertToPT(m);
  bindLessons();
}

// ===== 전환 지도 엔진 (룰 기반) =====
const OT_ANGLE = {
  "체중감량": "체성분 변화가 보이는 시점(보통 6~8주)을 미리 그려주고, 정체기 돌파가 PT의 진짜 가치임을 강조",
  "체형교정": "거울 앞에서 좌우 불균형·자세를 직접 짚어주고, 혼자선 못 잡는 디테일임을 체험으로 각인",
  "통증완화": "안전 최우선 + 생활 통증 개선 사례 제시. 과장 없는 신뢰가 전환의 열쇠",
  "체력향상": "횟수·중량·지구력 등 측정 지표로 '눈에 보이는 성취'를 설계",
  "자세교정": "거북목·라운드숄더 등 일상 자세와 운동을 연결해 '매일 쓰는 몸'으로 동기 부여",
  "대회준비": "시즌 역산 스케줄과 전문 레퍼런스로 전문성·신뢰 확보",
  "재활": "무리 금지·점진적 접근. 필요시 병원과 협업을 언급해 안정감 제공",
  "자신감·멘탈": "숫자보다 '함께 해낸다'는 정서적 지지를 전면에"
};
const OT_OBJ = {
  "가격 부담": "회당 단가로 분해해 보여주고, 혼자 등록 후 안 나간 비용을 환기. 부담되면 단기 집중으로 회차를 낮춘 옵션 제시",
  "시간 없음": "주 2회 40분도 충분히 효과 있음을 강조. 바쁠수록 PT가 시간 효율적 — 고정 시간 슬롯부터 먼저 확보",
  "효과 의심": "4주 단기 목표를 먼저 잡아 '작은 성공'을 설계. 비포·애프터/후기로 근거 제시",
  "혼자 가능 생각": "이미 혼자 해봤다 멈춘 경험을 환기. 자세·강도·정체기에서 차이남을 체험 때 몸으로 느끼게 한다",
  "타 센터 비교": "가격 비교에서 벗어나 본인의 전문성·관리 디테일로 기준을 옮긴다. 비교당하지 말고 차별점을 만든다",
  "지속 자신없음": "PT의 본질은 '지속 강제력'. 예약·체크 시스템으로 이탈을 막아준다는 점을 핵심 가치로",
  "낯가림": "압박 없이 천천히. 첫 4주는 가볍게, 편안함과 라포를 먼저 쌓는다"
};
const OT_TONE = {
  "감정·공감형": "공감·격려 중심으로. 숫자보다 '함께한다'는 메시지가 통합니다.",
  "논리·데이터형": "계획표·근거·수치로 설득하세요. 과장은 역효과입니다.",
  "성과·목표형": "목표 역산 마일스톤과 기록 갱신 자극이 동기를 끌어올립니다.",
  "관계·라포형": "트레이너와의 신뢰·편안함을 먼저. 사람을 보고 등록합니다."
};

function generatePlan(ot) {
  const motives = ot.motives || [];
  const objs = ot.objections || [];
  const exp = ot.experience || "";
  const avail = ot.availability || "";
  const budget = ot.budget || "";

  // 전환 온도 점수
  let score = 75;
  const weight = { "가격 부담": 15, "효과 의심": 15, "혼자 가능 생각": 15, "시간 없음": 10, "지속 자신없음": 10, "타 센터 비교": 8, "낯가림": 6 };
  objs.forEach(o => score -= (weight[o] || 8));
  if (budget === "여유") score += 10;
  if (budget === "빠듯") score -= 8;
  if (avail === "주 3회" || avail === "주 4회+") score += 8;
  score = Math.max(10, Math.min(98, score));
  const level = score >= 70 ? { t: "높음", c: "high" } : score >= 45 ? { t: "중간", c: "mid" } : { t: "낮음", c: "low" };
  const coach = score >= 70
    ? "전환 가능성이 높습니다. 망설임이 적으니 오늘 바로 구체적 패키지와 시작일을 제안하세요."
    : score >= 45
      ? "관심은 있으나 결정적 이의가 남아 있어요. 아래 이의제기부터 풀고 클로징하세요."
      : "지금 강하게 밀면 부담을 느낍니다. 작은 약속(단기·소수 회차)으로 신뢰부터 쌓으세요.";

  // 추천 패키지
  const pkg = [];
  const perWeek = avail === "주 4회+" ? 4 : avail === "주 3회" ? 3 : 2;
  const goalWeight = motives.some(x => ["체중감량", "체형교정", "자세교정"].includes(x));
  if (exp.startsWith("입문"))
    pkg.push("입문자 — 첫 8~10회는 '자세·기본기 집중'으로 부담 없이 시작 후 연장 유도");
  if (budget === "빠듯")
    pkg.push("예산이 빠듯하니 큰 패키지 대신 단기 10~16회 먼저 제안 → 성과 확인 후 연장");
  else
    pkg.push(`목표·여건상 주 ${perWeek}회 × 12주 ≈ ${perWeek * 12}회 패키지가 표준 추천`);
  if (goalWeight)
    pkg.push("체중·체형 목표는 최소 8~12주 꾸준함이 관건 — '한 달은 짧다'를 미리 인지시키기");
  if (perWeek <= 2)
    pkg.push("주 2회라면 수업 외 자가운동 1개를 숙제로 줘 효과를 보강");

  const angles = motives.map(x => OT_ANGLE[x]).filter(Boolean);
  const objections = objs.map(o => ({ q: o, a: OT_OBJ[o] })).filter(x => x.a);
  const persTone = OT_TONE[ot.personality] || "";

  return { score, level, coach, pkg, angles, objections, persTone };
}

// ---------- 회원 모달 ----------
let editingMember = null;
function openMemberModal(m) {
  editingMember = m;
  $("memberModalTitle").textContent = m ? "회원 정보 수정" : "회원 추가";
  memberType = m?.type || "PT";
  $("m_typeSeg").querySelectorAll("button").forEach(x => x.classList.toggle("on", x.dataset.type === memberType));
  $("m_name").value = m?.name || "";
  $("m_startDate").value = m?.startDate || todayStr();
  $("m_left").value = m?.left ?? "";
  $("m_total").value = m?.total ?? "";
  $("m_injury").value = m?.injury || "";
  $("m_restriction").value = m?.restriction || "";
  $("m_personality").value = m?.personality || "";
  $("m_goalShort").value = m?.goalShort || "";
  $("m_goalLong").value = m?.goalLong || "";
  $("m_payment").value = m?.payment || "";
  $("m_contact").value = m?.contact || "";
  $("deleteMemberBtn").classList.toggle("hidden", !m);
  $("memberModal").classList.remove("hidden");
}
$("addMemberBtn").onclick = () => openMemberModal(null);

$("saveMemberBtn").onclick = async () => {
  const name = $("m_name").value.trim();
  if (!name) { $("m_name").focus(); return; }
  const data = {
    name,
    type: memberType,
    startDate: $("m_startDate").value,
    left: $("m_left").value === "" ? "" : Number($("m_left").value),
    total: $("m_total").value === "" ? "" : Number($("m_total").value),
    injury: $("m_injury").value.trim(),
    restriction: $("m_restriction").value.trim(),
    personality: $("m_personality").value.trim(),
    goalShort: $("m_goalShort").value.trim(),
    goalLong: $("m_goalLong").value.trim(),
    payment: $("m_payment").value.trim(),
    contact: $("m_contact").value.trim()
  };
  if (editingMember) {
    await updateDoc(doc(db, "members", editingMember.id), data);
  } else {
    data.lessons = [];
    data.createdAt = serverTimestamp();
    const ref = await addDoc(collection(db, "members"), data);
    currentId = ref.id;
  }
  closeModals();
};

$("deleteMemberBtn").onclick = async () => {
  if (!editingMember) return;
  if (!confirm(`'${editingMember.name}' 회원을 완전히 삭제할까요? 되돌릴 수 없습니다.`)) return;
  await deleteDoc(doc(db, "members", editingMember.id));
  closeModals();
  $("backBtn").click();
};

// ---------- 수업 일지 모달 ----------
let editingLessonIdx = null;
function openLessonModal(idx) {
  editingLessonIdx = idx;
  const m = members.find(x => x.id === currentId);
  const l = idx !== null ? (m.lessons || [])[idx] : null;
  $("lessonModalTitle").textContent = l ? "수업 기록 수정" : "수업 기록 추가";
  $("l_date").value = l?.date || todayStr();
  $("l_session").value = l?.session || (l ? "" : suggestSession(m));
  $("l_topic").value = l?.topic || "";
  $("l_workout").value = l?.workout || "";
  $("l_condition").value = l?.condition || "";
  $("l_emotion").value = l?.emotion || "";
  $("l_next").value = l?.next || "";
  $("deleteLessonBtn").classList.toggle("hidden", idx === null);
  $("lessonModal").classList.remove("hidden");
}
// 가장 최근 회차 +1 자동 제안
function suggestSession(m) {
  const last = (m.lessons || []).find(x => x.session);
  const n = last ? parseInt(last.session, 10) : 0;
  return Number.isFinite(n) && n > 0 ? String(n + 1) : "";
}

$("saveLessonBtn").onclick = async () => {
  const m = members.find(x => x.id === currentId);
  if (!m) return;
  const entry = {
    date: $("l_date").value || todayStr(),
    session: $("l_session").value.trim(),
    topic: $("l_topic").value.trim(),
    workout: $("l_workout").value.trim(),
    condition: $("l_condition").value.trim(),
    emotion: $("l_emotion").value.trim(),
    next: $("l_next").value.trim()
  };
  const lessons = [...(m.lessons || [])];
  if (editingLessonIdx !== null) lessons[editingLessonIdx] = entry;
  else lessons.unshift(entry);
  // 날짜 최신순 정렬 (최신이 위)
  lessons.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  await updateDoc(doc(db, "members", currentId), { lessons });
  closeModals();
};

$("deleteLessonBtn").onclick = async () => {
  if (editingLessonIdx === null) return;
  if (!confirm("이 수업 기록을 삭제할까요?")) return;
  const m = members.find(x => x.id === currentId);
  const lessons = [...(m.lessons || [])];
  lessons.splice(editingLessonIdx, 1);
  await updateDoc(doc(db, "members", currentId), { lessons });
  closeModals();
};

// ---------- 모달 닫기 ----------
function closeModals() {
  $("memberModal").classList.add("hidden");
  $("lessonModal").classList.add("hidden");
  $("otModal").classList.add("hidden");
}
document.querySelectorAll("[data-close]").forEach(b => b.onclick = closeModals);
document.querySelectorAll(".modal").forEach(m => {
  m.addEventListener("click", (e) => { if (e.target === m) closeModals(); });
});
