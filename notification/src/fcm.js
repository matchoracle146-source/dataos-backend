// ═══════════════════════════════════════════════════════════════
// Firebase Cloud Messaging — V1 API (Legacy server key deprecated)
// Uses service account JWT for auth, not server key
// Firebase project: Dataos | Sender ID: 86909636218
// ═══════════════════════════════════════════════════════════════
'use strict';

const axios  = require('axios');
const crypto = require('crypto');
const { createLogger } = require('../../shared/utils');

const log = createLogger('fcm-v1');

// FCM V1 endpoint — project ID comes from service account JSON
const FCM_URL = (projectId) =>
  `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

// ─── Service Account JWT ──────────────────────────────────────────────────────
// Firebase V1 uses short-lived OAuth2 tokens signed with service account key
// Set FCM_SERVICE_ACCOUNT env var to the full JSON string of your service account
// Get it: Firebase Console → Project Settings → Service Accounts → Generate new private key
class FCMClient {
  constructor() {
    this._token      = null;
    this._tokenExpiry = 0;
    this._sa         = null;
    this._projectId  = process.env.FCM_PROJECT_ID || 'dataos-firebase'; // your Firebase project ID
  }

  _getServiceAccount() {
    if (this._sa) return this._sa;

    const raw = process.env.FCM_SERVICE_ACCOUNT;
    if (!raw) {
      throw new Error(
        'FCM_SERVICE_ACCOUNT env var not set. ' +
        'Get it from: Firebase Console → Project Settings → Service Accounts → Generate new private key. ' +
        'Paste the entire JSON as the env var value.'
      );
    }

    try {
      this._sa = JSON.parse(raw);
      this._projectId = this._sa.project_id || this._projectId;
      return this._sa;
    } catch {
      throw new Error('FCM_SERVICE_ACCOUNT is not valid JSON. Paste the entire service account JSON file contents.');
    }
  }

  // Build and sign a JWT for Google OAuth2
  _buildJWT(sa) {
    const now     = Math.floor(Date.now() / 1000);
    const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss:   sa.client_email,
      sub:   sa.client_email,
      aud:   'https://oauth2.googleapis.com/token',
      iat:   now,
      exp:   now + 3600,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    })).toString('base64url');

    const unsigned = `${header}.${payload}`;
    const sign     = crypto.createSign('RSA-SHA256');
    sign.update(unsigned);
    const signature = sign.sign(sa.private_key, 'base64url');

    return `${unsigned}.${signature}`;
  }

  async getAccessToken() {
    if (this._token && Date.now() < this._tokenExpiry - 60000) return this._token;

    const sa  = this._getServiceAccount();
    const jwt = this._buildJWT(sa);

    const res = await axios.post('https://oauth2.googleapis.com/token',
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion:  jwt,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );

    this._token       = res.data.access_token;
    this._tokenExpiry = Date.now() + (res.data.expires_in - 120) * 1000;
    return this._token;
  }

  // Send a push notification to a single FCM token
  async send(fcmToken, notification, data = {}) {
    if (!fcmToken) return { success: false, reason: 'no_token' };

    if (process.env.NODE_ENV !== 'production') {
      log.debug('FCM push (dev skipped)', { title: notification.title });
      return { success: true, dev: true };
    }

    try {
      const token  = await this.getAccessToken();
      const url    = FCM_URL(this._projectId);

      const message = {
        token: fcmToken,
        notification: {
          title: notification.title,
          body:  notification.body,
        },
        data: {
          ...Object.fromEntries(
            Object.entries(data).map(([k, v]) => [k, String(v)])
          ),
          deepLink: notification.deepLink || '/',
          type:     notification.type     || 'general',
        },
        android: {
          priority: 'high',
          notification: {
            sound:        'default',
            click_action: 'FLUTTER_NOTIFICATION_CLICK',
            channel_id:   'dataos_alerts',
          },
        },
        webpush: {
          headers: { Urgency: 'high' },
          notification: {
            icon:  '/icons/icon-192.png',
            badge: '/icons/badge-72.png',
            vibrate: [100, 50, 100],
          },
          fcm_options: { link: notification.deepLink || '/' },
        },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: {
            aps: {
              alert: { title: notification.title, body: notification.body },
              sound: 'default',
              badge: 1,
            },
          },
        },
      };

      const res = await axios.post(url, { message }, {
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      log.info('FCM push sent', { messageId: res.data.name });
      return { success: true, messageId: res.data.name };

    } catch (err) {
      const errData = err.response?.data?.error;

      // Token is stale — remove from DB
      if (errData?.code === 404 || errData?.status === 'UNREGISTERED') {
        log.info('FCM token unregistered — will remove', { fcmToken: fcmToken.slice(0, 20) });
        return { success: false, unregistered: true };
      }

      log.error('FCM send failed', { error: err.message, status: err.response?.status });
      return { success: false, error: err.message };
    }
  }

  // Send to multiple tokens (batched)
  async sendMulticast(tokens, notification, data = {}) {
    const results = await Promise.allSettled(
      tokens.map(t => this.send(t, notification, data))
    );
    return results.map((r, i) => ({
      token:  tokens[i],
      result: r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message },
    }));
  }
}

module.exports = new FCMClient();
