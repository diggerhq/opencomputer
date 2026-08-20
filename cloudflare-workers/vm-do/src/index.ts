// opencomputer-vmdo — the dedicated worker that OWNS the VmSession Durable
// Object class (VM-DO exec data plane). Split out of api-edge on purpose:
// api-edge redeploys on every merge that touches web/ or edge code (the
// dashboard SPA is bundled into it as assets), and every deploy resets all
// Durable Objects ("Durable Object reset because its code was updated"),
// severing every host-dialed VM WebSocket — waves of exec fallbacks to the
// tunnel for the next hour. This worker changes only when VM-DO logic changes,
// so the sockets survive the edge's deploy cadence.
//
// api-edge binds the class cross-script:
//   [[durable_objects.bindings]]  name = "VM_SESSIONS"
//   class_name = "VmSession"      script_name = "<this worker>"
// All traffic reaches the DO through that binding (the edge authenticates
// /internal/vms/:id/connect and routes /exec) — this worker has no routes and
// its own fetch handler serves nothing.
export { VmSession } from "./vm_session";
// MicrovmSession is the AWS MicroVM counterpart: same persistent-channel idea,
// but it dials OUT to the box because that runtime has no host process of ours
// to dial in. See microvm_session.ts.
export { MicrovmSession } from "./microvm_session";

export default {
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
};
