import { createFakeServer, type FakeServer } from '@opencomputer/sdk/computer/fake'
import type { Host } from './host'
import { browserParts, urlLocation } from './host-web'

// The surface against the fake server, all in the tab: for development,
// screenshots and the journey tests. `?fake=empty` is a new organization.

declare global {
  interface Window {
    __fake?: FakeServer
  }
}

export function fakeHost(o: { base: string; seed?: 'demo' | 'empty'; platform?: Host['platform'] }): Host {
  const fake = createFakeServer({ seed: o.seed ?? 'demo', pace: 30, latency: 40 })
  // Tests and the console drive the agents through this.
  window.__fake = fake
  return {
    platform: o.platform ?? 'web',
    principal: fake.principal,
    name: 'Igor',
    api: { fetch: (path, init) => fake.fetch(path, init) },
    connect: () => fake.connect(),
    location: urlLocation(o.base),
    ...browserParts(),
  }
}
