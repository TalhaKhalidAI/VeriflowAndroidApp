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
import { router, useFocusEffect } from 'expo-router';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Copy,
  Database,
  Flashlight,
  FlashlightOff,
  Key,
  Lock,
  LogOut,
  QrCode,
  ShieldAlert,
  SlidersHorizontal,
  X,
  XCircle
} from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  Dimensions,
  Modal,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import { useAuth } from '../core/authContext';
import {
  addPublicKey,
  upsertPublicKey,
  addScanToQueue,
  getInventoryItems,
  getPublicKeys,
  isScanAlreadyInQueue,
} from '../core/db';
import {
  RuleCheck,
  buildApiUrl,
  extractJwtPayload,
  isLikelyPublicKeyPayload,
  parsePublicKeyPayload,
  verifyJwtAgainstPublicKey,
} from '../core/jwt';
import { InventoryRecord, PublicKeyRecord, VerificationResult } from '../core/types';

const BLACK = '#07111d';
const PANEL = '#0f172a';
const PANEL_ALT = '#111c2e';
const BORDER = '#1e293b';
const YELLOW = '#facc15';
const MUTED = '#94a3b8';
const PASS_COLOR = '#22c55e';
const FAIL_COLOR = '#ef4444';

function translateErrorReason(result: VerificationResult): string {
  if (result.valid) {
    return 'RS256 cryptographic signature and claims verified successfully.';
  }
  const reason = result.reason || '';
  if (result.errorCode === 'EXPIRED' || reason.toLowerCase().includes('expired')) {
    return 'Token Expired: Signature is valid, but the timestamp on this tag has expired.';
  }
  if (result.errorCode === 'KEY_MISMATCH' || reason.toLowerCase().includes('mismatch')) {
    return 'Key Mismatch: Scanned token was signed with a key not matching active public key.';
  }
  if (result.errorCode === 'CLAIM_MISMATCH') {
    return reason || 'Rule Violation: Product attributes do not match required inventory rule.';
  }
  if (reason.toLowerCase().includes('duplicate')) {
    return 'Duplicate Item: This barcode was already scanned during the current shift.';
  }
  return reason || 'Verification Failed: Unrecognized barcode or invalid signature.';
}

