import {
  Box,
  Button,
  ButtonText,
  HStack,
  Heading,
  Input,
  InputField,
  Text,
  VStack,
} from '@gluestack-ui/themed';
import {
  AlertCircle,
  CheckCircle2,
  Key,
  QrCode,
  ShieldCheck,
  Wand2,
  X,
} from 'lucide-react-native';
import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { inspectPublicKeyText, parsePublicKeyPayload } from '../core/jwt';

const BLACK = '#07111d';
const PANEL = '#0f172a';
const PANEL_ALT = '#111c2e';
const YELLOW = '#facc15';
const MUTED = '#94a3b8';
const PASS_COLOR = '#22c55e';
const FAIL_COLOR = '#ef4444';

interface Props {
  visible: boolean;
  alias: string;
  onChangeAlias: (a: string) => void;
  value: string;
  onChangeValue: (v: string) => void;
  scannedFormat?: string | null;
  onClose: () => void;
  onScanQr: () => void;
  onSave: (alias: string, pem: string) => Promise<void>;
  isLoading?: boolean;
}

function Chip({
  ok,
  warn,
  label,
}: {
  ok: boolean;
  warn?: boolean;
  label: string;
}) {
  const color = ok ? PASS_COLOR : warn ? YELLOW : FAIL_COLOR;
  return (
    <View style={[styles.chip, { borderColor: color, backgroundColor: color + '22' }]}>
      <Text color={color} fontSize="$2xs" fontWeight="900">
        {ok ? '✓' : warn ? '!' : '✕'} {label}
      </Text>
    </View>
  );
}

