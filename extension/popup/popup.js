const LINES = [
  ['red', 'Red', '#BF0D3E'], ['orange', 'Orange', '#ED8B00'], ['silver', 'Silver', '#919D9D'],
  ['blue', 'Blue', '#009CDE'], ['yellow', 'Yellow', '#FFD100'], ['green', 'Green', '#00B140'],
];

let settings;

// Debounced: chrome.storage.sync has per-minute write quotas (slider drags).
let saveTimer = 0;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => GMO.save(settings), 120);
};

function render() {
  const master = document.getElementById('enabled');
  master.checked = settings.enabled;
  document.body.classList.toggle('off', !settings.enabled);

  for (const section of document.querySelectorAll('[data-overlay]')) {
    const cfg = settings.overlays[section.dataset.overlay];
    section.classList.toggle('off', !cfg.enabled);
    for (const input of section.querySelectorAll('input[data-key], select[data-key]')) {
      if (input.type === 'checkbox') input.checked = !!cfg[input.dataset.key];
      else input.value = String(cfg[input.dataset.key]);
    }
  }
  for (const chip of document.querySelectorAll('#wmata-lines .chip')) {
    chip.setAttribute('aria-pressed', String(settings.overlays.wmata.lines[chip.dataset.line] !== false));
  }
}

function build() {
  const lines = document.getElementById('wmata-lines');
  for (const [id, name, color] of LINES) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.dataset.line = id;
    chip.style.setProperty('--c', color);
    chip.innerHTML = '<i></i>';
    chip.append(name);
    chip.title = `Show/hide the ${name} line`;
    chip.addEventListener('click', () => {
      const l = settings.overlays.wmata.lines;
      l[id] = l[id] === false;
      render();
      save();
    });
    lines.append(chip);
  }

  document.getElementById('enabled').addEventListener('change', (e) => {
    settings.enabled = e.target.checked;
    render();
    save();
  });

  for (const section of document.querySelectorAll('[data-overlay]')) {
    const cfg = () => settings.overlays[section.dataset.overlay];
    for (const input of section.querySelectorAll('input[data-key], select[data-key]')) {
      input.addEventListener(input.type === 'range' ? 'input' : 'change', () => {
        cfg()[input.dataset.key] = input.type === 'checkbox' ? input.checked : Number(input.value);
        render();
        save();
      });
    }
  }
}

async function status() {
  const el = document.getElementById('status');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let res = null;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'gmo:status' });
  } catch {}
  if (res?.count) {
    el.textContent = `${res.count} Google Map${res.count > 1 ? 's' : ''} found on this page.`;
    el.classList.add('found');
  } else {
    el.textContent = /^https?:/.test(tab?.url || '')
      ? 'No Google Map found on this page (yet).'
      : 'Overlays can’t run on this page.';
  }
}

(async () => {
  settings = await GMO.load();
  build();
  render();
  status();
})();
