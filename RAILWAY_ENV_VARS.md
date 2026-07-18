# DataOS — Railway Environment Variables
# Set these on EVERY service in Railway (Variables tab)
# Use Railway's variable reference syntax for DB/Redis — Railway fills them automatically

## ── Core ──────────────────────────────────────────────────────────────────────
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
ALLOWED_ORIGINS=https://YOUR-APP.vercel.app

## ── JWT Keys (generate once, paste on all services) ──────────────────────────
# Run locally first:
#   openssl genrsa -out jwt_private.pem 4096
#   openssl rsa -in jwt_private.pem -pubout -out jwt_public.pem
# Then paste the FULL file contents including BEGIN/END lines
# In Railway's variable editor: click the var name → edit → paste with real newlines (not \n)
JWT_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nYOUR_KEY_HERE\n-----END RSA PRIVATE KEY-----
JWT_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\nYOUR_KEY_HERE\n-----END PUBLIC KEY-----

## ── Secrets (generate with: openssl rand -hex 32) ────────────────────────────
INTERNAL_API_KEY=generate_with_openssl_rand_hex_32
PHONE_HASH_SECRET=generate_with_openssl_rand_hex_32
MSISDN_HASH_SECRET=generate_with_openssl_rand_hex_32
NIN_HASH_SECRET=generate_with_openssl_rand_hex_32
BVN_HASH_SECRET=generate_with_openssl_rand_hex_32

## ── AI (Claude) ──────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-YOUR_KEY_HERE
CLAUDE_MODEL=claude-sonnet-4-6

## ── MTN Developer Portal — YOUR APPROVED "Dataos" APP ────────────────────────
# Source: developers.mtn.com → My Apps → Dataos (expand row)
# App status: APPROVED | Country: Nigeria | Expires: Never
# Consumer Key   → paste as MTN_CLIENT_ID and MTN_API_KEY (same value)
# Consumer Secret → paste as MTN_CLIENT_SECRET
#
# From your screenshot:
#   Consumer Key:    faGJXXXXXXXXXXXXXXXXXXXHT3B  ← replace X's with real chars
#   Consumer Secret: bg2wXXXXXXXXlejR              ← replace X's with real chars
#
# Approved production APIs you can now use:
#   Balance Management V1  → live balance fetch (no USSD needed)
#   Subscriptions V2       → bundle purchases
#   Plans V2               → real-time bundle catalog
#   SMS V2 / SMS V3 API    → OTP delivery for MTN numbers (FREE via your approval)
#   Prepay Balance V1      → detailed prepaid balance
#   Usage Management       → data consumption history
#   SIM Verification       → SIM ownership confirmation
#   Customer KYC Verif.    → NIN check via MTN (replaces Smile Identity for MTN users)
#   Data Gifting           → peer data gifting feature
#   Customer Rewards       → MTN loyalty points
#   Notifications V1/V2    → push via MTN channel
#   OAuth V1               → already green in portal
#   MTN USSD Interface     → programmatic USSD (backup channel)
MTN_CLIENT_ID=PASTE_YOUR_CONSUMER_KEY_HERE
MTN_CLIENT_SECRET=PASTE_YOUR_CONSUMER_SECRET_HERE
MTN_API_KEY=PASTE_YOUR_CONSUMER_KEY_HERE
MTN_SERVICE_CODE=DataOS

## ── Airtel (apply at developer.airtel.africa) ────────────────────────────────
# Apply now — approval is faster than MTN
# Until approved: Airtel adapter falls back to USSD automatically
AIRTEL_CLIENT_ID=APPLY_AT_DEVELOPER_AIRTEL_AFRICA
AIRTEL_CLIENT_SECRET=APPLY_AT_DEVELOPER_AIRTEL_AFRICA

## ── SMS Fallback (non-MTN numbers → Termii) ──────────────────────────────────
# termii.com → sign up → Dashboard → API Keys
# Sandbox key works immediately for testing
# Production key needs Nigerian business registration
TERMII_API_KEY=YOUR_TERMII_API_KEY_HERE

