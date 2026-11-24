// server.js — Study Pods Dashboard
const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());

// Prevent stale browser caching for this app
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.use(express.json());

// Google Workspace authentication
require("./staff-auth")(app);

app.use(express.static("public"));

const MAX_RANGE_DAYS = 31;

/* ============================
   Manual pod overtime alerts
============================ */
const podAlerts = new Map();
let podAlertSequence = 0;
const POD_ALERT_TTL_MS = 60 * 1000;

// Today's sent-alert history is shared by all staff dashboards connected to
// this Render process. It is distinct from the 60-second tablet alert queue.
// In-memory records reset if Render restarts or redeploys the service.
const podAlertHistory = new Map();
const LIBRARY_TIME_ZONE = "America/New_York";
// External history is stored in a private Google Sheet by the existing
// signed Google Apps Script service. The in-memory map is a fallback only.
const CHIME_HISTORY_NAMESPACE = String(
  process.env.POD_CHIME_HISTORY_NAMESPACE || "production"
).trim();
let chimeSheetCache = { date: "", timestamp: 0, rows: [] };
let chimeSheetInFlight = null;

function getLibraryDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LIBRARY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function pruneOldPodAlertHistory(today) {
  for (const [eid, record] of podAlertHistory.entries()) {
    if (record.date !== today) podAlertHistory.delete(eid);
  }
}

