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

// The browser already knows the user's timezone, so the assistant can be given
// a correct clock without asking a question about it. Without this it answers
// "what day is it" from whatever the model assumed, and every relative time
// the user mentions resolves against the wrong date.
function currentTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch (e) {
    return '';
  }
}

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

// ---- the proactivity question names the assistant ----
// The name is chosen a few questions earlier in the same form, so the label
// follows it rather than saying "they".
var assistantNameField = byId('assistant_name');
var assistantLabel = byId('assistant-label');

if (assistantNameField && assistantLabel) {
  assistantNameField.addEventListener('input', function () {
    var name = assistantNameField.value.trim();
    assistantLabel.textContent = name || 'your assistant';
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
  var originalHandle = handleInput.value.trim();

  handleInput.addEventListener('input', function () {
    clearTimeout(handleTimer);
    var value = handleInput.value.trim();
    if (!value) { handleStatus.textContent = ''; return; }
    if (value === originalHandle) { handleStatus.textContent = 'This is the current address.'; return; }

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
          timezone: currentTimezone(),
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

// ---- hold to record (SPEC 3, step 6) ----
// The transcript is what gets stored and embedded. The audio stays in R2 for
// the user's own reference and deletion, and is never replayed back into the
// assistant's reasoning, so the textarea is filled with the transcript and the
// user can edit it before saving.
var recordBtn = byId('record');
var contextField = byId('context');

if (recordBtn && contextField) {
  var recorder = null;
  var chunks = [];
  var idleLabel = recordBtn.textContent;

  function supported() {
    return !!(navigator.mediaDevices && window.MediaRecorder);
  }

  if (!supported()) {
    recordBtn.hidden = true;
  } else {
    recordBtn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(function (stream) {
          chunks = [];
          recorder = new MediaRecorder(stream);
          recorder.ondataavailable = function (ev) {
            if (ev.data && ev.data.size) chunks.push(ev.data);
          };
          recorder.onstop = function () {
            stream.getTracks().forEach(function (t) { t.stop(); });
            upload(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
          };
          recorder.start();
          recordBtn.textContent = 'Recording, let go when done';
        })
        .catch(function () {
          recordBtn.textContent = 'Microphone not available';
          setTimeout(function () { recordBtn.textContent = idleLabel; }, 2500);
        });
    });

    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (evt) {
      recordBtn.addEventListener(evt, function () {
        if (recorder && recorder.state === 'recording') {
          recorder.stop();
          recorder = null;
          recordBtn.textContent = 'Transcribing';
        }
      });
    });
  }

  function upload(blob) {
    fetch('/api/recording', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        recordBtn.textContent = idleLabel;
        if (!data.ok) return;
        if (data.transcript) {
          contextField.value = contextField.value
            ? contextField.value + '\n' + data.transcript
            : data.transcript;
        } else {
          contextField.placeholder = 'That did not transcribe. Type it instead.';
        }
      })
      .catch(function () {
        recordBtn.textContent = idleLabel;
      });
  }
}

// ---- is the channel actually able to reach us? ----
// Opening the bot chat is not the same as connecting. Telegram only forwards
// /start to this Worker once a webhook is registered, so without one the chat
// opens, the bot looks live, and nothing ever binds. Say so rather than
// letting people discover it by sending messages into a void.
var channelWarning = byId('channel-warning');

if (channelWarning) {
  fetch('/api/diagnostics')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.ok) return;
      var problems = [];
      ['telegram', 'whatsapp'].forEach(function (name) {
        var c = d[name];
        var configured = name === 'telegram' ? c.bot_token : c.token;
        if (!configured) return;
        if (!c.last_webhook || c.last_webhook.outcome !== 'accepted') {
          problems.push(c.hint);
        }
      });
      if (problems.length) {
        channelWarning.textContent = problems.join(' ');
        channelWarning.hidden = false;
      }
    })
    .catch(function () { /* diagnostics are advisory, never block the page */ });
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

// ---- settings ----
// Everything chosen during onboarding stays editable here. /api/preferences is
// a partial update, so it is safe to send only what changed.
var settingsForm = byId('settings');

if (settingsForm) {
  settingsForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var status = byId('settings-status');
    var button = settingsForm.querySelector('button[type="submit"]');
    var data = new FormData(settingsForm);

    status.textContent = '';
    button.disabled = true;
    button.textContent = 'Saving';

    post('/api/preferences', {
      assistant_name: data.get('assistant_name'),
      address_as: data.get('address_as'),
      personality: data.get('personality'),
      language: data.get('language'),
      proactivity: Number(data.get('proactivity')),
      timezone: currentTimezone()
    }).then(function (result) {
      button.disabled = false;
      button.textContent = 'Save changes';
      if (!result.ok) { status.textContent = result.error || 'Could not save.'; return; }
      // The name appears in several headings, so re-render rather than leave
      // the page showing the old one.
      window.location.reload();
    });
  });
}

// ---- change the assistant's email address (SPEC 6.2) ----
var saveHandle = byId('save-handle');

if (saveHandle && handleInput && handleStatus) {
  saveHandle.addEventListener('click', function () {
    var value = handleInput.value.trim();
    if (!value) { handleStatus.textContent = 'Pick an address first.'; return; }

    saveHandle.disabled = true;
    saveHandle.textContent = 'Saving';

    post('/api/handle', { handle: value }).then(function (result) {
      saveHandle.disabled = false;
      saveHandle.textContent = 'Save address';
      handleStatus.textContent = result.ok
        ? (result.unchanged ? 'That is already the address.' : 'Now ' + result.handle + '.')
        : (result.error || 'Could not change it.');
    });
  });
}

// ---- what the assistant knows about you ----
var memoryList = byId('memory-list');
var memoryNew = byId('memory-new');
var addMemoryBtn = byId('add-memory');

function renderMemory() {
  fetch('/api/memory')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.ok) return;
      if (!data.memories.length) {
        memoryList.innerHTML = '<p class="disclaimer">Nothing yet.</p>';
        return;
      }
      memoryList.innerHTML = data.memories.map(function (m) {
        var div = document.createElement('div');
        div.textContent = m.text;
        return '<div class="memory"><span>' + div.innerHTML +
          '</span><button class="ghost-btn forget" data-id="' + m.id + '">Forget</button></div>';
      }).join('');

      memoryList.querySelectorAll('.forget').forEach(function (b) {
        b.addEventListener('click', function () {
          b.disabled = true;
          fetch('/api/memory', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: b.dataset.id })
          })
            .then(function (r) { return r.json(); })
            .then(function (result) {
              if (result.ok) renderMemory();
              else b.disabled = false;
            });
        });
      });
    });
}

if (memoryList) renderMemory();

if (addMemoryBtn && memoryNew) {
  addMemoryBtn.addEventListener('click', function () {
    var text = memoryNew.value.trim();
    if (!text) { memoryNew.focus(); return; }

    addMemoryBtn.disabled = true;
    addMemoryBtn.textContent = 'Adding';

    post('/api/memory', { text: text }).then(function (result) {
      addMemoryBtn.disabled = false;
      addMemoryBtn.textContent = 'Add';
      if (result.ok) { memoryNew.value = ''; renderMemory(); }
    });
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
