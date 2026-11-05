import {
  Box,
  Button,
  ButtonText,
  HStack,
  Heading,
  Input,
  InputField,
  Pressable,
  ScrollView,
  Text,
  VStack,
} from '@gluestack-ui/themed';
import { useRouter } from 'expo-router';
import {
  Check,
  CheckCircle2,
  Clock,
  Cloud,
  CloudOff,
  Copy,
  Eye,
  Filter,
  RefreshCw,
  Search,
  ShieldAlert,
  Tag,
  Trash2,
  X,
  XCircle,
} from 'lucide-react-native';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  Modal,
  StyleSheet,
  View,
} from 'react-native';
import { useAuth } from '../core/authContext';
import { deleteScan, getAllScans, updateScanStatus } from '../core/db';
import { extractJwtHeader, extractJwtPayload } from '../core/jwt';
import { ScanRecord } from '../core/types';

const BLACK = '#07111d';
const PANEL = '#0f172a';
const PANEL_ALT = '#111c2e';
const BORDER = '#1e293b';
const YELLOW = '#facc15';
const MUTED = '#94a3b8';
const PASS_COLOR = '#22c55e';
const FAIL_COLOR = '#ef4444';
const AMBER = '#f59e0b';

type FilterType = 'ALL' | 'PASS' | 'FAIL' | 'PENDING' | 'SYNCED';

