/* auto-apply dashboard (GitHub Pages, static, no build step).
 *
 * Auth: Supabase email/password via supabase-js v2 (CDN). Session persists
 * in the browser. All data access runs as the authenticated user; RLS
 * owner policies apply.
 *
 * Config: SUPABASE_URL is baked in (not secret). SUPABASE_ANON_KEY comes
 * from web/config.js (local dev, gitignored) or from the browser's
 * localStorage, entered once on the live site's setup screen. The key never
 * lives in the repo.
 *
 * v1 flow: pipeline (matched -> preparing -> review -> ready) ->
 * (Jayanth submits on the ATS site) -> submitted. Nothing here auto-submits.
 *
 * UX: keyboard-first review (j/k move, a approve, r reject), slide-over
 * detail drawer, optimistic actions with toasts, batch approve.
 */

const PROJECT_URL = "https://wbmihhwbtmongzjwsxdx.supabase.co";
const LS_KEY = "aa_anon_key";

function resolveConfig() {
  const fromFile = (typeof window.DASHBOARD_CONFIG !== "undefined")
    ? window.DASHBOARD_CONFIG : null;
  const url = (fromFile && fromFile.SUPABASE_URL && fromFile.SUPABASE_URL.indexOf("xyzcompany") !== 0)
    ? fromFile.SUPABASE_URL : PROJECT_URL;
  let key = (fromFile && fromFile.SUPABASE_ANON_KEY && fromFile.SUPABASE_ANON_KEY.indexOf("PASTE_") !== 0)
    ? fromFile.SUPABASE_ANON_KEY : null;
  if (!key) {
    try { key = localStorage.getItem(LS_KEY) || null; } catch (e) { key = null; }
  }
  return { url: url, key: key };
}

const CONFIG = resolveConfig();

let sb = null;          // supabase client
let candidateId = null; // Jayanth's candidates.id
let profileId = null;   // his default profiles.id
let trackerFilter = "all";
let currentView = "pipeline";
let reviewItems = [];   // [{id, el}] for keyboard nav
let kbIndex = -1;
let matchById = {};     // last pipeline load, for the match drawer

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");
const money = (n) => "$" + Number(n || 0).toFixed(2);
const money4 = (n) => "$" + Number(n || 0).toFixed(4);
const day = (ts) => String(ts || "").slice(0, 10);
const rel = (ts) => {
  if (!ts) return "";
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  const d = Math.floor(s / 86400);
  return d === 1 ? "1d ago" : d + "d ago";
};

const STATUSES = ["queued", "running", "needs_review", "ready_to_submit",
  "needs_otp", "manual", "submitted", "failed"];

// ---------- toasts ----------
function toast(msg, type) {
  const t = document.createElement("div");
  t.className = "toast " + (type || "info");
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 300);
  }, 3600);
}

// ---------- events (dashboard-side notes) ----------
async function logEvent(applicationId, type, payload) {
  const { error } = await sb.from("application_events").insert({
    application_id: applicationId,
    type: type,
    payload_json: payload,
  });
  if (error) {
    // Migration 008 adds the authenticated INSERT policy; if it is not
    // applied yet, inserts are rejected. Status changes still stand.
    console.warn("application_events insert blocked:", error.message);
    return false;
  }
  return true;
}

