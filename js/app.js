/* auto-apply dashboard (GitHub Pages, static, no build step).
 *
 * Auth: Supabase email/password via supabase-js v2 (CDN). Session persists
 * in the browser. All data access runs as the authenticated user; RLS
 * owner policies apply.
 *
 * Config: SUPABASE_URL + SUPABASE_ANON_KEY come from web/config.js (local,
 * gitignored). web/config.example.js documents the placeholders.
 *
 * v1 flow: queue -> needs_review -> ready_to_submit -> (Jayanth submits on
 * the ATS site) -> submitted. Nothing here auto-submits.
 */

const CONFIG = (typeof window.DASHBOARD_CONFIG !== "undefined")
  ? window.DASHBOARD_CONFIG
  : null;

let sb = null;          // supabase client
let candidateId = null; // Jayanth's candidates.id
let profileId = null;   // his default profiles.id
let trackerFilter = "all";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");
const money = (n) => "$" + Number(n || 0).toFixed(2);
const money4 = (n) => "$" + Number(n || 0).toFixed(4);
const day = (ts) => String(ts || "").slice(0, 10);

const STATUSES = ["queued", "running", "needs_review", "ready_to_submit",
  "needs_otp", "manual", "submitted", "failed"];

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

// ---------- tabs ----------
$("#tabs").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-view]");
  if (!btn) return;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll("#app-view .view").forEach((v) => v.classList.remove("active"));
  btn.classList.add("active");
  $("#view-" + btn.dataset.view).classList.add("active");
  await loadView(btn.dataset.view);
});

async function loadView(view) {
  if (view === "queue") return loadQueue();
  if (view === "review") return loadReview();
  if (view === "tracker") return loadTracker();
  if (view === "costs") return loadCosts();
}

// ---------- queue ----------
async function loadQueue() {
  const tb = $("#queue-table tbody");
  tb.innerHTML = `<tr><td colspan="7">Loading...</td></tr>`;
  const { data: matches, error } = await sb.from("matches")
    .select("id,score,reasons_json,created_at,posting_id,postings(company,title,location,url,ats_type)")
    .eq("profile_id", profileId)
    .order("score", { ascending: false })
    .limit(100);
  if (error) {
    tb.innerHTML = `<tr><td colspan="7">Could not load matches: ${esc(error.message)}</td></tr>`;
    return;
  }
  const { data: apps } = await sb.from("applications")
    .select("url,status")
    .eq("candidate_id", candidateId);
  const byUrl = {};
  (apps || []).forEach((a) => { byUrl[a.url] = a.status; });
  tb.innerHTML = (matches || []).map((m) => {
    const p = m.postings || {};
    const existing = byUrl[p.url];
    const action = existing
      ? `<span class="status ${esc(existing)}">${esc(existing)}</span>`
      : `<button class="action primary" data-prepare="${m.id}">Prepare application</button>`;
    return `<tr><td>${esc(m.score)}</td><td>${esc(p.company)}</td><td>${esc(p.title)}</td>` +
      `<td>${esc(p.location)}</td><td>${esc(p.ats_type)}</td><td>${day(m.created_at)}</td>` +
      `<td>${action}</td></tr>`;
  }).join("") || `<tr><td colspan="7">No matches yet.</td></tr>`;
}

document.addEventListener("click", async (e) => {
  const prep = e.target.dataset && e.target.dataset.prepare;
  if (!prep) return;
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = "Preparing...";
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
        loadQueue();
        return;
      }
      throw error;
    }
    await logEvent(app.id, "note", { note: "prepared from queue by Jayanth" });
    loadQueue();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Prepare application";
    alert("Could not prepare the application: " + err.message);
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

async function loadReview() {
  const list = $("#review-list");
  list.innerHTML = "<p>Loading...</p>";
  const { data: rows, error } = await sb.from("applications")
    .select("id,url,ats,review_json,tailored_resume_ref,cover_letter_ref,created_at")
    .eq("candidate_id", candidateId)
    .eq("status", "needs_review")
    .order("created_at", { ascending: false });
  if (error) {
    list.innerHTML = `<p>Could not load review queue: ${esc(error.message)}</p>`;
    return;
  }
  $("#review-count").textContent = rows.length || "";
  list.innerHTML = "";
  rows.forEach((app) => {
    const r = app.review_json || {};
    const posting = r.posting || {};
    const card = document.createElement("div");
    card.className = "review-card";
    card.innerHTML =
      `<h3>${esc(posting.title || "")} <small>${esc(posting.company || "")}</small></h3>` +
      renderUnanswered(r) + renderDiff(r) + renderAnswers(r) +
      (app.tailored_resume_ref
        ? `<p class="hint">Tailored resume: ${refLink(app.tailored_resume_ref)}</p>` : "") +
      (app.cover_letter_ref
        ? `<p class="hint">Cover letter: ${refLink(app.cover_letter_ref)}</p>` : "") +
      `<p><a href="${esc(app.url)}" target="_blank" rel="noopener">Open posting</a></p>` +
      `<button class="action primary" data-approve="${app.id}">Approve</button> ` +
      `<button class="action danger" data-reject="${app.id}">Reject</button>`;
    list.appendChild(card);
  });
  if (!rows.length) list.innerHTML = "<p>Review queue is empty.</p>";
}

