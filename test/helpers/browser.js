/** Minimal browser for panel tests: keeps cookies, sends same-origin Origin headers, tracks CSRF tokens. */
export class Browser {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  headers(extra = {}) {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    return { ...(cookie ? { Cookie: cookie } : {}), ...extra };
  }

  async read(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const [name, value] = pair.split('=');
      const expired = attrs.some((a) => /expires=Thu, 01 Jan 1970/i.test(a));
      if (expired || value === '') this.cookies.delete(name.trim());
      else this.cookies.set(name.trim(), value);
    }
    const text = await res.text();
    this.csrf = /name="_csrf" value="([^"]+)"/.exec(text)?.[1] ?? this.csrf;
    return { status: res.status, text, location: res.headers.get('location'), headers: res.headers };
  }

  async get(url) {
    return this.read(await fetch(this.base + url, { headers: this.headers(), redirect: 'manual' }));
  }

  async post(url, fields = {}) {
    const body = new URLSearchParams({ _csrf: this.csrf ?? '' });
    for (const [k, v] of Object.entries(fields)) for (const item of [].concat(v)) body.append(k, item);
    return this.read(await fetch(this.base + url, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/x-www-form-urlencoded', Origin: this.base }),
      body,
      redirect: 'manual',
    }));
  }

  async login(email, password) {
    await this.get('/login');
    return this.post('/login', { email, password });
  }
}
