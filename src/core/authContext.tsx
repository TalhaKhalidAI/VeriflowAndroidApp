import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { Alert, NativeModules, Platform } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { getAppSetting, initDatabase, setAppSetting, syncRulesFromPayload } from './db';
import { buildApiUrl, normalizeApiBaseUrl, parseRootCaPayload } from './jwt';
import { ShiftSession } from './types';

export interface RefreshPermissionsResult {
  ok: boolean;
  status?: number;
  error?: string;
}

interface AuthContextType {
  session: ShiftSession | null;
  isLoggedIn: boolean;
  isShiftExpired: boolean;
  isLoading: boolean;
  apiBaseUrl: string;
  setApiBaseUrl: (url: string) => Promise<void>;
  rootCaCert: string;
  setRootCaCert: (pemOrEmpty: string) => Promise<boolean>;
  isNativeCaAvailable: boolean;
  hasPermission: (permission: string) => boolean;
  updateSessionPermissions: (newPerms: Record<string, boolean>, role?: string) => Promise<void>;
  refreshPermissions: () => Promise<RefreshPermissionsResult>;
  markOfflineCheckout: () => Promise<void>;
  clearOfflineCheckout: () => Promise<void>;
  login: (token: string, payload: any, publicKeyId?: number) => Promise<void>;
  logout: () => Promise<void>;
}

const DEFAULT_API_URL =
  Platform.OS === 'android' ? 'http://10.0.2.2:8000' : 'http://127.0.0.1:8000';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const isNativeCaAvailable = Boolean(
  NativeModules?.VeriFlowCustomCa && typeof NativeModules.VeriFlowCustomCa.setRootCa === 'function'
);

