/* auto-apply dashboard (GitHub Pages, static, no build step).
 *
 * Tsenta-style surfaces, our backend:
 *   Discovery = match feed (find)      Prep = per-role tailoring (prep)
 *   Review    = approve/reject gate    Apply = ready-to-submit (apply)
 *   Track     = application board      Activity = event feed
 *   Costs     = pool spend
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
 * v1 flow: discovery -> prep -> review -> ready_to_submit ->
 * (Jayanth submits on the ATS site himself) -> submitted. Nothing here
 * auto-submits, ever.
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
let candidateId = null; // candidates.id
let profileId = null;   // default profiles.id
let currentView = "discovery";
let reviewItems = [];   // [{id, el}] for keyboard nav
let kbIndex = -1;
let matchById = {};     // last discovery load, for the match drawer
let allMatches = [];    // unfiltered discovery matches
let authUserId = null;  // supabase auth.users.id (RLS: pull_requests.requested_by)

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

// ---------- tailoring package renderers (review_json) ----------
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
  return `<div class="diff-block">${blocks}</div>`;
}

function renderCoverLetter(r, ref) {
  if (r.cover_letter) return `<pre class="cover">${esc(String(r.cover_letter))}</pre>`;
  if (ref) return `<p>${refLink(ref)}</p>`;
  return "";
}

function renderAnswers(r) {
  const answers = r.filled_answers || r.answers;
  if (!answers || !Object.keys(answers).length) return "";
  return `<table class="answers"><tbody>` +
    Object.entries(answers).map(([k, v]) =>
      `<tr><td class="ans-key">${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join("") +
    `</tbody></table>`;
}

function renderUnanswered(r) {
  const qs = r.unanswered_questions || r.unanswerable_questions;
  if (!qs || !qs.length) return "";
  return qs.map((q) => {
    const label = typeof q === "string" ? q : q.label;
    const opts = (q && q.options && q.options.length)
      ? `<br>Options: ${esc(q.options.join(" | "))}` : "";
    return `<div class="unanswered"><strong>${esc(label)}</strong>${opts}</div>`;
  }).join("");
}

// ---------- recruiter replies ----------
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
  if (view === "discovery") return loadDiscovery();
  if (view === "prep") return loadPrep();
  if (view === "review") return loadReview();
  if (view === "apply") return loadApply();
  if (view === "track") return loadTrack();
  if (view === "activity") return loadActivity();
  if (view === "costs") return loadCosts();
}

function kpiCard(label, value, sub, accent) {
  return `<div class="kpi${accent ? " accent" : ""}"><div class="kpi-label">${esc(label)}</div>` +
    `<div class="kpi-value">${value}</div>` +
    (sub ? `<div class="kpi-sub">${esc(sub)}</div>` : "") + `</div>`;
}

// ---------- DISCOVERY (find): match feed ----------
function matchCard(m) {
  const p = m.postings || {};
  const posted = p.first_seen_at ? rel(p.first_seen_at) : "";
  return `<div class="kcard" data-match-id="${m.id}">` +
    `<div class="kcard-top"><span class="kcard-company">${esc(p.company || "")}</span>${atsBadge(p.ats_type)}</div>` +
    `<p class="kcard-title">${esc(p.title || "")}</p>` +
    `<div class="kcard-loc">${esc(p.location || "")}${posted ? ` · posted ${esc(posted)}` : ""}</div>` +
    scoreHTML(m.score) +
    whyHTML(m.reasons_json, false) +
    `<div class="kcard-actions"><button class="btn" data-jd="${m.id}">Description</button>` +
    `<button class="btn primary" data-prepare="${m.id}">Prepare application</button></div>` +
    `</div>`;
}

function filteredMatches() {
  const minScore = Number($("#f-minscore").value) / 100;
  const locQ = $("#f-location").value.trim().toLowerCase();
  const remoteOnly = $("#f-remote").checked;
  return allMatches.filter((m) => {
    if (Number(m.score || 0) < minScore) return false;
    const loc = String((m.postings || {}).location || "").toLowerCase();
    if (locQ && loc.indexOf(locQ) === -1) return false;
    if (remoteOnly && loc.indexOf("remote") === -1) return false;
    return true;
  });
}

function renderMatchList() {
  const list = $("#match-list");
  const rows = filteredMatches();
  $("#f-count").textContent = `${rows.length} of ${allMatches.length} matches`;
  if (!rows.length) {
    list.innerHTML = allMatches.length
      ? `<div class="kempty"><strong>No matches pass these filters</strong>Loosen the filters to see more.</div>`
      : `<div class="kempty"><strong>No matches yet</strong>Run your first Apify pull to fill the pipeline with real postings.<br><br><button class="btn primary" data-pull-jobs>Pull jobs now</button></div>`;
    return;
  }
  list.innerHTML = "";
  rows.forEach((m) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = matchCard(m);
    list.appendChild(wrap.firstChild);
  });
}

["f-minscore", "f-location", "f-remote"].forEach((id) => {
  document.addEventListener("input", (e) => {
    if (e.target && e.target.id === id) {
      if (id === "f-minscore") $("#f-minscore-val").textContent = e.target.value + "%";
      if (currentView === "discovery") renderMatchList();
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target && e.target.id === id && currentView === "discovery") renderMatchList();
  });
});

function updateReviewBadge(n) {
  $("#review-count").textContent = n || "";
}

async function loadDiscovery() {
  const list = $("#match-list");
  const kpis = $("#kpi-row");
  list.innerHTML = `<p class="hint">Loading matches…</p>`;
  kpis.innerHTML = "";

  const { data: matches, error: merr } = await sb.from("matches")
    .select("id,score,reasons_json,created_at,posting_id,postings(company,title,location,url,ats_type,description_raw,first_seen_at)")
    .eq("profile_id", profileId)
    .order("score", { ascending: false })
    .limit(200);
  if (merr) {
    list.innerHTML = `<p class="hint">Could not load matches: ${esc(merr.message)}</p>`;
    return;
  }
  const { data: apps, error: aerr } = await sb.from("applications")
    .select("id,url,status,updated_at")
    .eq("candidate_id", candidateId)
    .limit(2000);
  if (aerr) {
    list.innerHTML = `<p class="hint">Could not load applications: ${esc(aerr.message)}</p>`;
    return;
  }

  const rows = apps || [];
  const byUrl = {};
  rows.forEach((a) => { byUrl[a.url] = a.status; });
  matchById = {};
  allMatches = (matches || []).filter((m) => !byUrl[(m.postings || {}).url]);
  allMatches.forEach((m) => { matchById[m.id] = m; });

  const { data: poolRows } = await sb.from("pool_spend_today").select("*");
  const pool = (poolRows && poolRows[0]) || null;
  const { responded } = await loadReplyMap(rows.map((a) => a.id));

  const count = (s) => rows.filter((a) => a.status === s).length;
  const submittedCount = count("submitted");
  const replyRate = submittedCount
    ? Math.round((responded.size / submittedCount) * 100) + "%"
    : "—";
  const needsReview = count("needs_review");
  updateReviewBadge(needsReview);

  kpis.innerHTML =
    kpiCard("New matches", String(allMatches.length), "awaiting prep", true) +
    kpiCard("Awaiting review", String(needsReview), "triage with j / k") +
    kpiCard("Ready to submit", String(count("ready_to_submit")), "you submit on the ATS") +
    kpiCard("Submitted", String(submittedCount), "marked submitted") +
    kpiCard("Reply rate", replyRate, `${responded.size} replies · ${submittedCount} submitted`) +
    kpiCard("Pool spend today", pool ? money(pool.spent_usd) : "n/a", "all users");

  renderMatchList();
  syncPullState();
}

// ---------- PULL JOBS: UI-triggered Apify sourcing ----------
// The dashboard inserts a pull_requests row (RLS: requested_by = auth.uid()).
// The pull_worker cron (service role) picks it up and runs the pull.
const PULL_ACTOR_ID = "Dn2KJLnaNC5vFGkEw"; // fantastic-jobs/career-site-job-listing-feed
const PULL_MAX_ITEMS = 200;
const PULL_USD_PER_ITEM = 0.003;
let pullTimer = null;

async function latestPull() {
  const { data, error } = await sb.from("pull_requests")
    .select("id,status,progress,error,max_items,created_at")
    .eq("requested_by", authUserId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

function renderPullStatus(p) {
  const pill = $("#pull-status");
  const btn = $("#pull-jobs");
  const busy = p && (p.status === "queued" || p.status === "running");
  btn.disabled = !!busy;
  if (!p) { pill.className = "pill hidden"; pill.textContent = ""; return; }
  const prog = p.progress || {};
  if (p.status === "queued") {
    pill.className = "pill queued"; pill.textContent = "Pull queued";
  } else if (p.status === "running") {
    const extra = prog.fetched != null ? ` · ${prog.fetched} fetched`
      : (prog.new != null ? ` · ${prog.new} new` : "");
    pill.className = "pill running"; pill.textContent = "Pull running" + extra;
  } else if (p.status === "done") {
    const r = prog.result || {};
    pill.className = "pill submitted";
    pill.textContent = `Last pull: ${r.new != null ? r.new : "—"} new`;
  } else {
    pill.className = "pill failed"; pill.textContent = "Pull failed";
  }
}

function stopPullPolling() {
  if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
}

function startPullPolling() {
  stopPullPolling();
  const tick = async () => {
    let p = null;
    try { p = await latestPull(); }
    catch (e) { return; } // transient; keep polling
    renderPullStatus(p);
    if (p && (p.status === "done" || p.status === "failed")) {
      stopPullPolling();
      if (p.status === "done") {
        const r = (p.progress || {}).result || {};
        toast(`Pull done — ${r.new || 0} new postings, ${r.matched || 0} new matches`, "ok");
        if (currentView === "discovery") loadDiscovery();
      } else {
        toast("Pull failed: " + (p.error || "unknown error"), "error");
      }
    }
  };
  tick();
  pullTimer = setInterval(tick, 10000);
}

async function syncPullState() {
  try {
    const p = await latestPull();
    renderPullStatus(p);
    if (p && (p.status === "queued" || p.status === "running")) startPullPolling();
    else stopPullPolling();
  } catch (e) {
    // pull_requests table not migrated yet: leave the button enabled;
    // the insert will surface the real error.
  }
}

async function requestPull() {
  let p = null;
  try { p = await latestPull(); } catch (e) { /* table may not exist yet */ }
  if (p && (p.status === "queued" || p.status === "running")) {
    toast("A pull is already queued or running", "info");
    return;
  }
  const cap = `Up to ${PULL_MAX_ITEMS} listings, about $${(PULL_MAX_ITEMS * PULL_USD_PER_ITEM).toFixed(2)} max — counts toward your $5/month Apify budget.`;
  if (!confirm("Pull fresh job listings from Apify?\n\n" + cap)) return;
  const { error } = await sb.from("pull_requests").insert({
    requested_by: authUserId,
    actor_id: PULL_ACTOR_ID,
    max_items: PULL_MAX_ITEMS,
    actor_input: {},
  });
  if (error) {
    toast("Could not start the pull: " + error.message, "error");
    return;
  }
  toast("Pull queued — the worker picks it up within ~15 minutes", "ok");
  startPullPolling();
}

