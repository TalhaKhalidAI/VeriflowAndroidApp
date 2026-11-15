import { NativeModules } from 'react-native';
import { InventoryRecord, PublicKeyRecord, ScanRecord } from './types';

export type DatabaseErrorCode = 'SQLCIPHER_BUILD_MISSING' | 'OFFLINE_DB_UNREADABLE';

export class DatabaseSecurityError extends Error {
  code: DatabaseErrorCode;
  constructor(code: DatabaseErrorCode, message: string) {
    super(message);
    this.name = 'DatabaseSecurityError';
    this.code = code;
  }
}

let OpSQLite: any = null;
let ExpoSQLite: any = null;
let Keychain: any = null;

try {
  // Prefer @op-engineering/op-sqlite with sqlcipher: true when native build is linked
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  OpSQLite = require('@op-engineering/op-sqlite');
} catch {
  OpSQLite = null;
}

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ExpoSQLite = require('expo-sqlite');
} catch {
  ExpoSQLite = null;
}

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Keychain = require('react-native-keychain');
} catch {
  Keychain = null;
}

const KEYCHAIN_SERVICE = 'veriflow_sqlcipher_db_key';
const KEYCHAIN_ACCOUNT = 'veriflow_db_encryption';

const memoryStore = {
  publicKeys: [] as PublicKeyRecord[],
  inventory: [] as InventoryRecord[],
  scans: [] as ScanRecord[],
  settings: {} as Record<string, string>,
};

let db: any = null;
let dbEngine: 'op-sqlite' | 'expo-sqlite' | 'memory' = 'memory';
let sqlCipherActive = false;
let lastDbError: DatabaseSecurityError | null = null;

