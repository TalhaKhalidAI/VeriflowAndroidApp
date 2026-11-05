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
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useFocusEffect } from 'expo-router';
import { ShieldAlert, CheckCircle2, XCircle, SlidersHorizontal, Flashlight, FlashlightOff } from 'lucide-react-native';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Modal, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useAuth } from '../core/authContext';
import {
  addPublicKey,
  addScanToQueue,
  getInventoryItems,
  getPublicKeys,
  isScanAlreadyInQueue,
} from '../core/db';
import {
  RuleCheck,
  verifyJwtAgainstPublicKey,
  extractJwtPayload,
  isLikelyPublicKeyPayload,
  parsePublicKeyPayload,
} from '../core/jwt';
import { InventoryRecord, PublicKeyRecord, UiMode, VerificationResult } from '../core/types';

const BLACK = '#07111d';
const PANEL = '#0f172a';
const PANEL_ALT = '#111c2e';
const YELLOW = '#facc15';
const MUTED = '#94a3b8';
const PASS_COLOR = '#22c55e';
const FAIL_COLOR = '#ef4444';

export default function ScannerPage() {
  const { session, hasPermission } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const { height } = useWindowDimensions();

  // Permissions gate
  const canScan = hasPermission('scans.create');

  // State
  const [publicKeys, setPublicKeys] = useState<PublicKeyRecord[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(null);

  // Inventory Rules state
  const [inventoryRules, setInventoryRules] = useState<InventoryRecord[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<number | 'ALL' | null>(null);
  const [isTorchOn, setIsTorchOn] = useState<boolean>(false);
  const [isScreenFocused, setIsScreenFocused] = useState<boolean>(true);

  useFocusEffect(
    useCallback(() => {
      setIsScreenFocused(true);
      void loadData();
      return () => {
        setIsScreenFocused(false);
        setIsTorchOn(false);
      };
    }, []),
  );

  // Camera & Scan state
  const scanLockRef = React.useRef<boolean>(false);
  const [hasScanned, setHasScanned] = useState<boolean>(false);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [splashResult, setSplashResult] = useState<VerificationResult | null>(null);
  const [uiMode, setUiMode] = useState<UiMode>('PASS_FAIL_MODE');

  // Picker Modals
  const [keyPickerVisible, setKeyPickerVisible] = useState(false);
  const [rulePickerVisible, setRulePickerVisible] = useState(false);

  const selectedKey = publicKeys.find(k => k.id === selectedKeyId) || publicKeys[0] || null;
  const selectedRule = typeof selectedRuleId === 'number'
    ? inventoryRules.find(r => r.id === selectedRuleId) || null
    : null;

  const loadData = async () => {
    try {
      const keys = await getPublicKeys();
      setPublicKeys(keys);
      if (session?.publicKeyId && keys.some(k => k.id === session.publicKeyId)) {
        setSelectedKeyId(session.publicKeyId);
      } else if (keys.length > 0 && !selectedKeyId) {
        setSelectedKeyId(keys[0].id);
      }

      const rules = await getInventoryItems();
      setInventoryRules(rules);
    } catch (e) {
      console.warn('Error loading scanner dependencies:', e);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleBarcodeScanned = async ({ data }: { data: string }) => {
    if (scanLockRef.current || isVerifying || hasScanned) return;
    scanLockRef.current = true;
    setHasScanned(true);
    setIsVerifying(true);

    // Auto-detect if scanned QR is a Public Key (JSON / Clean Base64 / PEM)
    if (isLikelyPublicKeyPayload(data.trim())) {
      if (!hasPermission('keys.create')) {
        Alert.alert(
          'Permission Denied',
          'Scanned QR is a Public Key, but your shift token lacks "keys.create" permission.',
        );
      } else {
        try {
          const parsed = parsePublicKeyPayload(data.trim());
          const insertedId = await addPublicKey(parsed.suggestedName, parsed.pem);
          await loadData();
          setSelectedKeyId(insertedId);
          Alert.alert(
            'Public Key Imported to Keystore',
            `Saved "${parsed.suggestedName}" into local SQLite keystore and selected it for verification.\n\nAuto-Detected Format: ${parsed.detectedFormat}`,
          );
        } catch (e: any) {
          Alert.alert('Invalid Key QR', e?.message || 'Could not parse scanned public key.');
        }
      }
      setIsVerifying(false);
      setHasScanned(false);
      scanLockRef.current = false;
      return;
    }

    if (!selectedKey) {
      const errRes: VerificationResult = {
        valid: false,
        status: 'fail',
        reason: 'No public key selected for RS256 verification',
      };
      setResult(errRes);
      setSplashResult(errRes);
      setIsVerifying(false);
      return;
    }

    try {
      let rulesToCheck: RuleCheck[] | undefined;

      if (selectedRuleId === 'ALL') {
        rulesToCheck = inventoryRules.map(r => ({
          ruleName: r.inventory_name,
          matchingClaimKey: r.matching_claim_key,
          expectedValue: r.expected_value,
        }));
      } else if (selectedRule) {
        rulesToCheck = [
          {
            ruleName: selectedRule.inventory_name,
            matchingClaimKey: selectedRule.matching_claim_key,
            expectedValue: selectedRule.expected_value,
          },
        ];
      }

      const extractedPayload = extractJwtPayload(data.trim());

      // 1. Prevent duplicate scans for the current shift (Requirement 2)
      const isDuplicate = await isScanAlreadyInQueue(
        data.trim(),
        session?.userId,
        session?.shiftId,
      );

      if (isDuplicate) {
        const dupRes: VerificationResult = {
          valid: false,
          status: 'fail',
          reason: 'Duplicate Item: Already scanned in this shift. Skipped to prevent redundancy.',
          errorCode: 'CLAIM_MISMATCH',
          payload: extractedPayload || undefined,
        };
        setResult(dupRes);
        setSplashResult(dupRes);
        setIsVerifying(false);
        return;
      }

      const verifyRes = await verifyJwtAgainstPublicKey(
        data.trim(),
        selectedKey.public_key_string,
        rulesToCheck,
      );

      if (!verifyRes.payload && extractedPayload) {
        verifyRes.payload = extractedPayload;
      }
      setResult(verifyRes);
      setSplashResult(verifyRes);

      // Save to SQLite queue
      const reasonNote = rulesToCheck && rulesToCheck.length > 0
        ? `Checked ${rulesToCheck.length} rule(s): ${verifyRes.reason}`
        : verifyRes.reason;
      await addScanToQueue(
        data.trim(),
        verifyRes.status,
        reasonNote,
        session?.userId,
        session?.shiftId,
      );
    } catch (err: any) {
      const failRes: VerificationResult = {
        valid: false,
        status: 'fail',
        reason: err.message || 'Verification exception',
      };
      setResult(failRes);
      setSplashResult(failRes);
    } finally {
      setIsVerifying(false);
    }
  };

  const resetScanner = () => {
    scanLockRef.current = false;
    setHasScanned(false);
    setResult(null);
    setSplashResult(null);
  };

  if (!canScan) {
    return (
      <Box flex={1} bg={BLACK} p="$6" alignItems="center" justifyContent="center">
        <ShieldAlert size={64} color="#f87171" />
        <Heading color="#f87171" size="xl" mt="$4" textAlign="center">
          Scanner Access Restricted
        </Heading>
        <Text color={MUTED} textAlign="center" mt="$2" maxWidth={360}>
          Your shift token does not have the required <Text color={YELLOW} fontWeight="700">scans.create</Text> permission to operate the barcode scanner.
        </Text>
      </Box>
    );
  }

  const cameraPreviewHeight = Math.min(Math.max(height * 0.32, 220), 320);

  return (
    <Box flex={1} bg={BLACK} px="$3" py="$4">
      <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        <VStack space="md" width="100%" maxWidth={540} alignSelf="center">
          {/* Public Key & Mode Selector */}
          <HStack justifyContent="space-between" alignItems="center">
            <Pressable onPress={() => setKeyPickerVisible(true)} flex={1} mr="$2">
              <Box bg={PANEL} p="$2" borderRadius="$lg" borderWidth={1} borderColor="#334155">
                <Text color={MUTED} fontSize="$xs" fontWeight="700">VERIFICATION KEY:</Text>
                <Text color={YELLOW} fontWeight="800" fontSize="$xs" numberOfLines={1}>
                  {selectedKey ? selectedKey.name : 'Select Key ⌄'}
                </Text>
              </Box>
            </Pressable>

            <Button
              size="xs"
              variant="outline"
              borderColor={YELLOW}
              onPress={() => setUiMode(m => m === 'PASS_FAIL_MODE' ? 'DATA_MODE' : 'PASS_FAIL_MODE')}
            >
              <ButtonText color={YELLOW} fontSize="$xs">
                {uiMode === 'PASS_FAIL_MODE' ? 'MODE: PASS/FAIL' : 'MODE: DATA'}
              </ButtonText>
            </Button>
          </HStack>

          {/* Optional Inventory Rule Selector (Requirement 3) */}
          <Box bg={PANEL} p="$3" borderRadius="$xl" borderWidth={2} borderColor={selectedRuleId ? YELLOW : '#334155'}>
            <HStack justifyContent="space-between" alignItems="center" mb="$1">
              <HStack space="xs" alignItems="center">
                <SlidersHorizontal size={16} color={YELLOW} />
                <Text color="#f8fafc" fontSize="$xs" fontWeight="800">
                  COMPARE WITH RULE (OPTIONAL)
                </Text>
              </HStack>
              {selectedRuleId ? (
                <Pressable onPress={() => setSelectedRuleId(null)}>
                  <Text color="#f87171" fontSize="$xs" fontWeight="700">Clear</Text>
                </Pressable>
              ) : null}
            </HStack>

            <Pressable onPress={() => setRulePickerVisible(true)}>
              <Box
                bg={PANEL_ALT}
                borderWidth={1}
                borderColor="#334155"
                borderRadius="$md"
                p="$2"
                flexDirection="row"
                justifyContent="space-between"
                alignItems="center"
              >
                <VStack flex={1} mr="$2">
                  <Text color={selectedRuleId ? YELLOW : MUTED} fontSize="$xs" fontWeight="700" numberOfLines={1}>
                    {selectedRuleId === 'ALL'
                      ? `[ALL RULES] Match all ${inventoryRules.length} rules`
                      : selectedRule
                        ? `[RULE] ${selectedRule.inventory_name} (${selectedRule.matching_claim_key} == ${selectedRule.expected_value})`
                        : 'None (Verify RS256 signature only)'}
                  </Text>
                </VStack>
                <Text color={YELLOW} fontSize="$sm">⌄</Text>
              </Box>
            </Pressable>
          </Box>

          {/* Camera Scanner View */}
          <Box
            h={cameraPreviewHeight}
            borderWidth={2}
            borderColor={result ? (result.status === 'pass' ? PASS_COLOR : FAIL_COLOR) : YELLOW}
            borderRadius="$xl"
            overflow="hidden"
            bg="#050914"
            position="relative"
          >
            {permission?.granted ? (
              isScreenFocused ? (
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  enableTorch={isTorchOn}
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={isVerifying || hasScanned ? undefined : handleBarcodeScanned}
                />
              ) : null
            ) : (
              <VStack flex={1} alignItems="center" justifyContent="center" px="$4">
                <Text color="#f8fafc" textAlign="center" mb="$2">Camera permission required</Text>
                <Button size="xs" bg={YELLOW} onPress={() => requestPermission()}>
                  <ButtonText color={BLACK} fontWeight="800">Enable Camera</ButtonText>
                </Button>
              </VStack>
            )}

            {permission?.granted && (
              <Pressable
                position="absolute"
                top={12}
                right={12}
                zIndex={10}
                onPress={() => setIsTorchOn(prev => !prev)}
                bg={isTorchOn ? YELLOW : "rgba(5, 9, 20, 0.75)"}
                p=".5"
                borderRadius=""
                borderWidth={1}
                borderColor={isTorchOn ? YELLOW : "rgba(255, 255, 255, 0.3)"}
                alignItems="center"
                justifyContent="center"
              >
                {isTorchOn ? (
                  <Flashlight size={20} color={BLACK} />
                ) : (
                  <FlashlightOff size={20} color="#f8fafc" />
                )}
              </Pressable>
            )}

            {/* Reticle */}
            <View style={styles.reticleOverlay} pointerEvents="none">
              <View style={[styles.reticleBox, result ? { borderColor: result.status === 'pass' ? PASS_COLOR : FAIL_COLOR } : null]} />
            </View>

            {isVerifying ? (
              <Box position="absolute" top={0} left={0} right={0} bottom={0} bg="rgba(0,0,0,0.7)" alignItems="center" justifyContent="center">
                <ActivityIndicator size="large" color={YELLOW} />
                <Text color={YELLOW} fontWeight="800" mt="$2">Verifying...</Text>
              </Box>
            ) : null}
          </Box>

          {/* Scan Action / Reset Button */}
          {hasScanned ? (
            <Button bg={YELLOW} borderRadius="$lg" onPress={resetScanner}>
              <ButtonText color={BLACK} fontWeight="900">
                Scan Another QR
              </ButtonText>
            </Button>
          ) : null}

          {/* Result Card */}
          {result ? (
            <Box
              bg={PANEL}
              borderWidth={2}
              borderColor={
                result.reason?.toLowerCase().includes('duplicate')
                  ? '#f59e0b'
                  : result.status === 'pass'
                  ? PASS_COLOR
                  : FAIL_COLOR
              }
              borderRadius="$xl"
              p="$4"
            >
              <HStack space="sm" alignItems="center" mb="$2">
                {result.status === 'pass' ? (
                  <CheckCircle2 size={24} color={PASS_COLOR} />
                ) : result.reason?.toLowerCase().includes('duplicate') ? (
                  <ShieldAlert size={24} color="#f59e0b" />
                ) : (
                  <XCircle size={24} color={FAIL_COLOR} />
                )}
                <Text
                  color={
                    result.reason?.toLowerCase().includes('duplicate')
                      ? '#f59e0b'
                      : result.status === 'pass'
                      ? PASS_COLOR
                      : FAIL_COLOR
                  }
                  fontSize="$xl"
                  fontWeight="900"
                >
                  {result.reason?.toLowerCase().includes('duplicate')
                    ? 'DUPLICATE (ALREADY SCANNED)'
                    : result.status.toUpperCase()}
                </Text>
              </HStack>

              <Text color="#f8fafc" fontSize="$sm" mb="$2">
                {result.reason}
              </Text>

              {uiMode === 'DATA_MODE' ? (
                <Box bg={PANEL_ALT} p="$3" borderRadius="$md" mt="$2">
                  <HStack justifyContent="space-between" alignItems="center" mb="$2">
                    <Text color={YELLOW} fontSize="$xs" fontWeight="800">
                      DECODED JWT DATA / CLAIMS:
                    </Text>
                    {result.reason?.toLowerCase().includes('duplicate') ? (
                      <Text color="#f59e0b" fontSize="$2xs" fontWeight="900">
                        [DUPLICATE SCAN]
                      </Text>
                    ) : null}
                  </HStack>
                  {result.payload ? (
                    <VStack space="xs">
                      {Object.entries(result.payload).map(([k, v]) => (
                        <HStack
                          key={k}
                          justifyContent="space-between"
                          py="$1"
                          borderBottomWidth={1}
                          borderBottomColor="#1e293b"
                        >
                          <Text color={MUTED} fontSize="$xs" fontWeight="700">
                            {k}:
                          </Text>
                          <Text
                            color="#f8fafc"
                            fontSize="$xs"
                            fontWeight="600"
                            numberOfLines={2}
                            flex={1}
                            textAlign="right"
                            ml="$2"
                          >
                            {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                          </Text>
                        </HStack>
                      ))}
                      <Box mt="$2" pt="$1">
                        <Text color="#64748b" fontSize="$2xs" fontWeight="700" mb="$1">
                          RAW JSON CLAIMS:
                        </Text>
                        <ScrollView style={{ maxHeight: 120 }}>
                          <Text color="#cbd5e1" fontSize="$xs">
                            {JSON.stringify(result.payload, null, 2)}
                          </Text>
                        </ScrollView>
                      </Box>
                    </VStack>
                  ) : (
                    <Text color={MUTED} fontSize="$xs">
                      None (Data could not be decoded as a valid JWT payload)
                    </Text>
                  )}
                </Box>
              ) : null}
            </Box>
          ) : null}
        </VStack>
      </ScrollView>

      {/* Select Key Modal */}
      <Modal visible={keyPickerVisible} transparent animationType="fade" onRequestClose={() => setKeyPickerVisible(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setKeyPickerVisible(false)}>
          <Box bg={PANEL} borderWidth={2} borderColor={YELLOW} borderRadius="$xl" p="$4" width="100%" maxWidth={460}>
            <Text color={YELLOW} fontSize="$lg" fontWeight="900" mb="$3">
              Select Public Key
            </Text>
            <ScrollView style={{ maxHeight: 260 }}>
              {publicKeys.map(k => (
                <Pressable
                  key={k.id}
                  onPress={() => {
                    setSelectedKeyId(k.id);
                    setKeyPickerVisible(false);
                  }}
                >
                  <HStack justifyContent="space-between" alignItems="center" py="$3" borderTopWidth={1} borderTopColor="#334155">
                    <Text color="#f8fafc" fontWeight="700">{k.name}</Text>
                    {k.id === selectedKey?.id ? <Text color={YELLOW} fontWeight="900" fontSize="$xs">ACTIVE</Text> : null}
                  </HStack>
                </Pressable>
              ))}
            </ScrollView>
            <Button mt="$3" variant="outline" borderColor="#64748b" onPress={() => setKeyPickerVisible(false)}>
              <ButtonText color="#cbd5e1">Close</ButtonText>
            </Button>
          </Box>
        </Pressable>
      </Modal>

      {/* Select Inventory Rule Modal */}
      <Modal visible={rulePickerVisible} transparent animationType="fade" onRequestClose={() => setRulePickerVisible(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setRulePickerVisible(false)}>
          <Box bg={PANEL} borderWidth={2} borderColor={YELLOW} borderRadius="$xl" p="$4" width="100%" maxWidth={480}>
            <Text color={YELLOW} fontSize="$lg" fontWeight="900" mb="$2">
              Select Rule to Compare With QR
            </Text>
            <Text color={MUTED} fontSize="$xs" mb="$3">
              Optionally require the scanned QR claims to match a rule stored in the local SQLite DB.
            </Text>

            <ScrollView style={{ maxHeight: 280 }}>
              {/* Option 1: None */}
              <Pressable
                onPress={() => {
                  setSelectedRuleId(null);
                  setRulePickerVisible(false);
                }}
              >
                <HStack justifyContent="space-between" alignItems="center" py="$3" borderTopWidth={1} borderTopColor="#334155">
                  <VStack>
                    <Text color="#f8fafc" fontWeight="700">None (Signature Only)</Text>
                    <Text color={MUTED} fontSize="$xs">Validate RS256 signature and expiration only</Text>
                  </VStack>
                  {selectedRuleId === null ? <Text color={YELLOW} fontWeight="900" fontSize="$xs">SELECTED</Text> : null}
                </HStack>
              </Pressable>

              {/* Option 2: All Rules */}
              {inventoryRules.length > 0 ? (
                <Pressable
                  onPress={() => {
                    setSelectedRuleId('ALL');
                    setRulePickerVisible(false);
                  }}
                >
                  <HStack justifyContent="space-between" alignItems="center" py="$3" borderTopWidth={1} borderTopColor="#334155">
                    <VStack>
                      <Text color={YELLOW} fontWeight="800">[ALL RULES] Verify All {inventoryRules.length} Rules</Text>
                      <Text color={MUTED} fontSize="$xs">Must satisfy every active inventory rule in DB</Text>
                    </VStack>
                    {selectedRuleId === 'ALL' ? <Text color={YELLOW} fontWeight="900" fontSize="$xs">SELECTED</Text> : null}
                  </HStack>
                </Pressable>
              ) : null}

              {/* Specific Rules */}
              {inventoryRules.map(r => (
                <Pressable
                  key={r.id}
                  onPress={() => {
                    setSelectedRuleId(r.id);
                    setRulePickerVisible(false);
                  }}
                >
                  <HStack justifyContent="space-between" alignItems="center" py="$3" borderTopWidth={1} borderTopColor="#334155">
                    <VStack flex={1} mr="$2">
                      <Text color="#f8fafc" fontWeight="700">{r.inventory_name}</Text>
                      <Text color={MUTED} fontSize="$xs">
                        claim: <Text color={YELLOW}>{r.matching_claim_key}</Text> == &quot;{r.expected_value}&quot;
                      </Text>
                    </VStack>
                    {selectedRuleId === r.id ? <Text color={YELLOW} fontWeight="900" fontSize="$xs">SELECTED</Text> : null}
                  </HStack>
                </Pressable>
              ))}
            </ScrollView>

            <Button mt="$3" variant="outline" borderColor="#64748b" onPress={() => setRulePickerVisible(false)}>
              <ButtonText color="#cbd5e1">Close</ButtonText>
            </Button>
          </Box>
        </Pressable>
      </Modal>

      {/* Splash Result Fullscreen Modal (Pass/Fail Mode) */}
      <Modal
        visible={Boolean(splashResult && uiMode === 'PASS_FAIL_MODE')}
        transparent
        animationType="fade"
        onRequestClose={resetScanner}
      >
        <Pressable
          style={[
            styles.splashContainer,
            { backgroundColor: splashResult?.status === 'pass' ? PASS_COLOR : FAIL_COLOR },
          ]}
          onPress={() => setSplashResult(null)}
        >
          <Text color="#ffffff" fontSize="$6xl" fontWeight="900" textAlign="center">
            {splashResult?.status === 'pass' ? 'PASS' : 'FAIL'}
          </Text>
          <Text color="#ffffff" fontSize="$lg" fontWeight="800" textAlign="center" mt="$3" px="$4">
            {splashResult?.reason}
          </Text>
          <Text color="#ffffff" fontSize="$xs" textAlign="center" mt="$6" opacity={0.8}>
            Tap anywhere to dismiss
          </Text>
        </Pressable>
      </Modal>
    </Box>
  );
}

const styles = StyleSheet.create({
  reticleOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticleBox: {
    width: 170,
    height: 170,
    borderWidth: 2,
    borderColor: YELLOW,
    borderRadius: 16,
    borderStyle: 'dashed',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  splashContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
});
