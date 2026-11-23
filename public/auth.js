// Sign in / sign up / forgot / reset — one page, picked by the URL path.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const params = new URLSearchParams(location.search);
const next = (() => {
  const n = params.get('next') || '/';
  return /^\/(?!\/)/.test(n) && !n.includes('\\') ? n : '/';
})();
const mode = { '/signup': 'signup', '/forgot-password': 'forgot', '/reset-password': 'reset' }[location.pathname.replace(/\/$/, '')] || 'signin';
const withNext = (path) => (next !== '/' ? `${path}?next=${encodeURIComponent(next)}` : path);

const ERRORS = {
  google_not_configured: 'Google sign-in isn’t switched on for this LaunchLoop yet. Use your email and password, or ask the owner to add the Google keys.',
  google_cancelled: 'Google sign-in was cancelled.',
  google_failed: 'Google sign-in didn’t work. Please try again.',
  google_expired: 'That sign-in took too long. Please try again.',
  google_unverified: 'Your Google email isn’t verified yet.',
  needs_code: 'This is the first account, so it becomes the owner. Enter the access code below, then continue with Google again.',
  disabled: 'This account has been switched off. Ask your LaunchLoop admin if you think this is a mistake.',
};

const G_LOGO = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `Something went wrong (HTTP ${r.status})`), { status: r.status });
  return data;
}

function strength(pw) {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  if (pw.length < 8) s = Math.min(s, 1);
  return Math.max(1, s);
}
const STRENGTH_LABEL = ['', 'Too weak', 'Fair', 'Good', 'Strong'];

const field = (name, label, { type = 'text', auto = '', value = '', extra = '', hint = '', after = '', required = true } = {}) => `
  <label class="field"><span>${label}${extra}</span>
    <div class="input ${type === 'password' ? 'pw' : ''}"><input name="${name}" type="${type}" autocomplete="${auto}" value="${esc(value)}" ${required ? 'required' : ''}>${type === 'password' ? '<button type="button" class="eye" data-eye>Show</button>' : ''}</div>
    ${after}${hint ? `<small>${hint}</small>` : ''}<div class="ferr" data-err="${name}"></div></label>`;

