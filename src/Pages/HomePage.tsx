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
import { router, useFocusEffect } from 'expo-router';
import {
  CheckCircle2,
  History,
  Key,
  LogOut,
  QrCode,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UploadCloud,
  Wifi,
  WifiOff,
  XCircle,
} from 'lucide-react-native';
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';
import { CheckoutModal } from '../components/CheckoutModal';
import { useAuth } from '../core/authContext';
import { DailyScanStats, getDailyScanStats, getInventoryItems } from '../core/db';

const BLACK = '#07111d';
const PANEL = '#0f172a';
const PANEL_ALT = '#111c2e';
const YELLOW = '#facc15';
const MUTED = '#94a3b8';
const PASS_COLOR = '#22c55e';
const FAIL_COLOR = '#ef4444';

export default function HomePage() {
  const { session, hasPermission } = useAuth();
  const [checkoutVisible, setCheckoutVisible] = useState(false);
  const [stats, setStats] = useState<DailyScanStats>({
    total: 0,
    passCount: 0,
    failCount: 0,
    pendingSyncCount: 0,
    syncedCount: 0,
  });
  const [rulesCount, setRulesCount] = useState<number>(0);
  const [isLoadingStats, setIsLoadingStats] = useState<boolean>(true);

  const canScan = hasPermission('scans.create');
  const canViewHistory = hasPermission('scans.view');

  const refreshData = useCallback(async () => {
    try {
      const [dailyStats, rules] = await Promise.all([
        getDailyScanStats(session?.userId, session?.shiftId),
        getInventoryItems(),
      ]);
      setStats(dailyStats);
      setRulesCount(rules.length);
    } catch (e) {
      console.warn('Failed refreshing dashboard stats:', e);
    } finally {
      setIsLoadingStats(false);
    }
  }, [session?.userId, session?.shiftId]);

  useFocusEffect(
    useCallback(() => {
      void refreshData();
    }, [refreshData]),
  );

  const expiresTime = session?.exp
    ? new Date(session.exp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'N/A';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <VStack space="md" width="100%" maxWidth={540} alignSelf="center">
        {/* Brand Header */}
        <HStack alignItems="center" justifyContent="space-between" mb="$1">
          <HStack alignItems="center" space="sm">
            <Image
              source={require('../assets/msi_white.png')}
              style={styles.logo}
              resizeMode="contain"
              accessibilityLabel="VeriFlow logo"
            />
            <VStack>
              <HStack space="xs" alignItems="center">
                <Heading size="xl" color={YELLOW} fontWeight="900" letterSpacing={0.5}>
                  VeriFlow
                </Heading>
                <Box bg="rgba(250, 204, 21, 0.15)" px="$1.5" py="$0.5" borderRadius="$xs">
                  <Text color={YELLOW} fontSize="$2xs" fontWeight="900">
                    PRO
                  </Text>
                </Box>
              </HStack>
              <Text fontSize="$2xs" color={MUTED} fontWeight="700">
                INDUSTRIAL VERIFICATION ENGINE
              </Text>
            </VStack>
          </HStack>

          {/* Quick Network Status Pill */}
          <Box
            bg={session?.offlineCheckoutPending ? 'rgba(239, 68, 68, 0.15)' : 'rgba(34, 197, 94, 0.15)'}
            borderWidth={1}
            borderColor={session?.offlineCheckoutPending ? FAIL_COLOR : PASS_COLOR}
            px="$2"
            py="$1"
            borderRadius="$full"
          >
            <HStack space="xs" alignItems="center">
              {session?.offlineCheckoutPending ? (
                <>
                  <WifiOff size={11} color={FAIL_COLOR} />
                  <Text color={FAIL_COLOR} fontSize="$2xs" fontWeight="800">
                    OFFLINE
                  </Text>
                </>
              ) : (
                <>
                  <View style={styles.pulsingDot} />
                  <Text color={PASS_COLOR} fontSize="$2xs" fontWeight="800">
                    ONLINE
                  </Text>
                </>
              )}
            </HStack>
          </Box>
        </HStack>

        {/* 1. HERO ACTION: START SCANNING (Requirement 1 - Priority #1) */}
        {canScan ? (
          <Pressable
            style={({ pressed }) => [
              styles.heroScanCard,
              pressed && { opacity: 0.9, transform: [{ scale: 0.99 }] },
            ]}
            onPress={() => router.push('/scanner')}
          >
            <HStack space="md" alignItems="center" justifyContent="space-between">
              <HStack space="md" alignItems="center" flex={1}>
                <View style={styles.scanIconWrapper}>
                  <QrCode size={30} color={BLACK} strokeWidth={2.5} />
                </View>
                <VStack flex={1}>
                  <Heading size="md" color={BLACK} fontWeight="900" letterSpacing={0.5}>
                    START QR SCANNER
                  </Heading>
                  <Text color="#0f172a" fontSize="$xs" fontWeight="700" numberOfLines={1}>
                    Fast RS256 tag verification & claim checks
                  </Text>
                </VStack>
              </HStack>
              <View style={styles.actionArrow}>
                <Text color={BLACK} fontSize="$lg" fontWeight="900">
                  →
                </Text>
              </View>
            </HStack>
          </Pressable>
        ) : (
          <Box bg={PANEL} p="$4" borderRadius="$xl" borderWidth={1} borderColor="#ef4444">
            <Text color="#ef4444" fontSize="$xs" fontWeight="800">
              Camera Scanner Disabled
            </Text>
            <Text color={MUTED} fontSize="$2xs" mt="$1">
              Your shift token lacks &quot;scans.create&quot; permission.
            </Text>
          </Box>
        )}

        {/* 2. OPERATOR & SHIFT CONSOLE CARD */}
        <Box bg={PANEL} borderWidth={1.5} borderColor="#1e293b" borderRadius="$xl" p="$4">
          <HStack justifyContent="space-between" alignItems="center" mb="$2">
            <HStack space="xs" alignItems="center">
              <ShieldCheck size={18} color={PASS_COLOR} />
              <Text color="#f8fafc" fontSize="$xs" fontWeight="800">
                ACTIVE OPERATOR SHIFT
              </Text>
            </HStack>
            <Box bg="rgba(250, 204, 21, 0.15)" px="$2" py="$0.5" borderRadius="$sm">
              <Text color={YELLOW} fontSize="$2xs" fontWeight="900">
                ROLE: {(session?.role || 'operator').toUpperCase()}
              </Text>
            </Box>
          </HStack>

          <HStack justifyContent="space-between" alignItems="flex-end" pt="$1">
            <VStack space="2xs" flex={1}>
              <Text color="#f8fafc" fontSize="$lg" fontWeight="900" numberOfLines={1}>
                {session?.sub || 'Field Operator'}
              </Text>
              <Text color={MUTED} fontSize="$xs" fontFamily="monospace">
                Shift: #{session?.shiftId ? session.shiftId.slice(0, 8) : 'ACTIVE'}
              </Text>
            </VStack>
            <VStack alignItems="flex-end" space="2xs">
              <Text color={MUTED} fontSize="$2xs" fontWeight="700">
                SHIFT EXPIRES
              </Text>
              <Text color={YELLOW} fontSize="$xs" fontWeight="900" fontFamily="monospace">
                {expiresTime}
              </Text>
            </VStack>
          </HStack>
        </Box>

        {/* 3. SHIFT / DAILY SCAN STATISTICS (Requirement 1) */}
        <VStack space="xs">
          <Text color={MUTED} fontSize="$2xs" fontWeight="800" textTransform="uppercase" letterSpacing={1}>
            Today&apos;s Verification Summary
          </Text>

          <HStack space="xs">
            {/* Stat: PASS */}
            <Box flex={1} bg={PANEL} p="$3" borderRadius="$lg" borderWidth={1} borderColor="#1e293b">
              <HStack space="2xs" alignItems="center" mb="$1">
                <CheckCircle2 size={14} color={PASS_COLOR} />
                <Text color={MUTED} fontSize="$2xs" fontWeight="700">
                  PASS
                </Text>
              </HStack>
              {isLoadingStats ? (
                <ActivityIndicator size="small" color={PASS_COLOR} />
              ) : (
                <Text color={PASS_COLOR} fontSize="$xl" fontWeight="900">
                  {stats.passCount}
                </Text>
              )}
            </Box>

            {/* Stat: FAIL */}
            <Box flex={1} bg={PANEL} p="$3" borderRadius="$lg" borderWidth={1} borderColor="#1e293b">
              <HStack space="2xs" alignItems="center" mb="$1">
                <XCircle size={14} color={FAIL_COLOR} />
                <Text color={MUTED} fontSize="$2xs" fontWeight="700">
                  FAIL
                </Text>
              </HStack>
              {isLoadingStats ? (
                <ActivityIndicator size="small" color={FAIL_COLOR} />
              ) : (
                <Text color={stats.failCount > 0 ? FAIL_COLOR : MUTED} fontSize="$xl" fontWeight="900">
                  {stats.failCount}
                </Text>
              )}
            </Box>

            {/* Stat: PENDING SYNC */}
            <Box
              flex={1}
              bg={PANEL}
              p="$3"
              borderRadius="$lg"
              borderWidth={1}
              borderColor={stats.pendingSyncCount > 0 ? YELLOW : '#1e293b'}
            >
              <HStack space="2xs" alignItems="center" mb="$1">
                <UploadCloud size={14} color={stats.pendingSyncCount > 0 ? YELLOW : MUTED} />
                <Text color={MUTED} fontSize="$2xs" fontWeight="700">
                  PENDING
                </Text>
              </HStack>
              {isLoadingStats ? (
                <ActivityIndicator size="small" color={YELLOW} />
              ) : (
                <Text
                  color={stats.pendingSyncCount > 0 ? YELLOW : PASS_COLOR}
                  fontSize="$xl"
                  fontWeight="900"
                >
                  {stats.pendingSyncCount}
                </Text>
              )}
            </Box>
          </HStack>
        </VStack>

        {/* 4. OPERATIONAL SHORTCUTS */}
        <VStack space="xs" pt="$1">
          <Text color={MUTED} fontSize="$2xs" fontWeight="800" textTransform="uppercase" letterSpacing={1}>
            Quick Management
          </Text>

          <HStack space="xs">
            {canViewHistory ? (
              <Button
                flex={1}
                size="md"
                variant="outline"
                borderColor="#334155"
                bg={PANEL_ALT}
                borderRadius="$md"
                onPress={() => router.push('/history')}
              >
                <HStack space="xs" alignItems="center">
                  <History size={16} color={YELLOW} />
                  <ButtonText color="#f8fafc" fontSize="$xs" fontWeight="800">
                    Scan History
                  </ButtonText>
                </HStack>
              </Button>
            ) : null}

            <Button
              flex={1}
              size="md"
              variant="outline"
              borderColor="#334155"
              bg={PANEL_ALT}
              borderRadius="$md"
              onPress={() => router.push('/settings')}
            >
              <HStack space="xs" alignItems="center">
                <Settings size={16} color="#cbd5e1" />
                <ButtonText color="#cbd5e1" fontSize="$xs" fontWeight="800">
                  Settings & Keys
                </ButtonText>
              </HStack>
            </Button>
          </HStack>
        </VStack>

        {/* 5. CHECKOUT BUTTON (End Shift & Transfer Scans) */}
        <Box pt="$2">
          <Button
            size="lg"
            variant="outline"
            borderColor="#ef4444"
            bg="rgba(239, 68, 68, 0.08)"
            borderRadius="$lg"
            onPress={() => setCheckoutVisible(true)}
          >
            <HStack space="xs" alignItems="center">
              <LogOut size={18} color="#ef4444" />
              <ButtonText color="#ef4444" fontSize="$sm" fontWeight="900">
                Check Out Shift & Sync Scans
              </ButtonText>
            </HStack>
          </Button>
        </Box>
      </VStack>

      {/* Checkout Modal */}
      <CheckoutModal visible={checkoutVisible} onClose={() => setCheckoutVisible(false)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BLACK,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 36,
  },
  logo: {
    width: 44,
    height: 44,
  },
  pulsingDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: PASS_COLOR,
  },
  heroScanCard: {
    backgroundColor: YELLOW,
    borderRadius: 16,
    padding: 18,
    shadowColor: YELLOW,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 4,
  },
  scanIconWrapper: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionArrow: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
