/*
 * Browser end-to-end test: drives the real site against the real database.
 * Uses its own "__test__" components and removes them afterwards.
 *
 *   npm i --no-save playwright@1.64.1      (once, anywhere; or set NODE_PATH)
 *   python3 -m http.server 8765 &          (from the repo root)
 *   SITE=http://localhost:8765 node tests/e2e.cjs
 *
 * Credentials come from .env (APP_LOGIN_USERNAME / APP_LOGIN_PASSWORD).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const env = { ...process.env };
if (fs.existsSync(path.join(ROOT, '.env'))) {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2];
  }
}
const SITE = env.SITE || 'http://localhost:8765';
const USER = env.APP_LOGIN_USERNAME;
const PASS = env.APP_LOGIN_PASSWORD;
const SHOTS = env.SHOTS || path.join(ROOT, 'test-results');
const T = '__test__ ';

let passed = 0, failed = 0;
const problems = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✖ ${name} ${detail}`); }
}
const cleanup = () => execFileSync('python3', [path.join(ROOT, 'tests/api_test.py'), '--cleanup'], { stdio: 'ignore' });

async function newPage(browser, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
  });
  return { ctx, page };
}

async function login(page, user = USER, pass = PASS) {
  await page.goto(SITE);
  await page.waitForSelector('#login-page:not(.hidden-section), #app:not(.hidden-section)');
  if (await page.isVisible('#app')) return;
  await page.fill('#username', user);
  await page.fill('#password', pass);
  await page.click('#login-submit');
}

const row = (page, tbody, text) => page.locator(`${tbody} tr`, { hasText: text });
const toastText = (page) => page.locator('#toasts').innerText();

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const { ctx, page } = await newPage(browser);

  console.log('Login');
  await page.goto(SITE);
  await page.waitForSelector('#login-page:not(.hidden-section)');
  check('logged-out visitor sees only the login page', !(await page.isVisible('#app')));
  await page.screenshot({ path: `${SHOTS}/01-login.png` });
  await login(page, USER, PASS + 'wrong');
  await page.waitForSelector('#login-error:not(.hidden-section)');
  check('wrong password shows an error', (await page.innerText('#login-error')).includes('Authentication failed'));
  await login(page, USER.toUpperCase(), PASS);
  await page.waitForSelector('#app:not(.hidden-section)', { timeout: 15000 });
  check('correct login opens the ledger (username not case-sensitive)', true);
  await page.waitForSelector('#live-status.live', { timeout: 20000 }).catch(() => {});
  check('realtime connection is live', await page.isVisible('#live-status.live'));

  console.log('New entry');
  await page.click('#open-add');
  await page.fill('#add-name', `${T}Arduino Uno`);
  await page.fill('#add-units', '5');
  check('"Added today" is the default date', (await page.innerText('[data-date-field=add] .date-mode.active')).includes('today'));
  await page.screenshot({ path: `${SHOTS}/02-add-modal.png` });
  await page.click('#form-add button[type=submit]');
  await row(page, '#stock-body', `${T}Arduino Uno`).waitFor();
  check('component appears with 5 units', (await row(page, '#stock-body', `${T}Arduino Uno`).innerText()).includes('5 Units'));

  await page.click('#open-add');
  await page.fill('#add-name', `${T.toUpperCase()}arduino uno`);
  check('hint says it adds to existing stock', (await page.innerText('#add-name-hint')).includes('Adds to existing stock'));
  await page.fill('#add-units', '3');
  await page.click('[data-date-field=add] [data-mode=custom]');
  await page.fill('[data-date-field=add] input[type=date]', '2026-01-15');
  await page.click('#form-add button[type=submit]');
  await page.waitForFunction((t) => [...document.querySelectorAll('#stock-body tr')].some((r) => r.innerText.includes(t) && r.innerText.includes('8 Units')), `${T}Arduino Uno`);
  const r1 = await row(page, '#stock-body', `${T}Arduino Uno`).innerText();
  check('same name adds to stock (total 8) and keeps earliest date', r1.includes('8 Units') && r1.includes('15 Jan 2026'), r1);

  await page.click('#open-add');
  await page.fill('#add-name', `${T}Servo`);
  await page.fill('#add-units', '0');
  await page.click('#form-add button[type=submit]');
  check('zero units rejected with a message', (await page.innerText('#form-add .form-error')).includes('at least 1'));
  await page.click('[data-date-field=add] [data-mode=custom]');
  await page.fill('#add-units', '2');
  await page.fill('[data-date-field=add] input[type=date]', '2099-01-01');
  await page.click('#form-add button[type=submit]');
  check('future date rejected', (await page.innerText('#form-add .form-error')).includes('future'));
  await page.click('[data-date-field=add] [data-mode=today]');
  await page.click('#form-add button[type=submit]');
  await row(page, '#stock-body', `${T}Servo`).waitFor();

  console.log('Issue');
  await page.click('#open-issue');
  await page.selectOption('#issue-component', { label: `${T}Arduino Uno — 8 available` });
  await page.fill('#issue-units', '9');
  await page.fill('#issue-name', 'Test Borrower');
  await page.fill('#issue-roll', '080bei013');
  check('roll number placeholder is 080bei013', (await page.getAttribute('#issue-roll', 'placeholder')) === '080bei013');
  await page.click('#form-issue button[type=submit]');
  check('cannot issue more than available', (await page.innerText('#form-issue .form-error')).includes('Only 8'));
  await page.fill('#issue-units', '2');
  await page.screenshot({ path: `${SHOTS}/03-issue-modal.png` });
  await page.click('#form-issue button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#modal-issue').classList.contains('hidden-section'));
  check('available drops to 6', (await row(page, '#stock-body', `${T}Arduino Uno`).innerText()).includes('6 Units'));
  await page.click('[data-view=logs]');
  const log1 = await row(page, '#logs-body', 'Test Borrower').innerText();
  check('log shows borrower, roll (uppercased), units, on loan', log1.includes('080BEI013') && log1.includes('2 Units') && log1.includes('On loan'), log1);

  await page.click('[data-view=stock]');
  await row(page, '#stock-body', `${T}Servo`).locator('.act-issue').click();
  check('row "Issue" button preselects the component', (await page.inputValue('#issue-component')) !== '');
  await page.fill('#issue-name', 'Odd Roll');
  await page.fill('#issue-roll', 'staff-1');
  await page.click('#form-issue button[type=submit]');
  check('unusual roll number asks for confirmation', (await page.innerText('#issue-roll-hint')).includes("doesn't look like"));
  await page.click('#form-issue button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#modal-issue').classList.contains('hidden-section'));
  check('second press saves it anyway', true);

  console.log('Return');
  await page.click('[data-view=logs]');
  await row(page, '#logs-body', 'Test Borrower').locator('.act-return').click();
  check('"Returned today" is the default', (await page.innerText('[data-date-field=return] .date-mode.active')).includes('today'));
  await page.click('[data-date-field=return] [data-mode=custom]');
  await page.fill('[data-date-field=return] input[type=date]', '2020-01-01');
  await page.click('#form-return button[type=submit]');
  check('return before issue date rejected', (await page.innerText('#form-return .form-error')).includes("can't be before"));
  await page.click('[data-date-field=return] [data-mode=today]');
  await page.click('#form-return button[type=submit]');
  await page.waitForFunction(() => [...document.querySelectorAll('#logs-body tr')].some((r) => r.innerText.includes('Test Borrower') && r.innerText.includes('Returned')));
  check('record shows Returned', true);
  await page.click('[data-filter=active]');
  check('"On loan" filter hides returned records', (await row(page, '#logs-body', 'Test Borrower').count()) === 0);
  await page.click('[data-filter=all]');
  await page.screenshot({ path: `${SHOTS}/04-logs.png`, fullPage: true });

  console.log('Bin');
  await page.click('[data-view=stock]');
  await row(page, '#stock-body', `${T}Servo`).locator('.act-bin').click();
  await page.waitForTimeout(300);
  check('binning a component with an active loan is blocked', (await toastText(page)).includes('out on loan'));
  await page.click('[data-view=logs]');
  await row(page, '#logs-body', 'Odd Roll').locator('.act-bin').click();
  await page.click('#confirm-ok');
  await page.waitForFunction(() => !document.querySelector('#bin-count').classList.contains('hidden-section'));
  check('bin badge shows 1', (await page.innerText('#bin-count')) === '1');
  await page.click('[data-view=stock]');
  await row(page, '#stock-body', `${T}Servo`).locator('.act-bin').click();
  await page.click('#confirm-ok');
  await page.waitForFunction(() => document.querySelector('#bin-count').textContent === '2');
  check('component moved to bin (badge 2)', (await row(page, '#stock-body', `${T}Servo`).count()) === 0);
  await page.click('[data-view=bin]');
  check('bin lists the component', (await row(page, '#bin-components-body', `${T}Servo`).count()) === 1);
  check('bin lists the issue record', (await row(page, '#bin-issues-body', 'Odd Roll').count()) === 1);
  await page.screenshot({ path: `${SHOTS}/05-bin.png`, fullPage: true });
  await row(page, '#bin-components-body', `${T}Servo`).locator('.act-restore').click();
  await page.waitForFunction(() => document.querySelector('#bin-count').textContent === '1');
  check('restore puts the component back', true);
  await row(page, '#bin-issues-body', 'Odd Roll').locator('.act-delete').click();
  check('permanent delete asks for confirmation', (await page.innerText('#confirm-title')).includes('permanently'));
  await page.click('#modal-confirm [data-close].btn');
  check('cancel keeps the record', (await row(page, '#bin-issues-body', 'Odd Roll').count()) === 1);
  await row(page, '#bin-issues-body', 'Odd Roll').locator('.act-delete').click();
  await page.click('#confirm-ok');
  await page.waitForFunction(() => document.querySelector('#bin-count').classList.contains('hidden-section'));
  check('record permanently deleted, bin empty', true);

  console.log('Live sync between two devices');
  const second = await newPage(browser, { width: 390, height: 844 });
  await login(second.page);
  await second.page.waitForSelector('#app:not(.hidden-section)');
  await second.page.waitForSelector('#live-status.live', { timeout: 20000 }).catch(() => {});
  await page.click('[data-view=stock]');
  await page.click('#open-add');
  await page.fill('#add-name', `${T}Live Sync Part`);
  await page.fill('#add-units', '4');
  await page.click('#form-add button[type=submit]');
  const t0 = Date.now();
  const seen = await row(second.page, '#stock-body', `${T}Live Sync Part`).waitFor({ timeout: 10000 }).then(() => true, () => false);
  check(`other device sees the new entry without refreshing (${Date.now() - t0} ms)`, seen);
  await second.page.screenshot({ path: `${SHOTS}/06-mobile-stock.png`, fullPage: true });
  const overflow = await second.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('no sideways page scroll on a phone', !overflow);

  console.log('Search & export');
  await page.fill('#search', 'servo');
  await page.waitForTimeout(250);
  check('search filters the stock list', (await page.locator('#stock-body tr').count()) === 1);
  await page.fill('#search', '');
  await page.click('#export-btn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-export=xlsx]')]);
  const file = path.join(SHOTS, dl.suggestedFilename());
  await dl.saveAs(file);
  check('Excel export downloads a workbook', fs.statSync(file).size > 1000 && file.endsWith('.xlsx'), file);
  await page.click('#export-btn');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('[data-export=json]')]);
  const jfile = path.join(SHOTS, dl2.suggestedFilename());
  await dl2.saveAs(jfile);
  const json = JSON.parse(fs.readFileSync(jfile, 'utf8'));
  check('JSON export contains the data', json.components.some((c) => c.name === `${T}Arduino Uno`));

  console.log('Offline fallback');
  await page.route('**/rest/v1/**', (r) => r.abort('internetdisconnected'));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForSelector('#conn-banner:not(.hidden-section)', { timeout: 10000 });
  check('offline banner appears and data stays visible', (await row(page, '#stock-body', `${T}Arduino Uno`).count()) === 1);
  check('write buttons are hidden while offline', !(await page.isVisible('#open-add')));
  await page.screenshot({ path: `${SHOTS}/07-offline.png` });
  await page.unroute('**/rest/v1/**');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForSelector('#conn-banner.hidden-section', { state: 'attached', timeout: 10000 });
  check('recovers automatically when back online', await page.isVisible('#open-add'));

  console.log('Session');
  await page.reload();
  await page.waitForSelector('#app:not(.hidden-section)', { timeout: 15000 });
  check('stays logged in after refresh', true);
  await page.click('#logout-btn');
  await page.waitForSelector('#login-page:not(.hidden-section)');
  const cache = await page.evaluate(() => localStorage.getItem('robostore-cache-v1'));
  check('log out returns to login and clears cached data', cache === null);
  await page.reload();
  await page.waitForSelector('#login-page:not(.hidden-section)');
  check('still logged out after refresh', !(await page.isVisible('#app')));

  await second.ctx.close();
  await ctx.close();
  await browser.close();

  const real = problems.filter((p) => !/Failed to load resource.*(net::ERR_INTERNET_DISCONNECTED|net::ERR_FAILED)|status of 400|internetdisconnected|Failed to fetch/i.test(p));
  check('no JavaScript errors or CSP violations', real.length === 0, '\n    ' + real.join('\n    '));
}

(async () => {
  try { cleanup(); await main(); }
  catch (e) { failed++; console.log(`  ✖ crashed: ${e.stack}`); }
  finally {
    cleanup();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
