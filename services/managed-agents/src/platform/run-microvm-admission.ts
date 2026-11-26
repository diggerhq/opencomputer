import { DurableObject } from "cloudflare:workers";

/**
 * The rate gate of a compute provider that no longer exists. Nothing calls
 * it. The class stays exported and bound because removing a Durable Object
 * class from a live Worker needs a `deleted_classes` migration, and work
 * 097 decision 8 allows no Durable Object migrations in iteration 1.
 */
export class RunMicrovmAdmission extends DurableObject {}