async function applyNativeRootCa(pem: string): Promise<boolean> {
  try {
    const customCaMod = NativeModules?.VeriFlowCustomCa;
    if (customCaMod && typeof customCaMod.setRootCa === 'function') {
      await customCaMod.setRootCa(pem || null);
      return true;
    }
  } catch (e) {
    console.warn('Native Root CA module sync skipped or failed:', e);
  }
  return false;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<ShiftSession | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [apiBaseUrl, setApiBaseUrlState] = useState<string>(DEFAULT_API_URL);
  const [rootCaCert, setRootCaCertState] = useState<string>('');

  useEffect(() => {
    async function restore() {
      try {
        await initDatabase();
        const savedUrl = await getAppSetting('api_base_url', DEFAULT_API_URL);
        if (savedUrl) setApiBaseUrlState(normalizeApiBaseUrl(savedUrl));

        const savedRootCa = await getAppSetting('root_ca_cert', '');
        if (savedRootCa) {
          setRootCaCertState(savedRootCa);
          await applyNativeRootCa(savedRootCa);
        }

        const savedSessionJson = await getAppSetting('active_session', '');
        if (savedSessionJson) {
          const parsed: ShiftSession = JSON.parse(savedSessionJson);
          // Always restore active shift session even if expired so operator
          // can review history, sync pending records, and complete checkout.
          setSession(parsed);
        }
      } catch (e) {
        console.warn('Failed restoring auth session:', e);
      } finally {
        setIsLoading(false);
      }
    }
    void restore();
  }, []);

  const setApiBaseUrl = async (url: string) => {
    const normalized = normalizeApiBaseUrl(url);
    if (!normalized) return;
    setApiBaseUrlState(normalized);
    await setAppSetting('api_base_url', normalized);
  };

  const setRootCaCert = async (pemOrEmpty: string): Promise<boolean> => {
    const trimmed = (pemOrEmpty || '').trim();
    if (!trimmed) {
      setRootCaCertState('');
      await setAppSetting('root_ca_cert', '');
      await applyNativeRootCa('');
      return true;
    }
    const parsed = parseRootCaPayload(trimmed);
    setRootCaCertState(parsed.pem);
    await setAppSetting('root_ca_cert', parsed.pem);
    return await applyNativeRootCa(parsed.pem);
  };

  const hasPermission = (perm: string): boolean => {
    if (!session) return false;
    if (session.role === 'admin' || session.permissions?.['*'] === true) {
      return true;
    }

    if (session.permissions?.[perm] === true) {
      return true;
    }

    // Strict scan permissions checking - NEVER alias to user account settings
    if (perm === 'scans.create') {
      return session.permissions?.['scans.create'] === true;
    }

    if (perm === 'scans.view' || perm === 'scans.view.own') {
      return (
        session.permissions?.['scans.view.own'] === true ||
        session.permissions?.['scans.view'] === true ||
        session.permissions?.['scans.view.any'] === true
      );
    }

    if (perm === 'scans.view.any') {
      return session.permissions?.['scans.view.any'] === true || session.role === 'admin';
    }

    if (perm === 'scans.update') {
      return session.permissions?.['scans.update'] === true;
    }

    if (perm === 'scans.delete') {
      return session.permissions?.['scans.delete'] === true;
    }

    if (perm === 'inventory_rules.view') {
      return (
        session.permissions?.['inventory_rules.view'] === true ||
        session.permissions?.['inventory_rules'] === true
      );
    }

    if (perm === 'inventory_rules.create') {
      return (
        session.permissions?.['inventory_rules.create'] === true ||
        session.permissions?.['inventory_rules'] === true
      );
    }

    if (perm === 'inventory_rules.update') {
      return (
        session.permissions?.['inventory_rules.update'] === true ||
        session.permissions?.['inventory_rules'] === true
      );
    }

    if (perm === 'inventory_rules.delete') {
      return (
        session.permissions?.['inventory_rules.delete'] === true ||
        session.permissions?.['inventory_rules'] === true
      );
    }

    if (perm === 'keys.view') {
      return (
        session.permissions?.['keys.view'] === true ||
        session.permissions?.['keys'] === true
      );
    }

    if (perm === 'keys.create') {
      return (
        session.permissions?.['keys.create'] === true ||
        session.permissions?.['keys'] === true
      );
    }

    if (perm === 'keys.update') {
      return (
        session.permissions?.['keys.update'] === true ||
        session.permissions?.['keys'] === true
      );
    }

    if (perm === 'keys.delete' || perm === 'keys.revoke') {
      return (
        session.permissions?.['keys.delete'] === true ||
        session.permissions?.['keys.revoke'] === true
      );
    }

    if (perm === 'user.delete_all_data' || perm === 'delete_all_data') {
      return (
        session.permissions?.['user.delete_all_data'] === true ||
        session.permissions?.['delete_all_data'] === true
      );
    }

    return false;
  };

  const login = async (token: string, payload: any, publicKeyId?: number) => {
    const perms: Record<string, boolean> = typeof payload.permissions === 'object' && payload.permissions !== null
      ? { ...payload.permissions }
      : {};

    // Standard shift operator defaults for mobile worker:
    if (perms['scans.view.own'] === undefined) perms['scans.view.own'] = true;
    if (perms['scans.create'] === undefined) perms['scans.create'] = true;
    if (perms['inventory_rules.view'] === undefined) perms['inventory_rules.view'] = true;

    // Store embedded inventory rules (supports dict or array) to local SQLite DB
    if (payload.rules) {
      try {
        await syncRulesFromPayload(payload.rules);
      } catch (err) {
        console.warn('Could not auto-sync rules from token:', err);
      }
    }

    // Try fetching fresh permissions from server API in background if online
    try {
      const profileRes = await fetch(buildApiUrl(apiBaseUrl, '/users/users_config/me'), {
        headers: { Authorization: `Bearer ${token.trim()}` },
      }).catch(() => null);

      if (profileRes && profileRes.ok) {
        const profile = await profileRes.json();
        if (profile.permissions && typeof profile.permissions === 'object') {
          Object.assign(perms, profile.permissions);
        }
        if (profile.user_role) {
          payload.role = profile.user_role;
        }
      }
    } catch {
      // Offline fallback: keep token permissions
    }

    const newSession: ShiftSession = {
      token: token.trim(),
      sub: String(payload.sub || payload.email || 'operator'),
      userId: Number(payload.user_id || 0),
      shiftId: String(payload.shift_id || ''),
      keyId: payload.key_id ? String(payload.key_id) : undefined,
      role: payload.role ? String(payload.role) : 'user',
      permissions: perms,
      rules: payload.rules || [],
      exp: Number(payload.exp || 0),
      iat: Number(payload.iat || 0),
      publicKeyId,
    };

    setSession(newSession);
    await setAppSetting('active_session', JSON.stringify(newSession));
  };

  // TanStack Query: Live background permission polling & real-time notification
  const { data: remoteProfile } = useQuery({
    queryKey: ['admin_permissions_sync', session?.userId, session?.token, apiBaseUrl],
    queryFn: async () => {
      if (!session?.token) return null;
      try {
        const url = buildApiUrl(apiBaseUrl, '/users/users_config/me');
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${session.token}`,
            Accept: 'application/json',
          },
        });
        if (!res.ok) {
          return null;
        }
        return await res.json();
      } catch {
        return null;
      }
    },
    enabled: Boolean(session?.token && session?.userId),
    refetchInterval: 10000, // Check for admin updates every 10 seconds!
    refetchIntervalInBackground: true,
  });

  // Track and notify changes in permissions
  const prevPermsRef = useRef<Record<string, boolean> | null>(null);

  useEffect(() => {
    if (!remoteProfile || !session) return;

    const serverPerms: Record<string, boolean> = {};
    if (Array.isArray(remoteProfile.permissions)) {
      for (const p of remoteProfile.permissions) serverPerms[p] = true;
    } else if (remoteProfile.permissions && typeof remoteProfile.permissions === 'object') {
      Object.assign(serverPerms, remoteProfile.permissions);
    }

    const currentPerms = session.permissions || {};

    // Initialize baseline on first fetch so we don't alert on initial startup
    if (!prevPermsRef.current) {
      prevPermsRef.current = { ...currentPerms, ...serverPerms };
      return;
    }

    const prev = prevPermsRef.current;
    const added: string[] = [];
    const removed: string[] = [];

    // Detect newly granted permissions
    for (const [k, v] of Object.entries(serverPerms)) {
      if (v && !prev[k]) {
        added.push(k);
      }
    }

    // Detect newly revoked permissions
    for (const [k, v] of Object.entries(prev)) {
      if (v && !serverPerms[k]) {
        removed.push(k);
      }
    }

    if (added.length > 0 || removed.length > 0) {
      prevPermsRef.current = { ...serverPerms };

      setSession(s => {
        if (!s) return null;
        const updated: ShiftSession = {
          ...s,
          role: remoteProfile.user_role || s.role,
          permissions: { ...serverPerms },
        };
        void setAppSetting('active_session', JSON.stringify(updated));
        return updated;
      });

      const changes: string[] = [];
      if (added.length > 0) {
        changes.push(`🟢 GRANTED:\n${added.map(p => `  • ${p}`).join('\n')}`);
      }
      if (removed.length > 0) {
        changes.push(`🔴 REVOKED:\n${removed.map(p => `  • ${p}`).join('\n')}`);
      }

      Alert.alert(
        '🛡️ Permissions Updated by Admin',
        `Your access permissions have been updated in real-time:\n\n${changes.join('\n\n')}`,
      );
    }
  }, [remoteProfile, session?.userId]);

  const refreshPermissions = useCallback(async (): Promise<RefreshPermissionsResult> => {
    if (!session?.token) {
      return { ok: false, error: 'No active session token found.' };
    }
    try {
      const url = buildApiUrl(apiBaseUrl, '/users/users_config/me');
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${session.token}` },
      }).catch(() => null);

      if (!res) {
        return { ok: false, error: 'Network request failed. Server unreachable or offline.' };
      }

      if (res.ok) {
        const profile = await res.json();
        const serverPerms: Record<string, boolean> = {};
        if (Array.isArray(profile.permissions)) {
          for (const p of profile.permissions) serverPerms[p] = true;
        } else if (profile.permissions && typeof profile.permissions === 'object') {
          Object.assign(serverPerms, profile.permissions);
        }

        setSession(prev => {
          if (!prev) return null;
          const merged = { ...prev.permissions, ...serverPerms };
          const updated: ShiftSession = {
            ...prev,
            role: profile.user_role || prev.role,
            permissions: merged,
          };
          void setAppSetting('active_session', JSON.stringify(updated));
          return updated;
        });
        return { ok: true, status: res.status };
      }

      const errBody = await res.json().catch(() => ({}));
      const errMsg = errBody.detail || errBody.error || errBody.message || `Server responded with status ${res.status}`;

      if (res.status === 401) {
        return {
          ok: false,
          status: 401,
          error: 'Session token rejected by server (401: Invalid token). This shift session was ended on the server or signed with an older key. Please check out and scan a fresh shift badge.',
        };
      }

      if (res.status === 404) {
        return {
          ok: false,
          status: 404,
          error: `API endpoint not found (404) at ${url}. Please verify Server API URL in Settings.`,
        };
      }

      return { ok: false, status: res.status, error: errMsg };
    } catch (e: any) {
      console.warn('refreshPermissions failed:', e);
      return { ok: false, error: e.message || 'Unknown error refreshing permissions.' };
    }
  }, [session?.token, apiBaseUrl]);

  const updateSessionPermissions = useCallback(async (newPerms: Record<string, boolean>, role?: string) => {
    setSession(prev => {
      if (!prev) return null;
      const updated: ShiftSession = {
        ...prev,
        role: role || prev.role,
        permissions: newPerms,
      };
      void setAppSetting('active_session', JSON.stringify(updated));
      return updated;
    });
  }, []);

  const markOfflineCheckout = useCallback(async () => {
    setSession(prev => {
      if (!prev) return null;
      const updated: ShiftSession = {
        ...prev,
        offlineCheckoutPending: true,
      };
      void setAppSetting('active_session', JSON.stringify(updated));
      return updated;
    });
  }, []);

  const clearOfflineCheckout = useCallback(async () => {
    setSession(prev => {
      if (!prev) return null;
      const updated: ShiftSession = {
        ...prev,
        offlineCheckoutPending: false,
      };
      void setAppSetting('active_session', JSON.stringify(updated));
      return updated;
    });
  }, []);

  const logout = useCallback(async () => {
    setSession(null);
    await setAppSetting('active_session', '');
  }, []);

  const isShiftExpired = Boolean(
    session?.exp && Math.floor(Date.now() / 1000) >= session.exp
  );

  return (
    <AuthContext.Provider
      value={{
        session,
        isLoggedIn: Boolean(session),
        isShiftExpired,
        isLoading,
        apiBaseUrl,
        setApiBaseUrl,
        rootCaCert,
        setRootCaCert,
        isNativeCaAvailable,
        hasPermission,
        updateSessionPermissions,
        refreshPermissions,
        markOfflineCheckout,
        clearOfflineCheckout,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
