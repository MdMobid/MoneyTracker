/**
 * MoneyTracker - Firebase Realtime Database & Offline Queue Wrapper
 */

class DataAPI {
  constructor() {
    this.configKey = 'moneytracker_db_config';
    this.queueKey = 'moneytracker_sync_queue';

    // Load config: { url, key }
    this.config = JSON.parse(localStorage.getItem(this.configKey) || 'null');

    // Load queue of pending offline actions
    this.queue = JSON.parse(localStorage.getItem(this.queueKey) || '[]');

    // Add network listeners for auto-sync
    window.addEventListener('online', () => this.processQueue());

    // Process on boot
    if (this.config) {
      setTimeout(() => this.processQueue(), 1000);
    }
  }

  isConfigured() {
    return !!(this.config && this.config.url);
  }

  saveConfig(url, key) {
    // Clean URL to ensure no trailing slash
    url = url.replace(/\/$/, "");
    this.config = { url, key };
    localStorage.setItem(this.configKey, JSON.stringify(this.config));
    this.processQueue();
  }

  clearConfig() {
    this.config = null;
    localStorage.removeItem(this.configKey);
  }

  /**
   * Internal pure fetch against Firebase REST API
   */
  async _fetchAPI(path, method = 'GET', data = null) {
    if (!this.isConfigured()) return null;

    let url = `${this.config.url}/${path}.json`;
    if (this.config.key) {
      url += `?auth=${this.config.key}`;
    }

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
   * Pushes a background job to sync later if offline
   */
  queueAction(action, payload) {
    if (!this.isConfigured()) return;
    this.queue.push({ id: Date.now().toString(), action, payload });
    localStorage.setItem(this.queueKey, JSON.stringify(this.queue));
    this.processQueue();
  }

  /**
   * Run through offline actions
   */
  async processQueue() {
    if (!this.isConfigured() || !navigator.onLine || this.isSyncing) return;
    if (this.queue.length === 0) return;

    this.isSyncing = true;

    try {
      while (this.queue.length > 0) {
        const job = this.queue[0];

        // Firebase specific execution
        await this._fetchAPI(job.payload.path, job.action, job.payload.data);

        // Remove completed job
        this.queue.shift();
        localStorage.setItem(this.queueKey, JSON.stringify(this.queue));
      }
    } catch (e) {
      console.warn("Sync queue stalled, likely offline or API error", e);
    } finally {
      this.isSyncing = false;
    }
  }

  // --- Collection Helpers to match the old MongoDB structure ---

  async fetchDocuments(collection) {
    if (!this.isConfigured() || !navigator.onLine) return null;
    try {
      const res = await this._fetchAPI(collection, 'GET');
      if (!res) return null;
      // Convert Firebase object back into MongoDB style array of documents
      return Object.keys(res).map(key => ({ _id: key, ...res[key] }));
    } catch (e) {
      console.warn("Failed to fetch documents:", e);
      return null;
    }
  }

  upsertDocument(collection, filter, updateDoc) {
    // For Firebase, we can just PUT directly to the path collection/id to overwrite/create it
    if (!filter._id) return;
    this.queueAction('PUT', {
      path: `${collection}/${filter._id}`,
      data: updateDoc
    });
  }
}

// Global instance
window.db = new DataAPI();
