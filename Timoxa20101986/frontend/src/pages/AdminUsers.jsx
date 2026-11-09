import React, { useEffect, useState } from 'react';
import { Shield, Ban, Check, KeyRound, Copy } from 'lucide-react';
import api from '../utils/api.js';

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(null);
  const [temporaryPasswords, setTemporaryPasswords] = useState({});

  const load = () => {
    api.get('/auth/users').then(d => setUsers(d.users || [])).catch(e => {
      setError(e.error || 'Failed to load users');
    }).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const toggleApproval = async (u) => {
    setError('');
    try {
      await api.post(`/auth/users/${u.id}/approve`, { approved: !u.approved });
      load();
    } catch (e) {
      setError(e.error || 'Failed to update approval');
    }
  };

  const resetPassword = async (u) => {
    if (!window.confirm('Сгенерировать новый пароль? Старый пароль перестанет работать.')) return;
    setResetting(u.id);
    setError('');
    try {
      const result = await api.post('/auth/users/' + u.id + '/reset-password');
      setTemporaryPasswords(prev => ({ ...prev, [u.id]: result.temporaryPassword }));
    } catch (e) {
      setError(e.error || 'Failed to reset password');
    } finally {
      setResetting(null);
    }
  };

  const toggleBan = async (u) => {
    setError('');
    try {
      await api.post(`/auth/users/${u.id}/ban`, { banned: !u.banned });
      load();
    } catch (e) {
      setError(e.error || 'Failed to update user');
    }
  };

  if (loading) return <div className="flex items-center justify-center h-full text-gray-400">Loading...</div>;

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-3 rounded-xl bg-orange-50 text-orange-600">
          <Shield size={24} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Users</h1>
          <p className="text-gray-500 text-sm">Accounts on this platform. Banned users cannot sign in.</p>
        </div>
      </div>

      {error && (
        <div className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-6">{error}</div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <div className="card"><div className="text-xs text-gray-500">Total users</div><div className="text-2xl font-bold mt-1">{users.length}</div></div>
        <div className="card"><div className="text-xs text-gray-500">Pending approval</div><div className="text-2xl font-bold mt-1 text-orange-600">{users.filter(u => !u.approved).length}</div></div>
        <div className="card"><div className="text-xs text-gray-500">Banned</div><div className="text-2xl font-bold mt-1 text-red-600">{users.filter(u => u.banned).length}</div></div>
      </div>

      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-gray-400 border-b border-gray-100 dark:border-gray-800">
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Approval</th>
              <th className="px-4 py-3">Password</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className="border-b border-gray-50 dark:border-gray-800 last:border-0">
                <td className="px-4 py-3 text-gray-900 dark:text-gray-100">{u.email}</td>
                <td className="px-4 py-3 text-gray-500">{u.role}</td>
                <td className="px-4 py-3">
                  {u.banned ? (
                    <span className="text-red-600">Banned</span>
                  ) : (
                    <span className="text-green-600">Active</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {u.approved ? (
                    u.role === 'admin' ? <span className="text-green-600">Approved</span> : <button className="btn-secondary text-xs" onClick={() => toggleApproval(u)}>Revoke</button>
                  ) : <button className="btn-primary text-xs" onClick={() => toggleApproval(u)}>Approve</button>}
                </td>
                <td className="px-4 py-3">
                  {u.role === 'admin' ? (
                    <span className="text-xs text-gray-400">Protected</span>
                  ) : temporaryPasswords[u.id] ? (
                    <div className="flex items-center gap-2">
                      <code className="rounded bg-gray-100 px-2 py-1 text-xs">{temporaryPasswords[u.id]}</code>
                      <button className="text-gray-500 hover:text-gray-900" title="Copy" onClick={() => navigator.clipboard?.writeText(temporaryPasswords[u.id])}><Copy size={14} /></button>
                    </div>
                  ) : (
                    <button className="btn-secondary text-xs inline-flex items-center gap-1" disabled={resetting === u.id} onClick={() => resetPassword(u)}><KeyRound size={12} /> {resetting === u.id ? 'Generating…' : 'Reset'}</button>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {u.role !== 'admin' && (
                    <button
                      className={u.banned ? 'btn-secondary text-xs' : 'btn-danger text-xs'}
                      onClick={() => toggleBan(u)}
                    >
                      {u.banned ? <span className="inline-flex items-center gap-1"><Check size={12} /> Unban</span> : <span className="inline-flex items-center gap-1"><Ban size={12} /> Ban</span>}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