document.addEventListener("click", (e) => {
  if (e.target && e.target.closest && e.target.closest("#pull-jobs,[data-pull-jobs]")) {
    requestPull();
  }
});

function openMatchDrawer(m) {
  const p = m.postings || {};
  const posted = p.first_seen_at ? rel(p.first_seen_at) : "";
  showDrawer(
    `<h3>${esc(p.company || "")} — ${esc(p.title || "")}</h3>` +
    `<p class="hint">${esc(p.location || "")}${posted ? ` · posted ${esc(posted)}` : ""}</p>` +
    `<div class="kcard-meta">${atsBadge(p.ats_type)}</div>` +
    scoreHTML(m.score) +
    whyHTML(m.reasons_json, true) +
    `<h4>Job description</h4>` +
    (p.description_raw
      ? `<div class="jd">${esc(p.description_raw)}</div>`
      : `<p class="hint">No description stored for this posting.</p>`) +
    `<p style="margin-top:14px"><a href="${esc(p.url)}" target="_blank" rel="noopener">Open posting</a></p>` +
    `<button class="btn primary block" data-prepare="${m.id}">Prepare application</button>`
  );
}

// prepare (from a match card or the match drawer)
document.addEventListener("click", async (e) => {
  const prep = e.target.dataset && e.target.dataset.prepare;
  if (prep) {
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
          loadView(currentView);
          return;
        }
        throw error;
      }
      await logEvent(app.id, "note", { note: "prepared from discovery by Jayanth" });
      toast("Application queued — see Prep", "ok");
      closeDrawer();
      loadView(currentView);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = orig;
      toast("Could not prepare the application: " + err.message, "error");
    }
    return;
  }
  const jd = e.target.dataset && e.target.dataset.jd;
  if (jd && matchById[jd]) { openMatchDrawer(matchById[jd]); return; }
});

