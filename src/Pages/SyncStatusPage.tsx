import {
  Box,
  Button,
  ButtonText,
  HStack,
  Heading,
  Pressable,
  ScrollView,
  Text,
  VStack,
} from '@gluestack-ui/themed';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  UploadCloud,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Wifi,
  WifiOff,
  Clock,
  Layers,
  ArrowRight,
} from 'lucide-react-native';
import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useAuth } from '../core/authContext';
import {
  getAllScans,
  getPendingScans,
  getFailedScans,
  markScansAsSynced,
  markScansAsFailed,
} from '../core/db';
import { apiFetch } from '../core/jwt';
import { ScanRecord } from '../core/types';

const BLACK = '#07111d';
const PANEL = '#0f172a';
const PANEL_ALT = '#111c2e';
const YELLOW = '#facc15';
const MUTED = '#94a3b8';
const PASS_COLOR = '#22c55e';
const FAIL_COLOR = '#ef4444';
const BLUE_ACCENT = '#38bdf8';

export default function SyncStatusPage() {
  const { session, apiBaseUrl, clearOfflineCheckout } = useAuth();
  const queryClient = useQueryClient();
  const { width } = useWindowDimensions();
  const isCompact = width < 460;
  const isNarrow = width < 380;
  const [filter, setFilter] = useState<'all' | 'failed' | 'pending' | 'synced'>('all');
  const [syncFeedback, setSyncFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // TanStack Query to fetch all scans and compute sync metrics for current user
  const {
    data: scans = [],
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['sync_page_scans', session?.userId],
    queryFn: async () => {
      return await getAllScans(session?.userId);
    },
    refetchInterval: 10000,
  });

  // Online connection probe
  const { data: isOnline = false } = useQuery({
    queryKey: ['server_health_check', apiBaseUrl],
    queryFn: async () => {
      try {
        const res = await apiFetch(apiBaseUrl, '/keys/jwks', { method: 'GET' });
        return res.ok;
      } catch {
        return false;
      }
    },
    refetchInterval: 15000,
  });

  const syncedCount = scans.filter(s => s.sync_status === 'synced').length;
  const pendingCount = scans.filter(s => s.sync_status === 'pending' || !s.sync_status).length;
  const failedCount = scans.filter(s => s.sync_status === 'failed').length;
  const unsyncedTotal = pendingCount + failedCount;

  // TanStack Query Mutation: Resync All Unsynced Scans (Pending + Failed)
  const resyncMutation = useMutation({
    mutationKey: ['resync_scans', session?.userId, session?.shiftId],
    mutationFn: async () => {
      setSyncFeedback(null);
      if (!session) throw new Error('No active user session');
      if (!session.shiftId) throw new Error('No shift ID associated with current session');

      const unsyncedScans = await getPendingScans(session.userId);
      if (unsyncedScans.length === 0) {
        return { count: 0, message: 'All scan records are already synced.' };
      }

      // Format payload for /app/v1/scans/shifts/{shift_id}/sync
      const scansData = unsyncedScans.map(s => {
        let claims: Record<string, any> = {};
        try {
          const parts = s.scanned_jwt.split('.');
          if (parts.length >= 2) {
            const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const jsonStr = decodeURIComponent(
              atob(base64)
                .split('')
                .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
                .join(''),
            );
            claims = JSON.parse(jsonStr);
          }
        } catch {
          claims = { raw_token: s.scanned_jwt };
        }

        return {
          jwt_scanned: claims,
          status: s.status === 'pass' ? 'valid' : 'invalid',
          scanned_at: s.scanned_at || new Date().toISOString(),
          reason: s.notes || (s.status === 'pass' ? 'Verified RS256' : 'Verification failed'),
        };
      });

      const res = await apiFetch(apiBaseUrl, `/scans/shifts/${session.shiftId}/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({ scans: scansData }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const msg = errData.error || errData.detail || errData.message || `Sync failed: HTTP ${res.status}`;
        await markScansAsFailed(unsyncedScans.map(s => s.id), msg);
        throw new Error(msg);
      }

      // Mark locally as synced in SQLite
      await markScansAsSynced(unsyncedScans.map(s => s.id));

      // If offline checkout was pending, checkout the shift now that all data is transferred
      if (session.offlineCheckoutPending) {
        try {
          await apiFetch(apiBaseUrl, `/shifts/${session.shiftId}/checkout`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${session.token}` },
          });
          await clearOfflineCheckout();
        } catch (e) {
          console.warn('Completed scan sync, checkout call deferred:', e);
        }
      }

      return { count: unsyncedScans.length, message: `Successfully synced ${unsyncedScans.length} scans to server.` };
    },
    onSuccess: (result) => {
      setSyncFeedback({ type: 'success', message: result.message });
      void refetch();
      void queryClient.invalidateQueries({ queryKey: ['sync_page_scans'] });
    },
    onError: (err: any) => {
      setSyncFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Resync failed. Please check network connection.',
      });
      void refetch();
    },
  });

  const filteredScans = scans.filter(s => {
    if (filter === 'failed') return s.sync_status === 'failed';
    if (filter === 'pending') return s.sync_status === 'pending' || !s.sync_status;
    if (filter === 'synced') return s.sync_status === 'synced';
    return true;
  });

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <Box width="100%" maxWidth={720} alignSelf="center">
      {/* Header */}
      <HStack justifyContent="space-between" alignItems="center" mb="$4">
        <VStack>
          <Heading color={YELLOW} size="xl" fontWeight="900">
            Sync Center
          </Heading>
          <Text color={MUTED} fontSize="$xs">
            Shift: <Text color="#cbd5e1" fontWeight="700">{session?.shiftId?.slice(0, 8)}...</Text> | Operator: <Text color="#cbd5e1" fontWeight="700">{session?.sub}</Text>
          </Text>
        </VStack>

        {/* Live Connectivity Badge */}
        <Box
          bg={isOnline ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)'}
          borderWidth={1}
          borderColor={isOnline ? PASS_COLOR : FAIL_COLOR}
          px="$3"
          py="$1"
          borderRadius="$full"
        >
          <HStack space="xs" alignItems="center">
            {isOnline ? <Wifi size={14} color={PASS_COLOR} /> : <WifiOff size={14} color={FAIL_COLOR} />}
            <Text
              color={isOnline ? PASS_COLOR : FAIL_COLOR}
              fontSize="$xs"
              fontWeight="900"
            >
              {isOnline ? 'ONLINE' : 'OFFLINE'}
            </Text>
          </HStack>
        </Box>
      </HStack>

      {/* Offline Checkout Notice (Requirement 1) */}
      {session?.offlineCheckoutPending ? (
        <Box
          bg="rgba(234, 179, 8, 0.15)"
          borderWidth={1}
          borderColor={YELLOW}
          borderRadius="$xl"
          p="$4"
          mb="$4"
        >
          <HStack space="sm" alignItems="flex-start">
            <AlertTriangle size={20} color={YELLOW} style={{ marginTop: 2 }} />
            <VStack flex={1}>
              <Text color={YELLOW} fontWeight="900" fontSize="$sm">
                Offline Checkout Recorded
              </Text>
              <Text color="#cbd5e1" fontSize="$xs" mt="$1">
                You ended your shift while offline. All scanned data and tokens remain secured locally.
                Press Resync below when online to push all scans to the server and finalize shift checkout.
              </Text>
            </VStack>
          </HStack>
        </Box>
      ) : null}

      {/* Responsive Metrics Grid (2x2 on mobile, 1x4 on tablet/desktop) */}
      {isCompact ? (
        <VStack space="sm" mb="$4">
          <HStack space="sm">
            {/* Total Scanned */}
            <Box flex={1} bg={PANEL} p="$3" borderRadius="$xl" borderWidth={1} borderColor="#1e293b">
              <HStack justifyContent="space-between" alignItems="center">
                <Text color={MUTED} fontSize="$2xs" fontWeight="700">TOTAL</Text>
                <Layers size={14} color={MUTED} />
              </HStack>
              <Text color="#f8fafc" fontSize="$xl" fontWeight="900" mt="$1">
                {scans.length}
              </Text>
            </Box>

            {/* Synced */}
            <Box flex={1} bg={PANEL} p="$3" borderRadius="$xl" borderWidth={1} borderColor="rgba(34, 197, 94, 0.3)">
              <HStack justifyContent="space-between" alignItems="center">
                <Text color={PASS_COLOR} fontSize="$2xs" fontWeight="700">SYNCED</Text>
                <CheckCircle2 size={14} color={PASS_COLOR} />
              </HStack>
              <Text color={PASS_COLOR} fontSize="$xl" fontWeight="900" mt="$1">
                {syncedCount}
              </Text>
            </Box>
          </HStack>

          <HStack space="sm">
            {/* Pending */}
            <Box flex={1} bg={PANEL} p="$3" borderRadius="$xl" borderWidth={1} borderColor="rgba(250, 204, 21, 0.3)">
              <HStack justifyContent="space-between" alignItems="center">
                <Text color={YELLOW} fontSize="$2xs" fontWeight="700">PENDING</Text>
                <Clock size={14} color={YELLOW} />
              </HStack>
              <Text color={YELLOW} fontSize="$xl" fontWeight="900" mt="$1">
                {pendingCount}
              </Text>
            </Box>

            {/* Failed */}
            <Box flex={1} bg={PANEL} p="$3" borderRadius="$xl" borderWidth={1} borderColor="rgba(239, 68, 68, 0.3)">
              <HStack justifyContent="space-between" alignItems="center">
                <Text color={FAIL_COLOR} fontSize="$2xs" fontWeight="700">FAILED</Text>
                <AlertTriangle size={14} color={FAIL_COLOR} />
              </HStack>
              <Text color={FAIL_COLOR} fontSize="$xl" fontWeight="900" mt="$1">
                {failedCount}
              </Text>
            </Box>
          </HStack>
        </VStack>
      ) : (
        <HStack space="sm" mb="$4">
          {/* Total Scanned */}
          <Box flex={1} bg={PANEL} p="$3" borderRadius="$xl" borderWidth={1} borderColor="#1e293b">
            <HStack justifyContent="space-between" alignItems="center">
              <Text color={MUTED} fontSize="$xs" fontWeight="700">TOTAL</Text>
              <Layers size={14} color={MUTED} />
            </HStack>
            <Text color="#f8fafc" fontSize="$2xl" fontWeight="900" mt="$1">
              {scans.length}
            </Text>
          </Box>

          {/* Synced */}
          <Box flex={1} bg={PANEL} p="$3" borderRadius="$xl" borderWidth={1} borderColor="rgba(34, 197, 94, 0.3)">
            <HStack justifyContent="space-between" alignItems="center">
              <Text color={PASS_COLOR} fontSize="$xs" fontWeight="700">SYNCED</Text>
              <CheckCircle2 size={14} color={PASS_COLOR} />
            </HStack>
            <Text color={PASS_COLOR} fontSize="$2xl" fontWeight="900" mt="$1">
              {syncedCount}
            </Text>
          </Box>

          {/* Pending */}
          <Box flex={1} bg={PANEL} p="$3" borderRadius="$xl" borderWidth={1} borderColor="rgba(250, 204, 21, 0.3)">
            <HStack justifyContent="space-between" alignItems="center">
              <Text color={YELLOW} fontSize="$xs" fontWeight="700">PENDING</Text>
              <Clock size={14} color={YELLOW} />
            </HStack>
            <Text color={YELLOW} fontSize="$2xl" fontWeight="900" mt="$1">
              {pendingCount}
            </Text>
          </Box>

          {/* Failed */}
          <Box flex={1} bg={PANEL} p="$3" borderRadius="$xl" borderWidth={1} borderColor="rgba(239, 68, 68, 0.3)">
            <HStack justifyContent="space-between" alignItems="center">
              <Text color={FAIL_COLOR} fontSize="$xs" fontWeight="700">FAILED</Text>
              <AlertTriangle size={14} color={FAIL_COLOR} />
            </HStack>
            <Text color={FAIL_COLOR} fontSize="$2xl" fontWeight="900" mt="$1">
              {failedCount}
            </Text>
          </Box>
        </HStack>
      )}

      {/* Responsive Resync Action Card */}
      <Box bg={PANEL_ALT} p="$4" borderRadius="$xl" borderWidth={1} borderColor="#334155" mb="$4">
        <View style={{ flexDirection: isNarrow ? 'column' : 'row', justifyContent: 'space-between', alignItems: isNarrow ? 'stretch' : 'center', marginBottom: 12 }}>
          <VStack flex={isNarrow ? undefined : 1} pr={isNarrow ? '$0' : '$3'} mb={isNarrow ? '$3' : '$0'}>
            <Text color="#f8fafc" fontWeight="800" fontSize="$sm">
              Server Sync Dispatcher
            </Text>
            <Text color={MUTED} fontSize="$xs" mt="$0.5">
              {unsyncedTotal > 0
                ? `${unsyncedTotal} scan records are waiting to be transferred to the central server.`
                : 'All scans are up to date with the server.'}
            </Text>
          </VStack>

          <Button
            bg={YELLOW}
            onPress={() => resyncMutation.mutate()}
            isDisabled={resyncMutation.isPending || unsyncedTotal === 0}
            size={isNarrow ? 'sm' : 'md'}
          >
            {resyncMutation.isPending ? (
              <HStack space="xs" alignItems="center">
                <ActivityIndicator size="small" color={BLACK} />
                <ButtonText color={BLACK} fontWeight="900" ml="$2" fontSize="$xs">
                  Syncing...
                </ButtonText>
              </HStack>
            ) : (
              <HStack space="xs" alignItems="center">
                <RefreshCw size={16} color={BLACK} />
                <ButtonText color={BLACK} fontWeight="900" ml="$2" fontSize="$xs">
                  Resync All Data
                </ButtonText>
              </HStack>
            )}
          </Button>
        </View>

        {syncFeedback ? (
          <Box
            bg={syncFeedback.type === 'success' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)'}
            borderWidth={1}
            borderColor={syncFeedback.type === 'success' ? PASS_COLOR : FAIL_COLOR}
            borderRadius="$lg"
            p="$3"
          >
            <HStack space="xs" alignItems="center">
              {syncFeedback.type === 'success' ? (
                <CheckCircle2 size={16} color={PASS_COLOR} />
              ) : (
                <AlertTriangle size={16} color={FAIL_COLOR} />
              )}
              <Text
                color={syncFeedback.type === 'success' ? PASS_COLOR : FAIL_COLOR}
                fontSize="$xs"
                fontWeight="700"
                flex={1}
              >
                {syncFeedback.message}
              </Text>
            </HStack>
          </Box>
        ) : null}
      </Box>

      {/* Filter Tabs */}
      <HStack space="xs" mb="$3">
        {(['all', 'failed', 'pending', 'synced'] as const).map(tab => {
          const active = filter === tab;
          return (
            <Pressable
              key={tab}
              onPress={() => setFilter(tab)}
              style={[styles.filterTab, active && styles.filterTabActive]}
            >
              <Text
                style={[styles.filterTabText, active && styles.filterTabTextActive]}
              >
                {tab.toUpperCase()}
              </Text>
            </Pressable>
          );
        })}
      </HStack>

      {/* Scan Queue Item List */}
      <VStack space="sm" pb="$10">
        {filteredScans.length === 0 ? (
          <Box bg={PANEL} p="$6" borderRadius="$xl" alignItems="center" borderWidth={1} borderColor="#1e293b">
            <Text color={MUTED} fontSize="$sm">
              No scans found matching '{filter}'.
            </Text>
          </Box>
        ) : (
          filteredScans.map(s => {
            const isSynced = s.sync_status === 'synced';
            const isFailed = s.sync_status === 'failed';
            const statusColor = isSynced ? PASS_COLOR : isFailed ? FAIL_COLOR : YELLOW;

            return (
              <Box
                key={s.id}
                bg={PANEL}
                p="$3.5"
                borderRadius="$lg"
                borderWidth={1}
                borderColor="#1e293b"
              >
                <HStack justifyContent="space-between" alignItems="flex-start">
                  <VStack flex={1} mr="$2">
                    <HStack space="xs" alignItems="center" mb="$1">
                      <Box
                        bg={
                          isSynced
                            ? 'rgba(34, 197, 94, 0.12)'
                            : isFailed
                            ? 'rgba(239, 68, 68, 0.12)'
                            : 'rgba(250, 204, 21, 0.12)'
                        }
                        px="$2"
                        py="$0.5"
                        borderRadius="$sm"
                        borderWidth={1}
                        borderColor={statusColor}
                      >
                        <Text color={statusColor} fontSize="$2xs" fontWeight="900">
                          {(s.sync_status || 'PENDING').toUpperCase()}
                        </Text>
                      </Box>
                      <Text color={MUTED} fontSize="$2xs">
                        ID #{s.id} • {s.scanned_at ? new Date(s.scanned_at).toLocaleTimeString() : 'N/A'}
                      </Text>
                    </HStack>

                    <Text
                      color="#f1f5f9"
                      fontSize="$xs"
                      fontFamily="monospace"
                      numberOfLines={1}
                      ellipsizeMode="middle"
                    >
                      {s.scanned_jwt}
                    </Text>

                    {s.notes ? (
                      <Text
                        color={isFailed ? FAIL_COLOR : MUTED}
                        fontSize="$2xs"
                        mt="$1"
                        numberOfLines={2}
                      >
                        {isFailed ? `Error: ${s.notes}` : s.notes}
                      </Text>
                    ) : null}
                  </VStack>

                  <Box
                    bg={s.status === 'pass' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)'}
                    px="$2"
                    py="$1"
                    borderRadius="$md"
                  >
                    <Text
                      color={s.status === 'pass' ? PASS_COLOR : FAIL_COLOR}
                      fontWeight="900"
                      fontSize="$xs"
                    >
                      {s.status.toUpperCase()}
                    </Text>
                  </Box>
                </HStack>
              </Box>
            );
          })
        )}
      </VStack>
          </Box>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BLACK,
  },
  contentContainer: {
    padding: 16,
  },
  filterTab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: PANEL,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  filterTabActive: {
    backgroundColor: PANEL_ALT,
    borderColor: YELLOW,
  },
  filterTabText: {
    color: MUTED,
    fontSize: 11,
    fontWeight: '800',
  },
  filterTabTextActive: {
    color: YELLOW,
  },
});
