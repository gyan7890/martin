GLOBALOTTSTORE BOT SOURCE CODE
==============================

Ready-to-host Telegram shop bot source code.

Start here:
1. Open HOSTING_INSTRUCTIONS.txt
2. Edit .env
3. Run npm install
4. Run npm start
5. Open /admin in your Telegram bot
6. Open /admin-web in browser

All features are included.


BLANK / CLEAN SOURCE BUILD
==========================

DIGITAL STORE BOT — BLANK SOURCE CODE
=======================================

This ZIP is a clean/source source build for resale or new deployment.

Included:
- All bot features from the latest feature build
- Telegram app admin panel
- Web admin panel
- Team web access + permissions
- Bulk Data Helper
- Stock Wait Queue
- 30-minute payment expiry
- Safe Delivery Center
- Health & Speed Checker
- Group alerts + keyword direct-buy replies
- Custom delivery message templates
- Product descriptions, stock formats, brand codes, custom emojis

Not included:
- No users
- No orders
- No payments
- No products
- No admins
- No personal data
- No bot token
- No Binance keys
- No web admin password

First setup:
1. Rename .env.example to .env or add the variables in your hosting panel.
2. Set:
   BOT_TOKEN
   ADMIN_ID
   ADMIN_WEB_PASSWORD
   STORE_NAME
   SUPPORT_USERNAME
   WEB_BASE_URL
3. Deploy and start:
   npm install
   npm start
4. Send /claimowner or /admin from the Telegram account whose ID is ADMIN_ID.
5. Open web panel:
   https://your-domain.com/admin-web

How new owner adds data:
- Web Admin → Products → Add Product
- Web Admin → Payment Methods
- Web Admin → Settings
- Web Admin → Team Web Access
- Web Admin → Bulk Data Helper

Important:
- ADMIN_ID must be the buyer's numeric Telegram ID.
- BotFather Privacy Mode should be OFF for group keyword replies.
- Channel alerts require bot admin permission in the channel.
- Group alerts work when bot is added to group and can send messages.


DIGITAL STORE V17 - INLINE CHAT SCREEN UI

This version fixes the UI problem:
- Buttons are INLINE, attached to chat messages.
- Buttons are NOT bottom reply-keyboard buttons.
- On /start, the bot sends a remove-keyboard command to clear old bottom menu from previous versions.
- Then it sends the welcome message with inline buttons under the message.

Important:
Telegram itself controls button colors/theme. The bot controls layout/text/buttons, not exact green/blue gradient.

HOSTINGER SETTINGS:
Entry file: index.js
Node version: 24.x
Build command: None
Package manager: npm
Root directory: ./
WEBHOOK_URL: source/delete

TEST:
1. Upload files.
2. Redeploy.
3. Send /start
4. Logs should show:
   ✅ Inline chat-screen UI active
   📩 Incoming text from ...
5. The old bottom keyboard should disappear after /start.

SECURITY:
Do not put real tokens in public messages.
Use Hostinger Environment Variables for BOT_TOKEN and BINANCE keys.

BINANCE AUTO VERIFY:
Normal Binance API can verify on-chain deposits by TXID from deposit history.
Binance Pay UID/note full merchant auto-verification may require Binance Pay Merchant API.


V18 PREMIUM SMART UI:
- More attractive bold welcome message.
- Cleaner premium product detail card.
- Add Product flow improved:
  Product Name -> Price -> Short Details -> Emoji
- Bot auto-generates attractive product description from short details.
- When admin adds stock, users get autom