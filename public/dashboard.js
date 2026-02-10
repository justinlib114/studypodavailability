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

let timer = null;

async function loadData() {
  const tbody = document.getElementById("rows");
  const meta = document.getElementById("meta");
  const graceEl = document.getElementById("grace");

  const grace = graceEl ? graceEl.value : "10";
  tbody.innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;

  try {
    const url = `/api/pods-status?grace=${encodeURIComponent(grace)}`;
    const r = await fetch(url);

    if (!r.ok) {
      const t = await r.text();
      throw new Error(`HTTP ${r.status}: ${t}`);
    }

    const data = await r.json();
    const updated = new Date(data.now).toLocaleString();

    meta.textContent = `Date: ${data.date} | Pods: ${data.count} | Updated: ${updated} | Grace: ${data.graceMinutes} min`;

    if (!data.results || !data.results.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="muted">No pods returned (check location/category IDs).</td></tr>`;
      return;
    }

    tbody.innerHTML = data.results
      .map((p) => {
        const isAvail = p.status === "Available";
        const statusClass = isAvail ? "available" : "reserved";

        const current = p.active
          ? `${p.active.patron ? `<strong>${p.active.patron}</strong><br/>` : ""}${fmtRange(
              p.active.fromDate,
              p.active.toDate
            )}`
          : `<span class="muted">—</span>`;

        const next = p.next
          ? `${fmtRange(p.next.fromDate, p.next.toDate)}`
          : `<span class="muted">—</span>`;

        return `
          <tr>
            <td>${p.name || ""}</td>
            <td class="${statusClass}">${p.status}</td>
            <td>${current}</td>
            <td>${next}</td>
          </tr>
        `;
      })
      .join("");
  } catch (e) {
    meta.textContent = "—";
    tbody.innerHTML = `<tr><td colspan="4" class="error">${e.message}</td></tr>`;
  }
}

function startAutoRefresh() {
  const autoEl = document.getElementById("autorefresh");
  const seconds = autoEl ? Number(autoEl.value) : 60;

  if (timer) clearInterval(timer);
  if (!Number.isFinite(seconds) || seconds <= 0) return;

  timer = setInterval(loadData, Math.max(10, seconds) * 1000);
}

document.getElementById("refresh").addEventListener("click", loadData);
document.getElementById("autorefresh").addEventListener("change", startAutoRefresh);

loadData();
startAutoRefresh();
