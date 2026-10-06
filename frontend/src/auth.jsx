import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [expired, setExpired] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { user: u } = await api.get('/auth/me', { quiet401: true });
      setUser(u);
    } catch {
      setUser(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    // Any 401 ends the client session immediately so no sensitive data stays on screen.
    const onUnauthorized = (e) => {
      setUser((prev) => {
        if (prev && ['SESSION_EXPIRED', 'SESSION_REVOKED', 'NO_SESSION'].includes(e.detail)) setExpired(true);
        return null;
      });
    };
    // Pages restored from the back/forward cache after logout must re-check the session.
    const onPageShow = (e) => { if (e.persisted) window.location.reload(); };
    window.addEventListener('vhc:unauthorized', onUnauthorized);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('vhc:unauthorized', onUnauthorized);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [refresh]);

  const login = async (email, password, rememberDevice = false) => {
    const { user: u } = await api.post('/auth/login', { email, password, rememberDevice });
    setExpired(false);
    setUser(u);
    return u;
  };
  /** Used after a flow that establishes a session server-side (e.g. claimant verification). */
  const adoptSession = (u) => { setExpired(false); setUser(u); };
  const logout = async () => {
    try { await api.post('/auth/logout', {}, { quiet401: true }); } catch { /* already ended */ }
    setUser(null);
  };

  return (
    <AuthCtx.Provider value={{ user, ready, expired, setExpired, login, adoptSession, logout, refresh, setUser }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
export const isStaff = (u) => ['agent', 'underwriter', 'claims_officer', 'admin'].includes(u?.role);
export const homeFor = (u) => (!u ? '/' : u.role === 'customer' ? '/dashboard' : u.role === 'claimant' ? '/life-claim' : '/ops');
