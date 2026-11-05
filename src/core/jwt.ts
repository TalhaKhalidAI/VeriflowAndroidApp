import { Platform } from 'react-native';
import { VerificationResult } from './types';

type JoseModule = typeof import('jose');

function ensureCryptoAvailable(): boolean {
  try {
    if (Platform.OS === 'web') {
      return typeof globalThis.crypto?.subtle !== 'undefined';
    }

    const quickCrypto = require('react-native-quick-crypto') as {
      install?: () => void;
      subtle?: SubtleCrypto;
      getRandomValues?: typeof crypto.getRandomValues;
    };

    if (typeof quickCrypto.install === 'function') {
      quickCrypto.install();
    }

    if (typeof globalThis.crypto === 'undefined' && quickCrypto.subtle) {
      Object.defineProperty(globalThis, 'crypto', {
        value: quickCrypto,
        configurable: true,
        writable: true,
      });
    }

    if (globalThis.crypto && !globalThis.crypto.subtle && quickCrypto.subtle) {
      Object.defineProperty(globalThis.crypto, 'subtle', {
        value: quickCrypto.subtle,
        configurable: true,
        writable: true,
      });
    }

    return typeof globalThis.crypto?.subtle !== 'undefined';
  } catch {
    return false;
  }
}

export interface ParsedKeyPayload {
  pem: string;
  suggestedName: string;
  detectedFormat: 'JSON Bundle' | 'Standard PEM' | 'Clean Base64';
  kid?: string;
}

export interface ParsedRootCaPayload {
  pem: string;
  detectedFormat: 'JSON Bundle' | 'Standard PEM' | 'Clean Base64';
}

/**
 * Normalizes a Backend Server API URL so both https:// and http:// URLs work cleanly.
 * Strips redundant path prefixes and auto-formats reverse-proxy setups like veriflow.talhahub.io.
 */
export function normalizeApiBaseUrl(rawUrl: string): string {
  let cleaned = (rawUrl || '').trim();
  if (!cleaned) return '';
  if (!/^https?:\/\//i.test(cleaned)) {
    const isLocalIp =
      /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/i.test(
        cleaned,
      );
    cleaned = `${isLocalIp ? 'http' : 'https'}://${cleaned}`;
  }
  cleaned = cleaned.replace(/\/+$/, '');

  // Strip duplicate /app/v1 suffix if attached to /api or standalone
  cleaned = cleaned.replace(/\/api\/(app\/)?v1\/?$/i, '/api');
  cleaned = cleaned.replace(/\/app\/v1\/?$/i, '');

  // Reverse proxy special case: veriflow.talhahub.io maps /api -> /app/v1
  // Any request to veriflow.talhahub.io must target /api (without /app/v1)
  if (/veriflow\.talhahub\.io/i.test(cleaned)) {
    const stripped = cleaned.replace(/\/api\/?$/i, '').replace(/\/+$/, '');
    cleaned = `${stripped}/api`;
  }

  return cleaned.replace(/\/+$/, '');
}

/**
 * Builds the exact API endpoint URL taking into account reverse proxy prefix mapping.
 * (e.g. https://veriflow.talhahub.io/api maps /api -> /app/v1 on the backend).
 */
export function buildApiUrl(baseUrl: string, endpoint: string): string {
  const base = normalizeApiBaseUrl(baseUrl);
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

  if (base.endsWith('/api')) {
    // Reverse proxy already routes /api -> /app/v1, so strip /app/v1 from endpoint if present
    const subPath = cleanEndpoint.replace(/^\/app\/v1/, '');
    return `${base}${subPath}`;
  }

  if (base.endsWith('/app/v1')) {
    const subPath = cleanEndpoint.replace(/^\/app\/v1/, '');
    return `${base}${subPath}`;
  }

  // Standard direct connection (e.g. local dev http://10.0.2.2:8000)
  const withAppV1 = cleanEndpoint.startsWith('/app/v1') ? cleanEndpoint : `/app/v1${cleanEndpoint}`;
  return `${base}${withAppV1}`;
}

