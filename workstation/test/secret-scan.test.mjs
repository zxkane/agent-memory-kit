import test from 'node:test';
import assert from 'node:assert/strict';
import { PATTERNS, scanText } from '../lib/secret-scan.mjs';

test('flags each pattern and reports id and line only', () => {
  const cases = {
    'aws-access-key-id': 'key AK' + 'IAQ3R5T7V9X2Z4B6D8 here',
    'github-token': 'ghp_' + 'a'.repeat(36),
    'slack-token': 'xox' + 'b-123456789012-abcdefghij',
    'api-key-sk': 'sk-' + 'A1b2'.repeat(10),
    'private-key-block': '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----',
    'jwt': 'ey' + 'JhbGciOiJIUzI1NiJ9.ey' + 'JzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    'secret-assignment': 'CLOUDFLARE_API_TOKEN=' + 'abcDEF1234567890abcDEF1234567890abcdEF12',
  };
  for (const [id, line] of Object.entries(cases)) {
    assert.deepEqual(scanText(`first line\n${line}\n`), [{ id, line: 2 }], id);
  }
});

test('does not flag ordinary note content', () => {
  const clean = [
    'commit 9fceb02d0ae598e95dc970b74767f19372d61af8 fixed it',
    'arn:aws:lambda:us-east-1:111122223333:function:my-function',
    'see https://example.com/a/very/long/path/with/many/segments/0123456789abcdef',
    'API_KEY=<your-key>',
    'export TOKEN=${GITHUB_TOKEN}',
    'the token is stored in SSM under /app/prod/token',
    'password: example-placeholder-value-123456',
  ].join('\n');
  assert.deepEqual(scanText(clean), []);
});

test('handles empty input and a very long line', () => {
  assert.deepEqual(scanText(''), []);
  assert.deepEqual(scanText('a'.repeat(200000)), []);
});

test('orders findings by line then pattern order, one per pattern per line', () => {
  const aws = 'AK' + 'IAQ3R5T7V9X2Z4B6D8';
  const text = `${aws} ${aws}\nclean\n${aws} xox` + 'b-123456789012-abcdefghij';
  assert.deepEqual(scanText(text), [
    { id: 'aws-access-key-id', line: 1 },
    { id: 'aws-access-key-id', line: 3 },
    { id: 'slack-token', line: 3 },
  ]);
});

test('secret-assignment requires a letter and a digit in the value', () => {
  assert.deepEqual(scanText('token=' + 'a'.repeat(30)), []);
  assert.deepEqual(scanText('token=' + '1'.repeat(30)), []);
  assert.deepEqual(scanText('token: "' + 'a1'.repeat(15) + '"'), [{ id: 'secret-assignment', line: 1 }]);
});

test('secret-assignment finds a real value after an excluded one on the same line', () => {
  const line = `password=${'xxxx1'.repeat(5)} sec` + `ret=abcDEF1234567890abcDEF1234`;
  assert.deepEqual(scanText(line), [{ id: 'secret-assignment', line: 1 }]);
});

test('exposes the pattern table in order', () => {
  assert.deepEqual(PATTERNS.map((p) => p.id), [
    'aws-access-key-id', 'github-token', 'slack-token', 'api-key-sk',
    'private-key-block', 'jwt', 'secret-assignment',
  ]);
  assert.ok(PATTERNS.every((p) => p.re instanceof RegExp));
});

test('stays fast on long runs of a token prefix inside its own character class', () => {
  for (const unit of ['eyJ-', 'sk-', 'xoxb-', 'ghp_', 'github_pat_', 'AKIA']) {
    const start = Date.now();
    scanText(unit.repeat(50000));
    assert.ok(Date.now() - start < 1000, unit);
  }
});

test('stays fast on pathological repeated keywords', () => {
  const start = Date.now();
  scanText('token'.repeat(40000));
  assert.ok(Date.now() - start < 2000);
});

const jwt = () => 'ey' + 'JhbGciOiJIUzI1NiJ9.ey' + 'JzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';

test('a JSON web token directly after a hyphen is flagged', () => {
  for (const line of [`-${jwt()}`, `see -${jwt()}`, `id-${jwt()}`]) {
    assert.deepEqual(scanText(line), [{ id: 'jwt', line: 1 }], line);
  }
});

test('a JSON web token glued to a letter, digit or underscore is not taken for one', () => {
  for (const prefix of ['a', '7', '_']) assert.deepEqual(scanText(`${prefix}${jwt()}`), [], prefix);
});

test('a JSON web token with a very long first segment is flagged', () => {
  const longHeader = 'ey' + 'J' + 'h'.repeat(4997);
  assert.equal(longHeader.length, 5000);
  const token = `${longHeader}.ey` + 'JzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
  assert.deepEqual(scanText(`note\nheader ${token} end\n`), [{ id: 'jwt', line: 2 }]);
});

