import React, { useEffect, useState, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, LineChart, Line,
} from 'recharts';
import {
  Calendar, Mic, MessageSquare, Clock, TrendingUp,
  Download, Sparkles, Loader2,
} from 'lucide-react';
import AppShell from '../components/AppShell';
import {
  fetchOverview,
  fetchMeetingsTimeseries,
  fetchQATrend,
} from '../store/slices/analyticsSlice';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const formatDuration = (seconds) => {
  if (!seconds || seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
};

const formatDate = (iso) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

const TooltipStyle = {
  backgroundColor: '#0f172a',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 16,
  color: '#fff',
};

const DATE_RANGE_LABELS = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
};

// ─── SVG Chart Builders (pure SVG, no external deps, works in print) ──────────

/**
 * Builds an inline SVG bar chart for meetings-over-time data.
 * Returns an SVG string ready to embed in HTML.
 */
const buildBarChartSVG = (data) => {
  if (!data || data.length === 0) return '<p style="color:#9CA3AF;font-size:12px;text-align:center;padding:60px 0">No data for this period</p>';

  const W = 560, H = 220;
  const padL = 36, padR = 16, padT = 16, padB = 40;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const maxVal = Math.max(...data.map((d) => d.meetings), 1);
  const barW = Math.min(40, (chartW / data.length) * 0.6);
  const gap  = chartW / data.length;

  // Y-axis ticks (4 levels)
  const yTicks = [0, 1, 2, 3].map((i) => Math.round((maxVal / 3) * i));

  const bars = data.map((d, i) => {
    const bh = (d.meetings / maxVal) * chartH;
    const x  = padL + gap * i + (gap - barW) / 2;
    const y  = padT + chartH - bh;
    const label = new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${Math.max(bh, 1).toFixed(1)}"
            rx="4" fill="#6366F1"/>
      <text x="${(x + barW / 2).toFixed(1)}" y="${(padT + chartH + 26).toFixed(1)}"
            text-anchor="middle" font-size="10" fill="#6B7280">${label}</text>
      <text x="${(x + barW / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}"
            text-anchor="middle" font-size="10" fill="#6366F1" font-weight="600">${d.meetings}</text>`;
  }).join('');

  const yLines = yTicks.map((v) => {
    const y = padT + chartH - (v / maxVal) * chartH;
    return `
      <line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"
            stroke="#E5E7EB" stroke-width="1"/>
      <text x="${(padL - 4).toFixed(1)}" y="${(y + 4).toFixed(1)}"
            text-anchor="end" font-size="10" fill="#9CA3AF">${v}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">
  ${yLines}
  ${bars}
</svg>`;
};

/**
 * Builds an inline SVG line chart for Q&A trend data.
 * Returns an SVG string ready to embed in HTML.
 */
const buildLineChartSVG = (data) => {
  if (!data || data.length === 0) return '<p style="color:#9CA3AF;font-size:12px;text-align:center;padding:60px 0">No Q&A data for this period</p>';

  const W = 560, H = 220;
  const padL = 40, padR = 16, padT = 16, padB = 40;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const maxVal = Math.max(...data.map((d) => d.interactions), 1);
  const yTicks = [0, 1, 2, 3].map((i) => Math.round((maxVal / 3) * i));

  const points = data.map((d, i) => {
    const x = padL + (i / Math.max(data.length - 1, 1)) * chartW;
    const y = padT + chartH - (d.interactions / maxVal) * chartH;
    return { x, y, d };
  });

  // Smooth polyline
  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  // Filled area under line
  const areaPoints = [
    `${points[0].x.toFixed(1)},${(padT + chartH).toFixed(1)}`,
    ...points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`),
    `${points[points.length - 1].x.toFixed(1)},${(padT + chartH).toFixed(1)}`,
  ].join(' ');

  const dots = points.map((p) =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="#8B5CF6" stroke="#fff" stroke-width="1.5"/>`
  ).join('');

  const labels = points.map((p) => {
    const label = new Date(p.d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `<text x="${p.x.toFixed(1)}" y="${(padT + chartH + 26).toFixed(1)}"
              text-anchor="middle" font-size="10" fill="#6B7280">${label}</text>`;
  }).join('');

  const yLines = yTicks.map((v) => {
    const y = padT + chartH - (v / maxVal) * chartH;
    return `
      <line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"
            stroke="#E5E7EB" stroke-width="1"/>
      <text x="${(padL - 4).toFixed(1)}" y="${(y + 4).toFixed(1)}"
            text-anchor="end" font-size="10" fill="#9CA3AF">${v}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">
  <defs>
    <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#8B5CF6" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="#8B5CF6" stop-opacity="0"/>
    </linearGradient>
  </defs>
  ${yLines}
  <polygon points="${areaPoints}" fill="url(#areaGrad)"/>
  <polyline points="${polyline}" fill="none" stroke="#8B5CF6" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  ${dots}
  ${labels}
</svg>`;
};

// ─── PDF Export HTML builder ──────────────────────────────────────────────────
const buildExportHTML = ({ overview, timeseries, qaTrend, dateRange, generatedAt }) => {
  const rangeLabel   = DATE_RANGE_LABELS[dateRange] || dateRange;
  const barChartSVG  = buildBarChartSVG(timeseries);
  const lineChartSVG = buildLineChartSVG(qaTrend);

  const timeseriesRows = timeseries.map((d) =>
    `<tr><td>${d.date}</td><td>${d.meetings}</td><td>${formatDuration(d.durationAvg)}</td><td>${d.failures}</td></tr>`
  ).join('');

  const qaTrendRows = qaTrend.map((d) =>
    `<tr><td>${d.date}</td><td>${d.interactions}</td></tr>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>VoiceMind Analytics Report</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;
       background:#fff; color:#111; padding:40px 48px; font-size:13px; line-height:1.7; }
.header { border-bottom:3px solid #6366F1; padding-bottom:20px; margin-bottom:28px; }
.brand  { font-size:10px; font-weight:700; letter-spacing:0.18em; text-transform:uppercase;
          color:#6B7280; margin-bottom:8px; }
h1      { font-size:22px; font-weight:800; color:#111; margin-bottom:6px; }
.subtitle { font-size:12px; color:#6B7280; }
.meta   { margin-top:10px; font-size:11px; color:#9CA3AF; }

/* KPI grids */
.kpis   { display:grid; gap:14px; margin:24px 0; }
.kpis-4 { grid-template-columns:repeat(4,1fr); }
.kpis-3 { grid-template-columns:repeat(3,1fr); }
.kpi    { border:1px solid #E5E7EB; border-radius:10px; padding:16px 18px; }
.kpi-label { font-size:10px; text-transform:uppercase; letter-spacing:0.1em;
             color:#9CA3AF; margin-bottom:6px; }
.kpi-value { font-size:22px; font-weight:800; color:#111; }

/* Charts side-by-side */
.charts { display:grid; grid-template-columns:1fr 1fr; gap:20px; margin:28px 0; }
.chart-box { border:1px solid #E5E7EB; border-radius:12px; padding:20px; }
.chart-title { font-size:13px; font-weight:700; color:#111; margin-bottom:16px; }

/* Tables */
.section { margin-bottom:32px; }
.section-title { font-size:11px; font-weight:700; text-transform:uppercase;
                 letter-spacing:0.12em; color:#6B7280; margin-bottom:12px;
                 padding-bottom:8px; border-bottom:1px solid #F3F4F6; }
table   { width:100%; border-collapse:collapse; font-size:12px; }
thead tr { background:#F9FAFB; }
th      { text-align:left; padding:8px 12px; font-size:10px; font-weight:700;
          text-transform:uppercase; letter-spacing:0.08em; color:#6B7280; }
td      { padding:8px 12px; border-bottom:1px solid #F3F4F6; color:#374151; }
tr:last-child td { border-bottom:none; }

.footer { margin-top:40px; padding-top:14px; border-top:1px solid #E5E7EB;
          font-size:11px; color:#9CA3AF; text-align:center; }

@media print {
  body { padding:20px 24px; }
  .charts { page-break-inside:avoid; }
}
</style>
</head>
<body>

<div class="header">
  <div class="brand">VoiceMind Analytics</div>
  <h1>Statistics &amp; Insights Report</h1>
  <div class="subtitle">Deep dive into recording patterns, transcript activity, and Q&amp;A usage.</div>
  <div class="meta">Period: ${rangeLabel} &nbsp;|&nbsp; Generated: ${generatedAt}</div>
</div>

<!-- KPI row 1 -->
<div class="kpis kpis-4">
  <div class="kpi">
    <div class="kpi-label">Total Meetings</div>
    <div class="kpi-value">${overview?.totalMeetings ?? 0}</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Avg Duration</div>
    <div class="kpi-value">${formatDuration(overview?.avgDuration)}</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Success Rate</div>
    <div class="kpi-value">${overview?.successRate?.toFixed(1) ?? 0}%</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Q&amp;A Interactions</div>
    <div class="kpi-value">${overview?.qaInteractions ?? 0}</div>
  </div>
</div>

<!-- KPI row 2 -->
<div class="kpis kpis-3">
  <div class="kpi">
    <div class="kpi-label">Active Recordings</div>
    <div class="kpi-value">${overview?.activeRecordings ?? 0}</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Chunk Failure Rate</div>
    <div class="kpi-value">${overview?.chunkFailureRate?.toFixed(1) ?? 0}%</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Total Duration</div>
    <div class="kpi-value">${formatDuration(overview?.totalDurationSec)}</div>
  </div>
</div>

<!-- Charts (SVG inline) -->
<div class="charts">
  <div class="chart-box">
    <div class="chart-title">Meetings Over Time</div>
    ${barChartSVG}
  </div>
  <div class="chart-box">
    <div class="chart-title">Q&amp;A Interactions Over Time</div>
    ${lineChartSVG}
  </div>
</div>

<!-- Data tables -->
${timeseries.length > 0 ? `
<div class="section">
  <div class="section-title">Meetings Over Time — Data</div>
  <table>
    <thead><tr><th>Date</th><th>Meetings</th><th>Avg Duration</th><th>Failures</th></tr></thead>
    <tbody>${timeseriesRows}</tbody>
  </table>
</div>` : ''}

${qaTrend.length > 0 ? `
<div class="section">
  <div class="section-title">Q&amp;A Interactions — Data</div>
  <table>
    <thead><tr><th>Date</th><th>Interactions</th></tr></thead>
    <tbody>${qaTrendRows}</tbody>
  </table>
</div>` : ''}

<div class="footer">Generated by VoiceMind &bull; ${generatedAt}</div>
</body>
</html>`;
};

// ─── Main Component ───────────────────────────────────────────────────────────
const Statistics = () => {
  const dispatch = useDispatch();
  const { overview, timeseries, qaTrend, loading } = useSelector((s) => s.analytics);
  const [dateRange, setDateRange] = useState('7d');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const to   = new Date().toISOString();
    const days = dateRange === '90d' ? 90 : dateRange === '30d' ? 30 : 7;
    const from = new Date(Date.now() - days * 86400000).toISOString();
    dispatch(fetchOverview({ from, to }));
    dispatch(fetchMeetingsTimeseries({ from, to, bucket: 'day' }));
    dispatch(fetchQATrend({ from, to }));
  }, [dispatch, dateRange]);

  // ── Export to PDF (with charts) ──────────────────────────────────────────
  const handleExport = useCallback(() => {
    setExporting(true);
    try {
      const generatedAt = new Date().toLocaleString();
      const html = buildExportHTML({ overview, timeseries, qaTrend, dateRange, generatedAt });

      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url  = URL.createObjectURL(blob);
      const win  = window.open(url, '_blank');

      if (win) {
        win.onload = () => {
          setTimeout(() => {
            win.print();
            URL.revokeObjectURL(url);
          }, 300); // slight delay ensures SVGs are fully rendered before print
        };
      } else {
        // Fallback: download HTML file directly (popup blocked)
        const a = document.createElement('a');
        a.href = url;
        a.download = `voicemind-analytics-${dateRange}-${new Date().toISOString().slice(0, 10)}.html`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } finally {
      setExporting(false);
    }
  }, [overview, timeseries, qaTrend, dateRange]);

  // ── KPI cards ────────────────────────────────────────────────────────────
  const kpis = [
    {
      label:  'Total Meetings',
      value:  overview?.totalMeetings ?? 0,
      icon:   Calendar,
      accent: 'text-primary-300',
      bg:     'bg-primary-500/10 border-primary-500/20',
    },
    {
      label:  'Avg Duration',
      value:  loading ? '…' : formatDuration(overview?.avgDuration ?? 0),
      icon:   Clock,
      accent: 'text-sky-300',
      bg:     'bg-sky-500/10 border-sky-500/20',
    },
    {
      label:  'Success Rate',
      value:  loading ? '…' : `${overview?.successRate?.toFixed(1) ?? 0}%`,
      icon:   TrendingUp,
      accent: 'text-emerald-300',
      bg:     'bg-emerald-500/10 border-emerald-500/20',
    },
    {
      label:  'Q&A Interactions',
      value:  overview?.qaInteractions ?? 0,
      icon:   MessageSquare,
      accent: 'text-violet-300',
      bg:     'bg-violet-500/10 border-violet-500/20',
    },
  ];

  return (
    <AppShell>
      <div className="space-y-6">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <section className="glass-panel overflow-hidden p-6 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-primary-200">
                <Sparkles className="h-3.5 w-3.5" />
                Analytics
              </div>
              <h1 className="section-title text-3xl">Statistics &amp; insights</h1>
              <p className="section-subtitle">
                Deep dive into recording patterns, transcript activity, and Q&amp;A usage.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <select
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value)}
                className="input-field w-auto text-sm"
              >
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="90d">Last 90 days</option>
              </select>

              <button
                onClick={handleExport}
                disabled={exporting || loading}
                className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                title="Export statistics as PDF with charts"
              >
                {exporting
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Download className="h-4 w-4" />}
                {exporting ? 'Preparing…' : 'Export PDF'}
              </button>
            </div>
          </div>
        </section>

        {/* ── KPI cards ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {kpis.map(({ label, value, icon: Icon, accent, bg }) => (
            <div key={label} className="kpi-card">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-[0.28em] text-slate-500">{label}</div>
                  <div className="mt-3 text-3xl font-bold tracking-tight text-white">
                    {loading && value === 0
                      ? <span className="inline-block h-8 w-16 animate-pulse rounded-lg bg-white/10" />
                      : value}
                  </div>
                </div>
                <div className={`rounded-2xl border p-3 ${bg}`}>
                  <Icon className={`h-5 w-5 ${accent}`} />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* ── Charts ──────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="surface-card p-6">
            <h3 className="mb-6 font-semibold text-white">Meetings over time</h3>
            <div className="h-72">
              {loading ? (
                <div className="skeleton h-full w-full" />
              ) : timeseries.length === 0 ? (
                <div className="flex h-full items-center justify-center text-slate-500 text-sm">
                  No data for this period
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={timeseries}>
                    <CartesianGrid stroke="rgba(148,163,184,0.12)" vertical={false} />
                    <XAxis dataKey="date" stroke="#64748B" tickLine={false} axisLine={false}
                      fontSize={11} tickFormatter={formatDate} />
                    <YAxis stroke="#64748B" tickLine={false} axisLine={false} fontSize={11} />
                    <Tooltip contentStyle={TooltipStyle} labelFormatter={formatDate}
                      formatter={(v, name) => [
                        name === 'durationAvg' ? formatDuration(v) : v,
                        name === 'meetings' ? 'Meetings' : name === 'durationAvg' ? 'Avg Duration' : name,
                      ]} />
                    <Bar dataKey="meetings" fill="#6366F1" radius={[8, 8, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="surface-card p-6">
            <h3 className="mb-6 font-semibold text-white">Q&amp;A interactions</h3>
            <div className="h-72">
              {loading ? (
                <div className="skeleton h-full w-full" />
              ) : qaTrend.length === 0 ? (
                <div className="flex h-full items-center justify-center text-slate-500 text-sm">
                  No Q&amp;A data for this period
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={qaTrend}>
                    <CartesianGrid stroke="rgba(148,163,184,0.12)" vertical={false} />
                    <XAxis dataKey="date" stroke="#64748B" tickLine={false} axisLine={false}
                      fontSize={11} tickFormatter={formatDate} />
                    <YAxis stroke="#64748B" tickLine={false} axisLine={false} fontSize={11} />
                    <Tooltip contentStyle={TooltipStyle} labelFormatter={formatDate}
                      formatter={(v) => [v, 'Interactions']} />
                    <Line type="monotone" dataKey="interactions" stroke="#8B5CF6"
                      strokeWidth={2.5} dot={{ fill: '#8B5CF6', r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>

        {/* ── Recording details ────────────────────────────────────────── */}
        <div className="surface-card p-6">
          <h3 className="mb-5 font-semibold text-white">Recording details</h3>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            {[
              { label: 'Active recordings', value: overview?.activeRecordings ?? 0,
                icon: Mic, accent: 'text-orange-300', bg: 'bg-orange-500/10 border-orange-500/20' },
              { label: 'Chunk failure rate', value: `${overview?.chunkFailureRate?.toFixed(1) ?? 0}%`,
                icon: TrendingUp, accent: 'text-red-300', bg: 'bg-red-500/10 border-red-500/20' },
              { label: 'Total duration', value: formatDuration(overview?.totalDurationSec ?? 0),
                icon: Clock, accent: 'text-teal-300', bg: 'bg-teal-500/10 border-teal-500/20' },
            ].map(({ label, value, icon: Icon, accent, bg }) => (
              <div key={label} className="surface-card-soft flex items-center gap-4 p-4">
                <div className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl border ${bg}`}>
                  <Icon className={`h-5 w-5 ${accent}`} />
                </div>
                <div>
                  <p className="text-xs text-slate-400">{label}</p>
                  <p className="mt-0.5 text-xl font-semibold text-white">
                    {loading
                      ? <span className="inline-block h-6 w-12 animate-pulse rounded bg-white/10" />
                      : value}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </AppShell>
  );
};

export default Statistics;