document.addEventListener("click", async (e) => {
  const ap = e.target.dataset && e.target.dataset.approve;
  const rj = e.target.dataset && e.target.dataset.reject;
  if (ap) {
    const { error } = await sb.from("applications")
      .update({ status: "ready_to_submit" }).eq("id", ap);
    if (error) { alert("Approve failed: " + error.message); return; }
    await logEvent(ap, "note", { note: "approved by Jayanth" });
    loadReview();
    return;
  }
  if (rj) {
    const note = prompt("Reject this application. Your note (saved to the event log):");
    if (note === null) return; // cancelled
    const { error } = await sb.from("applications")
      .update({ status: "failed", failure_reason: "rejected_at_review" }).eq("id", rj);
    if (error) { alert("Reject failed: " + error.message); return; }
    await logEvent(rj, "note", { note: "rejected at review by Jayanth: " + (note || "(no note)") });
    loadReview();
    return;
  }
  const ms = e.target.dataset && e.target.dataset.markSubmitted;
  if (ms) markSubmitted(ms);
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
  if (error) { alert("Mark submitted failed: " + error.message); return; }
  await logEvent(id, "note", { note: "marked submitted by Jayanth after manual submit" });
  loadTracker();
}

// ---------- tracker ----------
function renderTrackerFilters(counts) {
  const wrap = $("#tracker-filters");
  const chips = ["all"].concat(STATUSES).map((s) => {
    const label = s === "all" ? "all" : s;
    const n = s === "all"
      ? STATUSES.reduce((t, x) => t + (counts[x] || 0), 0)
      : (counts[s] || 0);
    return `<button class="action${s === trackerFilter ? " primary" : ""}"` +
      ` data-filter="${s}">${esc(label)} (${n})</button>`;
  }).join(" ");
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
  tb.innerHTML = `<tr><td colspan="5">Loading...</td></tr>`;
  let q = sb.from("applications")
    .select("id,url,ats,status,receipt_json,tailored_resume_ref,updated_at,postings(company,title,location)")
    .eq("candidate_id", candidateId)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (trackerFilter !== "all") q = q.eq("status", trackerFilter);
  const { data: rows, error } = await q;
  if (error) {
    tb.innerHTML = `<tr><td colspan="5">Could not load tracker: ${esc(error.message)}</td></tr>`;
    return;
  }
  // counts for the filter chips (one extra cheap query over statuses)
  const { data: allRows } = await sb.from("applications")
    .select("status").eq("candidate_id", candidateId).limit(2000);
  const counts = {};
  (allRows || []).forEach((a) => { counts[a.status] = (counts[a.status] || 0) + 1; });
  renderTrackerFilters(counts);
  tb.innerHTML = (rows || []).map((a) => {
    const p = a.postings || {};
    const canMark = (a.status === "ready_to_submit" || a.status === "manual");
    return `<tr><td>${esc(p.company || "")}</td><td>${esc(p.title || "")}</td>` +
      `<td><span class="status ${esc(a.status)}">${esc(a.status)}</span></td>` +
      `<td>${day(a.updated_at)}</td>` +
      `<td><button class="action" data-detail="${a.id}">Detail</button>` +
      (canMark ? ` <button class="action primary" data-mark-submitted="${a.id}">Mark submitted</button>` : "") +
      `</td></tr>`;
  }).join("") || `<tr><td colspan="5">No applications yet.</td></tr>`;
}

document.addEventListener("click", async (e) => {
  const id = e.target.dataset && e.target.dataset.detail;
  if (!id) return;
  const { data: app, error } = await sb.from("applications")
    .select("id,url,ats,status,failure_reason,review_json,receipt_json,tailored_resume_ref,cover_letter_ref,created_at,updated_at,postings(company,title,location)")
    .eq("id", id).single();
  if (error) { alert("Detail failed: " + error.message); return; }
  const { data: events } = await sb.from("application_events")
    .select("type,payload_json,at").eq("application_id", id).order("at", { ascending: false });
  const { data: msgs } = await sb.from("inbound_messages")
    .select("subject,classification,from_addr,at").eq("application_id", id)
    .order("at", { ascending: false });
  const p = app.postings || {};
  const r = app.review_json || {};
  $("#modal-content").innerHTML =
    `<h3>${esc(p.company || "")} - ${esc(p.title || "")}</h3>` +
    `<p><span class="status ${esc(app.status)}">${esc(app.status)}</span> ` +
    `<a href="${esc(app.url)}" target="_blank" rel="noopener">Open posting</a></p>` +
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
      `<div class="msg"><span class="status">${esc(m.classification || "")}</span> ` +
      `<strong>${esc(m.subject || "(no subject)")}</strong><br>` +
      `<span class="hint">${esc(m.from_addr || "")} - ${day(m.at)}</span></div>`
    ).join("") || `<p class="hint">No linked messages.</p>`) +
    `<h4>Timeline</h4><div class="timeline">` +
    ((events || []).map((ev) =>
      `<div class="event"><span class="event-type">${esc(ev.type)}</span> ` +
      `<span class="hint">${day(ev.at)}</span>` +
      `<pre class="cover">${esc(JSON.stringify(ev.payload_json || {}, null, 2))}</pre></div>`
    ).join("") || `<p class="hint">No events.</p>`) + `</div>`;
  $("#detail-modal").classList.remove("hidden");
});
$("#modal-close").addEventListener("click", () =>
  $("#detail-modal").classList.add("hidden"));