function generateRandomHexKey(bytesLength = 32): string {
  const bytes = new Uint8Array(bytesLength);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytesLength; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Retrieves or creates the stable 256-bit SQLCipher encryption key from Android Keystore.
 * Uses react-native-keychain (Keychain.getGenericPassword / setGenericPassword) first,
 * and falls back to the native AndroidKeyStore AES-256-GCM hardware wrapper in VeriFlowCustomCa.
 * Never hardcodes any secret key in the JS bundle.
 */
export async function getDatabaseKeyFromKeystore(): Promise<string> {
  // 1. Primary path: react-native-keychain (Android Keystore backed)
  if (Keychain && typeof Keychain.getGenericPassword === 'function') {
    try {
      const credentials = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
      if (credentials && typeof credentials === 'object' && credentials.password) {
        return credentials.password;
      }
      // Check if native AndroidKeyStore already has a key before generating a new one
      const nativeMod = NativeModules?.VeriFlowCustomCa;
      const candidateKey =
        nativeMod && typeof nativeMod.getOrCreateKeystoreKey === 'function'
          ? await nativeMod.getOrCreateKeystoreKey(KEYCHAIN_SERVICE)
          : generateRandomHexKey(32);

      if (typeof Keychain.setGenericPassword === 'function') {
        await Keychain.setGenericPassword(KEYCHAIN_ACCOUNT, candidateKey, {
          service: KEYCHAIN_SERVICE,
          accessible: Keychain.ACCESSIBLE?.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        });
      }
      return candidateKey;
    } catch (err) {
      console.warn('Keychain.getGenericPassword fallback to native AndroidKeyStore:', err);
    }
  }

  // 2. Native AndroidKeyStore hardware-backed AES-256-GCM key via VeriFlowCustomCa
  const nativeMod = NativeModules?.VeriFlowCustomCa;
  if (nativeMod) {
    if (typeof nativeMod.getOrCreateKeystoreKey === 'function') {
      const key = await nativeMod.getOrCreateKeystoreKey(KEYCHAIN_SERVICE);
      if (key && typeof key === 'string' && key.length >= 32) {
        return key;
      }
    }
    if (typeof nativeMod.getOrCreateKeystoreKeySync === 'function') {
      const key = nativeMod.getOrCreateKeystoreKeySync(KEYCHAIN_SERVICE);
      if (key && typeof key === 'string' && key.length >= 32) {
        return key;
      }
    }
  }

  throw new DatabaseSecurityError(
    'SQLCIPHER_BUILD_MISSING',
    'Android Keystore native module is unavailable to unlock SQLCipher database.',
  );
}

/**
 * Adapter that normalizes op-sqlite and expo-sqlite behind a single synchronous/transactional API.
 */
function createOpSqliteAdapter(rawOpDb: any) {
  return {
    execSync(sql: string) {
      return rawOpDb.executeSync ? rawOpDb.executeSync(sql) : rawOpDb.execute(sql);
    },
    runSync(sql: string, params: any[] = []) {
      const res = rawOpDb.executeSync ? rawOpDb.executeSync(sql, params) : rawOpDb.execute(sql, params);
      return {
        lastInsertRowId: res?.insertId ?? 0,
        changes: res?.rowsAffected ?? 0,
      };
    },
    getAllSync(sql: string, params: any[] = []) {
      const res = rawOpDb.executeSync ? rawOpDb.executeSync(sql, params) : rawOpDb.execute(sql, params);
      return res?.rows?._array ?? res?.rows ?? [];
    },
    getFirstSync(sql: string, params: any[] = []) {
      const rows = this.getAllSync(sql, params);
      return rows.length > 0 ? rows[0] : null;
    },
    withTransactionSync(fn: () => void) {
      this.execSync('BEGIN TRANSACTION;');
      try {
        fn();
        this.execSync('COMMIT;');
      } catch (e) {
        try {
          this.execSync('ROLLBACK;');
        } catch {}
        throw e;
      }
    },
  };
}

export function getDatabaseHealth(): {
  engine: 'op-sqlite' | 'expo-sqlite' | 'memory';
  sqlCipherActive: boolean;
  error: DatabaseSecurityError | null;
} {
  return {
    engine: dbEngine,
    sqlCipherActive,
    error: lastDbError,
  };
}

function openAndEncryptDatabase(encryptionKey: string): void {
  const escapedKey = encryptionKey.replace(/'/g, "''");

  // 1. Try op-sqlite with SQLCipher first if native module is linked
  if (OpSQLite && typeof OpSQLite.open === 'function') {
    try {
      const rawOpDb = OpSQLite.open({
        name: 'veriflow_encrypted.db',
        encryptionKey,
      });
      const adapter = createOpSqliteAdapter(rawOpDb);
      // Verify readability (throws if key changed / OFFLINE_DB_UNREADABLE)
      adapter.getFirstSync('SELECT count(*) as cnt FROM sqlite_master;');
      db = adapter;
      dbEngine = 'op-sqlite';
      sqlCipherActive = true;
      lastDbError = null;
      return;
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (msg.toLowerCase().includes('not a database') || msg.toLowerCase().includes('file is encrypted')) {
        lastDbError = new DatabaseSecurityError(
          'OFFLINE_DB_UNREADABLE',
          'Local encrypted SQLite database cannot be decrypted with the current Android Keystore key (OFFLINE_DB_UNREADABLE).',
        );
        throw lastDbError;
      }
      console.warn('op-sqlite initialization skipped, falling back to expo-sqlite:', msg);
    }
  }

  // 2. Use expo-sqlite with SQLCipher PRAGMA key
  if (ExpoSQLite && typeof ExpoSQLite.openDatabaseSync === 'function') {
    const rawExpoDb = ExpoSQLite.openDatabaseSync('veriflow.db');
    try {
      rawExpoDb.execSync(`PRAGMA key = '${escapedKey}';`);
      sqlCipherActive = true;
    } catch {
      // Standard SQLite build without SQLCipher pragma support continues gracefully
      sqlCipherActive = false;
    }

    try {
      // Verify database header is readable and not corrupted / key-mismatched
      rawExpoDb.getFirstSync('SELECT count(*) as cnt FROM sqlite_master;');
      db = rawExpoDb;
      dbEngine = 'expo-sqlite';
      lastDbError = null;
      return;
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      lastDbError = new DatabaseSecurityError(
        'OFFLINE_DB_UNREADABLE',
        `Offline SQLite database is unreadable (${msg}). Keystore key may have changed or DB file is corrupted.`,
      );
      throw lastDbError;
    }
  }
}

export async function initDatabase(): Promise<void> {
  try {
    if (!db) {
      let dbKey = '';
      try {
        dbKey = await getDatabaseKeyFromKeystore();
      } catch (keyErr: any) {
        if (keyErr instanceof DatabaseSecurityError) {
          console.warn(`[DB Security] ${keyErr.code}: ${keyErr.message}`);
        }
        // If running on web or environment without Android Keystore, open standard DB
        if (ExpoSQLite && typeof ExpoSQLite.openDatabaseSync === 'function') {
          db = ExpoSQLite.openDatabaseSync('veriflow.db');
          dbEngine = 'expo-sqlite';
        }
      }

      if (dbKey && !db) {
        openAndEncryptDatabase(dbKey);
      }
    }

    if (!db) {
      return;
    }

    db.withTransactionSync(() => {
      db.execSync(`
        CREATE TABLE IF NOT EXISTS public_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          public_key_string TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);

      db.execSync(`
        CREATE TABLE IF NOT EXISTS inventory_ids (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          inventory_name TEXT NOT NULL,
          matching_claim_key TEXT NOT NULL,
          expected_value TEXT NOT NULL
        );
      `);

      db.execSync(`
        CREATE TABLE IF NOT EXISTS scans_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          shift_id TEXT,
          scanned_jwt TEXT NOT NULL,
          status TEXT NOT NULL,
          sync_status TEXT NOT NULL DEFAULT 'pending',
          scanned_at TEXT,
          notes TEXT
        );
      `);

      db.execSync(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);

      // Automatic migration for existing databases: ensure newly added columns exist
      try { db.execSync('ALTER TABLE scans_queue ADD COLUMN user_id INTEGER;'); } catch {}
      try { db.execSync('ALTER TABLE scans_queue ADD COLUMN shift_id TEXT;'); } catch {}
      try { db.execSync('ALTER TABLE scans_queue ADD COLUMN scanned_at TEXT;'); } catch {}
      try { db.execSync('ALTER TABLE scans_queue ADD COLUMN notes TEXT;'); } catch {}
      try { db.execSync('CREATE INDEX IF NOT EXISTS idx_scans_user_sync ON scans_queue (user_id, sync_status);'); } catch {}
      try { db.execSync('CREATE INDEX IF NOT EXISTS idx_scans_jwt_shift ON scans_queue (scanned_jwt, shift_id);'); } catch {}
      // Remove any legacy duplicate rows before creating unique index on scans_queue
      try {
        db.execSync(`
          DELETE FROM scans_queue
          WHERE id NOT IN (
            SELECT MIN(id)
            FROM scans_queue
            GROUP BY scanned_jwt, COALESCE(shift_id, '')
          );
        `);
        db.execSync(
          "CREATE UNIQUE INDEX IF NOT EXISTS uq_scans_queue_jwt_shift ON scans_queue (scanned_jwt, COALESCE(shift_id, ''));",
        );
      } catch {}
    });
  } catch (error: any) {
    if (error instanceof DatabaseSecurityError) {
      lastDbError = error;
      throw error;
    }
    const msg = String(error?.message || error || '');
    if (msg.toLowerCase().includes('not a database') || msg.toLowerCase().includes('encrypted')) {
      lastDbError = new DatabaseSecurityError('OFFLINE_DB_UNREADABLE', msg);
      throw lastDbError;
    }
    throw error;
  }
}

export async function resetUnreadableDatabase(): Promise<void> {
  try {
    if (ExpoSQLite && typeof ExpoSQLite.deleteDatabaseSync === 'function') {
      try {
        ExpoSQLite.deleteDatabaseSync('veriflow.db');
      } catch {}
    }
    db = null;
    lastDbError = null;
    await initDatabase();
  } catch (e) {
    console.warn('Failed resetting unreadable database:', e);
  }
}

// ---------------- PUBLIC KEYS ----------------
export function getPublicKeys(): Promise<PublicKeyRecord[]> {
  if (!db) {
    return Promise.resolve(memoryStore.publicKeys);
  }
  try {
    return Promise.resolve(db.getAllSync('SELECT * FROM public_keys ORDER BY created_at DESC'));
  } catch {
    return Promise.resolve([]);
  }
}

export function upsertPublicKey(name: string, publicKeyString: string): Promise<number> {
  const trimmedPem = publicKeyString.trim();
  if (!db) {
    const existing = memoryStore.publicKeys.find(
      k => k.public_key_string.trim() === trimmedPem || k.name === name
    );
    if (existing) {
      existing.public_key_string = trimmedPem;
      existing.name = name;
      return Promise.resolve(existing.id);
    }
    const item: PublicKeyRecord = {
      id: memoryStore.publicKeys.length + 1,
      name,
      public_key_string: trimmedPem,
      created_at: new Date().toISOString(),
    };
    memoryStore.publicKeys.unshift(item);
    return Promise.resolve(item.id);
  }

  const existing = db.getFirstSync(
    'SELECT id FROM public_keys WHERE public_key_string = ? OR name = ?',
    [trimmedPem, name],
  );

  if (existing?.id) {
    db.runSync(
      'UPDATE public_keys SET public_key_string = ?, name = ? WHERE id = ?',
      [trimmedPem, name, existing.id],
    );
    return Promise.resolve(Number(existing.id));
  }

  const result = db.runSync(
    'INSERT INTO public_keys (name, public_key_string, created_at) VALUES (?, ?, ?)',
    [name, trimmedPem, new Date().toISOString()],
  );
  return Promise.resolve(Number(result.lastInsertRowId));
}

export function addPublicKey(name: string, publicKeyString: string): Promise<number> {
  return upsertPublicKey(name, publicKeyString);
}

export function updatePublicKey(id: number, name: string, publicKeyString: string): Promise<void> {
  if (!db) {
    memoryStore.publicKeys = memoryStore.publicKeys.map(item => item.id === id ? { ...item, name, public_key_string: publicKeyString } : item);
    return Promise.resolve();
  }
  db.runSync('UPDATE public_keys SET name = ?, public_key_string = ? WHERE id = ?', [name, publicKeyString, id]);
  return Promise.resolve();
}

export function deletePublicKey(id: number): Promise<void> {
  if (!db) {
    memoryStore.publicKeys = memoryStore.publicKeys.filter(item => item.id !== id);
    return Promise.resolve();
  }
  db.runSync('DELETE FROM public_keys WHERE id = ?', [id]);
  return Promise.resolve();
}

// ---------------- INVENTORY RULES ----------------
export function getInventoryItems(): Promise<InventoryRecord[]> {
  if (!db) {
    return Promise.resolve(memoryStore.inventory);
  }
  try {
    return Promise.resolve(db.getAllSync('SELECT * FROM inventory_ids ORDER BY id DESC'));
  } catch {
    return Promise.resolve([]);
  }
}

export function addInventoryItem(
  inventoryName: string,
  matchingClaimKey: string,
  expectedValue: string,
): Promise<number> {
  if (!db) {
    const item: InventoryRecord = {
      id: memoryStore.inventory.length + 1,
      inventory_name: inventoryName,
      matching_claim_key: matchingClaimKey,
      expected_value: expectedValue,
    };
    memoryStore.inventory.unshift(item);
    return Promise.resolve(item.id);
  }

  const result = db.runSync(
    'INSERT INTO inventory_ids (inventory_name, matching_claim_key, expected_value) VALUES (?, ?, ?)',
    [inventoryName, matchingClaimKey, expectedValue],
  );
  return Promise.resolve(Number(result.lastInsertRowId));
}

export function updateInventoryItem(
  id: number,
  inventoryName: string,
  matchingClaimKey: string,
  expectedValue: string,
): Promise<void> {
  if (!db) {
    memoryStore.inventory = memoryStore.inventory.map(item => item.id === id ? { ...item, inventory_name: inventoryName, matching_claim_key: matchingClaimKey, expected_value: expectedValue } : item);
    return Promise.resolve();
  }
  db.runSync(
    'UPDATE inventory_ids SET inventory_name = ?, matching_claim_key = ?, expected_value = ? WHERE id = ?',
    [inventoryName, matchingClaimKey, expectedValue, id],
  );
  return Promise.resolve();
}

export function deleteInventoryItem(id: number): Promise<void> {
  if (!db) {
    memoryStore.inventory = memoryStore.inventory.filter(item => item.id !== id);
    return Promise.resolve();
  }
  db.runSync('DELETE FROM inventory_ids WHERE id = ?', [id]);
  return Promise.resolve();
}

export function replaceInventoryRules(
  rules: Array<{ rule_name?: string; matching_claim_key: string; expected_value: string }>,
): Promise<void> {
  if (!db) {
    memoryStore.inventory = rules.map((r, idx) => ({
      id: idx + 1,
      inventory_name: r.rule_name || `Rule_${r.matching_claim_key}`,
      matching_claim_key: r.matching_claim_key,
      expected_value: String(r.expected_value ?? ''),
    }));
    return Promise.resolve();
  }
  try {
    db.runSync('DELETE FROM inventory_ids');
    for (const r of rules) {
      db.runSync(
        'INSERT INTO inventory_ids (inventory_name, matching_claim_key, expected_value) VALUES (?, ?, ?)',
        [r.rule_name || `Rule_${r.matching_claim_key}`, r.matching_claim_key, String(r.expected_value ?? '')],
      );
    }
  } catch (e) {
    console.warn('replaceInventoryRules error:', e);
  }
  return Promise.resolve();
}

export async function syncRulesFromPayload(
  rules?: any,
): Promise<number> {
  if (!rules) return 0;

  const normalizedList: Array<{ ruleName: string; claimKey: string; expectedValue: string }> = [];

  if (Array.isArray(rules)) {
    for (const r of rules) {
      if (!r || typeof r !== 'object') continue;
      if (r.matching_claim_key) {
        normalizedList.push({
          ruleName: r.rule_name || `Rule_${r.matching_claim_key}`,
          claimKey: String(r.matching_claim_key),
          expectedValue: String(r.expected_value ?? ''),
        });
      } else {
        for (const [k, v] of Object.entries(r)) {
          normalizedList.push({
            ruleName: `Rule_${k}`,
            claimKey: String(k),
            expectedValue: String(v ?? ''),
          });
        }
      }
    }
  } else if (typeof rules === 'object') {
    for (const [k, v] of Object.entries(rules)) {
      if (k === 'rule_name' || k === 'matching_claim_key') continue;
      normalizedList.push({
        ruleName: `Rule_${k}`,
        claimKey: String(k),
        expectedValue: String(v ?? ''),
      });
    }
  }

  if (normalizedList.length === 0) return 0;

  const existing = await getInventoryItems();
  let addedCount = 0;

  for (const r of normalizedList) {
    const match = existing.find(
      e => e.matching_claim_key === r.claimKey && String(e.expected_value) === r.expectedValue,
    );

    if (!match) {
      await addInventoryItem(r.ruleName, r.claimKey, r.expectedValue);
      addedCount++;
    }
  }

  return addedCount;
}

function extractScanJti(scannedJwt: string): string | null {
  try {
    const parts = scannedJwt.trim().split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
    if (typeof globalThis.atob !== 'function') return null;
    const jsonStr = decodeURIComponent(
      globalThis
        .atob(padded)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
    const payload = JSON.parse(jsonStr);
    if (payload && typeof payload === 'object' && payload.jti) {
      return String(payload.jti).trim();
    }
  } catch {}
  return null;
}

// ---------------- SCANS QUEUE ----------------
export async function addScanToQueue(
  scannedJwt: string,
  status: 'pass' | 'fail',
  notes?: string,
  userId?: number,
  shiftId?: string,
): Promise<number> {
  const trimmed = scannedJwt.trim();
  // Prevent duplicate scan history records in local DB before inserting
  const alreadyExists = await isScanAlreadyInQueue(trimmed, userId, shiftId);
  if (alreadyExists) {
    if (!db) {
      const existing = memoryStore.scans.find(s => s.scanned_jwt.trim() === trimmed);
      return existing?.id ?? 0;
    }
    const existingRow = db.getFirstSync(
      'SELECT id FROM scans_queue WHERE scanned_jwt = ? ORDER BY id DESC LIMIT 1',
      [trimmed],
    );
    return Number(existingRow?.id ?? 0);
  }

  const timestamp = new Date().toISOString();
  if (!db) {
    const item: ScanRecord = {
      id: memoryStore.scans.length + 1,
      user_id: userId,
      shift_id: shiftId,
      scanned_jwt: trimmed,
      status,
      sync_status: 'pending',
      scanned_at: timestamp,
      notes,
    };
    memoryStore.scans.unshift(item);
    return item.id;
  }

  try {
    const result = db.runSync(
      'INSERT OR IGNORE INTO scans_queue (scanned_jwt, status, sync_status, scanned_at, notes, user_id, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [trimmed, status, 'pending', timestamp, notes ?? null, userId ?? null, shiftId ?? null],
    );
    return Number(result.lastInsertRowId);
  } catch (err: any) {
    if (String(err?.message || err).includes('no column named')) {
      try { db.execSync('ALTER TABLE scans_queue ADD COLUMN user_id INTEGER;'); } catch {}
      try { db.execSync('ALTER TABLE scans_queue ADD COLUMN shift_id TEXT;'); } catch {}
      try { db.execSync('ALTER TABLE scans_queue ADD COLUMN scanned_at TEXT;'); } catch {}
      try { db.execSync('ALTER TABLE scans_queue ADD COLUMN notes TEXT;'); } catch {}
      const retryResult = db.runSync(
        'INSERT OR IGNORE INTO scans_queue (scanned_jwt, status, sync_status, scanned_at, notes, user_id, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [trimmed, status, 'pending', timestamp, notes ?? null, userId ?? null, shiftId ?? null],
      );
      return Number(retryResult.lastInsertRowId);
    }
    throw err;
  }
}

export function isScanAlreadyInQueue(
  scannedJwt: string,
  userId?: number,
  shiftId?: string,
): Promise<boolean> {
  const trimmed = scannedJwt.trim();
  const targetJti = extractScanJti(trimmed);

  if (!db) {
    return Promise.resolve(
      memoryStore.scans.some(s => {
        if (s.scanned_jwt.trim() === trimmed) return true;
        if (targetJti && extractScanJti(s.scanned_jwt) === targetJti) return true;
        return false;
      }),
    );
  }
  try {
    // 1. Check exact token match across scan history in local DB
    const exactRow = db.getFirstSync(
      'SELECT id FROM scans_queue WHERE scanned_jwt = ? LIMIT 1',
      [trimmed],
    );
    if (exactRow?.id) {
      return Promise.resolve(true);
    }

    // 2. Check JTI match across scan history if the scanned QR has a unique JTI claim
    if (targetJti) {
      const recentRows = db.getAllSync(
        'SELECT scanned_jwt FROM scans_queue ORDER BY id DESC LIMIT 500',
      ) as Array<{ scanned_jwt: string }>;
      for (const r of recentRows) {
        if (r?.scanned_jwt && extractScanJti(r.scanned_jwt) === targetJti) {
          return Promise.resolve(true);
        }
      }
    }

    return Promise.resolve(false);
  } catch {
    return Promise.resolve(false);
  }
}

export function getPendingScans(userId?: number): Promise<ScanRecord[]> {
  if (!db) {
    return Promise.resolve(
      memoryStore.scans.filter(
        item => item.sync_status !== 'synced' && (userId === undefined || item.user_id === userId)
      )
    );
  }
  try {
    if (userId !== undefined) {
      return Promise.resolve(
        db.getAllSync(
          'SELECT * FROM scans_queue WHERE sync_status != ? AND user_id = ? ORDER BY id DESC',
          ['synced', userId],
        ),
      );
    }
    return Promise.resolve(
      db.getAllSync('SELECT * FROM scans_queue WHERE sync_status != ? ORDER BY id DESC', ['synced']),
    );
  } catch {
    return Promise.resolve([]);
  }
}

export function getFailedScans(userId?: number): Promise<ScanRecord[]> {
  if (!db) {
    return Promise.resolve(
      memoryStore.scans.filter(
        item => item.sync_status === 'failed' && (userId === undefined || item.user_id === userId)
      )
    );
  }
  try {
    if (userId !== undefined) {
      return Promise.resolve(
        db.getAllSync(
          'SELECT * FROM scans_queue WHERE sync_status = ? AND user_id = ? ORDER BY id DESC',
          ['failed', userId],
        ),
      );
    }
    return Promise.resolve(
      db.getAllSync('SELECT * FROM scans_queue WHERE sync_status = ? ORDER BY id DESC', ['failed']),
    );
  } catch {
    return Promise.resolve([]);
  }
}

export function markScansAsFailed(ids: number[], errorMsg?: string): Promise<void> {
  if (!ids.length) return Promise.resolve();
  if (!db) {
    memoryStore.scans = memoryStore.scans.map(s =>
      ids.includes(s.id)
        ? { ...s, sync_status: 'failed', notes: errorMsg ? `${s.notes || ''} [Sync Error: ${errorMsg}]` : s.notes }
        : s,
    );
    return Promise.resolve();
  }
  const placeholders = ids.map(() => '?').join(',');
  db.runSync(`UPDATE scans_queue SET sync_status = 'failed' WHERE id IN (${placeholders})`, ids);
  return Promise.resolve();
}

export function getAllScans(userId?: number): Promise<ScanRecord[]> {
  if (!db) {
    return Promise.resolve(
      memoryStore.scans.filter(
        item => userId === undefined || item.user_id === userId
      )
    );
  }
  try {
    if (userId !== undefined) {
      return Promise.resolve(
        db.getAllSync(
          'SELECT * FROM scans_queue WHERE user_id = ? ORDER BY id DESC',
          [userId],
        ),
      );
    }
    return Promise.resolve(db.getAllSync('SELECT * FROM scans_queue ORDER BY id DESC'));
  } catch {
    return Promise.resolve([]);
  }
}

export function markScansAsSynced(ids: number[]): Promise<void> {
  if (!ids.length) return Promise.resolve();
  if (!db) {
    memoryStore.scans = memoryStore.scans.map(s => ids.includes(s.id) ? { ...s, sync_status: 'synced' } : s);
    return Promise.resolve();
  }
  const placeholders = ids.map(() => '?').join(',');
  db.runSync(`UPDATE scans_queue SET sync_status = 'synced' WHERE id IN (${placeholders})`, ids);
  return Promise.resolve();
}

export function deleteScan(id: number): Promise<void> {
  if (!db) {
    memoryStore.scans = memoryStore.scans.filter(s => s.id !== id);
    return Promise.resolve();
  }
  db.runSync('DELETE FROM scans_queue WHERE id = ?', [id]);
  return Promise.resolve();
}

export function updateScanStatus(id: number, status: 'pass' | 'fail'): Promise<void> {
  if (!db) {
    memoryStore.scans = memoryStore.scans.map(s => s.id === id ? { ...s, status } : s);
    return Promise.resolve();
  }
  db.runSync('UPDATE scans_queue SET status = ? WHERE id = ?', [status, id]);
  return Promise.resolve();
}

export interface DailyScanStats {
  total: number;
  passCount: number;
  failCount: number;
  pendingSyncCount: number;
  syncedCount: number;
}

export function getDailyScanStats(userId?: number, shiftId?: string): Promise<DailyScanStats> {
  const allScans: ScanRecord[] = !db
    ? memoryStore.scans
    : (db.getAllSync('SELECT * FROM scans_queue ORDER BY id DESC') as ScanRecord[]);

  const today = new Date().toISOString().slice(0, 10);
  const relevant = allScans.filter(s => {
    if (userId !== undefined && s.user_id !== undefined && s.user_id !== userId) return false;
    if (shiftId && s.shift_id && s.shift_id === shiftId) return true;
    if (s.scanned_at && s.scanned_at.startsWith(today)) return true;
    return false;
  });

  const passCount = relevant.filter(s => s.status === 'pass').length;
  const failCount = relevant.filter(s => s.status === 'fail').length;
  const pendingSyncCount = allScans.filter(
    s => s.sync_status !== 'synced' && (userId === undefined || s.user_id === userId),
  ).length;
  const syncedCount = relevant.filter(s => s.sync_status === 'synced').length;

  return Promise.resolve({
    total: relevant.length,
    passCount,
    failCount,
    pendingSyncCount,
    syncedCount,
  });
}

// ---------------- WIPE ALL LOCAL SQLITE DATA ----------------
export function deleteAllSqliteData(): Promise<{
  deletedScans: number;
  deletedRules: number;
  deletedKeys: number;
}> {
  if (!db) {
    const deletedScans = memoryStore.scans.length;
    const deletedRules = memoryStore.inventory.length;
    const deletedKeys = memoryStore.publicKeys.length;
    memoryStore.scans = [];
    memoryStore.inventory = [];
    memoryStore.publicKeys = [];
    return Promise.resolve({ deletedScans, deletedRules, deletedKeys });
  }

  let deletedScans = 0;
  let deletedRules = 0;
  let deletedKeys = 0;

  db.withTransactionSync(() => {
    try {
      const scanRow = db.getFirstSync('SELECT COUNT(*) as cnt FROM scans_queue');
      deletedScans = Number(scanRow?.cnt ?? 0);
    } catch {}
    try {
      const ruleRow = db.getFirstSync('SELECT COUNT(*) as cnt FROM inventory_ids');
      deletedRules = Number(ruleRow?.cnt ?? 0);
    } catch {}
    try {
      const keyRow = db.getFirstSync('SELECT COUNT(*) as cnt FROM public_keys');
      deletedKeys = Number(keyRow?.cnt ?? 0);
    } catch {}

    db.runSync('DELETE FROM scans_queue');
    db.runSync('DELETE FROM inventory_ids');
    db.runSync('DELETE FROM public_keys');
  });

  memoryStore.scans = [];
  memoryStore.inventory = [];
  memoryStore.publicKeys = [];

  return Promise.resolve({ deletedScans, deletedRules, deletedKeys });
}

// ---------------- APP SETTINGS ----------------
export function getAppSetting(key: string, defaultValue: string = ''): Promise<string> {
  if (!db) {
    return Promise.resolve(memoryStore.settings[key] ?? defaultValue);
  }
  try {
    const row = db.getFirstSync('SELECT value FROM app_settings WHERE key = ?', [key]);
    return Promise.resolve(row?.value ?? defaultValue);
  } catch {
    return Promise.resolve(defaultValue);
  }
}

export function setAppSetting(key: string, value: string): Promise<void> {
  if (!db) {
    memoryStore.settings[key] = value;
    return Promise.resolve();
  }
  try {
    db.runSync(
      'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)',
      [key, value],
    );
  } catch (err) {
    console.error('Error saving app setting:', err);
  }
  return Promise.resolve();
}