/**
 * Auto-detects whether a pasted or QR-scanned Root CA Certificate is:
 * 1. JSON Bundle ({ root_ca, ca_cert, certificate, cert })
 * 2. Standard PEM (-----BEGIN CERTIFICATE-----...)
 * 3. Clean Single-Line Base64 (MIID... / MIIF...)
 * and returns a canonical X.509 CERTIFICATE PEM block.
 */
export function parseRootCaPayload(rawInput: string): ParsedRootCaPayload {
  if (!rawInput || !rawInput.trim()) {
    throw new Error('Root CA certificate is empty. Paste or scan a valid X.509 Root CA certificate.');
  }

  let trimmed = rawInput.trim();
  let detectedFormat: 'JSON Bundle' | 'Standard PEM' | 'Clean Base64' = 'Clean Base64';

  if (trimmed.split('.').length === 3 && trimmed.startsWith('eyJ')) {
    throw new Error(
      'Scanned QR is a JWT token, not a Root CA Certificate. Please scan or paste an X.509 Certificate.',
    );
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const caField =
        parsed.root_ca ||
        parsed.ca_cert ||
        parsed.certificate ||
        parsed.cert ||
        parsed.ca ||
        (Array.isArray(parsed.x5c) && parsed.x5c[0]);
      if (caField && typeof caField === 'string') {
        trimmed = caField.trim();
        detectedFormat = 'JSON Bundle';
      }
    } catch {
      // fall through
    }
  }

  trimmed = trimmed
    .replace(/\\r/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '')
    .trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim().replace(/\\r/g, '').replace(/\\n/g, '\n');
  }

  if (trimmed.includes('PRIVATE KEY')) {
    throw new Error('You entered a PRIVATE KEY. Please provide an X.509 Root CA CERTIFICATE.');
  }

  if (detectedFormat !== 'JSON Bundle' && /-----BEGIN [A-Z0-9 ]*CERTIFICATE-----/i.test(trimmed)) {
    detectedFormat = 'Standard PEM';
  }

  // Take only the body between the BEGIN header and the first following "-----" marker.
  // This tolerates a missing / partially cut-off "-----END CERTIFICATE-----" line (e.g. QR truncation),
  // so leftover END/CERTIFICATE letters never pollute the Base64 body.
  let body = trimmed;
  const beginMatch = body.match(/-----BEGIN [A-Z0-9 ]*-----/i);
  if (beginMatch && beginMatch.index !== undefined) {
    body = body.slice(beginMatch.index + beginMatch[0].length);
  }
  const nextMarker = body.indexOf('-----');
  if (nextMarker >= 0) {
    body = body.slice(0, nextMarker);
  }
  let base64Body = body.replace(/[^A-Za-z0-9+/=]/g, '');

  if (!base64Body || base64Body.length < 64) {
    throw new Error(
      'Invalid Root CA Certificate: Could not extract valid Base64 X.509 certificate content.',
    );
  }

  // Validate against the DER length header to detect truncation and trim trailing junk.
  const der = checkDerLength(base64Body);
  if (der.status === 'truncated') {
    throw new Error(
      `Root CA certificate is incomplete (got ${der.actualBytes} bytes, expected ${der.expectedBytes}). The QR/paste was cut off — regenerate a smaller QR (lower-density) or paste the full certificate.`,
    );
  }
  if (der.status === 'invalid') {
    throw new Error('Invalid Root CA Certificate: data is not a valid X.509 DER structure.');
  }
  if (der.status === 'extra' && der.trimmedBase64) {
    base64Body = der.trimmedBase64;
  }

  const lines = base64Body.match(/.{1,64}/g) || [base64Body];
  return {
    pem: `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`,
    detectedFormat,
  };
}

export interface DerLengthCheck {
  status: 'ok' | 'truncated' | 'extra' | 'invalid' | 'unknown';
  actualBytes: number;
  expectedBytes: number;
  trimmedBase64?: string;
}

/**
 * Verifies the outer ASN.1 SEQUENCE length of a Base64 DER certificate against the bytes received.
 */
