let countdownTimer = null;

function ymdToday() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fmtTime(dt) {
  try {
    const d = new Date(dt);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return dt;
  }
}

function isSameDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function fmtDateTime(dt) {
  const d = new Date(dt);
  return d.toLocaleString([], {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtRange(fromDate, toDate) {
  if (!fromDate || !toDate) return "";

  if (isSameDay(fromDate, new Date())) {
    return `${fmtTime(fromDate)}–${fmtTime(toDate)}`;
  }

  return `${fmtDateTime(fromDate)}–${fmtTime(toDate)}`;
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function minutesUntil(isoEnd) {
  const end = new Date(isoEnd).getTime();
  const now = Date.now();
  return Math.ceil((end - now) / 60000);
}

function renderCountdown() {
  document.querySelectorAll("[data-endtime]").forEach((el) => {
    const endIso = el.getAttribute("data-endtime");
    const mins = minutesUntil(endIso);

    if (mins <= 0) {
      el.textContent = "Ended";
      el.className = "muted";
    } else if (mins === 1) {
      el.textContent = "Ends in 1 min";
      el.className = "reserved";
    } else {
      el.textContent = `Ends in ${mins} min`;
      el.className = "reserved";
    }
  });
}

function normalizeStatus(status) {
  const s = String(status || "").trim().toLowerCase();

  if (!s || s === "-" || s === "not checked in") return "not_checked_in";
  if (s === "in" || s === "checked in") return "checked_in";
  if (s === "out" || s === "checked out") return "checked_out";

  return "unknown";
}

function renderCheckStatusText(reservation) {
  if (!reservation) return "—";

  const normalized = normalizeStatus(reservation.checkInStatus);

  if (normalized === "checked_in") return "Checked In";
  if (normalized === "checked_out") return "Checked Out";
  return "Not Checked In";
}

function renderCheckStatusClass(reservation) {
  if (!reservation) return "";

  const normalized = normalizeStatus(reservation.checkInStatus);

  if (normalized === "checked_in") return "check-in";
  if (normalized === "checked_out") return "check-out";
  return "check-none";
}

function renderStatusCell(p) {
  const baseStatus = p.status === "Reserved" ? "Reserved" : "Available";
  const checkText = p.active ? renderCheckStatusText(p.active) : "—";
  const checkClass = p.active ? renderCheckStatusClass(p.active) : "";

  return `
    <div class="${baseStatus === "Reserved" ? "reserved" : "available"}">
      ${escapeHtml(baseStatus)}
    </div>
    <div class="check-status ${checkClass}">
      ${escapeHtml(checkText)}
    </div>
  `;
}

function renderCurrentReservation(active) {
  if (!active) return `<span class="muted">—</span>`;

  return `
    <strong>${escapeHtml(active.patron || "—")}</strong><br/>
    <div>
      <span class="card-number">${escapeHtml(active.account || "—")}</span>
    </div>
    <div>${escapeHtml(fmtRange(active.fromDate, active.toDate))}</div>
    <div><span data-endtime="${escapeHtml(active.toDate)}" class="reserved"></span></div>
  `;
}

function renderNextReservation(next) {
  if (!next) return `<span class="muted">—</span>`;

  return `
    <strong>${escapeHtml(next.patron || "—")}</strong><br/>
    <div>
      <span class="card-number">${escapeHtml(next.account || "—")}</span>
    </div>
    <div>${escapeHtml(fmtRange(next.fromDate, next.toDate))}</div>
  `;
}

function renderLastReservation(last) {
  if (!last) return `<span class="muted">—</span>`;

  const checkClass = renderCheckStatusClass(last);
  const checkText = renderCheckStatusText(last);

  return `
    <div class="recently-ended-label">Recently Ended</div>
    <strong>${escapeHtml(last.patron || "—")}</strong><br/>
    <div>
      <span class="card-number">${escapeHtml(last.account || "—")}</span>
    </div>
    <div>${escapeHtml(fmtRange(last.fromDate, last.toDate))}</div>
    <div class="check-status ${checkClass}">
      ${escapeHtml(checkText)}
    </div>
  `;
}

async function loadData() {
  const tbody = document.getElementById("rows");
  const meta = document.getElementById("meta");

  const startEl = document.getElementById("start");
  const endEl = document.getElementById("end");

  const start = startEl?.value || ymdToday();
  const end = endEl?.value || start;

  tbody.innerHTML = `<tr><td colspan="5" class="muted">Loading…</td></tr>`;

  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  try {
    const url = `/api/pods-status?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&_ts=${Date.now()}`;
    const r = await fetch(url, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
      },
    });

    if (!r.ok) {
      const t = await r.text();
      throw new Error(`HTTP ${r.status}: ${t}`);
    }

    const data = await r.json();
    const updated = new Date(data.now).toLocaleString();

    meta.textContent = `Range: ${data.range.start} → ${data.range.end} (${data.range.days} day${data.range.days === 1 ? "" : "s"}) | Updated: ${updated}`;

    if (!data.results || !data.results.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted">No pods returned.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.results
      .map((p) => `
        <tr>
          <td>${escapeHtml(p.name || "")}</td>
          <td>${renderStatusCell(p)}</td>
          <td>${renderCurrentReservation(p.active)}</td>
          <td>${renderNextReservation(p.next)}</td>
          <td class="last-reservation">${renderLastReservation(p.last)}</td>
        </tr>
      `)
      .join("");

    renderCountdown();
    countdownTimer = setInterval(loadData, 30000);
  } catch (e) {
    meta.textContent = "—";
    tbody.innerHTML = `<tr><td colspan="5" class="error">${escapeHtml(e.message)}</td></tr>`;
  }
}

document.getElementById("refresh").addEventListener("click", loadData);
window.addEventListener("DOMContentLoaded", loadData);

(() => {
  const today = ymdToday();
  const startEl = document.getElementById("start");
  const endEl = document.getElementById("end");

  if (startEl && !startEl.value) startEl.value = today;
  if (endEl && !endEl.value) endEl.value = today;
})();
