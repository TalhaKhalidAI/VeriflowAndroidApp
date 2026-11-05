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
  Pencil,
  Trash2,
  Key,
  Sliders,
  Globe,
  DownloadCloud,
  ShieldAlert,
  ShieldCheck,
  Lock,
  QrCode,
  Flashlight,
  FlashlightOff,
} from 'lucide-react-native';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Modal, StyleSheet, View } from 'react-native';
import { useAuth } from '../core/authContext';
import { RootCaModal } from '../components/RootCaModal';
import { PublicKeyModal } from '../components/PublicKeyModal';
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
const YELLOW = '#facc15';
const MUTED = '#94a3b8';
const PASS_COLOR = '#22c55e';
const FAIL_COLOR = '#ef4444';

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

  // Tab: 'KEYS' | 'RULES' | 'NETWORK'
  const [activeTab, setActiveTab] = useState<'KEYS' | 'RULES' | 'NETWORK'>('RULES');

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
      // Show exactly what the scanner received so it can be inspected / fixed in the manager.
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
      await refresh();
      Alert.alert(
        'Saved to Keystore',
        `Public key "${keyName.trim()}" added to local SQLite keystore.`,
      );
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
          {
            text: 'Scan Again',
            onPress: () => setKeyScanLock(false),
          },
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

  // Fetch Public Keys from Server API (JWKS)
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
                ? `-----BEGIN PUBLIC KEY-----
${k.x5c[0]}
-----END PUBLIC KEY-----`
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
        'Your user account lacks "user.delete_all_data" permission. Ask an admin to grant it and tap Sync Permissions.',
      );
      return;
    }

    Alert.alert(
      'Delete All Local SQLite Data?',
      'This will permanently wipe all local scans, inventory rules, and public keys stored in SQLite on this Android device. Your active login session and server URL will remain intact.',
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

  return (
    <ScrollView style={{ flex: 1, backgroundColor: BLACK }}>
      <Box px="$4" py="$6">
        <VStack space="lg" width="100%" maxWidth={580} alignSelf="center">
          <Heading color={YELLOW} size="2xl" fontWeight="900">
            Settings & Local Storage
          </Heading>

          {/* Navigation Tabs */}
          <HStack space="xs" bg={PANEL_ALT} p="$1" borderRadius="$lg" borderWidth={1} borderColor="#334155">
            <Pressable
              flex={1}
              py="$2"
              borderRadius="$md"
              bg={activeTab === 'RULES' ? YELLOW : 'transparent'}
              alignItems="center"
              onPress={() => setActiveTab('RULES')}
            >
              <HStack space="xs" alignItems="center">
                <Sliders size={16} color={activeTab === 'RULES' ? BLACK : MUTED} />
                <Text color={activeTab === 'RULES' ? BLACK : MUTED} fontWeight="800" fontSize="$xs">
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
              <HStack space="xs" alignItems="center">
                <Key size={16} color={activeTab === 'KEYS' ? BLACK : MUTED} />
                <Text color={activeTab === 'KEYS' ? BLACK : MUTED} fontWeight="800" fontSize="$xs">
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
              <HStack space="xs" alignItems="center">
                <Globe size={16} color={activeTab === 'NETWORK' ? BLACK : MUTED} />
                <Text color={activeTab === 'NETWORK' ? BLACK : MUTED} fontWeight="800" fontSize="$xs">
                  Server API
                </Text>
              </HStack>
            </Pressable>
          </HStack>

          {/* ======================================================== */}
          {/* TAB 1: INVENTORY RULES */}
          {/* ======================================================== */}
          {activeTab === 'RULES' ? (
            !canViewRules ? (
              <Box bg={PANEL} p="$6" borderRadius="$xl" borderWidth={1} borderColor="#ef4444" alignItems="center">
                <ShieldAlert size={48} color={FAIL_COLOR} />
                <Heading color={FAIL_COLOR} size="md" mt="$3">
                  Permission Denied
                </Heading>
                <Text color={MUTED} fontSize="$xs" textAlign="center" mt="$1">
                  Your token does not have &quot;inventory_rules.view&quot; permission.
                </Text>
              </Box>
            ) : (
              <Box borderWidth={2} borderColor={YELLOW} borderRadius="$xl" bg={PANEL} p="$4">
                <HStack justifyContent="space-between" alignItems="center" mb="$1">
                  <Text color="#f8fafc" fontSize="$lg" fontWeight="800">
                    SQLite Inventory Rules ({rules.length})
                  </Text>
                  <Box
                    bg={
                      canCreateRules && canUpdateRules && canDeleteRules
                        ? 'rgba(34, 197, 94, 0.2)'
                        : 'rgba(250, 204, 21, 0.15)'
                    }
                    px="$2"
                    py="$1"
                    borderRadius="$sm"
                    borderWidth={1}
                    borderColor={
                      canCreateRules && canUpdateRules && canDeleteRules ? PASS_COLOR : YELLOW
                    }
                  >
                    <Text
                      color={
                        canCreateRules && canUpdateRules && canDeleteRules ? PASS_COLOR : YELLOW
                      }
                      fontSize="$2xs"
                      fontWeight="900"
                    >
                      {canCreateRules && canUpdateRules && canDeleteRules
                        ? 'FULL CRUD'
                        : canCreateRules
                        ? 'VIEW + CREATE'
                        : 'VIEW ONLY'}
                    </Text>
                  </Box>
                </HStack>

                <Text color={MUTED} fontSize="$xs" mb="$3">
                  Rules tested optionally during QR scanning to compare claims with expected values.
                </Text>

                {/* Permissions Status Indicators */}
                <Box bg={PANEL_ALT} p="$2" borderRadius="$md" borderWidth={1} borderColor="#334155" mb="$3">
                  <HStack space="sm" flexWrap="wrap">
                    <Text color={PASS_COLOR} fontSize="$2xs">
                      • view: GRANTED
                    </Text>
                    <Text color={canCreateRules ? PASS_COLOR : MUTED} fontSize="$2xs">
                      • create: {canCreateRules ? 'GRANTED' : 'DENIED'}
                    </Text>
                    <Text color={canUpdateRules ? PASS_COLOR : MUTED} fontSize="$2xs">
                      • update: {canUpdateRules ? 'GRANTED' : 'DENIED'}
                    </Text>
                    <Text color={canDeleteRules ? PASS_COLOR : MUTED} fontSize="$2xs">
                      • delete: {canDeleteRules ? 'GRANTED' : 'DENIED'}
                    </Text>
                  </HStack>
                </Box>

                {/* Add Rule Form (Gated by canCreateRules) */}
                {canCreateRules ? (
                  <VStack space="xs" mb="$4">
                    <Input variant="outline" size="sm" borderColor="#334155">
                      <InputField
                        value={ruleName}
                        onChangeText={setRuleName}
                        placeholder="Rule Name (e.g. WH-A Electronics Batch)"
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
                          placeholder="Expected value (e.g. 2026-X)"
                          placeholderTextColor="#64748b"
                          color="#f8fafc"
                        />
                      </Input>
                    </HStack>

                    <Button bg={YELLOW} borderRadius="$md" mt="$2" onPress={saveRule}>
                      <ButtonText color={BLACK} fontWeight="900">
                        + Add Rule
                      </ButtonText>
                    </Button>
                  </VStack>
                ) : (
                  <Box bg="rgba(148, 163, 184, 0.08)" p="$3" borderRadius="$md" mb="$4" borderWidth={1} borderColor="#334155">
                    <HStack space="xs" alignItems="center">
                      <Lock size={14} color={MUTED} />
                      <Text color={MUTED} fontSize="$xs">
                        Rule creation disabled. Requires &quot;inventory_rules.create&quot; permission.
                      </Text>
                    </HStack>
                  </Box>
                )}

                {/* Rules List */}
                <VStack space="xs">
                  {rules.map(r => (
                    <HStack
                      key={r.id}
                      justifyContent="space-between"
                      alignItems="center"
                      borderTopWidth={1}
                      borderTopColor="#334155"
                      py="$3"
                    >
                      <VStack flex={1} mr="$2">
                        <Text color="#f8fafc" fontWeight="700">
                          {r.inventory_name}
                        </Text>
                        <Text color={MUTED} fontSize="$xs">
                          Match: <Text color={YELLOW}>{r.matching_claim_key}</Text> == &quot;{r.expected_value}&quot;
                        </Text>
                      </VStack>

                      {/* Edit/Delete Actions gated by permissions */}
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
                            <Pencil size={16} color={YELLOW} />
                          </Pressable>
                        ) : null}

                        {canDeleteRules ? (
                          <Pressable onPress={() => confirmDeleteRule(r)} style={styles.actionBtn}>
                            <Trash2 size={16} color="#f87171" />
                          </Pressable>
                        ) : null}
                      </HStack>
                    </HStack>
                  ))}
                  {!rules.length ? (
                    <Text color={MUTED} fontSize="$xs" py="$4" textAlign="center">
                      No inventory rules stored in SQLite.
                    </Text>
                  ) : null}
                </VStack>
              </Box>
            )
          ) : null}

          {/* ======================================================== */}
          {/* TAB 2: PUBLIC KEYS */}
          {/* ======================================================== */}
          {activeTab === 'KEYS' ? (
            !canViewKeys ? (
              <Box bg={PANEL} p="$6" borderRadius="$xl" borderWidth={1} borderColor="#ef4444" alignItems="center">
                <ShieldAlert size={48} color={FAIL_COLOR} />
                <Heading color={FAIL_COLOR} size="md" mt="$3">
                  Permission Denied
                </Heading>
                <Text color={MUTED} fontSize="$xs" textAlign="center" mt="$1">
                  Your token does not have &quot;keys.view&quot; permission.
                </Text>
              </Box>
            ) : (
              <Box borderWidth={2} borderColor={YELLOW} borderRadius="$xl" bg={PANEL} p="$4">
                <HStack justifyContent="space-between" alignItems="center" mb="$1">
                  <Text color="#f8fafc" fontSize="$lg" fontWeight="800">
                    Public Keys ({publicKeys.length})
                  </Text>
                  <Box
                    bg={
                      canCreateKeys && canUpdateKeys && canDeleteKeys
                        ? 'rgba(34, 197, 94, 0.2)'
                        : 'rgba(250, 204, 21, 0.15)'
                    }
                    px="$2"
                    py="$1"
                    borderRadius="$sm"
                    borderWidth={1}
                    borderColor={
                      canCreateKeys && canUpdateKeys && canDeleteKeys ? PASS_COLOR : YELLOW
                    }
                  >
                    <Text
                      color={
                        canCreateKeys && canUpdateKeys && canDeleteKeys ? PASS_COLOR : YELLOW
                      }
                      fontSize="$2xs"
                      fontWeight="900"
                    >
                      {canCreateKeys && canUpdateKeys && canDeleteKeys
                        ? 'FULL CRUD'
                        : canCreateKeys
                        ? 'VIEW + CREATE'
                        : 'VIEW ONLY'}
                    </Text>
                  </Box>
                </HStack>

                <Text color={MUTED} fontSize="$xs" mb="$3">
                  RSA public verification keys used by the mobile scanner to verify RS256 token signatures.
                </Text>

                {/* Permissions Status Indicators */}
                <Box bg={PANEL_ALT} p="$2" borderRadius="$md" borderWidth={1} borderColor="#334155" mb="$3">
                  <HStack space="sm" flexWrap="wrap">
                    <Text color={PASS_COLOR} fontSize="$2xs">
                      • view: GRANTED
                    </Text>
                    <Text color={canCreateKeys ? PASS_COLOR : MUTED} fontSize="$2xs">
                      • create: {canCreateKeys ? 'GRANTED' : 'DENIED'}
                    </Text>
                    <Text color={canUpdateKeys ? PASS_COLOR : MUTED} fontSize="$2xs">
                      • update: {canUpdateKeys ? 'GRANTED' : 'DENIED'}
                    </Text>
                    <Text color={canDeleteKeys ? PASS_COLOR : MUTED} fontSize="$2xs">
                      • delete: {canDeleteKeys ? 'GRANTED' : 'DENIED'}
                    </Text>
                  </HStack>
                </Box>

                {/* Fetch from API button & Add Key Form (Gated by canCreateKeys) */}
                {canCreateKeys ? (
                  <VStack space="sm" mb="$4">
                    {/* Fetch Keys from API Button */}
                    <Button
                      variant="outline"
                      borderColor={YELLOW}
                      onPress={fetchServerKeys}
                      isDisabled={isFetchingServerKeys}
                    >
                      {isFetchingServerKeys ? (
                        <HStack space="xs" alignItems="center">
                          <ActivityIndicator size="small" color={YELLOW} />
                          <ButtonText color={YELLOW} fontWeight="800" ml="$2">
                            Fetching Server Keys...
                          </ButtonText>
                        </HStack>
                      ) : (
                        <HStack space="xs" alignItems="center">
                          <DownloadCloud size={16} color={YELLOW} />
                          <ButtonText color={YELLOW} fontWeight="800" ml="$1">
                            Fetch Public Keys from API
                          </ButtonText>
                        </HStack>
                      )}
                    </Button>

                    {/* Public Key Action Buttons */}
                    <HStack space="xs">
                      <Button
                        flex={1}
                        bg={keyQrScannerVisible ? YELLOW : 'rgba(250, 204, 21, 0.14)'}
                        borderWidth={1}
                        borderColor={YELLOW}
                        onPress={() => {
                          setKeyScanLock(false);
                          setIsKeyScannerTorchOn(false);
                          setKeyQrScannerVisible(prev => !prev);
                        }}
                      >
                        <HStack space="xs" alignItems="center">
                          <QrCode size={16} color={keyQrScannerVisible ? BLACK : YELLOW} />
                          <ButtonText color={keyQrScannerVisible ? BLACK : YELLOW} fontWeight="900" fontSize="$xs">
                            {keyQrScannerVisible ? 'Close Camera' : 'Scan Key QR'}
                          </ButtonText>
                        </HStack>
                      </Button>

                      <Button
                        flex={1}
                        variant="outline"
                        borderColor={YELLOW}
                        bg={keyValue.trim() ? 'rgba(34, 197, 94, 0.15)' : 'rgba(250, 204, 21, 0.08)'}
                        onPress={() => setPublicKeyModalVisible(true)}
                      >
                        <HStack space="xs" alignItems="center">
                          <Key size={16} color={YELLOW} />
                          <ButtonText color={YELLOW} fontWeight="900" fontSize="$xs">
                            {keyValue.trim() ? 'Review Key Modal' : 'Import / Manage Key'}
                          </ButtonText>
                        </HStack>
                      </Button>
                    </HStack>

                    {keyQrScannerVisible ? (
                      <Box
                        bg={PANEL_ALT}
                        borderWidth={2}
                        borderColor={YELLOW}
                        borderRadius="$xl"
                        p="$3"
                      >
                        <Text color={MUTED} fontSize="$2xs" mb="$2" textAlign="center">
                          Aim at Web App Public Key QR (<Text color={YELLOW} fontWeight="800">Clean Base64</Text>, <Text color={YELLOW} fontWeight="800">JSON</Text>, or <Text color={YELLOW} fontWeight="800">PEM</Text>)
                        </Text>

                        <Box
                          h={250}
                          borderWidth={2}
                          borderColor={YELLOW}
                          borderRadius="$lg"
                          overflow="hidden"
                          bg="#050914"
                          position="relative"
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
                              <Text color="#f8fafc" fontSize="$sm" fontWeight="800" textAlign="center">
                                Camera permission is required to scan Public Key QR codes.
                              </Text>
                              <Button mt="$3" bg={YELLOW} size="sm" onPress={() => requestPermission()}>
                                <ButtonText color={BLACK} fontWeight="800">
                                  Grant Camera Permission
                                </ButtonText>
                              </Button>
                            </VStack>
                          )}

                          {permission?.granted ? (
                            <Pressable
                              position="absolute"
                              top={12}
                              right={12}
                              zIndex={10}
                              onPress={() => setIsKeyScannerTorchOn(prev => !prev)}
                              bg={isKeyScannerTorchOn ? YELLOW : 'rgba(5, 9, 20, 0.75)'}
                              p="$2"
                              borderRadius="$md"
                              borderWidth={1}
                              borderColor={isKeyScannerTorchOn ? YELLOW : 'rgba(255, 255, 255, 0.3)'}
                              alignItems="center"
                              justifyContent="center"
                            >
                              {isKeyScannerTorchOn ? (
                                <Flashlight size={18} color={BLACK} />
                              ) : (
                                <FlashlightOff size={18} color="#f8fafc" />
                              )}
                            </Pressable>
                          ) : null}

                          <View style={styles.reticleOverlay} pointerEvents="none">
                            <View style={styles.reticleBox} />
                          </View>
                        </Box>
                      </Box>
                    ) : null}

                    <Text color={MUTED} fontSize="$2xs" textAlign="center">
                      — OR PASTE KEY MANUALLY (JSON / BASE64 / PEM) —
                    </Text>

                    {scannedKeyFormat ? (
                      <Box
                        bg="rgba(34, 197, 94, 0.15)"
                        borderWidth={1}
                        borderColor={PASS_COLOR}
                        borderRadius="$md"
                        p="$2.5"
                      >
                        <Text color={PASS_COLOR} fontSize="$xs" fontWeight="800">
                          ✓ QR Scanned ({scannedKeyFormat}) — Enter Key Alias below and tap &quot;+ Add Key&quot;
                        </Text>
                      </Box>
                    ) : null}

                    <Input variant="outline" size="sm" borderColor={scannedKeyFormat && !keyName.trim() ? YELLOW : '#334155'}>
                      <InputField
                        value={keyName}
                        onChangeText={setKeyName}
                        placeholder="Enter Key alias (e.g. Master Verification Key) *"
                        placeholderTextColor="#64748b"
                        color="#f8fafc"
                      />
                    </Input>
                    <Input variant="outline" size="sm" borderColor="#334155">
                      <InputField
                        value={keyValue}
                        onChangeText={setKeyValue}
                        placeholder="Paste Clean Base64, Standard PEM, or JSON Key Bundle..."
                        placeholderTextColor="#64748b"
                        color="#f8fafc"
                        multiline
                        numberOfLines={4}
                        minHeight={80}
                      />
                    </Input>
                    <Button bg={YELLOW} borderRadius="$md" onPress={saveKey}>
                      <ButtonText color={BLACK} fontWeight="900">
                        + Add Key
                      </ButtonText>
                    </Button>
                  </VStack>
                ) : (
                  <Box bg="rgba(148, 163, 184, 0.08)" p="$3" borderRadius="$md" mb="$4" borderWidth={1} borderColor="#334155">
                    <HStack space="xs" alignItems="center">
                      <Lock size={14} color={MUTED} />
                      <Text color={MUTED} fontSize="$xs">
                        Key creation and API fetch disabled. Requires &quot;keys.create&quot; permission.
                      </Text>
                    </HStack>
                  </Box>
                )}

                {/* Keys List */}
                <VStack space="xs">
                  {publicKeys.map(k => (
                    <HStack
                      key={k.id}
                      justifyContent="space-between"
                      alignItems="center"
                      borderTopWidth={1}
                      borderTopColor="#334155"
                      py="$3"
                    >
                      <VStack flex={1} mr="$2">
                        <Text color="#f8fafc" fontWeight="700">
                          {k.name}
                        </Text>
                        <Text color={MUTED} fontSize="$xs" numberOfLines={1}>
                          ID: {k.id} · {k.public_key_string.slice(0, 40)}...
                        </Text>
                      </VStack>

                      {/* Edit/Delete Actions gated by permissions */}
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
                            <Pencil size={16} color={YELLOW} />
                          </Pressable>
                        ) : null}

                        {canDeleteKeys ? (
                          <Pressable onPress={() => confirmDeleteKey(k)} style={styles.actionBtn}>
                            <Trash2 size={16} color="#f87171" />
                          </Pressable>
                        ) : null}
                      </HStack>
                    </HStack>
                  ))}
                  {!publicKeys.length ? (
                    <Text color={MUTED} fontSize="$xs" py="$4" textAlign="center">
                      No keys saved in SQLite yet.
                    </Text>
                  ) : null}
                </VStack>
              </Box>
            )
          ) : null}

          {/* ======================================================== */}
          {/* TAB 3: NETWORK / API & HTTPS ROOT CA */}
          {/* ======================================================== */}
          {activeTab === 'NETWORK' ? (
            <Box borderWidth={2} borderColor={YELLOW} borderRadius="$xl" bg={PANEL} p="$4">
              <HStack justifyContent="space-between" alignItems="center" mb="$1">
                <Text color="#f8fafc" fontSize="$lg" fontWeight="800">
                  Server API & HTTPS Root CA
                </Text>
                <Box
                  bg={
                    serverUrl.trim().toLowerCase().startsWith('https://')
                      ? 'rgba(34, 197, 94, 0.2)'
                      : 'rgba(250, 204, 21, 0.15)'
                  }
                  px="$2"
                  py="$1"
                  borderRadius="$sm"
                  borderWidth={1}
                  borderColor={
                    serverUrl.trim().toLowerCase().startsWith('https://') ? PASS_COLOR : YELLOW
                  }
                >
                  <Text
                    color={
                      serverUrl.trim().toLowerCase().startsWith('https://') ? PASS_COLOR : YELLOW
                    }
                    fontSize="$2xs"
                    fontWeight="900"
                  >
                    {serverUrl.trim().toLowerCase().startsWith('https://') ? 'HTTPS TLS' : 'HTTP'}
                  </Text>
                </Box>
              </HStack>

              <Text color={MUTED} fontSize="$xs" mb="$3">
                Supports both <Text color={PASS_COLOR} fontWeight="700">https://</Text> and <Text color={YELLOW} fontWeight="700">http://</Text> endpoints. For self-signed or private HTTPS servers, paste or scan your Root CA certificate below.
              </Text>

              {/* Quick Protocol & Preset Switcher */}
              <HStack space="xs" mb="$2" flexWrap="wrap">
                <Button
                  size="xs"
                  variant="outline"
                  borderColor={PASS_COLOR}
                  bg={serverUrl.trim().toLowerCase().startsWith('https://') ? 'rgba(34, 197, 94, 0.2)' : 'transparent'}
                  onPress={() => {
                    const stripped = serverUrl.trim().replace(/^https?:\/\//i, '');
                    setServerUrl(`https://${stripped}`);
                  }}
                >
                  <ButtonText color={PASS_COLOR} fontSize="$2xs" fontWeight="900">
                    Use https://
                  </ButtonText>
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  borderColor={YELLOW}
                  bg={serverUrl.trim().toLowerCase().startsWith('http://') ? 'rgba(250, 204, 21, 0.15)' : 'transparent'}
                  onPress={() => {
                    const stripped = serverUrl.trim().replace(/^https?:\/\//i, '');
                    setServerUrl(`http://${stripped}`);
                  }}
                >
                  <ButtonText color={YELLOW} fontSize="$2xs" fontWeight="900">
                    Use http://
                  </ButtonText>
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  borderColor="#38bdf8"
                  bg={serverUrl.includes('talhahub.io') ? 'rgba(56, 189, 248, 0.2)' : 'transparent'}
                  onPress={() => {
                    setServerUrl('https://veriflow.talhahub.io/api');
                  }}
                >
                  <ButtonText color="#38bdf8" fontSize="$2xs" fontWeight="900">
                    Preset: talhahub.io
                  </ButtonText>
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  borderColor="#94a3b8"
                  bg={serverUrl.includes('10.0.2.2') ? 'rgba(148, 163, 184, 0.2)' : 'transparent'}
                  onPress={() => {
                    setServerUrl('http://10.0.2.2:8000');
                  }}
                >
                  <ButtonText color="#cbd5e1" fontSize="$2xs" fontWeight="900">
                    Preset: 10.0.2.2
                  </ButtonText>
                </Button>
              </HStack>

              <Input variant="outline" size="md" borderColor="#334155" mb="$4">
                <InputField
                  value={serverUrl}
                  onChangeText={setServerUrl}
                  placeholder="https://veriflow.talhahub.io/api or http://10.0.2.2:8000"
                  placeholderTextColor="#64748b"
                  color="#f8fafc"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </Input>

              {/* ROOT CA CERTIFICATE SECTION */}
              <Box
                bg={PANEL_ALT}
                p="$3"
                borderRadius="$lg"
                borderWidth={1}
                borderColor={rootCaCert ? PASS_COLOR : '#334155'}
                mb="$4"
              >
                <HStack justifyContent="space-between" alignItems="center" mb="$2">
                  <HStack space="xs" alignItems="center">
                    <ShieldCheck size={16} color={rootCaCert ? PASS_COLOR : YELLOW} />
                    <Text color="#f8fafc" fontSize="$sm" fontWeight="800">
                      Root CA Certificate (HTTPS)
                    </Text>
                  </HStack>
                  <Text
                    color={rootCaCert ? PASS_COLOR : MUTED}
                    fontSize="$2xs"
                    fontWeight="900"
                  >
                    {rootCaCert ? 'CUSTOM CA ACTIVE' : 'SYSTEM CA ONLY'}
                  </Text>
                </HStack>

                <Text color={MUTED} fontSize="$2xs" mb="$2.5">
                  Scan or paste your Root CA certificate (<Text color={YELLOW}>-----BEGIN CERTIFICATE-----</Text>, Clean Base64, or JSON) so Android trusts your HTTPS server.
                </Text>

                <Button
                  size="sm"
                  bg={caQrScannerVisible ? YELLOW : 'rgba(250, 204, 21, 0.14)'}
                  borderWidth={1}
                  borderColor={YELLOW}
                  mb="$2.5"
                  onPress={() => {
                    setCaScanLock(false);
                    setIsKeyScannerTorchOn(false);
                    setCaQrScannerVisible(prev => !prev);
                  }}
                >
                  <HStack space="xs" alignItems="center">
                    <QrCode size={15} color={caQrScannerVisible ? BLACK : YELLOW} />
                    <ButtonText color={caQrScannerVisible ? BLACK : YELLOW} fontSize="$xs" fontWeight="900">
                      {caQrScannerVisible
                        ? 'Close Root CA QR Camera'
                        : 'Scan Root CA QR (Auto-Detect JSON / Base64 / PEM)'}
                    </ButtonText>
                  </HStack>
                </Button>

                {caQrScannerVisible ? (
                  <Box
                    h={240}
                    borderWidth={2}
                    borderColor={YELLOW}
                    borderRadius="$lg"
                    overflow="hidden"
                    bg="#050914"
                    position="relative"
                    mb="$2.5"
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
                        <Text color="#f8fafc" fontSize="$sm" fontWeight="800" textAlign="center">
                          Camera permission is required to scan Root CA QR codes.
                        </Text>
                        <Button mt="$3" bg={YELLOW} size="sm" onPress={() => requestPermission()}>
                          <ButtonText color={BLACK} fontWeight="800">
                            Grant Camera Permission
                          </ButtonText>
                        </Button>
                      </VStack>
                    )}

                    {permission?.granted ? (
                      <Pressable
                        position="absolute"
                        top={12}
                        right={12}
                        zIndex={10}
                        onPress={() => setIsKeyScannerTorchOn(prev => !prev)}
                        bg={isKeyScannerTorchOn ? YELLOW : 'rgba(5, 9, 20, 0.75)'}
                        p="$2"
                        borderRadius="$md"
                        borderWidth={1}
                        borderColor={isKeyScannerTorchOn ? YELLOW : 'rgba(255, 255, 255, 0.3)'}
                        alignItems="center"
                        justifyContent="center"
                      >
                        {isKeyScannerTorchOn ? (
                          <Flashlight size={18} color={BLACK} />
                        ) : (
                          <FlashlightOff size={18} color="#f8fafc" />
                        )}
                      </Pressable>
                    ) : null}

                    <View style={styles.reticleOverlay} pointerEvents="none">
                      <View style={styles.reticleBox} />
                    </View>
                  </Box>
                ) : null}

                {scannedCaFormat ? (
                  <Box
                    bg="rgba(34, 197, 94, 0.15)"
                    borderWidth={1}
                    borderColor={PASS_COLOR}
                    borderRadius="$md"
                    p="$2"
                    mb="$2"
                  >
                    <Text color={PASS_COLOR} fontSize="$2xs" fontWeight="800">
                      ✓ Root CA QR Scanned ({scannedCaFormat}) — open the manager to review and Apply
                    </Text>
                  </Box>
                ) : null}

                <Text
                  color={rootCaCert ? PASS_COLOR : rootCaInput.trim() ? YELLOW : MUTED}
                  fontSize="$2xs"
                  fontWeight="700"
                  mb="$2"
                >
                  {rootCaCert
                    ? '✓ Custom Root CA applied'
                    : rootCaInput.trim()
                    ? '• Draft pending — open manager and Apply'
                    : '• No custom Root CA (system CAs only)'}
                </Text>

                <Button
                  size="sm"
                  bg={YELLOW}
                  onPress={() => setRootCaModalVisible(true)}
                >
                  <ButtonText color={BLACK} fontSize="$xs" fontWeight="900">
                    Manage Root CA Certificate
                  </ButtonText>
                </Button>
              </Box>

              <Button
                bg={YELLOW}
                borderRadius="$md"
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
                <ButtonText color={BLACK} fontWeight="900">
                  Save Server & Root CA Configuration
                </ButtonText>
              </Button>
            </Box>
          ) : null}

          {/* ======================================================== */}
          {/* DANGER ZONE: DELETE ALL LOCAL SQLITE DATA */}
          {/* ======================================================== */}
          <Box
            borderWidth={2}
            borderColor={canDeleteAllData ? FAIL_COLOR : '#334155'}
            borderRadius="$xl"
            bg={PANEL}
            p="$4"
          >
            <HStack justifyContent="space-between" alignItems="center" mb="$1">
              <HStack space="xs" alignItems="center">
                <Trash2 size={18} color={canDeleteAllData ? FAIL_COLOR : MUTED} />
                <Text color="#f8fafc" fontSize="$md" fontWeight="800">
                  Local SQLite Data Reset
                </Text>
              </HStack>
              <Box
                bg={canDeleteAllData ? 'rgba(239, 68, 68, 0.2)' : 'rgba(148, 163, 184, 0.12)'}
                px="$2"
                py="$1"
                borderRadius="$sm"
                borderWidth={1}
                borderColor={canDeleteAllData ? FAIL_COLOR : '#475569'}
              >
                <Text
                  color={canDeleteAllData ? '#f87171' : MUTED}
                  fontSize="$2xs"
                  fontWeight="900"
                >
                  {canDeleteAllData ? 'user.delete_all_data: GRANTED' : 'user.delete_all_data: DENIED'}
                </Text>
              </Box>
            </HStack>

            <Text color={MUTED} fontSize="$xs" mb="$3">
              Permanently wipe all local SQLite tables (scan queue, inventory rules, and cached public keys) from this device.
            </Text>

            {canDeleteAllData ? (
              <Button
                bg={FAIL_COLOR}
                borderRadius="$md"
                onPress={confirmDeleteAllData}
              >
                <HStack space="xs" alignItems="center">
                  <Trash2 size={16} color="#ffffff" />
                  <ButtonText color="#ffffff" fontWeight="900">
                    Delete All SQLite Data
                  </ButtonText>
                </HStack>
              </Button>
            ) : (
              <HStack space="xs" alignItems="center" justifyContent="space-between">
                <HStack space="xs" alignItems="center" flex={1}>
                  <Lock size={14} color={MUTED} />
                  <Text color={MUTED} fontSize="$xs">
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
      </Box>

      {/* Edit Rule Modal */}
      <Modal
        visible={Boolean(editingRule)}
        transparent
        animationType="fade"
        onRequestClose={() => setEditingRule(null)}
      >
        <View style={styles.modalBackdrop}>
          <Box bg={PANEL} borderWidth={2} borderColor={YELLOW} borderRadius="$xl" p="$4" width="100%" maxWidth={480}>
            <Text color={YELLOW} fontSize="$lg" fontWeight="900" mb="$3">
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
                <Button variant="outline" borderColor="#64748b" onPress={() => setEditingRule(null)}>
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
          <Box bg={PANEL} borderWidth={2} borderColor={YELLOW} borderRadius="$xl" p="$4" width="100%" maxWidth={480}>
            <Text color={YELLOW} fontSize="$lg" fontWeight="900" mb="$3">
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
                <Button variant="outline" borderColor="#64748b" onPress={() => setEditingKey(null)}>
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

      {/* Root CA Manager Modal (large viewer/editor) */}
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

      {/* Public Key Manager & Import Modal (Separate QR Review & SQLite Storage) */}
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  actionBtn: {
    width: 34,
    height: 34,
    borderRadius: 6,
    backgroundColor: '#111c2e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  reticleOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticleBox: {
    width: 165,
    height: 165,
    borderWidth: 2,
    borderColor: YELLOW,
    borderRadius: 16,
    borderStyle: 'dashed',
  },
});
