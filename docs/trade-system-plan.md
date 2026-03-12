# Phase 1: Trade Request System — Detailed Implementation Plan

## Overview

Add a 1-for-1 day trade system to the dog walking calendar. Users can request trades (open or directed), and the other person accepts or declines. Accepted trades update the calendar for everyone in real time.

**People:** Franco, Manés, Santi
**Current system:** Pure algorithmic rotation (mod-3 from a reference date), no backend.
**After this feature:** Firebase Realtime DB stores trade overrides; calendar checks overrides before falling back to the algorithm.

---

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage | Firebase Realtime DB (free tier) | Real-time sync, no server to manage, free for this scale |
| Identity | Simple name selector (localStorage) | Only 3 trusted users, no auth overhead needed |
| Trade type | Always 1-for-1 swap | Matches how trades actually work between the 3 of you |
| Trade modes | Open (anyone) + Directed (specific person) | Covers both "can anyone swap?" and "hey Franco, swap with me?" |
| Notifications | In-app UI + WhatsApp deep links | Deep links are free and instant; automated messages = Phase 2 |

---

## Data Model (Firebase Realtime DB)

### Node: `/trades/{tradeId}`

```json
{
  "id": "string (auto-generated push key)",
  "requester": "Franco | Manés | Santi",
  "requesterDate": "YYYY-MM-DD (the day the requester wants covered)",
  "type": "open | directed",
  "targetPerson": "null | Franco | Manés | Santi",
  "offerDate": "null | YYYY-MM-DD",
  "status": "pending | accepted | declined | cancelled | expired",
  "acceptedBy": "null | Franco | Manés | Santi",
  "acceptorDate": "null | YYYY-MM-DD",
  "createdAt": "number (timestamp ms)",
  "resolvedAt": "null | number (timestamp ms)"
}
```

#### Field Details

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Firebase push key, auto-generated |
| `requester` | string | Who created the trade request |
| `requesterDate` | string | The requester's assigned day they want someone else to cover |
| `type` | string | `"open"` = anyone can accept; `"directed"` = specific person only |
| `targetPerson` | string/null | For directed trades: who the request is aimed at. Null for open trades |
| `offerDate` | string/null | For directed trades: which of the target's days the requester will cover. Null for open trades (acceptor picks) |
| `status` | string | Lifecycle state of the trade |
| `acceptedBy` | string/null | Who accepted the trade (relevant for open trades where anyone could) |
| `acceptorDate` | string/null | For open trades: which of the acceptor's days the requester will cover (chosen by acceptor at accept time) |
| `createdAt` | number | Unix timestamp (ms) when created |
| `resolvedAt` | number/null | Unix timestamp (ms) when accepted/declined/cancelled |

#### Trade Lifecycle

```
                    ┌─────────┐
                    │ PENDING │
                    └────┬────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
              ▼          ▼          ▼
         ┌─────────┐ ┌─────────┐ ┌──────────┐
         │ACCEPTED │ │DECLINED │ │CANCELLED │
         └─────────┘ └─────────┘ └──────────┘
                                       ▲
         Date passes without      Requester
         acceptance:              cancels own
         ┌─────────┐             request
         │ EXPIRED │
         └─────────┘
```

- **pending** → Created, waiting for response
- **accepted** → Someone accepted; calendar overrides written
- **declined** → Target person said no (directed trades only)
- **cancelled** → Requester withdrew their own request
- **expired** → The `requesterDate` passed without anyone accepting

#### Example: Directed Trade

Franco wants Santi to cover March 15 (Franco's day). Franco offers to cover March 17 (Santi's day) in return.

```json
{
  "id": "-NxABC123",
  "requester": "Franco",
  "requesterDate": "2026-03-15",
  "type": "directed",
  "targetPerson": "Santi",
  "offerDate": "2026-03-17",
  "status": "pending",
  "acceptedBy": null,
  "acceptorDate": null,
  "createdAt": 1741000000000,
  "resolvedAt": null
}
```

When Santi accepts → `status: "accepted"`, `acceptedBy: "Santi"`, `resolvedAt: <now>`, and overrides are written.

#### Example: Open Trade

Franco needs someone to cover March 15 but doesn't care who.