export function checkDerLength(base64Body: string): DerLengthCheck {
  try {
    const clean = base64Body.replace(/[^A-Za-z0-9+/]/g, '');
    const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
    const bin = atob(padded);
    const actual = bin.length;
    if (actual < 4 || bin.charCodeAt(0) !== 0x30) {
      return { status: 'invalid', actualBytes: actual, expectedBytes: 0 };
    }
    const b1 = bin.charCodeAt(1);
    let headerLen = 2;
    let contentLen = b1;
    if (b1 & 0x80) {
      const n = b1 & 0x7f;
      if (n < 1 || n > 4) return { status: 'invalid', actualBytes: actual, expectedBytes: 0 };
      contentLen = 0;
      for (let i = 0; i < n; i++) contentLen = contentLen * 256 + bin.charCodeAt(2 + i);
      headerLen = 2 + n;
    }
    const expected = headerLen + contentLen;
    if (actual < expected) return { status: 'truncated', actualBytes: actual, expectedBytes: expected };
    if (actual > expected) {
      const keepB64Len = Math.ceil((expected * 4) / 3);
      return {
        status: 'extra',
        actualBytes: actual,
        expectedBytes: expected,
        trimmedBase64: padded.slice(0, keepB64Len) + '='.repeat((4 - (keepB64Len % 4)) % 4),
      };
    }
    return { status: 'ok', actualBytes: actual, expectedBytes: expected };
  } catch {
    return { status: 'unknown', actualBytes: 0, expectedBytes: 0 };
  }
}

export interface RootCaInspection {
  hasBegin: boolean;
  hasEnd: boolean;
  status: DerLengthCheck['status'];
  actualBytes: number;
  expectedBytes: number;
  lineCount: number;
  valid: boolean;
}

/** Lightweight live inspection of whatever text is in the Root CA editor (never throws). */
export function inspectRootCaText(raw: string): RootCaInspection {
  const text = (raw || '').replace(/\\r/g, '').replace(/\\n/g, '\n');
  const hasBegin = /-----BEGIN [A-Z0-9 ]*CERTIFICATE-----/i.test(text);
  const hasEnd = /-----END [A-Z0-9 ]*CERTIFICATE-----/i.test(text);
  let body = text;
  const bm = body.match(/-----BEGIN [A-Z0-9 ]*-----/i);
  if (bm && bm.index !== undefined) body = body.slice(bm.index + bm[0].length);
  const nm = body.indexOf('-----');
  if (nm >= 0) body = body.slice(0, nm);
  const b64 = body.replace(/[^A-Za-z0-9+/=]/g, '');
  const lineCount = text.split('\n').filter(l => l.trim()).length;
  if (b64.length < 64) {
    return { hasBegin, hasEnd, status: 'unknown', actualBytes: 0, expectedBytes: 0, lineCount, valid: false };
  }
  const der = checkDerLength(b64);
  return {
    hasBegin,
    hasEnd,
    status: der.status,
    actualBytes: der.actualBytes,
    expectedBytes: der.expectedBytes,
    lineCount,
    valid: der.status === 'ok' || der.status === 'extra',
  };
}

/**
 * Checks whether a scanned QR string is a Public Key payload (JSON key bundle, PEM, or Clean Base64 SPKI)
 * rather than a 3-part JWT token.
 */
export function isLikelyPublicKeyPayload(rawInput: string): boolean {
  if (!rawInput || !rawInput.trim()) return false;
  const trimmed = rawInput.trim();

  // 3-part JWT tokens have two dots and start with eyJ
  if (trimmed.split('.').length === 3 && trimmed.startsWith('eyJ')) {
    return false;
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && (parsed.public_key || (Array.isArray(parsed.keys) && parsed.keys.length > 0))) {
        return true;
      }
    } catch {
      return false;
    }
  }

  if (/-----BEGIN (?:RSA )?PUBLIC KEY-----/i.test(trimmed)) {
    return true;
  }

  // Standard RSA-2048/4096 SPKI Base64 starts with MIIBIjANBgkqhkiG9w0BAQEF or MIICIjANBgkqhkiG9w0BAQEF
  const cleanB64 = trimmed.replace(/\s+/g, '');
  if (
    !cleanB64.includes('.') &&
    (cleanB64.startsWith('MIIBIjANBgkqhkiG9w0BAQEF') ||
      cleanB64.startsWith('MIICIjANBgkqhkiG9w0BAQEF'))
  ) {
    return true;
  }

  return false;
}

