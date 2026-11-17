import { describe, expect, it } from 'vitest';
import { FEDERATED_PRESET, NO_GOAL_PRESET, presetFixture } from '../../../test/fixtures/presets';
import {
  isFederatedPreset,
  presetEngineLabel,
  presetEngineRef,
  presetEngineText,
  presetOptimizationText,
  presetOptionsText,
  presetRegistrationText,
  studyPresetRefusal,
} from './presetText';

describe('a run preset on screen', () => {
  it('names an exact engine by name and version, and a built-in one by the name the preset gives', () => {
    expect(presetEngineLabel(presetFixture().engine)).toBe('random-search 1.0.0');
    expect(presetEngineLabel('random-search')).toBe('random-search');
    expect(presetEngineRef('random-search')).toBeNull();
    expect(presetEngineRef(presetFixture().engine)).toEqual(presetFixture().engine);
    expect(presetEngineText(presetFixture())).toBe('random-search 1.0.0 · mode sampling');
    expect(presetEngineText({ engine: 'random-search', mode: null })).toBe(
      'random-search · default mode'
    );
  });

  it('writes the options as they are, with a time budget in seconds', () => {
    expect(presetOptionsText(presetFixture().options)).toBe('time budget 30 s · iterations 5,000');
    expect(presetOptionsText({})).toBe('Engine defaults');
    expect(presetOptionsText({ label: 'fast', weights: [1, 2] })).toBe(
      'label fast · weights [1,2]'
    );
  });

  it('writes the optimization with its weights, and nothing when the run chooses it', () => {
    expect(presetOptimizationText(presetFixture().optimization)).toBe('SINGLE · weighted-sum');
    expect(
      presetOptimizationText({
        type: 'MULTI',
        scalarization: 'weighted-sum',
        weights: [
          { criteria: 'cost', value: 0.7 },
          { criteria: 'latency', value: 0.3 },
        ],
      })
    ).toBe('MULTI · weighted-sum (weights cost 0.7, latency 0.3)');
    expect(presetOptimizationText(null)).toBeNull();
  });

  it('names the deployment of a federated preset', () => {
    expect(isFederatedPreset(FEDERATED_PRESET)).toBe(true);
    expect(isFederatedPreset(presetFixture())).toBe(false);
    expect(presetRegistrationText(FEDERATED_PRESET.registration)).toBe('edge-lab/edge-solver-eu 1');
    expect(presetRegistrationText(null)).toBeNull();
  });

  it('says why a study cannot take a federated preset or one without an optimization', () => {
    expect(studyPresetRefusal(presetFixture())).toBeNull();
    expect(studyPresetRefusal(FEDERATED_PRESET)).toBe(
      'Runs on a federated deployment: presets of federated engines can’t join a study yet.'
    );
    expect(studyPresetRefusal(NO_GOAL_PRESET)).toBe(
      'Names no optimization, which a study engine needs.'
    );
  });
});
