import { feature, item, plan } from "atmn";

// Keep these IDs aligned with the feature IDs emitted by the billing paths in
// cloudflare-workers/api-edge. Credits are denominated in US dollars.
export const agentRuntime = feature({
  id: "agent_runtime_2gb_1vcpu",
  name: "Agent runtime (2 GB / 1 vCPU)",
  type: "metered",
  consumable: true,
});

export const credits = feature({
  id: "credits",
  name: "Credits",
  type: "credit_system",
  creditSchema: [
    {
      meteredFeatureId: agentRuntime.id,
      // $0.00315 per minute, billed in whole seconds.
      creditCost: 0.0000525,
    },
  ],
});

export const base = plan({
  id: "base",
  name: "Usage",
  description: "Default OpenComputer usage balance.",
  autoEnable: true,
  items: [
    item({
      featureId: credits.id,
      included: 5,
      reset: { interval: "one_off" },
    }),
  ],
});

export const topUp = plan({
  id: "top_up",
  name: "Credit top-up",
  description: "One-off prepaid OpenComputer credits.",
  addOn: true,
  items: [
    item({
      featureId: credits.id,
      price: {
        amount: 1,
        billingUnits: 1,
        billingMethod: "prepaid",
        interval: "one_off",
      },
    }),
  ],
});
