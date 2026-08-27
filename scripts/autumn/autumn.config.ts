import { feature, item, plan } from "atmn";

// This is the complete shared OpenComputer catalog. Keep existing production
// IDs and prices stable: atmn push reconciles the whole target environment, so
// omitting an existing resource can propose deleting or archiving it.

export const compute1gb = feature({
  id: "compute_1gb",
  name: "compute_1gb",
  type: "metered",
  consumable: true,
});

export const compute4gb = feature({
  id: "compute_4gb",
  name: "compute_4gb",
  type: "metered",
  consumable: true,
});

export const compute8gb = feature({
  id: "compute_8gb",
  name: "compute_8gb",
  type: "metered",
  consumable: true,
});

export const compute16gb = feature({
  id: "compute_16gb",
  name: "compute_16gb",
  type: "metered",
  consumable: true,
});

export const compute32gb = feature({
  id: "compute_32gb",
  name: "compute_32gb",
  type: "metered",
  consumable: true,
});

export const compute64gb = feature({
  id: "compute_64gb",
  name: "compute_64gb",
  type: "metered",
  consumable: true,
});

export const modelSpend = feature({
  id: "model_spend",
  name: "model_spend",
  type: "metered",
  consumable: true,
});

export const browserRuntime = feature({
  id: "browser_runtime",
  name: "browser_runtime",
  type: "metered",
  consumable: true,
});

export const diskOverageGbSeconds = feature({
  id: "disk_overage_gb_seconds",
  name: "disk_overage_gb_seconds",
  type: "metered",
  consumable: true,
});

export const agentRuntime = feature({
  id: "agent_runtime_2gb_1vcpu",
  name: "Agent runtime (2 GB / 1 vCPU)",
  type: "metered",
  consumable: true,
});

// Entitlement gate for connecting an external Claude/Codex subscription
// (work 011). Boolean feature: present on a plan = allowed, absent = denied.
// Not metered and not part of the credit system; subscription-routed model
// inference carries no OpenComputer model charge by design.
export const byoModelSubscriptions = feature({
  id: "byo_model_subscriptions",
  name: "byo_model_subscriptions",
  type: "boolean",
});

export const credits = feature({
  id: "credits",
  name: "credits",
  type: "credit_system",
  creditSchema: [
    { meteredFeatureId: compute1gb.id, creditCost: 0.00001666666666 },
    { meteredFeatureId: compute4gb.id, creditCost: 0.00006666666664 },
    { meteredFeatureId: compute8gb.id, creditCost: 0.00013333333328 },
    { meteredFeatureId: compute16gb.id, creditCost: 0.00026666666656 },
    { meteredFeatureId: compute32gb.id, creditCost: 0.00053333333312 },
    { meteredFeatureId: compute64gb.id, creditCost: 0.00106666666624 },
    {
      meteredFeatureId: modelSpend.id,
      // The model meter submits provider spend in micro-dollars.
      creditCost: 0.000001,
    },
    { meteredFeatureId: browserRuntime.id, creditCost: 0.000133333333 },
    { meteredFeatureId: diskOverageGbSeconds.id, creditCost: 0.0000001 },
    {
      meteredFeatureId: agentRuntime.id,
      // $0.00315 per minute, billed in whole seconds.
      creditCost: 0.0000525,
    },
  ],
});

export const base = plan({
  id: "base",
  name: "base",
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
  name: "top_up",
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

export const concurrencyPro = plan({
  id: "concurrency_pro",
  name: "concurrency_pro",
  addOn: true,
  price: { amount: 150, interval: "month" },
  items: [],
});

export const concurrencyPlus = plan({
  id: "concurrency_plus",
  name: "concurrency_plus",
  addOn: true,
  price: { amount: 500, interval: "month" },
  items: [],
});

export const concurrencyPlusPlus = plan({
  id: "concurrency_plus_plus",
  name: "concurrency_plus_plus",
  addOn: true,
  price: { amount: 1_000, interval: "month" },
  items: [],
});

export const pro = plan({
  id: "pro",
  name: "Pro",
  description: "$20 per month with $200 in shared OpenComputer credits.",
  group: "usage_plan",
  price: { amount: 20, interval: "month" },
  items: [
    item({
      featureId: credits.id,
      included: 200,
      reset: { interval: "month" },
    }),
    item({
      featureId: byoModelSubscriptions.id,
    }),
  ],
});

export const max = plan({
  id: "max",
  name: "Max",
  description: "$200 per month with $2,000 in shared OpenComputer credits.",
  group: "usage_plan",
  price: { amount: 200, interval: "month" },
  items: [
    item({
      featureId: credits.id,
      included: 2_000,
      reset: { interval: "month" },
    }),
    item({
      featureId: byoModelSubscriptions.id,
    }),
  ],
});
