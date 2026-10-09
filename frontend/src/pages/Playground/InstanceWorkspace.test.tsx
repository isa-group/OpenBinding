import { describe, expect, it } from 'vitest';
import { Workbench } from '../Workbench/Workbench';
import { InstanceWorkspace } from './InstanceWorkspace';
import { Playground } from './Playground';

// The tests of the instance workspace moved with its code: see src/pages/Workbench/Workbench.test.tsx and the tests next to the forms.
describe('retired playground names', () => {
  it('still resolve to the Workbench screen, so an old import cannot reach a second implementation', () => {
    expect(InstanceWorkspace).toBe(Workbench);
    expect(Playground).toBe(Workbench);
  });
});
