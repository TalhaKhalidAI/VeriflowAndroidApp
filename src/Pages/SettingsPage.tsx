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
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useFocusEffect } from 'expo-router';
import {
  ChevronDown,
  ChevronUp,
  DownloadCloud,
  Flashlight,
  FlashlightOff,
  Globe,
  Key,
  Lock,
  Pencil,
  Plus,
  QrCode,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Trash2,
} from 'lucide-react-native';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import { PublicKeyModal } from '../components/PublicKeyModal';
import { RootCaModal } from '../components/RootCaModal';
import { useAuth } from '../core/authContext';
import {
  addInventoryItem,
  addPublicKey,
  deleteAllSqliteData,
  deleteInventoryItem,
  deletePublicKey,
  getInventoryItems,
  getPublicKeys,
  updateInventoryItem,
  updatePublicKey,
} from '../core/db';
import {
  buildApiUrl,
  normalizeApiBaseUrl,
  normalizePublicKey,
  parsePublicKeyPayload,
  parseRootCaPayload,
} from '../core/jwt';
import { InventoryRecord, PublicKeyRecord } from '../core/types';

const BLACK = '#07111d';
const PANEL = '#0f172a';
const PANEL_ALT = '#111c2e';
const BORDER = '#1e293b';
const YELLOW = '#facc15';
const MUTED = '#94a3b8';
const PASS_COLOR = '#22c55e';
const FAIL_COLOR = '#ef4444';

type SettingsTab = 'RULES' | 'KEYS' | 'NETWORK';

