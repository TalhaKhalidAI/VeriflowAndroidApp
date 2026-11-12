const {
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withMainApplication,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const NETWORK_SECURITY_CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </base-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">talhahub.io</domain>
        <domain includeSubdomains="true">veriflow.talhahub.io</domain>
        <domain includeSubdomains="true">localhost</domain>
        <domain includeSubdomains="true">10.0.2.2</domain>
        <domain includeSubdomains="true">127.0.0.1</domain>
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </domain-config>
</network-security-config>
`;

const CUSTOM_CA_MODULE_KT = `package com.anonymous.veriflow

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import okhttp3.OkHttpClient
import java.io.ByteArrayInputStream
import java.net.Socket
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedTrustManager
import javax.net.ssl.X509TrustManager

class VeriFlowCustomCaModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun setRootCa(pem: String?, promise: Promise) {
    try {
      val cleanPem = pem?.trim().orEmpty()
      saveRootCaPem(reactContext.applicationContext, cleanPem)
      installOkHttpTlsFactory(reactContext.applicationContext, cleanPem)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("CUSTOM_CA_ERROR", e.message ?: "Failed to apply custom Root CA", e)
    }
  }

  companion object {
    const val NAME = "VeriFlowCustomCa"
    private const val PREFS_NAME = "veriflow_tls_prefs"
    private const val KEY_ROOT_CA_PEM = "root_ca_pem"

    @Volatile
    private var currentPem: String = ""

    @Volatile
    private var currentBackingTrustManager: X509TrustManager? = null

    fun initOnStartup(context: Context) {
      val savedPem = loadSavedRootCaPem(context)
      installOkHttpTlsFactory(context, savedPem)
    }

    private fun saveRootCaPem(context: Context, pem: String) {
      context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .putString(KEY_ROOT_CA_PEM, pem)
        .apply()
    }

    private fun loadSavedRootCaPem(context: Context): String {
      return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .getString(KEY_ROOT_CA_PEM, "")
        ?.trim()
        .orEmpty()
    }

    private fun parseX509Certificate(pem: String): X509Certificate? {
      if (pem.isBlank()) return null
      return try {
        val cf = CertificateFactory.getInstance("X.509")
        ByteArrayInputStream(pem.toByteArray(Charsets.UTF_8)).use { stream ->
          cf.generateCertificate(stream) as? X509Certificate
        }
      } catch (_: Exception) {
        null
      }
    }

    private fun buildDefaultTrustManager(customCert: X509Certificate?): X509TrustManager? {
      return try {
        val keyStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
          load(null, null)
        }

        try {
          val androidCaStore = KeyStore.getInstance("AndroidCAStore")
          androidCaStore.load(null, null)
          val aliases = androidCaStore.aliases()
          while (aliases.hasMoreElements()) {
            val alias = aliases.nextElement()
            val cert = androidCaStore.getCertificate(alias)
            if (cert != null) {
              keyStore.setCertificateEntry(alias, cert)
            }
          }
        } catch (_: Exception) {
        }

        if (customCert != null) {
          keyStore.setCertificateEntry("veriflow_custom_root_ca", customCert)
        }

        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        tmf.init(keyStore)
        tmf.trustManagers.filterIsInstance<X509TrustManager>().firstOrNull()
      } catch (_: Exception) {
        null
      }
    }

    @SuppressLint("CustomX509TrustManager")
    private fun createUniversalTrustManager(): X509TrustManager {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        return object : X509ExtendedTrustManager() {
          override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
          override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) {}
          override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) {}

          override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            if (chain.isNullOrEmpty()) return
            try {
              currentBackingTrustManager?.checkServerTrusted(chain, authType)
            } catch (_: Exception) {
            }
          }

          override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) {
            checkServerTrusted(chain, authType)
          }

          override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) {
            checkServerTrusted(chain, authType)
          }

          override fun getAcceptedIssuers(): Array<X509Certificate> {
            return currentBackingTrustManager?.acceptedIssuers ?: emptyArray()
          }
        }
      }

      return object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
          if (chain.isNullOrEmpty()) return
          try {
            currentBackingTrustManager?.checkServerTrusted(chain, authType)
          } catch (_: Exception) {
          }
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> {
          return currentBackingTrustManager?.acceptedIssuers ?: emptyArray()
        }
      }
    }

    fun installOkHttpTlsFactory(context: Context, pem: String) {
      currentPem = pem
      val customCert = parseX509Certificate(pem)
      currentBackingTrustManager = buildDefaultTrustManager(customCert)

      val dynamicTrustManager = createUniversalTrustManager()

      val sslContext = SSLContext.getInstance("TLS")
      sslContext.init(null, arrayOf<TrustManager>(dynamicTrustManager), SecureRandom())
      val sslSocketFactory = sslContext.socketFactory

      HttpsURLConnection.setDefaultSSLSocketFactory(sslSocketFactory)
      HttpsURLConnection.setDefaultHostnameVerifier { _, _ -> true }

      OkHttpClientProvider.setOkHttpClientFactory(
        object : OkHttpClientFactory {
          override fun createNewNetworkModuleClient(): OkHttpClient {
            return OkHttpClientProvider.createClientBuilder(context)
              .connectTimeout(30, TimeUnit.SECONDS)
              .readTimeout(30, TimeUnit.SECONDS)
              .writeTimeout(30, TimeUnit.SECONDS)
              .sslSocketFactory(sslSocketFactory, dynamicTrustManager)
              .hostnameVerifier { _, _ -> true }
              .build()
          }
        }
      )
    }
  }
}
`;

const CUSTOM_CA_PACKAGE_KT = `package com.anonymous.veriflow

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

@Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
class VeriFlowCustomCaPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
    return listOf(VeriFlowCustomCaModule(reactContext))
  }

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
    return emptyList()
  }
}
`;

function withVeriFlowNetworkSecurity(config) {
  config = withAppBuildGradle(config, modConfig => {
    const pkg = (modConfig.android && modConfig.android.package) || 'com.anonymous.veriflow';
    let contents = modConfig.modResults.contents;
    contents = contents.replace(/namespace\s+['"][^'"]+['"]/, `namespace '${pkg}'`);
    contents = contents.replace(/applicationId\s+['"][^'"]+['"]/, `applicationId '${pkg}'`);
    modConfig.modResults.contents = contents;
    return modConfig;
  });

  config = withAndroidManifest(config, async modConfig => {
    const manifest = modConfig.modResults.manifest;
    manifest['uses-permission'] = manifest['uses-permission'] || [];

    const ensurePerm = name => {
      const exists = manifest['uses-permission'].some(
        p => p.$ && p.$['android:name'] === name,
      );
      if (!exists) {
        manifest['uses-permission'].push({ $: { 'android:name': name } });
      }
    };

    ensurePerm('android.permission.INTERNET');
    ensurePerm('android.permission.ACCESS_NETWORK_STATE');
    ensurePerm('android.permission.ACCESS_WIFI_STATE');

    const app = manifest.application && manifest.application[0];
    if (app && app.$) {
      app.$['android:usesCleartextTraffic'] = 'true';
      app.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    }

    return modConfig;
  });

  config = withDangerousMod(config, [
    'android',
    async modConfig => {
      const platformRoot = modConfig.modRequest.platformProjectRoot;
      const xmlDir = path.join(platformRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, 'network_security_config.xml'),
        NETWORK_SECURITY_CONFIG_XML,
        'utf8',
      );

      const pkg = (modConfig.android && modConfig.android.package) || 'com.anonymous.veriflow';
      const javaDir = path.join(
        platformRoot,
        'app',
        'src',
        'main',
        'java',
        ...pkg.split('.'),
      );
      fs.mkdirSync(javaDir, { recursive: true });
      fs.writeFileSync(
        path.join(javaDir, 'VeriFlowCustomCaModule.kt'),
        CUSTOM_CA_MODULE_KT,
        'utf8',
      );
      fs.writeFileSync(
        path.join(javaDir, 'VeriFlowCustomCaPackage.kt'),
        CUSTOM_CA_PACKAGE_KT,
        'utf8',
      );

      // Clear stale cached autolinking files so ReactNativeApplicationEntryPoint.java uses the active package
      fs.rmSync(path.join(platformRoot, 'build', 'generated', 'autolinking'), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(platformRoot, 'app', 'build', 'generated', 'autolinking'), {
        recursive: true,
        force: true,
      });
      return modConfig;
    },
  ]);

  config = withMainApplication(config, modConfig => {
    let contents = modConfig.modResults.contents;
    if (!contents.includes('VeriFlowCustomCaPackage')) {
      if (contents.includes('// add(MyReactNativePackage())')) {
        contents = contents.replace(
          '// add(MyReactNativePackage())',
          '// add(MyReactNativePackage())\n          add(VeriFlowCustomCaPackage())',
        );
      } else {
        contents = contents.replace(
          /PackageList\(this\)\.packages\.apply\s*\{/,
          'PackageList(this).packages.apply {\n          add(VeriFlowCustomCaPackage())',
        );
      }
    }
    if (!contents.includes('VeriFlowCustomCaModule.initOnStartup')) {
      contents = contents.replace(
        'super.onCreate()',
        'super.onCreate()\n    VeriFlowCustomCaModule.initOnStartup(applicationContext)',
      );
    }
    modConfig.modResults.contents = contents;
    return modConfig;
  });

  return config;
}

module.exports = withVeriFlowNetworkSecurity;
