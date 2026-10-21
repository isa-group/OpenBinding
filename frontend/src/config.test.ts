import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadConfig() {
  vi.resetModules();
  return (await import('./config')).config;
}

describe('application configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('points to the native SPACE and SPHERE consoles by default', async () => {
    vi.stubEnv('VITE_SPACE_FRONTEND_URL', '');
    vi.stubEnv('VITE_SPHERE_URL', '');
    const config = await loadConfig();

    expect(config.spaceFrontendUrl).toBe('https://space.score.us.es');
    expect(config.sphereUrl).toBe('https://sphere.score.us.es');
  });

  it('takes the console addresses from the environment when it names them', async () => {
    vi.stubEnv('VITE_SPACE_FRONTEND_URL', 'https://space.example.test');
    vi.stubEnv('VITE_SPHERE_URL', 'https://sphere.example.test');
    const config = await loadConfig();

    expect(config.spaceFrontendUrl).toBe('https://space.example.test');
    expect(config.sphereUrl).toBe('https://sphere.example.test');
  });
});
