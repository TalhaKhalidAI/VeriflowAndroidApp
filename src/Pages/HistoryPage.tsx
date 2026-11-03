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
import {
  ShieldAlert,
  Trash2,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Eye,
  Copy,
  Check,
  Calendar,
  Layers,
  FileCode,
  Sparkles,
} from 'lucide-react-native';
import React, { useEffect, useState, useMemo } from 'react';
import { ActivityIndicator, Alert, Modal, StyleSheet, View, Clipboard } from 'react-native';
import { useAuth } from '../core/authContext';
import { deleteAllSqliteData, deleteScan, getAllScans, updateScanStatus } from '../core/db';
import { extractJwtHeader, extractJwtPayload } from '../core/jwt';
import { ScanRecord } from '../core/types';

const BLACK = '#07111d';
const PANEL = '#0f172a';
const PANEL_ALT = '#111c2e';
const YELLOW = '#facc15';
const MUTED = '#94a3b8';
const PASS_COLOR = '#22c55e';
const FAIL_COLOR = '#ef4444';

export default function HistoryPage() {
  const { session, hasPermission, refreshPermissions } = useAuth();
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [selectedScan, setSelectedScan] = useState<ScanRecord | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [copiedToken, setCopiedToken] = useState<boolean>(false);
  const [copiedPayload, setCopiedPayload] = useState<boolean>(false);
  const [showRawJwt, setShowRawJwt] = useState<boolean>(false);

  const canViewAny = hasPermission('scans.view.any') || session?.role === 'admin';
  const canViewOwn = hasPermission('scans.view.own') || hasPermission('scans.view');
  const canView = canViewAny || canViewOwn;
  const canUpdate = hasPermission('scans.update');
  const canDelete = hasPermission('scans.delete');
  const canDeleteAllData = hasPermission('user.delete_all_data');

  const loadData = async () => {
    if (!canView) return;
    try {
      const records = await getAllScans(canViewAny ? undefined : session?.userId);
      setScans(records);
    } catch (e) {
      console.warn('Failed loading history:', e);
    }
  };

  const handleRefreshAll = async () => {
    setIsRefreshing(true);
    try {
      await loadData();
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleSyncServerPermissions = async () => {
    setIsRefreshing(true);
    try {
      const ok = await refreshPermissions();
      if (ok) {
        Alert.alert('Permissions Synced', 'Successfully updated permissions from server.');
      } else {
        Alert.alert('Sync Unavailable', 'Server unreachable or offline. Using token permissions.');
      }
      await loadData();
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [canView, session?.userId]);

  // Decode selected scan details
  const decodedData = useMemo(() => {
    if (!selectedScan?.scanned_jwt) return { payload: null, header: null };
    const payload = extractJwtPayload(selectedScan.scanned_jwt);
    const header = extractJwtHeader(selectedScan.scanned_jwt);
    return { payload, header };
  }, [selectedScan]);

  const handleDelete = (item: ScanRecord) => {
    if (!canDelete) {
      Alert.alert(
        'Permission Denied',
        'Your user account currently lacks "scans.delete" permission. Tap "Refresh Permissions" above if an admin recently updated your role.',
      );
      return;
    }
    Alert.alert(
      'Delete Scan Record?',
      `Record #${item.id} will be permanently removed from this device.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteScan(item.id);
            await loadData();
          },
        },
      ],
    );
  };

  const handleDeleteAllData = () => {
    if (!canDeleteAllData) {
      Alert.alert(
        'Permission Denied',
        'Your user account lacks "user.delete_all_data" permission. Tap "Sync from Server" above if an admin recently updated your role.',
      );
      return;
    }
    Alert.alert(
      'Delete All SQLite Data?',
      'This will permanently delete all local scans, inventory rules, and public keys stored in SQLite on this device.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete All Data',
          style: 'destructive',
          onPress: async () => {
            const res = await deleteAllSqliteData();
            await loadData();
            Alert.alert(
              'All SQLite Data Deleted',
              `Removed ${res.deletedScans} scan(s), ${res.deletedRules} rule(s), and ${res.deletedKeys} key(s) from SQLite.`,
            );
          },
        },
      ],
    );
  };

  const handleToggleStatus = async (item: ScanRecord) => {
    if (!canUpdate) {
      Alert.alert(
        'Permission Denied',
        'Your user account currently lacks "scans.update" permission. Tap "Refresh Permissions" above if an admin recently updated your role.',
      );
      return;
    }
    const nextStatus = item.status === 'pass' ? 'fail' : 'pass';
    await updateScanStatus(item.id, nextStatus);
    await loadData();
  };

  const copyToClipboard = (text: string, isToken: boolean) => {
    Clipboard.setString(text);
    if (isToken) {
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 2000);
    } else {
      setCopiedPayload(true);
      setTimeout(() => setCopiedPayload(false), 2000);
    }
  };

  if (!canView) {
    return (
      <Box flex={1} bg={BLACK} p="$6" alignItems="center" justifyContent="center">
        <ShieldAlert size={64} color="#f87171" />
        <Heading color="#f87171" size="xl" mt="$4" textAlign="center">
          Permission Restricted
        </Heading>
        <Text color={MUTED} textAlign="center" mt="$2" maxWidth={360}>
          Your shift session does not have the required <Text color={YELLOW} fontWeight="700">scans.view</Text> permission to access scan history.
        </Text>
        <Button mt="$4" bg={YELLOW} onPress={handleRefreshAll}>
          <ButtonText color={BLACK} fontWeight="800">Refresh Permissions</ButtonText>
        </Button>
      </Box>
    );
  }

  const total = scans.length;
  const passCount = scans.filter(s => s.status === 'pass').length;
  const pendingCount = scans.filter(s => s.sync_status === 'pending').length;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: BLACK }}>
      <Box px="$4" py="$6">
        <VStack space="lg" width="100%" maxWidth={640} alignSelf="center">
          {/* Header */}
          <HStack justifyContent="space-between" alignItems="center">
            <VStack>
              <Heading color={YELLOW} size="2xl" fontWeight="900">
                Scan Audit Log
              </Heading>
              <Text color={MUTED} fontSize="$xs">
                Local verification history & queue · Operator #{session?.userId || 'N/A'}
              </Text>
            </VStack>
            <Pressable
              onPress={handleRefreshAll}
              style={styles.iconBtn}
              accessibilityLabel="Refresh scans and permissions"
            >
              {isRefreshing ? (
                <ActivityIndicator size="small" color={YELLOW} />
              ) : (
                <RefreshCw size={20} color={YELLOW} />
              )}
            </Pressable>
          </HStack>

          {/* Stats Bar */}
          <HStack space="sm">
            <Box flex={1} bg={PANEL} p="$3" borderRadius="$lg" borderWidth={1} borderColor="#334155">
              <Text color={MUTED} fontSize="$xs">TOTAL</Text>
              <Text color="#f8fafc" fontSize="$xl" fontWeight="900">{total}</Text>
            </Box>
            <Box flex={1} bg={PANEL} p="$3" borderRadius="$lg" borderWidth={1} borderColor="#334155">
              <Text color={MUTED} fontSize="$xs">PASSED</Text>
              <Text color={PASS_COLOR} fontSize="$xl" fontWeight="900">{passCount}</Text>
            </Box>
            <Box flex={1} bg={PANEL} p="$3" borderRadius="$lg" borderWidth={1} borderColor="#334155">
              <Text color={MUTED} fontSize="$xs">PENDING SYNC</Text>
              <Text color={YELLOW} fontSize="$xl" fontWeight="900">{pendingCount}</Text>
            </Box>
          </HStack>

          {/* Permissions Status Banner */}
          <Box bg={PANEL_ALT} p="$3" borderRadius="$md" borderWidth={1} borderColor="#334155">
            <HStack justifyContent="space-between" alignItems="center" mb="$2">
              <Text color={MUTED} fontSize="$xs" fontWeight="800">
                SCREEN PERMISSIONS & ROLE:
              </Text>
              <Pressable onPress={handleSyncServerPermissions}>
                <HStack space="xs" alignItems="center">
                  <Sparkles size={12} color={YELLOW} />
                  <Text color={YELLOW} fontSize="$2xs" fontWeight="900">
                    Sync from Server
                  </Text>
                </HStack>
              </Pressable>
            </HStack>

            <HStack space="md" flexWrap="wrap">
              <Text color={canView ? PASS_COLOR : FAIL_COLOR} fontSize="$xs" fontWeight="700">
                • scans.view: {canView ? (canViewAny ? 'GRANTED (ALL)' : `GRANTED (USER #${session?.userId})`) : 'DENIED'}
              </Text>
              <Text color={canUpdate ? PASS_COLOR : FAIL_COLOR} fontSize="$xs" fontWeight="700">
                • scans.update: {canUpdate ? 'GRANTED' : 'DENIED'}
              </Text>
              <Text color={canDelete ? PASS_COLOR : FAIL_COLOR} fontSize="$xs" fontWeight="700">
                • scans.delete: {canDelete ? 'GRANTED' : 'DENIED'}
              </Text>
              <Text color={canDeleteAllData ? PASS_COLOR : FAIL_COLOR} fontSize="$xs" fontWeight="700">
                • user.delete_all_data: {canDeleteAllData ? 'GRANTED' : 'DENIED'}
              </Text>
            </HStack>

            {canDeleteAllData ? (
              <Button
                size="xs"
                bg={FAIL_COLOR}
                borderRadius="$md"
                mt="$3"
                onPress={handleDeleteAllData}
              >
                <HStack space="xs" alignItems="center">
                  <Trash2 size={14} color="#ffffff" />
                  <ButtonText color="#ffffff" fontSize="$xs" fontWeight="900">
                    Delete All SQLite Data
                  </ButtonText>
                </HStack>
              </Button>
            ) : null}
          </Box>

          {/* Scan Items List */}
          <VStack space="sm">
            {scans.length > 0 ? (
              scans.map(item => {
                const itemPayload = extractJwtPayload(item.scanned_jwt);
                const tagIdentifier =
                  itemPayload?.sub ||
                  itemPayload?.product_id ||
                  itemPayload?.tag_id ||
                  itemPayload?.id ||
                  itemPayload?.category ||
                  'Signed JWT Payload';

                return (
                  <Box
                    key={item.id}
                    bg={PANEL}
                    borderWidth={1}
                    borderColor={item.status === 'pass' ? '#166534' : '#991b1b'}
                    borderRadius="$lg"
                    p="$3"
                  >
                    <HStack justifyContent="space-between" alignItems="flex-start">
                      <HStack space="sm" alignItems="center" flex={1}>
                        {item.status === 'pass' ? (
                          <CheckCircle2 size={20} color={PASS_COLOR} />
                        ) : (
                          <XCircle size={20} color={FAIL_COLOR} />
                        )}
                        <VStack flex={1}>
                          <Text color="#f8fafc" fontWeight="800">
                            Scan #{item.id} · {item.status.toUpperCase()}
                          </Text>
                          <Text color={MUTED} fontSize="$xs">
                            {item.scanned_at ? new Date(item.scanned_at).toLocaleTimeString() : 'Recent'} · Sync: {item.sync_status}
                          </Text>
                        </VStack>
                      </HStack>

                      {/* Action buttons */}
                      <HStack space="xs" alignItems="center">
                        {/* Eye View Icon to Inspect Decoded Data */}
                        <Pressable
                          onPress={() => {
                            setShowRawJwt(false);
                            setSelectedScan(item);
                          }}
                          style={styles.eyeBtn}
                          accessibilityLabel="View Decoded Data"
                        >
                          <Eye size={17} color={YELLOW} />
                        </Pressable>

                        {/* Toggle Status (Gated) */}
                        {canUpdate ? (
                          <Button
                            size="xs"
                            variant="outline"
                            borderColor="#475569"
                            onPress={() => handleToggleStatus(item)}
                          >
                            <ButtonText color={YELLOW} fontSize="$xs">
                              Toggle
                            </ButtonText>
                          </Button>
                        ) : null}

                        {/* Delete (Gated) */}
                        {canDelete ? (
                          <Pressable
                            onPress={() => handleDelete(item)}
                            style={styles.trashBtn}
                            accessibilityLabel="Delete Scan"
                          >
                            <Trash2 size={16} color="#f87171" />
                          </Pressable>
                        ) : null}
                      </HStack>
                    </HStack>

                    {/* Decoded Data Preview Card */}
                    <Pressable
                      onPress={() => {
                        setShowRawJwt(false);
                        setSelectedScan(item);
                      }}
                    >
                      <Box bg={PANEL_ALT} p="$3" borderRadius="$md" mt="$2">
                        {itemPayload ? (
                          <VStack space="xs">
                            <HStack justifyContent="space-between" alignItems="center">
                              <Text color={YELLOW} fontSize="$xs" fontWeight="800" numberOfLines={1}>
                                {String(tagIdentifier)}
                              </Text>
                              <HStack space="xs" alignItems="center">
                                <Eye size={12} color={MUTED} />
                                <Text color={MUTED} fontSize="$2xs">Tap to view data</Text>
                              </HStack>
                            </HStack>
                            {/* Key preview claims */}
                            <HStack space="sm" flexWrap="wrap" mt="$1">
                              {Object.entries(itemPayload)
                                .filter(([k]) => !['iat', 'exp', 'jti', 'nbf', 'sub'].includes(k))
                                .slice(0, 3)
                                .map(([k, v]) => (
                                  <Text key={k} color="#cbd5e1" fontSize="$2xs">
                                    <Text color={MUTED}>{k}:</Text> {typeof v === 'object' ? '...' : String(v)}
                                  </Text>
                                ))}
                            </HStack>
                          </VStack>
                        ) : (
                          <Text color={MUTED} fontSize="$xs" numberOfLines={1}>
                            {item.scanned_jwt}
                          </Text>
                        )}
                        {item.notes ? (
                          <Text color="#64748b" fontSize="$2xs" mt="$1" italic>
                            {item.notes}
                          </Text>
                        ) : null}
                      </Box>
                    </Pressable>
                  </Box>
                );
              })
            ) : (
              <Box bg={PANEL} p="$6" borderRadius="$lg" alignItems="center">
                <Text color={MUTED}>No scans recorded in queue yet.</Text>
              </Box>
            )}
          </VStack>
        </VStack>
      </Box>

      {/* ======================================================== */}
      {/* Decoded JWT Internal Data Inspection Modal */}
      {/* ======================================================== */}
      <Modal
        visible={Boolean(selectedScan)}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedScan(null)}
      >
        <View style={styles.modalBackdrop}>
          <Box
            bg={PANEL}
            borderWidth={2}
            borderColor={YELLOW}
            borderRadius="$xl"
            p="$4"
            width="100%"
            maxWidth={540}
            maxHeight="88%"
          >
            {/* Modal Title & Status */}
            <HStack justifyContent="space-between" alignItems="center" mb="$3">
              <VStack>
                <Text color={YELLOW} fontSize="$lg" fontWeight="900">
                  Scan #{selectedScan?.id} Data Inspection
                </Text>
                <Text color={MUTED} fontSize="$xs">
                  {selectedScan?.scanned_at
                    ? new Date(selectedScan.scanned_at).toLocaleString()
                    : 'Unknown Time'}{' '}
                  · Sync: {selectedScan?.sync_status}
                </Text>
              </VStack>

              <Box
                px="$2"
                py="$1"
                borderRadius="$md"
                bg={selectedScan?.status === 'pass' ? '#14532d' : '#7f1d1d'}
              >
                <Text
                  color={selectedScan?.status === 'pass' ? PASS_COLOR : FAIL_COLOR}
                  fontSize="$xs"
                  fontWeight="900"
                >
                  {selectedScan?.status?.toUpperCase()}
                </Text>
              </Box>
            </HStack>

            {/* Note / Verification Reason if present */}
            {selectedScan?.notes ? (
              <Box bg={PANEL_ALT} p="$2" borderRadius="$md" mb="$3" borderWidth={1} borderColor="#334155">
                <Text color={MUTED} fontSize="$xs">
                  <Text color={YELLOW} fontWeight="700">Verification Note: </Text>
                  {selectedScan.notes}
                </Text>
              </Box>
            ) : null}

            {/* Mode Toggle: Decoded Claims vs Raw JWT */}
            <HStack space="xs" mb="$3">
              <Button
                flex={1}
                size="xs"
                variant={!showRawJwt ? 'solid' : 'outline'}
                bg={!showRawJwt ? YELLOW : 'transparent'}
                borderColor={YELLOW}
                onPress={() => setShowRawJwt(false)}
              >
                <ButtonText color={!showRawJwt ? BLACK : YELLOW} fontWeight="800">
                  Decoded Claims
                </ButtonText>
              </Button>
              <Button
                flex={1}
                size="xs"
                variant={showRawJwt ? 'solid' : 'outline'}
                bg={showRawJwt ? YELLOW : 'transparent'}
                borderColor={YELLOW}
                onPress={() => setShowRawJwt(true)}
              >
                <ButtonText color={showRawJwt ? BLACK : YELLOW} fontWeight="800">
                  Raw JWT String
                </ButtonText>
              </Button>
            </HStack>

            <ScrollView style={{ maxHeight: 360 }}>
              {!showRawJwt ? (
                decodedData.payload ? (
                  <VStack space="sm">
                    {/* Key/Value claims list */}
                    <Box bg={PANEL_ALT} p="$3" borderRadius="$md">
                      <Text color={YELLOW} fontSize="$xs" fontWeight="900" mb="$2">
                        PAYLOAD CLAIMS (INTERNAL DATA)
                      </Text>
                      {Object.entries(decodedData.payload).map(([k, v]) => {
                        let displayValue = String(v);
                        let subDetail: string | null = null;

                        if (k === 'exp' && typeof v === 'number') {
                          displayValue = new Date(v * 1000).toLocaleString();
                          const isExpired = v < Math.floor(Date.now() / 1000);
                          subDetail = isExpired ? '(Expired)' : '(Valid)';
                        } else if (k === 'iat' && typeof v === 'number') {
                          displayValue = new Date(v * 1000).toLocaleString();
                        } else if (typeof v === 'object' && v !== null) {
                          displayValue = JSON.stringify(v, null, 2);
                        }

                        return (
                          <Box
                            key={k}
                            py="$2"
                            borderBottomWidth={1}
                            borderBottomColor="#1e293b"
                          >
                            <HStack justifyContent="space-between" alignItems="flex-start">
                              <Text color={MUTED} fontSize="$xs" fontWeight="800" mr="$2">
                                {k}:
                              </Text>
                              <VStack flex={1} alignItems="flex-end">
                                <Text color="#f8fafc" fontSize="$xs" fontWeight="600" selectable>
                                  {displayValue}
                                </Text>
                                {subDetail ? (
                                  <Text
                                    color={subDetail.includes('Expired') ? FAIL_COLOR : PASS_COLOR}
                                    fontSize="$2xs"
                                    fontWeight="700"
                                  >
                                    {subDetail}
                                  </Text>
                                ) : null}
                              </VStack>
                            </HStack>
                          </Box>
                        );
                      })}
                    </Box>

                    {/* Header Details */}
                    {decodedData.header ? (
                      <Box bg={PANEL_ALT} p="$3" borderRadius="$md">
                        <Text color={MUTED} fontSize="$xs" fontWeight="800" mb="$1">
                          JWT HEADER:
                        </Text>
                        <Text color="#cbd5e1" fontSize="$xs">
                          Algorithm: <Text color={YELLOW}>{decodedData.header.alg || 'RS256'}</Text> · Type: {decodedData.header.typ || 'JWT'}
                          {decodedData.header.kid ? ` · Key ID: ${decodedData.header.kid}` : ''}
                        </Text>
                      </Box>
                    ) : null}

                    {/* Copy JSON Button */}
                    <Button
                      size="xs"
                      variant="outline"
                      borderColor="#475569"
                      onPress={() =>
                        copyToClipboard(JSON.stringify(decodedData.payload, null, 2), false)
                      }
                    >
                      <HStack space="xs" alignItems="center">
                        {copiedPayload ? <Check size={14} color={PASS_COLOR} /> : <Copy size={14} color={YELLOW} />}
                        <ButtonText color={YELLOW} fontSize="$xs">
                          {copiedPayload ? 'Copied JSON!' : 'Copy Decoded JSON'}
                        </ButtonText>
                      </HStack>
                    </Button>
                  </VStack>
                ) : (
                  <Box bg={PANEL_ALT} p="$4" borderRadius="$md">
                    <Text color={MUTED} textAlign="center" fontSize="$xs">
                      Could not decode standard JWT claims from this scan.
                    </Text>
                  </Box>
                )
              ) : (
                <VStack space="sm">
                  <Box bg={PANEL_ALT} p="$3" borderRadius="$md">
                    <Text color="#cbd5e1" fontSize="$xs" selectable>
                      {selectedScan?.scanned_jwt}
                    </Text>
                  </Box>
                  <Button
                    size="xs"
                    variant="outline"
                    borderColor="#475569"
                    onPress={() => copyToClipboard(selectedScan?.scanned_jwt || '', true)}
                  >
                    <HStack space="xs" alignItems="center">
                      {copiedToken ? <Check size={14} color={PASS_COLOR} /> : <Copy size={14} color={YELLOW} />}
                      <ButtonText color={YELLOW} fontSize="$xs">
                        {copiedToken ? 'Copied Raw JWT!' : 'Copy Raw JWT'}
                      </ButtonText>
                    </HStack>
                  </Button>
                </VStack>
              )}
            </ScrollView>

            {/* Close Button */}
            <Button mt="$3" bg={YELLOW} onPress={() => setSelectedScan(null)}>
              <ButtonText color={BLACK} fontWeight="900">
                Close
              </ButtonText>
            </Button>
          </Box>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 8,
    backgroundColor: '#111c2e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyeBtn: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: 'rgba(250, 204, 21, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(250, 204, 21, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  trashBtn: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
});
