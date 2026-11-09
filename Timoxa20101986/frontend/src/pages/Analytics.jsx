import React, { useEffect, useState } from 'react';
import api from '../utils/api.js';

function PeriodTabs({ value, onChange }) {
  const tabs = [
    { key: 'lifetime', label: 'Lifetime' },
    { key: '7d', label: '7d' },
    { key: '30d', label: '30d' },
  ];
  return (
    <div className="flex gap-0.5 text-xs">
      {tabs.map(t => (
        <button key={t.key} onClick={() => onChange(t.key)}
          className={`px-2 py-0.5 rounded font-medium transition-colors ${
            value === t.key ? 'text-orange-600' : 'text-gray-400 hover:text-gray-600'
          }`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

function SectionCard({ icon, iconColor, title, children, period, onPeriodChange }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2.5">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-sm ${iconColor}`}>
            {icon}
          </div>
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        </div>
        {onPeriodChange && <PeriodTabs value={period} onChange={onPeriodChange} />}
      </div>
      {children}
    </div>
  );
}

function StatCell({ label, value }) {
  return (
    <div>
      <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">{label}</div>
      <div className="text-xl font-bold text-gray-900">{value}</div>
    </div>
  );
}

export default function Analytics() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState({});
  const [period, setPeriod] = useState('lifetime');

  const loadData = (p) => {
    setLoading(true);
    const params = p && p !== 'lifetime' ? `?period=${p}` : '';
    Promise.all([
      api.get(`/analytics${params}`),
      api.get('/settings')
    ]).then(([d, s]) => { setData(d); setSettings(s); })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(period); }, [period]);

  if (loading && !data) return <div className="flex items-center justify-center h-full"><div className="text-gray-400">Загрузка...</div></div>;

  const { financials, outreach, activity, responseTimes, topSources, pipelineStats } = data || {};
  const currency = settings.currency === 'USD' ? '$' : '₽';

  const maxSourceSent = topSources?.length > 0 ? Math.max(...topSources.map(s => s.sent)) : 1;
  const sourceColors = ['#3b82f6', '#6366f1', '#f59e0b', '#10b981', '#ef4444'];

  const maxPipelineCount = pipelineStats?.length > 0 ? Math.max(...pipelineStats.map(p => p.count), 1) : 1;

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>

      {/* Row 1: Financials + Outreach */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard icon="$" iconColor="bg-blue-500" title="Financials" period={period} onPeriodChange={setPeriod}>
          <div className="grid grid-cols-2 gap-y-5">
            <StatCell label="Campaign Value" value={`${currency}${(financials?.campaignValue || 0).toLocaleString()}`} />
            <StatCell label="Revenue" value={`${currency}${(financials?.revenue || 0).toLocaleString()}`} />
            <StatCell label="Deals Won" value={financials?.dealsWon || 0} />
            <StatCell label="Avg Deal Value" value={financials?.avgDealValue ? `${currency}${financials.avgDealValue.toLocaleString()}` : '–'} />
          </div>
        </SectionCard>

        <SectionCard icon="✈" iconColor="bg-indigo-500" title="Outreach" period={period} onPeriodChange={setPeriod}>
          <div className="grid grid-cols-2 gap-y-5">
            <StatCell label="Scraped" value={outreach?.scraped || 0} />
            <StatCell label="DMs Sent" value={outreach?.dmsSent || 0} />
            <StatCell label="Replies" value={outreach?.replies || 0} />
            <StatCell label="Reply Rate" value={`${outreach?.replyRate || 0}%`} />
          </div>
        </SectionCard>
      </div>

      {/* Row 2: Activity + Response Times */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard icon="⚡" iconColor="bg-violet-500" title="Activity" period={period} onPeriodChange={setPeriod}>
          <div className="grid grid-cols-3 gap-4">
            <StatCell label="Avg New DMs / Day" value={activity?.avgDmsPerDay || 0} />
            <StatCell label="Avg Follow-ups / Day" value={activity?.followUpsPerDay || 0} />
            <StatCell label="Time Saved" value={activity?.timeSaved || '0m'} />
          </div>
        </SectionCard>

        <SectionCard icon="⏱" iconColor="bg-emerald-500" title="Response Times" period={period} onPeriodChange={setPeriod}>
          <div className="grid grid-cols-2 gap-4">
            <StatCell label="Lead Response" value={responseTimes?.leadResponse || '–'} />
            <StatCell label="Your Response" value={responseTimes?.yourResponse || '–'} />
          </div>
        </SectionCard>
      </div>

      {/* Row 3: Top Sources + Pipeline */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard icon="Q" iconColor="bg-amber-500" title="Top sources" period={period} onPeriodChange={setPeriod}>
          {topSources?.length > 0 ? (
            <div>
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 text-[10px] text-gray-400 uppercase tracking-wider mb-2 px-1">
                <div>Source</div>
                <div className="text-right">Sent</div>
                <div className="text-right">Replies</div>
                <div className="text-right">Reply %</div>
              </div>
              <div className="space-y-2">
                {topSources.map((s, i) => (
                  <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 items-center px-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="h-2 rounded-full flex-shrink-0" style={{
                        backgroundColor: sourceColors[i % sourceColors.length],
                        width: `${Math.max(10, (s.sent / maxSourceSent) * 100)}%`,
                        minWidth: '20px',
                        maxWidth: '70%'
                      }} />
                      <span className="text-sm text-gray-700 truncate">{s.source}</span>
                    </div>
                    <div className="text-sm text-gray-600 text-right tabular-nums">{s.sent}</div>
                    <div className="text-sm text-gray-600 text-right tabular-nums font-medium">{s.replies}</div>
                    <div className="text-sm text-gray-600 text-right tabular-nums">{s.replyRate}%</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center py-6 text-gray-400 text-sm">Нет данных</div>
          )}
        </SectionCard>

        <SectionCard icon="▼" iconColor="bg-purple-500" title="Pipeline" period={period} onPeriodChange={setPeriod}>
          {pipelineStats?.length > 0 ? (
            <div className="space-y-3">
              {pipelineStats.map((ps, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-sm text-gray-700 w-24 flex-shrink-0">{ps.name}</span>
                  <div className="flex-1 bg-gray-100 rounded-full h-2.5">
                    <div className="h-2.5 rounded-full transition-all" style={{
                      backgroundColor: ps.color,
                      width: `${Math.max(2, (ps.count / maxPipelineCount) * 100)}%`
                    }} />
                  </div>
                  <span className="text-sm font-semibold text-gray-900 w-8 text-right">{ps.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-6 text-gray-400 text-sm">Нет данных</div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