export function PublicKeyModal({
  visible,
  alias,
  onChangeAlias,
  value,
  onChangeValue,
  scannedFormat,
  onClose,
  onScanQr,
  onSave,
  isLoading = false,
}: Props) {
  const { height } = useWindowDimensions();
  const info = useMemo(() => inspectPublicKeyText(value, alias), [value, alias]);
  const hasText = value.trim().length > 0;

  const handleNormalize = () => {
    try {
      const parsed = parsePublicKeyPayload(value, alias);
      onChangeValue(parsed.pem);
      if (!alias.trim() && parsed.suggestedName) {
        onChangeAlias(parsed.suggestedName);
      }
      Alert.alert(
        'Key Normalized',
        `Detected: ${parsed.detectedFormat}${parsed.kid ? ` (kid: ${parsed.kid})` : ''}\nCanonical SPKI PEM formatted.`,
      );
    } catch (e: any) {
      Alert.alert('Cannot Normalize', e?.message || 'Invalid public key format.');
    }
  };

  const handleSave = async () => {
    if (!alias.trim()) {
      Alert.alert('Key Alias Required', 'Please enter a name/alias for this key.');
      return;
    }
    if (!value.trim()) {
      Alert.alert('Key Material Missing', 'Please paste or scan a Public Key certificate.');
      return;
    }
    try {
      const parsed = parsePublicKeyPayload(value, alias.trim());
      await onSave(alias.trim(), parsed.pem);
    } catch (e: any) {
      Alert.alert('Invalid Public Key', e?.message || 'Key parsing failed.');
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Box
          bg={PANEL}
          borderWidth={2}
          borderColor={YELLOW}
          borderRadius="$xl"
          p="$4"
          width="100%"
          maxWidth={540}
          maxHeight={Math.min(height * 0.9, 740)}
        >
          {/* Header */}
          <HStack justifyContent="space-between" alignItems="center" mb="$2">
            <HStack space="xs" alignItems="center" flex={1}>
              <Key size={22} color={YELLOW} />
              <VStack ml="$1" flex={1}>
                <Heading size="sm" color={YELLOW} fontWeight="900" letterSpacing={0.5}>
                  PUBLIC KEY IMPORT
                </Heading>
                <Text color={MUTED} fontSize="$2xs">
                  Review & store RS256 verification key in SQLite keystore
                </Text>
              </VStack>
            </HStack>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.7 }]}
            >
              <X size={20} color="#cbd5e1" />
            </Pressable>
          </HStack>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator
            keyboardShouldPersistTaps="handled"
          >
            {/* Scanned format banner if fresh scan */}
            {scannedFormat ? (
              <Box
                bg="rgba(34, 197, 94, 0.15)"
                borderWidth={1}
                borderColor={PASS_COLOR}
                borderRadius="$md"
                p="$2.5"
                mb="$3"
              >
                <HStack space="xs" alignItems="center">
                  <CheckCircle2 size={16} color={PASS_COLOR} />
                  <Text color={PASS_COLOR} fontSize="$xs" fontWeight="800">
                    QR Scanned: {scannedFormat}
                  </Text>
                </HStack>
              </Box>
            ) : null}

            {/* Status Inspection Summary */}
            <Box bg={PANEL_ALT} p="$3" borderRadius="$lg" borderWidth={1} borderColor="#334155" mb="$3">
              <Text color={MUTED} fontSize="$2xs" fontWeight="700" mb="$2">
                KEY INSPECTION & VALIDATION STATUS
              </Text>

              <View style={styles.chipsRow}>
                <Chip
                  ok={info.valid}
                  warn={!hasText}
                  label={
                    !hasText
                      ? 'No Key Material'
                      : info.valid
                      ? `Format: ${info.detectedFormat}`
                      : 'Format: Unknown / Invalid'
                  }
                />
                {info.kid ? <Chip ok label={`Key ID (kid): ${info.kid}`} /> : null}
                {info.bitLength ? (
                  <Chip ok label={`${info.bitLength}-bit RSA`} />
                ) : null}
                {info.valid ? <Chip ok label="RS256 Signature Capable" /> : null}
              </View>

              {info.errorMessage ? (
                <HStack space="xs" alignItems="flex-start" mt="$2">
                  <AlertCircle size={14} color={FAIL_COLOR} style={{ marginTop: 2 }} />
                  <Text color={FAIL_COLOR} fontSize="$2xs" flex={1}>
                    {info.errorMessage}
                  </Text>
                </HStack>
              ) : null}
            </Box>

            {/* Key Alias Input */}
            <VStack space="xs" mb="$3">
              <HStack justifyContent="space-between" alignItems="center">
                <Text color="#f8fafc" fontSize="$xs" fontWeight="800">
                  Key Alias (Name) <Text color={YELLOW}>*</Text>
                </Text>
                {info.suggestedAlias && info.suggestedAlias !== alias ? (
                  <Pressable onPress={() => onChangeAlias(info.suggestedAlias || '')}>
                    <Text color="#38bdf8" fontSize="$2xs" fontWeight="800">
                      Auto-fill: {info.suggestedAlias}
                    </Text>
                  </Pressable>
                ) : null}
              </HStack>
              <Input
                variant="outline"
                size="md"
                borderColor={!alias.trim() && hasText ? YELLOW : '#334155'}
                bg="#0b1220"
              >
                <InputField
                  value={alias}
                  onChangeText={onChangeAlias}
                  placeholder="e.g. Master Shift Key or Warehouse Key (Wh111)"
                  placeholderTextColor="#64748b"
                  color="#f8fafc"
                />
              </Input>
            </VStack>

            {/* Public Key Certificate Text Editor / Preview */}
            <VStack space="xs" mb="$2">
              <HStack justifyContent="space-between" alignItems="center">
                <Text color="#f8fafc" fontSize="$xs" fontWeight="800">
                  Public Key Material (PEM / JSON / Base64)
                </Text>
                <HStack space="xs">
                  {hasText ? (
                    <Pressable
                      style={styles.actionPill}
                      onPress={handleNormalize}
                    >
                      <Wand2 size={12} color={YELLOW} />
                      <Text color={YELLOW} fontSize="$2xs" fontWeight="800" ml="$1">
                        Format PEM
                      </Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    style={styles.actionPill}
                    onPress={onScanQr}
                  >
                    <QrCode size={12} color={YELLOW} />
                    <Text color={YELLOW} fontSize="$2xs" fontWeight="800" ml="$1">
                      Scan QR
                    </Text>
                  </Pressable>
                </HStack>
              </HStack>

              <TextInput
                style={[
                  styles.certInput,
                  { borderColor: info.valid ? PASS_COLOR : hasText ? FAIL_COLOR : '#334155' },
                ]}
                value={value}
                onChangeText={onChangeValue}
                placeholder="-----BEGIN PUBLIC KEY-----&#10;Paste Clean Base64, JSON bundle, or Standard PEM here...&#10;-----END PUBLIC KEY-----"
                placeholderTextColor="#64748b"
                multiline
                numberOfLines={8}
                textAlignVertical="top"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text color={MUTED} fontSize="$2xs">
                Supports: <Text color={YELLOW}>Clean Base64</Text>, <Text color={YELLOW}>JSON Key Bundle</Text> (from web dashboard), or <Text color={YELLOW}>Standard PEM</Text>.
              </Text>
            </VStack>
          </ScrollView>

          {/* Action Buttons */}
          <VStack space="xs" mt="$3" pt="$2" borderTopWidth={1} borderTopColor="#1e293b">
            <Button
              bg={YELLOW}
              onPress={handleSave}
              isDisabled={isLoading}
              size="md"
              borderRadius="$md"
            >
              {isLoading ? (
                <HStack space="xs" alignItems="center">
                  <ActivityIndicator size="small" color={BLACK} />
                  <ButtonText color={BLACK} fontWeight="900" ml="$2">
                    Saving to Keystore...
                  </ButtonText>
                </HStack>
              ) : (
                <HStack space="xs" alignItems="center">
                  <ShieldCheck size={18} color={BLACK} />
                  <ButtonText color={BLACK} fontWeight="900" ml="$1">
                    Store in Local SQLite Keystore
                  </ButtonText>
                </HStack>
              )}
            </Button>

            <HStack space="xs">
              <Button
                flex={1}
                variant="outline"
                borderColor={YELLOW}
                bg="rgba(250, 204, 21, 0.12)"
                onPress={onScanQr}
                size="sm"
                borderRadius="$md"
              >
                <HStack space="xs" alignItems="center">
                  <QrCode size={15} color={YELLOW} />
                  <ButtonText color={YELLOW} fontSize="$xs" fontWeight="900">
                    Scan Key QR (Camera)
                  </ButtonText>
                </HStack>
              </Button>

              <Button
                flex={1}
                variant="outline"
                borderColor="#64748b"
                onPress={onClose}
                size="sm"
                borderRadius="$md"
              >
                <ButtonText color="#cbd5e1" fontSize="$xs">
                  Cancel
                </ButtonText>
              </Button>
            </HStack>
          </VStack>
        </Box>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(5, 11, 20, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  scroll: {
    maxHeight: 480,
  },
  scrollContent: {
    paddingVertical: 4,
  },
  closeBtn: {
    padding: 4,
    borderRadius: 8,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  actionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(250, 204, 21, 0.12)',
    borderWidth: 1,
    borderColor: YELLOW,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  certInput: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    lineHeight: 16,
    color: '#f8fafc',
    backgroundColor: '#050914',
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    minHeight: 140,
    maxHeight: 200,
  },
});

