// ═══════════════════════════════════════════════════════════════
// DataOS — SMS Service (OTP Delivery)
// MTN numbers   → MTN SMS API v2 (production, approved)
// Other networks → Termii (primary) → Africa's Talking (fallback)
// ═══════════════════════════════════════════════════════════════
'use strict';

const axios = require('axios');
const { createLogger, detectNetwork, maskPhone } = require('../../../shared/utils');

const log = createLogger('sms-service');

// ─── MTN SMS via approved MTN Developer API ───────────────────────────────────
class MTNSMSChannel {
  constructor() {
    this.clientId     = process.env.MTN_CLIENT_ID;
    this.clientSecret = process.env.MTN_CLIENT_SECRET;
    this.apiKey       = process.env.MTN_API_KEY || process.env.MTN_CLIENT_ID;
    this._token       = null;
    this._tokenExpiry = 0;
  }

  async getToken() {
    if (this._token && Date.now() < this._tokenExpiry - 60000) return this._token;
    const params = new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     this.clientId,
      client_secret: this.clientSecret,
    });
    const res = await axios.post('https://api.mtn.com/v1/oauth/access_token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    this._token       = res.data.access_token;
    this._tokenExpiry = Date.now() + parseInt(res.data.expires_in || '3599', 10) * 1000;
    return this._token;
  }

  async send(msisdn, message) {
    const token  = await this.getToken();
    const txnId  = require('uuid').v4();

    const res = await axios.post('https://api.mtn.com/v2/messages/sms/outbound', {
      senderAddress:    'DataOS',
      receiverAddress:  [msisdn],
      message,
      clientCorrelator: txnId,
      serviceCode:      process.env.MTN_SERVICE_CODE || 'DataOS',
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-api-key':   this.apiKey,
        transactionId: txnId,
        'Content-Type':'application/json',
      },
      timeout: 10000,
    });

    return { success: true, messageId: res.data?.data?.messageId || txnId, channel: 'MTN_API' };
  }
}

// ─── Termii (all networks, primary for non-MTN) ───────────────────────────────
class TermiiChannel {
  async send(msisdn, message) {
    const res = await axios.post('https://api.ng.termii.com/api/sms/send', {
      to:      msisdn,
      from:    'DataOS',
      sms:     message,
      type:    'plain',
      api_key: process.env.TERMII_API_KEY,
      channel: 'generic',
    }, { timeout: 10000 });

    return { success: true, messageId: res.data?.message_id, channel: 'TERMII' };
  }
}

// ─── Africa's Talking (fallback) ──────────────────────────────────────────────
class AfricasTalkingChannel {
  async send(msisdn, message) {
    const params = new URLSearchParams({
      username: process.env.AT_USERNAME,
      to:       msisdn,
      message,
      from:     'DataOS',
    });
    await axios.post('https://api.africastalking.com/version1/messaging',
      params.toString(), {
        headers: {
          apiKey:         process.env.AT_API_KEY,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000,
      }
    );
    return { success: true, channel: 'AT' };
  }
}

// ─── SMS Service — routes by network ─────────────────────────────────────────
class SMSService {
  constructor() {
    this.mtn     = new MTNSMSChannel();
    this.termii  = new TermiiChannel();
    this.at      = new AfricasTalkingChannel();
  }

  async sendOTP(msisdn, otp) {
    const message = `Your DataOS verification code is: ${otp}\n\nExpires in 60 seconds. Never share this code.\n\n- DataOS`;

    // Development — log only, never call real APIs
    if (process.env.NODE_ENV !== 'production') {
      log.info('DEV: OTP not sent to real number', {
        phone: maskPhone(msisdn), otp,
      });
      return { success: true, dev: true, otp };
    }

    const network = detectNetwork(msisdn);
    log.info('Sending OTP', { phone: maskPhone(msisdn), network });

    // MTN numbers → MTN SMS API first (our approved channel)
    if (network === 'MTN' && this.mtn.clientId) {
      try {
        const result = await this.mtn.send(msisdn, message);
        log.info('OTP sent via MTN API', { phone: maskPhone(msisdn) });
        return result;
      } catch (err) {
        log.warn('MTN SMS API failed, falling back to Termii', { err: err.message });
      }
    }

    // All others (or MTN API failure) → Termii
    if (process.env.TERMII_API_KEY) {
      try {
        const result = await this.termii.send(msisdn, message);
        log.info('OTP sent via Termii', { phone: maskPhone(msisdn) });
        return result;
      } catch (err) {
        log.warn('Termii failed, falling back to Africa\'s Talking', { err: err.message });
      }
    }

    // Last resort → Africa's Talking
    if (process.env.AT_API_KEY) {
      const result = await this.at.send(msisdn, message);
      log.info('OTP sent via Africa\'s Talking', { phone: maskPhone(msisdn) });
      return result;
    }

    throw new Error('All SMS channels exhausted. Check MTN_CLIENT_ID, TERMII_API_KEY, AT_API_KEY.');
  }
}

module.exports = new SMSService();
