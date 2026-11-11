# Wallets

Splits your bank balance into wallets, lets you pay by UPI from a chosen wallet, and
helps you match the app with your real balance. Your money never moves between wallets
for real; the app only keeps count. All data stays on your phone.

## Put it on your phone (free, nothing to install on the PC)

The app has to be opened from an https address for the camera and "install" to work.
GitHub Pages gives you one for free.

1. On github.com, create a new repository named `wallets`. Choose **Public**
   (free Pages needs a public repository; it only holds the app's code, never your data).
2. On the new repository's page, click **uploading an existing file**, drag in every
   file from this folder, and click **Commit changes**.
3. Go to **Settings > Pages**. Under "Build and deployment" pick **Deploy from a branch**,
   branch **main**, folder **/ (root)**, then **Save**.
4. After a minute or two, open `https://YOUR-USERNAME.github.io/wallets/` in Chrome on your phone.
5. Chrome menu (three dots) > **Add to Home screen** > **Install**. It now opens like any app
   and works offline.

## Using it

- **Wallets**: enter your bank balance once, create wallets, move money into them.
  "Unallocated" is whatever is in the bank but not in a wallet.
- **Pay**: scan a QR (or pick a QR photo, type a UPI ID, or a phone number), enter the amount,
  pick the wallet (it shows whether there is enough), then pick the UPI app. When you come
  back, tap **Paid** or **Not paid**. Money is only deducted on **Paid**.
- **Refresh**: type your current bank balance. If it differs from what the app expects,
  add the missing transactions by hand or read them from a screenshot, and pick a wallet
  for each. Anything you don't explain sits in Unallocated.
- **History**: tap an entry to change its wallet or delete it (deleting undoes it).
- **Settings** (gear on the Wallets tab): backup, restore, erase.

Screenshot reading runs on the phone with Tesseract (open-source OCR); screenshots are
never uploaded and no API key is needed. The first time you use it, the reader (a few MB)
is downloaded from cdn.jsdelivr.net, so you need internet once. Every transaction it finds
can be corrected before it is added.

## Where to change things

| To change | Open |
|---|---|
| Colours, sizes, spacing | `app.css` (colour list is at the very top) |
| Wallet colour choices, list of UPI apps | top of `app.js`, `COLORS` and `UPI_APPS` |
| Money rules (what a payment, move or refresh does) | `app.js` section 1 |
| Screens (Wallets, Pay, Refresh, History) | `app.js` section 3 |
| Pop-up forms and what their buttons do | `app.js` section 4 |
| UPI link building and QR scanning | `app.js` section 5 |
| How screenshot text becomes transactions | `app.js` section 6 (`parseAppRows`, `parseStatementRows`) |
| App name and icon | `manifest.webmanifest`, `icon-192.png`, `icon-512.png` |

After changing any file, upload it to GitHub again and bump `wallets-v1` to `wallets-v2`
in `sw.js` so phones pick up the new version.

`jsqr.js` is the open-source QR reader library (jsQR); leave it as is.
