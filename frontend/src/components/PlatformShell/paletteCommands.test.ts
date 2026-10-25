import { describe, expect, it } from 'vitest';
import { buildCommands } from './paletteCommands';

describe('buildCommands', () => {
  // [utest->req~frontend-retire-palette~1]
  it('offers no command for a retired address', () => {
    const commands = buildCommands({ isAdmin: true });

    expect(commands.filter((command) => command.label === 'Analysis')).toEqual([]);
    expect(commands.filter((command) => /^\/app\/analysis([/?#]|$)/.test(command.href))).toEqual([]);
  });
});
