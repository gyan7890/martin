# 🚀 24/7 Vercel Hosting & Cloud Data Persistence Guide

This bot is configured to run **24/7 on Vercel** via Telegram Webhooks with **Permanent MongoDB Atlas Cloud Persistence** so it never loses data (stock, orders, users, balances) and **never needs to run on your local PC**.

---

## 1. Get Free Permanent MongoDB Database (5 Minutes)

1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) and create a free account.
2. Create a **Free Cluster (M0 Sandbox - 100% Free Forever)**.
3. Under **Database Access**, create a database user and password (e.g. `storeuser` / `yourpassword`).
4. Under **Network Access**, click **Add IP Address** -> Select **Allow Access From Anywhere (`0.0.0.0/0`)**.
5. Click **Connect** -> Choose **Drivers (Node.js)**.
6. Copy the connection string format:
   ```text
   mongodb+srv://storeuser:<password>@cluster0.xxxx.mongodb.net/?retryWrites=true&w=majority
   ```
   *(Replace `<password>` with your database user password)*.

---

## 2. Configure Vercel Environment Variables

In your Vercel Project Settings -> **Environment Variables**, add:

```env
BOT_TOKEN=your_telegram_bot_token
ADMIN_ID=your_numeric_telegram_id
STORE_NAME=Your Store Name
SUPPORT_USERNAME=@your_support_username
STORE_CURRENCY=INR
WEB_BASE_URL=https://your-project.vercel.app
ADMIN_WEB_USER=admin
ADMIN_WEB_PASSWORD=your_strong_admin_password
MONGODB_URI=mongodb+srv://storeuser:yourpassword@cluster0.xxxx.mongodb.net/?retryWrites=true&w=majority
```

---

## 3. Deploy to Vercel

1. Import this repository / project folder into Vercel.
2. Click **Deploy**.
3. Once deployed, open in browser to verify:
   ```text
   https://your-project.vercel.app/health
   ```
   *You should see `"mode": "vercel-serverless-24-7"` and `"mongoPersistence": true`.*

---

## 4. Activate Telegram Webhook (One-Time Link)

In your browser, open:
```text
https://your-project.vercel.app/api/set-webhook
```

You will see:
```json
{
  "ok": true,
  "webhook": "https://your-project.vercel.app/api/telegram",
  "result": { "ok": true, "description": "Webhook was set" }
}
```

Check webhook status anytime:
```text
https://your-project.vercel.app/api/webhook-info
```

---

## 5. Stop & Remove Local PC Dependencies

Now that your bot is deployed on Vercel:
- **Do NOT run** `node index.js`, `runner.js`, or `start_24_7.bat` on your PC.
- You can turn off your PC completely.
- Telegram will send all messages directly to Vercel 24/7, and Vercel will save all orders, payments, users, and stock updates directly into your cloud MongoDB database!
