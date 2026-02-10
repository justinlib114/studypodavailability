const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.static("public"));

/* =========================
   Helpers
========================= */
function toYMD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeCsv(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(",");
}

function parseISO(dt) {
  const t = Date.parse(dt);
  return Number.isNaN(t) ? null : t;
}

async function getLibCalToken() {
  const { CLIENT_ID_PHYSICAL, CLIENT_SECRET_PHYSICAL } = process.env;

  if (!CLIENT_ID_PHYSICAL || !CLIENT_SECRET_PHYSICAL) {
    throw new Error("Missing CLIENT_ID_PHYSICAL / CLIENT_SECRET_PHYSICAL in .env");
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
    const errorText = await resp.text();
    throw new Error(`Token error: ${resp.status} ${resp.statusText} - ${errorText}`);
  }

  const data = await resp.json();
  return data.access_token;
}

/* =========================
   Pages
========================= */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/ping", (req, res) => {
  res.send("OK");
});

/* =========================
   API: Today’s Study Pod Reservations
   - pulls /space/bookings for today
   - filters Confirmed only
   - removes anything ended > grace minutes ago
   - sorts by start time
========================= */
app.get("/api/pods-today", async (req, res) => {
  try {
    const lid = process.env.PODS_LOCATION_ID;
    const cid = normalizeCsv(process.env.PODS_CATEGORY_ID);

    if (!lid) return res.status(500).json({ error: "Missing PODS_LOCATION_ID in .env" });
    if (!cid) return res.status(500).json({ error: "Missing PODS_CATEGORY_ID in .env" });

    const graceMin = Math.max(
      0,
      Number(req.query.grace ?? process.env.EXPIRE_GRACE_MINUTES ?? 10)
    );

    const token = await getLibCalToken();
    const headers = { Authorization: `Bearer ${token}` };

    const today = new Date();
    const ymd = toYMD(today);
    const now = Date.now();
    const graceMs = graceMin * 60 * 1000;

    // IMPORTANT: /space/bookings may not return daily bookings unless you include lid/cid/eid/seat_id
    const params = new URLSearchParams({
      date: ymd,
      days: "0",
      limit: "500",
      page: "1",
      include_cancel: "0",
      include_denied: "0",
      include_tentative: "0",
      check_in_status: "0",
      include_remote: "0",
      lid: String(lid),
      cid: String(cid),
    });

    const url = `https://greenburghlibrary.libcal.com/1.1/space/bookings?${params.toString()}`;
    const resp = await fetch(url, { headers });

    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`Bookings error: ${resp.status} ${resp.statusText} - ${t}`);
    }

    const bookings = await resp.json();

    const rows = [];
    const seen = new Set();

    for (const b of bookings || []) {
      if (!b) continue;

      // Confirmed only
      if (String(b.status || "").toLowerCase() !== "confirmed") continue;

      const startMs = parseISO(b.fromDate);
      const endMs = parseISO(b.toDate);
      if (!startMs || !endMs) continue;

      // Remove bookings that ended more than graceMin ago
      if (endMs + graceMs < now) continue;

      // de-dupe
      const key = b.id != null ? `id:${b.id}` : `book:${b.bookId}|from:${b.fromDate}|to:${b.toDate}|eid:${b.eid}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const activeNow = startMs <= now && now <= endMs;
      const statusLabel = activeNow ? "In progress" : "Upcoming";

      rows.push({
        start: b.fromDate,
        end: b.toDate,
        pod: b.item_name || "Study Pod",
        patron: `${b.firstName || ""} ${b.lastName || ""}`.trim() || "—",
        status: statusLabel,
      });
    }

    rows.sort((a, b) => String(a.start).localeCompare(String(b.start)));

    res.json({
      date: ymd,
      graceMinutes: graceMin,
      count: rows.length,
      results: rows,
      serverTime: new Date(now).toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to load pods reservations",
      detail: String(err.message || err),
    });
  }
});

app.listen(port, () => {
  console.log(`Study Pods dashboard running on port ${port}`);
});