// ---------- PREP: per-role tailoring, step by step ----------
function prepStepsHTML(app) {
  const r = app.review_json || {};
  const diff = renderDiff(r);
  const cover = renderCoverLetter(r, app.cover_letter_ref);
  const answers = renderAnswers(r);
  const unanswered = renderUnanswered(r);
  const hasPackage = diff || cover || answers || unanswered ||
    app.tailored_resume_ref || app.cover_letter_ref;
  const step = (title, body, emptyText) =>
    `<li><div class="step-title">${esc(title)}</div>` +
    (body || `<div class="step-empty">${esc(emptyText)}</div>`) + `</li>`;
  return `<ol class="steps">` +
    step("Resume diff — what changed vs your base resume",
      diff || (app.tailored_resume_ref ? `<p>${refLink(app.tailored_resume_ref)}</p>` : ""),
      hasPackage ? "No resume changes recorded." : "Tailoring hasn't run yet — the pipeline picks this up automatically.") +
    step("Cover letter", cover,
      hasPackage ? "No cover letter for this role." : "Tailoring hasn't run yet — the pipeline picks this up automatically.") +
    step("Exact answers that will be used", answers,
      hasPackage ? "No open-ended answers recorded." : "Tailoring hasn't run yet — the pipeline picks this up automatically.") +
    step("Open questions needing you",
      unanswered,
      hasPackage ? "None — every question was answerable from your profile." : "Tailoring hasn't run yet — the pipeline picks this up automatically.") +
    `</ol>`;
}

