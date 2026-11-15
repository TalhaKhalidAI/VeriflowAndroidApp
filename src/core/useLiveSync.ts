import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useAuth } from './authContext';
import { upsertPublicKey } from './db';
import { apiFetch } from './jwt';

/**
 * Requirement 4: Live key sync using TanStack Query.
 * - Periodically fetches active public keys (JWKS) from the server.
 * - Token permissions are governed strictly by the cryptographically signed Shift Token.
 */
export function useLiveSync() {
  const { isLoggedIn, apiBaseUrl } = useAuth();

  // Live Public Keys (JWKS) Query using TanStack Query
  const keysQuery = useQuery({
    queryKey: ['live_jwks', apiBaseUrl],
    queryFn: async () => {
      const res = await apiFetch(apiBaseUrl, '/keys/jwks');
      if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
      return res.json();
    },
    enabled: Boolean(isLoggedIn),
    refetchInterval: 60000, // Check every 60s
    retry: false,
  });

  const lastSyncedKeysRef = useRef<string>('');

  useEffect(() => {
    if (keysQuery.data?.keys && Array.isArray(keysQuery.data.keys)) {
      const keysSignature = JSON.stringify(keysQuery.data.keys.map((k: any) => k.kid || k.id));
      if (keysSignature !== lastSyncedKeysRef.current) {
        lastSyncedKeysRef.current = keysSignature;
        for (const k of keysQuery.data.keys) {
          if (k.kid && k.public_key) {
            void upsertPublicKey(k.kid, k.public_key);
          }
        }
      }
    }
  }, [keysQuery.data]);

  return {
    isPermissionsFetching: false,
    isKeysFetching: keysQuery.isFetching,
  };
}
