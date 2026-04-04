let validZipConfirmed = false;
let pendingUrl = null;

const SERVICE_ZIPS = [
  '53701','53702','53703','53704','53705','53706','53707','53708',
  '53711','53713','53714','53715','53716','53717','53718','53719',
  '53725','53726','53744','53774','53777','53778','53779','53782',
  '53783','53784','53785','53786','53788','53789','53790','53791',
  '53792','53793','53794',
  '53597','53562','53593','53528','53558','53527','53532','53575',
  '53598','53571','53508','53523','53590','53589'
];

// ── NAV SCROLL BEHAVIOR ──
const nav = document.getElementById('nav');
let lastScroll = 0;

window.addEventListener('scroll', () => {
  const current = window.scrollY;
  nav.classList.toggle('scrolled', current > 60);
  nav.style.transform = current > lastScroll && current > 80 ? 'translateY(-100%)' : 'translateY(0)';
  lastScroll = current;
});

// ── ZIP CHECKER ──
function focusZip() {
  setTimeout(() => {
    const input = document.getElementById('zipInput');
    if (input) { input.focus(); input.classList.add('pulse'); setTimeout(() => input.classList.remove('pulse'), 1000); }
  }, 400);
}

function checkZip() {
  const zip = document.getElementById('zipInput').value.trim();
  const result = document.getElementById('zipResult');
  const waitlist = document.getElementById('zipWaitlist');
  const buttons = document.getElementById('zipButtons');
  if (zip.length !== 5 || isNaN(zip)) {
    result.textContent = 'Please enter a valid 5-digit zip code.';
    result.className = 'zip-result error'; result.style.display = 'block';
    waitlist.style.display = 'none'; buttons.style.display = 'none'; return;
  }
  if (SERVICE_ZIPS.includes(zip)) {
    validZipConfirmed = true;
    result.innerHTML = '✓ Spots available this week';
    result.className = 'zip-result success'; result.style.display = 'block';
    waitlist.style.display = 'none'; buttons.style.display = 'flex';
  } else {
    validZipConfirmed = false;
    result.textContent = "Not in your area yet";
    result.className = 'zip-result error'; result.style.display = 'block';
    waitlist.style.display = 'flex'; buttons.style.display = 'none';
  }
}

// ── ZIP MODAL ──
function requireZip(url) {
  if (validZipConfirmed) { window.open(url, '_blank'); return; }
  pendingUrl = url;
  document.getElementById('modalZipError').style.display = 'none';
  document.getElementById('modalZipInput').value = '';
  document.getElementById('zipModal').style.display = 'flex';
  setTimeout(() => document.getElementById('modalZipInput').focus(), 150);
}

function closeZipModal() {
  document.getElementById('zipModal').style.display = 'none';
  pendingUrl = null;
}

function confirmModalZip() {
  const zip = document.getElementById('modalZipInput').value.trim();
  const errEl = document.getElementById('modalZipError');
  if (zip.length !== 5 || isNaN(zip)) { errEl.textContent = 'Please enter a valid 5-digit zip code.'; errEl.style.display = 'block'; return; }
  if (SERVICE_ZIPS.includes(zip)) {
    validZipConfirmed = true;
    document.getElementById('zipModal').style.display = 'none';
    const mainZip = document.getElementById('zipInput');
    if (mainZip) mainZip.value = zip;
    const result = document.getElementById('zipResult');
    if (result) { result.innerHTML = '✓ Spots available this week'; result.className = 'zip-result success'; result.style.display = 'block'; }
    const buttons = document.getElementById('zipButtons');
    const waitlist = document.getElementById('zipWaitlist');
    if (buttons) buttons.style.display = 'flex';
    if (waitlist) waitlist.style.display = 'none';
    if (pendingUrl) { window.open(pendingUrl, '_blank'); pendingUrl = null; }
  } else {
    errEl.textContent = "Sorry, we're not in your area yet."; errEl.style.display = 'block';
    setTimeout(() => {
      document.getElementById('zipModal').style.display = 'none';
      document.getElementById('zip-check').scrollIntoView({ behavior: 'smooth' });
      const result = document.getElementById('zipResult');
      if (result) { result.textContent = "Not in your area yet"; result.className = 'zip-result error'; result.style.display = 'block'; }
      const mainZip = document.getElementById('zipInput');
      if (mainZip) mainZip.value = zip;
      const buttons = document.getElementById('zipButtons');
      const waitlist = document.getElementById('zipWaitlist');
      if (buttons) buttons.style.display = 'none';
      if (waitlist) waitlist.style.display = 'flex';
    }, 1200);
  }
}

// ── WAITLIST ──
function joinWaitlist() {
  const email = document.getElementById('waitlistEmail').value.trim();
  const zip = document.getElementById('zipInput').value.trim();
  if (!email || !email.includes('@')) { alert('Please enter a valid email.'); return; }
  fetch('https://bijjtificxcekmesgwrn.supabase.co/rest/v1/waitlist', {
    method: 'POST',
    headers: {
      'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJpamp0aWZpY3hjZWttZXNnd3JuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NjExMzAsImV4cCI6MjA5MDIzNzEzMH0.19_WTJl5cRKaGZSxOS9QLWguFgYhPAyQYDGdP2iZdkM',
      'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJpamp0aWZpY3hjZWttZXNnd3JuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NjExMzAsImV4cCI6MjA5MDIzNzEzMH0.19_WTJl5cRKaGZSxOS9QLWguFgYhPAyQYDGdP2iZdkM',
      'Content-Type': 'application/json', 'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ email, zip, created_at: new Date().toISOString() })
  }).catch(() => {});
  document.getElementById('waitlistConfirm').style.display = 'block';
  document.getElementById('waitlistEmail').style.display = 'none';
  document.querySelector('.zip-waitlist-btn').style.display = 'none';
}

// ── ROOM ACCORDION ──
function toggleRoom(btn) {
  const item = btn.closest('.room-item');
  const isOpen = item.classList.contains('open');
  document.querySelectorAll('.room-item').forEach(r => r.classList.remove('open'));
  if (!isOpen) item.classList.add('open');
}

// ── EVENT LISTENERS ──
document.addEventListener('DOMContentLoaded', () => {
  const zipInput = document.getElementById('zipInput');
  const modalZipInput = document.getElementById('modalZipInput');
  if (zipInput) zipInput.addEventListener('keypress', e => { if (e.key === 'Enter') checkZip(); });
  if (modalZipInput) modalZipInput.addEventListener('keypress', e => { if (e.key === 'Enter') confirmModalZip(); });
});

document.addEventListener('click', (e) => {
  const modal = document.getElementById('zipModal');
  if (e.target === modal) closeZipModal();
});
