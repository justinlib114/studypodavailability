// server.js — Study Pods Dashboard
// Includes:
// - date range view
// - active / next reservations
// - patron name
// - account / library card number
// - check-in / check-out buttons
// - route guard using DASHBOARD_ADMIN_KEY
// - auto-checkout of previous checked-in reservation on same pod before checking in current one
// - 15-minute grace display after reservation ends, unless another reservation starts within that grace window
// - next reservation details returned for display
// - supports early check-in up to 15 minutes before the next reservation starts

const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const MAX_RANGE_DAYS = 31;
const ENDED_GRACE_MINUTES = 15;

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
  const a = new Date(
    startDate.getFullYear(),
    startDate.getMonth(),
    startDate.getDate()
  ).getTime();
  const b = new Date(
    endDate.getFullYear(),
    endDate.getMonth(),
    endDate.getDate()
  ).getTime();
  return Math.floor((b - a) / msPerDay) + 1;
}

function parseIsoSafe(s) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
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

async function libCalGet(endpoint, params) {
  const token = await getLibCalToken();
  const url = `https://greenburghlibrary.libcal.com/1.1${endpoint}?${new URLSearchParams(params).toString()}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const text = await resp.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    throw new Error(`${endpoint} error: ${resp.status} ${resp.statusText} - ${text}`);
  }

  return data;
}

async function libCalPost(endpoint, params) {
  const token = await getLibCalToken();
  const url = `https://greenburghlibrary.libcal.com/1.1${endpoint}?${new URLSearchParams(params).toString()}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const text = await resp.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    throw new Error(`${endpoint} error: ${resp.status} ${resp.statusText} - ${text}`);
  }

  return data;
}

async function fetchBookingsForRange({
  lid,
  cid,
  startDateYMD,
  days,
  eid = null,
  email = null,
}) {
  const all = [];
  let page = 1;

  while (true) {
    const params = {
      lid: String(lid),
      cid: String(cid),
      date: String(startDateYMD),
      days: String(days),
      limit: "500",
      page: String(page),
      include_cancel: "0",
      include_denied: "0",
      include_tentative: "0",
      include_remote: "0",
      check_in_status: "1",
    };

    if (eid != null && eid !== "") {
      params.eid = String(eid);
    }

    if (email) {
      params.email = String(email);
    }

    const chunk = await libCalGet("/space/bookings", params);

    if (!Array.isArray(chunk)) break;
    all.push(...chunk);

    if (chunk.length < 500) break;
    page += 1;
    if (page > 20) break;
  }

  return all;
}

function requireDashboardKey(req, res, next) {
  const expected = String(process.env.DASHBOARD_ADMIN_KEY || "").trim();
  const provided = String(req.get("x-dashboard-key") || "").trim();

  if (!expected) {
    return res.status(500).json({ error: "Missing DASHBOARD_ADMIN_KEY in env" });
  }

  if (!provided || provided !== expected) {
    return res.status(403).json({ error: "Forbidden" });
  }

  next();
}

async function findBookingById(bookingId) {
  const lid = process.env.PODS_LOCATION_ID;
  const cid = process.env.PODS_CATEGORY_ID;

  if (!lid || !cid) {
    throw new Error("Missing PODS_LOCATION_ID or PODS_CATEGORY_ID in env");
  }

  const today = new Date();

  let bookings = await fetchBookingsForRange({
    lid,
    cid,
    startDateYMD: toYMD(today),
    days: 7,
  });

  let found = bookings.find((b) => String(b.id) === String(bookingId));
  if (found) return found;

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  bookings = await fetchBookingsForRange({
    lid,
    cid,
    startDateYMD: toYMD(yesterday),
    days: 8,
  });

  found = bookings.find((b) => String(b.id) === String(bookingId));
  return found || null;
}

async function findPreviousCheckedInBooking(currentBooking) {
  const lid = process.env.PODS_LOCATION_ID;
  const cid = process.env.PODS_CATEGORY_ID;

  if (!lid || !cid) {
    throw new Error("Missing PODS_LOCATION_ID or PODS_CATEGORY_ID in env");
  }

  if (!currentBooking || !currentBooking.eid || !currentBooking.fromDate) {
    return null;
  }

  const currentStart = parseIsoSafe(currentBooking.fromDate);
  if (!currentStart) return null;

  const searchStart = new Date(currentStart);
  searchStart.setDate(searchStart.getDate() - 1);

  const bookings = await fetchBookingsForRange({
    lid,
    cid,
    eid: currentBooking.eid,
    startDateYMD: toYMD(searchStart),
    days: 2,
  });

  const candidates = bookings
    .filter((b) => String(b.status || "").toLowerCase() === "confirmed")
    .filter((b) => String(b.id) !== String(currentBooking.id))
    .map((b) => ({
      ...b,
      _start: parseIsoSafe(b.fromDate),
      _end: parseIsoSafe(b.toDate),
    }))
    .filter((b) => b._start && b._end)
    .filter((b) => b._end.getTime() <= currentStart.getTime())
    .sort((a, b) => b._end.getTime() - a._end.getTime());

  const previous = candidates[0];
  if (!previous) return null;

  if (String(previous.check_in_status || "").toLowerCase() !== "in") {
    return null;
  }

  return previous;
}

