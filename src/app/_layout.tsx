import { config } from '@gluestack-ui/config';
import { GluestackUIProvider } from '@gluestack-ui/themed';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { Drawer, DrawerContentScrollView, DrawerItemList } from 'expo-router/drawer';
import * as SplashScreen from 'expo-splash-screen';
import { LogOut } from 'lucide-react-native';
import React, { useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View, useColorScheme, useWindowDimensions } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { CheckoutModal } from '@/components/CheckoutModal';
import { DatabaseErrorBoundary } from '@/components/DatabaseErrorBoundary';
import { AuthProvider, useAuth } from '@/core/authContext';
import { useLiveSync } from '@/core/useLiveSync';
import LoginPage from '@/Pages/LoginPage';

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
    },
    mutations: {
      retry: false,
    },
  },
});

function MainAppDrawer() {
  const { session, isLoggedIn, isLoading } = useAuth();
  const { width } = useWindowDimensions();
  const [checkoutVisible, setCheckoutVisible] = useState(false);

  // Requirement 4: Real-time TanStack Query sync for permissions and public keys
  useLiveSync();

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#facc15" />
        <Text style={styles.loadingText}>Loading VeriFlow Security Engine...</Text>
      </View>
    );
  }

  // REQUIREMENT 5: If not logged in, user CANNOT access any other screen.
  // Main login is done via QR ONLY.
  if (!isLoggedIn) {
    return <LoginPage />;
  }

  return (
    <>
      <Drawer
        drawerContent={(props) => (
          <DrawerContentScrollView {...props} contentContainerStyle={styles.drawerContent}>
            <View style={styles.drawerBrand}>
              <Image
                source={require('../assets/msi_white.png')}
                style={styles.drawerLogo}
                resizeMode="contain"
                accessibilityLabel="VeriFlow logo"
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.drawerTitle}>VeriFlow</Text>
                <Text style={styles.drawerSubtitle}>INDUSTRIAL OFFLINE SCANNER</Text>
                <Text style={styles.drawerOperator} numberOfLines={1}>
                  {session?.sub || 'Operator'}
                </Text>
                {session?.offlineCheckoutPending ? (
                  <Text style={styles.drawerOfflineWarning}>
                    OFFLINE CHECKOUT SAVED
                  </Text>
                ) : null}
              </View>
            </View>

            <DrawerItemList {...props} />

            <View style={styles.drawerFooter}>
              <Pressable
                style={styles.checkoutBtn}
                onPress={() => setCheckoutVisible(true)}
              >
                <LogOut size={18} color="#ef4444" />
                <Text style={styles.checkoutBtnText}>Checkout Shift</Text>
              </Pressable>
            </View>
          </DrawerContentScrollView>
        )}
        screenOptions={{
          headerShown: true,
          headerTitle: 'VeriFlow',
          headerStyle: { backgroundColor: '#07111d' },
          headerTintColor: '#facc15',
          headerTitleStyle: { fontWeight: '900', fontSize: 24 },
          drawerStyle: { backgroundColor: '#0b1220', width: Math.min(280, Math.floor(width * 0.82)) },
          drawerActiveTintColor: '#facc15',
          drawerInactiveTintColor: '#e2e8f0',
          drawerLabelStyle: { fontWeight: '700' },
          sceneStyle: { backgroundColor: '#050b14' },
          headerRight: () => (
            <Pressable
              style={styles.headerCheckout}
              onPress={() => setCheckoutVisible(true)}
            >
              <LogOut size={16} color="#ef4444" />
              <Text style={styles.headerCheckoutText}>Checkout</Text>
            </Pressable>
          ),
        }}
      >
        <Drawer.Screen name="index" options={{ title: 'Home', drawerLabel: 'Home' }} />
        <Drawer.Screen name="scanner" options={{ title: 'QR Scanner', drawerLabel: 'QR Scanner' }} />
        <Drawer.Screen name="history" options={{ title: 'Scan History', drawerLabel: 'Scan History' }} />
        <Drawer.Screen name="sync" options={{ title: 'Sync Queue', drawerLabel: 'Sync & Queue' }} />
        <Drawer.Screen name="settings" options={{ title: 'Settings', drawerLabel: 'Settings & Rules' }} />
        <Drawer.Screen
          name="explore"
          options={{
            drawerItemStyle: { display: 'none' },
          }}
        />
      </Drawer>

      <CheckoutModal
        visible={checkoutVisible}
        onClose={() => setCheckoutVisible(false)}
      />
    </>
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <DatabaseErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
            <GluestackUIProvider config={config}>
              <AnimatedSplashOverlay />
              <MainAppDrawer />
            </GluestackUIProvider>
          </ThemeProvider>
        </AuthProvider>
      </QueryClientProvider>
    </DatabaseErrorBoundary>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: '#07111d',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    color: '#facc15',
    fontWeight: '800',
    marginTop: 12,
    fontSize: 14,
  },
  drawerContent: {
    flexGrow: 1,
    backgroundColor: '#0b1220',
  },
  drawerBrand: {
    minHeight: 112,
    paddingHorizontal: 16,
    paddingVertical: 18,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  drawerLogo: {
    width: 52,
    height: 52,
  },
  drawerTitle: {
    color: '#facc15',
    fontSize: 20,
    fontWeight: '900',
  },
  drawerSubtitle: {
    color: '#cbd5e1',
    fontSize: 8,
    fontWeight: '800',
    marginTop: 2,
  },
  drawerOperator: {
    color: '#22c55e',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 4,
  },
  drawerOfflineWarning: {
    color: '#facc15',
    fontSize: 9,
    fontWeight: '900',
    marginTop: 3,
    backgroundColor: 'rgba(250, 204, 21, 0.15)',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    alignSelf: 'flex-start',
  },
  drawerFooter: {
    marginTop: 'auto',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  checkoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  checkoutBtnText: {
    color: '#ef4444',
    fontWeight: '800',
    fontSize: 14,
  },
  headerCheckout: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginRight: 16,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  headerCheckoutText: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: '800',
  },
});
