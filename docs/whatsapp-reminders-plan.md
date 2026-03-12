# Phase 2: WhatsApp Integration & Daily Reminders — Detailed Implementation Plan

## Overview

Add automated WhatsApp messaging to the dog walking calendar:
1. **Daily reminder at 9 PM Buenos Aires time** — Notify whoever is on duty that night
2. **Automated trade notifications** — When a trade is created/accepted, send a WhatsApp message to the group automatically (no manual tap needed)

This is Phase 2, to be built **after** the trade system (Phase 1) is working.

---

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| WhatsApp API | Twilio WhatsApp API | Easiest to set up, reliable, cheap (~$0.005/msg) |
| Scheduler | Firebase Cloud Functions + Cloud Scheduler | Already using Firebase; natural fit for cron jobs |
| Timezone | America/Argentina/Buenos_Aires (UTC-3) | The 3 users are in Buenos Aires |
| Message language | Spanish | Matches existing app language |

---

## How Twilio WhatsApp Works

### The Basics

1. You create a **Twilio account** and get a **Twilio WhatsApp-enabled phone number**
2. Your code calls Twilio's API: "send this message to this WhatsApp group/number"
3. Twilio delivers it via WhatsApp
4. Recipients see a normal WhatsApp message from the Twilio number

### Limitations & Considerations

- **Group messaging**: Twilio can't send directly to WhatsApp groups. Two workarounds:
  - **Option A**: Send individual messages to each person (or just the person on duty)
  - **Option B**: Use a WhatsApp group where the Twilio number is a participant (requires WhatsApp Business API for group messaging — more complex)
  - **Recommended**: Option A — send a message to the person on duty. Optionally also notify the group by sending to all 3 individually.

- **Message templates**: For automated (non-reply) messages, WhatsApp requires pre-approved **message templates**. Twilio handles this, but you need to submit templates for approval (usually approved within minutes for simple notifications).

- **Cost**: ~$0.005 per message + ~$1/month for the phone number. At 1-3 messages/day = ~$2-3/month total.

- **Twilio Sandbox (for testing)**: Twilio offers a free WhatsApp sandbox for development. No phone number purchase needed. Each recipient must opt in by sending a code to the sandbox number. Good for testing before going live.

---

## Data Model Additions

### Firebase: `/config/whatsapp`

```json
{
  "enabled": true,
  "reminderHour": 21,
  "reminderMinute": 0,
  "timezone": "America/Argentina/Buenos_Aires",
  "phoneNumbers": {
    "Franco": "+5411XXXXXXXX",
    "Manés": "+5411XXXXXXXX",
    "Santi": "+5411XXXXXXXX"
  },
  "notifyOnTradeCreate": true,
  "notifyOnTradeAccept": true
}
```

### Firebase: `/config/twilio` (stored as environment variables in Cloud Functions, NOT in client code)

```
TWILIO_ACCOUNT_SID=ACXXXXXXXXX
TWILIO_AUTH_TOKEN=XXXXXXXXX
TWILIO_WHATSAPP_NUMBER=+14155238886
```

**Important**: Twilio credentials are NEVER exposed to the client. They live only in Firebase Cloud Functions environment config.

---

## Message Templates

### Daily Reminder (9 PM)

```
🐕 ¡Recordatorio!

Hoy es tu día de pasear a Mía, {name}.
¡No te olvides! 🌙

📅 {date formatted} ({day of week})
```

If the day was swapped:
```
🐕 ¡Recordatorio!

Hoy es tu día de pasear a Mía, {name}.
(Intercambiado con {originalPerson})
¡No te olvides! 🌙

📅 {date formatted} ({day of week})
```

### Trade Created — Open

```
🔄 ¡Nuevo pedido de intercambio!

{requester} necesita que alguien cubra el {date}.
¿Podés intercambiar? Revisá el calendario.
```

### Trade Created — Directed

```
🔄 ¡Pedido de intercambio!

{requester} quiere intercambiar con {targetPerson}:
→ {targetPerson} cubre el {requesterDate}
→ {requester} cubre el {offerDate}

Revisá el calendario para aceptar o rechazar.
```

### Trade Accepted

```
✅ ¡Intercambio confirmado!

{requester} ↔ {acceptor}
📅 {date1} ahora lo cubre {person1}
📅 {date2} ahora lo cubre {person2}

El calendario ya está actualizado.
```

---

## Implementation Steps

