import React, { createContext, useContext, useEffect, useState } from 'react';
import api, { getAuthToken, setAuthToken, setWorkspaceCookie } from '../utils/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [ready, setReady] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [user, setUser] = useState(null);

  const load = async () => {
    try {
      const data = await api.get('/auth/status');
      setAuthRequired(!!data.authRequired);
      setUser(data.user || null);
      if (data.user?.workspace) setWorkspaceCookie(data.user.workspace);
    } catch {
      setAuthRequired(!!getAuthToken());
      setUser(null);
    } finally {
      setReady(true);
    }
  };

  useEffect(() => { load(); }, []);

  const afterAuth = (payload) => {
    setAuthToken(payload.token);
    setUser(payload.user);
    setAuthRequired(true);
    if (payload.user?.workspace) setWorkspaceCookie(payload.user.workspace);
  };

  const login = async (email, password) => {
    const data = await api.post('/auth/login', { email, password });
    afterAuth(data);
    return data;
  };

  const register = async (email, password) => {
    return api.post('/auth/register', { email, password });
  };

  const logout = async () => {
    try { await api.post('/auth/logout'); } catch {}
    setAuthToken('');
    setUser(null);
    await load();
  };

  return (
    <AuthContext.Provider value={{ ready, authRequired, user, login, register, logout, reload: load }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