/**
 * Auto-detects whether the input (from QR scan or clipboard paste) is:
 * 1. JSON Bundle ({ kid, name, public_key } or JWKS { keys: [...] })
 * 2. Standard PEM (-----BEGIN PUBLIC KEY-----...)
 * 3. Clean Single-Line Base64 (MIIBIjANBgkqhkiG9w0BAQEF...)
 *
 * Returns the canonical SPKI PEM, a suggested alias name, and the detected format label.
 */
export function parsePublicKeyPayload(
  rawInput: string,
  fallbackAlias?: string,
): ParsedKeyPayload {
  if (!rawInput || !rawInput.trim()) {
    throw new Error('Scanned or pasted key payload is empty.');
  }

  const trimmed = rawInput.trim();

  if (trimmed.split('.').length === 3 && trimmed.startsWith('eyJ')) {
    throw new Error(
      'Scanned QR is a signed JWT token (Shift Badge or Product Tag), not a Public Key. Please scan a Public Key QR code from the Web App.',
    );
  }

  let rawKeyMaterial = trimmed;
  let detectedFormat: 'JSON Bundle' | 'Standard PEM' | 'Clean Base64' = 'Clean Base64';
  let extractedKid: string | undefined;
  let extractedName: string | undefined;

  // 1. Auto-detect JSON format
  if (trimmed.startsWith('{')) {
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('Invalid JSON key payload.');
    }

    const targetObj =
      Array.isArray(parsed?.keys) && parsed.keys.length > 0 ? parsed.keys[0] : parsed;

    if (targetObj?.private_key && !targetObj?.public_key) {
      throw new Error(
        'Scanned QR contains a PRIVATE KEY JSON bundle. The mobile verifier requires the PUBLIC KEY QR code.',
      );
    }

    extractedKid = targetObj?.kid || targetObj?.key_id || targetObj?.id;
    extractedName = targetObj?.name;

    if (targetObj?.public_key && typeof targetObj.public_key === 'string') {
      rawKeyMaterial = targetObj.public_key;
      detectedFormat = 'JSON Bundle';
    } else if (Array.isArray(targetObj?.x5c) && targetObj.x5c[0]) {
      rawKeyMaterial = targetObj.x5c[0];
      detectedFormat = 'JSON Bundle';
    } else {
      throw new Error(
        'JSON QR does not contain a "public_key" field. Please scan a valid Public Key QR code.',
      );
    }
  } else if (/-----BEGIN [A-Z0-9 ]+-----/i.test(trimmed)) {
    detectedFormat = 'Standard PEM';
  }

  const canonicalPem = normalizePublicKey(rawKeyMaterial);

  let suggestedName = (fallbackAlias || '').trim();
  if (!suggestedName) {
    if (extractedName && extractedKid) {
      suggestedName = `${extractedName} (${extractedKid})`;
    } else if (extractedKid) {
      suggestedName = `Key ${extractedKid}`;
    } else if (extractedName) {
      suggestedName = String(extractedName);
    } else {
      const b64Clean = canonicalPem
        .replace(/-----BEGIN PUBLIC KEY-----/g, '')
        .replace(/-----END PUBLIC KEY-----/g, '')
        .replace(/\s+/g, '');
      const suffix = b64Clean.slice(-6) || String(Math.floor(1000 + Math.random() * 9000));
      suggestedName = `QR Key (${suffix})`;
    }
  }

  return {
    pem: canonicalPem,
    suggestedName,
    detectedFormat,
    kid: extractedKid ? String(extractedKid) : undefined,
  };
}

