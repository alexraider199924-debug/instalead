import axios from 'axios';

const TOKEN_KEY = 'instalead_token';

export function getAuthToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function setAuthToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

function getWorkspaceFromCookie() {
  const match = document.cookie.match(/(?:^|;\s*)instalead_ws=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function getWorkspace() {
  const cookieWs = getWorkspaceFromCookie();
  if (cookieWs) return cookieWs;

  return 'default';
}

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: 30000,
  withCredentials: true
});

api.interceptors.request.use(config => {
  config.headers['X-Workspace'] = getWorkspace();
  const token = getAuthToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  res => res.data,
  err => Promise.reject(err.response?.data || err)
);

export function getCurrentWorkspace() {
  return getWorkspace();
}

export function setWorkspaceCookie(workspace) {
  if (!workspace) return;
  document.cookie = `instalead_ws=${encodeURIComponent(workspace)}; path=/; max-age=${60 * 60 * 24 * 365}`;
}

export default api;
