/**
 * The Vendo component registry — generated empty by `vendo init`, then yours.
 * One file, two consumers: `createVendo` takes this object as `catalog` and
 * reads only the data fields (description, props, examples); <VendoRoot
 * components={registry}> takes the same object and reads only the component
 * references. There is no second map to keep in sync.
 *
 * Add entries keyed by component name, e.g.:
 *
 *   SpendingDonut: {
 *     component: SpendingDonut,
 *     description: "Spending by category. Use for where-did-my-money-go requests.",
 *     props: z.object({
 *       slices: z.array(z.object({ category: z.string(), amount: z.number() })),
 *     }),
 *     examples: ['{"slices":[{"category":"dining","amount":342.18}]}'],
 *   },
 *
 * (`props` is an optional zod schema; a schema-less entry is legal.)
 */
import type { ComponentRegistry } from "@vendoai/vendo";

export const registry = {} satisfies ComponentRegistry;