export default function SettingsPage() {
  const {
    session,
    hasPermission,
    refreshPermissions,
    apiBaseUrl,
    setApiBaseUrl,
    rootCaCert,
    setRootCaCert,
  } = useAuth();

  // Active Tab
  const [activeTab, setActiveTab] = useState<SettingsTab>('KEYS');

  // Permission gates
  const canViewRules = hasPermission('inventory_rules.view');
  const canCreateRules = hasPermission('inventory_rules.create');
  const canUpdateRules = hasPermission('inventory_rules.update');
  const canDeleteRules = hasPermission('inventory_rules.delete');

  const canViewKeys = hasPermission('keys.view');
  const canCreateKeys = hasPermission('keys.create');
  const canUpdateKeys = hasPermission('keys.update');
  const canDeleteKeys = hasPermission('keys.delete') || hasPermission('keys.revoke');
  const canDeleteAllData = hasPermission('user.delete_all_data');

  // Public Keys state
  const [publicKeys, setPublicKeys] = useState<PublicKeyRecord[]>([]);
  const [keyName, setKeyName] = useState('');
  const [keyValue, setKeyValue] = useState('');
  const [showManualKeyForm, setShowManualKeyForm] = useState(false);
  const [editingKey, setEditingKey] = useState<PublicKeyRecord | null>(null);
  const [editKeyName, setEditKeyName] = useState('');
  const [editKeyValue, setEditKeyValue] = useState('');
  const [isFetchingServerKeys, setIsFetchingServerKeys] = useState(false);

  // Key QR Scanner state
  const [permission, requestPermission] = useCameraPermissions();
  const [keyQrScannerVisible, setKeyQrScannerVisible] = useState(false);
  const [isKeyScannerTorchOn, setIsKeyScannerTorchOn] = useState(false);
  const [keyScanLock, setKeyScanLock] = useState(false);
  const [scannedKeyFormat, setScannedKeyFormat] = useState<string | null>(null);
  const [publicKeyModalVisible, setPublicKeyModalVisible] = useState(false);

  // Inventory Rules state
  const [rules, setRules] = useState<InventoryRecord[]>([]);
  const [ruleName, setRuleName] = useState('');
  const [ruleKey, setRuleKey] = useState('');
  const [ruleValue, setRuleValue] = useState('');
  const [showAddRuleForm, setShowAddRuleForm] = useState(false);
  const [editingRule, setEditingRule] = useState<InventoryRecord | null>(null);
  const [editRuleName, setEditRuleName] = useState('');
  const [editRuleKey, setEditRuleKey] = useState('');
  const [editRuleValue, setEditRuleValue] = useState('');

  // Network & Root CA state
  const [serverUrl, setServerUrl] = useState(apiBaseUrl);
  const [rootCaInput, setRootCaInput] = useState(rootCaCert);
  const [caQrScannerVisible, setCaQrScannerVisible] = useState(false);
  const [rootCaModalVisible, setRootCaModalVisible] = useState(false);
  const [caScanLock, setCaScanLock] = useState(false);
  const [scannedCaFormat, setScannedCaFormat] = useState<string | null>(null);

  useEffect(() => {
    setServerUrl(apiBaseUrl);
  }, [apiBaseUrl]);

  useEffect(() => {
    setRootCaInput(rootCaCert);
  }, [rootCaCert]);

  const refresh = async () => {
    try {
      if (canViewKeys) {
        const k = await getPublicKeys();
        setPublicKeys(k);
      }
      if (canViewRules) {
        const r = await getInventoryItems();
        setRules(r);
      }
    } catch (e) {
      console.warn('Failed refreshing settings:', e);
    }
  };

  useEffect(() => {
    void refresh();
  }, [canViewKeys, canViewRules]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
      return () => {
        setKeyQrScannerVisible(false);
        setCaQrScannerVisible(false);
        setIsKeyScannerTorchOn(false);
        setKeyScanLock(false);
        setCaScanLock(false);
      };
    }, [canViewKeys, canViewRules]),
  );

  const handleRootCaQrScanned = ({ data }: { data: string }) => {
    if (caScanLock) return;
    setCaScanLock(true);
    setCaQrScannerVisible(false);
    setIsKeyScannerTorchOn(false);
    try {
      const parsed = parseRootCaPayload(data);
      setRootCaInput(parsed.pem);
      setScannedCaFormat(parsed.detectedFormat);
    } catch {
      setRootCaInput(data);
      setScannedCaFormat('Raw scan — needs review');
    }
    setRootCaModalVisible(true);
    setCaScanLock(false);
  };

  // ---------------- PUBLIC KEY ACTIONS ----------------
  const saveKey = async () => {
    if (!canCreateKeys) {
      Alert.alert('Permission Denied', 'Your token lacks "keys.create" permission.');
      return;
    }
    if (!keyName.trim()) {
      Alert.alert('Key Alias Required', 'Please enter a Key Alias (name) before adding the key.');
      return;
    }
    if (!keyValue.trim()) {
      Alert.alert('Missing Key Certificate', 'Please paste or scan a Public Key (JSON, Base64, or PEM).');
      return;
    }
    try {
      const parsed = parsePublicKeyPayload(keyValue, keyName.trim());
      await addPublicKey(keyName.trim(), parsed.pem);
      setKeyName('');
      setKeyValue('');
      setScannedKeyFormat(null);
      setShowManualKeyForm(false);
      await refresh();
      Alert.alert('Saved to Keystore', `Public key "${keyName.trim()}" added to local SQLite keystore.`);
    } catch (err: any) {
      Alert.alert('Invalid Public Key', err.message || 'Key parsing failed');
    }
  };

  const handleKeyQrScanned = async ({ data }: { data: string }) => {
    if (keyScanLock) return;
    setKeyScanLock(true);
    try {
      const parsed = parsePublicKeyPayload(data, keyName);
      setKeyValue(parsed.pem);
      if (!keyName.trim() || parsed.detectedFormat === 'JSON Bundle') {
        setKeyName(parsed.suggestedName);
      }
      setScannedKeyFormat(parsed.detectedFormat);
      setKeyQrScannerVisible(false);
      setIsKeyScannerTorchOn(false);
      setPublicKeyModalVisible(true);
    } catch (err: any) {
      Alert.alert(
        'Invalid Key QR',
        err.message || 'Scanned QR is not a valid Public Key (JSON, Base64, or PEM).',
        [
          { text: 'Scan Again', onPress: () => setKeyScanLock(false) },
          {
            text: 'Close',
            style: 'cancel',
            onPress: () => {
              setKeyQrScannerVisible(false);
              setKeyScanLock(false);
            },
          },
        ],
      );
      return;
    }
    setKeyScanLock(false);
  };

  const saveEditKey = async () => {
    if (!canUpdateKeys) {
      Alert.alert('Permission Denied', 'Your token lacks "keys.update" permission.');
      return;
    }
    if (!editingKey || !editKeyName.trim() || !editKeyValue.trim()) return;
    try {
      const normalized = normalizePublicKey(editKeyValue);
      await updatePublicKey(editingKey.id, editKeyName.trim(), normalized);
      setEditingKey(null);
      await refresh();
      Alert.alert('Updated', 'Public key updated successfully.');
    } catch (err: any) {
      Alert.alert('Invalid PEM', err.message || 'Key parsing failed');
    }
  };

  const confirmDeleteKey = (item: PublicKeyRecord) => {
    if (!canDeleteKeys) {
      Alert.alert('Permission Denied', 'Your token lacks "keys.delete" permission.');
      return;
    }
    Alert.alert('Delete Public Key?', `"${item.name}" will be removed from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deletePublicKey(item.id);
          await refresh();
        },
      },
    ]);
  };

  const fetchServerKeys = async () => {
    if (!canCreateKeys) {
      Alert.alert('Permission Denied', 'Importing keys requires "keys.create" permission.');
      return;
    }

    setIsFetchingServerKeys(true);
    const targetJwksUrl = buildApiUrl(apiBaseUrl, '/keys/jwks');
    try {
      const res = await fetch(targetJwksUrl, {
        headers: { Accept: 'application/json' },
      }).catch(() => null);

      if (res && res.ok) {
        const jwks = await res.json();
        const keys = jwks.keys || [];
        if (keys.length === 0) {
          Alert.alert('No Keys Found', 'Server returned 0 active keys in JWKS.');
        } else {
          let addedCount = 0;
          for (const k of keys) {
            const pem =
              k.public_key ||
              (k.x5c && k.x5c[0]
                ? `-----BEGIN PUBLIC KEY-----\n${k.x5c[0]}\n-----END PUBLIC KEY-----`
                : null);

            if (pem) {
              const keyAlias = `Server Key ${k.kid || k.id || ''}`;
              await addPublicKey(keyAlias, pem);
              addedCount++;
            }
          }
          await refresh();
          Alert.alert('Import Complete', `Successfully imported ${addedCount} public key(s) from server.`);
        }
      } else {
        Alert.alert('Connection Failed', `Could not reach ${targetJwksUrl}`);
      }
    } catch (err: any) {
      Alert.alert('Fetch Error', err.message || 'Could not fetch public keys from server.');
    } finally {
      setIsFetchingServerKeys(false);
    }
  };

  // ---------------- INVENTORY RULE ACTIONS ----------------
  const saveRule = async () => {
    if (!canCreateRules) {
      Alert.alert('Permission Denied', 'Your token lacks "inventory_rules.create" permission.');
      return;
    }
    if (!ruleName.trim() || !ruleKey.trim() || !ruleValue.trim()) {
      Alert.alert('Missing Fields', 'Please specify Rule Name, Claim Key, and Expected Value.');
      return;
    }
    await addInventoryItem(ruleName.trim(), ruleKey.trim(), ruleValue.trim());
    setRuleName('');
    setRuleKey('');
    setRuleValue('');
    setShowAddRuleForm(false);
    await refresh();
  };

  const saveEditRule = async () => {
    if (!canUpdateRules) {
      Alert.alert('Permission Denied', 'Your token lacks "inventory_rules.update" permission.');
      return;
    }
    if (!editingRule || !editRuleName.trim() || !editRuleKey.trim() || !editRuleValue.trim()) return;
    await updateInventoryItem(
      editingRule.id,
      editRuleName.trim(),
      editRuleKey.trim(),
      editRuleValue.trim(),
    );
    setEditingRule(null);
    await refresh();
  };

  const confirmDeleteRule = (item: InventoryRecord) => {
    if (!canDeleteRules) {
      Alert.alert('Permission Denied', 'Your token lacks "inventory_rules.delete" permission.');
      return;
    }
    Alert.alert('Delete Rule?', `Rule "${item.inventory_name}" will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteInventoryItem(item.id);
          await refresh();
        },
      },
    ]);
  };

  // ---------------- WIPE ALL SQLITE DATA ACTION ----------------
  const confirmDeleteAllData = () => {
    if (!canDeleteAllData) {
      Alert.alert(
        'Permission Denied',
        'Your user account lacks "user.delete_all_data" permission.',
      );
      return;
    }

    Alert.alert(
      'Delete All Local SQLite Data?',
      'This will permanently wipe all local scans, inventory rules, and public keys stored in SQLite on this Android device. Active login session and Server URL will remain intact.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete All Data',
          style: 'destructive',
          onPress: async () => {
            try {
              const res = await deleteAllSqliteData();
              setPublicKeys([]);
              setRules([]);
              await refresh();
              Alert.alert(
                'All SQLite Data Deleted',
                `Wiped ${res.deletedScans} scan(s), ${res.deletedRules} rule(s), and ${res.deletedKeys} key(s) from local SQLite database.`,
              );
            } catch (err: any) {
              Alert.alert('Delete Failed', err.message || 'Could not clear local SQLite database.');
            }
          },
        },
      ],
    );
  };

  const isHttps = serverUrl.trim().toLowerCase().startsWith('https://');

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: BLACK }}
    >
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 24 }}>
        <VStack space="lg" width="100%" maxWidth={580} alignSelf="center">
          {/* Header */}
          <VStack space="2xs">
            <Heading color="#f8fafc" size="xl" fontWeight="900" letterSpacing={0.5}>
              Settings
            </Heading>
            <Text color={MUTED} fontSize="$xs">
              Manage verification rules, keystore, and server configuration.
            </Text>
          </VStack>

          {/* Navigation Tabs (Compact Responsive Segmented Control) */}
          <HStack space="xs" bg={PANEL_ALT} p="$1" borderRadius="$lg" borderWidth={1} borderColor={BORDER}>
            <Pressable
              flex={1}
              py="$2"
              borderRadius="$md"
              bg={activeTab === 'RULES' ? YELLOW : 'transparent'}
              alignItems="center"
              onPress={() => setActiveTab('RULES')}
            >
              <HStack space="2xs" alignItems="center">
                <Sliders size={14} color={activeTab === 'RULES' ? BLACK : MUTED} />
                <Text
                  color={activeTab === 'RULES' ? BLACK : MUTED}
                  fontWeight="800"
                  fontSize="$xs"
                  numberOfLines={1}
                >
                  Inventory Rules
                </Text>
              </HStack>
            </Pressable>

            <Pressable
              flex={1}
              py="$2"
              borderRadius="$md"
              bg={activeTab === 'KEYS' ? YELLOW : 'transparent'}
              alignItems="center"
              onPress={() => setActiveTab('KEYS')}
            >
              <HStack space="2xs" alignItems="center">
                <Key size={14} color={activeTab === 'KEYS' ? BLACK : MUTED} />
                <Text
                  color={activeTab === 'KEYS' ? BLACK : MUTED}
                  fontWeight="800"
                  fontSize="$xs"
                  numberOfLines={1}
                >
                  Public Keys
                </Text>
              </HStack>
            </Pressable>

            <Pressable
              flex={1}
              py="$2"
              borderRadius="$md"
              bg={activeTab === 'NETWORK' ? YELLOW : 'transparent'}
              alignItems="center"
              onPress={() => setActiveTab('NETWORK')}
            >
              <HStack space="2xs" alignItems="center">
                <Globe size={14} color={activeTab === 'NETWORK' ? BLACK : MUTED} />
                <Text
                  color={activeTab === 'NETWORK' ? BLACK : MUTED}
                  fontWeight="800"
                  fontSize="$xs"
                  numberOfLines={1}
                >
                  Server API
                </Text>
              </HStack>
            </Pressable>
          </HStack>

          {/* ======================================================== */}
          {/* TAB 1: INVENTORY RULES */}
          {/* ======================================================== */}
          {activeTab === 'RULES' && (
            !canViewRules ? (
              <Box bg={PANEL} p="$6" borderRadius="$xl" borderWidth={1} borderColor={FAIL_COLOR} alignItems="center">
                <ShieldAlert size={44} color={FAIL_COLOR} />
                <Heading color={FAIL_COLOR} size="sm" mt="$3">
                  Permission Denied
                </Heading>
                <Text color={MUTED} fontSize="$xs" textAlign="center" mt="$1">
                  Your token does not have &quot;inventory_rules.view&quot; permission.
                </Text>
              </Box>
            ) : (
              <Box borderRadius="$xl" bg={PANEL} borderWidth={1} borderColor={BORDER} p="$4">
                <HStack justifyContent="space-between" alignItems="center" mb="$1">
                  <VStack flex={1}>
                    <Text color="#f8fafc" fontSize="$md" fontWeight="800">
                      Inventory Rules ({rules.length})
                    </Text>
                    <Text color={MUTED} fontSize="$2xs">
                      Applied during QR scan to check payload claims.
                    </Text>
                  </VStack>

                  {/* Compact permission badge */}
                  <Box
                    bg={canCreateRules ? 'rgba(34, 197, 94, 0.12)' : 'rgba(148, 163, 184, 0.1)'}
                    px="$2"
                    py="$0.5"
                    borderRadius="$full"
                    borderWidth={1}
                    borderColor={canCreateRules ? 'rgba(34, 197, 94, 0.3)' : '#334155'}
                  >
                    <Text
                      color={canCreateRules ? PASS_COLOR : MUTED}
                      fontSize="$2xs"
                      fontWeight="900"
                    >
                      {canCreateRules && canUpdateRules && canDeleteRules
                        ? 'FULL CRUD'
                        : canCreateRules
                        ? 'CREATE'
                        : 'READ ONLY'}
                    </Text>
                  </Box>
                </HStack>

                {/* Add Rule Toggle / Form */}
                {canCreateRules ? (
                  <VStack space="xs" mt="$3" mb="$2">
                    <Button
                      size="xs"
                      variant="outline"
                      borderColor={YELLOW}
                      bg="rgba(250, 204, 21, 0.08)"
                      onPress={() => setShowAddRuleForm((prev: boolean) => !prev)}
                    >
                      <HStack space="xs" alignItems="center">
                        <Plus size={14} color={YELLOW} />
                        <ButtonText color={YELLOW} fontSize="$xs" fontWeight="800">
                          {showAddRuleForm ? 'Hide Rule Form' : '+ Add Inventory Rule'}
                        </ButtonText>
                      </HStack>
                    </Button>

                    {showAddRuleForm && (
                      <Box bg={PANEL_ALT} p="$3" borderRadius="$lg" borderWidth={1} borderColor="#334155" mt="$2">
                        <VStack space="xs">
                          <Input variant="outline" size="sm" borderColor="#334155">
                            <InputField
                              value={ruleName}
                              onChangeText={setRuleName}
                              placeholder="Rule Name (e.g. Batch Verification)"
                              placeholderTextColor="#64748b"
                              color="#f8fafc"
                            />
                          </Input>
                          <HStack space="xs">
                            <Input variant="outline" size="sm" borderColor="#334155" flex={1}>
                              <InputField
                                value={ruleKey}
                                onChangeText={setRuleKey}
                                placeholder="Claim key (e.g. batch_no)"
                                placeholderTextColor="#64748b"
                                color="#f8fafc"
                              />
                            </Input>
                            <Input variant="outline" size="sm" borderColor="#334155" flex={1}>
                              <InputField
                                value={ruleValue}
                                onChangeText={setRuleValue}
                                placeholder="Expected value"
                                placeholderTextColor="#64748b"
                                color="#f8fafc"
                              />
                            </Input>
                          </HStack>

                          <Button bg={YELLOW} borderRadius="$md" mt="$1.5" onPress={saveRule}>
                            <ButtonText color={BLACK} fontWeight="900" fontSize="$xs">
                              Save Rule
                            </ButtonText>
                          </Button>
                        </VStack>
                      </Box>
                    )}
                  </VStack>
                ) : null}

                {/* Rules List */}
                <VStack space="xs" mt="$2">
                  {rules.length > 0 ? (
                    rules.map((r: InventoryRecord) => (
                      <HStack
                        key={r.id}
                        justifyContent="space-between"
                        alignItems="center"
                        borderTopWidth={1}
                        borderTopColor="#1e293b"
                        py="$2.5"
                      >
                        <VStack flex={1} mr="$2">
                          <Text color="#f8fafc" fontWeight="700" fontSize="$sm">
                            {r.inventory_name}
                          </Text>
                          <Text color={MUTED} fontSize="$2xs">
                            Match: <Text color={YELLOW}>{r.matching_claim_key}</Text> == &quot;{r.expected_value}&quot;
                          </Text>
                        </VStack>

                        <HStack space="xs">
                          {canUpdateRules ? (
                            <Pressable
                              onPress={() => {
                                setEditingRule(r);
                                setEditRuleName(r.inventory_name);
                                setEditRuleKey(r.matching_claim_key);
                                setEditRuleValue(r.expected_value);
                              }}
                              style={styles.actionBtn}
                            >
                              <Pencil size={15} color={YELLOW} />
                            </Pressable>
                          ) : null}

                          {canDeleteRules ? (
                            <Pressable onPress={() => confirmDeleteRule(r)} style={styles.actionBtn}>
                              <Trash2 size={15} color={FAIL_COLOR} />
                            </Pressable>
                          ) : null}
                        </HStack>
                      </HStack>
                    ))
                  ) : (
                    <Text color={MUTED} fontSize="$xs" py="$4" textAlign="center">
                      No inventory rules stored in SQLite.
                    </Text>
                  )}
                </VStack>
              </Box>
            )
          )}

          {/* ======================================================== */}
          {/* TAB 2: PUBLIC KEYS */}
          {/* ======================================================== */}
          {activeTab === 'KEYS' && (
            !canViewKeys ? (
              <Box bg={PANEL} p="$6" borderRadius="$xl" borderWidth={1} borderColor={FAIL_COLOR} alignItems="center">
                <ShieldAlert size={44} color={FAIL_COLOR} />
                <Heading color={FAIL_COLOR} size="sm" mt="$3">
                  Permission Denied
                </Heading>
                <Text color={MUTED} fontSize="$xs" textAlign="center" mt="$1">
                  Your token does not have &quot;keys.view&quot; permission.
                </Text>
              </Box>
            ) : (
              <Box borderRadius="$xl" bg={PANEL} borderWidth={1} borderColor={BORDER} p="$4">
                {/* Header & Permission Status */}
                <HStack justifyContent="space-between" alignItems="center" mb="$2">
                  <VStack flex={1}>
                    <Text color="#f8fafc" fontSize="$md" fontWeight="800">
                      Public Keys ({publicKeys.length})
                    </Text>
                    <Text color={MUTED} fontSize="$2xs">
                      RSA verification keys used to verify token signatures.
                    </Text>
                  </VStack>

                  <Box
                    bg={canCreateKeys ? 'rgba(34, 197, 94, 0.12)' : 'rgba(148, 163, 184, 0.1)'}
                    px="$2"
                    py="$0.5"
                    borderRadius="$full"
                    borderWidth={1}
                    borderColor={canCreateKeys ? 'rgba(34, 197, 94, 0.3)' : '#334155'}
                  >
                    <Text
                      color={canCreateKeys ? PASS_COLOR : MUTED}
                      fontSize="$2xs"
                      fontWeight="900"
                    >
                      {canCreateKeys && canUpdateKeys && canDeleteKeys
                        ? 'FULL ACCESS'
                        : canCreateKeys
                        ? 'CREATE ONLY'
                        : 'READ ONLY'}
                    </Text>
                  </Box>
                </HStack>

                {/* Key Management Actions */}
                {canCreateKeys ? (
                  <VStack space="xs" mb="$3">
                    {/* Primary Action: Fetch Keys from Server API */}
                    <Button
                      bg={YELLOW}
                      borderRadius="$md"
                      h={46}
                      onPress={fetchServerKeys}
                      isDisabled={isFetchingServerKeys}
                    >
                      {isFetchingServerKeys ? (
                        <HStack space="xs" alignItems="center">
                          <ActivityIndicator size="small" color={BLACK} />
                          <ButtonText color={BLACK} fontWeight="900" ml="$2">
                            Fetching Server Keys...
                          </ButtonText>
                        </HStack>
                      ) : (
                        <HStack space="xs" alignItems="center">
                          <DownloadCloud size={16} color={BLACK} />
                          <ButtonText color={BLACK} fontWeight="900">
                            Fetch Public Keys from API
                          </ButtonText>
                        </HStack>
                      )}
                    </Button>

                    {/* Secondary Actions: Scan QR & Import Modal */}
                    <HStack space="xs" mt="$1">
                      <Button
                        flex={1}
                        variant="outline"
                        borderColor={keyQrScannerVisible ? YELLOW : '#334155'}
                        bg={keyQrScannerVisible ? 'rgba(250, 204, 21, 0.15)' : PANEL_ALT}
                        h={42}
                        onPress={() => {
                          setKeyScanLock(false);
                          setIsKeyScannerTorchOn(false);
                          setKeyQrScannerVisible((prev: boolean) => !prev);
                        }}
                      >
                        <HStack space="xs" alignItems="center">
                          <QrCode size={14} color={keyQrScannerVisible ? YELLOW : '#cbd5e1'} />
                          <ButtonText color={keyQrScannerVisible ? YELLOW : '#cbd5e1'} fontSize="$xs" fontWeight="700">
                            {keyQrScannerVisible ? 'Close Camera' : 'Scan Key QR'}
                          </ButtonText>
                        </HStack>
                      </Button>

                      <Button
                        flex={1}
                        variant="outline"
                        borderColor="#334155"
                        bg={PANEL_ALT}
                        h={42}
                        onPress={() => setPublicKeyModalVisible(true)}
                      >
                        <HStack space="xs" alignItems="center">
                          <Key size={14} color={YELLOW} />
                          <ButtonText color="#cbd5e1" fontSize="$xs" fontWeight="700">
                            Import / Review
                          </ButtonText>
                        </HStack>
                      </Button>
                    </HStack>

                    {/* Inline QR Camera Viewport */}
                    {keyQrScannerVisible && (
                      <Box
                        bg={PANEL_ALT}
                        borderWidth={1}
                        borderColor={YELLOW}
                        borderRadius="$lg"
                        p="$3"
                        mt="$2"
                      >
                        <Text color={MUTED} fontSize="$2xs" mb="$2" textAlign="center">
                          Scan Public Key QR (<Text color={YELLOW}>Clean Base64</Text>, <Text color={YELLOW}>JSON</Text>, or <Text color={YELLOW}>PEM</Text>)
                        </Text>

                        <View
                          style={[
                            styles.cameraContainer,
                            { height: 230 }
                          ]}
                        >
                          {permission?.granted ? (
                            <CameraView
                              style={StyleSheet.absoluteFill}
                              facing="back"
                              enableTorch={isKeyScannerTorchOn}
                              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                              onBarcodeScanned={keyScanLock ? undefined : handleKeyQrScanned}
                            />
                          ) : (
                            <VStack flex={1} alignItems="center" justifyContent="center" px="$4">
                              <Text color="#f8fafc" fontSize="$xs" fontWeight="800" textAlign="center">
                                Camera permission required to scan keys.
                              </Text>
                              <Button mt="$3" bg={YELLOW} size="xs" onPress={() => requestPermission()}>
                                <ButtonText color={BLACK} fontWeight="800">
                                  Grant Permission
                                </ButtonText>
                              </Button>
                            </VStack>
                          )}

                          {permission?.granted && (
                            <Pressable
                              position="absolute"
                              top={8}
                              right={8}
                              zIndex={10}
                              onPress={() => setIsKeyScannerTorchOn((prev: boolean) => !prev)}
                              bg={isKeyScannerTorchOn ? YELLOW : 'rgba(5, 9, 20, 0.75)'}
                              p="$1.5"
                              borderRadius="$md"
                            >
                              {isKeyScannerTorchOn ? (
                                <Flashlight size={16} color={BLACK} />
                              ) : (
                                <FlashlightOff size={16} color="#f8fafc" />
                              )}
                            </Pressable>
                          )}

                          <View style={styles.reticleOverlay} pointerEvents="none">
                            <View style={styles.reticleBox}>
                              <View style={[styles.corner, styles.cornerTL]} />
                              <View style={[styles.corner, styles.cornerTR]} />
                              <View style={[styles.corner, styles.cornerBL]} />
                              <View style={[styles.corner, styles.cornerBR]} />
                            </View>
                          </View>
                        </View>
                      </Box>
                    )}

                    {/* Manual Key Entry Collapsible Accordion */}
                    <Pressable
                      onPress={() => setShowManualKeyForm((prev: boolean) => !prev)}
                      style={styles.expandToggle}
                    >
                      <HStack justifyContent="space-between" alignItems="center">
                        <Text color={MUTED} fontSize="$2xs" fontWeight="700">
                          {showManualKeyForm ? 'Hide Manual Entry Form' : '+ Add Key Manually (JSON / Base64 / PEM)'}
                        </Text>
                        {showManualKeyForm ? (
                          <ChevronUp size={14} color={MUTED} />
                        ) : (
                          <ChevronDown size={14} color={MUTED} />
                        )}
                      </HStack>
                    </Pressable>

                    {showManualKeyForm && (
                      <Box bg={PANEL_ALT} p="$3" borderRadius="$lg" borderWidth={1} borderColor="#334155" mt="$1">
                        <VStack space="xs">
                          <Input variant="outline" size="sm" borderColor="#334155">
                            <InputField
                              value={keyName}
                              onChangeText={setKeyName}
                              placeholder="Key Alias (e.g. Master Verification Key) *"
                              placeholderTextColor="#64748b"
                              color="#f8fafc"
                            />
                          </Input>
                          <Input variant="outline" size="sm" borderColor="#334155">
                            <InputField
                              value={keyValue}
                              onChangeText={setKeyValue}
                              placeholder="Paste Clean Base64, Standard PEM, or JSON..."
                              placeholderTextColor="#64748b"
                              color="#f8fafc"
                              multiline
                              numberOfLines={4}
                              minHeight={80}
                            />
                          </Input>
                          <Button bg={YELLOW} borderRadius="$md" mt="$1" onPress={saveKey}>
                            <ButtonText color={BLACK} fontWeight="900" fontSize="$xs">
                              + Save Key to Keystore
                            </ButtonText>
                          </Button>
                        </VStack>
                      </Box>
                    )}
                  </VStack>
                ) : (
                  <Box bg="rgba(148, 163, 184, 0.08)" p="$3" borderRadius="$md" mb="$3" borderWidth={1} borderColor="#334155">
                    <HStack space="xs" alignItems="center">
                      <Lock size={14} color={MUTED} />
                      <Text color={MUTED} fontSize="$xs">
                        Key creation and API fetch disabled. Requires &quot;keys.create&quot; permission.
                      </Text>
                    </HStack>
                  </Box>
                )}

                {/* Public Keys List */}
                <VStack space="xs" mt="$1">
                  {publicKeys.length > 0 ? (
                    publicKeys.map((k: PublicKeyRecord) => (
                      <Box
                        key={k.id}
                        bg={PANEL_ALT}
                        p="$3"
                        borderRadius="$lg"
                        borderWidth={1}
                        borderColor="#1e293b"
                        mb="$1"
                      >
                        <HStack justifyContent="space-between" alignItems="center">
                          <VStack flex={1} mr="$2">
                            <HStack space="xs" alignItems="center">
                              <Text color="#f8fafc" fontWeight="800" fontSize="$sm">
                                {k.name}
                              </Text>
                              <Box bg="rgba(255, 255, 255, 0.06)" px="$1.5" py="$0.5" borderRadius="$sm">
                                <Text color={MUTED} fontSize="$2xs" fontWeight="700">
                                  #{k.id}
                                </Text>
                              </Box>
                            </HStack>
                            <Text color="#64748b" fontSize="$2xs" mt="$1" numberOfLines={1}>
                              {k.public_key_string.slice(0, 42)}...
                            </Text>
                          </VStack>

                          <HStack space="xs">
                            {canUpdateKeys ? (
                              <Pressable
                                onPress={() => {
                                  setEditingKey(k);
                                  setEditKeyName(k.name);
                                  setEditKeyValue(k.public_key_string);
                                }}
                                style={styles.actionBtn}
                              >
                                <Pencil size={15} color={YELLOW} />
                              </Pressable>
                            ) : null}

                            {canDeleteKeys ? (
                              <Pressable onPress={() => confirmDeleteKey(k)} style={styles.actionBtn}>
                                <Trash2 size={15} color={FAIL_COLOR} />
                              </Pressable>
                            ) : null}
                          </HStack>
                        </HStack>
                      </Box>
                    ))
                  ) : (
                    <Text color={MUTED} fontSize="$xs" py="$4" textAlign="center">
                      No public keys saved in SQLite yet.
                    </Text>
                  )}
                </VStack>
              </Box>
            )
          )}

          {/* ======================================================== */}
          {/* TAB 3: SERVER API & HTTPS ROOT CA */}
          {/* ======================================================== */}
          {activeTab === 'NETWORK' && (
            <Box borderRadius="$xl" bg={PANEL} borderWidth={1} borderColor={BORDER} p="$4">
              {/* Header */}
              <HStack justifyContent="space-between" alignItems="center" mb="$2">
                <VStack flex={1}>
                  <Text color="#f8fafc" fontSize="$md" fontWeight="800">
                    Server API &amp; HTTPS Root CA
                  </Text>
                  <Text color={MUTED} fontSize="$2xs">
                    Configure the backend endpoint and trusted certificate.
                  </Text>
                </VStack>

                <Box
                  bg={isHttps ? 'rgba(34, 197, 94, 0.12)' : 'rgba(250, 204, 21, 0.12)'}
                  px="$2"
                  py="$0.5"
                  borderRadius="$full"
                  borderWidth={1}
                  borderColor={isHttps ? 'rgba(34, 197, 94, 0.3)' : 'rgba(250, 204, 21, 0.3)'}
                >
                  <Text
                    color={isHttps ? PASS_COLOR : YELLOW}
                    fontSize="$2xs"
                    fontWeight="900"
                  >
                    {isHttps ? 'HTTPS TLS' : 'HTTP'}
                  </Text>
                </Box>
              </HStack>

              {/* Protocol Selector (HTTPS | HTTP) */}
              <VStack space="xs" mb="$3">
                <Text color={MUTED} fontSize="$2xs" fontWeight="700">
                  PROTOCOL:
                </Text>
                <HStack space="xs">
                  <Pressable
                    flex={1}
                    py="$2"
                    borderRadius="$md"
                    bg={isHttps ? 'rgba(34, 197, 94, 0.15)' : PANEL_ALT}
                    borderWidth={1}
                    borderColor={isHttps ? PASS_COLOR : '#334155'}
                    alignItems="center"
                    onPress={() => {
                      const stripped = serverUrl.trim().replace(/^https?:\/\//i, '');
                      setServerUrl(`https://${stripped}`);
                    }}
                  >
                    <HStack space="2xs" alignItems="center">
                      <ShieldCheck size={14} color={isHttps ? PASS_COLOR : MUTED} />
                      <Text
                        color={isHttps ? PASS_COLOR : MUTED}
                        fontWeight="800"
                        fontSize="$xs"
                      >
                        Secure HTTPS
                      </Text>
                    </HStack>
                  </Pressable>

                  <Pressable
                    flex={1}
                    py="$2"
                    borderRadius="$md"
                    bg={!isHttps ? 'rgba(250, 204, 21, 0.12)' : PANEL_ALT}
                    borderWidth={1}
                    borderColor={!isHttps ? YELLOW : '#334155'}
                    alignItems="center"
                    onPress={() => {
                      const stripped = serverUrl.trim().replace(/^https?:\/\//i, '');
                      setServerUrl(`http://${stripped}`);
                    }}
                  >
                    <Text
                      color={!isHttps ? YELLOW : MUTED}
                      fontWeight="800"
                      fontSize="$xs"
                    >
                      HTTP (Insecure)
                    </Text>
                  </Pressable>
                </HStack>
              </VStack>

              {/* Server Presets */}
              <VStack space="xs" mb="$3">
                <Text color={MUTED} fontSize="$2xs" fontWeight="700">
                  SERVER PRESETS:
                </Text>
                <HStack space="xs">
                  <Button
                    flex={1}
                    size="xs"
                    variant="outline"
                    borderColor={serverUrl.includes('talhahub.io') ? '#38bdf8' : '#334155'}
                    bg={serverUrl.includes('talhahub.io') ? 'rgba(56, 189, 248, 0.15)' : PANEL_ALT}
                    onPress={() => setServerUrl('https://veriflow.talhahub.io/api')}
                  >
                    <ButtonText
                      color={serverUrl.includes('talhahub.io') ? '#38bdf8' : '#cbd5e1'}
                      fontSize="$2xs"
                      fontWeight="800"
                    >
                      talhahub.io (Production)
                    </ButtonText>
                  </Button>

                  <Button
                    flex={1}
                    size="xs"
                    variant="outline"
                    borderColor={serverUrl.includes('10.0.2.2') ? YELLOW : '#334155'}
                    bg={serverUrl.includes('10.0.2.2') ? 'rgba(250, 204, 21, 0.1)' : PANEL_ALT}
                    onPress={() => setServerUrl('http://10.0.2.2:8000')}
                  >
                    <ButtonText
                      color={serverUrl.includes('10.0.2.2') ? YELLOW : '#cbd5e1'}
                      fontSize="$2xs"
                      fontWeight="800"
                    >
                      10.0.2.2 (Emulator)
                    </ButtonText>
                  </Button>
                </HStack>
              </VStack>

              {/* API URL Input */}
              <VStack space="xs" mb="$3">
                <Text color={MUTED} fontSize="$2xs" fontWeight="700">
                  API BASE URL:
                </Text>
                <Input variant="outline" size="md" borderColor="#334155">
                  <InputField
                    value={serverUrl}
                    onChangeText={setServerUrl}
                    placeholder="https://veriflow.talhahub.io/api"
                    placeholderTextColor="#64748b"
                    color="#f8fafc"
                    keyboardType="url"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </Input>
              </VStack>

              {/* ROOT CA CERTIFICATE SECTION */}
              <Box
                bg={PANEL_ALT}
                p="$3.5"
                borderRadius="$lg"
                borderWidth={1}
                borderColor={rootCaCert ? PASS_COLOR : '#334155'}
                mb="$4"
              >
                <HStack justifyContent="space-between" alignItems="center" mb="$1">
                  <HStack space="xs" alignItems="center">
                    <ShieldCheck size={16} color={rootCaCert ? PASS_COLOR : YELLOW} />
                    <Text color="#f8fafc" fontSize="$sm" fontWeight="800">
                      Root CA Certificate
                    </Text>
                  </HStack>

                  <Box
                    bg={rootCaCert ? 'rgba(34, 197, 94, 0.15)' : 'rgba(148, 163, 184, 0.1)'}
                    px="$2"
                    py="$0.5"
                    borderRadius="$full"
                  >
                    <Text
                      color={rootCaCert ? PASS_COLOR : MUTED}
                      fontSize="$2xs"
                      fontWeight="800"
                    >
                      {rootCaCert
                        ? 'Custom CA Active'
                        : rootCaInput.trim()
                        ? 'Draft Pending'
                        : 'System Only'}
                    </Text>
                  </Box>
                </HStack>

                <Text color={MUTED} fontSize="$2xs" mb="$3" lineHeight={16}>
                  Configure a trusted Root CA when connecting to a private or self-signed HTTPS server.
                </Text>

                {/* Root CA Actions */}
                <HStack space="xs">
                  <Button
                    flex={1}
                    size="xs"
                    variant="outline"
                    borderColor={caQrScannerVisible ? YELLOW : '#334155'}
                    bg={caQrScannerVisible ? 'rgba(250, 204, 21, 0.15)' : PANEL}
                    h={40}
                    onPress={() => {
                      setCaScanLock(false);
                      setIsKeyScannerTorchOn(false);
                      setCaQrScannerVisible((prev: boolean) => !prev);
                    }}
                  >
                    <HStack space="xs" alignItems="center">
                      <QrCode size={14} color={caQrScannerVisible ? YELLOW : '#cbd5e1'} />
                      <ButtonText color={caQrScannerVisible ? YELLOW : '#cbd5e1'} fontSize="$xs" fontWeight="700">
                        {caQrScannerVisible ? 'Close Camera' : 'Scan Root CA QR'}
                      </ButtonText>
                    </HStack>
                  </Button>

                  <Button
                    flex={1}
                    size="xs"
                    bg={YELLOW}
                    h={40}
                    onPress={() => setRootCaModalVisible(true)}
                  >
                    <ButtonText color={BLACK} fontSize="$xs" fontWeight="900">
                      Manage Certificate
                    </ButtonText>
                  </Button>
                </HStack>

                {/* Inline Root CA Camera Viewport */}
                {caQrScannerVisible && (
                  <View
                    style={[
                      styles.cameraContainer,
                      { height: 220, borderWidth: 1, borderColor: YELLOW, marginTop: 12 }
                    ]}
                  >
                    {permission?.granted ? (
                      <CameraView
                        style={StyleSheet.absoluteFill}
                        facing="back"
                        enableTorch={isKeyScannerTorchOn}
                        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                        onBarcodeScanned={caScanLock ? undefined : handleRootCaQrScanned}
                      />
                    ) : (
                      <VStack flex={1} alignItems="center" justifyContent="center" px="$4">
                        <Text color="#f8fafc" fontSize="$xs" fontWeight="800" textAlign="center">
                          Camera permission required.
                        </Text>
                        <Button mt="$2" bg={YELLOW} size="xs" onPress={() => requestPermission()}>
                          <ButtonText color={BLACK} fontWeight="800">
                            Grant Permission
                          </ButtonText>
                        </Button>
                      </VStack>
                    )}

                    {permission?.granted && (
                      <Pressable
                        position="absolute"
                        top={8}
                        right={8}
                        zIndex={10}
                        onPress={() => setIsKeyScannerTorchOn((prev: boolean) => !prev)}
                        bg={isKeyScannerTorchOn ? YELLOW : 'rgba(5, 9, 20, 0.75)'}
                        p="$1.5"
                        borderRadius="$md"
                      >
                        {isKeyScannerTorchOn ? (
                          <Flashlight size={16} color={BLACK} />
                        ) : (
                          <FlashlightOff size={16} color="#f8fafc" />
                        )}
                      </Pressable>
                    )}

                    <View style={styles.reticleOverlay} pointerEvents="none">
                      <View style={styles.reticleBox}>
                        <View style={[styles.corner, styles.cornerTL]} />
                        <View style={[styles.corner, styles.cornerTR]} />
                        <View style={[styles.corner, styles.cornerBL]} />
                        <View style={[styles.corner, styles.cornerBR]} />
                      </View>
                    </View>
                  </View>
                )}
              </Box>

              {/* Primary Action: Save Server Configuration */}
              <Button
                bg={YELLOW}
                borderRadius="$md"
                h={48}
                onPress={async () => {
                  try {
                    const normalizedUrl = normalizeApiBaseUrl(serverUrl);
                    if (!normalizedUrl) {
                      Alert.alert('Invalid URL', 'Please enter a valid http:// or https:// Server API URL.');
                      return;
                    }
                    await setApiBaseUrl(normalizedUrl);
                    setServerUrl(normalizedUrl);
                    let appliedToNative = false;
                    if (rootCaInput.trim()) {
                      appliedToNative = await setRootCaCert(rootCaInput.trim());
                    } else {
                      await setRootCaCert('');
                    }
                    setScannedCaFormat(null);
                    const caStatusNote = rootCaInput.trim()
                      ? appliedToNative
                        ? '\n✓ Custom Root CA dynamically injected into Android TLS engine.'
                        : '\n⚠️ CA saved. Since running in Expo Go without native hooks, install talhaRootCA.crt in Android OS (Settings -> Security -> Install Certificate -> CA certificate) or run custom APK.'
                      : '';
                    Alert.alert(
                      'Configuration Saved',
                      `API URL set to: ${normalizedUrl}${caStatusNote}`,
                    );
                  } catch (err: any) {
                    Alert.alert('Root CA Error', err.message || 'Invalid Root CA certificate format.');
                  }
                }}
              >
                <ButtonText color={BLACK} fontWeight="900" fontSize="$sm">
                  Save Server Configuration
                </ButtonText>
              </Button>
            </Box>
          )}

          {/* ======================================================== */}
          {/* ISOLATED DANGER ZONE: DELETE ALL LOCAL SQLITE DATA */}
          {/* ======================================================== */}
          <Box
            borderWidth={1}
            borderColor={canDeleteAllData ? 'rgba(239, 68, 68, 0.4)' : '#1e293b'}
            borderRadius="$xl"
            bg={PANEL}
            p="$4"
            mt="$2"
          >
            <HStack justifyContent="space-between" alignItems="center" mb="$1">
              <HStack space="xs" alignItems="center">
                <Trash2 size={16} color={canDeleteAllData ? FAIL_COLOR : MUTED} />
                <Text color="#f8fafc" fontSize="$sm" fontWeight="800">
                  Local SQLite Data Reset
                </Text>
              </HStack>
              <Box
                bg={canDeleteAllData ? 'rgba(239, 68, 68, 0.15)' : 'rgba(148, 163, 184, 0.1)'}
                px="$2"
                py="$0.5"
                borderRadius="$full"
              >
                <Text
                  color={canDeleteAllData ? FAIL_COLOR : MUTED}
                  fontSize="$2xs"
                  fontWeight="900"
                >
                  {canDeleteAllData ? 'AUTHORIZED' : 'LOCKED'}
                </Text>
              </Box>
            </HStack>

            <Text color={MUTED} fontSize="$2xs" mb="$3">
              Permanently wipe local SQLite tables (scan queue, rules, and cached public keys) from this device.
            </Text>

            {canDeleteAllData ? (
              <Button
                bg={FAIL_COLOR}
                borderRadius="$md"
                h={44}
                onPress={confirmDeleteAllData}
              >
                <HStack space="xs" alignItems="center">
                  <Trash2 size={14} color="#ffffff" />
                  <ButtonText color="#ffffff" fontWeight="900" fontSize="$xs">
                    Delete All SQLite Data
                  </ButtonText>
                </HStack>
              </Button>
            ) : (
              <HStack space="xs" alignItems="center" justifyContent="space-between">
                <HStack space="xs" alignItems="center" flex={1}>
                  <Lock size={13} color={MUTED} />
                  <Text color={MUTED} fontSize="$2xs">
                    Requires &quot;user.delete_all_data&quot; permission.
                  </Text>
                </HStack>
                <Button
                  size="xs"
                  variant="outline"
                  borderColor={YELLOW}
                  onPress={async () => {
                    const result = await refreshPermissions();
                    Alert.alert(
                      result.ok
                        ? 'Permissions Synced'
                        : result.status === 401
                        ? 'Shift Token Rejected'
                        : 'Sync Unavailable',
                      result.ok
                        ? 'Updated user permissions from server.'
                        : result.error || 'Could not reach server. Using current token permissions.',
                    );
                  }}
                >
                  <ButtonText color={YELLOW} fontSize="$2xs" fontWeight="800">
                    Sync Permissions
                  </ButtonText>
                </Button>
              </HStack>
            )}
          </Box>
        </VStack>
      </ScrollView>

      {/* Edit Rule Modal */}
      <Modal
        visible={Boolean(editingRule)}
        transparent
        animationType="fade"
        onRequestClose={() => setEditingRule(null)}
      >
        <View style={styles.modalBackdrop}>
          <Box bg={PANEL} borderWidth={1} borderColor={BORDER} borderRadius="$xl" p="$4" width="100%" maxWidth={460}>
            <Text color={YELLOW} fontSize="$md" fontWeight="900" mb="$3">
              Edit Inventory Rule
            </Text>
            <VStack space="sm">
              <Input variant="outline" borderColor="#334155">
                <InputField
                  value={editRuleName}
                  onChangeText={setEditRuleName}
                  placeholder="Rule Name"
                  color="#f8fafc"
                />
              </Input>
              <Input variant="outline" borderColor="#334155">
                <InputField
                  value={editRuleKey}
                  onChangeText={setEditRuleKey}
                  placeholder="Claim Key"
                  color="#f8fafc"
                />
              </Input>
              <Input variant="outline" borderColor="#334155">
                <InputField
                  value={editRuleValue}
                  onChangeText={setEditRuleValue}
                  placeholder="Expected Value"
                  color="#f8fafc"
                />
              </Input>
              <HStack space="sm" justifyContent="flex-end" mt="$2">
                <Button variant="outline" borderColor="#475569" onPress={() => setEditingRule(null)}>
                  <ButtonText color="#cbd5e1">Cancel</ButtonText>
                </Button>
                <Button bg={YELLOW} onPress={saveEditRule}>
                  <ButtonText color={BLACK} fontWeight="900">
                    Save
                  </ButtonText>
                </Button>
              </HStack>
            </VStack>
          </Box>
        </View>
      </Modal>

      {/* Edit Key Modal */}
      <Modal
        visible={Boolean(editingKey)}
        transparent
        animationType="fade"
        onRequestClose={() => setEditingKey(null)}
      >
        <View style={styles.modalBackdrop}>
          <Box bg={PANEL} borderWidth={1} borderColor={BORDER} borderRadius="$xl" p="$4" width="100%" maxWidth={460}>
            <Text color={YELLOW} fontSize="$md" fontWeight="900" mb="$3">
              Edit Public Key
            </Text>
            <VStack space="sm">
              <Input variant="outline" borderColor="#334155">
                <InputField
                  value={editKeyName}
                  onChangeText={setEditKeyName}
                  placeholder="Key Name"
                  color="#f8fafc"
                />
              </Input>
              <Input variant="outline" borderColor="#334155">
                <InputField
                  value={editKeyValue}
                  onChangeText={setEditKeyValue}
                  placeholder="PEM Block"
                  color="#f8fafc"
                  multiline
                  numberOfLines={5}
                  minHeight={100}
                />
              </Input>
              <HStack space="sm" justifyContent="flex-end" mt="$2">
                <Button variant="outline" borderColor="#475569" onPress={() => setEditingKey(null)}>
                  <ButtonText color="#cbd5e1">Cancel</ButtonText>
                </Button>
                <Button bg={YELLOW} onPress={saveEditKey}>
                  <ButtonText color={BLACK} fontWeight="900">
                    Save
                  </ButtonText>
                </Button>
              </HStack>
            </VStack>
          </Box>
        </View>
      </Modal>

      {/* Root CA Manager Modal */}
      <RootCaModal
        visible={rootCaModalVisible}
        value={rootCaInput}
        onChangeValue={setRootCaInput}
        scannedFormat={scannedCaFormat}
        appliedCa={rootCaCert}
        onClose={() => setRootCaModalVisible(false)}
        onScanQr={() => {
          setRootCaModalVisible(false);
          setCaScanLock(false);
          setCaQrScannerVisible(true);
        }}
        onApply={async raw => {
          await setRootCaCert(raw.trim());
          setScannedCaFormat(null);
          setRootCaModalVisible(false);
          Alert.alert('Root CA Applied', 'Custom Root CA is now trusted for HTTPS connections.');
        }}
        onClear={async () => {
          await setRootCaCert('');
          setScannedCaFormat(null);
        }}
      />

      {/* Public Key Manager Modal */}
      <PublicKeyModal
        visible={publicKeyModalVisible}
        alias={keyName}
        onChangeAlias={setKeyName}
        value={keyValue}
        onChangeValue={setKeyValue}
        scannedFormat={scannedKeyFormat}
        onClose={() => {
          setPublicKeyModalVisible(false);
          setScannedKeyFormat(null);
        }}
        onScanQr={() => {
          setPublicKeyModalVisible(false);
          setKeyScanLock(false);
          setIsKeyScannerTorchOn(false);
          setKeyQrScannerVisible(true);
        }}
        onSave={async (alias, pem) => {
          if (!canCreateKeys) {
            Alert.alert('Permission Denied', 'Your token lacks "keys.create" permission.');
            return;
          }
          await addPublicKey(alias, pem);
          setKeyName('');
          setKeyValue('');
          setScannedKeyFormat(null);
          setPublicKeyModalVisible(false);
          await refresh();
          Alert.alert(
            'Saved to Keystore',
            `Public key "${alias}" successfully added to local SQLite keystore.`,
          );
        }}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  actionBtn: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: '#111c2e',
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
  },
  expandToggle: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  cameraContainer: {
    width: '100%',
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#050914',
    position: 'relative',
    borderWidth: 1,
    borderColor: '#334155',
  },
  reticleOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticleBox: {
    width: 160,
    height: 160,
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  corner: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderColor: YELLOW,
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: 3.5,
    borderLeftWidth: 3.5,
    borderTopLeftRadius: 6,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: 3.5,
    borderRightWidth: 3.5,
    borderTopRightRadius: 6,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 3.5,
    borderLeftWidth: 3.5,
    borderBottomLeftRadius: 6,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3.5,
    borderRightWidth: 3.5,
    borderBottomRightRadius: 6,
  },
});
