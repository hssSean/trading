import { describe, expect, it } from 'vitest';
import { buildSignedQuery, signQuery } from '../../src/engine/binanceClient';

describe('signQuery', () => {
  // Worked example from Binance's official API documentation (HMAC-SHA256
  // signed endpoint security type). Verified independently via Node's crypto
  // module before hardcoding — do not "fix" this value without re-deriving it.
  it('matches Binance\'s documented HMAC-SHA256 signing example', () => {
    const qs = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
    const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
    expect(signQuery(qs, secret)).toBe(
      'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71',
    );
  });

  it('produces a different signature for a different secret (sanity check against a no-op hash)', () => {
    const qs = 'symbol=BTCUSDT&timestamp=1000';
    expect(signQuery(qs, 'secretA')).not.toBe(signQuery(qs, 'secretB'));
  });

  it('is deterministic — same input always produces the same signature', () => {
    const qs = 'symbol=BTCUSDT&timestamp=1000';
    expect(signQuery(qs, 'secret')).toBe(signQuery(qs, 'secret'));
  });
});

describe('buildSignedQuery', () => {
  it('appends timestamp, recvWindow, and a valid trailing signature', () => {
    const out = buildSignedQuery({ symbol: 'BTCUSDT', side: 'BUY' }, 'mysecret', 1000, 5000);
    expect(out).toMatch(/^symbol=BTCUSDT&side=BUY&timestamp=1000&recvWindow=5000&signature=[0-9a-f]{64}$/);
  });

  it('omits keys whose value is undefined instead of serializing "key=undefined"', () => {
    const out = buildSignedQuery({ symbol: 'BTCUSDT', price: undefined }, 'mysecret', 1000);
    expect(out).not.toContain('price=undefined');
    expect(out).not.toContain('price=');
  });

  it('URL-encodes values so special characters in params cannot break the query string', () => {
    const out = buildSignedQuery({ note: 'a&b=c' }, 'mysecret', 1000);
    expect(out).toContain('note=a%26b%3Dc');
  });

  it('defaults recvWindow to 5000 when not specified', () => {
    const out = buildSignedQuery({ symbol: 'BTCUSDT' }, 'mysecret', 1000);
    expect(out).toContain('recvWindow=5000');
  });

  it('the produced signature actually verifies against signQuery on the same base string', () => {
    const secret = 'mysecret';
    const timestamp = 1700000000000;
    const out = buildSignedQuery({ symbol: 'ETHUSDT', quantity: 0.5 }, secret, timestamp, 6000);
    const [base, sigPart] = [out.slice(0, out.lastIndexOf('&signature=')), out.slice(out.lastIndexOf('signature=') + 10)];
    expect(signQuery(base, secret)).toBe(sigPart);
  });
});
