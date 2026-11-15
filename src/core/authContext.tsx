import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { Alert, AppState, AppStateStatus, NativeModules, Platform } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import {
  DatabaseSecurityError,
  getAppSetting,
  initDatabase,
  replaceInventoryRules,
  setAppSetting,
  syncRulesFromPayload,
} from './db';
import {
  apiFetch,
  buildApiUrl,
  extractJwtHeader,
  extractJwtPayload,
  normalizeApiBaseUrl,
  parseRootCaPayload,
} from './jwt';
import { ShiftSession } from './types';

export interface RefreshPermissionsResult {
  ok: boolean;
  status?: number;
  error?: string;
}

interface RevocationDeltaItem {
  id: number;
  target_type: string;
  target_id: string;
  revoked_by?: number | null;
  revoked_at: string;
  reason?: string | null;
}

interface RevocationDeltaResponse {
  items: RevocationDeltaItem[];
  server_time: string;
  since?: string | null;
  count: number;
}

interface AuthContextType {
  session: ShiftSession | null;
  isLoggedIn: boolean;
  isShiftExpired: boolean;
  isLoading: boolean;
  dbSecurityError: DatabaseSecurityError | null;
  apiBaseUrl: string;
  setApiBaseUrl: (url: string) => Promise<void>;
  rootCaCert: string;
  setRootCaCert: (pemOrEmpty: string) => Promise<boolean>;
  isNativeCaAvailable: boolean;
  hasPermission: (permission: string) => boolean;
  updateSessionPermissions: (newPerms: Record<string, boolean>, role?: string) => Promise<void>;
  refreshPermissions: () => Promise<RefreshPermissionsResult>;
  syncRevocationsDelta: () => Promise<boolean>;
  markOfflineCheckout: () => Promise<void>;
  clearOfflineCheckout: () => Promise<void>;
  login: (token: string, payload: any, publicKeyId?: number) => Promise<void>;
  logout: () => Promise<void>;
  // Strict Shift Policy flags & methods
  isStrictRules: boolean;
  isStrictKey: boolean;
  strictKeyId?: string;
  strictKeyKid?: string;
  canOverrideRules: boolean;
  canOverrideKey: boolean;
  ruleMatchMode: 'all' | 'any';
  refreshActiveRules: () => Promise<void>;
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

/**
 * Reads Android SystemClock.elapsedRealtime() (milliseconds since boot) via native module.
 * Immune to user wall-clock tampering; resets to 0 across device reboots.
 */
export async function getMonotonicElapsedRealtimeMs(): Promise<number | null> {
  try {
    const nativeMod = NativeModules?.VeriFlowCustomCa;
    if (!nativeMod) {
      return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : null;
    }
    if (typeof nativeMod.getElapsedRealtimeSync === 'function') {
      const val = Number(nativeMod.getElapsedRealtimeSync());
      if (Number.isFinite(val) && val >= 0) return val;
    }
    if (typeof nativeMod.getElapsedRealtime === 'function') {
      const val = Number(await nativeMod.getElapsedRealtime());
      if (Number.isFinite(val) && val >= 0) return val;
    }
  } catch (e) {
    console.warn('Monotonic clock read failed:', e);
  }
  return null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<ShiftSession | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [dbSecurityError, setDbSecurityError] = useState<DatabaseSecurityError | null>(null);
  const [apiBaseUrl, setApiBaseUrlState] = useState<string>(DEFAULT_API_URL);
  const [rootCaCert, setRootCaCertState] = useState<string>('');
  const [monotonicExpired, setMonotonicExpired] = useState<boolean>(false);
  const revocationLogoutInProgressRef = useRef<boolean>(false);

  const logout = useCallback(async () => {
    setSession(null);
    setMonotonicExpired(false);
    await setAppSetting('active_session', '');
  }, []);

  /**
   * Evaluates monotonic clock elapsed time and detects device reboots.
   * Conservative security policy: if device rebooted (currentElapsed < monotonicStartMs)
   * or monotonic timestamp is missing on Android, treat the shift as expired and force re-login.
   */
  const evaluateMonotonicShiftState = useCallback(
    async (activeSession: ShiftSession | null, onRebootLogout = true): Promise<boolean> => {
      if (!activeSession) {
        setMonotonicExpired(false);
        return false;
      }

      const currentElapsedMs = await getMonotonicElapsedRealtimeMs();
      if (currentElapsedMs !== null) {
        const startMs = activeSession.monotonicStartMs;
        const durationMs = activeSession.monotonicDurationMs;

        // 1. Reboot / Missing Monotonic Anchor Detection
        if (startMs === undefined || !Number.isFinite(startMs) || currentElapsedMs < startMs) {
          setMonotonicExpired(true);
          if (onRebootLogout && !revocationLogoutInProgressRef.current) {
            revocationLogoutInProgressRef.current = true;
            await logout();
            Alert.alert(
              '🔒 Shift Expired (Device Reboot Detected)',
              'The monotonic shift clock reset due to a device restart. For security, please scan a fresh shift badge to log in.',
            );
            revocationLogoutInProgressRef.current = false;
          }
          return true;
        }

        // 2. Monotonic Duration Check (immune to Date.now() rollback)
        if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0) {
          const elapsedInShiftMs = currentElapsedMs - startMs;
          if (elapsedInShiftMs >= durationMs) {
            setMonotonicExpired(true);
            return true;
          }
        }
      }

      // 3. Fallback wall-clock check
      const wallExpired = Boolean(
        activeSession.exp && Math.floor(Date.now() / 1000) >= activeSession.exp
      );
      setMonotonicExpired(wallExpired);
      return wallExpired;
    },
    [logout],
  );

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
          const currentElapsedMs = await getMonotonicElapsedRealtimeMs();

