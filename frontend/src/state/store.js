// ═══════════════════════════════════════════════════════════════
// DataOS Frontend — Global State Management (Zustand)
// ═══════════════════════════════════════════════════════════════
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { AuthAPI, UserAPI, TelecomAPI, AIAPI, WalletAPI, AnalyticsAPI, ForecastAPI, NotificationsAPI } from './api';

// ─── Auth Store ───────────────────────────────────────────────────────────────
export const useAuthStore = create(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      requestOTP: async (phone) => {
        set({ isLoading: true, error: null });
        try {
          const data = await AuthAPI.requestOTP(phone);
          set({ isLoading: false });
          return data;
        } catch (err) {
          set({ isLoading: false, error: err.message });
          throw err;
        }
      },

      verifyOTP: async (phone, otp) => {
        set({ isLoading: true, error: null });
        try {
          const data = await AuthAPI.verifyOTP(phone, otp);
          set({
            isAuthenticated: true,
            isLoading: false,
            error: null,
          });
          // Load user profile immediately
          await get().loadProfile();
          return data;
        } catch (err) {
          set({ isLoading: false, error: err.message });
          throw err;
        }
      },

      loadProfile: async () => {
        try {
          const data = await UserAPI.getProfile();
          set({ user: data.data });
        } catch (err) {
          console.error('Failed to load profile:', err);
        }
      },

      logout: async () => {
        await AuthAPI.logout();
        set({ user: null, isAuthenticated: false });
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'dataos-auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ isAuthenticated: state.isAuthenticated }),
    }
  )
);

// ─── Dashboard Store ───────────────────────────────────────────────────────────
export const useDashboardStore = create((set, get) => ({
  sims: [],
  balances: {},
  insights: [],
  wallet: null,
  score: null,
  notifications: [],
  unreadCount: 0,
  isLoading: false,
  lastRefresh: null,

  loadDashboard: async () => {
    set({ isLoading: true });
    try {
      const [simsData, walletData, insightsData, notifData] = await Promise.allSettled([
        UserAPI.getSIMs(),
        WalletAPI.getSummary(),
        AIAPI.getInsights(),
        NotificationsAPI.getAll(true),
      ]);

      const sims = simsData.status === 'fulfilled' ? simsData.value.data : [];
      set({
        sims,
        wallet: walletData.status === 'fulfilled' ? walletData.value.data : null,
        insights: insightsData.status === 'fulfilled' ? insightsData.value.data : [],
        unreadCount: notifData.status === 'fulfilled' ? notifData.value.meta?.unreadCount || 0 : 0,
        isLoading: false,
        lastRefresh: Date.now(),
      });

      // Load balances in parallel
      if (sims.length) {
        get().refreshAllBalances(sims);
      }
    } catch (err) {
      set({ isLoading: false });
      console.error('Dashboard load failed:', err);
    }
  },

  refreshAllBalances: async (sims, forceRefresh = false) => {
    const simsToFetch = sims || get().sims;
    const results = await Promise.allSettled(
      simsToFetch.map(sim => TelecomAPI.getBalance(sim.id, forceRefresh))
    );

    const balances = {};
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        balances[simsToFetch[i].id] = result.value.data;
      }
    });

    set(state => ({ balances: { ...state.balances, ...balances } }));
  },

  refreshBalance: async (simId, forceRefresh = true) => {
    try {
      const data = await TelecomAPI.getBalance(simId, forceRefresh);
      set(state => ({
        balances: { ...state.balances, [simId]: data.data }
      }));
      return data.data;
    } catch (err) {
      console.error('Balance refresh failed:', err);
      throw err;
    }
  },

  loadScore: async () => {
    try {
      const data = await AIAPI.getScore();
      set({ score: data });
    } catch (err) {
      console.error('Score load failed:', err);
    }
  },

  markNotificationRead: async (id) => {
    await NotificationsAPI.markRead(id);
    set(state => ({
      unreadCount: Math.max(0, state.unreadCount - 1),
    }));
  },

  dismissInsight: async (id) => {
    await AIAPI.markInsightRead(id, false);
    set(state => ({
      insights: state.insights.filter(i => i.id !== id),
    }));
  },

  actOnInsight: async (id) => {
    await AIAPI.markInsightRead(id, true);
    set(state => ({
      insights: state.insights.filter(i => i.id !== id),
    }));
  },

  getTotalBalance: () => {
    const { balances } = get();
    return Object.values(balances).reduce((sum, b) => sum + (parseFloat(b?.balanceMb || 0)), 0);
  },

  getTotalSpent: () => {
    // Computed from wallet or fetched separately
    return get().wallet?.earnedThisMonth || 0;
  },
}));

