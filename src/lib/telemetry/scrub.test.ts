import { describe, expect, it } from 'vitest';

import {
  containsHomePath,
  dropPiiKeys,
  isPiiKey,
  scrubPaths,
  scrubSentryEvent,
  stripQueryStrings,
  type SentryEventLike,
} from './scrub';

describe('scrub — paths', () => {
  it('collapses the macOS home username but keeps the trailing path', () => {
    expect(scrubPaths('/Users/example/o8/src/x.ts')).toBe('/Users/…/o8/src/x.ts');
  });

  it('collapses linux /home usernames too', () => {
    expect(scrubPaths('at /home/deploy/app/server.js:12')).toBe('at /home/…/app/server.js:12');
  });

  it('scrubs multiple occurrences in one string', () => {
    const input = 'Error in /Users/quise/a.ts called from /Users/quise/b.ts';
    expect(scrubPaths(input)).toBe('Error in /Users/…/a.ts called from /Users/…/b.ts');
  });

  it('leaves non-home paths untouched', () => {
    expect(scrubPaths('/var/log/app.log')).toBe('/var/log/app.log');
  });
});

describe('scrub — query strings', () => {
  it('strips query strings from http(s) urls', () => {
    expect(stripQueryStrings('https://api.o8.run/v1/x?token=abc&id=9')).toBe('https://api.o8.run/v1/x');
  });

  it('leaves urls without a query untouched', () => {
    expect(stripQueryStrings('https://api.o8.run/v1/x')).toBe('https://api.o8.run/v1/x');
  });
});

describe('scrub — PII keys', () => {
  it('flags secret/identity keys', () => {
    for (const key of ['OPENAI_API_KEY', 'password', 'authToken', 'email', 'sessionId', 'Authorization', 'DSN', 'HOSTNAME']) {
      expect(isPiiKey(key)).toBe(true);
    }
  });

  it('leaves ordinary keys alone', () => {
    for (const key of ['packetId', 'count', 'author', 'runtime', 'status']) {
      expect(isPiiKey(key)).toBe(false);
    }
  });

  it('dropPiiKeys removes only the sensitive entries', () => {
    const cleaned = dropPiiKeys({ packetId: 'p1', OPENAI_API_KEY: 'sk-xxx', count: 3, password: 'hunter2' });
    expect(cleaned).toEqual({ packetId: 'p1', count: 3 });
  });
});

describe('scrub — containsHomePath', () => {
  it('detects home paths (stateful regex reset between calls)', () => {
    expect(containsHomePath('/Users/quise/x')).toBe(true);
    expect(containsHomePath('/Users/quise/y')).toBe(true); // would fail if lastIndex leaked
    expect(containsHomePath('no path here')).toBe(false);
  });
});

describe('scrub — scrubSentryEvent', () => {
  it('scrubs message, exception values, stack frames, request, and drops identity', () => {
    const event: SentryEventLike = {
      message: 'boom at /Users/quise/o8/x.ts',
      exception: {
        values: [
          {
            value: 'ENOENT /Users/quise/.o8/db',
            stacktrace: {
              frames: [
                { filename: '/Users/quise/o8/src/a.ts', abs_path: '/Users/quise/o8/src/a.ts', function: 'run', module: 'a' },
              ],
            },
          },
        ],
      },
      request: {
        url: 'https://x.o8.run/api?token=abc',
        query_string: 'token=abc',
        headers: { Authorization: 'Bearer xyz' },
        cookies: 'session=1',
        data: { body: 'secret' },
      },
      breadcrumbs: [
        { message: 'navigated to /Users/quise/o8', data: { url: 'https://x.o8.run/y?id=1' } },
        { message: 'clicked button', data: { count: 2, api_key: 'sk-1' } },
      ],
      extra: { OPENAI_API_KEY: 'sk-xxx', packetId: 'p1' },
      user: { id: 'quise', email: 'q@example.com' },
      server_name: 'Quises-MacBook.local',
    };

    const out = scrubSentryEvent(event, { dropBreadcrumbsWithPaths: true });

    expect(out).not.toBeNull();
    expect(out!.message).toBe('boom at /Users/…/o8/x.ts');
    expect(out!.exception?.values?.[0].value).toBe('ENOENT /Users/…/.o8/db');
    expect(out!.exception?.values?.[0].stacktrace?.frames?.[0].filename).toBe('/Users/…/o8/src/a.ts');
    // request identity dropped, url query stripped
    expect(out!.request?.url).toBe('https://x.o8.run/api');
    expect(out!.request?.query_string).toBeUndefined();
    expect(out!.request?.headers).toBeUndefined();
    expect(out!.request?.cookies).toBeUndefined();
    expect(out!.request?.data).toBeUndefined();
    // path-bearing breadcrumb dropped; the safe one kept (with api_key scrubbed)
    expect(out!.breadcrumbs).toHaveLength(1);
    expect(out!.breadcrumbs?.[0].message).toBe('clicked button');
    expect(out!.breadcrumbs?.[0].data).toEqual({ count: 2 });
    // extra PII dropped; identity removed
    expect(out!.extra).toEqual({ packetId: 'p1' });
    expect(out!.user).toBeUndefined();
    expect(out!.server_name).toBeUndefined();
  });

  it('never throws on a malformed event', () => {
    expect(() => scrubSentryEvent({} as SentryEventLike)).not.toThrow();
    expect(() => scrubSentryEvent({ exception: { values: undefined } } as SentryEventLike)).not.toThrow();
  });

  it('drops an event when scrubbing cannot inspect it safely', () => {
    const event = new Proxy({} as SentryEventLike, {
      get() {
        throw new Error('malformed event');
      },
    });
    expect(scrubSentryEvent(event)).toBeNull();
  });
});