function refLink(ref) {
  const r = String(ref || "");
  if (!r) return "";
  if (/^https?:\/\//i.test(r)) return `<a href="${esc(r)}" target="_blank" rel="noopener">${esc(r)}</a>`;
  return `<code>${esc(r)}</code>`;
}

// ---------- small render helpers ----------
function statusPill(s) {
  return `<span class="pill ${esc(s)}">${esc(s).replace(/_/g, " ")}</span>`;
}
function atsBadge(ats) {
  if (!ats) return "";
  return `<span class="ats-badge">${esc(ats)}</span>`;
}
const REPLY_LABEL = {
  interview: "Interview", offer: "Offer", rejection: "Rejected",
  info_request: "Info request", confirmation: "Confirmed",
};
function replyChip(c) {
  if (!c) return `<span class="hint">—</span>`;
  const label = REPLY_LABEL[c] || c;
  return `<span class="reply ${esc(c)}">${esc(label)}</span>`;
}
function scoreHTML(score) {
  const pct = Math.round(Number(score || 0) * 100);
  return `<div class="scorebar"><div style="width:${pct}%"></div></div>` +
    `<div class="score-line"><span>match score</span><strong>${pct}%</strong></div>`;
}
// sponsorship / OPT / visa signals surfaced as chips when present in reasons_json
function signalChips(reasons) {
  const chips = [];
  const r = reasons || {};
  Object.entries(r).forEach(([k, v]) => {
    const kl = String(k).toLowerCase();
    const val = String(v).toLowerCase();
    const positive = val.includes("yes") || val.includes("will") || val.includes("ok") ||
      val.includes("accept") || val.includes("friendly") || v === true;
    if (kl.includes("sponsor") && positive) chips.push("Sponsors");
    else if ((kl.includes("opt") || kl.includes("stem")) && positive) chips.push("OPT-friendly");
    else if (kl.includes("visa") && positive) chips.push("Visa OK");
    else if (kl.includes("everify") || kl.includes("e-verify")) chips.push("E-Verify");
  });
  return [...new Set(chips)].map((c) => `<span class="sig-chip">${esc(c)}</span>`).join(" ");
}
function whyBullets(reasons) {
  const r = reasons || {};
  const out = [];
  if (r.threshold != null) {
    out.push(`Score clears your ${Math.round(Number(r.threshold) * 100)}% match threshold.`);
  }
  Object.entries(r).forEach(([k, v]) => {
    if (k === "threshold") return;
    const kl = String(k).toLowerCase();
    const val = (v && typeof v === "object") ? JSON.stringify(v) : String(v);
    if (kl.includes("sponsor") || kl.includes("opt") || kl.includes("visa") || kl.includes("everify")) {
      out.push(`<strong>${esc(k)}:</strong> ${esc(val)}`);
    } else {
      out.push(`<strong>${esc(k)}:</strong> ${esc(val)}`);
    }
  });
  if (!out.length) out.push("Scored by embedding similarity against your profile.");
  return out;
}
function whyHTML(reasons, open) {
  const chips = signalChips(reasons);
  const bullets = whyBullets(reasons).map((b) => `<li>${b}</li>`).join("");
  return (chips ? `<div class="kcard-meta">${chips}</div>` : "") +
    `<details class="why"${open ? " open" : ""}><summary>Why this match</summary><ul>${bullets}</ul></details>`;
}

// ---------- recruiter replies (shared by pipeline + tracker) ----------
async function loadReplyMap(appIds) {
  const map = {};        // appId -> latest meaningful classification
  const responded = new Set(); // appIds with a real employer reply
  if (!appIds.length) return { map: map, responded: responded };
  const { data: msgs } = await sb.from("inbound_messages")
    .select("application_id,classification,at")
    .in("application_id", appIds)
    .order("at", { ascending: false })
    .limit(2000);
  (msgs || []).forEach((m) => {
    if (!m.application_id || map[m.application_id] !== undefined) return;
    const c = m.classification;
    if (!c || c === "noise" || c === "otp") return;
    map[m.application_id] = c;
    if (c === "rejection" || c === "interview" || c === "offer" || c === "info_request") {
      responded.add(m.application_id);
    }
  });
  return { map: map, responded: responded };
}

// ---------- tabs ----------
$("#tabs").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-view]");
  if (!btn) return;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll("main .view").forEach((v) => v.classList.remove("active"));
  btn.classList.add("active");
  $("#view-" + btn.dataset.view).classList.add("active");
  currentView = btn.dataset.view;
  await loadView(currentView);
});

async function loadView(view) {
  if (view === "pipeline") return loadPipeline();
  if (view === "review") return loadReview();
  if (view === "tracker") return loadTracker();
  if (view === "costs") return loadCosts();
}

// ---------- pipeline (kanban) ----------
const KCOLS = [
  { key: "matched", label: "Matched", empty: ["No new matches", "Run your first Apify pull to fill the pipeline."] },
  { key: "preparing", label: "Preparing", statuses: ["queued", "running"], empty: ["Nothing preparing", "Prepared applications land here."] },
  { key: "review", label: "Needs review", statuses: ["needs_review"], empty: ["Nothing to review", "Tailored applications wait for your approval here."] },
  { key: "ready", label: "Ready", statuses: ["ready_to_submit", "manual", "needs_otp"], empty: ["Nothing ready", "Approved applications wait for your manual submit."] },
  { key: "submitted", label: "Submitted", statuses: ["submitted"], empty: ["No submissions yet", "Mark applications submitted after you apply on the ATS site."] },
  { key: "closed", label: "Closed", statuses: ["failed"], empty: ["Nothing closed", "Rejected or failed applications land here."] },
];

function kpiCard(label, value, sub, accent) {
  return `<div class="kpi${accent ? " accent" : ""}"><div class="kpi-label">${esc(label)}</div>` +
    `<div class="kpi-value">${value}</div>` +
    (sub ? `<div class="kpi-sub">${esc(sub)}</div>` : "") + `</div>`;
}

function matchCard(m) {
  const p = m.postings || {};
  return `<div class="kcard" data-match-id="${m.id}">` +
    `<div class="kcard-top"><span class="kcard-company">${esc(p.company || "")}</span>${atsBadge(p.ats_type)}</div>` +
    `<p class="kcard-title">${esc(p.title || "")}</p>` +
    `<div class="kcard-loc">${esc(p.location || "")}</div>` +
    scoreHTML(m.score) +
    `<div class="kcard-meta"><span class="kcard-age">${esc(rel(m.created_at))}</span></div>` +
    whyHTML(m.reasons_json, false) +
    `<div class="kcard-actions"><button class="btn primary" data-prepare="${m.id}">Prepare</button></div>` +
    `</div>`;
}

