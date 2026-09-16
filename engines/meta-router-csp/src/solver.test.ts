import test from 'node:test';
import assert from 'node:assert/strict';
import { MetaRoutingSolver, RoutingRequest } from './solver';

test('MetaRoutingSolver returns INFEASIBLE on empty candidates', () => {
  const solver = new MetaRoutingSolver();
  const result = solver.solve({ candidates: [] });
  assert.equal(result.termination, 'INFEASIBLE');
  assert.equal(result.evaluations.length, 0);
});

test('MetaRoutingSolver selects optimal candidate using MiniZinc or SAW fallback', () => {
  const solver = new MetaRoutingSolver();
  const request: RoutingRequest = {
    candidates: [
      {
        engine: 'evolutionary-heuristics',
        mode: 'elitist-genetic',
        latency: 2.0,
        quality: 0.94,
        failureRisk: 0.02,
        credits: 8,
        confidence: 0.90,
        isExact: false,
        isAvailable: true,
      },
      {
        engine: 'random-search',
        mode: 'seeded',
        latency: 0.05,
        quality: 0.40,
        failureRisk: 0.01,
        credits: 1,
        confidence: 0.80,
        isExact: false,
        isAvailable: true,
      },
    ],
    weights: {
      quality: 0.70,
      latency: 0.10,
      costCredits: 0.10,
      reliability: 0.10,
    },
  };

  const result = solver.solve(request);
  assert.equal(result.termination, 'OPTIMAL');
  assert.ok(result.selected);
  assert.equal(result.selected.engine, 'evolutionary-heuristics');
  assert.ok(result.fallback);
  assert.equal(result.fallback.engine, 'random-search');
  assert.equal(result.evaluations.length, 2);
});

test('MetaRoutingSolver enforces maxCredits constraint', () => {
  const solver = new MetaRoutingSolver();
  const request: RoutingRequest = {
    candidates: [
      {
        engine: 'minizinc-csp',
        mode: 'exact-weighted',
        latency: 5.0,
        quality: 1.0,
        failureRisk: 0.05,
        credits: 35,
        confidence: 0.85,
        isExact: true,
        isAvailable: true,
      },
      {
        engine: 'evolutionary-heuristics',
        mode: 'elitist-genetic',
        latency: 2.0,
        quality: 0.94,
        failureRisk: 0.02,
        credits: 8,
        confidence: 0.90,
        isExact: false,
        isAvailable: true,
      },
    ],
    hardConstraints: {
      maxCredits: 10,
    },
  };

  const result = solver.solve(request);
  assert.equal(result.termination, 'OPTIMAL');
  assert.equal(result.selected?.engine, 'evolutionary-heuristics');

  const mznEval = result.evaluations.find((e) => e.engine === 'minizinc-csp');
  assert.ok(mznEval);
  assert.equal(mznEval.admissible, false);
  assert.match(mznEval.rejectionReason || '', /credits/i);
});

test('MetaRoutingSolver enforces requireExact constraint', () => {
  const solver = new MetaRoutingSolver();
  const request: RoutingRequest = {
    candidates: [
      {
        engine: 'evolutionary-heuristics',
        mode: 'elitist-genetic',
        latency: 1.5,
        quality: 0.94,
        failureRisk: 0.02,
        credits: 8,
        confidence: 0.90,
        isExact: false,
        isAvailable: true,
      },
      {
        engine: 'minizinc-csp',
        mode: 'exact-weighted',
        latency: 4.0,
        quality: 1.0,
        failureRisk: 0.05,
        credits: 35,
        confidence: 0.85,
        isExact: true,
        isAvailable: true,
      },
    ],
    hardConstraints: {
      requireExact: true,
    },
  };

  const result = solver.solve(request);
  assert.equal(result.termination, 'OPTIMAL');
  assert.equal(result.selected?.engine, 'minizinc-csp');

  const gaEval = result.evaluations.find((e) => e.engine === 'evolutionary-heuristics');
  assert.ok(gaEval);
  assert.equal(gaEval.admissible, false);
  assert.match(gaEval.rejectionReason || '', /exact/i);
});

test('MetaRoutingSolver returns INFEASIBLE when all candidates violate constraints', () => {
  const solver = new MetaRoutingSolver();
  const request: RoutingRequest = {
    candidates: [
      {
        engine: 'minizinc-csp',
        mode: 'exact-weighted',
        latency: 10.0,
        quality: 1.0,
        failureRisk: 0.20,
        credits: 35,
        confidence: 0.85,
        isExact: true,
        isAvailable: true,
      },
    ],
    hardConstraints: {
      maxTimeBudgetMs: 5000,
    },
  };

  const result = solver.solve(request);
  assert.equal(result.termination, 'INFEASIBLE');
  assert.equal(result.selected, undefined);
  assert.equal(result.evaluations.length, 1);
  assert.equal(result.evaluations[0].admissible, false);
});