async function loadPrep() {
  const list = $("#prep-list");
  list.innerHTML = `<p class="hint">Loading prep queue…</p>`;
  const { data: rows, error } = await sb.from("applications")
    .select("id,url,ats,status,review_json,tailored_resume_ref,cover_letter_ref,created_at,postings(company,title,location)")
    .eq("candidate_id", candidateId)
    .in("status", ["queued", "running", "needs_review"])
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    list.innerHTML = `<p class="hint">Could not load prep queue: ${esc(error.message)}</p>`;
    return;
  }
  if (!rows || !rows.length) {
    list.innerHTML = `<div class="kempty"><strong>Nothing in prep</strong>Prepare a match from Discovery and its tailored package will appear here.</div>`;
    return;
  }
  list.innerHTML = "";
  rows.forEach((app) => {
    const p = app.postings || {};
    const card = document.createElement("div");
    card.className = "prep-card";
    card.innerHTML =
      `<h3>${esc(p.title || "")} <small>${esc(p.company || "")}</small></h3>` +
      `<div class="kcard-meta">${statusPill(app.status)}${atsBadge(app.ats)}` +
      `<span class="kcard-age">${esc(rel(app.created_at))}</span></div>` +
      prepStepsHTML(app) +
      (app.status === "needs_review"
        ? `<p style="margin-top:10px"><button class="btn primary" data-goto-review="${app.id}">Open in Review</button></p>`
        : `<p class="hint" style="margin-top:10px">Still tailoring — it moves to Review automatically when the package is ready.</p>`) +
      `<p><a href="${esc(app.url)}" target="_blank" rel="noopener">Open posting</a></p>`;
    list.appendChild(card);
  });
}

