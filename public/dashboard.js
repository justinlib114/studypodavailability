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

/* ============================
   Countdown
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
   Check-in / Check-out actions
============================ */
async function postBookingAction(action, bookingId, buttonEl) {
  const originalText = buttonEl ? buttonEl.textContent : "";
  const actionCell = buttonEl ? buttonEl.closest(".action-wrap") : null;
  const msgEl = actionCell ? actionCell.querySelector(".action-message") : null;

  try {
    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.textContent = action === "checkin" ? "Checking in..." : "Checking out...";
    }

    if (msgEl) {
      msgEl.textContent = "";
      msgEl.className = "action-message";
    }

    const resp = await fetch(`/api/booking/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-dashboard-key": window.DASHBOARD_ADMIN_KEY || "",
      },
      body: JSON.stringify({
        id: bookingId,
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data.detail || data.error || `Failed to ${action}`);
    }

    if (msgEl) {
      msgEl.textContent =
        action === "checkin"
          ? "Checked in successfully."
          : "Checked out successfully.";
      msgEl.className = "action-message success";
    }

    await loadData();
  } catch (e) {
    if (msgEl) {
      msgEl.textContent = e.message || `Failed to ${action}`;
      msgEl.className = "action-message error-text";
    }
  } finally {
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.textContent = originalText;
    }
  }
}

function bindActionButtons() {
  document.querySelectorAll(".btn-checkin").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const bookingId = btn.getAttribute("data-booking-id");
      await postBookingAction("checkin", bookingId, btn);
    });
  });

  document.querySelectorAll(".btn-checkout").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const bookingId = btn.getAttribute("data-booking-id");
      await postBookingAction("checkout", bookingId, btn);
    });
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

    meta.textContent =
      `Range: ${data.range.start} → ${data.range.end} ` +
      `(${data.range.days} day${data.range.days === 1 ? "" : "s"}) | Updated: ${updated}`;

    if (!data.results || !data.results.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="muted">No pods returned.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.results
      .map((p) => {
        const isAvail = p.status === "Available";
        const podStatusClass = isAvail ? "available" : "reserved";

        let current = `<span class="muted">—</span>`;

        if (p.active) {
          const range = escapeHtml(fmtRange(p.active.fromDate, p.active.toDate));

          const patron = p.active.patron
            ? `<strong>${escapeHtml(p.active.patron)}</strong><br/>`
            : "";

          const account = p.active.account
            ? `<span class="account-number">${escapeHtml(p.active.account)}</span>`
            : "";

          const rawStatus = String(p.active.checkInStatus || "-").toLowerCase();

          let statusLabel = "Not Checked In";
          let currentStatusClass = "checkin-none";

          if (rawStatus === "in") {
            statusLabel = "Checked In";
            currentStatusClass = "checkin-in";
          } else if (rawStatus === "out") {
            statusLabel = "Checked Out";
            currentStatusClass = "checkin-out";
          }

          const nowMs = Date.now();
          const startMs = new Date(p.active.fromDate).getTime();
          const endMs = new Date(p.active.toDate).getTime();
          const reservationStillActive = nowMs >= startMs && nowMs < endMs;

          const canCheckIn =
            reservationStillActive &&
            rawStatus !== "in" &&
            rawStatus !== "out";

          const canCheckOut = rawStatus === "in";

          const checkInBtn = canCheckIn
            ? `
              <button
                type="button"
                class="btn-action btn-checkin"
                data-booking-id="${escapeHtml(p.active.bookingId)}"
              >
                Check In
              </button>
            `
            : "";

          const checkOutBtn = canCheckOut
            ? `
              <button
                type="button"
                class="btn-action btn-checkout"
                data-booking-id="${escapeHtml(p.active.bookingId)}"
              >
                Check Out
              </button>
            `
            : "";

          current = `
            ${patron}
            ${account}
            ${range}<br/>
            <span data-endtime="${p.active.toDate}" class="reserved"></span><br/>
            <span class="checkin-state ${currentStatusClass}">${escapeHtml(statusLabel)}</span>
            <div class="action-wrap">
              <div class="action-buttons">
                ${checkInBtn}
                ${checkOutBtn}
              </div>
              <div class="action-message"></div>
            </div>
          `;
        }

        const next = p.next
          ? escapeHtml(fmtRange(p.next.fromDate, p.next.toDate))
          : `<span class="muted">—</span>`;

        return `
          <tr>
            <td>${escapeHtml(p.name || "")}</td>
            <td class="${podStatusClass}">${escapeHtml(p.status)}</td>
            <td>${current}</td>
            <td>${next}</td>
          </tr>
        `;
      })
      .join("");

    renderCountdown();
    countdownTimer = setInterval(renderCountdown, 30000);
    bindActionButtons();
  } catch (e) {
    meta.textContent = "—";
    tbody.innerHTML = `<tr><td colspan="4" class="error">${escapeHtml(e.message)}</td></tr>`;
  }
}

document.getElementById("refresh").addEventListener("click", loadData);
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