export default function ScannerPage() {
  const { session, hasPermission, isShiftExpired, isStrictRules, isStrictKey, strictKeyId, strictKeyKid, ruleMatchMode, apiBaseUrl } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();

  const canScan = hasPermission('scans.create') && !isShiftExpired;

  // Keystore & Rules state
  const [publicKeys, setPublicKeys] = useState<PublicKeyRecord[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(null);
  const [inventoryRules, setInventoryRules] = useState<InventoryRecord[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<number | 'ALL' | 'ANY' | null>(null);

  // Camera state
  const [isTorchOn, setIsTorchOn] = useState<boolean>(false);
  const [isScreenFocused, setIsScreenFocused] = useState<boolean>(true);
  const scanLockRef = useRef<boolean>(false);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);

  // Verification Result Sheet State
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [scannedJwtRaw, setScannedJwtRaw] = useState<string>('');
  const [showRawClaims, setShowRawClaims] = useState<boolean>(false);
  const [copiedToken, setCopiedToken] = useState<boolean>(false);

  // Selectors Modals
  const [keyPickerVisible, setKeyPickerVisible] = useState<boolean>(false);
  const [rulePickerVisible, setRulePickerVisible] = useState<boolean>(false);

  const selectedKey = publicKeys.find((k: PublicKeyRecord) => k.id === selectedKeyId) || publicKeys[0] || null;
  const selectedRule =
    typeof selectedRuleId === 'number'
      ? inventoryRules.find((r: InventoryRecord) => r.id === selectedRuleId) || null
      : null;

  const loadDependencies = useCallback(async () => {
    try {
      let [keys, rules] = await Promise.all([getPublicKeys(), getInventoryItems()]);

      const targetId = strictKeyId ? String(strictKeyId).toLowerCase().trim() : '';
      const targetKid = strictKeyKid ? String(strictKeyKid).toLowerCase().trim() : '';

      const findMatch = (list: PublicKeyRecord[]) => {
        if (!isStrictKey || (!targetId && !targetKid)) return null;
        return (
          list.find((k: PublicKeyRecord) => {
            const nameLower = k.name.toLowerCase();
            return (
              (targetId && String(k.id) === targetId) ||
              (targetId && nameLower.includes(targetId)) ||
              (targetKid && nameLower.includes(targetKid))
            );
          }) || null
        );
      };

      let matchedStrict = findMatch(keys);

      // If strict key is enforced but not found in local SQLite, auto-sync latest JWKS from server API
      if (isStrictKey && !matchedStrict && apiBaseUrl) {
        try {
          const targetJwksUrl = buildApiUrl(apiBaseUrl, '/keys/jwks');
          const res = await fetch(targetJwksUrl, { headers: { Accept: 'application/json' } }).catch(() => null);
          if (res && res.ok) {
            const jwks = await res.json();
            const serverKeys = jwks.keys || [];
            for (const k of serverKeys) {
              const pem =
                k.public_key ||
                (k.x5c && k.x5c[0]
                  ? `-----BEGIN PUBLIC KEY-----\n${k.x5c[0]}\n-----END PUBLIC KEY-----`
                  : null);
              if (pem) {
                const keyAlias = `${k.name || 'Server Key'} (kid: ${k.kid || ''}) [id: ${k.id || ''}]`;
                await upsertPublicKey(keyAlias, pem);
              }
            }
            keys = await getPublicKeys();
            matchedStrict = findMatch(keys);
          }
        } catch (fetchErr) {
          console.warn('Auto-sync JWKS for strict key in scanner failed:', fetchErr);
        }
      }

      setPublicKeys(keys);

      setSelectedKeyId((current: number | null) => {
        // If strict key policy is active, strictly bind to the matched strict key
        if (matchedStrict) {
          return matchedStrict.id;
        }
        if (isStrictKey && keys.length > 0) {
          return keys[0].id;
        }
        // Preserve user's manually chosen key if it exists in loaded keys
        if (current !== null && keys.some((k: PublicKeyRecord) => k.id === current)) {
          return current;
        }
        // Otherwise default to the session's login key if valid
        if (session?.publicKeyId && keys.some((k: PublicKeyRecord) => k.id === session.publicKeyId)) {
          return session.publicKeyId;
        }
        return keys.length > 0 ? keys[0].id : null;
      });

      setInventoryRules(rules);
      setSelectedRuleId((prev) => {
        if (isStrictRules && rules.length > 0) {
          return ruleMatchMode === 'any' ? 'ANY' : 'ALL';
        }
        if (prev !== null && prev !== 'ALL' && prev !== 'ANY' && rules.some((r: InventoryRecord) => r.id === prev)) {
          return prev;
        }
        if (prev === null) {
          return null;
        }
        return rules.length > 0 ? (ruleMatchMode === 'any' ? 'ANY' : 'ALL') : null;
      });
    } catch (e) {
      console.warn('Error loading scanner dependencies:', e);
    }
  }, [session?.publicKeyId, isStrictKey, strictKeyId, strictKeyKid, isStrictRules, ruleMatchMode, apiBaseUrl]);

  useFocusEffect(
    useCallback(() => {
      setIsScreenFocused(true);
      void loadDependencies();
      return () => {
        setIsScreenFocused(false);
        setIsTorchOn(false);
      };
    }, [loadDependencies]),
  );

  const handleBarcodeScanned = async ({ data }: { data: string }) => {
    if (scanLockRef.current || isVerifying || result || isShiftExpired) return;
    scanLockRef.current = true;
    setIsVerifying(true);
    setScannedJwtRaw(data.trim());

    // Auto-detect if scanned QR is a Public Key rather than an item tag
    if (isLikelyPublicKeyPayload(data.trim())) {
      if (!hasPermission('keys.create')) {
        Alert.alert(
          'Public Key Detected',
          'Scanned QR is a Public Key, but your shift token lacks "keys.create" permission.',
        );
      } else {
        try {
          const parsed = parsePublicKeyPayload(data.trim());
          const insertedId = await addPublicKey(parsed.suggestedName, parsed.pem);
          await loadDependencies();
          setSelectedKeyId(insertedId);
          Alert.alert(
            'Public Key Added to Keystore',
            `Saved "${parsed.suggestedName}" into local SQLite keystore and selected it as active verification key.`,
          );
        } catch (e: any) {
          Alert.alert('Invalid Key QR', e?.message || 'Could not parse public key.');
        }
      }
      setIsVerifying(false);
      scanLockRef.current = false;
      return;
    }

    if (!selectedKey) {
      const errRes: VerificationResult = {
        valid: false,
        status: 'fail',
        reason: 'No public key available for RS256 verification. Import a key in Settings or Login.',
      };
      setResult(errRes);
      setIsVerifying(false);
      return;
    }

    try {
      let rulesToCheck: RuleCheck[] | undefined;
      let effectiveMatchMode: 'all' | 'any' = ruleMatchMode;

      if (isStrictRules && inventoryRules.length > 0) {
        rulesToCheck = inventoryRules.map((r: InventoryRecord) => ({
          ruleName: r.inventory_name,
          matchingClaimKey: r.matching_claim_key,
          expectedValue: r.expected_value,
        }));
        effectiveMatchMode = ruleMatchMode;
      } else if (selectedRuleId === 'ALL' && inventoryRules.length > 0) {
        rulesToCheck = inventoryRules.map((r: InventoryRecord) => ({
          ruleName: r.inventory_name,
          matchingClaimKey: r.matching_claim_key,
          expectedValue: r.expected_value,
        }));
        effectiveMatchMode = 'all';
      } else if (selectedRuleId === 'ANY' && inventoryRules.length > 0) {
        rulesToCheck = inventoryRules.map((r: InventoryRecord) => ({
          ruleName: r.inventory_name,
          matchingClaimKey: r.matching_claim_key,
          expectedValue: r.expected_value,
        }));
        effectiveMatchMode = 'any';
      } else if (selectedRule) {
        rulesToCheck = [
          {
            ruleName: selectedRule.inventory_name,
            matchingClaimKey: selectedRule.matching_claim_key,
            expectedValue: selectedRule.expected_value,
          },
        ];
        effectiveMatchMode = 'all';
      }

      const extractedPayload = extractJwtPayload(data.trim());

      // Check duplicate in current shift
      const isDuplicate = await isScanAlreadyInQueue(
        data.trim(),
        session?.userId,
        session?.shiftId,
      );

      if (isDuplicate) {
        const dupRes: VerificationResult = {
          valid: false,
          status: 'fail',
          reason: 'Duplicate Item: Already scanned in this shift.',
          errorCode: 'CLAIM_MISMATCH',
          payload: extractedPayload || undefined,
        };
        setResult(dupRes);
        setIsVerifying(false);
        return;
      }

      // Cryptographic RS256 verification
      const verifyRes = await verifyJwtAgainstPublicKey(
        data.trim(),
        selectedKey.public_key_string,
        rulesToCheck,
        undefined,
        effectiveMatchMode,
      );

      if (!verifyRes.payload && extractedPayload) {
        verifyRes.payload = extractedPayload;
      }
      setResult(verifyRes);

      // Save to SQLite offline queue
      const reasonNote =
        rulesToCheck && rulesToCheck.length > 0
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
        reason: err.message || 'Verification exception occurred.',
      };
      setResult(failRes);
    } finally {
      setIsVerifying(false);
    }
  };

  const resetScanner = () => {
    scanLockRef.current = false;
    setResult(null);
    setScannedJwtRaw('');
    setShowRawClaims(false);
    setCopiedToken(false);
  };

  const copyToClipboard = (text: string) => {
    Clipboard.setString(text);
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 2000);
  };

  if (isShiftExpired) {
    const expiredTimeStr = session?.exp
      ? new Date(session.exp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
    return (
      <Box flex={1} bg={BLACK} p="$6" alignItems="center" justifyContent="center">
        <AlertTriangle size={64} color={YELLOW} />
        <Heading color={YELLOW} size="xl" mt="$4" textAlign="center">
          Shift Authorization Expired
        </Heading>
        <Text color={MUTED} textAlign="center" mt="$2" maxWidth={360}>
          Your shift expired at{' '}
          <Text color="#f8fafc" fontWeight="700">
            {expiredTimeStr}
          </Text>
          . Scanning new items is forbidden. Please proceed to Checkout to sync your pending scans or complete offline checkout.
        </Text>
        <Button
          size="lg"
          bg={YELLOW}
          borderRadius="$lg"
          mt="$6"
          minHeight={52}
          onPress={() => router.replace('/')}
        >
          <HStack space="sm" alignItems="center">
            <LogOut size={20} color={BLACK} />
            <ButtonText color={BLACK} fontWeight="900">
              GO TO CHECKOUT
            </ButtonText>
          </HStack>
        </Button>
      </Box>
    );
  }

  if (!canScan) {
    return (
      <Box flex={1} bg={BLACK} p="$6" alignItems="center" justifyContent="center">
        <ShieldAlert size={64} color="#f87171" />
        <Heading color="#f87171" size="xl" mt="$4" textAlign="center">
          Scanner Access Restricted
        </Heading>
        <Text color={MUTED} textAlign="center" mt="$2" maxWidth={360}>
          Your shift token does not have the required{' '}
          <Text color={YELLOW} fontWeight="700">
            scans.create
          </Text>{' '}
          permission to operate the barcode scanner.
        </Text>
      </Box>
    );
  }

  // Extract clean display values from result payload
  const productId =
    result?.payload?.sub ||
    result?.payload?.id ||
    result?.payload?.product_id ||
    result?.payload?.sku ||
    'Item Tag';

  const ruleLabel =
    selectedRuleId === 'ALL'
      ? `All Rules (${inventoryRules.length})`
      : selectedRule
        ? `${selectedRule.inventory_name} (${selectedRule.matching_claim_key}==${selectedRule.expected_value})`
        : 'Standard RS256 Check';

  return (
    <View style={styles.container}>
      {/* 1. FULL VIEWPORT CAMERA CANVAS (Requirement 2 - Maximize Camera Space) */}
      {permission?.granted ? (
        isScreenFocused ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            enableTorch={isTorchOn}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={isVerifying || result ? undefined : handleBarcodeScanned}
          />
        ) : null
      ) : (
        <View style={styles.permissionFallback}>
          <QrCode size={56} color={YELLOW} />
          <Text color="#f8fafc" fontSize="$md" fontWeight="800" textAlign="center" mt="$3">
            Camera permission required
          </Text>
          <Text color={MUTED} fontSize="$xs" textAlign="center" mt="$1" maxWidth={280}>
            Please enable camera access to scan industrial QR codes and product tags.
          </Text>
          <Button size="md" bg={YELLOW} mt="$4" onPress={() => requestPermission()}>
            <ButtonText color={BLACK} fontWeight="900">
              Enable Camera
            </ButtonText>
          </Button>
        </View>
      )}

      {/* 2. INDUSTRIAL RETICLE OVERLAY (EXACT DEAD-CENTER OF SCREEN) */}
      <View style={styles.reticleCenterLayer} pointerEvents="none">
        <View style={styles.reticleBox}>
          {/* Top guidance badge floating above frame without displacing the center */}
          <View style={styles.guidanceBadge}>
            <Text style={styles.viewfinderGuidance}>
              {isVerifying ? 'VERIFYING RS256 SIGNATURE...' : 'ALIGN QR CODE INSIDE FRAME'}
            </Text>
          </View>

          {/* 4 Corner Markers */}
          <View style={[styles.cornerMarker, styles.cornerTL]} />
          <View style={[styles.cornerMarker, styles.cornerTR]} />
          <View style={[styles.cornerMarker, styles.cornerBL]} />
          <View style={[styles.cornerMarker, styles.cornerBR]} />

          {isVerifying ? (
            <View style={styles.verifyingOverlay}>
              <ActivityIndicator size="large" color={YELLOW} />
            </View>
          ) : null}
        </View>
      </View>

      {/* 3. CONTROLS OVERLAY (TOP BAR & BOTTOM OPERATOR PILL) */}
      <View style={styles.controlsOverlay} pointerEvents="box-none">
        {/* Top Control Header Bar */}
        <View style={styles.topBar}>
          <HStack space="xs" alignItems="center" flex={1}>
            {/* Key Selector Chip */}
            <Pressable
              style={[
                styles.controlPill,
                isStrictKey && { borderColor: '#38bdf8', backgroundColor: 'rgba(56, 189, 248, 0.12)' },
              ]}
              onPress={() => {
                if (isStrictKey) {
                  Alert.alert(
                    'Verification Key Enforced',
                    `This shift is locked to cryptographic verification key "${selectedKey ? selectedKey.name : (strictKeyId || 'Assigned Key')}" by Administrator Shift Policy.`,
                  );
                  return;
                }
                setKeyPickerVisible(true);
              }}
            >
              <HStack space="xs" alignItems="center">
                {isStrictKey ? <Lock size={13} color="#38bdf8" /> : <Key size={13} color={YELLOW} />}
                <Text color="#f8fafc" fontSize="$2xs" fontWeight="800" numberOfLines={1}>
                  {selectedKey ? selectedKey.name : 'Select Key'}
                </Text>
                {!isStrictKey && <ChevronDown size={12} color={YELLOW} />}
              </HStack>
            </Pressable>

            {/* Rule Selector Chip */}
            <Pressable
              style={[
                styles.controlPill,
                (isStrictRules || selectedRuleId)
                  ? { borderColor: YELLOW, backgroundColor: 'rgba(250, 204, 21, 0.18)' }
                  : null,
              ]}
              onPress={() => {
                if (isStrictRules) {
                  Alert.alert(
                    'Shift Rules Enforced',
                    `Inventory verification rules are strictly enforced by Administrator Shift Policy (${inventoryRules.length} active rule${inventoryRules.length === 1 ? '' : 's'}). Manual switching is disabled.`,
                  );
                  return;
                }
                setRulePickerVisible(true);
              }}
            >
              <HStack space="xs" alignItems="center">
                {isStrictRules ? (
                  <Lock size={13} color={YELLOW} />
                ) : (
                  <SlidersHorizontal size={13} color={selectedRuleId ? YELLOW : MUTED} />
                )}
                <Text
                  color={selectedRuleId || isStrictRules ? YELLOW : '#f8fafc'}
                  fontSize="$2xs"
                  fontWeight="800"
                  numberOfLines={1}
                >
                  {isStrictRules
                    ? `Enforced (${inventoryRules.length} · ${ruleMatchMode.toUpperCase()})`
                    : selectedRuleId === 'ALL'
                    ? 'Rules (ALL)'
                    : selectedRuleId === 'ANY'
                    ? 'Rules (ANY)'
                    : selectedRule
                      ? selectedRule.inventory_name
                      : 'Rule: None'}
                </Text>
                {!isStrictRules && <ChevronDown size={12} color={MUTED} />}
              </HStack>
            </Pressable>
          </HStack>

          {/* Torch Button */}
          {permission?.granted && (
            <Pressable
              style={[styles.torchBtn, isTorchOn && { backgroundColor: YELLOW, borderColor: YELLOW }]}
              onPress={() => setIsTorchOn((prev: boolean) => !prev)}
            >
              {isTorchOn ? <Flashlight size={18} color={BLACK} /> : <FlashlightOff size={18} color="#f8fafc" />}
            </Pressable>
          )}
        </View>

        {/* Bottom Operator Pill */}
        <View style={styles.bottomStatusPill}>
          <Text style={styles.bottomStatusText}>
            Operator: <Text style={{ color: YELLOW, fontWeight: '900' }}>{session?.sub || 'Operator'}</Text>
          </Text>
        </View>
      </View>

      {/* 3. VERIFICATION RESULT BOTTOM SHEET (Requirements 2 & 3) */}
      <Modal
        visible={Boolean(result)}
        transparent
        animationType="slide"
        onRequestClose={resetScanner}
      >
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheetContainer}>
            {/* Sheet Handle */}
            <View style={styles.sheetHandle} />

            <ScrollView showsVerticalScrollIndicator contentContainerStyle={styles.sheetContent}>
              {/* Header Status Banner (Pass / Fail) */}
              <Box
                bg={result?.status === 'pass' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.18)'}
                borderWidth={2}
                borderColor={result?.status === 'pass' ? PASS_COLOR : FAIL_COLOR}
                borderRadius="$xl"
                p="$4"
                mb="$3"
              >
                <HStack space="sm" alignItems="center">
                  {result?.status === 'pass' ? (
                    <CheckCircle2 size={32} color={PASS_COLOR} strokeWidth={2.5} />
                  ) : (
                    <XCircle size={32} color={FAIL_COLOR} strokeWidth={2.5} />
                  )}
                  <VStack flex={1}>
                    <Heading
                      size="md"
                      color={result?.status === 'pass' ? PASS_COLOR : FAIL_COLOR}
                      fontWeight="900"
                      letterSpacing={0.5}
                    >
                      {result?.status === 'pass' ? 'VERIFIED (PASS)' : 'VIOLATION / REJECTED (FAIL)'}
                    </Heading>
                    <Text color="#f8fafc" fontSize="$xs" fontWeight="700" mt="$1">
                      {result ? translateErrorReason(result) : ''}
                    </Text>
                  </VStack>
                </HStack>
              </Box>

              {/* Key Verification Data Card */}
              <Box bg={PANEL_ALT} borderWidth={1} borderColor="#334155" borderRadius="$lg" p="$3" mb="$3">
                <Text color={MUTED} fontSize="$2xs" fontWeight="800" textTransform="uppercase" mb="$2">
                  VERIFICATION AUDIT DETAILS
                </Text>

                <VStack space="xs">
                  <HStack justifyContent="space-between" alignItems="center">
                    <Text color={MUTED} fontSize="$xs">Product / Item:</Text>
                    <Text color="#f8fafc" fontSize="$xs" fontWeight="900" fontFamily="monospace">
                      {productId}
                    </Text>
                  </HStack>

                  <HStack justifyContent="space-between" alignItems="center">
                    <Text color={MUTED} fontSize="$xs">Rule Enforced:</Text>
                    <Text color={YELLOW} fontSize="$xs" fontWeight="800" numberOfLines={1}>
                      {ruleLabel}
                    </Text>
                  </HStack>

                  <HStack justifyContent="space-between" alignItems="center">
                    <Text color={MUTED} fontSize="$xs">Timestamp:</Text>
                    <Text color="#cbd5e1" fontSize="$xs" fontFamily="monospace">
                      {new Date().toLocaleTimeString()}
                    </Text>
                  </HStack>

                  <HStack justifyContent="space-between" alignItems="center">
                    <Text color={MUTED} fontSize="$xs">Local SQLite Queue:</Text>
                    <HStack space="2xs" alignItems="center">
                      <Database size={12} color={PASS_COLOR} />
                      <Text color={PASS_COLOR} fontSize="$xs" fontWeight="800">
                        Saved (Pending Sync)
                      </Text>
                    </HStack>
                  </HStack>
                </VStack>
              </Box>

              {/* Expandable Claims JSON View */}
              {result?.payload ? (
                <Box mb="$3">
                  <Pressable
                    onPress={() => setShowRawClaims((prev: boolean) => !prev)}
                    style={styles.claimsToggleBtn}
                  >
                    <HStack justifyContent="space-between" alignItems="center">
                      <Text color="#cbd5e1" fontSize="$xs" fontWeight="700">
                        {showRawClaims ? 'Hide Claims Payload' : 'Inspect Raw Decoded Claims'}
                      </Text>
                      <ChevronDown
                        size={14}
                        color="#cbd5e1"
                        style={{ transform: [{ rotate: showRawClaims ? '180deg' : '0deg' }] }}
                      />
                    </HStack>
                  </Pressable>

                  {showRawClaims ? (
                    <Box bg="#050914" p="$3" borderRadius="$md" borderWidth={1} borderColor="#1e293b" mt="$2">
                      <HStack justifyContent="flex-end" mb="$1">
                        <Pressable onPress={() => copyToClipboard(JSON.stringify(result.payload, null, 2))}>
                          <HStack space="2xs" alignItems="center">
                            <Copy size={12} color={copiedToken ? PASS_COLOR : YELLOW} />
                            <Text color={copiedToken ? PASS_COLOR : YELLOW} fontSize="$2xs" fontWeight="800">
                              {copiedToken ? 'Copied' : 'Copy JSON'}
                            </Text>
                          </HStack>
                        </Pressable>
                      </HStack>
                      <Text color="#a5f3fc" fontSize="$2xs" fontFamily="monospace">
                        {JSON.stringify(result.payload, null, 2)}
                      </Text>
                    </Box>
                  ) : null}
                </Box>
              ) : null}

              {/* 4. PROMINENT "SCAN NEXT ITEM" ACTION (Requirement 2 & 3) */}
              <Button
                size="lg"
                bg={YELLOW}
                borderRadius="$lg"
                onPress={resetScanner}
                mt="$1"
                minHeight={52}
              >
                <HStack space="sm" alignItems="center">
                  <QrCode size={22} color={BLACK} strokeWidth={2.5} />
                  <ButtonText color={BLACK} fontWeight="900" fontSize="$md">
                    SCAN NEXT ITEM
                  </ButtonText>
                </HStack>
              </Button>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Verification Key Selection Modal */}
      <Modal
        visible={keyPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setKeyPickerVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setKeyPickerVisible(false)}
          />
          <Box
            bg={PANEL}
            borderWidth={1}
            borderColor={BORDER}
            borderRadius="$xl"
            p="$4"
            width="90%"
            maxWidth={400}
            zIndex={10}
          >
            <HStack justifyContent="space-between" alignItems="center" mb="$3">
              <Text color={YELLOW} fontSize="$md" fontWeight="900">
                Select Verification Key
              </Text>
              <Pressable
                onPress={() => setKeyPickerVisible(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <X size={18} color={MUTED} />
              </Pressable>
            </HStack>

            <ScrollView style={{ maxHeight: 300 }} keyboardShouldPersistTaps="handled">
              {publicKeys.map((k: PublicKeyRecord) => {
                const isSelected = selectedKeyId === k.id;
                return (
                  <Pressable
                    key={k.id}
                    style={[
                      styles.pickerItem,
                      isSelected && styles.pickerItemActive,
                    ]}
                    onPress={() => {
                      setSelectedKeyId(k.id);
                      setKeyPickerVisible(false);
                    }}
                  >
                    <HStack justifyContent="space-between" alignItems="center">
                      <VStack flex={1} mr="$2">
                        <Text
                          color={isSelected ? YELLOW : '#f8fafc'}
                          fontSize="$xs"
                          fontWeight="800"
                        >
                          {k.name}
                        </Text>
                        <Text color={MUTED} fontSize="$2xs" mt="$0.5">
                          ID: #{k.id} · {k.created_at ? new Date(k.created_at).toLocaleDateString() : 'Active'}
                        </Text>
                      </VStack>
                      {isSelected && (
                        <CheckCircle2 size={16} color={YELLOW} />
                      )}
                    </HStack>
                  </Pressable>
                );
              })}
            </ScrollView>
          </Box>
        </View>
      </Modal>

      {/* Rule Selection Modal */}
      <Modal
        visible={rulePickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setRulePickerVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setRulePickerVisible(false)}
          />
          <Box
            bg={PANEL}
            borderWidth={1}
            borderColor={BORDER}
            borderRadius="$xl"
            p="$4"
            width="90%"
            maxWidth={400}
            zIndex={10}
          >
            <HStack justifyContent="space-between" alignItems="center" mb="$3">
              <Text color={YELLOW} fontSize="$md" fontWeight="900">
                Select Inventory Rule
              </Text>
              <Pressable
                onPress={() => setRulePickerVisible(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <X size={18} color={MUTED} />
              </Pressable>
            </HStack>

            <ScrollView style={{ maxHeight: 300 }} keyboardShouldPersistTaps="handled">
              <Pressable
                style={[styles.pickerItem, selectedRuleId === null && styles.pickerItemActive]}
                onPress={() => {
                  setSelectedRuleId(null);
                  setRulePickerVisible(false);
                }}
              >
                <HStack justifyContent="space-between" alignItems="center">
                  <Text color="#f8fafc" fontSize="$xs" fontWeight="800">
                    None (Signature Check Only)
                  </Text>
                  {selectedRuleId === null && <CheckCircle2 size={16} color={YELLOW} />}
                </HStack>
              </Pressable>

              {inventoryRules.length > 0 && (
                <Pressable
                  style={[styles.pickerItem, selectedRuleId === 'ALL' && styles.pickerItemActive]}
                  onPress={() => {
                    setSelectedRuleId('ALL');
                    setRulePickerVisible(false);
                  }}
                >
                  <HStack justifyContent="space-between" alignItems="center">
                    <Text color={YELLOW} fontSize="$xs" fontWeight="900">
                      [ALL] Enforce All {inventoryRules.length} Rules (AND)
                    </Text>
                    {selectedRuleId === 'ALL' && <CheckCircle2 size={16} color={YELLOW} />}
                  </HStack>
                </Pressable>
              )}

              {inventoryRules.length > 1 && (
                <Pressable
                  style={[styles.pickerItem, selectedRuleId === 'ANY' && styles.pickerItemActive]}
                  onPress={() => {
                    setSelectedRuleId('ANY');
                    setRulePickerVisible(false);
                  }}
                >
                  <HStack justifyContent="space-between" alignItems="center">
                    <Text color="#38bdf8" fontSize="$xs" fontWeight="900">
                      [ANY] Match Any {inventoryRules.length} Rules (OR)
                    </Text>
                    {selectedRuleId === 'ANY' && <CheckCircle2 size={16} color="#38bdf8" />}
                  </HStack>
                </Pressable>
              )}

              {inventoryRules.map((r: InventoryRecord) => {
                const isSelected = selectedRuleId === r.id;
                return (
                  <Pressable
                    key={r.id}
                    style={[styles.pickerItem, isSelected && styles.pickerItemActive]}
                    onPress={() => {
                      setSelectedRuleId(r.id);
                      setRulePickerVisible(false);
                    }}
                  >
                    <HStack justifyContent="space-between" alignItems="center">
                      <VStack flex={1} mr="$2">
                        <Text color={isSelected ? YELLOW : '#f8fafc'} fontSize="$xs" fontWeight="800">
                          {r.inventory_name}
                        </Text>
                        <Text color={YELLOW} fontSize="$2xs">
                          {r.matching_claim_key} == {r.expected_value}
                        </Text>
                      </VStack>
                      {isSelected && <CheckCircle2 size={16} color={YELLOW} />}
                    </HStack>
                  </Pressable>
                );
              })}
            </ScrollView>
          </Box>
        </View>
      </Modal>
    </View>
  );
}

const { width } = Dimensions.get('window');
const RETICLE_SIZE = Math.min(width * 0.72, 280);

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BLACK,
  },
  permissionFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  reticleCenterLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
  },
  guidanceBadge: {
    position: 'absolute',
    top: -38,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  controlsOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'android' ? 20 : 16,
    paddingBottom: Platform.OS === 'android' ? 24 : 20,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  controlPill: {
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flex: 1,
  },
  torchBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewfinderGuidance: {
    color: '#f8fafc',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 12,
    overflow: 'hidden',
  },
  reticleBox: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: RETICLE_SIZE,
    height: RETICLE_SIZE,
    marginTop: -RETICLE_SIZE / 2,
    marginLeft: -RETICLE_SIZE / 2,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(250, 204, 21, 0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cornerMarker: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderColor: YELLOW,
  },
  cornerTL: {
    top: -2,
    left: -2,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 16,
  },
  cornerTR: {
    top: -2,
    right: -2,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 16,
  },
  cornerBL: {
    bottom: -2,
    left: -2,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 16,
  },
  cornerBR: {
    bottom: -2,
    right: -2,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 16,
  },
  verifyingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(7, 17, 29, 0.8)',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
  },
  bottomStatusPill: {
    alignSelf: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  bottomStatusText: {
    color: MUTED,
    fontSize: 11,
    fontWeight: '700',
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(7, 17, 29, 0.75)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: PANEL,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: '#334155',
    maxHeight: '85%',
    paddingBottom: Platform.OS === 'ios' ? 36 : 24,
  },
  sheetHandle: {
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#475569',
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 8,
  },
  sheetContent: {
    padding: 16,
  },
  claimsToggleBtn: {
    backgroundColor: PANEL_ALT,
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    padding: 10,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(7, 17, 29, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickerItem: {
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 8,
  },
  pickerItemActive: {
    backgroundColor: 'rgba(250, 204, 21, 0.15)',
    borderColor: YELLOW,
  },
});
