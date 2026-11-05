import { describe, expect, it } from 'vitest';
import { inInterfaceWords } from './interfaceWords';

describe('inInterfaceWords', () => {
  it('replaces the whole words case, job and publication in any letter case', () => {
    expect(inInterfaceWords('Terminal jobs')).toBe('Terminal runs');
    expect(inInterfaceWords('binding cases')).toBe('binding problems');
    expect(inInterfaceWords('Case created')).toBe('Problem created');
    expect(inInterfaceWords('one job, one case, one publication')).toBe('one run, one problem, one published result');
    expect(inInterfaceWords('Publications and Jobs')).toBe('Published results and Runs');
    expect(inInterfaceWords('JOBS')).toBe('RUNS');
  });

  it('leaves other words and parts of words alone', () => {
    expect(inInterfaceWords('showcase, jobless, suitcases, Expired api keys')).toBe('showcase, jobless, suitcases, Expired api keys');
  });
});
