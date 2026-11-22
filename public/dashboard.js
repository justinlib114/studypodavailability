let incidentPods = [];
let autoRefreshTimer = null;
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

function getButtonState(reservation) {
  if (!reservation || !reservation.bookId || !reservation.checkInCode) {
    return {
      canCheckIn: false,
      canCheckOut: false,
    };
  }

  const normalized = normalizeStatus(reservation.checkInStatus);

  if (normalized === "checked_in") {
    return {
      canCheckIn: false,
      canCheckOut: true,
    };
  }

  if (normalized === "checked_out") {
    return {
      canCheckIn: false,
      canCheckOut: false,
    };
  }

  return {
    canCheckIn: true,
    canCheckOut: false,
  };
}

function actionButtons(reservation, podName, columnName) {
  if (!reservation) return "";

  const state = getButtonState(reservation);
  const checkInDisabled = state.canCheckIn ? "" : "disabled";
  const checkOutDisabled = state.canCheckOut ? "" : "disabled";

  return `
    <div class="action-buttons"
      data-book-id="${escapeHtml(reservation.bookId || "")}"
      data-check-in-code="${escapeHtml(reservation.checkInCode || "")}"
      data-patron="${escapeHtml(reservation.patron || "")}"
      data-pod-name="${escapeHtml(podName || "")}"
      data-time-range="${escapeHtml(fmtRange(reservation.fromDate, reservation.toDate))}"
      data-column-name="${escapeHtml(columnName || "")}">
      <button type="button" class="action-btn btn-checkin" data-action="checkin" ${checkInDisabled}>Check In</button>
      <button type="button" class="action-btn btn-checkout" data-action="checkout" ${checkOutDisabled}>Check Out</button>
    </div>
  `;
}

function renderCurrentReservation(active, podName) {
  if (!active) return `<span class="muted">—</span>`;

  return `
    <strong>${escapeHtml(active.patron || "—")}</strong><br/>
    <div>
      <span class="card-number">${escapeHtml(active.account || "—")}</span>
    </div>
    <div>${escapeHtml(fmtRange(active.fromDate, active.toDate))}</div>
    <div><span data-endtime="${escapeHtml(active.toDate)}" class="reserved"></span></div>
    <div class="check-status ${renderCheckStatusClass(active)}">
      ${escapeHtml(renderCheckStatusText(active))}
    </div>
    ${actionButtons(active, podName, "Current Reservation")}
    ${incidentLinkedButton(active, podName, "active")}
  `;
}

function renderNextReservation(next, podName) {
  if (!next) return `<span class="muted">—</span>`;

  return `
    <strong>${escapeHtml(next.patron || "—")}</strong><br/>
    <div>
      <span class="card-number">${escapeHtml(next.account || "—")}</span>
    </div>
    <div>${escapeHtml(fmtRange(next.fromDate, next.toDate))}</div>
    <div class="check-status ${renderCheckStatusClass(next)}">
      ${escapeHtml(renderCheckStatusText(next))}
    </div>
    ${actionButtons(next, podName, "Next Reservation")}
    ${incidentLinkedButton(next, podName, "next")}
  `;
}