document.addEventListener("click", (e) => {
  const g = e.target.dataset && e.target.dataset.gotoReview;
  if (!g) return;
  document.querySelector('#tabs button[data-view="review"]').click();
});

// ---------- REVIEW: approve / reject gate ----------
function reviewCardHTML(app) {
  const r = app.review_json || {};
  const posting = r.posting || {};
  const cover = renderCoverLetter(r, app.cover_letter_ref);
  return `<h3>${esc(posting.title || "")} <small>${esc(posting.company || "")}</small></h3>` +
    `<div class="kcard-meta">${atsBadge(app.ats)}<span class="kcard-age">${esc(rel(app.created_at))}</span></div>` +
    (renderUnanswered(r) ? `<h4>Needs your answer (the worker refused to guess)</h4>` + renderUnanswered(r) : "") +
    (renderDiff(r) ? `<h4>What changed vs your base resume</h4>` + renderDiff(r) : "") +
    (cover ? `<h4>Cover letter</h4>` + cover : "") +
    (renderAnswers(r) ? `<h4>Exact answers that will be used</h4>` + renderAnswers(r) : "") +
    (app.tailored_resume_ref
      ? `<p class="hint">Tailored resume: ${refLink(app.tailored_resume_ref)}</p>` : "") +
    `<p><a href="${esc(app.url)}" target="_blank" rel="noopener">Open posting</a></p>` +
    `<div class="review-actions">` +
    `<button class="btn primary" data-approve="${app.id}">Approve</button>` +
    `<button class="btn danger" data-reject="${app.id}">Reject</button>` +
    `<span class="kb-note"><kbd>a</kbd> approve · <kbd>r</kbd> reject</span>` +
    `</div>`;
}

function emptyReviewHTML() {
  return `<div class="kempty" style="max-width:520px"><strong>All caught up</strong>` +
    `Nothing waiting for review. Prepared applications land here.</div>`;
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
  toast("Approved — the worker submits it on its next run", "ok");
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

// ---------- APPLY: ready to submit ----------
async function loadApply() {
  const list = $("#apply-list");
  list.innerHTML = `<p class="hint">Loading…</p>`;
  const { data: rows, error } = await sb.from("applications")
    .select("id,url,ats,status,receipt_json,updated_at,postings(company,title,location)")
    .eq("candidate_id", candidateId)
    .in("status", ["ready_to_submit", "manual", "needs_otp"])
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) {
    list.innerHTML = `<p class="hint">Could not load: ${esc(error.message)}</p>`;
    return;
  }
  if (!rows || !rows.length) {
    list.innerHTML = `<div class="kempty"><strong>Nothing ready to submit</strong>Approved applications land here. The worker submits them automatically and records the receipt. If you submit one yourself, use Mark submitted on its card to record the receipt.</div>`;
    return;
  }
  list.innerHTML = "";
  rows.forEach((a) => {
    const p = a.postings || {};
    const hasReceipt = a.receipt_json && Object.keys(a.receipt_json).length;
    const wrap = document.createElement("div");
    wrap.innerHTML =
      `<div class="kcard" data-app-id="${a.id}">` +
      `<div class="kcard-top"><span class="kcard-company">${esc(p.company || "")}</span>${atsBadge(a.ats)}</div>` +
      `<p class="kcard-title">${esc(p.title || "")}</p>` +
      `<div class="kcard-loc">${esc(p.location || "")}</div>` +
      `<div class="apply-meta">${statusPill(a.status)}<span class="kcard-age">${esc(rel(a.updated_at))}</span></div>` +
      (hasReceipt ? `<p class="hint">Receipt on file.</p>` : "") +
      `<div class="kcard-actions"><a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener">Open posting</a>` +
      `<button class="btn primary" data-mark-submitted="${a.id}">Mark submitted</button></div>` +
      `</div>`;
    list.appendChild(wrap.firstChild);
  });
}