test('two JSON web tokens on one line give one finding for that line', () => {
  assert.deepEqual(scanText(`${jwt()} and -${jwt()}`), [{ id: 'jwt', line: 1 }]);
});

test('stays fast on a hyphen-heavy line with token-shaped segments', () => {
  const start = Date.now();
  scanText(`${'-eyJ' + 'a'.repeat(30)}.`.repeat(20000));
  scanText(`-ey${'J-'.repeat(50000)}`);
  assert.ok(Date.now() - start < 1000);
});

test('stays fast on many token-shaped candidates inside one run of token characters', () => {
  const start = Date.now();
  scanText(('eyJ' + 'a'.repeat(20) + '-').repeat(10000));
  assert.ok(Date.now() - start < 1000);
});

test('an OpenPGP private key block is flagged', () => {
  assert.deepEqual(scanText(`note\n${'-----BEGIN PGP ' + 'PRIVATE KEY BLOCK-----'}\n`), [{ id: 'private-key-block', line: 2 }]);
  assert.deepEqual(scanText('-----BEGIN PGP PUBLIC KEY BLOCK-----\n'), []);
});

test('visibly fake AWS access key ids are not flagged', () => {
  for (const tail of ['IOSFODNN7EXAMPLE', 'TESTINVALID00000', 'ABCDFAKE23456789', '0000DUMMY0000000', 'INVALIDKEY234567']) {
    assert.deepEqual(scanText('key ' + 'AK' + 'IA' + tail), [], tail);
    assert.deepEqual(scanText('key ' + 'AS' + 'IA' + tail), [], tail);
  }
});

test('an ordinary AWS access key id is flagged, also next to a fake one', () => {
  const real = 'AK' + 'IA' + 'Q3R5T7V9X2Z4B6D8';
  const fake = 'AK' + 'IA' + 'IOSFODNN7EXAMPLE';
  assert.deepEqual(scanText(real), [{ id: 'aws-access-key-id', line: 1 }]);
  assert.deepEqual(scanText(`${fake} then ${real}`), [{ id: 'aws-access-key-id', line: 1 }]);
  assert.deepEqual(scanText(`${real} # EXAMPLE TEST`), [{ id: 'aws-access-key-id', line: 1 }]);
});

test('a file, path or directory variable holding a path is not flagged', () => {
  const cases = ['GH_TOKEN_FILE=/tmp/agent-work/token-file-0001',
    'password-file = ./config/passwords/db-01.txt', 'SECRET_DIR=../shared/secrets/2026-11-13'];
  for (const line of cases) assert.deepEqual(scanText(line), [], line);
});

test('the path exception needs both the name and the value', () => {
  const slashValue = 'aws_secret_access_key=' + '/' + 'wJalrXUtnFEMI7K7MDENGbPxRfiCY' + 'abc123XYZ0';
  assert.deepEqual(scanText(slashValue), [{ id: 'secret-assignment', line: 1 }]);
  const fileNameNotPath = 'API_TOKEN_FILE=' + 'abcDEF1234567890abcDEF1234567890';
  assert.deepEqual(scanText(fileNameNotPath), [{ id: 'secret-assignment', line: 1 }]);
  const pathThenReal = 'TOKEN_FILE=/tmp/agent-work/token-file-0001 TOKEN=' + 'abcDEF1234567890abcDEF1234567890';
  assert.deepEqual(scanText(pathThenReal), [{ id: 'secret-assignment', line: 1 }]);
});

test('a value starting with a tilde is not matched as an assignment under any name', () => {
  assert.deepEqual(scanText('tokenPath: ~/secrets/store/token-2026-01'), []);
  assert.deepEqual(scanText('API_TOKEN=~/secrets/store/token-2026-01'), []);
});

test('a real assignment glued to an excluded path value is still flagged', () => {
  const v = 'abcDEF1234567890abcDEF1234567890';
  for (const line of ['SECRET_DIR=/home/u/x/TOKEN=' + v, 'TOKEN_FILE=./token.txt.TOKEN=' + v,
    'SECRET_DIR=/home/user/project/' + 'TOKEN' + ': ' + v]) {
    assert.deepEqual(scanText(line), [{ id: 'secret-assignment', line: 1 }], line);
  }
});

test('stays fast on many path assignments with embedded names', () => {
  const start = Date.now();
  scanText('a_file=/token_file=/'.repeat(20000));
  assert.ok(Date.now() - start < 1000);
});