```json
{
  "id": "-NxDEF456",
  "requester": "Franco",
  "requesterDate": "2026-03-15",
  "type": "open",
  "targetPerson": null,
  "offerDate": null,
  "status": "pending",
  "acceptedBy": null,
  "acceptorDate": null,
  "createdAt": 1741000000000,
  "resolvedAt": null
}
```

Manés decides to accept and picks March 16 (his day) as the swap. → `acceptedBy: "Manés"`, `acceptorDate: "2026-03-16"`, `status: "accepted"`, and overrides are written for both dates.

### Node: `/overrides/{YYYY-MM-DD}`

```json
{
  "2026-03-15": {
    "assignedTo": "Santi",
    "originallyAssignedTo": "Franco",
    "tradeId": "-NxABC123"
  },
  "2026-03-17": {
    "assignedTo": "Franco",
    "originallyAssignedTo": "Santi",
    "tradeId": "-NxABC123"
  }
}
```

Each override stores:
- `assignedTo`: Who is now responsible for this day
- `originallyAssignedTo`: Who the algorithm would have assigned (for display purposes)
- `tradeId`: Reference back to the trade (for audit trail)

The calendar lookup becomes: **check `/overrides/{date}` first → if exists, use `assignedTo` → else use algorithm**.

---

## Validation Rules

### Creating a trade
1. `requesterDate` must be assigned to `requester` (by algorithm or existing override) — you can only trade away your own day
2. `requesterDate` must be today or in the future
3. No existing pending trade for the same `requesterDate` by the same requester
4. For directed trades:
   - `targetPerson` must be one of the other two people
   - `offerDate` must be assigned to `targetPerson`
   - `offerDate` must be today or in the future
   - `offerDate` must not already have a pending trade

