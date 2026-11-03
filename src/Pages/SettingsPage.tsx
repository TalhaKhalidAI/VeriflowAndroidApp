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
} from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Modal, StyleSheet, View } from 'react-native';
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
import { normalizePublicKey } from '../core/jwt';
import { InventoryRecord, PublicKeyRecord } from '../core/types';

const BLACK = '#07111d';
const PANEL = '#0f172a';
const PANEL_ALT = '#111c2e';
const YELLOW = '#facc15';
const MUTED = '#94a3b8';
const PASS_COLOR = '#22c55e';
const FAIL_COLOR = '#ef4444';

export default function SettingsPage() {
  const { session, hasPermission, refreshPermissions, apiBaseUrl, setApiBaseUrl } = useAuth();

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

  // Inventory Rules state
  const [rules, setRules] = useState<InventoryRecord[]>([]);
  const [ruleName, setRuleName] = useState('');
  const [ruleKey, setRuleKey] = useState('');
  const [ruleValue, setRuleValue] = useState('');
  const [editingRule, setEditingRule] = useState<InventoryRecord | null>(null);
  const [editRuleName, setEditRuleName] = useState('');
  const [editRuleKey, setEditRuleKey] = useState('');
  const [editRuleValue, setEditRuleValue] = useState('');

  // Network state
  const [serverUrl, setServerUrl] = useState(apiBaseUrl);

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

  // ---------------- PUBLIC KEY ACTIONS ----------------
  const saveKey = async () => {
    if (!canCreateKeys) {
      Alert.alert('Permission Denied', 'Your token lacks "keys.create" permission.');
      return;
    }
    if (!keyName.trim() || !keyValue.trim()) {
      Alert.alert('Missing Fields', 'Please enter a key name and PEM block.');
      return;
    }
    try {
      const normalized = normalizePublicKey(keyValue);
      await addPublicKey(keyName.trim(), normalized);
      setKeyName('');
      setKeyValue('');
      await refresh();
      Alert.alert('Saved', `Public key "${keyName.trim()}" added to local storage.`);
    } catch (err: any) {
      Alert.alert('Invalid PEM', err.message || 'Key parsing failed');
    }
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
    try {
      const res = await fetch(`${apiBaseUrl}/app/v1/keys/jwks`, {
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
        Alert.alert('Connection Failed', `Could not reach ${apiBaseUrl}/app/v1/keys/jwks`);
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

                    <Text color={MUTED} fontSize="$2xs" textAlign="center">
                      — OR ADD KEY MANUALLY —
                    </Text>

                    <Input variant="outline" size="sm" borderColor="#334155">
                      <InputField
                        value={keyName}
                        onChangeText={setKeyName}
                        placeholder="Key alias (e.g. Master Verification Key)"
                        placeholderTextColor="#64748b"
                        color="#f8fafc"
                      />
                    </Input>
                    <Input variant="outline" size="sm" borderColor="#334155">
                      <InputField
                        value={keyValue}
                        onChangeText={setKeyValue}
                        placeholder="Public key PEM (-----BEGIN PUBLIC KEY----- ...)"
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
          {/* TAB 3: NETWORK / API */}
          {/* ======================================================== */}
          {activeTab === 'NETWORK' ? (
            <Box borderWidth={2} borderColor={YELLOW} borderRadius="$xl" bg={PANEL} p="$4">
              <Text color="#f8fafc" fontSize="$lg" fontWeight="800" mb="$2">
                Server API Configuration
              </Text>
              <Text color={MUTED} fontSize="$xs" mb="$3">
                Used at Checkout to transfer bulk scans and complete shifts.
              </Text>
              <Input variant="outline" size="md" borderColor="#334155" mb="$3">
                <InputField
                  value={serverUrl}
                  onChangeText={setServerUrl}
                  placeholder="http://10.0.2.2:8000"
                  placeholderTextColor="#64748b"
                  color="#f8fafc"
                />
              </Input>
              <Button
                bg={YELLOW}
                borderRadius="$md"
                onPress={async () => {
                  await setApiBaseUrl(serverUrl);
                  Alert.alert('Saved', `API URL set to: ${serverUrl}`);
                }}
              >
                <ButtonText color={BLACK} fontWeight="900">
                  Save Configuration
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
                    const ok = await refreshPermissions();
                    Alert.alert(
                      ok ? 'Permissions Synced' : 'Sync Unavailable',
                      ok
                        ? 'Updated user permissions from server.'
                        : 'Could not reach server. Using current token permissions.',
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
});