export default function HistoryPage() {
  const router = useRouter();
  const { session, hasPermission } = useAuth();
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [selectedScan, setSelectedScan] = useState<ScanRecord | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeFilter, setActiveFilter] = useState<FilterType>('ALL');

  // Modal inspection state
  const [copiedToken, setCopiedToken] = useState<boolean>(false);
  const [copiedPayload, setCopiedPayload] = useState<boolean>(false);
  const [inspectTab, setInspectTab] = useState<'CLAIMS' | 'RAW'>('CLAIMS');

  const canViewAny = hasPermission('scans.view.any') || session?.role === 'admin';
  const canViewOwn = hasPermission('scans.view.own') || hasPermission('scans.view');
  const canView = canViewAny || canViewOwn;
  const canUpdate = hasPermission('scans.update');
  const canDelete = hasPermission('scans.delete');

  const loadData = async () => {
    if (!canView) return;
    try {
      const records = await getAllScans(canViewAny ? undefined : session?.userId);
      setScans(records);
    } catch (e) {
      console.warn('Failed loading scan history:', e);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await loadData();
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [canView, session?.userId]);

  // Decode selected scan details for modal
  const decodedData = useMemo(() => {
    if (!selectedScan?.scanned_jwt) return { payload: null, header: null };
    const payload = extractJwtPayload(selectedScan.scanned_jwt);
    const header = extractJwtHeader(selectedScan.scanned_jwt);
    return { payload, header };
  }, [selectedScan]);

  // Counts for filter badges
  const counts = useMemo(() => {
    const total = scans.length;
    const pass = scans.filter((s: ScanRecord) => s.status === 'pass').length;
    const fail = scans.filter((s: ScanRecord) => s.status === 'fail').length;
    const pending = scans.filter((s: ScanRecord) => s.sync_status === 'pending').length;
    const synced = scans.filter((s: ScanRecord) => s.sync_status === 'synced').length;
    return { total, pass, fail, pending, synced };
  }, [scans]);

  // Filtered & searched scans list
  const filteredScans = useMemo(() => {
    return scans.filter((item: ScanRecord) => {
      // 1. Status Filter
      if (activeFilter === 'PASS' && item.status !== 'pass') return false;
      if (activeFilter === 'FAIL' && item.status !== 'fail') return false;
      if (activeFilter === 'PENDING' && item.sync_status !== 'pending') return false;
      if (activeFilter === 'SYNCED' && item.sync_status !== 'synced') return false;

      // 2. Search query filter
      if (!searchQuery.trim()) return true;
      const q = searchQuery.trim().toLowerCase();

      // Check ID
      if (String(item.id).includes(q)) return true;
      // Check Notes
      if (item.notes && item.notes.toLowerCase().includes(q)) return true;
      // Check status
      if (item.status.toLowerCase().includes(q)) return true;

      // Check decoded payload claims (e.g. sub, product_id, tag_id, serial)
      const payload = extractJwtPayload(item.scanned_jwt);
      if (payload) {
        for (const [k, v] of Object.entries(payload)) {
          if (String(k).toLowerCase().includes(q)) return true;
          if (String(v).toLowerCase().includes(q)) return true;
        }
      }

      // Check raw token snippet
      if (item.scanned_jwt.toLowerCase().includes(q)) return true;

      return false;
    });
  }, [scans, activeFilter, searchQuery]);

  const handleDelete = (item: ScanRecord) => {
    if (!canDelete) {
      Alert.alert(
        'Permission Denied',
        'Your user account lacks "scans.delete" permission. Sync permissions in Settings if an admin updated your role.',
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

  const handleToggleStatus = async (item: ScanRecord) => {
    if (!canUpdate) {
      Alert.alert(
        'Permission Denied',
        'Your user account lacks "scans.update" permission.',
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
        <ShieldAlert size={64} color={FAIL_COLOR} />
        <Heading color={FAIL_COLOR} size="xl" mt="$4" textAlign="center">
          Permission Restricted
        </Heading>
        <Text color={MUTED} textAlign="center" mt="$2" maxWidth={360}>
          Your shift session lacks the required <Text color={YELLOW} fontWeight="700">scans.view</Text> permission to access scan audit logs.
        </Text>
        <Button mt="$4" bg={YELLOW} onPress={handleRefresh}>
          <ButtonText color={BLACK} fontWeight="800">Refresh Permissions</ButtonText>
        </Button>
      </Box>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: BLACK }}>
      <Box px="$4" py="$5">
        <VStack space="md" width="100%" maxWidth={640} alignSelf="center">
          {/* Header */}
          <HStack justifyContent="space-between" alignItems="center">
            <VStack>
              <Heading color={YELLOW} size="xl" fontWeight="900" letterSpacing={0.5}>
                Scan Audit History
              </Heading>
              <Text color={MUTED} fontSize="$xs">
                {canViewAny ? 'All Facility Scans' : `Operator #${session?.userId || 'N/A'}`} · Shift #{session?.shiftId || 'Local'}
              </Text>
            </VStack>

            <Pressable
              onPress={handleRefresh}
              style={styles.iconBtn}
              accessibilityLabel="Refresh scans"
            >
              {isRefreshing ? (
                <ActivityIndicator size="small" color={YELLOW} />
              ) : (
                <RefreshCw size={18} color={YELLOW} />
              )}
            </Pressable>
          </HStack>

          {/* Search Box */}
          <Box bg={PANEL} borderRadius="$lg" borderWidth={1} borderColor={BORDER} px="$3" py="$1">
            <HStack alignItems="center" space="xs">
              <Search size={16} color={MUTED} />
              <Input variant="underlined" borderWidth={0} flex={1}>
                <InputField
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="Search by Product ID, Tag, or Note..."
                  placeholderTextColor="#64748b"
                  color="#f8fafc"
                  fontSize="$sm"
                  py="$2"
                />
              </Input>
              {searchQuery ? (
                <Pressable onPress={() => setSearchQuery('')} p="$1">
                  <X size={16} color={MUTED} />
                </Pressable>
              ) : null}
            </HStack>
          </Box>

          {/* Filter Chips Bar */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <HStack space="xs" py="$1">
              {/* ALL */}
              <Pressable
                onPress={() => setActiveFilter('ALL')}
                style={[
                  styles.filterChip,
                  activeFilter === 'ALL' && styles.filterChipActive,
                ]}
              >
                <HStack space="xs" alignItems="center">
                  <Text
                    fontSize="$xs"
                    fontWeight="800"
                    color={activeFilter === 'ALL' ? BLACK : '#cbd5e1'}
                  >
                    All
                  </Text>
                  <Box
                    bg={activeFilter === 'ALL' ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.08)'}
                    px="$1.5"
                    py="$0.5"
                    borderRadius="$full"
                  >
                    <Text
                      fontSize="$2xs"
                      fontWeight="900"
                      color={activeFilter === 'ALL' ? BLACK : '#94a3b8'}
                    >
                      {counts.total}
                    </Text>
                  </Box>
                </HStack>
              </Pressable>

              {/* PASS */}
              <Pressable
                onPress={() => setActiveFilter('PASS')}
                style={[
                  styles.filterChip,
                  activeFilter === 'PASS' && { backgroundColor: PASS_COLOR, borderColor: PASS_COLOR },
                ]}
              >
                <HStack space="xs" alignItems="center">
                  <CheckCircle2
                    size={13}
                    color={activeFilter === 'PASS' ? BLACK : PASS_COLOR}
                  />
                  <Text
                    fontSize="$xs"
                    fontWeight="800"
                    color={activeFilter === 'PASS' ? BLACK : PASS_COLOR}
                  >
                    Passed
                  </Text>
                  <Box
                    bg={activeFilter === 'PASS' ? 'rgba(0,0,0,0.2)' : 'rgba(34,197,94,0.15)'}
                    px="$1.5"
                    py="$0.5"
                    borderRadius="$full"
                  >
                    <Text
                      fontSize="$2xs"
                      fontWeight="900"
                      color={activeFilter === 'PASS' ? BLACK : PASS_COLOR}
                    >
                      {counts.pass}
                    </Text>
                  </Box>
                </HStack>
              </Pressable>

              {/* FAIL */}
              <Pressable
                onPress={() => setActiveFilter('FAIL')}
                style={[
                  styles.filterChip,
                  activeFilter === 'FAIL' && { backgroundColor: FAIL_COLOR, borderColor: FAIL_COLOR },
                ]}
              >
                <HStack space="xs" alignItems="center">
                  <XCircle
                    size={13}
                    color={activeFilter === 'FAIL' ? '#ffffff' : FAIL_COLOR}
                  />
                  <Text
                    fontSize="$xs"
                    fontWeight="800"
                    color={activeFilter === 'FAIL' ? '#ffffff' : FAIL_COLOR}
                  >
                    Failed
                  </Text>
                  <Box
                    bg={activeFilter === 'FAIL' ? 'rgba(0,0,0,0.25)' : 'rgba(239,68,68,0.15)'}
                    px="$1.5"
                    py="$0.5"
                    borderRadius="$full"
                  >
                    <Text
                      fontSize="$2xs"
                      fontWeight="900"
                      color={activeFilter === 'FAIL' ? '#ffffff' : FAIL_COLOR}
                    >
                      {counts.fail}
                    </Text>
                  </Box>
                </HStack>
              </Pressable>

              {/* PENDING SYNC */}
              <Pressable
                onPress={() => setActiveFilter('PENDING')}
                style={[
                  styles.filterChip,
                  activeFilter === 'PENDING' && { backgroundColor: AMBER, borderColor: AMBER },
                ]}
              >
                <HStack space="xs" alignItems="center">
                  <Clock
                    size={13}
                    color={activeFilter === 'PENDING' ? BLACK : AMBER}
                  />
                  <Text
                    fontSize="$xs"
                    fontWeight="800"
                    color={activeFilter === 'PENDING' ? BLACK : AMBER}
                  >
                    Pending Sync
                  </Text>
                  <Box
                    bg={activeFilter === 'PENDING' ? 'rgba(0,0,0,0.2)' : 'rgba(245,158,11,0.15)'}
                    px="$1.5"
                    py="$0.5"
                    borderRadius="$full"
                  >
                    <Text
                      fontSize="$2xs"
                      fontWeight="900"
                      color={activeFilter === 'PENDING' ? BLACK : AMBER}
                    >
                      {counts.pending}
                    </Text>
                  </Box>
                </HStack>
              </Pressable>

              {/* SYNCED */}
              <Pressable
                onPress={() => setActiveFilter('SYNCED')}
                style={[
                  styles.filterChip,
                  activeFilter === 'SYNCED' && { backgroundColor: '#38bdf8', borderColor: '#38bdf8' },
                ]}
              >
                <HStack space="xs" alignItems="center">
                  <Cloud
                    size={13}
                    color={activeFilter === 'SYNCED' ? BLACK : '#38bdf8'}
                  />
                  <Text
                    fontSize="$xs"
                    fontWeight="800"
                    color={activeFilter === 'SYNCED' ? BLACK : '#38bdf8'}
                  >
                    Synced
                  </Text>
                  <Box
                    bg={activeFilter === 'SYNCED' ? 'rgba(0,0,0,0.2)' : 'rgba(56,189,248,0.15)'}
                    px="$1.5"
                    py="$0.5"
                    borderRadius="$full"
                  >
                    <Text
                      fontSize="$2xs"
                      fontWeight="900"
                      color={activeFilter === 'SYNCED' ? BLACK : '#38bdf8'}
                    >
                      {counts.synced}
                    </Text>
                  </Box>
                </HStack>
              </Pressable>
            </HStack>
          </ScrollView>

          {/* Scans List */}
          <VStack space="sm" mt="$1">
            {filteredScans.length > 0 ? (
              filteredScans.map((item: ScanRecord) => {
                const itemPayload = extractJwtPayload(item.scanned_jwt);
                const tagIdentifier =
                  itemPayload?.sub ||
                  itemPayload?.product_id ||
                  itemPayload?.tag_id ||
                  itemPayload?.serial ||
                  itemPayload?.id ||
                  itemPayload?.batch ||
                  'Signed JWT Item';

                const isPass = item.status === 'pass';
                const isPending = item.sync_status === 'pending';
                const formattedTime = item.scanned_at
                  ? new Date(item.scanned_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                  : 'Recent';

                return (
                  <Box
                    key={item.id}
                    bg={PANEL}
                    borderWidth={1}
                    borderColor={isPass ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.4)'}
                    borderLeftWidth={4}
                    borderLeftColor={isPass ? PASS_COLOR : FAIL_COLOR}
                    borderRadius="$lg"
                    p="$3.5"
                  >
                    {/* Top Row: Status, Scan #, Sync Badge, Actions */}
                    <HStack justifyContent="space-between" alignItems="center" mb="$2">
                      <HStack space="xs" alignItems="center">
                        <Box
                          px="$2"
                          py="$0.5"
                          borderRadius="$sm"
                          bg={isPass ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.18)'}
                          borderWidth={1}
                          borderColor={isPass ? PASS_COLOR : FAIL_COLOR}
                        >
                          <Text
                            color={isPass ? PASS_COLOR : FAIL_COLOR}
                            fontSize="$2xs"
                            fontWeight="900"
                            letterSpacing={0.5}
                          >
                            {isPass ? 'PASS' : 'FAIL'}
                          </Text>
                        </Box>

                        <Text color="#cbd5e1" fontSize="$xs" fontWeight="700">
                          #{item.id}
                        </Text>

                        {/* Sync Status Badge */}
                        <Box
                          px="$2"
                          py="$0.5"
                          borderRadius="$sm"
                          bg={isPending ? 'rgba(245, 158, 11, 0.15)' : 'rgba(56, 189, 248, 0.12)'}
                          borderWidth={1}
                          borderColor={isPending ? AMBER : '#0284c7'}
                        >
                          <HStack space="2xs" alignItems="center">
                            {isPending ? (
                              <Clock size={10} color={AMBER} />
                            ) : (
                              <Cloud size={10} color="#38bdf8" />
                            )}
                            <Text
                              color={isPending ? AMBER : '#38bdf8'}
                              fontSize="$2xs"
                              fontWeight="800"
                            >
                              {isPending ? 'PENDING SYNC' : 'SYNCED'}
                            </Text>
                          </HStack>
                        </Box>
                      </HStack>

                      {/* Right action controls */}
                      <HStack space="xs" alignItems="center">
                        {/* Eye inspect */}
                        <Pressable
                          onPress={() => {
                            setSelectedScan(item);
                            setInspectTab('CLAIMS');
                          }}
                          style={styles.actionBtn}
                          accessibilityLabel="Inspect Scan Details"
                        >
                          <Eye size={15} color={YELLOW} />
                        </Pressable>

                        {/* Toggle Status (Gated) */}
                        {canUpdate ? (
                          <Button
                            size="2xs"
                            variant="outline"
                            borderColor="#334155"
                            px="$2"
                            onPress={() => handleToggleStatus(item)}
                          >
                            <ButtonText color={YELLOW} fontSize="$2xs">
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
                            <Trash2 size={14} color="#f87171" />
                          </Pressable>
                        ) : null}
                      </HStack>
                    </HStack>

                    {/* Middle: Product / Identifier preview */}
                    <Pressable
                      onPress={() => {
                        setSelectedScan(item);
                        setInspectTab('CLAIMS');
                      }}
                    >
                      <Box bg={PANEL_ALT} p="$2.5" borderRadius="$md">
                        <HStack justifyContent="space-between" alignItems="center">
                          <HStack space="xs" alignItems="center" flex={1}>
                            <Tag size={13} color={YELLOW} />
                            <Text
                              color="#f8fafc"
                              fontSize="$sm"
                              fontWeight="800"
                              numberOfLines={1}
                            >
                              {String(tagIdentifier)}
                            </Text>
                          </HStack>
                          <Text color={MUTED} fontSize="$2xs">
                            {formattedTime}
                          </Text>
                        </HStack>

                        {/* Key claims pills */}
                        {itemPayload ? (
                          <HStack space="xs" flexWrap="wrap" mt="$2">
                            {Object.entries(itemPayload)
                              .filter(([k]) => !['iat', 'exp', 'jti', 'nbf', 'sub'].includes(k))
                              .slice(0, 3)
                              .map(([k, v]) => (
                                <Box
                                  key={k}
                                  bg="rgba(255, 255, 255, 0.05)"
                                  px="$1.5"
                                  py="$0.5"
                                  borderRadius="$sm"
                                  mr="$1"
                                  mb="$1"
                                >
                                  <Text color="#cbd5e1" fontSize="$2xs">
                                    <Text color={MUTED} fontWeight="700">{k}: </Text>
                                    {typeof v === 'object' ? '...' : String(v)}
                                  </Text>
                                </Box>
                              ))}
                          </HStack>
                        ) : null}

                        {/* Error / Notes if any */}
                        {item.notes ? (
                          <Text
                            color={isPass ? '#94a3b8' : '#f87171'}
                            fontSize="$2xs"
                            mt="$1.5"
                            numberOfLines={2}
                          >
                            {item.notes}
                          </Text>
                        ) : null}
                      </Box>
                    </Pressable>
                  </Box>
                );
              })
            ) : (
              <Box bg={PANEL} p="$8" borderRadius="$xl" borderWidth={1} borderColor={BORDER} alignItems="center">
                <Text color={MUTED} fontSize="$sm" textAlign="center" mb="$3">
                  {searchQuery || activeFilter !== 'ALL'
                    ? 'No scans match your search or filter.'
                    : 'No QR scans recorded in the local queue yet.'}
                </Text>
                {searchQuery || activeFilter !== 'ALL' ? (
                  <Button
                    size="xs"
                    variant="outline"
                    borderColor={YELLOW}
                    onPress={() => {
                      setSearchQuery('');
                      setActiveFilter('ALL');
                    }}
                  >
                    <ButtonText color={YELLOW} fontSize="$xs">
                      Reset Filters
                    </ButtonText>
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    bg={YELLOW}
                    onPress={() => router.push('/scanner')}
                  >
                    <ButtonText color={BLACK} fontWeight="800">
                      Open Scanner
                    </ButtonText>
                  </Button>
                )}
              </Box>
            )}
          </VStack>
        </VStack>
      </Box>

      {/* ======================================================== */}
      {/* Inspection Modal */}
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
              <VStack flex={1}>
                <HStack space="xs" alignItems="center">
                  <Text color={YELLOW} fontSize="$lg" fontWeight="900">
                    Scan #{selectedScan?.id}
                  </Text>
                  <Box
                    px="$2"
                    py="$0.5"
                    borderRadius="$sm"
                    bg={selectedScan?.status === 'pass' ? '#14532d' : '#7f1d1d'}
                  >
                    <Text
                      color={selectedScan?.status === 'pass' ? PASS_COLOR : FAIL_COLOR}
                      fontSize="$2xs"
                      fontWeight="900"
                    >
                      {selectedScan?.status?.toUpperCase()}
                    </Text>
                  </Box>
                </HStack>
                <Text color={MUTED} fontSize="$xs" mt="$0.5">
                  {selectedScan?.scanned_at
                    ? new Date(selectedScan.scanned_at).toLocaleString()
                    : 'Unknown Time'}{' '}
                  · Sync: {selectedScan?.sync_status?.toUpperCase()}
                </Text>
              </VStack>

              <Pressable
                onPress={() => setSelectedScan(null)}
                p="$1.5"
                borderRadius="$full"
                bg="rgba(255, 255, 255, 0.08)"
              >
                <X size={18} color="#cbd5e1" />
              </Pressable>
            </HStack>

            {/* Note / Verification Reason */}
            {selectedScan?.notes ? (
              <Box bg={PANEL_ALT} p="$2.5" borderRadius="$md" mb="$3" borderWidth={1} borderColor="#334155">
                <Text color={MUTED} fontSize="$xs">
                  <Text color={YELLOW} fontWeight="700">Verification Result: </Text>
                  {selectedScan.notes}
                </Text>
              </Box>
            ) : null}

            {/* Inspection Tabs */}
            <HStack space="xs" mb="$3">
              <Pressable
                flex={1}
                py="$2"
                borderRadius="$md"
                bg={inspectTab === 'CLAIMS' ? YELLOW : 'rgba(255, 255, 255, 0.06)'}
                alignItems="center"
                onPress={() => setInspectTab('CLAIMS')}
              >
                <Text
                  color={inspectTab === 'CLAIMS' ? BLACK : '#cbd5e1'}
                  fontWeight="800"
                  fontSize="$xs"
                >
                  Decoded Claims
                </Text>
              </Pressable>
              <Pressable
                flex={1}
                py="$2"
                borderRadius="$md"
                bg={inspectTab === 'RAW' ? YELLOW : 'rgba(255, 255, 255, 0.06)'}
                alignItems="center"
                onPress={() => setInspectTab('RAW')}
              >
                <Text
                  color={inspectTab === 'RAW' ? BLACK : '#cbd5e1'}
                  fontWeight="800"
                  fontSize="$xs"
                >
                  Raw JWT String
                </Text>
              </Pressable>
            </HStack>

            <ScrollView style={{ maxHeight: 360 }}>
              {inspectTab === 'CLAIMS' ? (
                decodedData.payload ? (
                  <VStack space="sm">
                    {/* Header Details */}
                    {decodedData.header ? (
                      <Box bg={PANEL_ALT} p="$2.5" borderRadius="$md">
                        <Text color={MUTED} fontSize="$xs" fontWeight="800" mb="$1">
                          JWT HEADER:
                        </Text>
                        <Text color="#cbd5e1" fontSize="$xs">
                          Algorithm: <Text color={YELLOW}>{decodedData.header.alg || 'RS256'}</Text>
                          {decodedData.header.kid ? ` · Key ID: ${decodedData.header.kid}` : ''}
                        </Text>
                      </Box>
                    ) : null}

                    {/* Claims list */}
                    <Box bg={PANEL_ALT} p="$3" borderRadius="$md">
                      <Text color={YELLOW} fontSize="$xs" fontWeight="900" mb="$2">
                        PAYLOAD CLAIMS (VERIFIED)
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
                      Could not decode standard JWT claims from this scan payload.
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
                Close Inspector
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
    borderWidth: 1,
    borderColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtn: {
    width: 30,
    height: 30,
    borderRadius: 6,
    backgroundColor: 'rgba(250, 204, 21, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(250, 204, 21, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  trashBtn: {
    width: 30,
    height: 30,
    borderRadius: 6,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    marginRight: 6,
  },
  filterChipActive: {
    backgroundColor: YELLOW,
    borderColor: YELLOW,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
});