### Accepting a trade
1. Acceptor cannot be the requester (can't accept your own trade)
2. For directed trades: only `targetPerson` can accept
3. For open trades: acceptor must pick one of their upcoming assigned days as `acceptorDate`
4. The selected `acceptorDate` must not already have a pending/accepted trade
5. `requesterDate` must still be in the future (not expired)

### Declining / Cancelling
1. Only `targetPerson` can decline a directed trade
2. Only `requester` can cancel a trade
3. Can only decline/cancel trades with status `pending`

---

## Implementation Steps

### Step 1: Firebase Setup

**Files modified:** `dog-calendar.html`

1. Add Firebase SDK v9 (compat mode) via CDN at the top of `<head>`:
   ```html
   <script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js"></script>
   <script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-database-compat.js"></script>
   ```

2. Add Firebase config placeholder (clearly marked for user to fill in):
   ```javascript
   const FIREBASE_CONFIG = {
     apiKey: "YOUR_API_KEY",
     authDomain: "YOUR_PROJECT.firebaseapp.com",
     databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
     projectId: "YOUR_PROJECT",
     storageBucket: "YOUR_PROJECT.appspot.com",
     messagingSenderId: "YOUR_SENDER_ID",
     appId: "YOUR_APP_ID"
   };
   ```

3. Initialize Firebase:
   ```javascript
   const firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
   const db = firebase.database();
   ```

4. Recommended Firebase Realtime DB rules (paste in Firebase Console):
   ```json
   {
     "rules": {
       ".read": true,
       ".write": true
     }
   }
   ```
   (Open access is fine for 3 trusted users. Can add basic validation rules later.)

**Acceptance criteria:**
- Firebase initializes without errors (visible in console)
- `db.ref('test').set({hello: 'world'})` writes and reads successfully

---

### Step 2: Identity Selector

**Files modified:** `dog-calendar.html`

**New React component: `IdentitySelector`**

1. On first visit (no `localStorage.dogCalendarUser`), show a full-screen overlay:
   - "Who are you?" heading
   - Three large buttons: Franco (blue), Manés (green), Santi (orange)
   - Matches existing color scheme from `PEOPLE` array

2. On selection:
   - Store in `localStorage.setItem('dogCalendarUser', name)`
   - Dismiss overlay, render main app

3. In the header, show current user as a small colored badge:
   - Example: `[🔵 Franco ▾]` in top-right
   - Tapping opens a dropdown to switch user

4. New state: `const [currentUser, setCurrentUser] = useState(localStorage.getItem('dogCalendarUser'))`

**Acceptance criteria:**
- First visit shows identity selector
- Selection persists across page reloads
- Can switch user via header dropdown
- No identity = app is blocked (can't interact with trades)

---

### Step 3: Override System

**Files modified:** `dog-calendar.html`

1. New state to hold overrides:
   ```javascript
   const [overrides, setOverrides] = useState({});
   ```

2. On mount, subscribe to Firebase overrides:
   ```javascript
   useEffect(() => {
     const ref = db.ref('overrides');
     ref.on('value', (snapshot) => {
       setOverrides(snapshot.val() || {});
     });
     return () => ref.off();
   }, []);
   ```

3. Modify the person-lookup logic:
   ```javascript
   function getEffectivePersonForDate(year, month, day) {
     const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
     if (overrides[dateStr]) {
       return PEOPLE.find(p => p.name === overrides[dateStr].assignedTo);
     }
     return getPersonForDate(year, month, day);  // existing algorithm
   }
   ```

4. Update all calendar rendering to use `getEffectivePersonForDate` instead of `getPersonForDate`

**Acceptance criteria:**
- Manually adding an override in Firebase Console changes the calendar in real time
- Removing the override reverts to algorithmic assignment
- All views (month, year, upcoming, hero) reflect overrides

---

### Step 4: Trade Request UI

**Files modified:** `dog-calendar.html`

**New components:**

#### 4a. `TradesList` — Pending trades section

- Appears below the calendar grid
- Header: "Intercambios pendientes" (Pending Trades) with count badge
- Each pending trade shows as a card:
  - Requester name + emoji
  - "Necesita que cubran el [date]" (Needs coverage for [date])
  - For open: "Abierto — cualquiera puede aceptar" with unlock icon
  - For directed: "Para [name]" with arrow icon
  - If directed + has `offerDate`: "Ofrece cubrir el [offerDate]"
  - Action buttons (context-dependent, see Step 5)
- Empty state: "No hay intercambios pendientes" with subtle illustration

#### 4b. `TradeRequestForm` — Create trade modal/bottom sheet

- Triggered by "Solicitar intercambio" (Request Trade) button
- Form fields:
  1. **Your day to trade away**: Dropdown of requester's upcoming assigned days (next 30 days). Shows date + day of week. Only shows days without existing pending trades.
  2. **Trade type toggle**: "Abierto" (Open) / "Dirigido" (Directed)
  3. If directed:
     - **Target person**: Dropdown of other two people
     - **Day you'll cover**: Dropdown of target's upcoming assigned days (next 30 days)
  4. **Submit button**: "Solicitar intercambio"
  5. **Cancel button**

- After submit: shows success message + "Share on WhatsApp" button (Step 7)

#### 4c. `TradeHistory` — Completed trades (collapsed)

- Below pending trades
- "Intercambios recientes" header, collapsed by default
- Shows last 10 accepted trades:
  - "[Name] ↔ [Name]: [date] por [date]"
  - Date of trade

**Styling:**
- Match existing app design language (rounded cards, gradients, person colors)
- Mobile-first responsive
- Smooth animations for trade card appearance/removal

**Acceptance criteria:**
- Trade list shows pending trades from Firebase in real time
- Form validates inputs before allowing submit
- Form only shows valid options (your days, future dates, no conflicts)
- History section shows accepted trades

---

### Step 5: Trade Logic (Business Rules)

**Files modified:** `dog-calendar.html`

**New functions:**

#### `createTrade(tradeData)`
```javascript
async function createTrade({ requester, requesterDate, type, targetPerson, offerDate }) {
  // Validate requesterDate belongs to requester
  // Validate no existing pending trade for requesterDate
  // Validate dates are in the future
  // If directed: validate offerDate belongs to targetPerson
  const newRef = db.ref('trades').push();
  await newRef.set({
    id: newRef.key,
    requester, requesterDate, type, targetPerson,
    offerDate: offerDate || null,
    status: 'pending',
    acceptedBy: null,
    acceptorDate: null,
    createdAt: Date.now(),
    resolvedAt: null
  });
  return newRef.key;
}
```

#### `acceptTrade(tradeId, acceptor, acceptorDate)`
```javascript
async function acceptTrade(tradeId, acceptor, acceptorDate) {
  const tradeRef = db.ref(`trades/${tradeId}`);
  const snapshot = await tradeRef.get();
  const trade = snapshot.val();

  // Validate trade is still pending
  // Validate acceptor is eligible
  // Validate acceptorDate belongs to acceptor (for open trades)

  const swapDate1 = trade.requesterDate;
  const swapDate2 = trade.type === 'directed' ? trade.offerDate : acceptorDate;

  // Atomic multi-path update
  const updates = {};
  updates[`trades/${tradeId}/status`] = 'accepted';
  updates[`trades/${tradeId}/acceptedBy`] = acceptor;
  updates[`trades/${tradeId}/acceptorDate`] = acceptorDate || trade.offerDate;
  updates[`trades/${tradeId}/resolvedAt`] = Date.now();
  updates[`overrides/${swapDate1}`] = {
    assignedTo: acceptor,
    originallyAssignedTo: trade.requester,
    tradeId: tradeId
  };
  updates[`overrides/${swapDate2}`] = {
    assignedTo: trade.requester,
    originallyAssignedTo: acceptor,
    tradeId: tradeId
  };

  await db.ref().update(updates);
}
```

#### `declineTrade(tradeId)`
```javascript
async function declineTrade(tradeId) {
  await db.ref(`trades/${tradeId}`).update({
    status: 'declined',
    resolvedAt: Date.now()
  });
}
```

#### `cancelTrade(tradeId)`
```javascript
async function cancelTrade(tradeId) {
  await db.ref(`trades/${tradeId}`).update({
    status: 'cancelled',
    resolvedAt: Date.now()
  });
}
```

**Action buttons per trade card (based on current user + trade state):**

| Scenario | Buttons shown |
|----------|---------------|
| I'm the requester | [Cancel] [Share WhatsApp] |
| Directed at me | [Accept] [Decline] |
| Open trade, I'm not requester | [Accept] (opens day picker) |
| Not my business (directed at someone else) | No buttons, just view |

**Acceptance criteria:**
- Creating a trade writes correct data to Firebase
- Accepting a trade writes both overrides atomically
- Calendar updates immediately after acceptance
- Declining/cancelling updates status without writing overrides
- Validation prevents invalid trades (wrong person, past dates, conflicts)

---

### Step 6: Calendar Integration

**Files modified:** `dog-calendar.html`

1. **Swap indicator on calendar days:**
   - Days with an override show a small swap icon (🔄) or a colored dot in the corner
   - The day cell still shows the *current* assignee (post-swap), but the indicator signals it was traded

2. **Day detail popup enhancement:**
   - If the day has an override, show:
     - "Intercambiado: Originalmente día de [original], cubierto por [new]"
     - Link to the trade that caused it

3. **Stats bar update:**
   - Stats should count using `getEffectivePersonForDate` (including overrides)
   - This way the stats reflect reality, not just the algorithm

4. **Upcoming days (horizontal scroll):**
   - Already uses person lookup; just needs to use the override-aware version
   - Swapped days could show a subtle indicator

5. **Hero header (today/tomorrow):**
   - Uses override-aware lookup
   - If today was swapped, maybe show "(intercambiado)" subtitle

**Acceptance criteria:**
- Swapped days are visually distinguishable
- All calendar views consistently reflect overrides
- Stats are accurate post-swaps
- Day detail popup shows swap information

---

### Step 7: WhatsApp Deep Links

**Files modified:** `dog-calendar.html`

1. **"Share on WhatsApp" button** appears:
   - After creating a trade (in success confirmation)
   - On each pending trade card (for the requester)

2. **Message generation:**

   Open trade:
   ```
   🐕 ¡Pedido de intercambio!
   {requester} necesita que alguien cubra el {requesterDate formatted}.
   ¿Alguien puede intercambiar? Revisá el calendario para aceptar.
   {link to calendar}
   ```

   Directed trade:
   ```
   🐕 ¡Pedido de intercambio!
   {requester} quiere intercambiar con {targetPerson}:
   → Vos cubrís el {requesterDate formatted}
   → {requester} cubre tu {offerDate formatted}
   Revisá el calendario para aceptar o rechazar.
   {link to calendar}
   ```

3. **Link format:**
   ```javascript
   const message = encodeURIComponent(generateTradeMessage(trade));
   const whatsappUrl = `https://wa.me/?text=${message}`;
   window.open(whatsappUrl, '_blank');
   ```
   (Using `wa.me` without a phone number opens WhatsApp's "choose recipient/group" screen)

4. **Button styling:** Green WhatsApp-branded button with WhatsApp icon

**Acceptance criteria:**
- Button opens WhatsApp with pre-filled Spanish message
- Message includes all relevant trade details
- Works on both mobile (opens WhatsApp app) and desktop (opens WhatsApp Web)

---

### Step 8: Polish & Edge Cases

**Files modified:** `dog-calendar.html`

1. **Expired trades cleanup:**
   - On app load, check all pending trades
   - If `requesterDate` < today → update status to `expired`
   - Run this check periodically (every hour or on visibility change)

2. **Conflict prevention:**
   - Before showing a day as available in the trade form, check all pending trades
   - If a day already has a pending trade involving it, grey it out / exclude it
   - Show tooltip: "Este día ya tiene un intercambio pendiente"

3. **Loading states:**
   - While Firebase is connecting: show skeleton/spinner for trades section
   - Disable trade actions until connected
   - Show "Conectando..." indicator

4. **Offline handling:**
   - Firebase SDK handles offline caching automatically
   - Show "Sin conexión" banner when offline
   - Disable create/accept/decline buttons when offline

5. **Undo accepted trade:**
   - Optional: Allow undoing an accepted trade (removes overrides, sets status back to pending or a new "reverted" status)
   - Only if both dates are still in the future

6. **Edge case — chained trades:**
   - If a day has been overridden and then someone tries to trade it again
   - The override system handles this naturally: the latest override wins
   - Validate against current effective assignment, not original algorithm

7. **Animations:**
   - Fade in/out for trade cards
   - Slide up for trade form modal
   - Smooth transition when calendar day assignments change

**Acceptance criteria:**
- Expired trades don't clutter the pending list
- Can't create conflicting trades
- App is usable offline (read-only)
- Graceful loading states

---

## Firebase Setup Guide

### Prerequisites
- A Google account (any Gmail works)
- 5 minutes

### Steps

1. **Create Firebase project**
   - Go to [Firebase Console](https://console.firebase.google.com/)
   - Click "Create a project"
   - Name: `dog-calendar` (or anything you like)
   - Disable Google Analytics (not needed) → "Create Project"
   - Wait ~30 seconds for creation

2. **Enable Realtime Database**
   - In the left sidebar: "Build" → "Realtime Database"
   - Click "Create Database"
   - Location: `United States (us-central1)` (or closest to Buenos Aires: `southamerica-east1` if available)
   - Security rules: Start in **test mode** (allows all reads/writes for 30 days)
   - Click "Enable"

3. **Register web app**
   - Click the gear icon (top-left) → "Project settings"
   - Scroll down to "Your apps" section
   - Click the web icon (`</>`)
   - App nickname: `dog-calendar`
   - Don't enable Firebase Hosting (not needed)
   - Click "Register app"
   - Copy the `firebaseConfig` object that appears

4. **Paste config into the calendar**
   - Open `dog-calendar.html`
   - Find the `FIREBASE_CONFIG` placeholder (near the top)
   - Replace the placeholder values with your real config
   - Save the file

5. **Test it**
   - Open the calendar in your browser
   - Open browser DevTools (F12) → Console
   - You should see no Firebase errors
   - Try creating a trade — it should appear in Firebase Console under "Realtime Database"

### Security Rules (Optional, for after test mode expires)

After 30 days, test mode expires. Paste these rules to keep it working:

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

This is open access — fine for your use case (3 trusted users, no sensitive data).

---

## File Changes Summary

| File | Changes |
|------|---------|
| `dog-calendar.html` | Firebase SDK, identity selector, override system, trade UI, trade logic, WhatsApp links, polish |

Everything lives in the single `dog-calendar.html` file, keeping the project's existing architecture (single-file apps, CDN dependencies, no build step).

---

## Estimated Component Sizes

| Component | Approximate Lines |
|-----------|-------------------|
| Firebase setup + config | ~20 |
| Identity selector | ~80 |
| Override system + modified lookup | ~40 |
| Trade data subscription (useEffect) | ~30 |
| Trade list UI | ~120 |
| Trade request form | ~150 |
| Trade history | ~60 |
| Trade logic functions (create/accept/decline/cancel) | ~100 |
| WhatsApp deep link generation | ~40 |
| Validation helpers | ~50 |
| Polish (loading, offline, expiry) | ~60 |
| **Total new code** | **~750 lines** |

Current `dog-calendar.html` is ~850 lines, so the file will roughly double in size.
