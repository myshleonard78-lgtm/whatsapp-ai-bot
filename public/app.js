// Shared across every page: sidebar live status, fetch helper, and the
// halt/resume/mode control action used wherever those buttons appear.

function fmt(n) { return typeof n === 'number' ? '$' + n.toFixed(2) : '—'; }

async function fetchData() {
  const res = await fetch('/trading-data');
  return res.json();
}

function updateSidebar(d) {
  const dot = document.getElementById('sidebarDot');
  const status = document.getElementById('sidebarStatus');
  if (!dot || !status) return;
  dot.className = 'live-dot' + (d.connected && !d.halted ? '' : ' off');
  status.innerHTML = `
    <div>${d.mode === 'live' ? 'LIVE' : 'Demo'} · ${d.connected ? 'Connected' : 'Disconnected'}</div>
    <div>${d.halted ? 'Trading halted' : 'Trading active'}</div>
    <div class="mono" style="margin-top:4px;">${fmt(d.balance)}</div>
  `;
}

async function control(action, mode) {
  if (!confirm(`Confirm: ${action}${mode ? ' → ' + mode : ''}?`)) return;
  const res = await fetch('/trading-control', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ action, mode })
  });
  if (!res.ok) alert('Action failed — check logs.');
  if (window.onControlDone) window.onControlDone();
}

async function removeStrategy(id) {
  if (!confirm(`Remove strategy "${id}"? This stops it from trading further.`)) return;
  await fetch('/trading-control', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ action: 'remove_strategy', strategyId: id })
  });
  if (window.onControlDone) window.onControlDone();
}

// Poll the sidebar on every page, independent of whatever the page itself does
async function pollSidebar() {
  try { updateSidebar(await fetchData()); } catch (e) { console.error(e); }
}
pollSidebar();
setInterval(pollSidebar, 5000);
