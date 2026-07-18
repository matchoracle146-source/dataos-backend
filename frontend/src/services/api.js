// ═══════════════════════════════════════════════════════════════
// DataOS Frontend — Complete API Service Layer
// Connects to all 10 backend microservices
// ═══════════════════════════════════════════════════════════════

const API_BASE = process.env.REACT_APP_API_BASE || 'http://localhost:80';
const TIMEOUT = 30000;

// ─── HTTP Client ─────────────────────────────────────────────────────────────
class APIClient {
  constructor() {
    this.accessToken = localStorage.getItem('dataos_access_token');
    this.refreshToken = localStorage.getItem('dataos_refresh_token');
  }

  async request(method, path, body = null, options = {}) {
    const url = `${API_BASE}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Request-ID': crypto.randomUUID(),
    };

    if (this.accessToken) headers['Authorization'] = `Bearer ${this.accessToken}`;

    const deviceId = this.getDeviceId();
    if (deviceId) headers['X-Device-ID'] = deviceId;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : null,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Auto-refresh on 401
      if (response.status === 401 && this.refreshToken && !options.isRetry) {
        const refreshed = await this.refreshAccessToken();
        if (refreshed) {
          return this.request(method, path, body, { ...options, isRetry: true });
        }
        this.logout();
        throw new APIError('Session expired. Please log in again.', 401, 'SESSION_EXPIRED');
      }

      const data = await response.json();

      if (!response.ok) {
        throw new APIError(
          data.error?.message || 'Request failed',
          response.status,
          data.error?.code || 'REQUEST_FAILED',
          data.error?.details
        );
      }

      return data;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') throw new APIError('Request timed out', 408, 'TIMEOUT');
      if (err instanceof APIError) throw err;
      throw new APIError('Network error. Check your connection.', 0, 'NETWORK_ERROR');
    }
  }

  get(path, options) { return this.request('GET', path, null, options); }
  post(path, body, options) { return this.request('POST', path, body, options); }
  patch(path, body, options) { return this.request('PATCH', path, body, options); }
  delete(path, body, options) { return this.request('DELETE', path, body, options); }

  async refreshAccessToken() {
    try {
      const response = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-ID': this.getDeviceId(),
        },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });
      if (!response.ok) return false;
      const data = await response.json();
      this.setTokens(data.data.accessToken, data.data.refreshToken);
      return true;
    } catch {
      return false;
    }
  }

  setTokens(accessToken, refreshToken) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    localStorage.setItem('dataos_access_token', accessToken);
    localStorage.setItem('dataos_refresh_token', refreshToken);
  }

  logout() {
    this.accessToken = null;
    this.refreshToken = null;
    localStorage.removeItem('dataos_access_token');
    localStorage.removeItem('dataos_refresh_token');
    window.location.href = '/login';
  }

  getDeviceId() {
    let id = localStorage.getItem('dataos_device_id');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('dataos_device_id', id);
    }
    return id;
  }

  isAuthenticated() { return !!this.accessToken; }
}

class APIError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const client = new APIClient();

// ─── Auth API ─────────────────────────────────────────────────────────────────
export const AuthAPI = {
  requestOTP: (phone, purpose = 'login') =>
    client.post('/api/v1/auth/request-otp', { phone, purpose }),

  verifyOTP: async (phone, otp) => {
    const data = await client.post('/api/v1/auth/verify-otp', {
      phone, otp,
      device: {
        deviceId: client.getDeviceId(),
        deviceName: navigator.userAgent.slice(0, 100),
        platform: 'web',
        osVersion: navigator.platform,
        appVersion: '1.0.0',
      },
    });
    if (data.data?.accessToken) {
      client.setTokens(data.data.accessToken, data.data.refreshToken);
    }
    return data;
  },

  logout: async (everywhere = false) => {
    try { await client.delete('/api/v1/auth/logout', { everywhere }); } catch {}
    client.logout();
  },

  getSessions: () => client.get('/api/v1/auth/sessions'),
  revokeSession: (id) => client.delete(`/api/v1/auth/sessions/${id}`),
  isAuthenticated: () => client.isAuthenticated(),
};

// ─── User API ─────────────────────────────────────────────────────────────────
export const UserAPI = {
  getProfile: () => client.get('/api/v1/users/me'),
  updateProfile: (data) => client.patch('/api/v1/users/me', data),

  getSIMs: () => client.get('/api/v1/users/me/sims'),
  addSIM: (data) => client.post('/api/v1/users/me/sims', data),
  updateSIM: (simId, data) => client.patch(`/api/v1/users/me/sims/${simId}`, data),
  removeSIM: (simId) => client.delete(`/api/v1/users/me/sims/${simId}`),

  getBudgets: () => client.get('/api/v1/users/me/budgets'),
  setBudget: (data) => client.post('/api/v1/users/me/budgets', data),

  verifyNIN: (nin) => client.post('/api/v1/users/me/kyc/nin', { nin }),
  verifyBVN: (bvn) => client.post('/api/v1/users/me/kyc/bvn', { bvn }),

  exportData: () => client.get('/api/v1/users/me/data-export'),
  deleteAccount: (confirmation) => client.delete('/api/v1/users/me/account', { confirmation }),
};

// ─── Telecom API ──────────────────────────────────────────────────────────────
export const TelecomAPI = {
  getBalance: (simId, forceRefresh = false) =>
    client.get(`/api/v1/telecom/balance/${simId}${forceRefresh ? '?refresh=true' : ''}`),

  getBundles: (network, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return client.get(`/api/v1/telecom/bundles/${network}${qs ? '?' + qs : ''}`);
  },

  purchaseBundle: (simId, bundleId, paymentMethod = 'wallet_credits') =>
    client.post('/api/v1/telecom/purchase', { simId, bundleId, paymentMethod }),

  getPurchaseHistory: (simId, page = 1) =>
    client.get(`/api/v1/telecom/history/${simId}?page=${page}`),

  getNetworkHealth: () => client.get('/api/v1/telecom/health'),
};

// ─── AI API ───────────────────────────────────────────────────────────────────
export const AIAPI = {
  chat: (message, sessionId, history = []) =>
    client.post('/api/v1/ai/chat', { message, sessionId, history }),

  getInsights: () => client.get('/api/v1/ai/insights'),
  markInsightRead: (id, acted = false) =>
    client.patch(`/api/v1/ai/insights/${id}/read`, { acted }),

  getRecommendations: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return client.get(`/api/v1/ai/recommendations${qs ? '?' + qs : ''}`);
  },

  sendFeedback: (recommendationId, accepted, reason) =>
    client.post('/api/v1/ai/feedback', { recommendationId, accepted, reason }),

  getScore: () => client.get('/api/v1/ai/score/calculate').then(r => r.data),
  getTwin: () => client.get(`/api/v1/ai/twin/${client.getDeviceId()}`),
};

// ─── Wallet API ───────────────────────────────────────────────────────────────
export const WalletAPI = {
  getWallet: () => client.get('/api/v1/wallet'),
  getSummary: () => client.get('/api/v1/wallet/summary'),
  getTransactions: (type, page = 1) =>
    client.get(`/api/v1/wallet/transactions?page=${page}${type ? '&type=' + type : ''}`),

  redeemCredits: (credits, simId, bundleId) =>
    client.post('/api/v1/wallet/redeem', { credits, simId, bundleId }),

  borrowCredits: (amountNgn) =>
    client.post('/api/v1/wallet/borrow', { amountNgn }),

  repayLoan: () => client.post('/api/v1/wallet/repay', {}),

  giftCredits: (recipientPhone, credits, message) =>
    client.post('/api/v1/wallet/gift', { recipientPhone, credits, message }),

  convertCashback: () => client.post('/api/v1/wallet/cashback/convert', {}),

  checkBorrowEligibility: () => client.get('/api/v1/wallet/borrow/eligibility'),
};

// ─── Rewards API ──────────────────────────────────────────────────────────────
export const RewardsAPI = {
  getReferrals: () => client.get('/api/v1/rewards/referrals'),
  applyReferralCode: (code) =>
    client.post('/api/v1/rewards/referrals/apply', { referralCode: code, refereeUserId: 'me' }),

  getAchievements: () => client.get('/api/v1/rewards/achievements'),
  getChallenges: () => client.get('/api/v1/rewards/challenges'),
  getLeaderboard: (type = 'referrals') =>
    client.get(`/api/v1/rewards/leaderboard?type=${type}`),
};

// ─── Analytics API ────────────────────────────────────────────────────────────
export const AnalyticsAPI = {
  getSpendingSummary: (period = 'month') =>
    client.get(`/api/v1/analytics/spending/summary?period=${period}`),

  getSpendingByTime: () => client.get('/api/v1/analytics/spending/by-time'),
  getSpendingByApp: () => client.get('/api/v1/analytics/spending/by-app'),
  getCostPerGbTrend: () => client.get('/api/v1/analytics/cost-per-gb'),
  getMonthlyReport: (month) => client.get(`/api/v1/analytics/report/${month}`),
};

// ─── Forecast API ─────────────────────────────────────────────────────────────
export const ForecastAPI = {
  getExhaustion: (simId) => client.get(`/api/v1/forecast/exhaustion/${simId}`),
  getMonthlyCost: () => client.get('/api/v1/forecast/monthly-cost'),
  getRechargeCalendar: () => client.get('/api/v1/forecast/recharge-calendar'),
  getSavings: () => client.get('/api/v1/forecast/savings'),
  runScenario: (reductionPct) =>
    client.post('/api/v1/forecast/scenario', { reductionPct }),
};

// ─── Notifications API ────────────────────────────────────────────────────────
export const NotificationsAPI = {
  getAll: (unreadOnly = false) =>
    client.get(`/api/v1/notifications${unreadOnly ? '?unreadOnly=true' : ''}`),
  markRead: (id) => client.patch(`/api/v1/notifications/${id}/read`),
  markAllRead: () => client.patch('/api/v1/notifications/read-all'),
  updatePreferences: (prefs) => client.patch('/api/v1/notifications/preferences', prefs),
};

// ─── Community API ────────────────────────────────────────────────────────────
export const CommunityAPI = {
  getNetworkPerformance: (city = 'Lagos') =>
    client.get(`/api/v1/community/networks?city=${city}`),
  getBenchmarks: () => client.get('/api/v1/community/benchmarks'),
  getBundleRankings: (network) =>
    client.get(`/api/v1/community/bundle-rankings${network ? '?network=' + network : ''}`),
  submitNetworkReport: (data) => client.post('/api/v1/community/network-report', data),
  getNews: (network) =>
    client.get(`/api/v1/community/news${network ? '?network=' + network : ''}`),
  setConsent: (granted) => client.post('/api/v1/community/consent', { granted }),
};

export { client, APIError };
export default client;