/* ============================
   Persistent chime history via Google Apps Script + Sheets
   Uses the existing POD_INCIDENT_SCRIPT_URL and shared HMAC secret.
   No patron or reservation data is transmitted.
============================ */
async function signedChimeHistoryRequest(payload) {
  const crypto = require("node:crypto");
  const config = incidentMailerConfig();
  const payloadString = JSON.stringify({
    ...payload,
    namespace: CHIME_HISTORY_NAMESPACE,
    issuedAt: Date.now(),
  });
  const signature = crypto.createHmac("sha256", config.secret)
    .update(payloadString, "utf8").digest("hex");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: JSON.stringify({ payload: payloadString, signature }),
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Chime history service HTTP ${response.status}`);
    const value = await response.json();
    if (!value || value.ok !== true || value.action !== payload.action) {
      throw new Error("Chime history service did not confirm the request");
    }
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

async function saveChimeToSheet(alert, sentBy) {
  const date = getLibraryDateKey(new Date(alert.createdAt));
  const result = await signedChimeHistoryRequest({
    action: "chime-write",
    date,
    eid: alert.eid,
    id: alert.id,
    createdAt: alert.createdAt,
    sentBy,
  });
  if (result.id !== alert.id) throw new Error("Chime save acknowledgment mismatched");
  // Invalidate cached cloud history after successful write.
  chimeSheetCache.timestamp = 0;
  return true;
}

async function getChimesFromSheet(date) {
  const ageMs = Date.now() - chimeSheetCache.timestamp;
  if (chimeSheetCache.date === date && ageMs < 20000) {
    return chimeSheetCache.rows;
  }
  if (!chimeSheetInFlight) {
    chimeSheetInFlight = signedChimeHistoryRequest({
      action: "chime-read",
      date,
    }).then((result) => {
      if (!Array.isArray(result.rows)) throw new Error("Invalid chime history rows");
      const rows = result.rows.filter((row) =>
        row && /^\d+$/.test(String(row.eid || "")) &&
        typeof row.id === "string" && typeof row.createdAt === "string" &&
        Number.isFinite(Date.parse(row.createdAt))
      );
      chimeSheetCache = { date, timestamp: Date.now(), rows };
      return rows;
    }).finally(() => { chimeSheetInFlight = null; });
  }
  return chimeSheetInFlight;
}

function buildChimeHistoryResponse(today, sheetRows) {
  const byPod = new Map();
  function insert(eid, item) {
    if (!byPod.has(eid)) byPod.set(eid, new Map());
    const map = byPod.get(eid);
    // Deduplicate across Render's memory and the Google Sheet.
    map.set(String(item.id), String(item.createdAt));
  }
  for (const [eid, record] of podAlertHistory.entries()) {
    if (record.date === today) {
      for (const item of record.alerts) insert(eid, item);
    }
  }
  for (const row of sheetRows) {
    if (getLibraryDateKey(new Date(row.createdAt)) === today) {
      insert(String(row.eid), row);
    }
  }
  const pods = {};
  for (const [eid, entries] of byPod.entries()) {
    const times = [...entries.values()].sort((a, b) => Date.parse(b) - Date.parse(a));
    pods[eid] = { count: times.length, sentAt: times };
  }
  return { ok: true, date: today, timeZone: LIBRARY_TIME_ZONE, pods };
}

/* ============================
   Helpers
============================ */
function toYMD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseYMD(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

function daysBetweenInclusive(startDate, endDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const a = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate()).getTime();
  const b = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate()).getTime();
  return Math.floor((b - a) / msPerDay) + 1;
}

function parseIsoSafe(s) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function isSameLocalDay(dateValue, ymdString) {
  if (!dateValue || !ymdString) return false;
  const d = new Date(dateValue);
  if (isNaN(d.getTime())) return false;
  return toYMD(d) === ymdString;
}

function normalizeCheckInStatus(value) {
  const v = String(value || "").trim().toLowerCase();

  if (!v || v === "-" || v === "none" || v === "null") return "Not Checked In";
  if (v === "in" || v === "checked in") return "Checked In";
  if (v === "out" || v === "checked out") return "Checked Out";

  return "Not Checked In";
}

function extractPatronName(b) {
  const full = `${b.firstName || ""} ${b.lastName || ""}`.trim();
  if (full) return full;
  if (b.name) return String(b.name).trim();
  if (b.fullName) return String(b.fullName).trim();
  return "";
}

function extractPatronCard(b) {
  const directCandidates = [
    b.account,
    b.barcode,
    b.card,
    b.card_number,
    b.library_card,
    b.libraryCard,
    b.patron_barcode,
    b.patronBarcode,
  ];

  for (const val of directCandidates) {
    if (val != null && String(val).trim()) {
      return String(val).trim();
    }
  }

  for (const [key, value] of Object.entries(b || {})) {
    if (!/^q\d+$/i.test(key)) continue;
    if (value == null) continue;

    const v = String(value).trim();
    if (!v) continue;

    if (/^\d{8,20}$/.test(v)) return v;
  }

  return "";
}

function cloneReservation(bk) {
  if (!bk) return null;

  return {
    patron: bk.patron || "",
    firstName: bk.firstName || "",
    lastName: bk.lastName || "",
    email: bk.email || "",
    account: bk.account || "",
    fromDate: bk.fromDate,
    toDate: bk.toDate,
    checkInStatus: bk.checkInStatus || "Not Checked In",
    status: bk.status || "",
    bookId: bk.bookId || "",
    numericId: bk.numericId || "",
    checkInCode: bk.checkInCode || "",
    eid: bk.eid || "",
  };
}

async function getLibCalToken() {
  const { CLIENT_ID_PHYSICAL, CLIENT_SECRET_PHYSICAL } = process.env;

  if (!CLIENT_ID_PHYSICAL || !CLIENT_SECRET_PHYSICAL) {
    throw new Error("Missing CLIENT_ID_PHYSICAL / CLIENT_SECRET_PHYSICAL in env");
  }

  const tokenUrl = "https://greenburghlibrary.libcal.com/1.1/oauth/token";
  const body = new URLSearchParams({
    client_id: CLIENT_ID_PHYSICAL,
    client_secret: CLIENT_SECRET_PHYSICAL,
    grant_type: "client_credentials",
  });

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Token error: ${resp.status} ${resp.statusText} - ${t}`);
  }

  const data = await resp.json();
  return data.access_token;
}

async function libCalPost(endpoint, params = {}) {
  const token = await getLibCalToken();
  const url = new URL(`https://greenburghlibrary.libcal.com/1.1${endpoint}`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const text = await resp.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!resp.ok) {
    throw new Error(
      `${resp.status} ${resp.statusText} - ${
        typeof data === "string" ? data : JSON.stringify(data)
      }`
    );
  }

  return data;
}

