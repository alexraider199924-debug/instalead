import { Router } from 'express';
import {
  userCount,
  registerUser,
  loginUser,
  readToken,
  deleteSession,
  setSessionCookie,
  clearSessionCookie,
  listUsers,
  setBanned,
  setApproved,
  resetUserPassword
} from '../services/authService.js';

const router = Router();

router.get('/status', async (req, res) => {
  const count = await userCount();
  const user = req.user || null;
  res.json({
    authRequired: count > 0,
    user: user ? { id: user.id, email: user.email, role: user.role, workspace: user.workspace, banned: !!user.banned, approved: user.approved !== false } : null
  });
});

router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const { user } = await registerUser(email, password);
    res.status(202).json({ user, pendingApproval: true, message: 'Registration submitted for administrator approval' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const { user, token } = await loginUser(email, password);
    setSessionCookie(res, token);
    res.json({ user, token });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Login failed' });
  }
});

router.post('/logout', async (req, res) => {
  await deleteSession(readToken(req));
  clearSessionCookie(res);
  res.json({ success: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
      workspace: req.user.workspace,
      banned: !!req.user.banned,
      approved: req.user.approved !== false
    }
  });
});

router.get('/users', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  res.json({ users: await listUsers() });
});

router.post('/users/:id/approve', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const user = await setApproved(Number(req.params.id), req.body?.approved !== false);
    res.json({ user });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Failed to update approval' });
  }
});

router.post('/users/:id/reset-password', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const result = await resetUserPassword(Number(req.params.id));
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Failed to reset password' });
  }
});

router.post('/users/:id/ban', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  try {
    const banned = req.body?.banned !== false;
    const user = await setBanned(Number(req.params.id), banned);
    res.json({ user });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Failed to update user' });
  }
});

export default router;
