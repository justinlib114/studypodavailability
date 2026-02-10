// server.js — Study Pods Staff Dashboard (today-only + shows Available when not booked)
const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.static("public"));

/* ============================
   Helpers
============================ */
function toYMD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseIsoSafe(s) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
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
   Routes
============================ */
app.get("/", (req, res) => {
  res.redirect("/dashboard");
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// Optional: if you want a token endpoint for debugging (not required by dashboard)
app.get("/token", async (req, res) => {
  try {
    const token = await getLibCalToken();
    res.json({ token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to obtain token", detail: String(e.message || e) });
  }
});

/* ============================
   Core API: current status for ALL pods
   - today bookings only
   - shows Available when not currently booked
   - flips back to Available after end + grace minutes
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

    const graceMinutes = clampInt(req.query.grace, Number(process.env.EXPIRE_GRACE_MINUTES || 10), 0, 120);
    const graceMs = graceMinutes * 60 * 1000;

    // date is optional; defaults today (server local time)
    const date = String(req.query.date || toYMD(new Date()));

    const token = await getLibCalToken();
    const headers = { Authorization: `Bearer ${token}` };

    // 1) Fetch spaces/items in this location+category
    //    NOTE: /space/items/{lid} supports category_id and visibility
    //    page_size max 100; loop pages just in case
    const items = [];
    let pageIndex = 0;
    while (true) {
      const itemsParams = new URLSearchParams({
        category_id: String(cid),
        visibility: "admin_only", // staff view
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

      // If fewer than page_size, we’re done
      if (!Array.isArray(chunk) || chunk.length < 100) break;
      pageIndex++;
      if (pageIndex > 20) break; // safety
    }

    // 2) Fetch today's bookings for this lid+cid
    //    Use /space/bookings and filter to Confirmed
    const bookings = [];
    let page = 1;
    while (true) {
      const bookParams = new URLSearchParams({
        lid: String(lid),
        cid: String(cid),
        date,
        days: "0",
        limit: "500",
        page: String(page),
        include_cancel: "0",
        include_denied: "0",
        include_tentative: "0",
        include_remote: "0",
        // You *can* set check_in_status=1 if you want that field returned,
        // but we don't actually need it for "Available vs Reserved" right now.
        check_in_status: "0",
      });

      const bookingsUrl = `https://greenburghlibrary.libcal.com/1.1/space/bookings?${bookParams.toString()}`;
      const bookingsResp = await fetch(bookingsUrl, { headers });

      if (!bookingsResp.ok) {
        const t = await bookingsResp.text();
        throw new Error(`Bookings error: ${bookingsResp.status} ${bookingsResp.statusText} - ${t}`);
      }

      const chunk = await bookingsResp.json();
      if (Array.isArray(chunk)) bookings.push(...chunk);

      // paginate: if chunk size hits limit, there *might* be more
      if (!Array.isArray(chunk) || chunk.length < 500) break;
      page++;
      if (page > 20) break; // safety
    }

    const now = new Date();

    // group bookings by space eid
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
        eid,
        fromDate: b.fromDate,
        toDate: b.toDate,
        start,
        end,
        patron: `${b.firstName || ""} ${b.lastName || ""}`.trim(),
        email: b.email || "",
      });
    }

    // sort each list by start time
    for (const [eid, list] of byEid.entries()) {
      list.sort((a, b) => a.start.getTime() - b.start.getTime());
      byEid.set(eid, list);
    }

    // compute per pod: active booking (now between start and end+grace), else available
    const results = items
      .map((it) => {
        const eid = it.id != null ? Number(it.id) : null;
        const name = it.name || "(Unnamed pod)";

        const list = eid != null ? (byEid.get(eid) || []) : [];

        // active = now >= start && now <= end + grace
        let active = null;
        for (const bk of list) {
          if (now.getTime() >= bk.start.getTime() && now.getTime() <= (bk.end.getTime() + graceMs)) {
            active = bk;
            break;
          }
        }

        // next booking (optional — helpful context)
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
                patron: active.patron || "",
                fromDate: active.fromDate,
                toDate: active.toDate,
              }
            : null,
          next: next
            ? {
                fromDate: next.fromDate,
                toDate: next.toDate,
              }
            : null,
        };
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    res.json({
      date,
      graceMinutes,
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

app.get("/ping", (req, res) => res.send("OK"));

app.listen(port, () => {
  console.log(`Study Pods dashboard listening on http://localhost:${port}`);
});
