/**
 * MoneyTracker - Hardcoded Firebase Realtime Database & Master Key Security Wrapper
 */

// ============================================================================
// HARDCODED DATABASE URL (No secrets/API keys exposed in source code)
// ============================================================================
const FIREBASE_DB_URL = "https://money-tracker-b6ba6-default-rtdb.firebaseio.com/webapp";

class DataAPI {
  constructor() {
    this.url = FIREBASE_DB_URL.replace(/\/$/, "");
    this.keyStorageName = 'moneytracker_master_key';
    this.queueKey = 'moneytracker_sync_queue';

    // Load saved Master Key from localStorage
    this.masterKey = localStorage.getItem(this.keyStorageName) || null;

    // Load queue of pending offline actions
    this.queue = JSON.parse(localStorage.getItem(this.queueKey) || '[]');

    // Setup network listeners for auto-sync
    window.addEventListener('online', () => this.processQueue());

    // Auto-process queue on startup if key is present
    if (this.isConfigured()) {
      setTimeout(() => this.processQueue(), 800);
    }
  }

  /**
   * Returns true if a Master Key has been set and verified
   */
  isConfigured() {
    return !!(this.masterKey && this.masterKey.trim().length > 0);
  }

  isUnlocked() {
    return this.isConfigured();
  }

  /**
   * Validates and saves the Master Key permanently in localStorage
   */
  async setMasterKey(key) {
    const cleanKey = (key || '').trim();
    if (!cleanKey) throw new Error("Master key cannot be empty.");

    // Test the master key against Firebase
    const testUrl = `${this.url}/moneytracker_data.json?auth=${encodeURIComponent(cleanKey)}`;
    const res = await fetch(testUrl, { method: 'GET' });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error("Invalid Master Key: Unauthorized access.");
      }
      throw new Error(`Firebase connection failed (Status ${res.status}).`);
    }

    // Save master key permanently
    this.masterKey = cleanKey;
    localStorage.setItem(this.keyStorageName, this.masterKey);

    this.notifyStatusChange();
    this.processQueue();
    window.dispatchEvent(new CustomEvent('moneytracker:db_unlocked'));
    return true;
  }

  /**
   * Locks the app by clearing the saved Master Key
   */
  clearMasterKey() {
    this.masterKey = null;
    localStorage.removeItem(this.keyStorageName);
    this.notifyStatusChange();
    window.dispatchEvent(new CustomEvent('moneytracker:db_locked'));
  }

  notifyStatusChange() {
    const status = {
      isConfigured: this.isConfigured(),
      isUnlocked: this.isUnlocked()
    };
    window.dispatchEvent(new CustomEvent('moneytracker:db_status', { detail: status }));
  }

  /**
   * Internal fetch with master key authentication
   */
  async _fetchAPI(path, method = 'GET', data = null) {
    if (!this.isConfigured()) {
      throw new Error("Access Denied: Master key not provided.");
    }

    let url = `${this.url}/${path}.json?auth=${encodeURIComponent(this.masterKey)}`;
    const options = {
      method,
      headers: { "Content-Type": "application/json" }
    };
    if (data) options.body = JSON.stringify(data);

    const res = await fetch(url, options);
    if (!res.ok) {
      throw new Error(`Firebase Error: ${res.status}`);
    }

    return await res.json();
  }

  /**
   * Pushes an action to the offline queue
   */
  queueAction(action, payload) {
    if (!this.isConfigured()) return;
    this.queue.push({ id: Date.now().toString(), action, payload });
    localStorage.setItem(this.queueKey, JSON.stringify(this.queue));
    this.processQueue();
  }

  /**
   * Processes queued actions when online
   */
  async processQueue() {
    if (!this.isConfigured() || !navigator.onLine || this.isSyncing) return;
    if (this.queue.length === 0) return;

    this.isSyncing = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue[0];
        await this._fetchAPI(job.payload.path, job.action, job.payload.data);
        this.queue.shift();
        localStorage.setItem(this.queueKey, JSON.stringify(this.queue));
      }
    } catch (e) {
      console.warn("Sync queue stalled:", e);
    } finally {
      this.isSyncing = false;
    }
  }

  async fetchDocuments(collection) {
    if (!this.isConfigured() || !navigator.onLine) return null;
    try {
      const res = await this._fetchAPI(collection, 'GET');
      if (!res) return null;
      return Object.keys(res).map(key => ({ _id: key, ...res[key] }));
    } catch (e) {
      console.warn("Failed to fetch documents:", e);
      return null;
    }
  }

  upsertDocument(collection, filter, updateDoc) {
    if (!filter._id || !this.isConfigured()) return;
    this.queueAction('PUT', {
      path: `${collection}/${filter._id}`,
      data: updateDoc
    });
  }
}

// Global database instance
window.db = new DataAPI();