### Step 1: Twilio Account Setup

**Manual steps (guide for user):**

1. **Create Twilio account**
   - Go to [twilio.com](https://www.twilio.com/)
   - Sign up for a free trial (gives you ~$15 credit)
   - Verify your phone number

2. **Enable WhatsApp Sandbox (for testing)**
   - Go to Twilio Console → Messaging → Try it Out → Send a WhatsApp Message
   - Twilio gives you a sandbox number (e.g., `+1 415 523 8886`)
   - Each person sends a join code to this number from their WhatsApp (e.g., "join <word>-<word>")
   - This lets Twilio send messages to those numbers for 72 hours at a time

3. **Get a real WhatsApp number (for production)**
   - Buy a Twilio phone number (~$1/month)
   - Go to Messaging → Senders → WhatsApp Senders → Add a sender
   - Submit your phone number for WhatsApp approval
   - Submit message templates for approval
   - Approval usually takes minutes to hours

4. **Note your credentials**
   - Account SID (from Twilio Console dashboard)
   - Auth Token (from Twilio Console dashboard)
   - WhatsApp-enabled phone number

---

### Step 2: Firebase Cloud Functions Setup

**New files:**

```
/functions/
├── package.json
├── index.js
└── .env          (Twilio credentials, not committed to git)
```

1. **Initialize Firebase Functions:**
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase init functions
   # Choose JavaScript, install dependencies
   ```

2. **Install Twilio SDK:**
   ```bash
   cd functions
   npm install twilio
   ```

3. **Set Twilio credentials as environment config:**
   ```bash
   firebase functions:config:set \
     twilio.account_sid="ACXXXXXXXXX" \
     twilio.auth_token="XXXXXXXXX" \
     twilio.whatsapp_number="+14155238886"
   ```

---

### Step 3: Daily Reminder Cloud Function

**File:** `/functions/index.js`

```javascript
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const twilio = require('twilio');

admin.initializeApp();

// Twilio client
const twilioClient = twilio(
  functions.config().twilio.account_sid,
  functions.config().twilio.auth_token
);
const TWILIO_WHATSAPP = `whatsapp:${functions.config().twilio.whatsapp_number}`;

// Dog walking rotation logic (must match client-side)
const PEOPLE = ['Franco', 'Manés', 'Santi'];
const REF_DATE = new Date(2026, 1, 28); // Feb 28, 2026
const REF_INDEX = 2;

function getPersonForDate(date) {
  const diff = Math.floor((date - REF_DATE) / 86400000);
  const idx = (((diff % 3) + REF_INDEX) % 3 + 3) % 3;
  return PEOPLE[idx];
}

// Scheduled: Every day at 9 PM Buenos Aires time (UTC-3 = midnight UTC)
// Cron: 0 0 * * * (midnight UTC = 9 PM ART)
exports.dailyReminder = functions.pubsub
  .schedule('0 0 * * *')
  .timeZone('America/Argentina/Buenos_Aires')
  .onRun(async (context) => {
    // Get today's date in Buenos Aires
    const now = new Date();
    const buenosAires = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
    const dateStr = formatDate(buenosAires);

    // Check for override
    const overrideSnap = await admin.database().ref(`overrides/${dateStr}`).get();
    let assignedPerson;
    let wasSwapped = false;
    let originalPerson = null;

    if (overrideSnap.exists()) {
      const override = overrideSnap.val();
      assignedPerson = override.assignedTo;
      originalPerson = override.originallyAssignedTo;
      wasSwapped = true;
    } else {
      assignedPerson = getPersonForDate(buenosAires);
    }

    // Get phone number
    const configSnap = await admin.database().ref('config/whatsapp').get();
    const config = configSnap.val();

    if (!config?.enabled) return null;

    const phoneNumber = config.phoneNumbers[assignedPerson];
    if (!phoneNumber) return null;

    // Build message
    let message = `🐕 ¡Recordatorio!\n\nHoy es tu día de pasear a Mía, ${assignedPerson}.`;
    if (wasSwapped) {
      message += `\n(Intercambiado con ${originalPerson})`;
    }
    message += `\n¡No te olvides! 🌙\n\n📅 ${formatDateSpanish(buenosAires)}`;

    // Send via Twilio
    await twilioClient.messages.create({
      body: message,
      from: TWILIO_WHATSAPP,
      to: `whatsapp:${phoneNumber}`
    });

    console.log(`Reminder sent to ${assignedPerson} at ${phoneNumber}`);
    return null;
  });
```

**Key details:**
- Uses Cloud Scheduler with `timeZone` parameter for correct Buenos Aires time
- Checks Firebase overrides (from trades) before determining who's on duty
- Duplicates the rotation algorithm server-side (must stay in sync with client)

---

### Step 4: Trade Notification Cloud Functions

**File:** `/functions/index.js` (continued)

```javascript
// Triggered when a new trade is created
exports.onTradeCreated = functions.database
  .ref('trades/{tradeId}')
  .onCreate(async (snapshot, context) => {
    const trade = snapshot.val();
    const config = (await admin.database().ref('config/whatsapp').get()).val();

    if (!config?.enabled || !config?.notifyOnTradeCreate) return null;

    let message;
    if (trade.type === 'open') {
      message = `🔄 ¡Nuevo pedido de intercambio!\n\n${trade.requester} necesita que alguien cubra el ${formatDateSpanish(trade.requesterDate)}.\n¿Podés intercambiar? Revisá el calendario.`;
    } else {
      message = `🔄 ¡Pedido de intercambio!\n\n${trade.requester} quiere intercambiar con ${trade.targetPerson}:\n→ ${trade.targetPerson} cubre el ${formatDateSpanish(trade.requesterDate)}\n→ ${trade.requester} cubre el ${formatDateSpanish(trade.offerDate)}\n\nRevisá el calendario para aceptar o rechazar.`;
    }

    // Send to relevant people (not the requester)
    const recipients = trade.type === 'directed'
      ? [trade.targetPerson]  // Only notify the target
      : PEOPLE.filter(p => p !== trade.requester);  // Notify everyone except requester

    const promises = recipients.map(person => {
      const phone = config.phoneNumbers[person];
      if (!phone) return null;
      return twilioClient.messages.create({
        body: message,
        from: TWILIO_WHATSAPP,
        to: `whatsapp:${phone}`
      });
    });

    await Promise.all(promises.filter(Boolean));
    return null;
  });

// Triggered when a trade status changes to accepted
exports.onTradeAccepted = functions.database
  .ref('trades/{tradeId}/status')
  .onUpdate(async (change, context) => {
    if (change.after.val() !== 'accepted') return null;

    const tradeSnap = await admin.database().ref(`trades/${context.params.tradeId}`).get();
    const trade = tradeSnap.val();
    const config = (await admin.database().ref('config/whatsapp').get()).val();

    if (!config?.enabled || !config?.notifyOnTradeAccept) return null;

    const acceptorDate = trade.acceptorDate || trade.offerDate;
    const message = `✅ ¡Intercambio confirmado!\n\n${trade.requester} ↔ ${trade.acceptedBy}\n📅 ${formatDateSpanish(trade.requesterDate)} → lo cubre ${trade.acceptedBy}\n📅 ${formatDateSpanish(acceptorDate)} → lo cubre ${trade.requester}\n\nEl calendario ya está actualizado.`;

    // Notify all 3 people
    const promises = PEOPLE.map(person => {
      const phone = config.phoneNumbers[person];
      if (!phone) return null;
      return twilioClient.messages.create({
        body: message,
        from: TWILIO_WHATSAPP,
        to: `whatsapp:${phone}`
      });
    });

    await Promise.all(promises.filter(Boolean));
    return null;
  });
```

---

### Step 5: Configuration UI (in calendar app)

**File modified:** `dog-calendar.html`

Add a settings section (accessible via gear icon in header) where users can:

1. **Toggle WhatsApp notifications** on/off
2. **Set phone numbers** for each person
   - Phone number input for Franco, Manés, Santi
   - Saves to `/config/whatsapp/phoneNumbers` in Firebase
3. **Toggle trade notifications** (create/accept)
4. **Set reminder time** (default 9 PM, adjustable)

**Note:** This is a lightweight admin panel. Since all 3 users are trusted, anyone can modify settings.

---

### Step 6: Deploy Cloud Functions

```bash
cd functions
firebase deploy --only functions
```

This deploys:
- `dailyReminder` — scheduled function (runs daily at 9 PM ART)
- `onTradeCreated` — database trigger
- `onTradeAccepted` — database trigger

---

## Twilio Setup Guide (Step-by-Step)

### For Testing (Free, 5 minutes)

1. Go to [twilio.com/try-twilio](https://www.twilio.com/try-twilio) and create an account
2. Verify your phone number via SMS
3. In the Twilio Console, go to **Messaging** → **Try it out** → **Send a WhatsApp message**
4. Follow the instructions:
   - Save the Twilio sandbox number in your phone contacts
   - Send the join code (e.g., "join example-word") from each of the 3 phones
5. Now Twilio can send WhatsApp messages to those 3 numbers for testing

### For Production (~$2-3/month)

1. **Buy a phone number**: Twilio Console → Phone Numbers → Buy a Number → Any US number (~$1/month)
2. **Enable WhatsApp**: Messaging → Senders → WhatsApp Senders → Request access
3. **Submit message templates**: Required by WhatsApp for automated messages
   - Template 1: Daily reminder (notification category)
   - Template 2: Trade created (notification category)
   - Template 3: Trade accepted (notification category)
4. **Wait for approval**: Usually 1-24 hours
5. **Update config**: Replace sandbox number with your real number

### Cost Breakdown

| Item | Cost |
|------|------|
| Twilio phone number | ~$1.00/month |
| WhatsApp messages (~30-60/month) | ~$0.15-0.30/month |
| Firebase Cloud Functions (free tier) | $0.00 |
| **Total** | **~$1.15-1.30/month** |

---

## Firebase Cloud Functions Setup Guide

### Prerequisites
- Node.js 18+ installed
- Firebase project from Phase 1

### Steps

1. **Install Firebase CLI:**
   ```bash
   npm install -g firebase-tools
   ```

2. **Login:**
   ```bash
   firebase login
   ```

3. **Initialize Functions in the project:**
   ```bash
   cd snake-1v1
   firebase init functions
   # Select your existing project
   # Choose JavaScript
   # Say yes to ESLint (optional)
   # Say yes to install dependencies
   ```

4. **Install Twilio:**
   ```bash
   cd functions
   npm install twilio
   ```

5. **Set environment variables:**
   ```bash
   firebase functions:config:set \
     twilio.account_sid="YOUR_ACCOUNT_SID" \
     twilio.auth_token="YOUR_AUTH_TOKEN" \
     twilio.whatsapp_number="+1XXXXXXXXXX"
   ```

6. **Deploy:**
   ```bash
   firebase deploy --only functions
   ```

7. **Verify:**
   - Check Firebase Console → Functions tab → all 3 functions should be listed
   - Check logs for any deployment errors

---

## Testing Plan

### Daily Reminder
1. Temporarily change the cron schedule to run every minute: `* * * * *`
2. Deploy, wait for it to fire, check WhatsApp
3. Verify correct person receives the message
4. Verify swapped days show swap info
5. Change back to `0 0 * * *` and redeploy

### Trade Notifications
1. Create a trade in the calendar app
2. Verify the correct WhatsApp message is received
3. Accept the trade
4. Verify the acceptance notification is received by all 3

### Edge Cases
- What if phone number is missing for a person? → Skip silently, log warning
- What if Twilio is down? → Cloud Function retries automatically (Firebase built-in)
- What if the calendar is overridden multiple times for the same date? → Use latest override

---

## What This Phase Adds to the Project

| New Files | Purpose |
|-----------|---------|
| `functions/package.json` | Cloud Functions dependencies |
| `functions/index.js` | Cloud Functions code (reminder + trade notifications) |
| `functions/.env` | Twilio credentials (not committed) |
| `.firebaserc` | Firebase project config |
| `firebase.json` | Firebase deployment config |

| Modified Files | Changes |
|----------------|---------|
| `dog-calendar.html` | Settings panel for WhatsApp config |
| `.gitignore` | Add `functions/.env`, `functions/node_modules` |

---

## Dependencies on Phase 1

This phase requires Phase 1 (Trade System) to be complete because:
- Trade notifications depend on the `/trades` data structure
- The override system must be working for the daily reminder to check swaps
- The Firebase project must already exist
- The calendar app must already have the identity selector (to know who to notify)

---

## Future Enhancements (Not in This Phase)

- **Tomorrow preview**: Send a message at 9 PM saying "Tomorrow is [name]'s day" so people can plan ahead
- **Weekly summary**: Every Sunday, send the week's schedule
- **Snooze/acknowledge**: Let the person reply "OK" to acknowledge; send a follow-up if no reply by 10 PM
- **Group message**: If WhatsApp Business API is set up, send to the group directly instead of individual messages
- **Custom reminder time per person**: Different people might want reminders at different times