test('every assignment on a line is judged on its own name and value', () => {
  const v = 'abcDEF1234567890abcDEF1234567890';
  const K = 'TO' + 'KEN';
  const flagged = [
    'X_' + K + '_FILE=/home/example/dir/' + K + '=' + v,
    'password=/home/user/project/' + K + ': ' + v,
    'SECRET_DIR=/home/user/project/' + K + ' = ' + v,
    'SECRET_DIR=/home/user/project/x/' + K + '="' + v + '"',
    K + '=example-placeholder-value-123456PASSWORD=' + v,
  ];
  for (const line of flagged) assert.deepEqual(scanText(line), [{ id: 'secret-assignment', line: 1 }], line);
});

test('location values are not flagged, also glued or in a colon-separated list', () => {
  const K = 'TO' + 'KEN';
  const clean = [
    'SECRETS_PATH=/home/user01/secrets:/opt/x',
    'GH_' + K + '_FILE=/tmp/agent-work/token-file-0001',
    K + '_FILE=/srv/data/' + K + '_DIR=/srv/data/keys-0001/store',
  ];
  for (const line of clean) assert.deepEqual(scanText(line), [], line);
});

test('stays fast on long runs of embedded assignment names', () => {
  const K = 'TO' + 'KEN';
  const start = Date.now();
  scanText('token=/'.repeat(50000));
  scanText((K + '_FILE=/srv/data/x-0001/').repeat(20000));
  assert.ok(Date.now() - start < 1000);
});

test('an assignment written inside another value is judged on its own and on the whole value', () => {
  const v = 'abcDEF1234567890abcDEF1234567890';
  const K = 'TO' + 'KEN';
  const S = 'SEC' + 'RET';
  const flagged = [
    'secret=abc123def' + K + '=ghi456jklmno',
    'password=abc123XYZ' + K.toLowerCase() + 'QWERTY456=',
    'password=Xy7Qw9Rt2Lm4' + K + '=Pz8Kv3Nb6Hj1',
    'password="Xy7Qw9Rt2Lm4Pz8K' + S.toLowerCase() + '=Kv3Nb6"',
    'api_key=Qm9vbGVhbjEy' + K.toLowerCase() + 'U2VjcmV0VmFsdWUx==',
    'X_FILE=/p/' + K + '=abc1' + S + '=def2ghi3jklmnopq',
    'password=/home/user/project/' + K + ': /example/' + S + '=abc1' + K + '=def2ghi3jkl',
    K + '=' + v + S + '=example-value',
  ];
  for (const line of flagged) assert.deepEqual(scanText(line), [{ id: 'secret-assignment', line: 1 }], line);
  assert.deepEqual(scanText(K + '=your-example-token-goes-here-123456'), []);
});

test('stays fast on long runs of assignment starts', () => {
  const start = Date.now();
  scanText('token='.repeat(50000) + 'x'.repeat(100000));
  scanText(('token' + 'a'.repeat(39) + '=').repeat(8000));
  scanText('token: '.repeat(50000));
  assert.ok(Date.now() - start < 1000);
});

test('no generated line that whole-value judging flags is missed', () => {
  const fragments = ['TO' + 'KEN=', 'secret: ', 'password = ', 'api_key="', "API_KEY='", 'GH_TOKEN_FILE=', 'tokenPath: ',
    'SECRET_DIR=', 'abcDEF1234567890abcDEF1234567890', 'abc123def456', 'Xy7Q', '/home/user/', './', '../', '/',
    'example', 'placeholder', 'xxxx', 'redacted', 'token', 'secret', 'password', '=', ':', ' ', '    ', '"', "'",
    '-', '_', '.', ';', '?'];
  const patternSource = PATTERNS.find((p) => p.id === 'secret-assignment').re.source;
  let seed = 12345;
  const next = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  const oracle = (line) => {
    for (const m of line.matchAll(new RegExp(patternSource, 'gi'))) {
      const [, name, value] = m;
      if (/(?:file|path|dir)$/i.test(name) && /^(?:\/|\.\/|\.\.\/)/.test(value)) continue;
      if (/[A-Za-z]/.test(value) && /[0-9]/.test(value) && !/example|placeholder|xxxx|redacted/i.test(value)) return true;
    }
    return false;
  };
  let expected = 0;
  for (let i = 0; i < 20000; i++) {
    const parts = [];
    for (let n = 2 + next(12); n > 0; n--) parts.push(fragments[next(fragments.length)]);
    const line = parts.join('');
    if (!oracle(line)) continue;
    expected += 1;
    if (scanText(line).length === 0) assert.fail(`line ${i} (length ${line.length}) is flagged by whole-value judging but not by the scan`);
  }
  assert.ok(expected >= 1000, `only ${expected} oracle findings`);
});
