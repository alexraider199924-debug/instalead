import React, { useState } from 'react';
import { Zap } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function Login() {
  const { login, register, authRequired } = useAuth();
  const [mode, setMode] = useState(authRequired ? 'login' : 'register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'register') {
        await register(email, password);
        setSubmitted(true);
      } else await login(email, password);
    } catch (err) {
      setError(err.error || err.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 app-shell">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-orange-400 to-pink-500 flex items-center justify-center">
            <Zap className="text-white" size={18} />
          </div>
          <span className="text-xl font-bold text-gray-900 dark:text-white">Instalead</span>
        </div>

        <div className="card">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-1">
            {mode === 'register' ? 'Create an account' : 'Sign in'}
          </h1>
          <p className="text-sm text-gray-500 mb-6">
            {mode === 'register'
              ? 'Create a user account and open your workspace.'
              : 'Enter your email and password to open the workspace.'}
          </p>

          {submitted ? (
            <div className="text-green-700 text-sm bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900 rounded-lg px-4 py-3 mb-4">
              Registration submitted. An administrator must approve your account before you can sign in.
            </div>
          ) : null}

          {error && (
            <div className="text-red-600 text-sm bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-lg px-4 py-3 mb-4">
              {error}
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">Email</label>
              <input
                className="input"
                type="email"
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">Password</label>
              <input
                className="input"
                type="password"
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                minLength={8}
                required
              />
              {mode === 'register' && (
                <p className="text-xs text-gray-400 mt-1">At least 8 characters.</p>
              )}
            </div>
            <button type="submit" className="btn-primary w-full" disabled={busy}>
              {busy ? 'Please wait…' : (mode === 'register' ? 'Register' : 'Sign in')}
            </button>
          </form>

          <p className="text-sm text-gray-500 mt-5 text-center">
            {mode === 'register' ? 'Already have an account?' : 'No account yet?'}{' '}
            <button
              type="button"
              className="text-orange-600 font-medium"
              onClick={() => { setMode(mode === 'register' ? 'login' : 'register'); setError(''); }}
            >
              {mode === 'register' ? 'Sign in' : 'Register'}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
