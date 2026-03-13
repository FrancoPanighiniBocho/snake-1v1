// Daily Dog Walking Reminder — runs via GitHub Actions at 21:00 Buenos Aires
// Reads Firebase overrides, calculates who's on duty, sends CallMeBot WhatsApp message

const PEOPLE = [
  { name: "Franco", phone: "5491169212260" },
  { name: "Manés", phone: "5491158120807" },
  { name: "Santi", phone: "5491136010141" },
];

const CALLMEBOT_KEYS = {
  "Franco": process.env.CALLMEBOT_KEY_FRANCO,
  "Manés": process.env.CALLMEBOT_KEY_MANES,
  "Santi": process.env.CALLMEBOT_KEY_SANTI,
};

const FIREBASE_DB_URL = "https://dog-calendar-96cd5-default-rtdb.firebaseio.com";

// Same rotation algorithm as dog-calendar.html
const REF_DATE = new Date(2026, 1, 28); // Feb 28, 2026
const REF_INDEX = 2;

function getPersonForDate(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.floor((d - REF_DATE) / 86400000);
  const idx = (((diff % 3) + REF_INDEX) % 3 + 3) % 3;
  return PEOPLE[idx];
}

function fmtDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function sendCallMeBot(personName, message) {
  const person = PEOPLE.find(p => p.name === personName);
  const apikey = CALLMEBOT_KEYS[personName];
  if (!person || !apikey) {
    console.log(`Skipping ${personName}: missing phone or API key`);
    return;
  }
  const url = `https://api.callmebot.com/whatsapp.php?phone=${person.phone}&text=${encodeURIComponent(message)}&apikey=${apikey}`;
  console.log(`Sending to ${personName}...`);
  const res = await fetch(url);
  console.log(`Response: ${res.status} ${res.statusText}`);
}

async function main() {
  // Calculate today in Buenos Aires (UTC-3)
  const now = new Date();
  const buenosAires = new Date(now.toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
  const today = new Date(buenosAires.getFullYear(), buenosAires.getMonth(), buenosAires.getDate());
  const todayStr = fmtDate(today);

  console.log(`Date (Buenos Aires): ${todayStr}`);

  // Get default person from rotation
  const defaultPerson = getPersonForDate(today);
  console.log(`Default rotation: ${defaultPerson.name}`);

  // Check Firebase overrides
  let assignedPerson = defaultPerson.name;
  let wasSwapped = false;
  let originalPerson = null;

  try {
    const res = await fetch(`${FIREBASE_DB_URL}/overrides/${todayStr}.json`);
    const override = await res.json();
    if (override && override.assignedTo) {
      assignedPerson = override.assignedTo;
      originalPerson = override.originallyAssignedTo || defaultPerson.name;
      wasSwapped = assignedPerson !== defaultPerson.name;
      console.log(`Override found: ${assignedPerson} (originally ${originalPerson})`);
    }
  } catch (e) {
    console.log(`No overrides or error: ${e.message}`);
  }

  // Build message
  let message;
  if (wasSwapped) {
    message = `🐕 Hoy te toca pasear a Sei, ${assignedPerson}! (intercambiado con ${originalPerson}) https://francopanighinibocho.github.io/snake-1v1/dog-calendar.html`;
  } else {
    message = `🐕 Hoy te toca pasear a Sei, ${assignedPerson}! https://francopanighinibocho.github.io/snake-1v1/dog-calendar.html`;
  }

  console.log(`Message: ${message}`);

  // Send WhatsApp
  await sendCallMeBot(assignedPerson, message);
  console.log("Done!");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