function render(cfg) {
  const card = $('#card');
  const err = ERRORS[params.get('error')] || '';
  const google = (label) => `<button type="button" class="gbtn" data-google>${G_LOGO}<span>${label}</span></button><div class="or">or</div>`;
  const codeField = cfg.signupNeedsCode
    ? field('accessCode', 'Owner access code', { type: 'password', auto: 'off', required: false, hint: 'This first account becomes the owner. Paste <code>APP_API_TOKEN</code> from Render → Environment.' })
    : '';

  if (mode === 'signin') {
    document.title = 'Sign in — LaunchLoop';
    card.innerHTML = `<h2>Welcome back</h2><p class="sub">Sign in to your LaunchLoop workspace.</p>
      ${google('Continue with Google')}
      <form novalidate>
        <div class="alert ${params.get('pending') ? 'info' : 'bad'}" role="alert">${params.get('pending') ? 'Thanks for signing up! An admin needs to approve your account before you can sign in. You’ll get an email when it’s approved.' : esc(err)}</div>
        ${field('email', 'Email', { type: 'email', auto: 'email', value: params.get('email') || '' })}
        ${field('password', 'Password', { type: 'password', auto: 'current-password', extra: `<a href="${withNext('/forgot-password')}">Forgot password?</a>` })}
        <label class="check"><input type="checkbox" name="remember" checked> Keep me signed in for a year</label>
        <button class="btn" type="submit">Sign in</button>
      </form>
      <p class="switch">New to LaunchLoop? <a href="${withNext('/signup')}">Create an account</a></p>`;
  } else if (mode === 'signup') {
    document.title = 'Create account — LaunchLoop';
    card.innerHTML = `<h2>Create your account</h2><p class="sub">${!cfg.hasUsers ? 'You’ll be the owner of this LaunchLoop.' : cfg.approvalRequired ? 'Join your team’s LaunchLoop. An admin approves new accounts before first sign-in.' : 'Join your team’s LaunchLoop workspace.'}</p>
      ${google('Sign up with Google')}
      <form novalidate>
        <div class="alert ${params.get('error') === 'needs_code' ? 'info' : 'bad'}" role="alert">${esc(err)}</div>
        ${field('name', 'Full name', { auto: 'name' })}
        ${field('email', 'Work email', { type: 'email', auto: 'email', value: params.get('email') || '' })}
        ${field('password', 'Password', { type: 'password', auto: 'new-password', after: '<div class="meter" data-s="0"><i></i><i></i><i></i><i></i></div>', hint: '<span class="meter-label">At least 8 characters, with a number or symbol.</span>' })}
        ${codeField}
        <button class="btn" type="submit">Create account</button>
      </form>
      <p class="switch">Already have an account? <a href="${withNext('/signin')}">Sign in</a></p>`;
  } else if (mode === 'forgot') {
    document.title = 'Reset password — LaunchLoop';
    card.innerHTML = `<h2>Reset your password</h2>
      <p class="sub">${cfg.emailReset ? 'Enter your email and we’ll send you a link to choose a new password.' : 'Enter your email, your team access code and a new password.'}</p>
      <form novalidate>
        <div class="alert" role="alert"></div>
        ${field('email', 'Email', { type: 'email', auto: 'email', value: params.get('email') || '' })}
        ${cfg.emailReset ? '' : field('accessCode', 'Team access code', { type: 'password', auto: 'off', hint: 'Owner: it’s <code>APP_API_TOKEN</code> in Render → Environment.' }) + field('password', 'New password', { type: 'password', auto: 'new-password', after: '<div class="meter" data-s="0"><i></i><i></i><i></i><i></i></div>' })}
        <button class="btn" type="submit">${cfg.emailReset ? 'Email me a reset link' : 'Set new password'}</button>
      </form>
      <p class="switch"><a href="${withNext('/signin')}">← Back to sign in</a></p>`;
  } else {
    document.title = 'Choose a new password — LaunchLoop';
    card.innerHTML = `<h2>Choose a new password</h2><p class="sub">You’ll be signed in straight after.</p>
      <form novalidate>
        <div class="alert bad" role="alert">${params.get('token') ? '' : 'This link is missing its code — open the link from the email again.'}</div>
        ${field('password', 'New password', { type: 'password', auto: 'new-password', after: '<div class="meter" data-s="0"><i></i><i></i><i></i><i></i></div>' })}
        ${field('confirm', 'Confirm new password', { type: 'password', auto: 'new-password' })}
        <button class="btn" type="submit">Save password</button>
      </form>
      <p class="switch"><a href="/signin">← Back to sign in</a></p>`;
  }
  wire(cfg);
}