export interface PublicKeyInspection {
  detectedFormat: 'JSON Bundle' | 'Standard PEM' | 'Clean Base64' | 'Unknown';
  kid?: string;
  name?: string;
  valid: boolean;
  canonicalPem?: string;
  suggestedAlias?: string;
  errorMessage?: string;
  bitLength?: number;
  lineCount: number;
}

/** Lightweight live inspection of whatever text is in the Public Key editor (never throws). */
export function inspectPublicKeyText(rawInput: string, fallbackAlias?: string): PublicKeyInspection {
  if (!rawInput || !rawInput.trim()) {
    return { detectedFormat: 'Unknown', valid: false, lineCount: 0 };
  }
  const lineCount = rawInput.split('\n').filter(l => l.trim()).length;
  try {
    const parsed = parsePublicKeyPayload(rawInput, fallbackAlias);
    const b64 = parsed.pem
      .replace(/-----BEGIN (?:RSA )?PUBLIC KEY-----/g, '')
      .replace(/-----END (?:RSA )?PUBLIC KEY-----/g, '')
      .replace(/\s+/g, '');

    let bitLength: number | undefined;
    if (b64.length >= 700) {
      bitLength = 4096;
    } else if (b64.length >= 350) {
      bitLength = 2048;
    } else if (b64.length >= 170) {
      bitLength = 1024;
    }

    return {
      detectedFormat: parsed.detectedFormat,
      kid: parsed.kid,
      name: parsed.suggestedName,
      valid: true,
      canonicalPem: parsed.pem,
      suggestedAlias: parsed.suggestedName,
      bitLength,
      lineCount,
    };
  } catch (err: any) {
    return {
      detectedFormat: 'Unknown',
      valid: false,
      errorMessage: err?.message || 'Invalid public key format',
      lineCount,
    };
  }
}

/**
 * Robustly sanitizes and normalizes PEM / Base64 / JSON blocks:
 * 1. Auto-extracts public_key if a JSON bundle was pasted directly.
 * 2. Unescapes literal \n and \r sequences from JSON/Swagger copy-paste.
 * 3. Rejects PRIVATE keys with a clear, helpful diagnostic.
 * 4. Strips all invalid/whitespace characters from the base64 body.
 * 5. Reconstructs a standard SPKI PEM block.
 */
export function normalizePublicKey(publicKeyPem: string): string {
  if (!publicKeyPem || !publicKeyPem.trim()) {
    throw new Error('Public key is empty. Paste or scan a valid Public Key.');
  }

  let clean = publicKeyPem.trim();

  // Auto-unwrap JSON bundle if passed directly to normalizePublicKey
  if (clean.startsWith('{')) {
    try {
      const parsed = JSON.parse(clean);
      const targetObj =
        Array.isArray(parsed?.keys) && parsed.keys.length > 0 ? parsed.keys[0] : parsed;
      if (targetObj?.public_key && typeof targetObj.public_key === 'string') {
        clean = targetObj.public_key.trim();
      } else if (targetObj?.private_key) {
        throw new Error(
          'You entered a PRIVATE KEY JSON bundle. The scanner requires the matching PUBLIC KEY.',
        );
      }
    } catch (e: any) {
      if (e?.message?.includes('PRIVATE KEY')) throw e;
    }
  }

  // 1. Unescape literal newlines/returns and trim
  clean = clean
    .replace(/\\r/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '')
    .trim();

  // 2. Strip surrounding quotes if copied from JSON string ("...")
  if (
    (clean.startsWith('"') && clean.endsWith('"')) ||
    (clean.startsWith("'") && clean.endsWith("'"))
  ) {
    clean = clean.slice(1, -1).trim();
    clean = clean.replace(/\\r/g, '').replace(/\\n/g, '\n');
  }

  // 3. Reject Private Keys explicitly to avoid confusing base64 errors
  if (clean.includes('PRIVATE KEY')) {
    throw new Error(
      'You entered a PRIVATE KEY. The scanner verifies RS256 signatures and requires the matching PUBLIC KEY (-----BEGIN PUBLIC KEY-----).',
    );
  }

  // 4. Extract base64 content between headers or raw
  const blockMatch = clean.match(
    /-----BEGIN (?:RSA )?PUBLIC KEY-----([\s\S]*?)-----END (?:RSA )?PUBLIC KEY-----/,
  );

  let base64Body = '';
  if (blockMatch) {
    // Keep ONLY valid base64 characters
    base64Body = blockMatch[1].replace(/[^A-Za-z0-9+/=]/g, '');
  } else {
    // If user scanned/pasted pure base64 without headers
    base64Body = clean.replace(/[^A-Za-z0-9+/=]/g, '');
  }

  if (!base64Body || base64Body.length < 32) {
    throw new Error(
      'Invalid public key: Could not find valid Base64 SPKI content. Ensure you scan or copy the complete PUBLIC KEY.',
    );
  }

  // 5. Reconstruct canonical PEM with 64-character lines
  const lines = base64Body.match(/.{1,64}/g) || [base64Body];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
}