// ---------- TRACK: application board (Tsenta-style columns) ----------
const TCOLS = [
  { key: "review", label: "Needs review",
    test: (a) => a.status === "needs_review",
    empty: "Tailored applications wait for your approval here." },
  { key: "ready", label: "Ready to submit",
    test: (a) => ["ready_to_submit", "manual", "needs_otp"].indexOf(a.status) !== -1,
    empty: "Approved applications wait for the worker's submit run." },
  { key: "submitted", label: "Submitted",
    test: (a, m) => a.status === "submitted" && !m,
    empty: "No quiet submissions — everything submitted is waiting on a reply or below." },
  { key: "replied", label: "Replied",
    test: (a, m) => a.status === "submitted" && (m === "confirmation" || m === "info_request"),
    empty: "Employer confirmations and info requests land here." },
  { key: "interview", label: "Interview",
    test: (a, m) => m === "interview",
    empty: "Interview invitations land here." },
  { key: "offer", label: "Offer",
    test: (a, m) => m === "offer",
    empty: "Offers land here." },
  { key: "closed", label: "Closed",
    test: (a, m) => a.status === "failed" || m === "rejection",
    empty: "Rejected or failed applications land here." },
];

function trackCard(a, replyByApp) {
  const p = a.postings || {};
  const reply = replyByApp[a.id];
  return `<div class="kcard" data-app-id="${a.id}">` +
    `<div class="kcard-top"><span class="kcard-company">${esc(p.company || "")}</span>${atsBadge(a.ats)}</div>` +
    `<p class="kcard-title">${esc(p.title || "")}</p>` +
    `<div class="kcard-meta">${reply ? replyChip(reply) : statusPill(a.status)}` +
    `<span class="kcard-age">${esc(rel(a.updated_at))}</span></div>` +
    `</div>`;
}

async function loadTrack() {
  const board = $("#track-board");
  board.innerHTML = `<p class="hint">Loading tracker…</p>`;
  const { data: rows, error } = await sb.from("applications")
    .select("id,url,ats,status,updated_at,postings(company,title,location)")
    .eq("candidate_id", candidateId)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error) {
    board.innerHTML = `<p class="hint">Could not load tracker: ${esc(error.message)}</p>`;
    return;
  }
  const apps = rows || [];
  const { map: replyByApp } = await loadReplyMap(apps.map((a) => a.id));
  if (!apps.length) {
    board.innerHTML = `<div class="kempty"><strong>No applications yet</strong>Prepare a match from Discovery to start your pipeline.</div>`;
    return;
  }
  const placed = new Set();
  board.innerHTML = TCOLS.map((col) => {
    const inCol = apps.filter((a) => !placed.has(a.id) && col.test(a, replyByApp[a.id]));
    inCol.forEach((a) => placed.add(a.id));
    const cards = inCol.map((a) => trackCard(a, replyByApp)).join("") ||
      `<div class="kempty"><strong>Empty</strong>${esc(col.empty)}</div>`;
    return `<div class="kcol"><div class="kcol-head"><span>${esc(col.label)}</span>` +
      `<span class="kcol-count">${inCol.length}</span></div>` +
      `<div class="kcol-body">${cards}</div></div>`;
  }).join("");
}

