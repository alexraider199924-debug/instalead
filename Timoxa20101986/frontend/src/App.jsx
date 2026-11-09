import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import {
  Home as HomeIcon, BarChart3, Users, GitBranch, Search, Sparkles,
  Send, MessageSquare, Bot, Globe, Link2, Settings, Zap, Moon, Sun, Wifi, WifiOff, LogOut, Shield as ShieldIcon
} from 'lucide-react';
import api from './utils/api.js';
import { ThemeProvider, useTheme } from './contexts/ThemeContext.jsx';
import { AuthProvider, useAuth } from './contexts/AuthContext.jsx';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import Analytics from './pages/Analytics.jsx';
import Contacts from './pages/Contacts.jsx';
import Pipelines from './pages/Pipelines.jsx';
import LeadFinder from './pages/LeadFinder.jsx';
import LeadSearch from './pages/LeadSearch.jsx';
import Campaigns from './pages/Campaigns.jsx';
import CampaignDetail from './pages/CampaignDetail.jsx';
import Inbox from './pages/Inbox.jsx';
import AIAgents from './pages/AIAgents.jsx';
import Accounts from './pages/Accounts.jsx';
import Integrations from './pages/Integrations.jsx';
import SettingsPage from './pages/Settings.jsx';
import AdminUsers from './pages/AdminUsers.jsx';

function getWorkspaceFromCookie() {
  const match = document.cookie.match(/(?:^|;\s*)instalead_ws=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function ConnectedAccount() {
  const [account, setAccount] = useState(null);
  const [extStatus, setExtStatus] = useState(null);

  useEffect(() => {
    const load = () => {
      api.get('/extension/account').then(d => setAccount(d.username || null)).catch(() => setAccount(null));
      api.get('/extension/heartbeat').then(d => setExtStatus(d)).catch(() => setExtStatus(null));
    };
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  const extConnected = extStatus?.connected;

  return (
    <div className="mx-3 mt-3 mb-2 px-3 py-3 rounded-xl card !p-3">
      <div className="flex items-center gap-2.5">
        <span className="relative flex h-2 w-2 flex-shrink-0">
          {account && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60" />}
          <span className={`relative inline-flex rounded-full h-2 w-2 ${account ? 'bg-green-500' : 'bg-gray-400'}`} />
        </span>
        <span className="text-[13px] font-semibold text-gray-900 dark:text-white truncate">
          {account ? `@${account}` : 'Not connected'}
        </span>
      </div>
      <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-gray-100 dark:border-gray-800">
        {extConnected ? (
          <Wifi size={12} className="text-green-500 flex-shrink-0" />
        ) : (
          <WifiOff size={12} className="text-gray-400 flex-shrink-0" />
        )}
        <span className={`text-xs ${extConnected ? 'text-green-600 dark:text-green-400' : 'text-gray-400'}`}>
          {extConnected
            ? (extStatus?.running ? 'Extension active' : 'Extension idle')
            : 'Extension offline'}
        </span>
      </div>
    </div>
  );
}

const mainNav = [
  { to: '/', label: 'Home', icon: HomeIcon },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/contacts', label: 'Contacts', icon: Users },
  { to: '/pipelines', label: 'Pipelines', icon: GitBranch },
  { to: '/lead-finder', label: 'Lead Finder', icon: Search },
  { to: '/lead-search', label: 'AI Поиск', icon: Sparkles },
  { to: '/campaigns', label: 'Campaigns', icon: Send },
  { to: '/inbox', label: 'Inbox', icon: MessageSquare },
  { to: '/ai-agents', label: 'AI Agents', icon: Bot },
];

const bottomNav = [
  { to: '/accounts', label: 'Accounts', icon: Globe },
  { to: '/integrations', label: 'Integrations', icon: Link2 },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function ThemeToggle() {
  const { dark, toggle } = useTheme();
  return (
    <button onClick={toggle}
      className="nav-item w-full">
      {dark ? <Sun size={18} /> : <Moon size={18} />}
      {dark ? 'Light mode' : 'Dark mode'}
    </button>
  );
}

function AccountMenu() {
  const { user, logout } = useAuth();
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    try { await logout(); } finally { setBusy(false); }
  };

  return (
    <div className="border-t border-gray-100 dark:border-gray-800 p-3">
      <div className="flex items-center gap-2.5 px-1 pb-3">
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
          style={{ backgroundImage: 'var(--accent-gradient)' }}
        >
          {(user?.email?.[0] || '?').toUpperCase()}
        </div>
        <span className="text-xs text-gray-600 dark:text-gray-300 truncate" title={user?.email}>
          {user?.email || 'Signed in'}
        </span>
      </div>
      <button
        type="button"
        onClick={signOut}
        disabled={busy}
        className="nav-item w-full hover:!text-red-600 hover:!bg-red-50 dark:hover:!text-red-400 dark:hover:!bg-red-950/30 disabled:opacity-50"
      >
        <LogOut size={18} />
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}

function AppContent() {
  const { ready, authRequired, user } = useAuth();
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('ws')) {
      url.searchParams.delete('ws');
      window.history.replaceState({}, '', url.pathname + (url.search ? url.search : '') + url.hash);
    }
    // Remove the legacy Instagram-derived workspace cookie. The backend now
    // resolves the workspace only from the authenticated platform user.
    document.cookie = 'instalead_ws=; path=/; max-age=0';
  }, []);
  if (!ready) return <div className="min-h-screen flex items-center justify-center app-shell text-gray-500">Loading…</div>;
  if (authRequired && !user) return <Login />;

  return (
    <BrowserRouter>
      <div className="flex h-screen overflow-hidden app-shell">
        <aside className="w-56 flex-shrink-0 app-sidebar border-r flex flex-col">
          <div className="px-4 py-4 border-b border-gray-100 dark:border-gray-800">
            <div className="flex items-center gap-2.5">
              <div
                className="w-8 h-8 rounded-xl flex items-center justify-center shadow-sm"
                style={{ backgroundImage: 'var(--accent-gradient)' }}
              >
                <Zap className="text-white" size={16} strokeWidth={2.5} />
              </div>
              <span className="text-[15px] font-bold tracking-tight text-gray-900 dark:text-white">Instalead</span>
            </div>
          </div>

          <div className="pt-3">
            <ConnectedAccount />
          </div>

          <nav className="flex-1 px-2 space-y-0.5 overflow-y-auto">
            {mainNav.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) => `nav-item ${isActive ? 'nav-item-active' : ''}`}
              >
                <Icon size={18} />
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="border-t border-gray-100 dark:border-gray-800 px-2 py-2 space-y-0.5">
            {user?.role === 'admin' && (
              <NavLink to="/admin" className={({ isActive }) => `nav-item ${isActive ? 'nav-item-active' : ''}`}>
                <ShieldIcon size={18} /> Admin Panel
              </NavLink>
            )}
            <ThemeToggle />
            {bottomNav.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => `nav-item ${isActive ? 'nav-item-active' : ''}`}
              >
                <Icon size={18} />
                {label}
              </NavLink>
            ))}
          </div>
          <AccountMenu />
        </aside>

        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/contacts" element={<Contacts />} />
            <Route path="/pipelines" element={<Pipelines />} />
            <Route path="/lead-finder" element={<LeadFinder />} />
            <Route path="/lead-search" element={<LeadSearch />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/campaigns/:id" element={<CampaignDetail />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/ai-agents" element={<AIAgents />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/integrations" element={<Integrations />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/admin" element={user?.role === 'admin' ? <AdminUsers /> : <Home />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ThemeProvider>
  );
}
