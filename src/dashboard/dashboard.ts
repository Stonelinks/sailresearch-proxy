const PAGE_SIZE = 50;
const REFRESH_INTERVAL = 5000;

let offset = 0;
let total = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let paused = false;

const tbody = document.getElementById("jobs-body") as HTMLTableSectionElement;
const lastUpdatedEl = document.getElementById("last-updated")!;
const toggleBtn = document.getElementById(
  "toggle-refresh",
) as HTMLButtonElement;
const prevBtn = document.getElementById("prev-page") as HTMLButtonElement;
const nextBtn = document.getElementById("next-page") as HTMLButtonElement;
const pageInfo = document.getElementById("page-info")!;
const statusFilter = document.getElementById(
  "status-filter",
) as HTMLSelectElement;

interface Job {
  id: string;
  sailResponseId: string;
  status: string;
  model: string;
  completionWindow: string;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
  pollCount: number;
  hasError: boolean;
}

async function fetchJobs() {
  const status = statusFilter.value;
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (status) params.set("status", status);

  try {
    const res = await fetch(`/api/dashboard/jobs?${params}`);
    const data: { jobs: Job[]; total: number } = await res.json();
    total = data.total;
    renderTable(data.jobs);
    updatePagination();
    lastUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch {
    lastUpdatedEl.textContent = "Update failed";
  }
}

function renderTable(jobs: Job[]) {
  if (jobs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">No requests found.</td></tr>`;
    return;
  }

  tbody.innerHTML = jobs
    .map(
      (job) => `
    <tr>
      <td><span class="badge badge-${job.status}">${job.status}</span></td>
      <td class="model-name" title="${esc(job.model)}">${esc(shortModel(job.model))}</td>
      <td>${esc(job.completionWindow)}</td>
      <td title="${esc(job.createdAt)}">${relativeTime(job.createdAt)}</td>
      <td>${formatDuration(job.durationMs, job.status)}</td>
      <td>${job.pollCount}</td>
      <td class="mono" title="${esc(job.sailResponseId)}">${esc(job.id.slice(0, 8))}</td>
    </tr>`,
    )
    .join("");
}

function updatePagination() {
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  pageInfo.textContent = `Page ${page} of ${totalPages} (${total} total)`;
  prevBtn.disabled = offset === 0;
  nextBtn.disabled = offset + PAGE_SIZE >= total;
}

function formatDuration(ms: number | null, status: string): string {
  if (ms === null) {
    if (status === "completed" || status === "failed" || status === "cancelled")
      return "--";
    return '<span style="opacity:0.5">in progress</span>';
  }
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function shortModel(model: string): string {
  // "deepseek-ai/DeepSeek-V3.2" → "DeepSeek-V3.2"
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function startRefresh() {
  refreshTimer = setInterval(fetchJobs, REFRESH_INTERVAL);
}

function stopRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// Event listeners
toggleBtn.addEventListener("click", () => {
  paused = !paused;
  toggleBtn.textContent = paused ? "Resume" : "Pause";
  if (paused) stopRefresh();
  else startRefresh();
});

prevBtn.addEventListener("click", () => {
  offset = Math.max(offset - PAGE_SIZE, 0);
  fetchJobs();
});

nextBtn.addEventListener("click", () => {
  offset += PAGE_SIZE;
  fetchJobs();
});

statusFilter.addEventListener("change", () => {
  offset = 0;
  fetchJobs();
});

// Init
fetchJobs();
startRefresh();
