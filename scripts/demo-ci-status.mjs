#!/usr/bin/env node
// Demo live source: prints a status-list whose state changes over time (no network needed).
const t = Math.floor(Date.now() / 4000);
const states = ['ok', 'pending', 'fail', 'ok'];
const pick = (i) => states[(t + i) % states.length];
console.log(JSON.stringify({
  items: [
    { label: 'main · build', status: 'ok', detail: '2m 11s' },
    { label: 'main · e2e', status: pick(0), detail: pick(0) === 'fail' ? 'checkout.spec.ts' : '' },
    { label: 'PR #42 · lint', status: pick(1) },
    { label: 'PR #42 · unit', status: pick(2) },
    { label: 'nightly · perf', status: 'ok', detail: `refreshed ${new Date().toLocaleTimeString()}` },
  ],
}));