          // Conservative reboot check on cold start:
          if (
            currentElapsedMs !== null &&
            (parsed.monotonicStartMs === undefined || currentElapsedMs < parsed.monotonicStartMs)
          ) {
            await setAppSetting('active_session', '');
            setSession(null);
            setMonotonicExpired(true);
            Alert.alert(
              '🔒 Shift Expired (Device Reboot)',
              'Your device was restarted during an active shift. Monotonic timer security requires scanning a fresh shift QR code.',
            );
          } else {
            setSession(parsed);
            await evaluateMonotonicShiftState(parsed, true);
          }
        }
      } catch (e: any) {
        if (e instanceof DatabaseSecurityError) {
          setDbSecurityError(e);
        }
        console.warn('Failed restoring auth session:', e);
      } finally {
        setIsLoading(false);
      }
    }
    void restore();
  }, [evaluateMonotonicShiftState]);

  // Periodic monotonic clock watchdog every 5 seconds
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      void evaluateMonotonicShiftState(session, true);
    }, 5000);
    return () => clearInterval(timer);
  }, [session, evaluateMonotonicShiftState]);

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

  /**
   * Delta Sync (Offline-first revocation & checkout enforcement):
   * Whenever network is available (foreground transition, reconnect, or periodic poll),
   * queries GET /revocations/delta?since=<timestamp>. If the current shift, user, or signing key
   * is in the delta list, invalidates the local shift token and redirects to LoginPage immediately.
   */
  const handleRemoteRevocationLogout = useCallback(
    async (reasonText: string) => {
      if (revocationLogoutInProgressRef.current) return;
      revocationLogoutInProgressRef.current = true;
      try {
        await logout();
        Alert.alert(
          '🛑 Shift Session Terminated',
          reasonText || 'Your shift or signing key was revoked on the server. You have been logged out.',
        );
      } finally {
        revocationLogoutInProgressRef.current = false;
      }
    },
    [logout],
  );

  const syncRevocationsDelta = useCallback(async (): Promise<boolean> => {
    if (!session) return false;
    try {
      const savedSince = await getAppSetting('last_revocation_delta_since', '');
      const fallbackSince =
        session.iat && session.iat > 0
          ? new Date((session.iat - 60) * 1000).toISOString()
          : '';
      const sinceParam = savedSince || fallbackSince;

      // Always extract live claims/header from token so even pre-existing sessions have key_id & kid
      const tokenClaims = session.token ? extractJwtPayload(session.token) : null;
      const tokenHeader = session.token ? extractJwtHeader(session.token) : null;

      const sessionShiftId = String(session.shiftId || tokenClaims?.shift_id || '');
      const sessionUserId = String(session.userId || tokenClaims?.user_id || '');
      const sessionSigningKeyId = String(
        session.signingKeyId || tokenClaims?.key_id || session.keyId || '',
      );
      const sessionSigningKeyKid = String(
        session.signingKeyKid || tokenClaims?.kid || tokenHeader?.kid || '',
      );
      const sessionStrictKeyId = String(
        (session as any).strict_key_id || tokenClaims?.strict_key_id || '',
      );
      const sessionStrictKeyKid = String(
        session.strict_key_kid || tokenClaims?.strict_key_kid || '',
      );

      const queryParams = new URLSearchParams();
      if (sinceParam) queryParams.set('since', sinceParam);
      if (sessionShiftId) queryParams.set('shift_id', sessionShiftId);
      if (sessionSigningKeyId) queryParams.set('key_id', sessionSigningKeyId);
      if (sessionSigningKeyKid) queryParams.set('kid', sessionSigningKeyKid);
      if (sessionStrictKeyId) queryParams.set('strict_key_id', sessionStrictKeyId);
      if (sessionStrictKeyKid) queryParams.set('strict_key_kid', sessionStrictKeyKid);

      const qs = queryParams.toString();
      const endpoint = qs ? `/revocations/delta?${qs}` : '/revocations/delta';

      const res = await apiFetch(apiBaseUrl, endpoint, {
        headers: {
          Accept: 'application/json',
          ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
        },
      }).catch(() => null);

      if (!res || !res.ok) {
        return false;
      }

      const data = (await res.json()) as RevocationDeltaResponse;
      if (data?.server_time) {
        await setAppSetting('last_revocation_delta_since', data.server_time);
      }

      if (Array.isArray(data?.items) && data.items.length > 0) {
        const candidateKeys = new Set(
          [
            sessionSigningKeyId,
            sessionSigningKeyKid,
            String(session.keyId || ''),
            sessionStrictKeyId,
            sessionStrictKeyKid,
          ].filter(Boolean),
        );

        const matched = data.items.find(item => {
          const targetType = String(item.target_type || '').toLowerCase();
          const targetId = String(item.target_id || '');
          if (!targetId) return false;

          if (targetType === 'shift' && sessionShiftId && targetId === sessionShiftId) {
            return true;
          }
          if (targetType === 'user' && sessionUserId && targetId === sessionUserId) {
            return true;
          }
          if (targetType === 'key' && candidateKeys.has(targetId)) {
            return true;
          }
          return false;
        });

        if (matched) {
          const reasonMsg = matched.reason
            ? `Your ${matched.target_type} was terminated on the server (${matched.reason}).`
            : `Your ${matched.target_type} was revoked or checked out on the server.`;
          await handleRemoteRevocationLogout(reasonMsg);
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }, [session, apiBaseUrl, handleRemoteRevocationLogout]);

  // Trigger Delta Sync + Monotonic Check immediately when app returns to foreground
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'active' && session) {
        void evaluateMonotonicShiftState(session, true);
        void syncRevocationsDelta();
      }
    });
    return () => subscription.remove();
  }, [session, evaluateMonotonicShiftState, syncRevocationsDelta]);

  // Fast Background Delta Sync via TanStack Query (every 3 seconds when online)
  useQuery({
    queryKey: ['revocations_delta_sync', session?.shiftId, session?.userId, apiBaseUrl],
    queryFn: async () => {
      return await syncRevocationsDelta();
    },
    enabled: Boolean(session?.token && session?.shiftId),
    refetchInterval: 3000,
    refetchIntervalInBackground: true,
    retry: false,
  });

  const hasPermission = (perm: string): boolean => {
    if (!session) return false;
    if (session.role === 'admin' || session.permissions?.['*'] === true) {
      return true;
    }

    if (session.permissions?.[perm] === true) {
      return true;
    }

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

    if (perms['scans.view.own'] === undefined) perms['scans.view.own'] = true;
    if (perms['scans.create'] === undefined) perms['scans.create'] = true;
    if (perms['inventory_rules.view'] === undefined) perms['inventory_rules.view'] = true;

    const canOverrideRules = Boolean(
      perms['rules.override'] ||
      payload.role === 'admin' ||
      payload.allow_rule_override === true
    );

    if (payload.rules) {
      try {
        if (!canOverrideRules && Array.isArray(payload.rules)) {
          await replaceInventoryRules(
            payload.rules.map((r: any) => ({
              rule_name: r.rule_name || `Rule_${r.matching_claim_key}`,
              matching_claim_key: String(r.matching_claim_key),
              expected_value: String(r.expected_value ?? ''),
            }))
          );
        } else {
          await syncRulesFromPayload(payload.rules);
        }
      } catch (err) {
        console.warn('Could not auto-sync rules from token:', err);
      }
    }

    try {
      const profileRes = await apiFetch(apiBaseUrl, '/users/users_config/me', {
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

    const expSec = Number(payload.exp || 0);
    const iatSec = Number(payload.iat || Math.floor(Date.now() / 1000));
    const nowWallSec = Math.floor(Date.now() / 1000);
    // Calculate shift duration from JWT claims (exp - iat), bounded by remaining wall time if positive
    const claimDurationSec = expSec > iatSec ? expSec - iatSec : Math.max(0, expSec - nowWallSec);
    const monotonicStartMs = await getMonotonicElapsedRealtimeMs();
    const monotonicDurationMs = claimDurationSec * 1000;

    const header = extractJwtHeader(token.trim());
    const signingKeyId = payload.key_id ? String(payload.key_id) : undefined;
    const signingKeyKid =
      payload.kid ? String(payload.kid) : header?.kid ? String(header.kid) : undefined;

    const newSession: ShiftSession & Record<string, any> = {
      token: token.trim(),
      sub: String(payload.sub || payload.email || 'operator'),
      userId: Number(payload.user_id || 0),
      shiftId: String(payload.shift_id || ''),
      keyId: payload.strict_key_id ? String(payload.strict_key_id) : signingKeyId,
      signingKeyId,
      signingKeyKid,
      role: payload.role ? String(payload.role) : 'user',
      permissions: perms,
      rules: payload.rules || [],
      exp: expSec,
      iat: iatSec,
      monotonicStartMs: monotonicStartMs ?? undefined,
      monotonicDurationMs,
      publicKeyId,
      strict_rules: payload.strict_rules,
      strict_key: payload.strict_key,
      strict_key_id: payload.strict_key_id,
      strict_key_kid: payload.strict_key_kid,
      allow_rule_override: payload.allow_rule_override,
      allow_key_override: payload.allow_key_override,
      rule_match_mode: payload.rule_match_mode === 'any' ? 'any' : 'all',
    };

    // Anchor delta sync timestamp to shift issue time so any post-issue revocation is caught
    if (iatSec > 0) {
      await setAppSetting(
        'last_revocation_delta_since',
        new Date((iatSec - 5) * 1000).toISOString(),
      );
    }

    setMonotonicExpired(false);
    setSession(newSession);
    await setAppSetting('active_session', JSON.stringify(newSession));
  };

  const isShiftExpired = Boolean(
    monotonicExpired || (session?.exp && Math.floor(Date.now() / 1000) >= session.exp)
  );

  // TanStack Query: Live background permission polling & real-time notification
  const { data: remoteProfile } = useQuery({
    queryKey: ['admin_permissions_sync', session?.userId, session?.token, apiBaseUrl],
    queryFn: async () => {
      if (!session?.token) return null;
      try {
        const res = await apiFetch(apiBaseUrl, '/users/users_config/me', {
          headers: {
            Authorization: `Bearer ${session.token}`,
            Accept: 'application/json',
          },
        });
        if (res.status === 401) {
          const errBody = await res.json().catch(() => ({}));
          const detail = String(errBody?.detail || errBody?.error || 'Session ended or key revoked on server.');
          if (detail.toLowerCase().includes('expired') || isShiftExpired) {
            // Freeze scanning locally without logging out so the operator can still sync & checkout
            setMonotonicExpired(true);
            return null;
          }
          await handleRemoteRevocationLogout(detail);
          return null;
        }
        if (!res.ok) {
          return null;
        }
        return await res.json();
      } catch {
        return null;
      }
    },
    enabled: Boolean(session?.token && session?.userId && !isShiftExpired),
    refetchInterval: 10000,
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

    if (!prevPermsRef.current) {
      prevPermsRef.current = { ...currentPerms, ...serverPerms };
      return;
    }

    const prev = prevPermsRef.current;
    const added: string[] = [];
    const removed: string[] = [];

    for (const [k, v] of Object.entries(serverPerms)) {
      if (v && !prev[k]) {
        added.push(k);
      }
    }

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
      // Also run delta revocation sync when refreshing permissions
      const wasRevoked = await syncRevocationsDelta();
      if (wasRevoked) {
        return {
          ok: false,
          status: 401,
          error: 'Shift was revoked or checked out on the server.',
        };
      }

      const url = buildApiUrl(apiBaseUrl, '/users/users_config/me');
      const res = await apiFetch(apiBaseUrl, '/users/users_config/me', {
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
        if (String(errMsg).toLowerCase().includes('revoked')) {
          await handleRemoteRevocationLogout(String(errMsg));
        }
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
  }, [session?.token, apiBaseUrl, syncRevocationsDelta, handleRemoteRevocationLogout]);

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

  const isStrictRules = Boolean(
    session &&
    ((session as any).strict_rules !== undefined
      ? Boolean((session as any).strict_rules)
      : (session as any).allow_rule_override !== undefined
      ? !(session as any).allow_rule_override
      : !session.permissions?.['rules.override'] && session.role !== 'admin')
  );
  const canOverrideRules = !isStrictRules;

  const isStrictKey = Boolean(
    session &&
    ((session as any).strict_key !== undefined
      ? Boolean((session as any).strict_key)
      : (session as any).allow_key_override !== undefined
      ? !(session as any).allow_key_override
      : !session.permissions?.['keys.override'] && session.role !== 'admin')
  );
  const strictKeyId = isStrictKey
    ? ((session as any)?.strict_key_id || session?.keyId)
    : undefined;
  const strictKeyKid = isStrictKey
    ? (session as any)?.strict_key_kid
    : undefined;
  const canOverrideKey = !isStrictKey;
  const ruleMatchMode: 'all' | 'any' = (session as any)?.rule_match_mode === 'any' ? 'any' : 'all';

  // TanStack Query: Live background rule polling (every 15s)
  const { data: remoteRules, refetch: refetchRemoteRules } = useQuery({
    queryKey: ['shift_active_rules_sync', session?.shiftId, session?.token, apiBaseUrl],
    queryFn: async () => {
      if (!session?.token) return null;
      try {
        const res = await apiFetch(apiBaseUrl, '/shifts/active/rules', {
          headers: {
            Authorization: `Bearer ${session.token}`,
            Accept: 'application/json',
          },
        });
        if (res.status === 401) {
          const errBody = await res.json().catch(() => ({}));
          const detail = String(errBody?.detail || errBody?.error || 'Shift session ended or signing key revoked.');
          if (detail.toLowerCase().includes('expired') || isShiftExpired) {
            // Freeze scanning locally without logging out so the operator can still sync & checkout
            setMonotonicExpired(true);
            return null;
          }
          await handleRemoteRevocationLogout(detail);
          return null;
        }
        if (!res.ok) return null;
        return (await res.json()) as Array<{
          id: string | number;
          rule_name: string;
          matching_claim_key: string;
          expected_value: string;
          is_active: boolean;
        }>;
      } catch {
        return null;
      }
    },
    enabled: Boolean(session?.token && session?.shiftId && !isShiftExpired),
    refetchInterval: 15000,
    refetchIntervalInBackground: true,
  });

  const prevRulesHashRef = useRef<string>('');

  useEffect(() => {
    if (!remoteRules || !session || !isStrictRules) return;
    const rulesHash = JSON.stringify(remoteRules);
    if (rulesHash === prevRulesHashRef.current) return;
    prevRulesHashRef.current = rulesHash;

    void replaceInventoryRules(
      remoteRules.map((r: any) => ({
        rule_name: r.rule_name,
        matching_claim_key: r.matching_claim_key,
        expected_value: r.expected_value,
      }))
    );
  }, [remoteRules, session?.shiftId, isStrictRules]);

  const refreshActiveRules = useCallback(async () => {
    const res = await refetchRemoteRules();
    if (res.data && isStrictRules) {
      await replaceInventoryRules(
        res.data.map((r: any) => ({
          rule_name: r.rule_name,
          matching_claim_key: r.matching_claim_key,
          expected_value: r.expected_value,
        }))
      );
    }
  }, [refetchRemoteRules, isStrictRules]);

  if (dbSecurityError) {
    throw dbSecurityError;
  }

  return (
    <AuthContext.Provider
      value={{
        session,
        isLoggedIn: Boolean(session),
        isShiftExpired,
        isLoading,
        dbSecurityError,
        apiBaseUrl,
        setApiBaseUrl,
        rootCaCert,
        setRootCaCert,
        isNativeCaAvailable,
        hasPermission,
        updateSessionPermissions,
        refreshPermissions,
        syncRevocationsDelta,
        markOfflineCheckout,
        clearOfflineCheckout,
        login,
        logout,
        isStrictRules,
        isStrictKey,
        strictKeyId,
        strictKeyKid,
        canOverrideRules,
        canOverrideKey,
        ruleMatchMode,
        refreshActiveRules,
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