async function getBookingsUpdates({ lid, sinceIso }) {
  const token = await getLibCalToken();

  const params = new URLSearchParams({
    date: sinceIso,
    lid: String(lid),
  });

  const url = `https://greenburghlibrary.libcal.com/1.1/space/bookings/updates?${params.toString()}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Booking updates error: ${resp.status} ${resp.statusText} - ${t}`);
  }

  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

/* ============================
   Pages
============================ */
app.get("/", (req, res) => res.redirect("/dashboard"));

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/ping", (req, res) => res.send("OK"));

/* ============================
   API: pods status for date range
============================ */
app.get("/api/pods-status", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");

    const lid = process.env.PODS_LOCATION_ID;
    const cid = process.env.PODS_CATEGORY_ID;

    if (!lid || !cid) {
      return res.status(500).json({
        error: "Missing PODS_LOCATION_ID or PODS_CATEGORY_ID in env",
      });
    }

    const today = new Date();
    const defaultStart = toYMD(today);
    const defaultEnd = toYMD(today);

    const startRaw = req.query.start || defaultStart;
    const endRaw = req.query.end || defaultEnd;

    const startDate = parseYMD(startRaw);
    const endDate = parseYMD(endRaw);

    if (!startDate || !endDate) {
      return res.status(400).json({ error: "Invalid start/end. Use YYYY-MM-DD." });
    }
    if (endDate < startDate) {
      return res.status(400).json({ error: "End date must be on/after start date." });
    }

    const rangeDays = daysBetweenInclusive(startDate, endDate);
    if (rangeDays > MAX_RANGE_DAYS) {
      return res.status(400).json({
        error: `Date range too large. Max is ${MAX_RANGE_DAYS} days.`,
      });
    }

    const token = await getLibCalToken();
    const headers = { Authorization: `Bearer ${token}` };

    const items = [];
    let pageIndex = 0;

    while (true) {
      const itemsParams = new URLSearchParams({
        category_id: String(cid),
        visibility: "admin_only",
        page_size: "100",
        page_index: String(pageIndex),
      });

      const itemsUrl = `https://greenburghlibrary.libcal.com/1.1/space/items/${lid}?${itemsParams.toString()}`;
      const itemsResp = await fetch(itemsUrl, { headers });

      if (!itemsResp.ok) {
        const t = await itemsResp.text();
        throw new Error(`Items error: ${itemsResp.status} ${itemsResp.statusText} - ${t}`);
      }

      const chunk = await itemsResp.json();
      if (Array.isArray(chunk)) items.push(...chunk);

      if (!Array.isArray(chunk) || chunk.length < 100) break;
      pageIndex++;
      if (pageIndex > 20) break;
    }

    const bookings = [];
    let page = 1;

    while (true) {
      const bookParams = new URLSearchParams({
        lid: String(lid),
        cid: String(cid),
        date: toYMD(startDate),
        days: String(rangeDays - 1),
        limit: "500",
        page: String(page),
        include_cancel: "0",
        include_denied: "0",
        include_tentative: "0",
        include_remote: "0",
        check_in_status: "1",
        form_answers: "1",
      });

      const bookingsUrl = `https://greenburghlibrary.libcal.com/1.1/space/bookings?${bookParams.toString()}`;
      const bookingsResp = await fetch(bookingsUrl, { headers });

      if (!bookingsResp.ok) {
        const t = await bookingsResp.text();
        throw new Error(`Bookings error: ${bookingsResp.status} ${bookingsResp.statusText} - ${t}`);
      }

      const chunk = await bookingsResp.json();
      if (Array.isArray(chunk)) bookings.push(...chunk);

      if (!Array.isArray(chunk) || chunk.length < 500) break;
      page++;
      if (page > 20) break;
    }

    // Overlay freshest check-in/out states from the updates endpoint
    try {
      const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000 + 60 * 1000).toISOString();
      const updates = await getBookingsUpdates({ lid, sinceIso });
      const updatesByBookId = new Map();

      for (const u of updates) {
        if (!u || !u.bookId) continue;
        updatesByBookId.set(String(u.bookId), u);
      }

      for (const b of bookings) {
        const match = updatesByBookId.get(String(b.bookId || ""));
        if (!match) continue;

        if (match.check_in_status !== undefined) {
          b.check_in_status = match.check_in_status;
        }
        if (match.status !== undefined) {
          b.status = match.status;
        }
      }
    } catch (updatesError) {
      console.warn("Booking updates overlay failed:", updatesError.message);
    }

    const now = new Date();
    const todayYmd = toYMD(now);

    const byEid = new Map();

    for (const b of bookings) {
      if (!b) continue;
      if (String(b.status || "").toLowerCase() !== "confirmed") continue;

      const eid = b.eid != null ? Number(b.eid) : null;
      if (eid == null) continue;

      const start = parseIsoSafe(b.fromDate);
      const end = parseIsoSafe(b.toDate);
      if (!start || !end) continue;

      if (!byEid.has(eid)) byEid.set(eid, []);

      byEid.get(eid).push({
        start,
        end,
        fromDate: b.fromDate,
        toDate: b.toDate,
        patron: extractPatronName(b),
        firstName: b.firstName || "",
        lastName: b.lastName || "",
        email: b.email || "",
        account: extractPatronCard(b),
        checkInStatus: normalizeCheckInStatus(b.check_in_status),
        status: b.status || "",
        bookId: b.bookId || "",
        numericId: b.id || "",
        checkInCode: b.check_in_code || "",
        eid,
      });
    }

    for (const [eid, list] of byEid.entries()) {
      list.sort((a, b) => a.start.getTime() - b.start.getTime());
      byEid.set(eid, list);
    }

    const results = items
      .map((it) => {
        const eid = it.id != null ? Number(it.id) : null;
        const name = it.name || "(Unnamed pod)";
        const list = eid != null ? byEid.get(eid) || [] : [];

        let active = null;
        let next = null;
        let last = null;

        for (const bk of list) {
          const nowMs = now.getTime();
          const startMs = bk.start.getTime();
          const endMs = bk.end.getTime();
          const isCheckedOut = bk.checkInStatus === "Checked Out";
          const endedOrFormer = endMs <= nowMs || isCheckedOut;

          if (!active && nowMs >= startMs && nowMs < endMs && !isCheckedOut) {
            active = bk;
          }

          if (!next && startMs > nowMs) {
            next = bk;
          }

          if (endedOrFormer && isSameLocalDay(bk.end, todayYmd)) {
            if (!last || endMs > last.end.getTime()) {
              last = bk;
            }
          }
        }

        return {
          eid,
          name,
          status: active ? "Reserved" : "Available",
          active: cloneReservation(active),
          next: cloneReservation(next),
          last: cloneReservation(last),
        };
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    res.json({
      range: { start: toYMD(startDate), end: toYMD(endDate), days: rangeDays },
      now: now.toISOString(),
      count: results.length,
      results,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: "Failed to build pods status",
      detail: String(e.message || e),
    });
  }
});