// ---------- costs ----------
async function loadCosts() {
  const cards = $("#cost-cards");
  const burnPanel = $("#burn-panel");
  const infraPanel = $("#infra-panel");
  cards.innerHTML = `<p>Loading...</p>`;
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
    cards.innerHTML = `<p>Could not load costs: ${esc(lerr.message)}</p>`;
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
    statCard("Pool spent today (all users)", pool ? money(pool.spent_usd) : "n/a") +
    statCard("Your total net spend", money(totalNet)) +
    statCard("Per-application cost", money(perApp)) +
    statCard("Applications submitted", String(submittedCount || 0));

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
      ` - budget <strong>${money(budget)}</strong>` +
      (active.note ? ` (${esc(active.note)})` : "") + `</p>` +
      `<p class="hint">Bar shows your ledger spend inside the window. ` +
      `Pool-wide spend is exposed only as the daily aggregate above.</p>` +
      `<div class="burn"><div class="burn-fill" style="width:${pct.toFixed(1)}%"></div>` +
      [50, 80, 100].map((m) =>
        `<div class="burn-marker" style="left:${m}%"></div>`).join("") +
      `</div><p>${money(windowSpend)} of ${money(budget)} (${pct.toFixed(1)}%) - ` +
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

function statCard(label, value) {
  return `<div class="card"><div class="card-label">${esc(label)}</div>` +
    `<div class="card-value">${esc(value)}</div></div>`;
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
  $("#app-view").classList.remove("hidden");
  $("#tabs").classList.remove("hidden");
  $("#auth-signout").classList.remove("hidden");
  $("#auth-user").textContent = user.email || "";
  try {
    await loadIdentity();
    await loadView("queue");
  } catch (err) {
    $("#app-view").innerHTML =
      `<p class="hint">Signed in, but could not load your candidate data: ${esc(err.message)}</p>`;
  }
}

function enterLogin() {
  $("#auth-view").classList.remove("hidden");
  $("#app-view").classList.add("hidden");
  $("#tabs").classList.add("hidden");
  $("#auth-signout").classList.add("hidden");
  $("#auth-user").textContent = "";
}

(function boot() {
  if (!CONFIG || !CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY ||
      CONFIG.SUPABASE_ANON_KEY.indexOf("PASTE_") === 0) {
    $("#setup-note").classList.remove("hidden");
    $("#setup-note").innerHTML = "<strong>Setup needed:</strong> copy web/config.example.js " +
      "to web/config.js and fill in SUPABASE_URL and SUPABASE_ANON_KEY, then reload.";
    return;
  }
  sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  sb.auth.onAuthStateChange((_event, session) => {
    if (session && session.user) enterApp(session.user);
    else enterLogin();
  });
  sb.auth.getSession().then(({ data }) => {
    if (data.session && data.session.user) enterApp(data.session.user);
    else enterLogin();
  });
})();
