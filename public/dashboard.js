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

function fmtRange(fromDate, toDate) {
  if (!fromDate || !toDate) return "";
  return `${fmtTime(fromDate)}–${fmtTime(toDate)}`;
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* ============================
   Countdown helpers
============================ */
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

/* ============================
   Main load
============================ */
async function loadData() {
  const tbody = document.getElementById("rows");
  const meta = document.getElementById("meta");

  const startEl = document.getElementById("start");
  const endEl = document.getElementById("end");

  const start = startEl?.value || ymdToday();
  const end = endEl?.value || start;

  tbody.innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;

  // Stop any previous countdown loop
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  try {
    const url = `/api/pods-status?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    const r = await fetch(url);

    if (!r.ok) {
      const t = await r.text();
      throw new Error(`HTTP ${r.status}: ${t}`);
    }

    const data = await r.json();
    const updated = new Date(data.now).toLocaleString();

    meta.textContent = `Range: ${data.range.start} → ${data.range.end} (${data.range.days} day${data.range.days === 1 ? "" : "s"}) | Updated: ${updated}`;

    if (!data.results || !data.results.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="muted">No pods returned.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.results
      .map((p) => {
        const isAvail = p.status === "Available";
        const statusClass = isAvail ? "available" : "reserved";

        let current = `<span class="muted">—</span>`;

        if (p.active) {
          const range = escapeHtml(fmtRange(p.active.fromDate, p.active.toDate));
          const patron = p.active.patron
            ? `<strong>${escapeHtml(p.active.patron)}</strong><br/>`
            : "";

          current = `
            ${patron}
            ${range}<br/>
            <span data-endtime="${p.active.toDate}" class="reserved"></span>
          `;
        }

        const next = p.next
          ? escapeHtml(fmtRange(p.next.fromDate, p.next.toDate))
          : `<span class="muted">—</span>`;

        return `
          <tr>
            <td>${escapeHtml(p.name || "")}</td>
            <td class="${statusClass}">${escapeHtml(p.status)}</td>
            <td>${current}</td>
            <td>${next}</td>
          </tr>
        `;
      })
      .join("");

    // Initial countdown render + interval
    renderCountdown();
    countdownTimer = setInterval(renderCountdown, 30000);

  } catch (e) {
    meta.textContent = "—";
    tbody.innerHTML = `<tr><td colspan="4" class="error">${escapeHtml(e.message)}</td></tr>`;
  }
}

document.getElementById("refresh").addEventListener("click", loadData);

// Load immediately on first open (defaults to today's date range already in the inputs)
window.addEventListener("DOMContentLoaded", loadData);

/* ============================
   Init defaults
============================ */
(() => {
  const today = ymdToday();
  const startEl = document.getElementById("start");
  const endEl = document.getElementById("end");
  if (startEl && !startEl.value) startEl.value = today;
  if (endEl && !endEl.value) endEl.value = today;
})();