/* ============================
   API: reservation actions
============================ */
app.post("/api/reservation-action", async (req, res) => {
  try {
    const action = String(req.body.action || "").trim().toLowerCase();
    const bookId = String(req.body.bookId || "").trim();
    const checkInCode = String(req.body.checkInCode || "").trim();
    const patron = String(req.body.patron || "").trim();
    const podName = String(req.body.podName || "").trim();
    const timeRange = String(req.body.timeRange || "").trim();

    if (!action || !["checkin", "checkout"].includes(action)) {
      return res.status(400).json({ ok: false, error: "Invalid action." });
    }

    if (!bookId) {
      return res.status(400).json({ ok: false, error: "Missing bookId." });
    }

    if (!checkInCode) {
      return res.status(400).json({ ok: false, error: "Missing check-in code." });
    }

    const endpoint = action === "checkin" ? "/space/checkin" : "/space/checkout";

    console.log("RESERVATION ACTION", {
      action,
      bookId,
      checkInCode,
      patron,
      podName,
      timeRange,
    });

    const result = await libCalPost(endpoint, {
      id: bookId,
      code: checkInCode,
    });

    res.json({
      ok: true,
      action,
      message: `${action === "checkin" ? "Checked in" : "Checked out"} ${patron || "patron"}${podName ? ` (${podName})` : ""}${timeRange ? ` for ${timeRange}` : ""}.`,
      result,
    });
  } catch (e) {
    console.error("Reservation action error:", e);
    res.status(500).json({
      ok: false,
      error: "Reservation action failed.",
      detail: String(e.message || e),
    });
  }
});


