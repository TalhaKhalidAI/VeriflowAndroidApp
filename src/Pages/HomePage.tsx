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
import { router } from 'expo-router';
import {
  LogOut,
  QrCode,
  History,
  Settings,
  ShieldCheck,
  CheckCircle,
  Database,
  Trash2,
} from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import { Alert, Image, StyleSheet } from 'react-native';
import { CheckoutModal } from '../components/CheckoutModal';
import { useAuth } from '../core/authContext';
import { deleteAllSqliteData, getInventoryItems, getPendingScans } from '../core/db';

const BLACK = '#07111d';
const PANEL = '#0f172a';
const PANEL_ALT = '#111c2e';
const YELLOW = '#facc15';
const MUTED = '#94a3b8';
const PASS_COLOR = '#22c55e';

export default function HomePage() {
  const { session, hasPermission } = useAuth();
  const [checkoutVisible, setCheckoutVisible] = useState(false);
  const [pendingScansCount, setPendingScansCount] = useState(0);
  const [rulesCount, setRulesCount] = useState(0);

  const canScan = hasPermission('scans.create');
  const canViewHistory = hasPermission('scans.view');
  const canDeleteAllData = hasPermission('user.delete_all_data');

  const refreshCounts = () => {
    void getPendingScans().then(s => setPendingScansCount(s.length));
    void getInventoryItems().then(r => setRulesCount(r.length));
  };

  useEffect(() => {
    refreshCounts();
  }, []);

  const handleDeleteAllSqlite = () => {
    if (!canDeleteAllData) {
      Alert.alert('Permission Denied', 'Requires "user.delete_all_data" permission.');
      return;
    }
    Alert.alert(
      'Delete All Local SQLite Data?',
      'This will wipe all scans, inventory rules, and public keys stored locally in SQLite on this device.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete All Data',
          style: 'destructive',
          onPress: async () => {
            const res = await deleteAllSqliteData();
            refreshCounts();
            Alert.alert(
              'All SQLite Data Deleted',
              `Deleted ${res.deletedScans} scan(s), ${res.deletedRules} rule(s), and ${res.deletedKeys} key(s) from SQLite.`,
            );
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: BLACK }}>
      <Box px="$4" py="$6">
        <VStack space="lg" width="100%" maxWidth={540} alignSelf="center">
          {/* Header */}
          <HStack alignItems="center" space="md">
            <Image
              source={require('../assets/msi_white.png')}
              style={{ width: 64, height: 56 }}
              resizeMode="contain"
              accessibilityLabel="VeriFlow logo"
            />
            <VStack space="xs" flex={1}>
              <Heading size="2xl" color={YELLOW} fontWeight="900">
                VeriFlow
              </Heading>
              <Text fontSize="$sm" color={MUTED}>
                Industrial QR Verification & Audit System
              </Text>
            </VStack>
          </HStack>

          {/* Active Operator Shift Card */}
          <Box borderWidth={2} borderColor={YELLOW} borderRadius="$xl" bg={PANEL} p="$4">
            <HStack justifyContent="space-between" alignItems="center" mb="$2">
              <HStack space="xs" alignItems="center">
                <ShieldCheck size={20} color={PASS_COLOR} />
                <Text color={PASS_COLOR} fontSize="$xs" fontWeight="800">
                  ACTIVE SHIFT VERIFIED (RS256)
                </Text>
              </HStack>
              <Text color={YELLOW} fontSize="$xs" fontWeight="700">
                Role: {session?.role || 'user'}
              </Text>
            </HStack>

            <VStack space="xs" mt="$1">
              <Text color="#f8fafc" fontSize="$lg" fontWeight="800" numberOfLines={1}>
                {session?.sub || 'Field Operator'}
              </Text>
              <Text color={MUTED} fontSize="$xs" numberOfLines={1}>
                Shift UUID: {session?.shiftId || 'Unknown'}
              </Text>
              <Text color={MUTED} fontSize="$xs">
                Expires: {session?.exp ? new Date(session.exp * 1000).toLocaleTimeString() : 'N/A'}
              </Text>
            </VStack>

            {/* Shift Permissions Summary */}
            <Box bg={PANEL_ALT} p="$3" borderRadius="$lg" mt="$3" borderWidth={1} borderColor="#334155">
              <Text color={MUTED} fontSize="$xs" fontWeight="700" mb="$1">
                APP PERMISSIONS GRANTED VIA JWT:
              </Text>
              <HStack space="sm" flexWrap="wrap">
                <HStack space="xs" alignItems="center">
                  <CheckCircle size={12} color={canScan ? PASS_COLOR : '#64748b'} />
                  <Text color={canScan ? '#f8fafc' : '#64748b'} fontSize="$xs">
                    scans.create ({canScan ? 'Yes' : 'No'})
                  </Text>
                </HStack>
                <HStack space="xs" alignItems="center">
                  <CheckCircle size={12} color={canViewHistory ? PASS_COLOR : '#64748b'} />
                  <Text color={canViewHistory ? '#f8fafc' : '#64748b'} fontSize="$xs">
                    scans.view ({canViewHistory ? 'Yes' : 'No'})
                  </Text>
                </HStack>
                <HStack space="xs" alignItems="center">
                  <CheckCircle size={12} color={hasPermission('scans.update') ? PASS_COLOR : '#64748b'} />
                  <Text color={hasPermission('scans.update') ? '#f8fafc' : '#64748b'} fontSize="$xs">
                    scans.update ({hasPermission('scans.update') ? 'Yes' : 'No'})
                  </Text>
                </HStack>
                <HStack space="xs" alignItems="center">
                  <CheckCircle size={12} color={hasPermission('scans.delete') ? PASS_COLOR : '#64748b'} />
                  <Text color={hasPermission('scans.delete') ? '#f8fafc' : '#64748b'} fontSize="$xs">
                    scans.delete ({hasPermission('scans.delete') ? 'Yes' : 'No'})
                  </Text>
                </HStack>
                <HStack space="xs" alignItems="center">
                  <CheckCircle size={12} color={canDeleteAllData ? PASS_COLOR : '#64748b'} />
                  <Text color={canDeleteAllData ? '#f8fafc' : '#64748b'} fontSize="$xs">
                    user.delete_all_data ({canDeleteAllData ? 'Yes' : 'No'})
                  </Text>
                </HStack>
              </HStack>
            </Box>
          </Box>

          {/* Quick Stats Grid */}
          <HStack space="sm">
            <Box flex={1} bg={PANEL} p="$3" borderRadius="$lg" borderWidth={1} borderColor="#334155">
              <HStack space="xs" alignItems="center" mb="$1">
                <Database size={16} color={YELLOW} />
                <Text color={MUTED} fontSize="$xs">PENDING SYNC</Text>
              </HStack>
              <Text color={pendingScansCount > 0 ? YELLOW : PASS_COLOR} fontSize="$2xl" fontWeight="900">
                {pendingScansCount}
              </Text>
            </Box>
            <Box flex={1} bg={PANEL} p="$3" borderRadius="$lg" borderWidth={1} borderColor="#334155">
              <HStack space="xs" alignItems="center" mb="$1">
                <Settings size={16} color={YELLOW} />
                <Text color={MUTED} fontSize="$xs">SQLITE RULES</Text>
              </HStack>
              <Text color="#f8fafc" fontSize="$2xl" fontWeight="900">
                {rulesCount}
              </Text>
            </Box>
          </HStack>

          {/* Quick Actions */}
          <VStack space="sm">
            {canScan ? (
              <Button
                size="lg"
                bg={YELLOW}
                borderRadius="$lg"
                onPress={() => router.push('/scanner')}
              >
                <HStack space="sm" alignItems="center">
                  <QrCode size={22} color={BLACK} />
                  <ButtonText color={BLACK} fontWeight="900">
                    Open Scanner
                  </ButtonText>
                </HStack>
              </Button>
            ) : null}

            {canViewHistory ? (
              <Button
                size="lg"
                variant="outline"
                borderColor={YELLOW}
                borderRadius="$lg"
                onPress={() => router.push('/history')}
              >
                <HStack space="sm" alignItems="center">
                  <History size={20} color={YELLOW} />
                  <ButtonText color={YELLOW} fontWeight="800">
                    Scan History & Queue
                  </ButtonText>
                </HStack>
              </Button>
            ) : null}

            <Button
              size="lg"
              variant="outline"
              borderColor="#475569"
              borderRadius="$lg"
              onPress={() => router.push('/settings')}
            >
              <HStack space="sm" alignItems="center">
                <Settings size={20} color="#f8fafc" />
                <ButtonText color="#f8fafc" fontWeight="700">
                  Inventory Rules & Keys
                </ButtonText>
              </HStack>
            </Button>

            {canDeleteAllData ? (
              <Button
                size="lg"
                variant="outline"
                borderColor="#ef4444"
                borderRadius="$lg"
                onPress={handleDeleteAllSqlite}
              >
                <HStack space="sm" alignItems="center">
                  <Trash2 size={20} color="#ef4444" />
                  <ButtonText color="#ef4444" fontWeight="800">
                    Delete All SQLite Data
                  </ButtonText>
                </HStack>
              </Button>
            ) : null}

            {/* Checkout Action Button */}
            <Button
              size="lg"
              bg="#dc2626"
              borderRadius="$lg"
              mt="$2"
              onPress={() => setCheckoutVisible(true)}
            >
              <HStack space="sm" alignItems="center">
                <LogOut size={22} color="#ffffff" />
                <ButtonText color="#ffffff" fontWeight="900">
                  Check Out & Transfer Data
                </ButtonText>
              </HStack>
            </Button>
          </VStack>
        </VStack>
      </Box>

      {/* TanStack Query Checkout Modal */}
      <CheckoutModal
        visible={checkoutVisible}
        onClose={() => setCheckoutVisible(false)}
      />
    </ScrollView>
  );
}
