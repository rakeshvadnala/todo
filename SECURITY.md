# Flow — security model

Flow is a static site (GitHub Pages). There is no server, so all protection is
done in the browser with the Web Crypto API.

## Architecture

```
master password ──PBKDF2-SHA256 · 600 000 iterations · random 16-byte salt──▶ KEK
KEK  ──AES-256-GCM wrap──▶  DEK  (random 256-bit data key)         → record.pw
recovery key (random 256-bit, optional) ──wrap──▶ DEK              → record.rec
DEK  ──AES-256-GCM, fresh random 96-bit IV on every write──▶ data  → record.data
```

* The password, KEK and DEK are never written anywhere. A wrong password fails
  the AES-GCM authentication tag, so **no password hash or verifier exists** to attack.
* In memory the DEK is a non-extractable `CryptoKey`; it is only made
  extractable momentarily (after re-entering the password) to change the password
  or create a recovery key.
* `js/vault.js` loads first. `script.js` / `features.js` are fetched and run
  **only after** a successful unlock, so no task data exists in memory or in the
  DOM while locked. **Lock** (button, `Ctrl+Shift+L`, or inactivity timeout)
  flushes the encrypted write and reloads the page, discarding every key and all
  decrypted data.
* All app storage goes through `window.FlowStore` (an in-memory map persisted as
  one encrypted blob in `localStorage["flow_vault_v1"]`). That blob also holds
  the GitHub token, backups, the last-used profile and preferences.
* A strict Content-Security-Policy (`script-src 'self'`, `connect-src` limited to
  `self` and `api.github.com`) limits the damage of an injected script.

## What is stored where

| Where | Content |
|-------|---------|
| `localStorage["flow_vault_v1"]` | Encrypted vault record (salt, wrapped keys, ciphertext). Nothing readable. |
| GitHub `data/flow-board.json` | A vault record whose ciphertext contains **only the board** (never the sync token, backups or preferences). |
| Memory (while unlocked) | Decrypted data and the non-extractable key. |
| Nowhere | Password, KEK, recovery key (shown once). |

## Recovery

* **Recovery key** — created at set-up (recommended) or in Settings → Security.
  Shown once; unlocks the vault and forces a new password. Store it in a password
  manager or on paper, **never in this repo**.
* **Encrypted backup** — Settings → *Export encrypted backup*, or the synced
  GitHub file. Both can be restored from the lock screen with the password.
  A second device is set up the same way (*Restore from backup → Fetch from this site*).
* **If you lose the password *and* the recovery key, the encrypted data cannot be
  recovered — by you, by GitHub, or by anyone else.** That is the point of the design.

## Deploying on GitHub Pages

1. Push the repository; Settings → Pages → deploy from `main` / root. (HTTPS is
   required for Web Crypto and is automatic on Pages.)
2. Open the site, choose a master password, save the recovery key.
3. Settings → GitHub sync: enter owner, repo and a fine-grained token with
   *Contents: read/write* on this repo only. The token is stored encrypted.
4. The first sync overwrites `data/flow-board.json` with the encrypted record.

## ⚠ Existing plaintext in git history

Earlier versions committed `data/flow-board.json` **unencrypted** (hundreds of
commits). Encrypting going forward does not remove those copies. Treat everything
in that history as already public:

1. Sync once from the unlocked app so the current file is encrypted.
2. Rewrite history: `git filter-repo --path data/flow-board.json --invert-paths`
   (or BFG), then `git push --force --all`. Alternatively make the repository
   private, or delete and re-create it.
3. Anything sensitive in old tasks may already be cached or forked; rotate any
   secrets that appeared in task text, and revoke/replace the old GitHub token.

## Limitations

* Client-side only: an attacker who can run script on the site origin while the
  app is **unlocked** can read decrypted data. The CSP and the lock timeout reduce
  this; they cannot eliminate it.
* Strength depends on the password. PBKDF2 slows guessing but cannot save a weak
  passphrase — use a long one (4+ random words). Attempt throttling on the lock
  screen is client-side and only a speed bump; the real defence is PBKDF2 plus
  password length.
* Metadata is visible in the public repo: file size, commit times, that a Flow
  vault exists.
* Notifications contain task titles and appear in the OS notification centre; turn
  off *Show task titles* in Settings if that is a concern. They fire only while
  the app is open (a static site has no push server).
* JSON/CSV exports and print/PDF are **plaintext by design** (labelled as such).
* Two tabs writing at once resolve last-writer-wins.
* Destroying browser storage deletes the local vault; the GitHub copy and any
  exported backup are then your only copies.