function wire(cfg) {
  const form = $('form');
  const alert = $('.alert', form);
  const setErr = (name, msg) => {
    const el = $(`[data-err="${name}"]`, form);
    const input = form.elements[name];
    if (el) el.textContent = msg || '';
    if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  };
  const showAlert = (msg, kind = 'bad') => {
    alert.className = `alert ${kind}`;
    alert.textContent = msg;
  };

  form.querySelectorAll('[data-eye]').forEach((b) =>
    b.addEventListener('click', () => {
      const i = b.previousElementSibling;
      i.type = i.type === 'password' ? 'text' : 'password';
      b.textContent = i.type === 'password' ? 'Show' : 'Hide';
    }),
  );
  const meter = $('.meter', form);
  if (meter) {
    const label = $('.meter-label', form);
    form.elements.password.addEventListener('input', (e) => {
      const s = strength(e.target.value);
      meter.dataset.s = e.target.value ? s : 0;
      if (label) label.textContent = e.target.value ? `${STRENGTH_LABEL[s]} · at least 8 characters, with a number or symbol.` : 'At least 8 characters, with a number or symbol.';
    });
  }
  form.querySelectorAll('input').forEach((i) => i.addEventListener('input', () => setErr(i.name, '')));

  $('[data-google]')?.addEventListener('click', async () => {
    const code = form.elements.accessCode?.value?.trim();
    try {
      if (mode === 'signup' && form.elements.accessCode) await post('/api/auth/google/prepare', { accessCode: code || '' });
      location.href = `/api/auth/google/start?mode=${mode === 'signup' ? 'signup' : 'signin'}&next=${encodeURIComponent(next)}`;
    } catch (e) {
      setErr('accessCode', e.message);
    }
  });

  const validate = () => {
    let ok = true;
    const v = (n) => form.elements[n]?.value?.trim() ?? '';
    const req = (n, msg) => {
      if (form.elements[n] && !v(n)) {
        setErr(n, msg);
        ok = false;
      }
    };
    if (form.elements.email) {
      if (!v('email')) (setErr('email', 'Enter your email'), (ok = false));
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v('email'))) (setErr('email', 'That email doesn’t look right'), (ok = false));
    }
    if (mode === 'signup') req('name', 'Enter your name');
    if (form.elements.password) {
      const pw = form.elements.password.value;
      if (!pw) (setErr('password', 'Enter a password'), (ok = false));
      else if (mode !== 'signin' && (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/[0-9\W_]/.test(pw))) (setErr('password', 'Use at least 8 characters, mixing letters with a number or symbol'), (ok = false));
    }
    if (mode === 'reset' && form.elements.confirm.value !== form.elements.password.value) (setErr('confirm', 'The passwords don’t match'), (ok = false));
    if (mode === 'forgot' && !cfg.emailReset) req('accessCode', 'Enter your team access code');
    if (mode === 'signup' && cfg.signupNeedsCode) req('accessCode', 'Enter your team access code');
    return ok;
  };

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showAlert('');
    if (!validate()) return form.querySelector('[aria-invalid=true]')?.focus();
    const btn = $('button[type=submit]', form);
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Please wait…';
    const f = Object.fromEntries(new FormData(form));
    try {
      if (mode === 'signin') await post('/api/auth/signin', { email: f.email, password: f.password, remember: !!f.remember });
      else if (mode === 'signup') {
        const r = await post('/api/auth/signup', { name: f.name, email: f.email, password: f.password, accessCode: f.accessCode, remember: true });
        if (r.user?.pending) {
          $('#card').innerHTML = `<div class="done"><div class="done-ico">✓</div><h2>You’re on the list</h2>
            <p class="sub">Thanks, ${esc(r.user.name)}. Your account is waiting for an admin to approve it.${cfg.emailReset ? ` We’ll email <b>${esc(r.user.email)}</b> as soon as you’re approved.` : ' Let your LaunchLoop admin know you’ve signed up.'}</p>
            <a class="btn btn-link" href="/signin?email=${encodeURIComponent(r.user.email)}">Back to sign in</a></div>`;
          return;
        }
      }
      else if (mode === 'reset') await post('/api/auth/reset', { token: params.get('token'), password: f.password });
      else if (cfg.emailReset) {
        await post('/api/auth/forgot', { email: f.email });
        showAlert(`If ${f.email} has an account, a reset link is on its way. Check your inbox (and spam).`, 'ok');
        btn.disabled = false;
        btn.textContent = label;
        return;
      } else await post('/api/auth/reset-with-code', { email: f.email, accessCode: f.accessCode, password: f.password });
      btn.textContent = 'Signed in ✓';
      location.href = next;
    } catch (e) {
      const m = e.message;
      if (/access code/i.test(m) && form.elements.accessCode) setErr('accessCode', m);
      else if (/password/i.test(m) && e.status === 400 && mode !== 'signin') setErr('password', m);
      else if (/valid email/i.test(m)) setErr('email', m);
      else showAlert(m);
      btn.disabled = false;
      btn.textContent = label;
    }
  });
  (form.querySelector('input:not([value=""])[type=email]') ? form.elements.password : form.querySelector('input'))?.focus();
}

(async () => {
  const [cfg, session] = await Promise.all([fetch('/api/auth/config').then((r) => r.json()), fetch('/api/session').then((r) => r.json())]);
  if (session.signedIn && mode !== 'reset') return location.replace(next);
  render(cfg);
})().catch(() => {
  $('#card').innerHTML = '<div class="alert bad">Can’t reach LaunchLoop right now. Refresh to try again.</div>';
});