/* ============================
   API: manual pod overtime alert
============================ */
app.post("/api/pod-alert", async (req, res) => {
  try {
    const eid = String(req.body.eid || "").trim();
    const podName = String(req.body.podName || "").trim();

    if (!eid || !/^\d+$/.test(eid)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid pod ID.",
      });
    }

    const alert = {
      id: `${Date.now()}-${++podAlertSequence}`,
      eid,
      podName,
      createdAt: new Date().toISOString(),
    };

    podAlerts.set(eid, alert);

    // Record every successfully created alert, even when staff trigger the
    // same pod repeatedly. The tablet queue itself still keeps only the latest.
    const today = getLibraryDateKey(new Date(alert.createdAt));
    pruneOldPodAlertHistory(today);
    let history = podAlertHistory.get(eid);
    if (!history) {
      history = { date: today, alerts: [] };
      podAlertHistory.set(eid, history);
    }
    history.alerts.push({ id: alert.id, createdAt: alert.createdAt });

    // Staff identity comes from the verified Google Workspace session.
    // Log it privately in Render; do not add it to the public tablet alert.
    const sentBy = req.session?.user?.email || "unknown";
    console.log("POD OVERTIME ALERT", { ...alert, sentBy });

    // Tablet delivery is already queued before this storage call.
    // A temporary Sheets outage must not stop the chime itself.
    let historySaved = false;
    try {
      historySaved = await saveChimeToSheet(alert, sentBy);
    } catch (error) {
      console.error("POD CHIME HISTORY SAVE FAILED", {
        eid,
        id: alert.id,
        error: error.name || "Error",
      });
    }

    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      alert,
      historySaved,
    });
  } catch (e) {
    console.error("Pod overtime alert error:", e);
    res.status(500).json({
      ok: false,
      error: "Failed to send pod overtime alert.",
      detail: String(e.message || e),
    });
  }
});

// Staff-only, read-only counts and timestamps for the current library day.
// This route deliberately does not match the unauthenticated tablet polling
// exception in staff-auth.js, so it still requires a staff Google login.
app.get("/api/pod-alert-history", async (req, res) => {
  const today = getLibraryDateKey();
  pruneOldPodAlertHistory(today);
  let rows = [];
  let historySource = "google-sheets";
  try {
    rows = await getChimesFromSheet(today);
  } catch (error) {
    historySource = "memory-fallback";
    console.error("POD CHIME HISTORY LOAD FAILED", error.name || "Error");
  }

  res.set("Cache-Control", "no-store");
  res.json({
    ...buildChimeHistoryResponse(today, rows),
    historySource,
  });
});

app.get("/api/pod-alert/:eid", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  const eid = String(req.params.eid || "").trim();

  if (!eid || !/^\d+$/.test(eid)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid pod ID.",
    });
  }

  const alert = podAlerts.get(eid);

  if (!alert) {
    return res.json({
      ok: true,
      alert: null,
    });
  }

  const createdAtMs = new Date(alert.createdAt).getTime();
  const ageMs = Date.now() - createdAtMs;

  if (!Number.isFinite(createdAtMs) || ageMs > POD_ALERT_TTL_MS) {
    podAlerts.delete(eid);

    return res.json({
      ok: true,
      alert: null,
    });
  }

  res.json({
    ok: true,
    alert,
  });
});