/**
 * Sanitizes and normalizes the scanned QR JWT string
 */
export function normalizeJwtToken(rawToken: string): string {
  let token = rawToken.trim();

  // Strip surrounding quotes if scanned from string or json
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }

  // Strip "Bearer " prefix if user scanned Authorization header
  if (token.toLowerCase().startsWith('bearer ')) {
    token = token.slice(7).trim();
  }

  // Remove any stray whitespace or invisible linebreaks inside QR
  token = token.replace(/\s+/g, '');

  return token;
}

export interface RuleCheck {
  ruleName?: string;
  matchingClaimKey: string;
  expectedValue: string;
}

export async function verifyJwtAgainstPublicKey(
  token: string,
  publicKeyPem: string,
  expectedClaimKeyOrRules?: string | RuleCheck[],
  expectedValue?: string,
): Promise<VerificationResult> {
  try {
    const cryptoReady = ensureCryptoAvailable();
    if (!cryptoReady) {
      return {
        valid: false,
        status: 'fail',
        reason:
          Platform.OS === 'web'
            ? 'Web Crypto is unavailable in this browser'
            : 'Native crypto module is missing. Rebuild the app to verify signed data.',
      };
    }

    const normalizedToken = normalizeJwtToken(token);
    if (!normalizedToken) {
      return {
        valid: false,
        status: 'fail',
        reason: 'Scanned QR code is empty',
      };
    }

    // Verify JWT structure (header.payload.signature)
    const tokenParts = normalizedToken.split('.');
    if (tokenParts.length !== 3) {
      return {
        valid: false,
        status: 'fail',
        reason: `Scanned QR is not a valid 3-part JWT token (found ${tokenParts.length} parts, expected 3).`,
        errorCode: 'INVALID_TOKEN',
      };
    }

    // Decode unverified payload to extract claims for diagnostic context
    let unverifiedPayload: Record<string, any> | undefined;
    try {
      const base64 = tokenParts[1].replace(/-/g, '+').replace(/_/g, '/');
      const jsonStr = decodeURIComponent(
        atob(base64)
          .split('')
          .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join(''),
      );
      unverifiedPayload = JSON.parse(jsonStr);
    } catch {
      // ignore
    }

    let pem: string;
    try {
      pem = normalizePublicKey(publicKeyPem);
    } catch (pemErr: any) {
      return {
        valid: false,
        status: 'fail',
        reason: pemErr.message || 'Invalid public key format or certificate error',
        errorCode: 'INVALID_CERT',
        payload: unverifiedPayload,
      };
    }

    const jose = require('jose') as JoseModule;
    const { importSPKI, jwtVerify } = jose;

    let key: any;
    try {
      key = await importSPKI(pem, 'RS256');
    } catch (spkiErr: any) {
      return {
        valid: false,
        status: 'fail',
        reason: `Public key SPKI import failed: ${spkiErr.message}. Ensure you are using the matching RS256 PUBLIC KEY certificate.`,
        errorCode: 'INVALID_CERT',
        payload: unverifiedPayload,
      };
    }

    let verifyResult: any;
    try {
      verifyResult = await jwtVerify(normalizedToken, key, { algorithms: ['RS256'] });
    } catch (jwtErr: any) {
      const msg = String(jwtErr?.message || '');
      const code = String(jwtErr?.code || '');
      const name = String(jwtErr?.name || '');

      // Check if signature check failed due to expiration
      if (
        code === 'ERR_JWT_EXPIRED' ||
        name === 'JWTExpired' ||
        msg.toLowerCase().includes('exp') ||
        msg.toLowerCase().includes('expired') ||
        (unverifiedPayload?.exp && Number(unverifiedPayload.exp) < Math.floor(Date.now() / 1000))
      ) {
        const expDate = unverifiedPayload?.exp ? new Date(Number(unverifiedPayload.exp) * 1000).toLocaleString() : 'past time';
        return {
          valid: false,
          status: 'fail',
          reason: `Token Expired: Shift badge expired at ${expDate}.`,
          errorCode: 'EXPIRED',
          payload: unverifiedPayload,
        };
      }

      // Key mismatch or decrypt/signature failure
      return {
        valid: false,
        status: 'fail',
        reason: `Key Mismatch / Invalid Signature: Scanned QR signature does not match public key (${msg}).`,
        errorCode: 'KEY_MISMATCH',
        payload: unverifiedPayload,
      };
    }

    const payload = verifyResult.payload;

    if (!payload.exp || Number(payload.exp) < Math.floor(Date.now() / 1000)) {
      const expDate = payload.exp ? new Date(Number(payload.exp) * 1000).toLocaleString() : 'unknown';
      return {
        valid: false,
        status: 'fail',
        reason: `Token Expired: Shift badge expired on ${expDate}.`,
        errorCode: 'EXPIRED',
        payload: payload as Record<string, any>,
      };
    }

    // Single rule check
    if (typeof expectedClaimKeyOrRules === 'string' && expectedValue !== undefined) {
      const actualValue = payload[expectedClaimKeyOrRules];
      if (String(actualValue) !== String(expectedValue)) {
        return {
          valid: false,
          status: 'fail',
          reason: `Claim '${expectedClaimKeyOrRules}' mismatch (expected: "${expectedValue}", got: "${actualValue ?? 'undefined'}")`,
          payload: payload as Record<string, any>,
        };
      }
    }

    // Multiple inventory rules check
    if (Array.isArray(expectedClaimKeyOrRules) && expectedClaimKeyOrRules.length > 0) {
      for (const rule of expectedClaimKeyOrRules) {
        const actualValue = payload[rule.matchingClaimKey];
        if (actualValue === undefined || String(actualValue) !== String(rule.expectedValue)) {
          return {
            valid: false,
            status: 'fail',
            reason: `Rule failed [${rule.ruleName || rule.matchingClaimKey}]: claim '${rule.matchingClaimKey}' expected '${rule.expectedValue}' but got '${actualValue ?? 'missing'}'`,
            payload: payload as Record<string, any>,
          };
        }
      }
    }

    return {
      valid: true,
      status: 'pass',
      reason: 'RS256 Signature and Claim Rules Verified',
      payload: payload as Record<string, any>,
    };
  } catch (error: any) {
    return {
      valid: false,
      status: 'fail',
      reason: error instanceof Error ? error.message : 'Verification failed',
    };
  }
}

/**
 * Decodes the unverified payload claims from a JWT token without verifying signature.
 * Returns null if the token cannot be parsed as a JWT.
 */
export function extractJwtPayload(rawToken: string): Record<string, any> | null {
  try {
    const token = normalizeJwtToken(rawToken);
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = decodeURIComponent(
      atob(base64)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/**
 * Decodes the unverified header from a JWT token.
 * Returns null if the token header cannot be parsed.
 */
export function extractJwtHeader(rawToken: string): Record<string, any> | null {
  try {
    const token = normalizeJwtToken(rawToken);
    const parts = token.split('.');
    if (parts.length < 1) return null;
    const base64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = decodeURIComponent(
      atob(base64)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}
