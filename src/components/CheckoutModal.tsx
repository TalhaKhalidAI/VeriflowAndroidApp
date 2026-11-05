import {
  Box,
  Button,
  ButtonText,
  HStack,
  Heading,
  Pressable,
  Text,
  VStack,
} from '@gluestack-ui/themed';
import { useMutation } from '@tanstack/react-query';
import { LogOut, UploadCloud, CheckCircle2, AlertTriangle, WifiOff, RefreshCw } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useAuth } from '../core/authContext';
import { getPendingScans, markScansAsSynced, markScansAsFailed, setAppSetting } from '../core/db';
import { buildApiUrl } from '../core/jwt';

const BLACK = '#07111d';
const PANEL = '#0f172a';
const PANEL_ALT = '#111c2e';
const YELLOW = '#facc15';
const MUTED = '#94a3b8';
const FAIL_COLOR = '#ef4444';
const PASS_COLOR = '#22c55e';
const BLUE_ACCENT = '#38bdf8';

interface CheckoutModalProps {
  visible: boolean;
  onClose: () => void;
}

export function CheckoutModal({ visible, onClose }: CheckoutModalProps) {
  const { session, apiBaseUrl, logout, markOfflineCheckout, clearOfflineCheckout } = useAuth();
  const { width } = useWindowDimensions();
  const isSmallScreen = width < 390;
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [offlineDetected, setOfflineDetected] = useState<boolean>(false);
  const [shiftOverNotice, setShiftOverNotice] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setOfflineDetected(false);
      setShiftOverNotice(null);
      void getPendingScans(session?.userId).then(scans => setPendingCount(scans.length));
    }
  }, [visible, session?.userId]);

  // TanStack Query Mutation dedicated to Checkout Data Transfer & Shift Completion
  const checkoutMutation = useMutation({
    mutationKey: ['checkout_sync', session?.shiftId],
    mutationFn: async () => {
      if (!session) throw new Error('No active shift session.');
      if (!session.shiftId) {
        throw new Error('Active session does not have a valid shift ID.');
      }

      setOfflineDetected(false);
      setShiftOverNotice(null);

      // 1. Fetch pending/failed scans for this specific user from SQLite
      const pendingScans = await getPendingScans(session.userId);

      // 2. If there are pending scans, bulk sync to backend
      if (pendingScans.length > 0) {
        const scansData = pendingScans.map(s => {
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

        const syncUrl = buildApiUrl(apiBaseUrl, `/scans/shifts/${session.shiftId}/sync`);
        try {
          const syncRes = await fetch(syncUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.token}`,
            },
            body: JSON.stringify({ scans: scansData }),
          });

          if (!syncRes.ok) {
            const errData = await syncRes.json().catch(() => ({}));
            const msg = errData.error || errData.detail || errData.message || `Scan transfer failed with status ${syncRes.status}`;
            await markScansAsFailed(pendingScans.map(s => s.id), msg);

            // If token was rejected by server (expired, key rotated, or shift already ended)
            if (
              syncRes.status === 401 ||
              msg.toLowerCase().includes('invalid token') ||
              msg.toLowerCase().includes('expired')
            ) {
              setShiftOverNotice(
                'Shift session has already ended or token is no longer active on the server. Local scans saved. Clearing local session...',
              );
              await clearOfflineCheckout();
              return { transferredCount: 0, shiftAlreadyOver: true };
            }

            throw new Error(msg);
          }

          // Mark local scans as synced in SQLite
          await markScansAsSynced(pendingScans.map(s => s.id));
          setPendingCount(0);
        } catch (err: any) {
          if (err.message?.includes('Network') || err.name === 'TypeError') {
            setOfflineDetected(true);
            throw new Error('Network unreachable: Cannot transfer scans while offline.');
          }
          throw err;
        }
      }

      // 3. Checkout Shift via POST /shifts/{shift_id}/checkout
      const checkoutUrl = buildApiUrl(apiBaseUrl, `/shifts/${session.shiftId}/checkout`);
      let checkoutRes: Response | null = null;
      try {
        checkoutRes = await fetch(checkoutUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.token}`,
          },
        });

        if (!checkoutRes.ok) {
          // Fallback to self-service checkout endpoint
          checkoutRes = await fetch(buildApiUrl(apiBaseUrl, '/shifts/checkout'), {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${session.token}`,
            },
          });
        }
      } catch (err: any) {
        setOfflineDetected(true);
        throw new Error('Network unreachable: Cannot reach server to complete shift checkout.');
      }

      if (!checkoutRes.ok) {
        const errData = await checkoutRes.json().catch(() => ({}));
        const msg = String(errData.error || errData.detail || errData.message || '');
        
        // Handle already completed shift, expired token, or invalid/replaced token gracefully
        if (
          msg.toLowerCase().includes('already') ||
          msg.toLowerCase().includes("status is 'completed'") ||
          msg.toLowerCase().includes('completed') ||
          msg.toLowerCase().includes('over') ||
          msg.toLowerCase().includes('invalid token') ||
          msg.toLowerCase().includes('expired') ||
          checkoutRes.status === 401
        ) {
          setShiftOverNotice(
            msg.toLowerCase().includes('invalid token') || checkoutRes.status === 401
              ? 'Shift session has already ended or token is no longer active on the server. Local session cleared.'
              : 'Shift has already ended on the server. Your data transfer has been verified.'
          );
          await clearOfflineCheckout();
          return { transferredCount: pendingScans.length, shiftAlreadyOver: true };
        }

        throw new Error(msg || 'Checkout could not be completed on server.');
      }

      await clearOfflineCheckout();
      return { transferredCount: pendingScans.length, shiftAlreadyOver: false };
    },
    onSuccess: async () => {
      // Immediately log out and close modal to return to QR Login screen
      onClose();
      await logout();
    },
  });

  // Offline checkout: records offline checkout shift ID, skips transfer, removes token, and exits
  const handleOfflineCheckout = async () => {
    if (session?.shiftId) {
      await setAppSetting('offline_checkout_shift_id', session.shiftId);
    }
    onClose();
    await logout();
  };

  const isPending = checkoutMutation.isPending;
  const isSuccess = checkoutMutation.isSuccess;
  const isError = checkoutMutation.isError;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Box
          bg={PANEL}
          borderWidth={2}
          borderColor={YELLOW}
          borderRadius="$2xl"
          p="$5"
          width="100%"
          maxWidth={480}
        >
          <HStack alignItems="center" space="sm" mb="$3">
            <LogOut size={26} color={YELLOW} />
            <Heading color={YELLOW} size="xl" fontWeight="900">
              Shift Checkout
            </Heading>
          </HStack>

          <Text color="#f8fafc" fontSize="$sm" mb="$3">
            Ending shift for operator <Text color={YELLOW} fontWeight="700">{session?.sub}</Text>
          </Text>

          <Box bg={PANEL_ALT} p="$3" borderRadius="$lg" borderWidth={1} borderColor="#334155" mb="$4">
            <HStack justifyContent="space-between" alignItems="center">
              <HStack space="xs" alignItems="center">
                <UploadCloud size={18} color={MUTED} />
                <Text color={MUTED} fontSize="$xs" fontWeight="700">
                  SCAN RECORDS TO TRANSFER:
                </Text>
              </HStack>
              <Text color={pendingCount > 0 ? YELLOW : PASS_COLOR} fontWeight="900" fontSize="$md">
                {pendingCount} pending
              </Text>
            </HStack>
            <Text color={MUTED} fontSize="$xs" mt="$1">
              At checkout, all local scan records are transferred directly to the central database.
            </Text>
          </Box>

          {shiftOverNotice ? (
            <Box bg="rgba(56, 189, 248, 0.15)" borderWidth={1} borderColor={BLUE_ACCENT} borderRadius="$md" p="$3" mb="$3">
              <HStack space="xs" alignItems="center">
                <CheckCircle2 size={16} color={BLUE_ACCENT} />
                <Text color={BLUE_ACCENT} fontSize="$xs" fontWeight="700" flex={1}>
                  {shiftOverNotice}
                </Text>
              </HStack>
            </Box>
          ) : null}

          {isError ? (
            <Box bg="rgba(239, 68, 68, 0.15)" borderWidth={1} borderColor={FAIL_COLOR} borderRadius="$md" p="$3" mb="$3">
              <HStack space="xs" alignItems="center">
                <AlertTriangle size={16} color={FAIL_COLOR} />
                <Text color={FAIL_COLOR} fontSize="$xs" fontWeight="700" flex={1}>
                  {checkoutMutation.error instanceof Error ? checkoutMutation.error.message : 'Checkout failed'}
                </Text>
              </HStack>
            </Box>
          ) : null}

          {offlineDetected ? (
            <Box bg="rgba(234, 179, 8, 0.15)" borderWidth={1} borderColor={YELLOW} borderRadius="$md" p="$3" mb="$3">
              <HStack space="xs" alignItems="flex-start">
                <WifiOff size={18} color={YELLOW} style={{ marginTop: 2 }} />
                <VStack flex={1}>
                  <Text color={YELLOW} fontSize="$xs" fontWeight="800">
                    Offline Mode Detected
                  </Text>
                  <Text color="#cbd5e1" fontSize="$xs" mt="$1">
                    Server is unreachable. You can checkout offline right now: all transfer is skipped, token is cleared, and you will be logged out immediately.
                  </Text>
                  <Button
                    size="xs"
                    bg={YELLOW}
                    mt="$2"
                    onPress={handleOfflineCheckout}
                  >
                    <ButtonText color={BLACK} fontWeight="900">
                      Checkout Offline (Skip Transfer & Remove Token)
                    </ButtonText>
                  </Button>
                </VStack>
              </HStack>
            </Box>
          ) : null}

          {isSuccess ? (
            <Box bg="rgba(34, 197, 94, 0.15)" borderWidth={1} borderColor={PASS_COLOR} borderRadius="$md" p="$3" mb="$3">
              <HStack space="xs" alignItems="center">
                <CheckCircle2 size={18} color={PASS_COLOR} />
                <Text color={PASS_COLOR} fontSize="$xs" fontWeight="800">
                  Scans transferred & checkout verified! Ending session...
                </Text>
              </HStack>
            </Box>
          ) : null}

          {/* Responsive Action Buttons */}
          {isSmallScreen ? (
            <VStack space="xs" mt="$2">
              <HStack space="xs">
                <Button
                  flex={1}
                  variant="outline"
                  borderColor="#64748b"
                  onPress={onClose}
                  isDisabled={isPending || isSuccess}
                  size="sm"
                >
                  <ButtonText color="#cbd5e1" fontSize="$xs">Cancel</ButtonText>
                </Button>

                <Button
                  flex={2}
                  bg={YELLOW}
                  onPress={() => checkoutMutation.mutate()}
                  isDisabled={isPending || isSuccess}
                  size="sm"
                >
                  {isPending ? (
                    <HStack space="xs" alignItems="center">
                      <ActivityIndicator size="small" color={BLACK} />
                      <ButtonText color={BLACK} fontWeight="900" ml="$1" fontSize="$xs">
                        Transferring...
                      </ButtonText>
                    </HStack>
                  ) : (
                    <ButtonText color={BLACK} fontWeight="900" fontSize="$xs">
                      Transfer & Checkout
                    </ButtonText>
                  )}
                </Button>
              </HStack>

              <Button
                variant="outline"
                borderColor="#ef4444"
                onPress={handleOfflineCheckout}
                isDisabled={isPending || isSuccess}
                size="xs"
                mt="$1"
              >
                <HStack space="xs" alignItems="center">
                  <WifiOff size={13} color="#ef4444" />
                  <ButtonText color="#ef4444" fontSize="$2xs">Offline Exit (Skip Transfer)</ButtonText>
                </HStack>
              </Button>
            </VStack>
          ) : (
            <HStack space="sm" justifyContent="space-between" alignItems="center" mt="$2">
              <Button
                variant="outline"
                borderColor="#ef4444"
                onPress={handleOfflineCheckout}
                isDisabled={isPending || isSuccess}
                size="sm"
              >
                <HStack space="xs" alignItems="center">
                  <WifiOff size={14} color="#ef4444" />
                  <ButtonText color="#ef4444" fontSize="$xs">Offline Exit</ButtonText>
                </HStack>
              </Button>

              <HStack space="sm">
                <Button
                  variant="outline"
                  borderColor="#64748b"
                  onPress={onClose}
                  isDisabled={isPending || isSuccess}
                  size="sm"
                >
                  <ButtonText color="#cbd5e1" fontSize="$xs">Cancel</ButtonText>
                </Button>

                <Button
                  bg={YELLOW}
                  onPress={() => checkoutMutation.mutate()}
                  isDisabled={isPending || isSuccess}
                  size="sm"
                >
                  {isPending ? (
                    <HStack space="xs" alignItems="center">
                      <ActivityIndicator size="small" color={BLACK} />
                      <ButtonText color={BLACK} fontWeight="900" ml="$2" fontSize="$xs">
                        Transferring...
                      </ButtonText>
                    </HStack>
                  ) : (
                    <ButtonText color={BLACK} fontWeight="900" fontSize="$xs">
                      Transfer & Checkout
                    </ButtonText>
                  )}
                </Button>
              </HStack>
            </HStack>
          )}
        </Box>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
});