/* =========================================================
   STAFF INCIDENT REPORTS (Email-only; no incident database)
   All requests pass through the existing Google staff auth.
   The matching POST path is also guarded by Origin and JSON checks.
   Patron data is never logged to Render.
========================================================= */
const crypto = require("node:crypto");
const INCIDENT_TYPES = new Set([
  "Overstayed reservation",
  "Consecutive reservation violation",
  "Food or drink violation",
  "Key not returned",
  "Items of Value Left Behind",
  "Disruptive behavior",
  "Equipment damage",
  "Other",
]);
const ACTION_TYPES = new Set([
  "Verbal reminder given",
  "Written warning issued",
  "Staff intervention required",
  "Referred to supervisor",
  "No action taken",
  "Other / follow-up required",
]);
const INCIDENT_PODS = new Map([
  ["219899", "Pod 1 (Up to 4)"],
  ["219904", "Pod 2 (Up to 6)"],
  ["219900", "Pod 3 (Up to 4)"],
  ["multiple", "Multiple pods / Other"],
]);

function stringField(input, maxLen) {
  return typeof input === "string" && input.length <= maxLen
    ? input.trim()
    : null;
}

function emailRecipients() {
  const list = String(process.env.POD_INCIDENT_RECIPIENTS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(list)];
  if (unique.length !== 2 || unique.some((s) => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(s))) {
    throw new Error("Configure exactly two valid POD_INCIDENT_RECIPIENTS emails.");
  }
  return unique;
}

function incidentMailerConfig() {
  const url = String(process.env.POD_INCIDENT_SCRIPT_URL || "").trim();
  const secret = String(process.env.POD_INCIDENT_SHARED_SECRET || "").trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/?#]+\/exec$/.test(url)) {
    throw new Error("POD_INCIDENT_SCRIPT_URL must be the deployed Google Apps Script /exec URL.");
  }
  if (secret.length < 32) {
    throw new Error("POD_INCIDENT_SHARED_SECRET must contain at least 32 characters.");
  }
  return { url, secret };
}

function nyDateTime(iso) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: LIBRARY_TIME_ZONE,
    year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
    timeZoneName: "short",
  }).format(new Date(iso));
}

function nyReservationRange(fromDate, toDate) {
  return `${nyDateTime(fromDate)} to ${nyDateTime(toDate)}`;
}

