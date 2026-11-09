import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { LayoutDashboard, Users, Megaphone, Settings, Bug } from 'lucide-react';
import Dashboard from './pages/Dashboard.jsx';
import Leads from './pages/Leads.jsx';
import Campaigns from './pages/Campaigns.jsx';
import CampaignDetail from './pages/CampaignDetail.jsx';
import SettingsPage from './pages/Settings.jsx';
import api from './utils/api.js';

const navItems = [
  { to: '/', label: 'Дашборд', icon: LayoutDashboard },
  { to: '/leads', label: 'Лиды', icon: Users },
  { to: '/campaigns', label: 'Кампании', icon: Megaphone },
  { to: '/settings', label: 'Настройки', icon: Settings }
];

function ConnectedAccount() {
  const [account, setAccount] = useState(null);

  useEffect(() => {
    const load = () => api.get('/extension/account').then(d => setAccount(d.username)).catch(() => {});
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="p-3 mx-2 mb-2 rounded-xl bg-gray-800 border border-gray-700">
      <div className="flex items-center gap-2.5">
        <div className="relative flex-shrink-0">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-600 to-pink-600 flex items-center justify-center text-white text-sm font-bold">
            {account ? account[0].toUpperCase() : '?'}
          </div>
          <span
            className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-gray-800 ${account ? 'bg-green-500' : 'bg-gray-500'}`}
          />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold text-gray-200 truncate">
            {account ? `@${account}` : 'Instagram не подключён'}
          </div>
          <div className={`text-xs ${account ? 'text-green-400' : 'text-gray-500'}`}>
            {account ? 'Готово к работе' : 'Откройте Instagram'}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex h-screen overflow-hidden">
        {/* Sidebar */}
        <aside className="w-60 flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col">
          <div className="px-5 py-5 border-b border-gray-800">
            <div className="flex items-center gap-2">
              <Bug className="text-brand-400" size={22} />
              <span className="text-lg font-bold text-white">InstaWorm</span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">Instagram Outreach</p>
          </div>
          <nav className="flex-1 px-3 py-4 space-y-1">
            {navItems.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-brand-600 text-white'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                  }`
                }
              >
                <Icon size={17} />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="border-t border-gray-800 pt-3">
            <ConnectedAccount />
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/leads" element={<Leads />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/campaigns/:id" element={<CampaignDetail />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
