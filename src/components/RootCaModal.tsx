import { Box, Button, ButtonText, HStack, Text, VStack } from '@gluestack-ui/themed';
import { QrCode, ShieldCheck } from 'lucide-react-native';
import React, { useMemo } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { inspectRootCaText, parseRootCaPayload } from '../core/jwt';

const BLACK = '#07111d';
const PANEL = '#0f172a';
const PANEL_ALT = '#111c2e';
const YELLOW = '#facc15';
const MUTED = '#94a3b8';
const PASS_COLOR = '#22c55e';
const FAIL_COLOR = '#ef4444';

interface Props {
  visible: boolean;
  /** Current draft text of the Root CA (PEM / Base64 / JSON). */
  value: string;
  onChangeValue: (v: string) => void;
  /** Format label from the last QR scan, if any. */
  scannedFormat?: string | null;
  /** Whether a custom Root CA is currently applied on the device. */
  appliedCa: string;
  /** Closes the modal (parent decides what to show next). */
  onClose: () => void;
  /** Closes this modal and starts the inline QR camera in the parent screen. */
  onScanQr: () => void;
  /** Persist + apply the cert (receives the raw draft; parent calls setRootCaCert). */
  onApply: (raw: string) => Promise<void>;
  /** Remove the custom Root CA. */
  onClear: () => Promise<void>;
}

function Chip({ ok, warn, label }: { ok: boolean; warn?: boolean; label: string }) {
  const color = ok ? PASS_COLOR : warn ? YELLOW : FAIL_COLOR;
  return (
    <View style={[styles.chip, { borderColor: color, backgroundColor: color + '22' }]}>
      <Text color={color} fontSize="$2xs" fontWeight="900">
        {ok ? '✓' : warn ? '!' : '✕'} {label}
      </Text>
    </View>
  );
}

export function RootCaModal({
  visible,
  value,
  onChangeValue,
  scannedFormat,
  appliedCa,
  onClose,
  onScanQr,
  onApply,
  onClear,
}: Props) {
  const { height } = useWindowDimensions();
  const info = useMemo(() => inspectRootCaText(value), [value]);
  const hasText = value.trim().length > 0;

  const normalizeNow = () => {
    try {
      const parsed = parseRootCaPayload(value);
      onChangeValue(parsed.pem);
      Alert.alert('Certificate Normalized', `Detected: ${parsed.detectedFormat}. Missing BEGIN/END lines were restored.`);
    } catch (e: any) {
      Alert.alert('Cannot Normalize', e?.message || 'Invalid certificate.');
    }
  };

  const apply = async () => {
    try {
      await onApply(value);
    } catch (e: any) {
      Alert.alert('Root CA Error', e?.message || 'Invalid Root CA certificate.');
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
          maxWidth={560}
          style={{ maxHeight: height * 0.92 }}
        >
          <HStack justifyContent="space-between" alignItems="center" mb="$2">
            <HStack space="xs" alignItems="center">
              <ShieldCheck size={18} color={appliedCa ? PASS_COLOR : YELLOW} />
              <Text color={YELLOW} fontSize="$lg" fontWeight="900">
                Root CA Certificate
              </Text>
            </HStack>
            <Text color={appliedCa ? PASS_COLOR : MUTED} fontSize="$2xs" fontWeight="900">
              {appliedCa ? 'CUSTOM CA ACTIVE' : 'SYSTEM CA ONLY'}
            </Text>
          </HStack>

          {scannedFormat ? (
            <Box
              bg="rgba(34, 197, 94, 0.15)"
              borderWidth={1}
              borderColor={PASS_COLOR}
              borderRadius="$md"
              p="$2"
              mb="$2"
            >
              <Text color={PASS_COLOR} fontSize="$2xs" fontWeight="800">
                ✓ Scanned from QR ({scannedFormat}). Review below, then tap Apply.
              </Text>
            </Box>
          ) : null}

          {/* Live validation chips */}
          <View style={styles.chipRow}>
            <Chip ok={info.hasBegin} warn={!info.hasBegin && hasText} label="BEGIN line" />
            <Chip ok={info.hasEnd} warn={!info.hasEnd && hasText} label="END line" />
            <Chip
              ok={info.valid}
              warn={info.status === 'unknown' && hasText}
              label={
                info.status === 'truncated'
                  ? `Truncated (${info.actualBytes}/${info.expectedBytes} B)`
                  : info.valid
                  ? `Valid X.509 (${info.expectedBytes} B)`
                  : 'Not valid yet'
              }
            />
            <Chip ok={info.lineCount > 0} warn label={`${info.lineCount} lines`} />
          </View>

          {hasText && info.valid && (!info.hasBegin || !info.hasEnd) ? (
            <Text color={YELLOW} fontSize="$2xs" mb="$2">
              BEGIN/END line missing (QR may have cut it). The certificate body is complete — tap
              &quot;Fix BEGIN/END&quot; or just Apply and it will be restored automatically.
            </Text>
          ) : null}
          {info.status === 'truncated' ? (
            <Text color={FAIL_COLOR} fontSize="$2xs" mb="$2">
              The certificate data is incomplete — the end was cut off. Re-scan a QR with the full
              certificate or paste it completely.
            </Text>
          ) : null}

          {/* Large scrollable certificate editor */}
          <ScrollView
            style={[styles.editorWrap, { height: Math.max(220, height * 0.42) }]}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
          >
            <TextInput
              value={value}
              onChangeText={onChangeValue}
              multiline
              scrollEnabled={false}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              placeholder={'-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n\n(or Clean Base64 / JSON bundle)'}
              placeholderTextColor="#64748b"
              style={styles.editor}
              textAlignVertical="top"
            />
          </ScrollView>

          <HStack space="xs" mt="$3" flexWrap="wrap">
            <Button
              size="sm"
              variant="outline"
              borderColor={YELLOW}
              bg="rgba(250, 204, 21, 0.14)"
              onPress={onScanQr}
            >
              <HStack space="xs" alignItems="center">
                <QrCode size={13} color={YELLOW} />
                <ButtonText color={YELLOW} fontSize="$2xs" fontWeight="900">
                  Scan QR
                </ButtonText>
              </HStack>
            </Button>
            <Button size="sm" variant="outline" borderColor="#475569" onPress={normalizeNow} isDisabled={!hasText}>
              <ButtonText color="#f8fafc" fontSize="$2xs" fontWeight="800">
                Fix BEGIN/END
              </ButtonText>
            </Button>
            <Button
              size="sm"
              variant="outline"
              borderColor={FAIL_COLOR}
              onPress={async () => {
                onChangeValue('');
                await onClear();
              }}
              isDisabled={!hasText && !appliedCa}
            >
              <ButtonText color="#f87171" fontSize="$2xs" fontWeight="800">
                Clear
              </ButtonText>
            </Button>
          </HStack>

          <HStack space="sm" justifyContent="flex-end" mt="$3">
            <Button variant="outline" borderColor="#64748b" onPress={onClose}>
              <ButtonText color="#cbd5e1">Close</ButtonText>
            </Button>
            <Button bg={YELLOW} onPress={apply} isDisabled={!hasText || info.status === 'truncated'}>
              <ButtonText color={BLACK} fontWeight="900">
                Apply Root CA
              </ButtonText>
            </Button>
          </HStack>
        </Box>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  editorWrap: {
    backgroundColor: '#07111d',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
  },
  editor: {
    color: '#f8fafc',
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Menlo',
    fontSize: 11,
    lineHeight: 16,
    padding: 10,
    minHeight: 220,
  },
});

