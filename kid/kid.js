// The Apps Script URL isn't secret by itself (only the key is, since the
// script checks the key on every request), so it's fine to commit here.
// Stephanie: paste your deployed web app URL below once, no key needed
// here since it comes from each kid's own link (?k=...).
const WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbyBYuTZw1E_5oJhzPeEjHONSOWROMWcQrgSAPLm5xQ0695kie0JqROhZCpzXVA5Vg40/exec';

// The exact same quack as the main app, not a different one: same file,
// same AudioContext-resume handling. Loading this page as a module (see
// index.html's <script type="module">) is what makes this import work.
import { playQuack } from '../app/quack.js';

const params = new URLSearchParams(location.search);
const key = params.get('k') || '';

const form = document.getElementById('form');
const result = document.getElementById('result');

if (!key) {
  form.style.display = 'none';
  result.textContent = "This link looks incomplete. Ask Mom for your own Ducks link.";
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (WEBAPP_URL.indexOf('PASTE_') === 0) {
    result.textContent = 'Not set up yet, tell Mom.';
    return;
  }
  const message = document.getElementById('message').value.trim();
  const neededBy = document.getElementById('neededBy').value || null;
  if (!message) return;

  form.querySelector('button').disabled = true;
  result.textContent = 'Sending...';
  try {
    const res = await fetch(WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ key, action: 'kid_submit', message, neededBy })
    });
    const data = await res.json();
    if (data.ok) {
      form.reset();
      form.style.display = 'none';
      result.textContent = data.greeting || 'Quack! Got it.';
      playQuack();
    } else {
      result.textContent = "That didn't work: " + (data.error || 'unknown error');
      form.querySelector('button').disabled = false;
    }
  } catch (err) {
    result.textContent = 'Could not send. Check your internet and try again.';
    form.querySelector('button').disabled = false;
  }
});
