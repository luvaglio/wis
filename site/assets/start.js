// /start: the counter, then email plus a one-time code.
//
// Auth is email-based, not phone-based (SPEC 2.1). There is no SMS anywhere
// in this flow. The mobile number is captured later as a contact field on the
// account, and is verified implicitly when a channel is linked (SPEC 4.3).

// ---- counter ----
// NOTE: wire this to your real signup count via an API endpoint when live,
// e.g. fetch('/api/count').then(r => r.json()).then(d => runCounter(d.count));
var COUNTER_TARGET = 534231;

function formatNum(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function runCounter(target) {
  var el = document.getElementById('counter');
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { el.textContent = formatNum(target); return; }

  var duration = 1800;
  var start = performance.now();
  function frame(now) {
    var t = Math.min((now - start) / duration, 1);
    var eased = 1 - Math.pow(1 - t, 4);
    el.textContent = formatNum(Math.round(target * eased));
    if (t < 1) requestAnimationFrame(frame);
    else tick(el, target);
  }
  requestAnimationFrame(frame);
}

// slow live ticking after the count-up
function tick(el, base) {
  var current = base;
  setInterval(function () {
    if (Math.random() < 0.6) current += 1;
    el.textContent = formatNum(current);
  }, 4000);
}

runCounter(COUNTER_TARGET);

// ---- sign in ----
var emailStep = document.getElementById('email-step');
var codeStep = document.getElementById('code-step');
var emailInput = document.getElementById('email');
var codeInput = document.getElementById('code');
var startBtn = document.getElementById('startBtn');
var verifyBtn = document.getElementById('verifyBtn');
var errorEl = document.getElementById('start-error');

function setError(message) {
  errorEl.textContent = message || '';
}

function post(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (r) {
    return r.json().catch(function () { return { ok: false, error: 'Something went wrong.' }; });
  });
}

function requestCode() {
  var email = emailInput.value.trim();
  if (!email || email.indexOf('@') === -1) {
    setError('Enter your email address.');
    emailInput.focus();
    return;
  }

  setError('');
  startBtn.disabled = true;
  startBtn.textContent = 'Sending';

  post('/api/auth/request', { email: email }).then(function (data) {
    startBtn.disabled = false;
    startBtn.textContent = 'Start';

    if (!data.ok) {
      setError(data.error || 'Could not send the code.');
      return;
    }

    document.getElementById('sent-to').textContent = email;
    emailStep.hidden = true;
    codeStep.hidden = false;
    codeInput.focus();
  });
}

function verify() {
  var code = codeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    setError('Enter the six digit code.');
    codeInput.focus();
    return;
  }

  setError('');
  verifyBtn.disabled = true;
  verifyBtn.textContent = 'Checking';

  post('/api/auth/verify', { email: emailInput.value.trim(), code: code }).then(function (data) {
    verifyBtn.disabled = false;
    verifyBtn.textContent = 'Continue';

    if (!data.ok) {
      setError(data.error || 'That code is not right.');
      return;
    }
    window.location.href = '/app';
  });
}

startBtn.addEventListener('click', requestCode);
verifyBtn.addEventListener('click', verify);

emailInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') requestCode();
});
codeInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') verify();
});

document.getElementById('resend').addEventListener('click', function (e) {
  e.preventDefault();
  setError('');
  post('/api/auth/request', { email: emailInput.value.trim() }).then(function () {
    setError('Sent again. Check your inbox.');
  });
});
