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
app.use(express.static("public"));

const MAX_RANGE_DAYS = 31;

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
          if (!active && now.getTime() >= bk.start.getTime() && now.getTime() < bk.end.getTime()) {
            active = bk;
          }

          if (!next && bk.start.getTime() > now.getTime()) {
            next = bk;
          }

          if (
            bk.end.getTime() <= now.getTime() &&
            isSameLocalDay(bk.end, todayYmd)
          ) {
            if (!last || bk.end.getTime() > last.end.getTime()) {
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

app.listen(port, () => {
  console.log(`Study Pods dashboard listening on http://localhost:${port}`);
});