function renderLastReservation(last, podName) {
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
    ${actionButtons(last, podName, "Last Reservation")}
    ${incidentLinkedButton(last, podName, "last")}
  `;
}



/* ==========================================================
   Staff incident reporting — independent from reservation
   actions, automatic warnings, and overtime chime controls.
========================================================= */
let incidentMode = "general";
let incidentReference = "";

function incidentLinkedButton(reservation, podName, slot) {
  if (!reservation?.bookId || !reservation?.fromDate) return "";
  return `<div class="incident-reservation-link">
    <button type="button" class="btn-incident-linked"
      data-incident-slot="${escapeHtml(slot)}"
      data-incident-eid="${escapeHtml(reservation.eid || "")}">
      Document Incident
    </button>
  </div>`;
}

function newIncidentReference() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `INC-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function incidentLocalDateTime() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function populateIncidentPodChoices() {
  const select = document.getElementById("incident-pod-id");
  if (!select) return;
  select.replaceChildren();
  incidentPods.forEach((p) => {
    const option = document.createElement("option");
    option.value = String(p.eid);
    option.textContent = p.name;
    select.appendChild(option);
  });
  const option = document.createElement("option");
  option.value = "multiple";
  option.textContent = "Multiple pods / Other";
  select.appendChild(option);
}

function setIncidentFeedback(message, error = false) {
  const field = document.getElementById("incident-feedback");
  field.textContent = message || "";
  field.className = error ? "incident-feedback incident-error" : "incident-feedback";
}

function openIncidentDialog(kind, pod = null, booking = null) {
  const dialog = document.getElementById("incident-dialog");
  const form = document.getElementById("incident-form");
  if (!dialog || !form) return;
  form.reset();
  incidentMode = kind;
  incidentReference = newIncidentReference();
  form.dataset.podId = String(pod?.eid || "");
  form.dataset.bookId = String(booking?.bookId || "");
  form.dataset.fromDate = String(booking?.fromDate || "");
  document.getElementById("incident-at").value = incidentLocalDateTime();
  document.getElementById("incident-general-fields").hidden = kind !== "general";
  document.getElementById("incident-linked-fields").hidden = kind !== "linked";
  document.getElementById("incident-dialog-title").textContent = kind === "linked" ? "Document Reservation Incident" : "Document General Incident";
  setIncidentFeedback("");
  populateIncidentPodChoices();
  if (pod?.eid) document.getElementById("incident-pod-id").value = String(pod.eid);

  if (kind === "linked" && pod && booking) {
    const fields = [
      ["incident-linked-pod", pod.name],
      ["incident-linked-name", booking.patron || "Not provided"],
      ["incident-linked-card", booking.account || "Not provided"],
      ["incident-linked-book", booking.bookId],
      ["incident-linked-time", fmtRange(booking.fromDate, booking.toDate)],
    ];
    fields.forEach(([id, value]) => { document.getElementById(id).textContent = value; });
  }
  if (typeof dialog.showModal === "function") dialog.showModal();
  else { dialog.setAttribute("open", ""); }
  document.getElementById("incident-at").focus();
}

function wireIncidentLinkedButtons() {
  document.querySelectorAll(".btn-incident-linked").forEach((button) => {
    button.addEventListener("click", () => {
      const pod = incidentPods.find((p) => String(p.eid) === button.dataset.incidentEid);
      const slot = button.dataset.incidentSlot;
      const booking = pod && ["active", "next", "last"].includes(slot) ? pod[slot] : null;
      if (!booking) return showMessage("Reservation is no longer shown. Refresh the dashboard.", "error");
      openIncidentDialog("linked", pod, booking);
    });
  });
}

async function submitIncidentReport(event) {
  event.preventDefault();
  const form = document.getElementById("incident-form");
  const submit = document.getElementById("incident-submit");
  const localValue = document.getElementById("incident-at").value;
  const date = new Date(localValue);
  if (!Number.isFinite(date.getTime())) {
    return setIncidentFeedback("Choose a valid incident date and time.", true);
  }
  if (!form.reportValidity()) return;

  const payload = {
    reference: incidentReference,
    kind: incidentMode,
    podId: incidentMode === "linked" ? form.dataset.podId : document.getElementById("incident-pod-id").value,
    bookId: incidentMode === "linked" ? form.dataset.bookId : "",
    fromDate: incidentMode === "linked" ? form.dataset.fromDate : "",
    patronName: incidentMode === "general" ? document.getElementById("incident-patron-name").value : "",
    libraryCard: incidentMode === "general" ? document.getElementById("incident-library-card").value : "",
    incidentAt: date.toISOString(),
    incidentType: document.getElementById("incident-type").value,
    description: document.getElementById("incident-description").value,
    actionType: document.getElementById("incident-action").value,
    actionDetails: document.getElementById("incident-action-details").value,
  };
  if (payload.description.trim().length < 10) {
    return setIncidentFeedback("Enter a description of at least 10 characters.", true);
  }

  submit.disabled = true;
  setIncidentFeedback("Sending incident report…");
  try {
    const response = await fetch("/api/incident-report", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || "Could not submit incident report.");
    document.getElementById("incident-dialog").close();
    showMessage(`Incident report emailed to designated recipients. Reference: ${result.reference}`, "success");
  } catch (error) {
    setIncidentFeedback(error.message || "Incident report failed.", true);
  } finally {
    submit.disabled = false;
  }
}

function initIncidentReporting() {
  document.getElementById("incident-general-button").addEventListener("click", () => openIncidentDialog("general"));
  document.getElementById("incident-cancel").addEventListener("click", () => document.getElementById("incident-dialog").close());
  document.getElementById("incident-form").addEventListener("submit", submitIncidentReport);
}

function showMessage(message, type = "info") {
  const el = document.getElementById("message");
  if (!el) return;
  el.textContent = message;
  el.className = `message ${type}`;
}

function clearMessage() {
  const el = document.getElementById("message");
  if (!el) return;
  el.textContent = "";
  el.className = "message hidden";
}

function setBusyState(isBusy) {
  document.querySelectorAll(".action-btn").forEach((btn) => {
    btn.dataset.wasDisabled = btn.disabled ? "true" : "false";

    if (isBusy) {
      btn.disabled = true;
    } else {
      btn.disabled = btn.dataset.wasDisabled === "true";
    }
  });

  const refreshBtn = document.getElementById("refresh");
  if (refreshBtn) {
    refreshBtn.disabled = isBusy;
  }
}

async function postReservationAction(payload) {
  const r = await fetch("/api/reservation-action", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify(payload),
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok || !data.ok) {
    throw new Error(data.detail || data.error || "Action failed.");
  }

  return data;
}

async function handleReservationAction(container, action) {
  try {
    const payload = {
      action,
      bookId: container.dataset.bookId || "",
      checkInCode: container.dataset.checkInCode || "",
      patron: container.dataset.patron || "",
      podName: container.dataset.podName || "",
      timeRange: container.dataset.timeRange || "",
      columnName: container.dataset.columnName || "",
    };

    if (!payload.bookId) {
      throw new Error("Missing bookId for this reservation.");
    }

    if (!payload.checkInCode) {
      throw new Error("Missing check-in code for this reservation.");
    }

    setBusyState(true);
    showMessage(`${action === "checkin" ? "Checking in" : "Checking out"} ${payload.patron || "reservation"}...`, "info");

    const result = await postReservationAction(payload);

    alert(result.message || "Action completed.");
    showMessage(result.message || "Action completed.", "success");

    setTimeout(() => {
      loadData();
    }, 1200);
  } catch (e) {
    showMessage(e.message || "Action failed.", "error");
    alert(e.message || "Action failed.");
    setBusyState(false);
  }
}

function wireActionButtons() {
  document.querySelectorAll(".action-buttons").forEach((container) => {
    const checkInBtn = container.querySelector('[data-action="checkin"]');
    const checkOutBtn = container.querySelector('[data-action="checkout"]');

    if (checkInBtn && !checkInBtn.disabled) {
      checkInBtn.addEventListener("click", () => {
        handleReservationAction(container, "checkin");
      });
    }

    if (checkOutBtn && !checkOutBtn.disabled) {
      checkOutBtn.addEventListener("click", () => {
        handleReservationAction(container, "checkout");
      });
    }
  });
}


// Update the compact history under every pod's chime button.
// The server is the source of truth, so multiple staff computers see the
// same counts after refreshing. This does not affect the tablet polling API.
function formatChimeSentTime(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(date);
}

async function refreshPodAlertHistory() {
  try {
    const response = await fetch(`/api/pod-alert-history?_ts=${Date.now()}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.ok) throw new Error("Alert history unavailable");

    document.querySelectorAll(".pod-alert-history").forEach((details) => {
      const eid = details.dataset.eid;
      const entries = data.pods?.[eid]?.sentAt || [];
      const count = data.pods?.[eid]?.count || 0;
      const summary = details.querySelector("summary");
      const list = details.querySelector(".pod-alert-history-list");
      summary.textContent = `Sent today: ${count}`;
      list.replaceChildren();

      if (entries.length === 0) {
        const item = document.createElement("li");
        item.textContent = "No overtime chimes sent today.";
        list.appendChild(item);
      } else {
        entries.forEach((sentAt) => {
          const item = document.createElement("li");
          item.textContent = `Sent at ${formatChimeSentTime(sentAt)}`;
          list.appendChild(item);
        });
      }
    });
  } catch (error) {
    // Keep reservations and the chime button working even if history fails.
    console.warn("Overtime chime history unavailable:", error.message);
    document.querySelectorAll(".pod-alert-history summary").forEach((summary) => {
      summary.textContent = "History unavailable";
    });
  }
}

async function sendPodOvertimeAlert(button) {
  const eid = button.dataset.eid || "";
  const podName = button.dataset.podName || "";

  if (!eid) {
    alert("Missing pod ID.");
    return;
  }

  const originalText = button.textContent;

  button.disabled = true;
  button.textContent = "Sending…";

  try {
    const r = await fetch("/api/pod-alert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      },
      body: JSON.stringify({
        eid,
        podName,
      }),
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok || !data.ok) {
      throw new Error(data.detail || data.error || "Could not send overtime alert.");
    }

    button.textContent = "Sent ✓";
    showMessage(`Overtime alert sent to ${podName || "pod"}.`, "success");
    // Display the updated count immediately, without refreshing the table.
    refreshPodAlertHistory();

    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 1500);
  } catch (e) {
    button.textContent = "Error";
    showMessage(e.message || "Could not send overtime alert.", "error");
    alert(e.message || "Could not send overtime alert.");

    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 2000);
  }
}

function wireOvertimeAlertButtons() {
  document.querySelectorAll(".btn-overtime-alert").forEach((button) => {
    button.addEventListener("click", () => {
      sendPodOvertimeAlert(button);
    });
  });
}

async function loadData() {
  const tbody = document.getElementById("rows");
  const meta = document.getElementById("meta");

  const startEl = document.getElementById("start");
  const endEl = document.getElementById("end");

  const start = startEl?.value || ymdToday();
  const end = endEl?.value || start;

  // Preserve each expanded history while the dashboard auto-refreshes.
  const expandedHistories = new Set(
    Array.from(tbody.querySelectorAll(".pod-alert-history[open]"),
      (details) => details.dataset.eid)
  );

  tbody.innerHTML = `<tr><td colspan="6" class="muted">Loading…</td></tr>`;

  clearMessage();

  if (autoRefreshTimer) {
    clearTimeout(autoRefreshTimer);
    autoRefreshTimer = null;
  }

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
    incidentPods = Array.isArray(data.results) ? data.results : [];
    const updated = new Date(data.now).toLocaleString();

    meta.textContent = `Range: ${data.range.start} → ${data.range.end} (${data.range.days} day${data.range.days === 1 ? "" : "s"}) | Updated: ${updated}`;

    if (!data.results || !data.results.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="muted">No pods returned.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.results
      .map((p) => `
        <tr>
          <td>${escapeHtml(p.name || "")}</td>
          <td>${renderStatusCell(p)}</td>
          <td>${renderCurrentReservation(p.active, p.name)}</td>
          <td>${renderNextReservation(p.next, p.name)}</td>
          <td class="last-reservation">${renderLastReservation(p.last, p.name)}</td>
          <td class="alert-column">
            <button
              type="button"
              class="btn-overtime-alert"
              data-eid="${escapeHtml(p.eid || "")}"
              data-pod-name="${escapeHtml(p.name || "")}">
              🔔 Overtime Chime
            </button>
            <details
              class="pod-alert-history"
              data-eid="${escapeHtml(p.eid || "")}" 
              ${expandedHistories.has(String(p.eid)) ? "open" : ""}>
              <summary>Sent today: …</summary>
              <ol class="pod-alert-history-list">
                <li>Loading history…</li>
              </ol>
            </details>
          </td>
        </tr>
      `)
      .join("");

    wireActionButtons();
    wireIncidentLinkedButtons();
    wireOvertimeAlertButtons();
    renderCountdown();

    // Load chime history independently; Google Sheets must not delay the
    // next reservation refresh. Chime errors are handled inside this function.
    void refreshPodAlertHistory();

    countdownTimer = setInterval(renderCountdown, 30000);
  } catch (e) {
    meta.textContent = "—";
    tbody.innerHTML = `<tr><td colspan="6" class="error">${escapeHtml(e.message)}</td></tr>`;
  } finally {
    setBusyState(false);

    // Always schedule the next reservation refresh, even if LibCal returned
    // an error or no pods. This timer does not wait for chime history.
    autoRefreshTimer = setTimeout(loadData, 60000);
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

window.addEventListener("DOMContentLoaded", initIncidentReporting);