// ─── Analytics Store ───────────────────────────────────────────────────────────
export const useAnalyticsStore = create((set) => ({
  summary: null,
  byTime: null,
  byApp: null,
  costTrend: null,
  period: 'month',
  isLoading: false,

  setPeriod: (period) => set({ period }),

  loadSummary: async (period = 'month') => {
    set({ isLoading: true });
    try {
      const [summaryData, timeData, appData, costData] = await Promise.allSettled([
        AnalyticsAPI.getSpendingSummary(period),
        AnalyticsAPI.getSpendingByTime(),
        AnalyticsAPI.getSpendingByApp(),
        AnalyticsAPI.getCostPerGbTrend(),
      ]);

      set({
        summary: summaryData.status === 'fulfilled' ? summaryData.value.data : null,
        byTime: timeData.status === 'fulfilled' ? timeData.value.data : null,
        byApp: appData.status === 'fulfilled' ? appData.value.data : null,
        costTrend: costData.status === 'fulfilled' ? costData.value.data : null,
        period,
        isLoading: false,
      });
    } catch (err) {
      set({ isLoading: false });
    }
  },
}));

// ─── AI Chat Store ─────────────────────────────────────────────────────────────
export const useAIChatStore = create((set, get) => ({
  messages: [],
  sessionId: null,
  isLoading: false,
  error: null,

  initSession: () => {
    const sessionId = crypto.randomUUID();
    set({
      sessionId,
      messages: [{
        role: 'assistant',
        content: 'Hi! I\'m your DataOS AI. I can help you manage your data spending, find better bundles, and predict when you\'ll run out. What would you like to know?',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      }],
    });
    return sessionId;
  },

  sendMessage: async (content) => {
    const { messages, sessionId } = get();
    const userMsg = {
      role: 'user',
      content,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    set(state => ({
      messages: [...state.messages, userMsg],
      isLoading: true,
      error: null,
    }));

    try {
      const history = messages.map(m => ({ role: m.role, content: m.content }));
      const data = await AIAPI.chat(content, sessionId, history);

      const aiMsg = {
        role: 'assistant',
        content: data.data.message,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        context: data.data.context,
      };

      set(state => ({
        messages: [...state.messages, aiMsg],
        isLoading: false,
      }));
    } catch (err) {
      set(state => ({
        messages: [...state.messages, {
          role: 'assistant',
          content: 'I\'m having trouble connecting right now. Please try again in a moment.',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          error: true,
        }],
        isLoading: false,
        error: err.message,
      }));
    }
  },

  clearHistory: () => set({ messages: [], sessionId: null }),
}));

// ─── Wallet Store ─────────────────────────────────────────────────────────────
export const useWalletStore = create((set) => ({
  wallet: null,
  transactions: [],
  eligibility: null,
  isLoading: false,

  loadWallet: async () => {
    set({ isLoading: true });
    try {
      const [walletData, eligData] = await Promise.allSettled([
        WalletAPI.getSummary(),
        WalletAPI.checkBorrowEligibility(),
      ]);

      set({
        wallet: walletData.status === 'fulfilled' ? walletData.value.data : null,
        eligibility: eligData.status === 'fulfilled' ? eligData.value.data : null,
        isLoading: false,
      });
    } catch {
      set({ isLoading: false });
    }
  },

  loadTransactions: async (type) => {
    const data = await WalletAPI.getTransactions(type);
    set({ transactions: data.data });
  },

  borrow: async (amountNgn) => {
    const data = await WalletAPI.borrowCredits(amountNgn);
    set(state => ({
      wallet: state.wallet ? {
        ...state.wallet,
        balance: state.wallet.balance + data.data.creditsAdded,
      } : null,
    }));
    return data.data;
  },

  redeem: async (credits, simId, bundleId) => {
    const data = await WalletAPI.redeemCredits(credits, simId, bundleId);
    return data.data;
  },
}));

// ─── Forecast Store ───────────────────────────────────────────────────────────
export const useForecastStore = create((set) => ({
  exhaustions: {},
  monthlyCost: null,
  rechargeCalendar: null,
  savings: null,
  isLoading: false,

  loadAllForecasts: async (sims) => {
    set({ isLoading: true });
    try {
      const [costData, calData, savData] = await Promise.allSettled([
        ForecastAPI.getMonthlyCost(),
        ForecastAPI.getRechargeCalendar(),
        ForecastAPI.getSavings(),
      ]);

      set({
        monthlyCost: costData.status === 'fulfilled' ? costData.value.data : null,
        rechargeCalendar: calData.status === 'fulfilled' ? calData.value.data : null,
        savings: savData.status === 'fulfilled' ? savData.value.data : null,
        isLoading: false,
      });

      // Load exhaustion per SIM
      if (sims?.length) {
        const exhaustionResults = await Promise.allSettled(
          sims.map(sim => ForecastAPI.getExhaustion(sim.id))
        );
        const exhaustions = {};
        exhaustionResults.forEach((r, i) => {
          if (r.status === 'fulfilled') exhaustions[sims[i].id] = r.value.data;
        });
        set({ exhaustions });
      }
    } catch {
      set({ isLoading: false });
    }
  },
}));