/* ============================
   Pages
============================ */
app.get("/", (req, res) => res.redirect("/dashboard"));

app.get("/dashboard", (req, res) => {
  const dashboardPath = path.join(__dirname, "public", "dashboard.html");
  let html = fs.readFileSync(dashboardPath, "utf8");

  html = html.replace(
    "</body>",
    `
    <script>
      window.DASHBOARD_ADMIN_KEY = ${JSON.stringify(process.env.DASHBOARD_ADMIN_KEY || "")};
    </script>
    </body>`
  );

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

app.get("/ping", (req, res) => res.send("OK"));

/* ============================
   API: Check in / Check out
============================ */
app.post("/api/booking/checkin", requireDashboardKey, async (req, res) => {
  try {
    const id = String(req.body.id || "").trim();
    const code = String(req.body.code || "").trim();

    if (!id || !code) {
      return res.status(400).json({ error: "Missing booking id or check-in code." });
    }

    const currentBooking = await findBookingById(id);

    if (!currentBooking) {
      return res.status(404).json({ error: "Current booking not found." });
    }

    let autoCheckedOut = null;

    const previousBooking = await findPreviousCheckedInBooking(currentBooking);

    if (previousBooking) {
      const previousId = String(previousBooking.id || "").trim();

      if (previousId) {
        const checkoutData = await libCalPost("/space/checkout", { id: previousId });

        autoCheckedOut = {
          bookingId: previousId,
          patron: `${previousBooking.firstName || ""} ${previousBooking.lastName || ""}`.trim(),
          account: previousBooking.account || "",
          fromDate: previousBooking.fromDate || "",
          toDate: previousBooking.toDate || "",
          data: checkoutData,
        };

        console.log(
          `[AUTOCHECKOUT] previous booking ${previousId} auto-checked out before checking in ${id}`
        );
      }
    }

    const data = await libCalPost("/space/checkin", { id, code });

    console.log(`[CHECKIN] booking ${id} at ${new Date().toISOString()}`);

    res.json({
      ok: true,
      action: "checkin",
      autoCheckedOut,
      data,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: "Check-in failed",
      detail: String(e.message || e),
    });
  }
});

app.post("/api/booking/checkout", requireDashboardKey, async (req, res) => {
  try {
    const id = String(req.body.id || "").trim();

    if (!id) {
      return res.status(400).json({ error: "Missing booking id." });
    }

    const data = await libCalPost("/space/checkout", { id });

    console.log(`[CHECKOUT] booking ${id} at ${new Date().toISOString()}`);

    res.json({ ok: true, action: "checkout", data });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: "Check-out failed",
      detail: String(e.message || e),
    });
  }
});

/* ============================
   API: pods status for date range
============================ */
app.get("/api/pods-status", async (req, res) => {
  try {
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
        bookingId: b.id != null ? String(b.id) : "",
        bookId: b.bookId || "",
        checkInCode: b.check_in_code || "",
        checkInStatus: b.check_in_status || "-",
        account: b.account || "",
        start,
        end,
        fromDate: b.fromDate,
        toDate: b.toDate,
        patron: `${b.firstName || ""} ${b.lastName || ""}`.trim(),
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

        for (let i = 0; i < list.length; i++) {
          const bk = list[i];
          const nextBk = list[i + 1] || null;

          const nowMs = now.getTime();
          const startMs = bk.start.getTime();
          const endMs = bk.end.getTime();
          const graceEndMs = addMinutes(bk.end, ENDED_GRACE_MINUTES).getTime();

          if (nowMs >= startMs && nowMs < endMs) {
            active = bk;
            break;
          }

          if (nowMs >= endMs && nowMs < graceEndMs) {
            const nextStartsWithinGrace =
              nextBk && nextBk.start.getTime() <= graceEndMs;

            if (!nextStartsWithinGrace) {
              active = bk;
              break;
            }
          }
        }

        let next = null;
        for (const bk of list) {
          if (bk.start.getTime() > now.getTime()) {
            next = bk;
            break;
          }
        }

        return {
          eid,
          name,
          status: active ? "Reserved" : "Available",
          active: active
            ? {
                bookingId: active.bookingId,
                bookId: active.bookId,
                checkInCode: active.checkInCode,
                checkInStatus: active.checkInStatus,
                account: active.account || "",
                patron: active.patron || "",
                fromDate: active.fromDate,
                toDate: active.toDate,
              }
            : null,
          next: next
            ? {
                bookingId: next.bookingId,
                bookId: next.bookId,
                checkInCode: next.checkInCode,
                checkInStatus: next.checkInStatus,
                account: next.account || "",
                patron: next.patron || "",
                fromDate: next.fromDate,
                toDate: next.toDate,
              }
            : null,
        };
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    res.json({
      range: {
        start: toYMD(startDate),
        end: toYMD(endDate),
        days: rangeDays,
      },
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