function appCard(a, replyByApp) {
  const p = a.postings || {};
  const reply = replyByApp[a.id];
  const canMark = (a.status === "ready_to_submit" || a.status === "manual");
  return `<div class="kcard" data-app-id="${a.id}">` +
    `<div class="kcard-top"><span class="kcard-company">${esc(p.company || "")}</span>${atsBadge(a.ats)}</div>` +
    `<p class="kcard-title">${esc(p.title || "")}</p>` +
    `<div class="kcard-loc">${esc(p.location || "")}</div>` +
    `<div class="kcard-meta">${statusPill(a.status)}${reply ? replyChip(reply) : ""}<span class="kcard-age">${esc(rel(a.updated_at))}</span></div>` +
    (canMark ? `<div class="kcard-actions"><button class="btn primary" data-mark-submitted="${a.id}">Mark submitted</button></div>` : "") +
    `</div>`;
}

async function loadPipeline() {
  const kanban = $("#kanban");
  const kpis = $("#kpi-row");
  kanban.innerHTML = `<p class="hint">Loading pipeline…</p>`;
  kpis.innerHTML = "";

  const { data: matches, error: merr } = await sb.from("matches")
    .select("id,score,reasons_json,created_at,posting_id,postings(company,title,location,url,ats_type)")
    .eq("profile_id", profileId)
    .order("score", { ascending: false })
    .limit(100);
  if (merr) {
    kanban.innerHTML = `<p class="hint">Could not load matches: ${esc(merr.message)}</p>`;
    return;
  }
  const { data: apps, error: aerr } = await sb.from("applications")
    .select("id,url,ats,status,receipt_json,tailored_resume_ref,updated_at,postings(company,title,location)")
    .eq("candidate_id", candidateId)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (aerr) {
    kanban.innerHTML = `<p class="hint">Could not load applications: ${esc(aerr.message)}</p>`;
    return;
  }

  const rows = apps || [];
  const byUrl = {};
  rows.forEach((a) => { byUrl[a.url] = a.status; });
  matchById = {};
  (matches || []).forEach((m) => { matchById[m.id] = m; });

  const { data: poolRows } = await sb.from("pool_spend_today").select("*");
  const pool = (poolRows && poolRows[0]) || null;
  const { map: replyByApp, responded } = await loadReplyMap(rows.map((a) => a.id));

  const newMatches = (matches || []).filter((m) => !byUrl[(m.postings || {}).url]);
  const count = (s) => rows.filter((a) => a.status === s).length;
  const submittedCount = count("submitted");
  const replyRate = submittedCount
    ? Math.round((responded.size / submittedCount) * 100) + "%"
    : "—";

  kpis.innerHTML =
    kpiCard("New matches", String(newMatches.length), "awaiting prep", true) +
    kpiCard("Awaiting review", String(count("needs_review")), "triage with j / k") +
    kpiCard("Ready to submit", String(count("ready_to_submit")), "you submit on the ATS") +
    kpiCard("Submitted", String(submittedCount), "marked submitted") +
    kpiCard("Reply rate", replyRate, `${responded.size} replies · ${submittedCount} submitted`) +
    kpiCard("Pool spend today", pool ? money(pool.spent_usd) : "n/a", "all users");

  const inCol = (a, col) => col.statuses && col.statuses.indexOf(a.status) !== -1;
  kanban.innerHTML = KCOLS.map((col) => {
    let cards = "";
    if (col.key === "matched") {
      cards = newMatches.map(matchCard).join("");
    } else {
      cards = rows.filter((a) => inCol(a, col)).map((a) => appCard(a, replyByApp)).join("");
    }
    const n = col.key === "matched"
      ? newMatches.length
      : rows.filter((a) => inCol(a, col)).length;
    if (!cards) {
      cards = `<div class="kempty"><strong>${esc(col.empty[0])}</strong>${esc(col.empty[1])}</div>`;
    }
    return `<div class="kcol"><div class="kcol-head"><span>${esc(col.label)}</span>` +
      `<span class="kcol-count">${n}</span></div><div class="kcol-body">${cards}</div></div>`;
  }).join("");
}

// prepare (from a match card or the match drawer)
document.addEventListener("click", async (e) => {
  const prep = e.target.dataset && e.target.dataset.prepare;
  if (!prep) return;
  const btn = e.target;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "Preparing…";
  try {
    const { data: m, error: merr } = await sb.from("matches")
      .select("posting_id,postings(url)")
      .eq("id", prep).single();
    if (merr) throw merr;
    const url = (m.postings || {}).url;
    if (!url) throw new Error("match has no posting url");
    const { data: app, error } = await sb.from("applications").insert({
      candidate_id: candidateId,
      profile_id: profileId,
      posting_id: m.posting_id,
      url: url,
      status: "queued",
    }).select("id").single();
    if (error) {
      if (error.code === "23505") {
        // unique(candidate_id, url) guard fired: another row already exists.
        toast("Already in your pipeline", "info");
        closeDrawer();
        loadPipeline();
        return;
      }
      throw error;
    }
    await logEvent(app.id, "note", { note: "prepared from pipeline by Jayanth" });
    toast("Application queued — see the Preparing column", "ok");
    closeDrawer();
    if (currentView === "pipeline") loadPipeline();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = orig;
    toast("Could not prepare the application: " + err.message, "error");
  }
});

