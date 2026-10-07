// A minimal cookie-keeping HTTP client for driving the app headlessly (acceptance.ts).
import { SIM } from './config';

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: any;
}

export class AppSession {
  private cookies = new Map<string, string>();
  constructor(readonly label: string, private base = SIM.appUrl) {}

  private absorb(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!value || /max-age=0|expires=thu, 01 jan 1970/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  hasSessionCookie() {
    return [...this.cookies.keys()].some((k) => /session_token/.test(k));
  }

  async request(method: string, url: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
    const target = url.startsWith('http') ? url : this.base + url;
    const res = await fetch(target, {
      method,
      redirect: 'manual',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Origin: this.base,
        Cookie: this.cookieHeader(),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.absorb(res);
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  get = (url: string, extra?: Record<string, string>) => this.request('GET', url, undefined, extra);
  post = (url: string, body?: unknown, extra?: Record<string, string>) => this.request('POST', url, body ?? {}, extra);
  put = (url: string, body?: unknown) => this.request('PUT', url, body ?? {});

  /** Follows redirects, carrying cookies; stops when the next hop is on the app and is a page. */
  private async follow(first: string, max = 12): Promise<Reply> {
    let url = first;
    let last: Reply | null = null;
    for (let i = 0; i < max; i++) {
      last = await this.request('GET', url);
      const loc = last.headers.get('location');
      if (last.status >= 300 && last.status < 400 && loc) {
        url = new URL(loc, url).toString();
        continue;
      }
      return last;
    }
    return last!;
  }

  /** Logs in through the simulated IdP as `username` (no picker: login_hint). */
  async login(username: string, providerId = SIM.oidc.providerId): Promise<Reply> {
    const start = await this.post('/api/auth/sign-in/oauth2', { providerId, callbackURL: '/dashboard' });
    const authUrl = start.json?.url as string | undefined;
    if (!authUrl) throw new Error(`login(${username}): no authorize URL (status ${start.status}: ${start.text.slice(0, 200)})`);
    const u = new URL(authUrl);
    u.searchParams.set('login_hint', username);
    return this.follow(u.toString());
  }

  /**
   * Logs in through the simulated SAML IdP as `username`: the app's AuthnRequest, the IdP's auto-posting
   * form (found in its HTML), and the cross-site POST to the app's ACS URL without any cookie of ours
   * going along, exactly as a browser would send it.
   */
  async loginSaml(username: string, providerId = SIM.saml.providerId): Promise<Reply> {
    const start = await this.post('/api/auth/sign-in/sso', { providerId, callbackURL: '/dashboard' });
    const authUrl = start.json?.url as string | undefined;
    if (!authUrl) throw new Error(`loginSaml(${username}): no IdP URL (status ${start.status}: ${start.text.slice(0, 200)})`);
    const u = new URL(authUrl);
    u.searchParams.set('login_hint', username);
    const page = await (await fetch(u)).text();
    const unescape = (v: string) => v.replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)));
    const field = (name: string) => {
      const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(page);
      return m ? unescape(m[1]) : undefined;
    };
    const action = /<form method="post" action="([^"]*)"/.exec(page)?.[1];
    const samlResponse = field('SAMLResponse');
    if (!action || !samlResponse) throw new Error(`loginSaml(${username}): IdP gave no form (${page.slice(0, 200)})`);
    const body = new URLSearchParams({ SAMLResponse: samlResponse, ...(field('RelayState') ? { RelayState: field('RelayState')! } : {}) });
    const res = await fetch(unescape(action), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: u.origin },
      body: body.toString(),
    });
    this.absorb(res);
    const loc = res.headers.get('location');
    return loc ? this.follow(new URL(loc, this.base).toString()) : { status: res.status, headers: res.headers, text: await res.text(), json: null };
  }
}
