import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { DatabaseSecurityError, resetUnreadableDatabase } from '@/core/db';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export class DatabaseErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: any): State {
    const code =
      error instanceof DatabaseSecurityError
        ? error.code
        : String(error?.message || '').includes('SQLCIPHER_BUILD_MISSING')
        ? 'SQLCIPHER_BUILD_MISSING'
        : 'OFFLINE_DB_UNREADABLE';
    return {
      hasError: true,
      errorCode: code,
      errorMessage: error?.message || 'Database encryption error.',
    };
  }

  handleRecover = async () => {
    await resetUnreadableDatabase();
    this.setState({ hasError: false, errorCode: undefined, errorMessage: undefined });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <View style={styles.card}>
            <Text style={styles.badge}>{this.state.errorCode || 'OFFLINE_DB_UNREADABLE'}</Text>
            <Text style={styles.title}>Encrypted Storage Alert</Text>
            <Text style={styles.message}>
              {this.state.errorCode === 'SQLCIPHER_BUILD_MISSING'
                ? 'SQLCipher native encryption or Android Keystore is missing from this build. Rebuild the native Android client (npx expo run:android) to enable hardware-backed database encryption.'
                : 'The local SQLCipher database could not be unlocked with the current Android Keystore key (OFFLINE_DB_UNREADABLE). This happens if device keystore credentials were cleared.'}
            </Text>
            {this.state.errorMessage ? (
              <Text style={styles.detail}>{this.state.errorMessage}</Text>
            ) : null}
            <Pressable style={styles.button} onPress={this.handleRecover}>
              <Text style={styles.buttonText}>Re-Initialize Encrypted Database</Text>
            </Pressable>
          </View>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050b14',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#0b1220',
    borderWidth: 1,
    borderColor: '#ef4444',
    borderRadius: 12,
    padding: 20,
    width: '100%',
    maxWidth: 420,
  },
  badge: {
    color: '#facc15',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  title: {
    color: '#f8fafc',
    fontSize: 20,
    fontWeight: '900',
    marginBottom: 10,
  },
  message: {
    color: '#cbd5e1',
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 12,
  },
  detail: {
    color: '#f87171',
    fontSize: 11,
    marginBottom: 16,
  },
  button: {
    backgroundColor: '#facc15',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonText: {
    color: '#07111d',
    fontWeight: '900',
    fontSize: 14,
  },
});