// ---------- ACTIVITY: recent events feed ----------
async function loadActivity() {
  const feed = $("#activity-feed");
  feed.innerHTML = `<p class="hint">Loading activity…</p>`;

  const { data: apps } = await sb.from("applications")
    .select("id,postings(company,title)")
    .eq("candidate_id", candidateId)
    .limit(2000);
  const appIds = (apps || []).map((a) => a.id);
  const titleOf = {};
  (apps || []).forEach((a) => {
    const p = a.postings || {};
    titleOf[a.id] = [p.company, p.title].filter(Boolean).join(" — ") || "application";
  });
  if (!appIds.length) {
    feed.innerHTML = `<div class="kempty"><strong>No activity yet</strong>Prepare a match from Discovery and the feed will fill in.</div>`;
    return;
  }

  const { data: events } = await sb.from("application_events")
    .select("application_id,type,payload_json,at")
    .in("application_id", appIds)
    .order("at", { ascending: false })
    .limit(200);
  const { data: msgs } = await sb.from("inbound_messages")
    .select("application_id,from_addr,subject,classification,at")
    .eq("candidate_id", candidateId)
    .order("at", { ascending: false })
    .limit(100);

  const items = [];
  (events || []).forEach((ev) => {
    const who = titleOf[ev.application_id] || "application";
    let text, dot = "";
    if (STATUSES.indexOf(ev.type) !== -1) {
      text = `<strong>${esc(who)}</strong> moved to <strong>${esc(ev.type.replace(/_/g, " "))}</strong>`;
      dot = ev.type === "failed" ? "bad" : (ev.type === "submitted" ? "good" : "");
    } else if (ev.type === "note") {
      text = `<strong>${esc(who)}</strong> — ${esc((ev.payload_json || {}).note || "note")}`;
    } else {
      text = `<strong>${esc(who)}</strong> — ${esc(ev.type)}`;
    }
    items.push({ at: ev.at, text: text, sub: rel(ev.at), appId: ev.application_id, dot: dot });
  });
  (msgs || []).forEach((m) => {
    const who = m.application_id ? (titleOf[m.application_id] || "application") : "application";
    const c = m.classification || "mail";
    const dot = (c === "interview" || c === "offer") ? "good"
      : (c === "rejection" ? "bad" : "mail");
    items.push({
      at: m.at,
      text: `Recruiter mail · ${replyChip(c)} <strong>${esc(m.subject || "(no subject)")}</strong> — ${esc(who)}`,
      sub: `${esc(m.from_addr || "")} · ${rel(m.at)}`,
      appId: m.application_id,
      dot: dot,
    });
  });
  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  if (!items.length) {
    feed.innerHTML = `<div class="kempty"><strong>No activity yet</strong>Status changes and recruiter mail will appear here.</div>`;
    return;
  }
  feed.innerHTML = items.slice(0, 120).map((it) =>
    `<div class="activity-item"><span class="activity-dot ${it.dot}"></span>` +
    `<div class="activity-body"><div class="activity-text">${it.text}</div>` +
    `<div class="activity-sub">${it.sub}</div></div>` +
    (it.appId ? `<button class="btn" data-detail="${it.appId}">Open</button>` : "") +
    `</div>`
  ).join("");
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
  const cover = renderCoverLetter(r, app.cover_letter_ref);
  showDrawer(
    `<h3>${esc(p.company || "")} — ${esc(p.title || "")}</h3>` +
    `<p>${statusPill(app.status)} ${atsBadge(app.ats)} ` +
    `<a href="${esc(app.url)}" target="_blank" rel="noopener">Open posting</a></p>` +
    `<p class="hint">${esc(p.location || "")} · updated ${esc(rel(app.updated_at))}</p>` +
    (app.failure_reason ? `<p class="hint">Failure reason: ${esc(app.failure_reason)}</p>` : "") +
    `<h4>Tailored resume</h4><p>${app.tailored_resume_ref ? refLink(app.tailored_resume_ref) : "<span class=hint>none</span>"}</p>` +
    `<h4>Cover letter</h4>` + (cover || `<p><span class="hint">none</span></p>`) +
    `<h4>Receipt</h4>` +
    (app.receipt_json
      ? `<pre class="cover">${esc(JSON.stringify(app.receipt_json, null, 2))}</pre>`
      : `<p class="hint">No receipt recorded yet.</p>`) +
    (renderDiff(r) ? `<h4>Review diff</h4>` + renderDiff(r) : "") +
    (renderAnswers(r) ? `<h4>Exact answers</h4>` + renderAnswers(r) : "") +
    (renderUnanswered(r) ? `<h4>Open questions</h4>` + renderUnanswered(r) : "") +
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

// card clicks open the drawer (buttons/links/expands/inputs keep working)
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
  authUserId = user.id;
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