// ---------- review ----------
function renderDiff(r) {
  const diff = r.diff;
  if (!diff || !diff.length) return "";
  const blocks = diff.map((d) => {
    if (typeof d === "string") return `<div class="diff-new">${esc(d)}</div>`;
    const section = d.section ? `<div class="diff-section">${esc(d.section)}</div>` : "";
    return section +
      (d.old ? `<div class="diff-old">${esc(d.old)}</div>` : "") +
      (d.new ? `<div class="diff-new">${esc(d.new)}</div>` : "");
  }).join("");
  return `<h4>What changed vs your base resume</h4>${blocks}`;
}

function renderAnswers(r) {
  const answers = r.filled_answers || r.answers;
  if (!answers || !Object.keys(answers).length) return "";
  return `<h4>Exact answers that will be used</h4><table class="answers"><tbody>` +
    Object.entries(answers).map(([k, v]) =>
      `<tr><td class="ans-key">${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join("") +
    `</tbody></table>`;
}

function renderUnanswered(r) {
  const qs = r.unanswered_questions || r.unanswerable_questions;
  if (!qs || !qs.length) return "";
  return `<h4>Needs your answer (the worker refused to guess)</h4>` +
    qs.map((q) => {
      const label = typeof q === "string" ? q : q.label;
      const opts = (q && q.options && q.options.length)
        ? `<br>Options: ${esc(q.options.join(" | "))}` : "";
      return `<div class="unanswered"><strong>${esc(label)}</strong>${opts}</div>`;
    }).join("");
}

function updateReviewBadge(n) {
  $("#review-count").textContent = n || "";
}

function reviewCardHTML(app) {
  const r = app.review_json || {};
  const posting = r.posting || {};
  return `<h3>${esc(posting.title || "")} <small>${esc(posting.company || "")}</small></h3>` +
    `<div class="kcard-meta">${atsBadge(app.ats)}<span class="kcard-age">${esc(rel(app.created_at))}</span></div>` +
    renderUnanswered(r) + renderDiff(r) + renderAnswers(r) +
    (app.tailored_resume_ref
      ? `<p class="hint">Tailored resume: ${refLink(app.tailored_resume_ref)}</p>` : "") +
    (app.cover_letter_ref
      ? `<p class="hint">Cover letter: ${refLink(app.cover_letter_ref)}</p>` : "") +
    `<p><a href="${esc(app.url)}" target="_blank" rel="noopener">Open posting</a></p>` +
    `<div class="review-actions">` +
    `<button class="btn primary" data-approve="${app.id}">Approve</button>` +
    `<button class="btn danger" data-reject="${app.id}">Reject</button>` +
    `<span class="kb-note"><kbd>a</kbd> approve · <kbd>r</kbd> reject</span>` +
    `</div>`;
}

function emptyReviewHTML() {
  return `<div class="kempty" style="max-width:520px"><strong>All caught up</strong>` +
    `Nothing waiting for review. New matches land in the Pipeline.</div>`;
}

async function loadReview() {
  const list = $("#review-list");
  list.innerHTML = "<p class='hint'>Loading…</p>";
  reviewItems = [];
  kbIndex = -1;
  const { data: rows, error } = await sb.from("applications")
    .select("id,url,ats,review_json,tailored_resume_ref,cover_letter_ref,created_at")
    .eq("candidate_id", candidateId)
    .eq("status", "needs_review")
    .order("created_at", { ascending: false });
  if (error) {
    list.innerHTML = `<p class="hint">Could not load review queue: ${esc(error.message)}</p>`;
    return;
  }
  updateReviewBadge(rows.length);
  $("#approve-all").disabled = !rows.length;
  list.innerHTML = "";
  if (!rows.length) {
    list.innerHTML = emptyReviewHTML();
    return;
  }
  rows.forEach((app) => {
    const card = document.createElement("div");
    card.className = "review-card";
    card.dataset.id = app.id;
    card.innerHTML = reviewCardHTML(app);
    list.appendChild(card);
    reviewItems.push({ id: app.id, el: card });
  });
  moveKb(0, true);
}

function moveKb(dir, absolute) {
  if (!reviewItems.length) return;
  if (absolute) kbIndex = 0;
  else kbIndex = Math.min(reviewItems.length - 1, Math.max(0, kbIndex + dir));
  reviewItems.forEach((it, i) => it.el.classList.toggle("kb-active", i === kbIndex));
  const el = reviewItems[kbIndex] && reviewItems[kbIndex].el;
  if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function removeReviewItem(id) {
  const i = reviewItems.findIndex((x) => x.id === id);
  if (i === -1) return;
  reviewItems[i].el.remove();
  reviewItems.splice(i, 1);
  if (!reviewItems.length) {
    kbIndex = -1;
    $("#review-list").innerHTML = emptyReviewHTML();
    $("#approve-all").disabled = true;
  } else {
    kbIndex = Math.min(i, reviewItems.length - 1);
    moveKb(0, true);
  }
  updateReviewBadge(reviewItems.length);
}

async function approveApp(id) {
  const item = reviewItems.find((x) => x.id === id);
  if (item) item.el.classList.add("leaving");
  const { error } = await sb.from("applications")
    .update({ status: "ready_to_submit" }).eq("id", id);
  if (error) {
    if (item) item.el.classList.remove("leaving");
    toast("Approve failed: " + error.message, "error");
    return;
  }
  await logEvent(id, "note", { note: "approved by Jayanth" });
  removeReviewItem(id);
  toast("Approved — ready for you to submit on the ATS site", "ok");
}

async function rejectApp(id) {
  const note = prompt("Reject this application. Your note (saved to the event log):");
  if (note === null) return; // cancelled
  const item = reviewItems.find((x) => x.id === id);
  if (item) item.el.classList.add("leaving");
  const { error } = await sb.from("applications")
    .update({ status: "failed", failure_reason: "rejected_at_review" }).eq("id", id);
  if (error) {
    if (item) item.el.classList.remove("leaving");
    toast("Reject failed: " + error.message, "error");
    return;
  }
  await logEvent(id, "note", { note: "rejected at review by Jayanth: " + (note || "(no note)") });
  removeReviewItem(id);
  toast("Rejected and closed", "ok");
}

document.addEventListener("click", async (e) => {
  const ap = e.target.dataset && e.target.dataset.approve;
  const rj = e.target.dataset && e.target.dataset.reject;
  if (ap) { approveApp(ap); return; }
  if (rj) { rejectApp(rj); return; }
  const ms = e.target.dataset && e.target.dataset.markSubmitted;
  if (ms) markSubmitted(ms);
});

$("#approve-all").addEventListener("click", async () => {
  const ids = reviewItems.map((x) => x.id);
  if (!ids.length) { toast("Review queue is empty", "info"); return; }
  const btn = $("#approve-all");
  btn.disabled = true;
  reviewItems.forEach((x) => x.el.classList.add("leaving"));
  let failed = 0;
  for (const id of ids) {
    const { error } = await sb.from("applications")
      .update({ status: "ready_to_submit" }).eq("id", id);
    if (error) failed++;
    else await logEvent(id, "note", { note: "approved by Jayanth (batch)" });
  }
  reviewItems = [];
  kbIndex = -1;
  $("#review-list").innerHTML = emptyReviewHTML();
  updateReviewBadge(0);
  if (failed) {
    toast(`Approved ${ids.length - failed}, ${failed} failed — reloading`, "error");
    loadReview();
  } else {
    toast(`Approved ${ids.length} application${ids.length > 1 ? "s" : ""} — ready to submit`, "ok");
  }
});

async function markSubmitted(id) {
  const text = prompt("Paste the confirmation or receipt text from the ATS site:");
  if (text === null || !text.trim()) return; // cancelled or empty
  const { data: cur } = await sb.from("applications")
    .select("receipt_json").eq("id", id).single();
  const receipt = Object.assign({}, (cur && cur.receipt_json) || {},
    { manual_receipt: text.trim() });
  const { error } = await sb.from("applications")
    .update({ status: "submitted", receipt_json: receipt }).eq("id", id);
  if (error) { toast("Mark submitted failed: " + error.message, "error"); return; }
  await logEvent(id, "note", { note: "marked submitted by Jayanth after manual submit" });
  toast("Marked submitted", "ok");
  closeDrawer();
  loadView(currentView);
}

// keyboard-first review: j/k move, a approve, r reject, Esc closes drawer
document.addEventListener("keydown", (e) => {
  const drawerOpen = $("#drawer").classList.contains("open");
  if (e.key === "Escape") { if (drawerOpen) closeDrawer(); return; }
  if (drawerOpen) return;
  if (currentView !== "review") return;
  if (e.target.closest("input, textarea, select")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "j") { moveKb(1); e.preventDefault(); }
  else if (k === "k") { moveKb(-1); e.preventDefault(); }
  else if (k === "a") { const it = reviewItems[kbIndex]; if (it) approveApp(it.id); }
  else if (k === "r") { const it = reviewItems[kbIndex]; if (it) rejectApp(it.id); }
});

// ---------- tracker ----------
function renderTrackerFilters(counts) {
  const wrap = $("#tracker-filters");
  const chips = ["all"].concat(STATUSES).map((s) => {
    const label = s === "all" ? "all" : s.replace(/_/g, " ");
    const n = s === "all"
      ? STATUSES.reduce((t, x) => t + (counts[x] || 0), 0)
      : (counts[s] || 0);
    return `<button class="btn${s === trackerFilter ? " on" : ""}"` +
      ` data-filter="${s}">${esc(label)} (${n})</button>`;
  }).join("");
  wrap.innerHTML = chips;
}

document.addEventListener("click", async (e) => {
  const f = e.target.dataset && e.target.dataset.filter;
  if (!f) return;
  trackerFilter = f;
  loadTracker();
});

async function loadTracker() {
  const tb = $("#tracker-table tbody");
  tb.innerHTML = `<tr><td colspan="6">Loading…</td></tr>`;
  let q = sb.from("applications")
    .select("id,url,ats,status,receipt_json,tailored_resume_ref,updated_at,postings(company,title,location)")
    .eq("candidate_id", candidateId)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (trackerFilter !== "all") q = q.eq("status", trackerFilter);
  const { data: rows, error } = await q;
  if (error) {
    tb.innerHTML = `<tr><td colspan="6">Could not load tracker: ${esc(error.message)}</td></tr>`;
    return;
  }
  // counts for the filter chips (one extra cheap query over statuses)
  const { data: allRows } = await sb.from("applications")
    .select("status").eq("candidate_id", candidateId).limit(2000);
  const counts = {};
  (allRows || []).forEach((a) => { counts[a.status] = (counts[a.status] || 0) + 1; });
  renderTrackerFilters(counts);
  const { map: replyByApp } = await loadReplyMap((rows || []).map((a) => a.id));
  tb.innerHTML = (rows || []).map((a) => {
    const p = a.postings || {};
    const canMark = (a.status === "ready_to_submit" || a.status === "manual");
    return `<tr><td><strong>${esc(p.company || "")}</strong></td><td>${esc(p.title || "")}</td>` +
      `<td>${statusPill(a.status)}</td>` +
      `<td>${replyChip(replyByApp[a.id])}</td>` +
      `<td>${day(a.updated_at)}</td>` +
      `<td><div class="row-actions"><button class="btn" data-detail="${a.id}">Detail</button>` +
      (canMark ? `<button class="btn primary" data-mark-submitted="${a.id}">Mark submitted</button>` : "") +
      `</div></td></tr>`;
  }).join("") || `<tr><td colspan="6"><div class="kempty"><strong>No applications yet</strong>Prepare one from the Pipeline.</div></td></tr>`;
}

// ---------- slide-over detail drawer ----------
function showDrawer(html) {
  $("#drawer-content").innerHTML = html;
  $("#drawer").classList.add("open");
  $("#scrim").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}
function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#scrim").classList.add("hidden");
  document.body.style.overflow = "";
}
$("#drawer-close").addEventListener("click", closeDrawer);
$("#scrim").addEventListener("click", closeDrawer);

function openMatchDrawer(m) {
  const p = m.postings || {};
  showDrawer(
    `<h3>${esc(p.company || "")} — ${esc(p.title || "")}</h3>` +
    `<p class="hint">${esc(p.location || "")}</p>` +
    `<div class="kcard-meta">${atsBadge(p.ats_type)}<span class="kcard-age">${esc(rel(m.created_at))}</span></div>` +
    scoreHTML(m.score) +
    whyHTML(m.reasons_json, true) +
    `<p style="margin-top:14px"><a href="${esc(p.url)}" target="_blank" rel="noopener">Open posting</a></p>` +
    `<button class="btn primary block" data-prepare="${m.id}">Prepare application</button>`
  );
}

async function openDrawer(id) {
  showDrawer(`<p class="hint">Loading…</p>`);
  const { data: app, error } = await sb.from("applications")
    .select("id,url,ats,status,failure_reason,review_json,receipt_json,tailored_resume_ref,cover_letter_ref,created_at,updated_at,postings(company,title,location)")
    .eq("id", id).single();
  if (error) { showDrawer(`<p class="hint">Detail failed: ${esc(error.message)}</p>`); return; }
  const { data: events } = await sb.from("application_events")
    .select("type,payload_json,at").eq("application_id", id).order("at", { ascending: false });
  const { data: msgs } = await sb.from("inbound_messages")
    .select("subject,classification,from_addr,at").eq("application_id", id)
    .order("at", { ascending: false });
  const p = app.postings || {};
  const r = app.review_json || {};
  showDrawer(
    `<h3>${esc(p.company || "")} — ${esc(p.title || "")}</h3>` +
    `<p>${statusPill(app.status)} ${atsBadge(app.ats)} ` +
    `<a href="${esc(app.url)}" target="_blank" rel="noopener">Open posting</a></p>` +
    `<p class="hint">${esc(p.location || "")} · updated ${esc(rel(app.updated_at))}</p>` +
    (app.failure_reason ? `<p class="hint">Failure reason: ${esc(app.failure_reason)}</p>` : "") +
    `<h4>Tailored resume</h4><p>${app.tailored_resume_ref ? refLink(app.tailored_resume_ref) : "<span class=hint>none</span>"}</p>` +
    `<h4>Cover letter</h4><p>${app.cover_letter_ref ? refLink(app.cover_letter_ref) : "<span class=hint>none</span>"}</p>` +
    `<h4>Receipt</h4>` +
    (app.receipt_json
      ? `<pre class="cover">${esc(JSON.stringify(app.receipt_json, null, 2))}</pre>`
      : `<p class="hint">No receipt recorded yet.</p>`) +
    (r.diff && r.diff.length ? `<h4>Review diff</h4>` + renderDiff(r) : "") +
    `<h4>Recruiter mail (${(msgs || []).length})</h4>` +
    ((msgs || []).map((m) =>
      `<div class="msg">${replyChip(m.classification)} ` +
      `<strong>${esc(m.subject || "(no subject)")}</strong><br>` +
      `<span class="hint">${esc(m.from_addr || "")} · ${rel(m.at)}</span></div>`
    ).join("") || `<p class="hint">No linked messages.</p>`) +
    `<h4>Timeline</h4><div class="timeline">` +
    ((events || []).map((ev) =>
      `<div class="event"><span class="event-type">${esc(ev.type)}</span> ` +
      `<span class="hint">${rel(ev.at)}</span>` +
      `<pre class="cover">${esc(JSON.stringify(ev.payload_json || {}, null, 2))}</pre></div>`
    ).join("") || `<p class="hint">No events.</p>`) + `</div>`
  );
}

// kanban card clicks open the drawer (buttons/links/expands keep working)
document.addEventListener("click", (e) => {
  const d = e.target.dataset && e.target.dataset.detail;
  if (d) { openDrawer(d); return; }
  const card = e.target.closest(".kcard");
  if (!card) return;
  if (e.target.closest("button, a, summary, input")) return;
  if (card.dataset.appId) openDrawer(card.dataset.appId);
  else if (card.dataset.matchId && matchById[card.dataset.matchId]) {
    openMatchDrawer(matchById[card.dataset.matchId]);
  }
});

// ---------- costs ----------
async function loadCosts() {
  const cards = $("#cost-cards");
  const burnPanel = $("#burn-panel");
  const infraPanel = $("#infra-panel");
  cards.innerHTML = `<p class="hint">Loading…</p>`;
  burnPanel.innerHTML = ""; infraPanel.innerHTML = "";

  // pool-wide aggregate for today (SECURITY DEFINER view, granted to authenticated)
  const { data: poolRows } = await sb.from("pool_spend_today").select("*");
  const pool = (poolRows && poolRows[0]) || null;

  // his own ledger rows (RLS: user_id = auth.uid())
  const { data: ledger, error: lerr } = await sb.from("cost_ledger")
    .select("kind,amount_usd,at,detail")
    .order("at", { ascending: false })
    .limit(2000);
  if (lerr) {
    cards.innerHTML = `<p class="hint">Could not load costs: ${esc(lerr.message)}</p>`;
    return;
  }
  const rows = ledger || [];

  // net spend excludes holds/releases (holds are temporary, not real spend)
  const net = rows.filter((r) => r.kind !== "hold" && r.kind !== "release");
  const totalNet = net.reduce((s, r) => s + parseFloat(r.amount_usd), 0);
  const byKind = {};
  net.forEach((r) => {
    byKind[r.kind] = byKind[r.kind] || { calls: 0, usd: 0 };
    byKind[r.kind].calls += 1;
    byKind[r.kind].usd += parseFloat(r.amount_usd);
  });

  const { count: submittedCount } = await sb.from("applications")
    .select("id", { count: "exact", head: true })
    .eq("candidate_id", candidateId)
    .eq("status", "submitted");
  const perApp = submittedCount ? totalNet / submittedCount : 0;

  cards.innerHTML =
    kpiCard("Pool spent today (all users)", pool ? money(pool.spent_usd) : "n/a", "") +
    kpiCard("Your total net spend", money(totalNet), "") +
    kpiCard("Per-application cost", money(perApp), "") +
    kpiCard("Applications submitted", String(submittedCount || 0), "");

  $("#costs-table tbody").innerHTML =
    Object.entries(byKind).sort((a, b) => b[1].usd - a[1].usd).map(([k, v]) =>
      `<tr><td>${esc(k)}</td><td>${v.calls}</td><td>${money4(v.usd)}</td></tr>`
    ).join("") || `<tr><td colspan="3">No spend recorded yet.</td></tr>`;
  $("#ledger-table tbody").innerHTML = rows.slice(0, 50).map((r) =>
    `<tr><td>${day(r.at)}</td><td>${esc(r.kind)}</td><td>${money4(r.amount_usd)}</td>` +
    `<td class="detail-cell">${esc(JSON.stringify(r.detail || {}))}</td></tr>`
  ).join("") || `<tr><td colspan="4">No ledger rows yet.</td></tr>`;

  // burn-down against pool budget windows (admin/service-role only via RLS)
  const { data: budgets } = await sb.from("pool_budgets")
    .select("period_start,period_end,budget_usd,note,alert_50_sent,alert_80_sent,alert_100_sent")
    .order("period_start", { ascending: false })
    .limit(5);
  if (budgets && budgets.length) {
    const today = new Date().toISOString().slice(0, 10);
    const active = budgets.find((b) => b.period_start <= today && today <= b.period_end) || budgets[0];
    const budget = parseFloat(active.budget_usd);
    const windowSpend = net
      .filter((r) => (r.at || "").slice(0, 10) >= active.period_start &&
                     (r.at || "").slice(0, 10) <= active.period_end)
      .reduce((s, r) => s + parseFloat(r.amount_usd), 0);
    const pct = budget > 0 ? Math.min(100, (windowSpend / budget) * 100) : 0;
    burnPanel.innerHTML =
      `<div class="panel"><p><strong>Window:</strong> ${esc(active.period_start)} to ${esc(active.period_end)}` +
      ` — budget <strong>${money(budget)}</strong>` +
      (active.note ? ` (${esc(active.note)})` : "") + `</p>` +
      `<p class="hint">Bar shows your ledger spend inside the window. ` +
      `Pool-wide spend is exposed only as the daily aggregate above.</p>` +
      `<div class="burn"><div class="burn-fill" style="width:${pct.toFixed(1)}%"></div>` +
      [50, 80, 100].map((m) =>
        `<div class="burn-marker" style="left:${m}%"></div>`).join("") +
      `</div><p>${money(windowSpend)} of ${money(budget)} (${pct.toFixed(1)}%) — ` +
      `red markers at 50%, 80%, 100%</p></div>`;
  } else {
    burnPanel.innerHTML =
      `<div class="panel placeholder"><p><strong>Pool budget windows are not visible to this page.</strong></p>` +
      `<p>pool_budgets has RLS enabled with no read policy for the authenticated role ` +
      `(migration 003), so the client cannot draw the 50/80/100% burn-down markers. ` +
      `No numbers are faked here.</p>` +
      `<p class="hint">Admin check: SELECT period_start, period_end, budget_usd FROM pool_budgets ` +
      `ORDER BY period_start DESC LIMIT 5;</p></div>`;
  }

  // DB size / storage bytes: not queryable from the client
  infraPanel.innerHTML =
    `<div class="panel placeholder"><p><strong>Database size and storage bytes are not shown.</strong></p>` +
    `<p>PostgREST exposes no size functions to the authenticated role, so this page ` +
    `cannot read pg_database_size() or Storage bucket usage. Showing a number here ` +
    `would be fabricated, so it is left blank.</p>` +
    `<p class="hint">Admin: run SELECT pg_size_pretty(pg_database_size(current_database())); ` +
    `in the SQL editor, and check Storage usage in the Supabase dashboard.</p></div>`;
}

// ---------- auth + boot ----------
$("#auth-signin").addEventListener("click", async () => {
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  $("#auth-error").textContent = "";
  const { error } = await sb.auth.signInWithPassword({ email: email, password: password });
  if (error) $("#auth-error").textContent = error.message;
});

$("#auth-signout").addEventListener("click", async () => {
  await sb.auth.signOut();
});

async function loadIdentity() {
  const { data: cands } = await sb.from("candidates").select("id").limit(1);
  if (!cands || !cands.length) throw new Error("no candidate row for this user");
  candidateId = cands[0].id;
  const { data: profs } = await sb.from("profiles")
    .select("id,label").eq("candidate_id", candidateId);
  if (!profs || !profs.length) throw new Error("no profile for this candidate");
  const def = profs.find((p) => p.label === "default") || profs[0];
  profileId = def.id;
}

async function enterApp(user) {
  $("#auth-view").classList.add("hidden");
  $("#shell").classList.remove("hidden");
  $("#auth-user").textContent = user.email || "";
  try {
    await loadIdentity();
    await loadView(currentView);
  } catch (err) {
    toast("Signed in, but could not load your candidate data: " + err.message, "error");
    $("#kpi-row").innerHTML = `<p class="hint">Signed in, but could not load your candidate data: ${esc(err.message)}</p>`;
  }
}

function enterLogin() {
  closeDrawer();
  $("#auth-view").classList.remove("hidden");
  $("#shell").classList.add("hidden");
  $("#auth-user").textContent = "";
  candidateId = null;
  profileId = null;
}

(function boot() {
  if (!CONFIG.url || !CONFIG.key) {
    const note = $("#setup-note");
    note.classList.remove("hidden");
    note.innerHTML =
      "<strong>One-time setup:</strong> paste your Supabase <em>anon public</em> key " +
      "(Supabase dashboard → Project Settings → API → Project API keys). " +
      "It is stored only in this browser's local storage, never in the repo.<br><br>" +
      '<input id="setup-key" type="password" autocomplete="off" placeholder="anon public key" ' +
      'style="width:100%;padding:10px 12px;font-size:14px;border:1px solid #d1d5db;border-radius:8px">' +
      '<div style="margin-top:10px"><button id="setup-save" class="btn primary block">Save key</button></div>' +
      '<p id="setup-err" class="error"></p>';
    $("#setup-save").addEventListener("click", () => {
      const v = $("#setup-key").value.trim();
      if (v.length < 20) {
        $("#setup-err").textContent = "That does not look like a Supabase anon key. Try again.";
        return;
      }
      try { localStorage.setItem(LS_KEY, v); } catch (e) {
        $("#setup-err").textContent = "Could not save to local storage: " + e.message;
        return;
      }
      location.reload();
    });
    return;
  }
  sb = window.supabase.createClient(CONFIG.url, CONFIG.key);
  sb.auth.onAuthStateChange((_event, session) => {
    if (session && session.user) enterApp(session.user);
    else enterLogin();
  });
  sb.auth.getSession().then(({ data }) => {
    if (data.session && data.session.user) enterApp(data.session.user);
    else enterLogin();
  });
})();