// Resolve linked reservation data from LibCal itself rather than trusting
// patron name, card number or booking details sent by a browser.
async function verifyIncidentReservation({ bookId, eid, fromDate }) {
  const lid = String(process.env.PODS_LOCATION_ID || "").trim();
  const cid = String(process.env.PODS_CATEGORY_ID || "").trim();
  if (!lid || !cid) throw new Error("Missing LibCal location/category configuration.");
  const from = new Date(fromDate);
  if (!Number.isFinite(from.getTime())) throw new Error("Invalid reservation date.");
  const day = getLibraryDateKey(from);
  const token = await getLibCalToken();

  for (let page = 1; page <= 10; page++) {
    const params = new URLSearchParams({
      lid, cid, date: day, days: "0", limit: "500", page: String(page),
      include_cancel: "1", include_denied: "0", include_tentative: "0",
      include_remote: "0", form_answers: "1", check_in_status: "1",
    });
    const url = `https://greenburghlibrary.libcal.com/1.1/space/bookings?${params.toString()}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 20000,
    });
    if (!resp.ok) throw new Error(`LibCal reservation lookup failed (HTTP ${resp.status}).`);
    const bookings = await resp.json();
    if (!Array.isArray(bookings)) throw new Error("Unexpected LibCal booking response.");

    const match = bookings.find((b) => b && String(b.bookId || "") === bookId && String(b.eid || "") === eid);
    if (match) {
      if (!match.fromDate || !match.toDate) throw new Error("Incomplete LibCal reservation details.");
      return {
        bookId,
        podName: INCIDENT_PODS.get(eid),
        patronName: extractPatronName(match),
        libraryCard: extractPatronCard(match),
        reservationTime: nyReservationRange(match.fromDate, match.toDate),
      };
    }
    if (bookings.length < 500) break;
  }
  return null;
}

async function deliverIncidentEmail(report) {
  const recipients = emailRecipients();
  const config = incidentMailerConfig();
  const payloadString = JSON.stringify({
    ...report,
    recipients,
    issuedAt: Date.now(),
  });
  const signature = crypto
    .createHmac("sha256", config.secret)
    .update(payloadString, "utf8")
    .digest("hex");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: JSON.stringify({ payload: payloadString, signature }),
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`Email service HTTP ${response.status}`);
    const result = await response.json().catch(() => null);
    if (!result || result.ok !== true || result.reference !== report.reference) {
      throw new Error("Email service did not confirm sending the report.");
    }
  } finally {
    clearTimeout(timeout);
  }
}

app.post("/api/incident-report", async (req, res) => {
  try {
    const body = req.body || {};
    const kind = stringField(body.kind, 15);
    const podId = stringField(body.podId, 12);
    const incidentType = stringField(body.incidentType, 80);
    const description = stringField(body.description, 4000);
    const actionType = stringField(body.actionType, 80);
    const actionDetails = stringField(body.actionDetails || "", 1500);
    const incidentIso = stringField(body.incidentAt, 40);
    const reference = stringField(body.reference, 90);

    if (!reference || !/^[a-zA-Z0-9-]{12,90}$/.test(reference)) {
      return res.status(400).json({ ok: false, error: "Invalid incident reference." });
    }
    if (!INCIDENT_PODS.has(podId) || (kind === "linked" && podId === "multiple")) {
      return res.status(400).json({ ok: false, error: "Select a valid study pod." });
    }
    if (!INCIDENT_TYPES.has(incidentType) || !description || description.length < 10 || !ACTION_TYPES.has(actionType) || actionDetails === null) {
      return res.status(400).json({ ok: false, error: "Complete all required incident fields." });
    }
    const incidentDate = new Date(incidentIso || "");
    if (!Number.isFinite(incidentDate.getTime()) ||
        incidentDate.getTime() > Date.now() + 10 * 60 * 1000 ||
        incidentDate.getTime() < new Date("2015-01-01T00:00:00Z").getTime()) {
      return res.status(400).json({ ok: false, error: "Enter a valid incident date/time (not in the future)." });
    }
    if (kind !== "linked" && kind !== "general") {
      return res.status(400).json({ ok: false, error: "Invalid incident report type." });
    }

    let reservation = null;
    if (kind === "linked") {
      const bookId = stringField(body.bookId, 100);
      const fromDate = stringField(body.fromDate, 50);
      if (!bookId || !fromDate) {
        return res.status(400).json({ ok: false, error: "Missing linked reservation reference." });
      }
      reservation = await verifyIncidentReservation({ bookId, eid: podId, fromDate });
      if (!reservation) {
        return res.status(404).json({
          ok: false,
          error: "Couldn't verify the reservation in LibCal. Use General Incident if this is an older or unavailable booking.",
        });
      }
    } else {
      const patronName = stringField(body.patronName || "", 150);
      const libraryCard = stringField(body.libraryCard || "", 40);
      if (patronName === null || libraryCard === null) {
        return res.status(400).json({ ok: false, error: "Patron details exceed allowed length." });
      }
      reservation = {
        bookId: "",
        podName: INCIDENT_PODS.get(podId),
        patronName, libraryCard,
        reservationTime: "Not linked to a reservation",
      };
    }

    const submittedAt = new Date().toISOString();
    const report = {
      reference,
      kind,
      podName: reservation.podName,
      bookingId: reservation.bookId,
      patronName: reservation.patronName,
      libraryCard: reservation.libraryCard,
      reservationTime: reservation.reservationTime,
      incidentType,
      incidentAt: nyDateTime(incidentDate.toISOString()),
      submittedAt: nyDateTime(submittedAt),
      reportedBy: req.session.user.email,
      description,
      actionType,
      actionDetails,
    };
    await deliverIncidentEmail(report);
    // Intentionally log only the unique report reference. Never log patron PII.
    console.log("POD INCIDENT REPORT ACCEPTED", { reference });
    return res.json({ ok: true, reference, message: "Incident email accepted for sending to both recipients." });
  } catch (error) {
    // Generic failure to avoid potentially revealing patron information in logs.
    console.error("Incident report delivery failed:", error.name || "Error");
    return res.status(502).json({
      ok: false,
      error: "Incident report could not be emailed. No confirmation was received. Retry the same form or contact a supervisor.",
    });
  }
});

app.listen(port, () => {
  console.log(`Study Pods dashboard listening on http://localhost:${port}`);
});