## ── Africa's Talking (last-resort SMS fallback) ──────────────────────────────
# account.africastalking.com → sign up free
AT_API_KEY=YOUR_AT_API_KEY_HERE
AT_USERNAME=YOUR_AT_USERNAME_HERE

## ── Push Notifications (Firebase) ────────────────────────────────────────────
# console.firebase.google.com → new project → Cloud Messaging → Server Key
FCM_SERVER_KEY=YOUR_FCM_SERVER_KEY_HERE

## ── KYC (Smile Identity — for Airtel/Glo/9mobile NIN checks) ─────────────────
# smileidentity.com → developer account
# Note: MTN users can use MTN KYC Verification API instead (already approved)
SMILE_PARTNER_ID=YOUR_SMILE_PARTNER_ID
SMILE_API_KEY=YOUR_SMILE_API_KEY

## ─────────────────────────────────────────────────────────────────────────────
## WHICH SERVICES NEED WHICH VARS
## ─────────────────────────────────────────────────────────────────────────────
## ALL 10 services need:
##   NODE_ENV, DATABASE_URL, REDIS_URL, JWT_PUBLIC_KEY,
##   INTERNAL_API_KEY, ALLOWED_ORIGINS
##
## auth-service also needs:
##   JWT_PRIVATE_KEY (only auth signs tokens — others only verify)
##   PHONE_HASH_SECRET, MSISDN_HASH_SECRET, NIN_HASH_SECRET, BVN_HASH_SECRET
##   MTN_CLIENT_ID, MTN_CLIENT_SECRET, MTN_API_KEY (for OTP via MTN SMS API)
##   TERMII_API_KEY, AT_API_KEY, AT_USERNAME (SMS fallback)
##
## telecom-service also needs:
##   MTN_CLIENT_ID, MTN_CLIENT_SECRET, MTN_API_KEY
##   AIRTEL_CLIENT_ID, AIRTEL_CLIENT_SECRET
##   AT_API_KEY, AT_USERNAME (USSD gateway)
##
## ai-service also needs:
##   ANTHROPIC_API_KEY, CLAUDE_MODEL
##
## notification-service also needs:
##   FCM_SERVER_KEY, TERMII_API_KEY
##
## user-service also needs:
##   SMILE_PARTNER_ID, SMILE_API_KEY
##   NIN_HASH_SECRET, BVN_HASH_SECRET
## ─────────────────────────────────────────────────────────────────────────────

## ── Firebase FCM V1 (UPDATED — legacy server key is DISABLED on your project) ──
# Your Firebase project: Dataos | Sender ID: 86909636218
# Cloud Messaging API V1: ENABLED ✅
#
# Step 1: Get service account JSON
#   Firebase Console → Project Settings → Service Accounts tab
#   → "Generate new private key" → download JSON file
#
# Step 2: Set these two env vars on notification-service in Railway:
#
# FCM_PROJECT_ID = your Firebase project ID (find in Project Settings → General)
# Example: dataos-12345 or dataos-firebase
FCM_PROJECT_ID=YOUR_FIREBASE_PROJECT_ID_HERE

# FCM_SERVICE_ACCOUNT = the ENTIRE contents of the downloaded JSON file
# Paste it as a single line (Railway handles multiline values)
# It looks like: {"type":"service_account","project_id":"...","private_key_id":"...","private_key":"-----BEGIN RSA PRIVATE KEY-----\n..."}
FCM_SERVICE_ACCOUNT=PASTE_ENTIRE_SERVICE_ACCOUNT_JSON_HERE

# ── IMPORTANT: DO NOT set FCM_SERVER_KEY ──────────────────────────────────────
# Your Firebase project has the legacy Cloud Messaging API DISABLED.
# The old FCM_SERVER_KEY approach will NOT work.
# The new fcm.js uses V1 API with service account — this is correct for your setup.
