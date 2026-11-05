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
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  DownloadCloud,
  Flashlight,
  FlashlightOff,
  Key,
  LogIn,
  LogOut,
  QrCode,
  RefreshCw,
  Server,
  ShieldCheck,
} from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { PublicKeyModal } from '../components/PublicKeyModal';
import { RootCaModal } from '../components/RootCaModal';
import { useAuth } from '../core/authContext';
import {
  addPublicKey,
  getAppSetting,
  getPendingScans,
  getPublicKeys,
  markScansAsSynced,
  setAppSetting,
} from '../core/db';
import {
  buildApiUrl,
  isLikelyPublicKeyPayload,
  normalizeApiBaseUrl,
  parsePublicKeyPayload,
  parseRootCaPayload,
  verifyJwtAgainstPublicKey,
} from '../core/jwt';
import { PublicKeyRecord } from '../core/types';

const BLACK = '#07111d';
const PANEL = '#0f172a';
const PANEL_ALT = '#111c2e';
const BORDER = '#1e293b';
const YELLOW = '#facc15';
const MUTED = '#94a3b8';
const FAIL_COLOR = '#ef4444';
const PASS_COLOR = '#22c55e';

export default function LoginPage() {
  const { login, apiBaseUrl, setApiBaseUrl, rootCaCert, setRootCaCert } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const [isTorchOn, setIsTorchOn] = useState<boolean>(false);
  const { height } = useWindowDimensions();
  const cameraBoxHeight = Math.min(290, Math.max(210, height * 0.32));

  const [publicKeys, setPublicKeys] = useState<PublicKeyRecord[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [scanCooldown, setScanCooldown] = useState<boolean>(true);
  const [showConfigOptions, setShowConfigOptions] = useState<boolean>(false);

  const [completedShiftPrompt, setCompletedShiftPrompt] = useState<{
    token: string;
    payload: any;
    keyId?: number;
    shiftId: string;
    operator: string;
  } | null>(null);
  const [isStartingNewShift, setIsStartingNewShift] = useState<boolean>(false);

  const [activeShiftPrompt, setActiveShiftPrompt] = useState<{
    token: string;
    payload: any;
    keyId?: number;
    shiftId: string;
    operator: string;
    pendingScansCount: number;
    wasOfflineCheckout: boolean;
    isOffline?: boolean;
  } | null>(null);
  const [isProcessingCheckout, setIsProcessingCheckout] = useState<boolean>(false);

  // 2.5 second scan cooldown on mount to prevent accidental instant re-scans after checkout
  useEffect(() => {
    const t = setTimeout(() => setScanCooldown(false), 2500);
    return () => clearTimeout(t);
  }, []);

  // Modals
  const [keyPickerVisible, setKeyPickerVisible] = useState(false);
  const [addKeyModalVisible, setAddKeyModalVisible] = useState(false);
  const [addKeyQrMode, setAddKeyQrMode] = useState(false);
  const [addKeyScanLock, setAddKeyScanLock] = useState(false);
  const [serverModalVisible, setServerModalVisible] = useState(false);
  const [rootCaQrMode, setRootCaQrMode] = useState(false);
  const [rootCaScanLock, setRootCaScanLock] = useState(false);
  const [rootCaModalVisible, setRootCaModalVisible] = useState(false);

  // Form states
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyPem, setNewKeyPem] = useState('');
  const [scannedKeyFormat, setScannedKeyFormat] = useState<string | null>(null);
  const [serverUrlInput, setServerUrlInput] = useState(apiBaseUrl);
  const [rootCaInput, setRootCaInput] = useState(rootCaCert);
  const [scannedCaFormat, setScannedCaFormat] = useState<string | null>(null);
  const [isFetchingServerKeys, setIsFetchingServerKeys] = useState(false);

  useEffect(() => {
    setServerUrlInput(apiBaseUrl);
  }, [apiBaseUrl]);

  useEffect(() => {
    setRootCaInput(rootCaCert);
  }, [rootCaCert]);

  const selectedKey = publicKeys.find((k: PublicKeyRecord) => k.id === selectedKeyId) || publicKeys[0] || null;

  const loadKeys = async (): Promise<PublicKeyRecord[]> => {
    try {
      const keys = await getPublicKeys();
      setPublicKeys(keys);
      if (keys.length > 0 && !selectedKeyId) {
        setSelectedKeyId(keys[0].id);
      }
      return keys;
    } catch (e) {
      console.warn('Error loading keys in login:', e);
      return [];
    }
  };

  const handleFetchServerKeys = async (silent: boolean = false): Promise<PublicKeyRecord[]> => {
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
          if (!silent) {
            Alert.alert('No Keys Found', 'Server returned 0 active keys in JWKS.');
          }
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
          const updated = await loadKeys();
          if (updated.length > 0 && !selectedKeyId) {
            setSelectedKeyId(updated[0].id);
          }
          if (!silent) {
            Alert.alert('Keys Updated', `Successfully fetched and synced ${addedCount} public key(s) from server.`);
          }
          return updated;
        }
      } else {
        if (!silent) {
          Alert.alert(
            'Connection Failed',
            `Could not reach ${targetJwksUrl}. Please check network or API URL.`,
          );
        }
      }
    } catch (e: any) {
      if (!silent) {
        Alert.alert('Error', e.message || 'Failed connecting to server');
      }
    } finally {
      setIsFetchingServerKeys(false);
    }
    return publicKeys;
  };

  useEffect(() => {
    void (async () => {
      const loaded = await loadKeys();
      // Auto-fetch from server if no keys currently stored in SQLite
      if (!loaded || loaded.length === 0) {
        await handleFetchServerKeys(true);
      }
    })();
  }, [apiBaseUrl]);

  const handleBarcodeScanned = async ({ data }: { data: string }) => {
    if (isVerifying) return;
    setErrorMessage(null);
    setSuccessMessage(null);

    setIsVerifying(true);
    try {
      const token = data.trim();

      // Auto-detect if the operator scanned a Public Key QR directly
      if (isLikelyPublicKeyPayload(token)) {
        const parsed = parsePublicKeyPayload(token, newKeyName);
        setNewKeyPem(parsed.pem);
        if (!newKeyName.trim() || parsed.detectedFormat === 'JSON Bundle') {
          setNewKeyName(parsed.suggestedName);
        }
        setScannedKeyFormat(parsed.detectedFormat);
        setAddKeyQrMode(false);
        setAddKeyModalVisible(true);
        setIsVerifying(false);
        return;
      }

      let keyToUse = selectedKey;
      let result = keyToUse
        ? await verifyJwtAgainstPublicKey(token, keyToUse.public_key_string)
        : { valid: false, reason: 'No key selected', status: 'fail' as const };

      // Fallback: If verification failed against selectedKey due to key mismatch (NOT expired), try other local keys in SQLite
      if (!result.valid && result.errorCode !== 'EXPIRED' && publicKeys.length > 1) {
        for (const k of publicKeys) {
          if (k.id === keyToUse?.id) continue;
          const retry = await verifyJwtAgainstPublicKey(token, k.public_key_string);
          if (retry.valid && retry.payload) {
            setSelectedKeyId(k.id);
            keyToUse = k;
            result = retry;
            break;
          }
        }
      }

      // If still invalid and not expired, try auto-refetching from server API in case keys were rotated
      if (!result.valid && result.errorCode !== 'EXPIRED') {
        const freshKeys = await handleFetchServerKeys(true);
        for (const k of freshKeys) {
          const retry = await verifyJwtAgainstPublicKey(token, k.public_key_string);
          if (retry.valid && retry.payload) {
            setSelectedKeyId(k.id);
            keyToUse = k;
            result = retry;
            break;
          }
        }
      }

      // Handle Verification Failures
      if (!result.valid || !result.payload) {
        const activeKeyName = keyToUse?.name || selectedKey?.name || 'Active Public Key';

        if (result.errorCode === 'EXPIRED') {
          const reason = result.reason || 'Shift badge token has expired.';
          setErrorMessage(reason);
          Alert.alert(
            'Shift Badge Expired',
            `${reason}\n\nThis shift token cannot be used because its expiration time has passed. Please request a new shift token from your supervisor.`,
            [{ text: 'Dismiss', style: 'cancel' }],
          );
        } else if (result.errorCode === 'KEY_MISMATCH' || result.errorCode === 'INVALID_CERT') {
          const reason = result.reason || `Signature mismatch with public key "${activeKeyName}".`;
          setErrorMessage(`Key Verification Failed: ${reason}`);
          Alert.alert(
            'Key Verification Failed',
            `Failed to verify QR signature with "${activeKeyName}".\n\n${reason}\n\nTip: Tap "Refetch Keys from API" or import the matching public key certificate.`,
            [
              { text: 'Dismiss', style: 'cancel' },
              { text: 'Refetch Keys from API', onPress: () => void handleFetchServerKeys(false) },
            ],
          );
        } else {
          const reason = result.reason || 'Invalid QR code or unverified token signature.';
          setErrorMessage(reason);
          Alert.alert('Verification Error', reason, [{ text: 'Dismiss', style: 'cancel' }]);
        }

        setIsVerifying(false);
        return;
      }

      const payload = result.payload;
      if (payload.type === 'product_tag') {
        const msg = 'Scanned QR is a Product Tag, not an Operator Shift Badge. Please scan your Shift Token QR badge.';
        setErrorMessage(msg);
        Alert.alert('Wrong QR Code Type', msg, [{ text: 'OK' }]);
        setIsVerifying(false);
        return;
      }

      if (!payload.shift_id) {
        const msg = 'QR badge is missing shift_id. Please scan an active Shift Token QR generated by /app/v1/shifts/start.';
        setErrorMessage(msg);
        Alert.alert('Invalid Shift Badge', msg, [{ text: 'OK' }]);
        setIsVerifying(false);
        return;
      }

      // Check if this worker already has an active shift on the server, or if this shift is completed
      let effectiveShiftId = payload.shift_id;
      let hasActiveServerShift = false;
      let isServerCompleted = false;
      let isOffline = false;
      let isTokenRejectedByServer = false;

      try {
        const activeMeRes = await fetch(buildApiUrl(apiBaseUrl, '/shifts/active/me'), {
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => null);

        if (activeMeRes && activeMeRes.ok) {
          const activeMeData = await activeMeRes.json();
          if (activeMeData && activeMeData.id && activeMeData.status === 'active') {
            effectiveShiftId = activeMeData.id;
            hasActiveServerShift = true;
          }
        } else if (activeMeRes && activeMeRes.status === 401) {
          isTokenRejectedByServer = true;
        } else if (!activeMeRes) {
          isOffline = true;
        }

        if (!hasActiveServerShift && !isOffline && !isTokenRejectedByServer) {
          const shiftStatusRes = await fetch(buildApiUrl(apiBaseUrl, `/shifts/${payload.shift_id}`), {
            headers: { Authorization: `Bearer ${token}` },
          }).catch(() => null);

          if (shiftStatusRes && shiftStatusRes.ok) {
            const shiftData = await shiftStatusRes.json();
            if (shiftData.status === 'completed' || shiftData.status === 'revoked') {
              isServerCompleted = true;
            }
          } else if (shiftStatusRes && shiftStatusRes.status === 401) {
            isTokenRejectedByServer = true;
          } else if (!shiftStatusRes) {
            isOffline = true;
          }
        }
      } catch (e) {
        console.warn('Server shift status check deferred (offline):', e);
        isOffline = true;
      }

      if (isTokenRejectedByServer) {
        setIsVerifying(false);
        setErrorMessage(
          'Shift Token Rejected: Server reported "Invalid token". This badge was signed with an older/different key or has expired. Please generate a new active shift badge from the Web Console.',
        );
        return;
      }

      if (!hasActiveServerShift && isServerCompleted) {
        setCompletedShiftPrompt({
          token,
          payload,
          keyId: keyToUse?.id,
          shiftId: payload.shift_id,
          operator: String(payload.sub || payload.user_id),
        });
        setIsVerifying(false);
        return;
      }

      const offlineShiftId = await getAppSetting('offline_checkout_shift_id', '');
      const pendingScans = await getPendingScans(payload.user_id);
      const wasOfflineCheckout = offlineShiftId === effectiveShiftId;

      setActiveShiftPrompt({
        token,
        payload: { ...payload, shift_id: effectiveShiftId },
        keyId: keyToUse?.id,
        shiftId: effectiveShiftId,
        operator: String(payload.sub || payload.user_id),
        pendingScansCount: pendingScans.length,
        wasOfflineCheckout,
        isOffline,
      });
      setIsVerifying(false);
      return;
    } catch (err: any) {
      setErrorMessage(err.message || 'Verification exception occurred');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleResumeShift = async () => {
    if (!activeShiftPrompt) return;
    const prompt = activeShiftPrompt;
    setActiveShiftPrompt(null);
    await setAppSetting('offline_checkout_shift_id', '');
    setSuccessMessage(`Welcome back! Operator: ${prompt.operator}`);
    const updatedPayload = { ...prompt.payload, shift_id: prompt.shiftId };
    await login(prompt.token, updatedPayload, prompt.keyId);
  };

  const handleCompleteServerCheckout = async () => {
    if (!activeShiftPrompt) return;
    setIsProcessingCheckout(true);
    setErrorMessage(null);
    const prompt = activeShiftPrompt;
    try {
      if (prompt.isOffline) {
        await setAppSetting('offline_checkout_shift_id', prompt.shiftId);
        setActiveShiftPrompt(null);
        setSuccessMessage(
          `Shift #${prompt.shiftId.slice(0, 8)} checked out offline! Token cleared and shift dismissed locally.`,
        );
        return;
      }

      const pendingScans = await getPendingScans(prompt.payload.user_id);
      let transferredCount = 0;

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

        const syncUrl = buildApiUrl(apiBaseUrl, `/scans/shifts/${prompt.shiftId}/sync`);
        const syncRes = await fetch(syncUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${prompt.token}`,
          },
          body: JSON.stringify({ scans: scansData }),
        }).catch(() => null);

        if (syncRes && syncRes.ok) {
          await markScansAsSynced(pendingScans.map(s => s.id));
          transferredCount = pendingScans.length;
        }
      }

      const checkoutUrl = buildApiUrl(apiBaseUrl, `/shifts/${prompt.shiftId}/checkout`);
      let checkoutRes = await fetch(checkoutUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${prompt.token}` },
      }).catch(() => null);

      if (!checkoutRes || !checkoutRes.ok) {
        checkoutRes = await fetch(buildApiUrl(apiBaseUrl, '/shifts/checkout'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${prompt.token}` },
        }).catch(() => null);
      }

      await setAppSetting('offline_checkout_shift_id', '');
      setActiveShiftPrompt(null);
      setSuccessMessage(
        `Shift #${prompt.shiftId.slice(0, 8)} successfully checked out on server!${transferredCount > 0 ? ` (${transferredCount} scans transferred)` : ''}`,
      );
    } catch {
      await setAppSetting('offline_checkout_shift_id', prompt.shiftId);
      setActiveShiftPrompt(null);
      setSuccessMessage(
        `Network offline: Shift #${prompt.shiftId.slice(0, 8)} checked out offline locally.`,
      );
    } finally {
      setIsProcessingCheckout(false);
    }
  };

  const handleStartNewShift = async () => {
    if (!completedShiftPrompt) return;
    setIsStartingNewShift(true);
    setErrorMessage(null);
    try {
      const startRes = await fetch(buildApiUrl(apiBaseUrl, '/shifts/start'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${completedShiftPrompt.token}`,
        },
        body: JSON.stringify({
          target_user_id: completedShiftPrompt.payload.user_id,
          duration_hours: 8,
        }),
      });

      if (!startRes.ok) {
        if (startRes.status === 409) {
          const activeMeRes = await fetch(buildApiUrl(apiBaseUrl, '/shifts/active/me'), {
            headers: { Authorization: `Bearer ${completedShiftPrompt.token}` },
          }).catch(() => null);

          let activeShiftId = completedShiftPrompt.shiftId;
          if (activeMeRes && activeMeRes.ok) {
            const activeData = await activeMeRes.json();
            if (activeData?.id) activeShiftId = activeData.id;
          }

          setCompletedShiftPrompt(null);
          setActiveShiftPrompt({
            token: completedShiftPrompt.token,
            payload: { ...completedShiftPrompt.payload, shift_id: activeShiftId },
            keyId: completedShiftPrompt.keyId,
            shiftId: activeShiftId,
            operator: completedShiftPrompt.operator,
            pendingScansCount: 0,
            wasOfflineCheckout: false,
            isOffline: false,
          });
          setErrorMessage(
            `Active shift #${activeShiftId.slice(0, 8)} is already running on the server. You can Check Out now to end it, or Resume working.`,
          );
          return;
        }

        const errData = await startRes.json().catch(() => ({}));
        throw new Error(errData.detail || errData.message || `Failed to start shift: ${startRes.status}`);
      }

      const data = await startRes.json();
      if (!data.shift_token) throw new Error('Server did not return a shift token');

      let newPayload = completedShiftPrompt.payload;
      try {
        const parts = data.shift_token.split('.');
        if (parts.length >= 2) {
          const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
          const jsonStr = decodeURIComponent(
            atob(base64)
              .split('')
              .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
              .join(''),
          );
          newPayload = JSON.parse(jsonStr);
        }
      } catch {
        // Fallback
      }

      setCompletedShiftPrompt(null);
      setSuccessMessage(`New shift activated! Operator: ${newPayload.sub || newPayload.user_id}`);
      await login(data.shift_token, newPayload, completedShiftPrompt.keyId);
    } catch (err: any) {
      setErrorMessage(err.message || 'Could not start new shift on server.');
    } finally {
      setIsStartingNewShift(false);
    }
  };

  const handleAddKeyQrScanned = async ({ data }: { data: string }) => {
    if (addKeyScanLock) return;
    setAddKeyScanLock(true);
    try {
      const parsed = parsePublicKeyPayload(data, newKeyName);
      setNewKeyPem(parsed.pem);
      if (!newKeyName.trim() || parsed.detectedFormat === 'JSON Bundle') {
        setNewKeyName(parsed.suggestedName);
      }
      setScannedKeyFormat(parsed.detectedFormat);
      setAddKeyQrMode(false);
      setAddKeyModalVisible(true);
    } catch (err: any) {
      Alert.alert(
        'Invalid Key QR',
        err.message || 'Scanned QR is not a valid Public Key (JSON, Base64, or PEM).',
        [
          { text: 'Scan Again', onPress: () => setAddKeyScanLock(false) },
          {
            text: 'Cancel',
            style: 'cancel',
            onPress: () => {
              setAddKeyScanLock(false);
              setAddKeyQrMode(false);
            },
          },
        ],
      );
      return;
    }
    setAddKeyScanLock(false);
  };

  const handleRootCaQrScanned = ({ data }: { data: string }) => {
    if (rootCaScanLock) return;
    setRootCaScanLock(true);
    setRootCaQrMode(false);
    try {
      const parsed = parseRootCaPayload(data);
      setRootCaInput(parsed.pem);
      setScannedCaFormat(parsed.detectedFormat);
    } catch {
      setRootCaInput(data);
      setScannedCaFormat('Raw scan — needs review');
    }
    setRootCaModalVisible(true);
    setRootCaScanLock(false);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: BLACK }}
    >
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 24 }}>
        <VStack space="md" width="100%" maxWidth={540} alignSelf="center">
          {/* A. Compact Branding Section */}
          <HStack alignItems="center" space="md" mb="$1">
            <Image
              source={require('../assets/msi_white.png')}
              style={{ width: 42, height: 42 }}
              resizeMode="contain"
              accessibilityLabel="VeriFlow logo"
            />
            <VStack flex={1}>
              <Text color={MUTED} fontSize="$2xs" fontWeight="800" letterSpacing={1.2}>
                INDUSTRIAL VERIFICATION SYSTEM
              </Text>
              <Heading size="lg" color="#f8fafc" fontWeight="900" mt="$0.5">
                Operator Check-In
              </Heading>
              <Text fontSize="$xs" color={MUTED} mt="$0.5">
                Scan your assigned shift QR code to access VeriFlow.
              </Text>
            </VStack>
          </HStack>

          {/* B. Authentication Readiness Card */}
          <Box
            bg={PANEL}
            borderRadius="$xl"
            borderWidth={1}
            borderColor={BORDER}
            p="$3.5"
          >
            <HStack justifyContent="space-between" alignItems="center" mb="$2">
              <VStack flex={1} mr="$2">
                <Text color={MUTED} fontSize="$2xs" fontWeight="800" letterSpacing={0.5}>
                  ACTIVE LOGIN KEY
                </Text>
                <Text color="#f8fafc" fontSize="$sm" fontWeight="800" numberOfLines={1}>
                  {selectedKey ? selectedKey.name : 'No Key Selected'}
                </Text>
              </VStack>

              <Pressable
                onPress={() => setKeyPickerVisible(true)}
                style={styles.changeKeyBadge}
              >
                <HStack space="2xs" alignItems="center">
                  <Text color={YELLOW} fontSize="$2xs" fontWeight="900">
                    Change Key
                  </Text>
                  <ChevronDown size={12} color={YELLOW} />
                </HStack>
              </Pressable>
            </HStack>

            {/* Status Indicators Row */}
            <HStack space="xs" flexWrap="wrap" pt="$1" borderTopWidth={1} borderTopColor="#1e293b">
              {/* Public Key Status */}
              <Box
                bg={selectedKey ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)'}
                px="$2"
                py="$0.5"
                borderRadius="$full"
                borderWidth={1}
                borderColor={selectedKey ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}
                mr="$1"
                mb="$1"
              >
                <HStack space="2xs" alignItems="center">
                  <Box
                    w={6}
                    h={6}
                    borderRadius="$full"
                    bg={selectedKey ? PASS_COLOR : FAIL_COLOR}
                  />
                  <Text
                    color={selectedKey ? PASS_COLOR : FAIL_COLOR}
                    fontSize="$2xs"
                    fontWeight="800"
                  >
                    Public Key: {selectedKey ? 'Available' : 'Missing'}
                  </Text>
                </HStack>
              </Box>

              {/* Root CA Status */}
              <Box
                bg={rootCaCert ? 'rgba(34, 197, 94, 0.12)' : 'rgba(148, 163, 184, 0.1)'}
                px="$2"
                py="$0.5"
                borderRadius="$full"
                borderWidth={1}
                borderColor={rootCaCert ? 'rgba(34, 197, 94, 0.3)' : '#334155'}
                mr="$1"
                mb="$1"
              >
                <HStack space="2xs" alignItems="center">
                  <Box
                    w={6}
                    h={6}
                    borderRadius="$full"
                    bg={rootCaCert ? PASS_COLOR : MUTED}
                  />
                  <Text
                    color={rootCaCert ? PASS_COLOR : MUTED}
                    fontSize="$2xs"
                    fontWeight="800"
                  >
                    Root CA: {rootCaCert ? 'Custom Active' : 'System Only'}
                  </Text>
                </HStack>
              </Box>

              {/* Server Endpoint */}
              <Box
                bg="rgba(250, 204, 21, 0.1)"
                px="$2"
                py="$0.5"
                borderRadius="$full"
                borderWidth={1}
                borderColor="rgba(250, 204, 21, 0.25)"
                mb="$1"
              >
                <HStack space="2xs" alignItems="center">
                  <Box w={6} h={6} borderRadius="$full" bg={YELLOW} />
                  <Text color={YELLOW} fontSize="$2xs" fontWeight="800">
                    Server: Ready
                  </Text>
                </HStack>
              </Box>
            </HStack>

            {/* C. Secondary Configuration Actions (Accordion / Expandable) */}
            <Pressable
              onPress={() => setShowConfigOptions((prev: boolean) => !prev)}
              style={styles.expandToggle}
            >
              <HStack justifyContent="space-between" alignItems="center">
                <Text color={MUTED} fontSize="$2xs" fontWeight="700">
                  {showConfigOptions ? 'Hide Key & Server Options' : 'Configuration & Keystore Options'}
                </Text>
                {showConfigOptions ? (
                  <ChevronUp size={14} color={MUTED} />
                ) : (
                  <ChevronDown size={14} color={MUTED} />
                )}
              </HStack>
            </Pressable>

            {showConfigOptions && (
              <VStack space="xs" mt="$2" pt="$2" borderTopWidth={1} borderTopColor="#1e293b">
                <HStack space="xs">
                  <Button
                    flex={1}
                    size="xs"
                    variant="outline"
                    borderColor="#334155"
                    bg={PANEL_ALT}
                    h={38}
                    onPress={() => setAddKeyModalVisible(true)}
                  >
                    <HStack space="xs" alignItems="center">
                      <Key size={13} color={YELLOW} />
                      <ButtonText color="#cbd5e1" fontSize="$2xs" fontWeight="700">
                        Import Key
                      </ButtonText>
                    </HStack>
                  </Button>

                  <Button
                    flex={1}
                    size="xs"
                    variant="outline"
                    borderColor={addKeyQrMode ? YELLOW : '#334155'}
                    bg={addKeyQrMode ? 'rgba(250, 204, 21, 0.18)' : PANEL_ALT}
                    h={38}
                    onPress={() => {
                      setAddKeyScanLock(false);
                      setErrorMessage(null);
                      setAddKeyQrMode((prev: boolean) => !prev);
                    }}
                  >
                    <HStack space="xs" alignItems="center">
                      <QrCode size={13} color={addKeyQrMode ? YELLOW : MUTED} />
                      <ButtonText color={addKeyQrMode ? YELLOW : '#cbd5e1'} fontSize="$2xs" fontWeight="700">
                        {addKeyQrMode ? 'Cancel QR' : 'Scan Key QR'}
                      </ButtonText>
                    </HStack>
                  </Button>
                </HStack>

                <HStack space="xs">
                  <Button
                    flex={1}
                    size="xs"
                    variant="outline"
                    borderColor="#334155"
                    bg={PANEL_ALT}
                    h={38}
                    onPress={() => handleFetchServerKeys(false)}
                    isDisabled={isFetchingServerKeys}
                  >
                    {isFetchingServerKeys ? (
                      <ActivityIndicator size="small" color={YELLOW} />
                    ) : (
                      <HStack space="xs" alignItems="center">
                        <DownloadCloud size={13} color={YELLOW} />
                        <ButtonText color="#cbd5e1" fontSize="$2xs" fontWeight="700">
                          Refetch Keys
                        </ButtonText>
                      </HStack>
                    )}
                  </Button>

                  <Button
                    flex={1}
                    size="xs"
                    variant="outline"
                    borderColor="#334155"
                    bg={PANEL_ALT}
                    h={38}
                    onPress={() => setServerModalVisible(true)}
                  >
                    <HStack space="xs" alignItems="center">
                      <Server size={13} color={YELLOW} />
                      <ButtonText color="#cbd5e1" fontSize="$2xs" fontWeight="700">
                        Server API
                      </ButtonText>
                    </HStack>
                  </Button>
                </HStack>

                {/* Subtitle with active URL */}
                <Text color="#64748b" fontSize="$2xs" textAlign="center" mt="$1">
                  API: {apiBaseUrl}
                </Text>
              </VStack>
            )}
          </Box>

          {/* D. Primary QR Camera View */}
          <Box
            borderRadius="$xl"
            bg={PANEL}
            borderWidth={1}
            borderColor={
              rootCaQrMode
                ? PASS_COLOR
                : addKeyQrMode
                ? '#38bdf8'
                : errorMessage
                ? FAIL_COLOR
                : BORDER
            }
            p="$3.5"
          >
            <HStack justifyContent="space-between" alignItems="center" mb="$2">
              <HStack space="xs" alignItems="center">
                <Text color="#f8fafc" fontSize="$sm" fontWeight="800" letterSpacing={0.5}>
                  {rootCaQrMode
                    ? 'SCAN ROOT CA CERTIFICATE'
                    : addKeyQrMode
                    ? 'SCAN PUBLIC KEY QR'
                    : 'Scan Shift QR Code'}
                </Text>
              </HStack>

              {addKeyQrMode || rootCaQrMode ? (
                <Pressable
                  onPress={() => {
                    setAddKeyQrMode(false);
                    setAddKeyScanLock(false);
                    setRootCaQrMode(false);
                    setRootCaScanLock(false);
                  }}
                  style={styles.cancelModeBadge}
                >
                  <Text color={YELLOW} fontSize="$2xs" fontWeight="800">
                    ✕ Shift Mode
                  </Text>
                </Pressable>
              ) : null}
            </HStack>

            {addKeyQrMode && (
              <Input variant="outline" size="sm" borderColor="#334155" mb="$2">
                <InputField
                  value={newKeyName}
                  onChangeText={setNewKeyName}
                  placeholder="Key alias (optional, auto-detected from QR)"
                  placeholderTextColor="#64748b"
                  color="#f8fafc"
                />
              </Input>
            )}

            {/* Camera Viewport Container */}
            <Box
              h={cameraBoxHeight}
              borderRadius="$lg"
              overflow="hidden"
              bg="#050914"
              position="relative"
              borderWidth={1}
              borderColor="#334155"
            >
              {permission?.granted ? (
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  enableTorch={isTorchOn}
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={
                    isVerifying ||
                    scanCooldown ||
                    Boolean(completedShiftPrompt) ||
                    Boolean(activeShiftPrompt) ||
                    addKeyModalVisible ||
                    serverModalVisible ||
                    addKeyScanLock ||
                    rootCaScanLock
                      ? undefined
                      : rootCaQrMode
                      ? handleRootCaQrScanned
                      : addKeyQrMode
                      ? handleAddKeyQrScanned
                      : handleBarcodeScanned
                  }
                />
              ) : (
                <VStack flex={1} alignItems="center" justifyContent="center" px="$4">
                  <Text color="#f8fafc" fontSize="$sm" fontWeight="800" textAlign="center">
                    Camera permission required to scan badge.
                  </Text>
                  <Button
                    mt="$3"
                    bg={YELLOW}
                    size="sm"
                    onPress={() => requestPermission()}
                  >
                    <ButtonText color={BLACK} fontWeight="800">
                      Grant Permission
                    </ButtonText>
                  </Button>
                </VStack>
              )}

              {/* Torch Toggle */}
              {permission?.granted && (
                <Pressable
                  position="absolute"
                  top={10}
                  right={10}
                  zIndex={10}
                  onPress={() => setIsTorchOn((prev: boolean) => !prev)}
                  bg={isTorchOn ? YELLOW : 'rgba(5, 9, 20, 0.75)'}
                  p="$2"
                  borderRadius="$md"
                  borderWidth={1}
                  borderColor={isTorchOn ? YELLOW : 'rgba(255, 255, 255, 0.2)'}
                  alignItems="center"
                  justifyContent="center"
                >
                  {isTorchOn ? (
                    <Flashlight size={16} color={BLACK} />
                  ) : (
                    <FlashlightOff size={16} color="#f8fafc" />
                  )}
                </Pressable>
              )}

              {/* Aiming Reticle Frame */}
              <View style={styles.reticleOverlay} pointerEvents="none">
                <View style={styles.reticleBox}>
                  {/* Corner brackets */}
                  <View style={[styles.corner, styles.cornerTL]} />
                  <View style={[styles.corner, styles.cornerTR]} />
                  <View style={[styles.corner, styles.cornerBL]} />
                  <View style={[styles.corner, styles.cornerBR]} />
                </View>
              </View>

              {/* Verification Loading Overlay */}
              {isVerifying && (
                <Box
                  position="absolute"
                  top={0}
                  left={0}
                  right={0}
                  bottom={0}
                  bg="rgba(5, 9, 20, 0.85)"
                  alignItems="center"
                  justifyContent="center"
                >
                  <ActivityIndicator size="large" color={YELLOW} />
                  <Text color={YELLOW} fontWeight="800" mt="$2" fontSize="$xs">
                    Verifying RS256 Signature...
                  </Text>
                </Box>
              )}
            </Box>

            <Text color={MUTED} fontSize="$xs" textAlign="center" mt="$2.5">
              Align your shift badge QR code inside the frame.
            </Text>
          </Box>

          {/* E. Authentication States & Prompts */}

          {/* Active Shift Detected Prompt */}
          {activeShiftPrompt && (
            <Box
              bg={PANEL}
              borderWidth={1}
              borderColor={activeShiftPrompt.isOffline ? '#f97316' : YELLOW}
              borderLeftWidth={4}
              borderLeftColor={activeShiftPrompt.isOffline ? '#f97316' : YELLOW}
              borderRadius="$xl"
              p="$4"
            >
              <HStack justifyContent="space-between" alignItems="center">
                <HStack space="xs" alignItems="center">
                  <AlertCircle size={16} color={activeShiftPrompt.isOffline ? '#f97316' : YELLOW} />
                  <Heading size="xs" color={activeShiftPrompt.isOffline ? '#f97316' : YELLOW} fontWeight="900" letterSpacing={0.5}>
                    {activeShiftPrompt.isOffline ? 'OFFLINE SHIFT DETECTED' : 'ACTIVE SHIFT DETECTED'}
                  </Heading>
                </HStack>

                <Box
                  bg={activeShiftPrompt.isOffline ? 'rgba(249, 115, 22, 0.2)' : 'rgba(34, 197, 94, 0.2)'}
                  px="$2"
                  py="$0.5"
                  borderRadius="$sm"
                >
                  <Text
                    color={activeShiftPrompt.isOffline ? '#f97316' : PASS_COLOR}
                    fontSize="$2xs"
                    fontWeight="800"
                  >
                    {activeShiftPrompt.isOffline ? 'OFFLINE' : 'ONLINE'}
                  </Text>
                </Box>
              </HStack>

              <Text color="#f8fafc" fontSize="$xs" fontWeight="700" mt="$2">
                Operator: <Text color={YELLOW} fontWeight="900">{activeShiftPrompt.operator}</Text> · Shift #{activeShiftPrompt.shiftId.slice(0, 8)}
              </Text>

              <Text color="#cbd5e1" fontSize="$xs" mt="$1" lineHeight={18}>
                {activeShiftPrompt.isOffline
                  ? 'Server unreachable (offline mode).'
                  : activeShiftPrompt.wasOfflineCheckout
                  ? 'Previously checked out offline on this device.'
                  : 'This shift is currently open on the server.'}
                {activeShiftPrompt.pendingScansCount > 0
                  ? ` Found ${activeShiftPrompt.pendingScansCount} local scan record(s) pending sync.`
                  : ''}
              </Text>

              <HStack space="xs" mt="$3">
                <Button
                  flex={1}
                  size="sm"
                  variant="outline"
                  borderColor={FAIL_COLOR}
                  bg="rgba(239, 68, 68, 0.12)"
                  h={46}
                  onPress={handleCompleteServerCheckout}
                  isDisabled={isProcessingCheckout}
                >
                  {isProcessingCheckout ? (
                    <ActivityIndicator size="small" color={FAIL_COLOR} />
                  ) : (
                    <HStack space="xs" alignItems="center">
                      <LogOut size={14} color={FAIL_COLOR} />
                      <ButtonText color={FAIL_COLOR} fontSize="$xs" fontWeight="900">
                        {activeShiftPrompt.isOffline ? 'Offline Checkout' : 'Check Out Shift'}
                      </ButtonText>
                    </HStack>
                  )}
                </Button>

                <Button
                  flex={1}
                  size="sm"
                  bg={YELLOW}
                  h={46}
                  onPress={handleResumeShift}
                  isDisabled={isProcessingCheckout}
                >
                  <HStack space="xs" alignItems="center">
                    <LogIn size={14} color={BLACK} />
                    <ButtonText color={BLACK} fontSize="$xs" fontWeight="900">
                      Login & Continue
                    </ButtonText>
                  </HStack>
                </Button>
              </HStack>

              <Button
                size="xs"
                variant="outline"
                borderColor="#334155"
                mt="$2"
                onPress={() => setActiveShiftPrompt(null)}
                isDisabled={isProcessingCheckout}
              >
                <ButtonText color="#94a3b8" fontSize="$2xs">
                  Dismiss / Scan Other Badge
                </ButtonText>
              </Button>
            </Box>
          )}

          {/* Completed Shift Prompt */}
          {completedShiftPrompt && (
            <Box
              bg={PANEL}
              borderWidth={1}
              borderColor={YELLOW}
              borderLeftWidth={4}
              borderLeftColor={YELLOW}
              borderRadius="$xl"
              p="$4"
            >
              <Text color={YELLOW} fontWeight="900" fontSize="$sm">
                Shift #{completedShiftPrompt.shiftId.slice(0, 8)} Has Ended
              </Text>
              <Text color="#cbd5e1" fontSize="$xs" mt="$1">
                Operator {completedShiftPrompt.operator} has already checked out of this shift.
              </Text>

              <HStack space="xs" mt="$3">
                <Button
                  flex={1}
                  size="sm"
                  variant="outline"
                  borderColor="#475569"
                  h={46}
                  onPress={() => setCompletedShiftPrompt(null)}
                >
                  <ButtonText color="#cbd5e1">Dismiss</ButtonText>
                </Button>
                <Button
                  flex={1.5}
                  size="sm"
                  bg={YELLOW}
                  h={46}
                  onPress={handleStartNewShift}
                  isDisabled={isStartingNewShift}
                >
                  <ButtonText color={BLACK} fontWeight="900">
                    {isStartingNewShift ? 'Starting...' : 'Start New Shift'}
                  </ButtonText>
                </Button>
              </HStack>
            </Box>
          )}

          {/* Error Message Card */}
          {errorMessage && (
            <Box
              bg="rgba(239, 68, 68, 0.12)"
              borderWidth={1}
              borderColor={FAIL_COLOR}
              borderLeftWidth={4}
              borderLeftColor={FAIL_COLOR}
              borderRadius="$xl"
              p="$3.5"
            >
              <HStack justifyContent="space-between" alignItems="center">
                <HStack space="xs" alignItems="center" flex={1}>
                  <AlertTriangle size={16} color={FAIL_COLOR} />
                  <Heading size="xs" color={FAIL_COLOR} fontWeight="900" letterSpacing={0.5}>
                    {errorMessage.toLowerCase().includes('expired')
                      ? 'SHIFT BADGE EXPIRED'
                      : errorMessage.toLowerCase().includes('key') ||
                        errorMessage.toLowerCase().includes('signature') ||
                        errorMessage.toLowerCase().includes('certificate')
                      ? 'KEY VERIFICATION FAILED'
                      : 'VERIFICATION ERROR'}
                  </Heading>
                </HStack>
                <Pressable onPress={() => setErrorMessage(null)} p="$1">
                  <Text color="#94a3b8" fontSize="$xs" fontWeight="900">✕</Text>
                </Pressable>
              </HStack>

              <Text color="#fca5a5" fontSize="$xs" fontWeight="600" mt="$1.5" lineHeight={18}>
                {errorMessage}
              </Text>

              {errorMessage.toLowerCase().includes('key') ||
              errorMessage.toLowerCase().includes('signature') ||
              errorMessage.toLowerCase().includes('certificate') ? (
                <Button
                  size="xs"
                  variant="outline"
                  borderColor={YELLOW}
                  bg="rgba(250, 204, 21, 0.1)"
                  mt="$2.5"
                  onPress={() => void handleFetchServerKeys(false)}
                >
                  <HStack space="xs" alignItems="center">
                    <DownloadCloud size={13} color={YELLOW} />
                    <ButtonText color={YELLOW} fontSize="$2xs" fontWeight="800">
                      Refetch Keys from API
                    </ButtonText>
                  </HStack>
                </Button>
              ) : null}
            </Box>
          )}

          {/* Success Message Card */}
          {successMessage && (
            <Box
              bg="rgba(34, 197, 94, 0.12)"
              borderWidth={1}
              borderColor={PASS_COLOR}
              borderRadius="$lg"
              p="$2.5"
            >
              <HStack space="xs" alignItems="center">
                <ShieldCheck size={15} color={PASS_COLOR} />
                <Text color={PASS_COLOR} fontSize="$xs" fontWeight="700">
                  {successMessage}
                </Text>
              </HStack>
            </Box>
          )}
        </VStack>
      </ScrollView>

      {/* Select Key Modal */}
      <Modal
        visible={keyPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setKeyPickerVisible(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setKeyPickerVisible(false)}>
          <Box
            bg={PANEL}
            borderWidth={1}
            borderColor={BORDER}
            borderRadius="$xl"
            p="$4"
            width="100%"
            maxWidth={460}
          >
            <HStack justifyContent="space-between" alignItems="center" mb="$3">
              <Text color={YELLOW} fontSize="$md" fontWeight="900">
                Select Active Verification Key
              </Text>
            </HStack>

            <Button
              variant="outline"
              borderColor={YELLOW}
              size="sm"
              mb="$3"
              onPress={() => handleFetchServerKeys(false)}
              isDisabled={isFetchingServerKeys}
            >
              {isFetchingServerKeys ? (
                <ActivityIndicator size="small" color={YELLOW} />
              ) : (
                <HStack space="xs" alignItems="center">
                  <DownloadCloud size={14} color={YELLOW} />
                  <ButtonText color={YELLOW} fontSize="$xs" fontWeight="800">
                    Refetch Keys from Server API
                  </ButtonText>
                </HStack>
              )}
            </Button>

            <ScrollView style={{ maxHeight: 260 }}>
              {publicKeys.length > 0 ? (
                publicKeys.map((k: PublicKeyRecord) => (
                  <Pressable
                    key={k.id}
                    onPress={() => {
                      setSelectedKeyId(k.id);
                      setKeyPickerVisible(false);
                    }}
                  >
                    <HStack
                      justifyContent="space-between"
                      alignItems="center"
                      borderTopWidth={1}
                      borderTopColor="#1e293b"
                      py="$3"
                    >
                      <VStack flex={1}>
                        <Text color="#f8fafc" fontWeight="700" fontSize="$sm">
                          {k.name}
                        </Text>
                        <Text color={MUTED} fontSize="$2xs">
                          ID: #{k.id} · {k.created_at?.slice(0, 10)}
                        </Text>
                      </VStack>
                      {k.id === selectedKey?.id ? (
                        <Box bg="rgba(250, 204, 21, 0.15)" px="$2" py="$0.5" borderRadius="$sm">
                          <Text color={YELLOW} fontSize="$2xs" fontWeight="900">
                            ACTIVE
                          </Text>
                        </Box>
                      ) : null}
                    </HStack>
                  </Pressable>
                ))
              ) : (
                <Text color={MUTED} py="$3" textAlign="center" fontSize="$xs">
                  No public keys saved. Tap Refetch above to download.
                </Text>
              )}
            </ScrollView>

            <Button mt="$3" variant="outline" borderColor="#475569" onPress={() => setKeyPickerVisible(false)}>
              <ButtonText color="#cbd5e1">Close</ButtonText>
            </Button>
          </Box>
        </Pressable>
      </Modal>

      {/* Public Key Import Modal */}
      <PublicKeyModal
        visible={addKeyModalVisible}
        alias={newKeyName}
        onChangeAlias={setNewKeyName}
        value={newKeyPem}
        onChangeValue={setNewKeyPem}
        scannedFormat={scannedKeyFormat}
        onClose={() => {
          setScannedKeyFormat(null);
          setAddKeyModalVisible(false);
        }}
        onScanQr={() => {
          setAddKeyModalVisible(false);
          setAddKeyScanLock(false);
          setAddKeyQrMode(true);
        }}
        onSave={async (alias, pem) => {
          const insertedId = await addPublicKey(alias, pem);
          await loadKeys();
          setSelectedKeyId(insertedId);
          setNewKeyName('');
          setNewKeyPem('');
          setScannedKeyFormat(null);
          setAddKeyQrMode(false);
          setAddKeyModalVisible(false);
          setSuccessMessage(`Saved key "${alias}" and set as Active Key!`);
          Alert.alert(
            'Key Saved to Keystore',
            `Saved "${alias}" into local SQLite keystore and selected it as Active Key.`,
          );
        }}
      />

      {/* Root CA Manager Modal */}
      <RootCaModal
        visible={rootCaModalVisible}
        value={rootCaInput}
        onChangeValue={setRootCaInput}
        scannedFormat={scannedCaFormat}
        appliedCa={rootCaCert}
        onClose={() => {
          setRootCaModalVisible(false);
          setServerModalVisible(true);
        }}
        onScanQr={() => {
          setRootCaModalVisible(false);
          setAddKeyQrMode(false);
          setRootCaScanLock(false);
          setRootCaQrMode(true);
        }}
        onApply={async raw => {
          await setRootCaCert(raw.trim());
          setScannedCaFormat(null);
          setRootCaModalVisible(false);
          setServerModalVisible(true);
          Alert.alert('Root CA Applied', 'Custom Root CA is now trusted for HTTPS connections.');
        }}
        onClear={async () => {
          await setRootCaCert('');
          setScannedCaFormat(null);
        }}
      />

      {/* Server API URL & HTTPS Root CA Modal */}
      <Modal
        visible={serverModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setServerModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <Box
            bg={PANEL}
            borderWidth={1}
            borderColor={BORDER}
            borderRadius="$xl"
            p="$4"
            width="100%"
            maxWidth={480}
          >
            <HStack justifyContent="space-between" alignItems="center" mb="$1">
              <Text color={YELLOW} fontSize="$md" fontWeight="900">
                Server API & HTTPS Root CA
              </Text>
              <Text
                color={serverUrlInput.trim().toLowerCase().startsWith('https://') ? PASS_COLOR : YELLOW}
                fontSize="$2xs"
                fontWeight="900"
              >
                {serverUrlInput.trim().toLowerCase().startsWith('https://') ? 'HTTPS TLS' : 'HTTP'}
              </Text>
            </HStack>

            <Text color={MUTED} fontSize="$2xs" mb="$3">
              Supports both HTTPS and HTTP endpoints with custom Root CA support.
            </Text>

            {/* Protocol Switcher */}
            <HStack space="xs" mb="$3">
              <Button
                flex={1}
                size="xs"
                variant="outline"
                borderColor={serverUrlInput.trim().toLowerCase().startsWith('https://') ? PASS_COLOR : '#334155'}
                bg={serverUrlInput.trim().toLowerCase().startsWith('https://') ? 'rgba(34, 197, 94, 0.15)' : 'transparent'}
                onPress={() => {
                  const stripped = serverUrlInput.trim().replace(/^https?:\/\//i, '');
                  setServerUrlInput(`https://${stripped}`);
                }}
              >
                <ButtonText color={PASS_COLOR} fontSize="$2xs" fontWeight="900">
                  Use https://
                </ButtonText>
              </Button>
              <Button
                flex={1}
                size="xs"
                variant="outline"
                borderColor={serverUrlInput.trim().toLowerCase().startsWith('http://') ? YELLOW : '#334155'}
                bg={serverUrlInput.trim().toLowerCase().startsWith('http://') ? 'rgba(250, 204, 21, 0.12)' : 'transparent'}
                onPress={() => {
                  const stripped = serverUrlInput.trim().replace(/^https?:\/\//i, '');
                  setServerUrlInput(`http://${stripped}`);
                }}
              >
                <ButtonText color={YELLOW} fontSize="$2xs" fontWeight="900">
                  Use http://
                </ButtonText>
              </Button>
            </HStack>

            {/* URL Input */}
            <Input variant="outline" size="md" borderColor="#334155" mb="$3">
              <InputField
                value={serverUrlInput}
                onChangeText={setServerUrlInput}
                placeholder="https://veriflow.talhahub.io/api or http://10.0.2.2:8000"
                placeholderTextColor="#64748b"
                color="#f8fafc"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </Input>

            {/* Root CA summary card */}
            <Box
              bg={PANEL_ALT}
              p="$3"
              borderRadius="$lg"
              borderWidth={1}
              borderColor={rootCaCert || rootCaInput.trim() ? PASS_COLOR : '#334155'}
              mb="$3"
            >
              <HStack justifyContent="space-between" alignItems="center">
                <VStack flex={1} mr="$2">
                  <Text color="#f8fafc" fontSize="$xs" fontWeight="800">
                    Root CA Certificate
                  </Text>
                  <Text
                    color={rootCaCert ? PASS_COLOR : rootCaInput.trim() ? YELLOW : MUTED}
                    fontSize="$2xs"
                    fontWeight="700"
                  >
                    {rootCaCert
                      ? '✓ Custom Root CA applied'
                      : rootCaInput.trim()
                      ? '• Draft pending review'
                      : '• System CAs only'}
                  </Text>
                </VStack>
                <Button
                  size="xs"
                  variant="outline"
                  borderColor={YELLOW}
                  bg="rgba(250, 204, 21, 0.1)"
                  onPress={() => {
                    setServerModalVisible(false);
                    setRootCaModalVisible(true);
                  }}
                >
                  <ButtonText color={YELLOW} fontSize="$2xs" fontWeight="900">
                    Manage CA
                  </ButtonText>
                </Button>
              </HStack>
            </Box>

            <HStack space="sm" justifyContent="flex-end">
              <Button variant="outline" borderColor="#475569" onPress={() => setServerModalVisible(false)}>
                <ButtonText color="#cbd5e1">Cancel</ButtonText>
              </Button>
              <Button
                bg={YELLOW}
                onPress={async () => {
                  try {
                    const normalizedUrl = normalizeApiBaseUrl(serverUrlInput);
                    if (!normalizedUrl) {
                      Alert.alert('Invalid URL', 'Please enter a valid http:// or https:// Server API URL.');
                      return;
                    }
                    await setApiBaseUrl(normalizedUrl);
                    setServerUrlInput(normalizedUrl);
                    let appliedToNative = false;
                    if (rootCaInput.trim()) {
                      appliedToNative = await setRootCaCert(rootCaInput.trim());
                    } else {
                      await setRootCaCert('');
                    }
                    setScannedCaFormat(null);
                    setServerModalVisible(false);
                    if (rootCaInput.trim() && !appliedToNative) {
                      Alert.alert(
                        'Root CA Notice',
                        'Root CA saved. Because the app is running in Expo Go without compiled native TLS hooks, install talhaRootCA.crt in Android Settings -> Security -> Install Certificate -> CA certificate.',
                      );
                    }
                    await handleFetchServerKeys(false);
                  } catch (err: any) {
                    Alert.alert('Root CA Error', err.message || 'Invalid Root CA certificate.');
                  }
                }}
              >
                <ButtonText color={BLACK} fontWeight="900">
                  Save & Refetch
                </ButtonText>
              </Button>
            </HStack>
          </Box>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  changeKeyBadge: {
    backgroundColor: 'rgba(250, 204, 21, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(250, 204, 21, 0.35)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  expandToggle: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  cancelModeBadge: {
    backgroundColor: 'rgba(250, 204, 21, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  reticleOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticleBox: {
    width: 175,
    height: 175,
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderColor: YELLOW,
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderTopLeftRadius: 6,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderTopRightRadius: 6,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderBottomLeftRadius: 6,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderBottomRightRadius: 6,
  },
});
