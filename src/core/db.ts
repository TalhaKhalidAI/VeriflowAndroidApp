let SQLite: any = null;

try {
  SQLite = require('expo-sqlite');
} catch {
  SQLite = null;
}

import { InventoryRecord, PublicKeyRecord, ScanRecord } from './types';

const memoryStore = {
  publicKeys: [] as PublicKeyRecord[],
  inventory: [] as InventoryRecord[],
  scans: [] as ScanRecord[],
  settings: {} as Record<string, string>,
};

const db = SQLite ? SQLite.openDatabaseSync?.('veriflow.db') ?? null : null;
const dbAny = db as any;

export function initDatabase(): Promise<void> {
  if (!db) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    try {
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
      });
      resolve();
    } catch (error) {
      reject(error);
    }
  });
}

// ---------------- PUBLIC KEYS ----------------
export function getPublicKeys(): Promise<PublicKeyRecord[]> {
  if (!db) {
    return Promise.resolve(memoryStore.publicKeys);
  }
  try {
    return Promise.resolve(dbAny.getAllSync('SELECT * FROM public_keys ORDER BY created_at DESC'));
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

  const existing = dbAny.getFirstSync(
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
    return Promise.resolve(dbAny.getAllSync('SELECT * FROM inventory_ids ORDER BY id DESC'));
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

export async function syncRulesFromPayload(
  rules?: any,
): Promise<number> {
  if (!rules) return 0;

  // Normalize rules into array of { ruleName, claimKey, expectedValue }
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
        // Plain key-value object within array
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
    // Plain key-value dict: { matching_claim_key: expected_value }
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

// ---------------- SCANS QUEUE ----------------
export function addScanToQueue(
  scannedJwt: string,
  status: 'pass' | 'fail',
  notes?: string,
  userId?: number,
  shiftId?: string,
): Promise<number> {
  const timestamp = new Date().toISOString();
  if (!db) {
    const item: ScanRecord = {
      id: memoryStore.scans.length + 1,
      user_id: userId,
      shift_id: shiftId,
      scanned_jwt: scannedJwt,
      status,
      sync_status: 'pending',
      scanned_at: timestamp,
      notes,
    };
    memoryStore.scans.unshift(item);
    return Promise.resolve(item.id);
  }

  try {
    const result = db.runSync(
      'INSERT INTO scans_queue (scanned_jwt, status, sync_status, scanned_at, notes, user_id, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [scannedJwt, status, 'pending', timestamp, notes ?? null, userId ?? null, shiftId ?? null],
    );
    return Promise.resolve(Number(result.lastInsertRowId));
  } catch (err: any) {
    if (String(err?.message || err).includes('no column named')) {
      try { db.execSync('ALTER TABLE scans_queue ADD COLUMN user_id INTEGER;'); } catch {}
      try { db.execSync('ALTER TABLE scans_queue ADD COLUMN shift_id TEXT;'); } catch {}
      try { db.execSync('ALTER TABLE scans_queue ADD COLUMN scanned_at TEXT;'); } catch {}
      try { db.execSync('ALTER TABLE scans_queue ADD COLUMN notes TEXT;'); } catch {}
      const retryResult = db.runSync(
        'INSERT INTO scans_queue (scanned_jwt, status, sync_status, scanned_at, notes, user_id, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [scannedJwt, status, 'pending', timestamp, notes ?? null, userId ?? null, shiftId ?? null],
      );
      return Promise.resolve(Number(retryResult.lastInsertRowId));
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
  if (!db) {
    return Promise.resolve(
      memoryStore.scans.some(
        s =>
          s.scanned_jwt.trim() === trimmed &&
          (shiftId ? s.shift_id === shiftId : true) &&
          (userId !== undefined ? s.user_id === userId : true),
      ),
    );
  }
  try {
    let query = 'SELECT id FROM scans_queue WHERE scanned_jwt = ?';
    const params: any[] = [trimmed];

    if (shiftId) {
      query += ' AND shift_id = ?';
      params.push(shiftId);
    }
    if (userId !== undefined) {
      query += ' AND user_id = ?';
      params.push(userId);
    }

    const row = dbAny.getFirstSync(query, params);
    return Promise.resolve(Boolean(row?.id));
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
        dbAny.getAllSync(
          'SELECT * FROM scans_queue WHERE sync_status != ? AND user_id = ? ORDER BY id DESC',
          ['synced', userId],
        ),
      );
    }
    return Promise.resolve(
      dbAny.getAllSync('SELECT * FROM scans_queue WHERE sync_status != ? ORDER BY id DESC', ['synced']),
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
        dbAny.getAllSync(
          'SELECT * FROM scans_queue WHERE sync_status = ? AND user_id = ? ORDER BY id DESC',
          ['failed', userId],
        ),
      );
    }
    return Promise.resolve(
      dbAny.getAllSync('SELECT * FROM scans_queue WHERE sync_status = ? ORDER BY id DESC', ['failed']),
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
        dbAny.getAllSync(
          'SELECT * FROM scans_queue WHERE user_id = ? ORDER BY id DESC',
          [userId],
        ),
      );
    }
    return Promise.resolve(dbAny.getAllSync('SELECT * FROM scans_queue ORDER BY id DESC'));
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
    : (dbAny.getAllSync('SELECT * FROM scans_queue ORDER BY id DESC') as ScanRecord[]);

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
      const scanRow = dbAny.getFirstSync('SELECT COUNT(*) as cnt FROM scans_queue');
      deletedScans = Number(scanRow?.cnt ?? 0);
    } catch {}
    try {
      const ruleRow = dbAny.getFirstSync('SELECT COUNT(*) as cnt FROM inventory_ids');
      deletedRules = Number(ruleRow?.cnt ?? 0);
    } catch {}
    try {
      const keyRow = dbAny.getFirstSync('SELECT COUNT(*) as cnt FROM public_keys');
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
    const row = dbAny.getFirstSync('SELECT value FROM app_settings WHERE key = ?', [key]);
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
