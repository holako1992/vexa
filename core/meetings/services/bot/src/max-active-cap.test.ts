/**
 * L1 — `deriveMaxActiveMs` (ARCHITECTURE.md §5, index.ts). Pure function, no browser/redis/STT.
 * Asserts the three-way ceiling combination the per-plan minute cap depends on:
 *   • a per-meeting `automaticLeave.maxBotTime` narrows the deployment's `BOT_MAX_ACTIVE_MS`
 *     when it is SMALLER (the plan-cap case — Free's 60min bot must not run 4h);
 *   • it never WIDENS past the deployment cap (a plan cap larger than BOT_MAX_ACTIVE_MS cannot
 *     override an operator's own ceiling);
 *   • absent `maxBotTime`, behavior is unchanged (deployment cap alone, floored by the granular
 *     timeouts + margin);
 *   • the granular-timeout floor still wins over a `maxBotTime` set too low to let the lobby/
 *     silence windows fire first.
 * Run: npx tsx src/max-active-cap.test.ts
 */
import { deriveMaxActiveMs, DEFAULT_MAX_ACTIVE_MS } from './index.js';
import type { Invocation } from './config.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const BASE: Invocation = {
  platform: 'google_meet',
  meetingUrl: 'https://meet.google.com/xxx-xxxx-xxx',
  botName: 'Vexa',
  redisUrl: 'redis://redis:6379',
};

// Small granular timeouts throughout so the margin floor (max(timeouts) + 60s) never masks the
// cap being asserted — everyoneLeftMs (the aloneness window) is passed separately, also kept small.
const SMALL_TIMEOUTS = { waitingRoomTimeout: 10_000, noOneJoinedTimeout: 10_000 };
const EVERYONE_LEFT_MS = 10_000;
const FLOOR = Math.max(EVERYONE_LEFT_MS, SMALL_TIMEOUTS.noOneJoinedTimeout, SMALL_TIMEOUTS.waitingRoomTimeout) + 60_000; // 70_000

// ── no maxBotTime at all: unchanged behavior — deployment env cap (or the 4h default), floored ──
{
  const inv: Invocation = { ...BASE, automaticLeave: { ...SMALL_TIMEOUTS } };
  const noEnv = deriveMaxActiveMs(inv, EVERYONE_LEFT_MS, {});
  check('no env, no maxBotTime → 4h default', noEnv === DEFAULT_MAX_ACTIVE_MS, String(noEnv));

  const withEnv = deriveMaxActiveMs(inv, EVERYONE_LEFT_MS, { BOT_MAX_ACTIVE_MS: '3600000' } as NodeJS.ProcessEnv);
  check('env cap, no maxBotTime → env cap', withEnv === 3_600_000, String(withEnv));
}

// ── the per-meeting cap (plan minute cap resolved by meeting-api) overrides the env default when
//    SMALLER — the case DB-72b exists for: a Free user's 60-minute plan cap on a deployment whose
//    BOT_MAX_ACTIVE_MS default is 4h ──
{
  const oneHourMs = 60 * 60 * 1000;
  const inv: Invocation = { ...BASE, automaticLeave: { ...SMALL_TIMEOUTS, maxBotTime: oneHourMs } };
  const result = deriveMaxActiveMs(inv, EVERYONE_LEFT_MS, {}); // no env override → 4h default would otherwise apply
  check(
    'plan cap (1h) overrides the 4h deployment default when smaller',
    result === oneHourMs,
    String(result),
  );
}

// ── a per-meeting cap LARGER than the deployment's own env cap never widens past it — the
//    operator's ceiling wins ──
{
  const inv: Invocation = { ...BASE, automaticLeave: { ...SMALL_TIMEOUTS, maxBotTime: 4 * 60 * 60 * 1000 } };
  const result = deriveMaxActiveMs(inv, EVERYONE_LEFT_MS, { BOT_MAX_ACTIVE_MS: '1800000' } as NodeJS.ProcessEnv); // 30min env cap
  check('a larger plan cap never widens past the deployment env cap', result === 1_800_000, String(result));
}

// ── the granular-timeout floor still wins over a maxBotTime set below it (never undercuts the
//    lobby/silence windows the caller also configured) ──
{
  const inv: Invocation = {
    ...BASE,
    automaticLeave: { waitingRoomTimeout: 500_000, noOneJoinedTimeout: 100_000, maxBotTime: 1_000 },
  };
  const result = deriveMaxActiveMs(inv, 0, {});
  const expectedFloor = 500_000 + 60_000;
  check('the granular-timeout floor wins over an under-sized maxBotTime', result === expectedFloor, String(result));
}

// ── a zero/negative maxBotTime is treated as absent, never as "leave immediately" ──
{
  const inv: Invocation = { ...BASE, automaticLeave: { ...SMALL_TIMEOUTS, maxBotTime: 0 } };
  const result = deriveMaxActiveMs(inv, EVERYONE_LEFT_MS, {});
  check('maxBotTime: 0 is treated as absent (4h default), not as a zero cap', result === DEFAULT_MAX_ACTIVE_MS, String(result));
}

console.log(failed === 0 ? '\nAll max-active-cap checks passed.' : `\n${failed} max-active-cap check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
