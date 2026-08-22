import { DEFAULT_SETTINGS } from './model.js';

const DB_NAME = 'slit-symptom-tracker';
const DB_VERSION = 1;
let dbPromise;

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexeddb_request_failed'));
  });
}

export function openDatabase() {
  if (!('indexedDB' in globalThis)) return Promise.reject(new Error('indexeddb_unavailable'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('sessions')) {
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('localDate', 'localDate');
        sessions.createIndex('doseTimestamp', 'doseTimestamp');
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexeddb_open_failed'));
  });
  return dbPromise;
}

async function transaction(storeNames, mode, callback) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('indexeddb_transaction_aborted'));
    tx.onerror = () => reject(tx.error || new Error('indexeddb_transaction_failed'));
    try {
      result = callback(tx);
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}

export async function getSessions() {
  const db = await openDatabase();
  const values = await requestPromise(db.transaction('sessions').objectStore('sessions').getAll());
  return values.sort((a, b) => new Date(b.doseTimestamp) - new Date(a.doseTimestamp));
}

export function putSession(session) {
  return transaction(['sessions'], 'readwrite', (tx) => tx.objectStore('sessions').put(session));
}

export function deleteSession(id) {
  return transaction(['sessions'], 'readwrite', (tx) => tx.objectStore('sessions').delete(id));
}

export async function getSettings() {
  const db = await openDatabase();
  const value = await requestPromise(db.transaction('settings').objectStore('settings').get('current'));
  return { ...DEFAULT_SETTINGS, ...(value || {}) };
}

export function putSettings(settings) {
  return transaction(['settings'], 'readwrite', (tx) => tx.objectStore('settings').put(settings, 'current'));
}

export async function getMeta(key) {
  const db = await openDatabase();
  return requestPromise(db.transaction('meta').objectStore('meta').get(key));
}

export function putMeta(key, value) {
  return transaction(['meta'], 'readwrite', (tx) => tx.objectStore('meta').put(value, key));
}

export function replaceAllData(sessions, settings) {
  return transaction(['sessions', 'settings'], 'readwrite', (tx) => {
    const sessionStore = tx.objectStore('sessions');
    sessionStore.clear();
    for (const session of sessions) sessionStore.put(session);
    tx.objectStore('settings').put(settings, 'current');
  });
}

export function deleteAllData() {
  return transaction(['sessions', 'settings', 'meta'], 'readwrite', (tx) => {
    tx.objectStore('sessions').clear();
    tx.objectStore('settings').clear();
    tx.objectStore('meta').clear();
  });
}
