// The signed-in surface: onboarding, then settings.
// Plain DOM, no framework. The product is behind the interface, not in it.

function post(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (r) {
    return r.json().catch(function () { return { ok: false, error: 'Something went wrong.' }; });
  });
}

function byId(id) { return document.getElementById(id); }

// ---- proactivity gauge (SPEC 3, step 5) ----
// A concrete estimate, not an abstract token count.
var ESTIMATES = {
  1: '5 messages a month',
  2: '12 messages a month',
  3: '20 messages a month',
  4: '45 messages a month',
  5: '90 messages a month'
};

var slider = byId('proactivity');
var estimate = byId('estimate');

if (slider && estimate) {
  slider.addEventListener('input', function () {
    estimate.textContent = ESTIMATES[slider.value] || ESTIMATES[3];
  });
}

// ---- personality "something else" reveal ----
var otherField = byId('personality_other');
if (otherField) {
  document.querySelectorAll('input[name="personality"]').forEach(function (radio) {
    radio.addEventListener('change', function () {
      otherField.hidden = radio.value !== 'custom' || !radio.checked;
      if (!otherField.hidden) otherField.focus();
    });
  });
}

// ---- live handle availability (SPEC 6.2) ----
var handleInput = byId('handle');
var handleStatus = byId('handle-status');
var handleTimer;

if (handleInput && handleStatus) {
  handleInput.addEventListener('input', function () {
    clearTimeout(handleTimer);
    var value = handleInput.value.trim();
    if (!value) { handleStatus.textContent = ''; return; }

    handleTimer = setTimeout(function () {
      fetch('/api/handle/check?handle=' + encodeURIComponent(value))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.ok) return;
          handleStatus.textContent = data.available
            ? data.address + ' is free.'
            : (data.reason || 'That one is taken.');
        });
    }, 300);
  });
}

// ---- onboarding submit ----
var form = byId('onboarding');
if (form) {
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var errorEl = byId('onboarding-error');
    var button = form.querySelector('button[type="submit"]');
    errorEl.textContent = '';
    button.disabled = true;
    button.textContent = 'Saving';

    var data = new FormData(form);
    var personality = data.get('personality');

    post('/api/account', {
      name: data.get('name'),
      country: data.get('country'),
      address: data.get('address'),
      mobile_number: data.get('mobile_number')
    })
      .then(function (accountResult) {
        if (!accountResult.ok) throw new Error(accountResult.error || 'Could not save your details.');
        return post('/api/onboarding', {
          assistant_name: data.get('assistant_name'),
          address_as: data.get('address_as'),
          personality: personality,
          personality_other: data.get('personality_other'),
          language: data.get('language'),
          proactivity: Number(data.get('proactivity')),
          context: data.get('context'),
          handle: data.get('handle')
        });
      })
      .then(function (result) {
        if (!result.ok) throw new Error(result.error || 'Could not finish setting up.');
        window.location.reload();
      })
      .catch(function (err) {
        button.disabled = false;
        button.textContent = 'Done';
        errorEl.textContent = err.message;
      });
  });
}

// ---- channel linking (SPEC 4.3) ----
document.querySelectorAll('.connect').forEach(function (button) {
  button.addEventListener('click', function () {
    var channel = button.dataset.channel;
    button.disabled = true;

    post('/api/channels/pair', {}).then(function (data) {
      button.disabled = false;
      if (!data.ok) return;

      var url = channel === 'whatsapp' ? data.whatsappUrl : data.telegramUrl;
      var pairing = byId('pairing');
      var copy = byId('pairing-copy');

      if (!url) {
        copy.textContent = 'That channel is not connected on our side yet.';
        pairing.hidden = false;
        return;
      }

      copy.innerHTML = 'Open <a class="u" href="' + url + '">this link</a> on your phone, or scan the code.';
      byId('qr').innerHTML =
        '<img alt="Pairing code" width="180" height="180" src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' +
        encodeURIComponent(url) + '">';
      pairing.hidden = false;
    });
  });
});

// ---- active outbound channel (SPEC 4.2) ----
document.querySelectorAll('.set-active').forEach(function (button) {
  button.addEventListener('click', function () {
    button.disabled = true;
    post('/api/channels/active', { channel: button.dataset.channel }).then(function (data) {
      if (data.ok) window.location.reload();
      else button.disabled = false;
    });
  });
});

// ---- settings: proactivity persists on release ----
if (slider && !form) {
  slider.addEventListener('change', function () {
    post('/api/onboarding', { proactivity: Number(slider.value) });
  });
}

// ---- account ----
var signOut = byId('signout');
if (signOut) {
  signOut.addEventListener('click', function (e) {
    e.preventDefault();
    post('/api/auth/logout', {}).then(function () { window.location.href = '/'; });
  });
}

var deleteAll = byId('delete-all');
if (deleteAll) {
  deleteAll.addEventListener('click', function (e) {
    e.preventDefault();
    if (!window.confirm('Delete everything we hold on you? This cannot be undone.')) return;
    fetch('/api/data', { method: 'DELETE' }).then(function () { window.location.href = '/'; });
  });
}
