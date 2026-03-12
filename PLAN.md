# Trade Request Feature — Implementation Plan

## Summary

Add a 1-for-1 day trade system to the dog walking calendar. Users can request trades (open or directed), and the other person accepts or declines. Accepted trades update the calendar. Firebase Realtime DB provides persistence. WhatsApp deep links let users share trade requests to their group chat.

---

## Architecture Decisions

| Decision | Choice |
|----------|--------|
| Storage | Firebase Realtime DB (free tier) |
| Identity | Simple name selector (stored in localStorage) |
| Trade type | Always 1-for-1 swap |
| Notifications | In-app UI + WhatsApp deep links (manual send) |
| Scope | Trades only (WhatsApp daily reminders = future phase) |

---

## Data Model (Firebase)

### `/trades/{tradeId}`

```json
{
  "id": "auto-generated",
  "requester": "Franco",
  "requesterDate": "2026-03-15",
  "offerDate": "2026-03-17",
  "targetPerson": null | "Santi",
  "status": "pending" | "accepted" | "declined" | "cancelled",
  "acceptedBy": null | "Santi",
  "createdAt": 1741000000000,
  "resolvedAt": null | 1741100000000
}
```

**Fields explained:**
- `requester`: Who's asking for the trade (the person who wants to give away `requesterDate`)
- `requesterDate`: The day the requester wants someone else to cover
- `offerDate`: The day the requester will cover in return (the day they're offering to take)
- `targetPerson`: `null` = open trade (anyone can accept), or a specific name = directed trade
- `status`: Lifecycle state
- `acceptedBy`: Who accepted (for open trades, this records who stepped up)

**Validation rules:**
- `requesterDate` must be assigned to `requester` (you can only trade away your own day)
- `offerDate` must be assigned to whoever would accept (you offer to take one of *their* days)
- For directed trades: `offerDate` must belong to `targetPerson`
- For open trades: `offerDate` is left as `null` — the acceptor picks which of their days to swap
- Both dates must be today or in the future
- No duplicate pending trades for the same `requesterDate`

**Revised model for open trades:**

```json
{
  "id": "auto-generated",
  "requester": "Franco",
  "requesterDate": "2026-03-15",
  "offerDate": null | "2026-03-17",
  "targetPerson": null | "Santi",
  "type": "open" | "directed",
  "status": "pending" | "accepted" | "declined" | "cancelled",
  "acceptedBy": null | "Santi",
  "acceptorDate": null | "2026-03-16",
  "createdAt": 1741000000000,
  "resolvedAt": null | 1741100000000
}
```

- **Directed trade**: `type=directed`, `targetPerson="Santi"`, `offerDate="2026-03-17"` (Franco offers to cover Santi's March 17, wants Santi to cover Franco's March 15)
- **Open trade**: `type=open`, `targetPerson=null`, `offerDate=null`. When someone accepts, they set `acceptorDate` (which of their days Franco will cover in return)

### `/overrides/{dateString}`

When a trade is accepted, we write date overrides:

```json
{
  "2026-03-15": "Santi",
  "2026-03-17": "Franco"
}
```

The calendar checks this map first. If a date has an override, use that person instead of the algorithmic result. This keeps the calendar logic simple.

---

## Implementation Steps

### Step 1: Firebase Setup

1. Add Firebase SDK (CDN) to `dog-calendar.html`
2. Add placeholder Firebase config (user will replace with real credentials)
3. Initialize Firebase app and Realtime Database reference
4. Add Firebase security rules (open read/write for simplicity since it's just 3 trusted users)

### Step 2: Identity Selector

1. Add a "Who are you?" selector that appears on first visit
2. Store selection in `localStorage` as `dogCalendarUser`
3. Show current user indicator in the header (small badge)
4. Allow switching user via a settings/profile tap

### Step 3: Override System

1. Modify `getPersonForDate()` to check Firebase `/overrides/{date}` first
2. On app load, fetch all overrides and cache locally
3. Listen for real-time updates via Firebase `onValue`
4. If override exists for a date → use override person; else → use algorithm

### Step 4: Trade Request UI

1. Add a "Trades" section/tab in the calendar (below the calendar or as a bottom sheet)
2. Show list of pending trades with:
   - Who's requesting
   - Which date they want covered
   - Open vs directed indicator
   - Accept / Decline buttons (shown only to eligible people)
3. Add a "Request Trade" button (FAB or in header)
4. Trade request form:
   - Auto-filled: requester (from identity selector)
   - Select: which of your upcoming days to trade away
   - Toggle: open trade vs directed
   - If directed: select target person + select which of their days you'll cover
   - Submit button

### Step 5: Trade Logic

1. **Create trade**: Write to `/trades/{newId}` with status=pending
2. **Accept trade**:
   - For directed: acceptor clicks Accept → status=accepted
   - For open: acceptor selects which of their days to swap → then Accept → status=accepted
   - On accept: write both date overrides to `/overrides/`
3. **Decline trade**: Set status=declined
4. **Cancel trade**: Requester can cancel their own pending trade
5. **Validation**: Prevent accepting a trade for a date that already has a pending/accepted trade

### Step 6: Calendar Integration

1. Calendar days that have been swapped show a small swap indicator (e.g., 🔄 icon or different border)
2. Day detail popup shows "Swapped: Originally Franco's day, covered by Santi"
3. Stats bar reflects actual assignments (including swaps)
4. Upcoming days section reflects swaps

### Step 7: WhatsApp Deep Links

1. After creating a trade request, show a "Share on WhatsApp" button
2. Generates a `wa.me` link with a pre-filled message like:
   - Open: "🐕 Trade request! Franco needs someone to cover March 15. Check the calendar to accept!"
   - Directed: "🐕 Hey Santi! Franco wants to trade: you cover March 15, Franco covers your March 17. Check the calendar!"
3. Button opens WhatsApp with the message, user taps Send

### Step 8: Polish & Edge Cases

1. Expired trades: Auto-mark as expired if the date passes without acceptance
2. Trade history: Show past trades (collapsed section)
3. Prevent conflicting trades (two pending trades for the same date)
4. Handle case where someone already has 2+ swaps in a week (optional warning)
5. Loading states while Firebase syncs
6. Offline handling: Show cached data, disable trade actions when offline

---

## UI Mockup (Conceptual)

```
┌──────────────────────────────────┐
│  🐕 Dog Calendar     [Franco ▾] │  ← identity selector
├──────────────────────────────────┤
│  Today: Santi's turn  🟠        │
│  Tomorrow: Franco     🔵        │
├──────────────────────────────────┤
│  [Calendar Grid - as today]     │
│  (swapped days show 🔄 icon)    │
├──────────────────────────────────┤
│  📋 Pending Trades              │
│  ┌────────────────────────────┐ │
│  │ Franco wants to trade      │ │
│  │ 📅 Mar 15 (Franco's day)   │ │
│  │ 🔓 Open - anyone can take  │ │
│  │ [Accept] [Share WhatsApp]  │ │
│  └────────────────────────────┘ │
│                                  │
│  [+ Request a Trade]            │
├──────────────────────────────────┤
│  ✅ Recent Trades               │
│  Mar 10: Franco ↔ Santi        │
└──────────────────────────────────┘
```

---

## Firebase Setup Guide (for user)

1. Go to https://console.firebase.google.com/
2. Click "Create a project" → name it "dog-calendar" → disable Google Analytics → Create
3. In the project, click "Build" → "Realtime Database" → "Create Database"
4. Choose region (us-central1) → Start in **test mode** (open access for 30 days, fine for 3 trusted users)
5. Go to Project Settings (gear icon) → scroll to "Your apps" → click Web icon (</>)
6. Register app name "dog-calendar" → copy the `firebaseConfig` object
7. Paste config into `dog-calendar.html` where indicated

---

## What's NOT in this phase

- Automated WhatsApp messages (requires Twilio, future phase)
- Daily 9 PM reminder (future phase)
- Push notifications
- User authentication (trusting the 3 users to be honest with name selector)
