import React, { useEffect, useState } from 'react';
import { Users, Megaphone, Send, TrendingUp, AlertCircle, Clock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import api from '../utils/api.js';

function StatCard({ icon: Icon, label, value, sub, color = 'brand' }) {
  const colors = {
    brand: 'text-brand-400 bg-brand-900/30',
    green: 'text-green-400 bg-green-900/30',
    yellow: 'text-yellow-400 bg-yellow-900/30',
    blue: 'text-blue-400 bg-blue-900/30'
  };
  return (
    <div className="card flex items-center gap-4">
      <div className={`p-3 rounded-xl ${colors[color]}`}>
        <Icon size={22} />
      </div>
      <div>
        <div className="text-2xl font-bold text-white">{value}</div>
        <div className="text-sm text-gray-400">{label}</div>
        {sub && <div className="text-xs text-gray-600 mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    draft: <span className="badge-gray">Черновик</span>,
    scheduled: <span className="badge-yellow">Запланирована</span>,
    running: <span className="badge-green">Работает</span>,
    paused: <span className="badge-blue">Пауза</span>,
    completed: <span className="badge-purple">Завершена</span>
  };
  return map[status] || <span className="badge-gray">{status}</span>;
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm">
      <div className="text-gray-400">{label}</div>
      <div className="text-brand-400 font-medium">{payload[0].value} отправлено</div>
    </div>
  );
};

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/analytics').then(setData).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-gray-500">Загрузка...</div>
    </div>
  );

  const { overview, campaignStats, dailyStats } = data || {};

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Дашборд</h1>
        <p className="text-gray-500 text-sm mt-1">Обзор вашей активности</p>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard icon={Users} label="Всего лидов" value={overview?.totalLeads ?? 0} color="blue" />
        <StatCard icon={Megaphone} label="Кампаний" value={overview?.totalCampaigns ?? 0} color="brand" />
        <StatCard icon={Send} label="Отправлено" value={overview?.totalSent ?? 0} color="green" />
        <StatCard icon={Clock} label="В очереди" value={overview?.totalPending ?? 0} color="yellow" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="card">
          <h2 className="text-base font-semibold text-white mb-4">Активность за 14 дней</h2>
          {dailyStats?.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={dailyStats} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={false} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="sent" fill="#c026d3" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex items-center justify-center text-gray-600 text-sm">
              Нет данных об отправке
            </div>
          )}
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-white">Последние кампании</h2>
            <Link to="/campaigns" className="text-xs text-brand-400 hover:text-brand-300">Все →</Link>
          </div>
          {campaignStats?.length > 0 ? (
            <div className="space-y-3">
              {campaignStats.slice(0, 5).map(c => (
                <Link key={c.id} to={`/campaigns/${c.id}`}
                  className="flex items-center justify-between p-3 rounded-lg bg-gray-800 hover:bg-gray-750 transition-colors group">
                  <div>
                    <div className="text-sm font-medium text-gray-200 group-hover:text-white">{c.name}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {c.sent}/{c.total} отправлено
                    </div>
                  </div>
                  <StatusBadge status={c.status} />
                </Link>
              ))}
            </div>
          ) : (
            <div className="h-40 flex flex-col items-center justify-center text-gray-600 text-sm gap-2">
              <AlertCircle size={24} />
              <span>Нет кампаний. <Link to="/campaigns" className="text-brand-400 hover:underline">Создать →</Link></span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
