import React from 'react';
import { Link } from 'react-router-dom';
import { Globe, Search, Send, MessageSquare, Users, GitBranch, Bot, BarChart3, Settings, Link2 } from 'lucide-react';

const steps = [
  { icon: Globe, title: 'Connect Instagram', desc: 'Install the Chrome extension and connect your Instagram account.', link: '/accounts', color: 'bg-blue-50 text-blue-600' },
  { icon: Search, title: 'Find Leads', desc: 'Build targeted lists from followers, hashtags, and more.', link: '/lead-finder', color: 'bg-orange-50 text-orange-600' },
  { icon: Send, title: 'Create Campaign', desc: 'Send DMs and follow-ups automatically on your schedule.', link: '/campaigns', color: 'bg-purple-50 text-purple-600' },
  { icon: MessageSquare, title: 'Manage Inbox', desc: 'Reply, draft, and close conversations in one place.', link: '/inbox', color: 'bg-green-50 text-green-600' },
];

const modules = [
  { icon: Search, title: 'Lead Finder', desc: 'Build targeted lists of leads.', link: '/lead-finder' },
  { icon: Send, title: 'Campaigns', desc: 'Automate outreach and follow-ups.', link: '/campaigns' },
  { icon: MessageSquare, title: 'Inbox', desc: 'Reply, draft, and close.', link: '/inbox' },
  { icon: Bot, title: 'AI Agents', desc: 'Business Context and Inbox Agent.', link: '/ai-agents' },
  { icon: Users, title: 'Contacts', desc: 'Your saved people with notes.', link: '/contacts' },
  { icon: GitBranch, title: 'Pipelines', desc: 'Track where each contact stands.', link: '/pipelines' },
  { icon: BarChart3, title: 'Analytics', desc: 'Performance across outreach.', link: '/analytics' },
  { icon: Settings, title: 'Settings', desc: 'Workspace preferences.', link: '/settings' },
];

export default function Home() {
  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-10">
        <h1 className="text-3xl font-bold text-gray-900">Welcome to Instalead</h1>
        <p className="text-gray-500 mt-2">Your Instagram outreach and CRM workspace. Get started in 4 steps.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-12">
        {steps.map((s, i) => (
          <Link key={i} to={s.link} className="card hover:shadow-md transition-shadow flex items-start gap-4 group">
            <div className={`p-3 rounded-xl ${s.color}`}>
              <s.icon size={22} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-gray-400">STEP {i + 1}</span>
              </div>
              <h3 className="text-base font-semibold text-gray-900 mt-0.5 group-hover:text-orange-600 transition-colors">{s.title}</h3>
              <p className="text-sm text-gray-500 mt-1">{s.desc}</p>
            </div>
          </Link>
        ))}
      </div>

      <div>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Modules</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {modules.map((m, i) => (
            <Link key={i} to={m.link} className="card hover:shadow-md transition-shadow text-center py-6 group">
              <m.icon className="mx-auto text-gray-400 group-hover:text-orange-500 transition-colors" size={24} />
              <h3 className="text-sm font-semibold text-gray-800 mt-2">{m.title}</h3>
              <p className="text-xs text-gray-500 mt-1">{m.desc}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
