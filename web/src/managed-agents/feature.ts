// The experiment is on by default for this launch. Set the build-time value to
// "0" to restore the existing dashboard and navigation without removing any
// legacy routes.
export const managedAgentsExperimentEnabled =
  import.meta.env.VITE_MANAGED_AGENTS_EXPERIMENT !== '0'
