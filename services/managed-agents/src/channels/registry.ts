// Importing this module registers every built-in provider. Edge entry points
// import it for the side effect, so a request handler can resolve an adapter
// by name without knowing which providers exist.
import { registerChannelAdapter } from "./adapter.js";
import { slackAdapter } from "./slack-adapter.js";
import { twilioAdapter } from "./twilio-adapter.js";

registerChannelAdapter(slackAdapter);
registerChannelAdapter(twilioAdapter);

export { channelAdapter, channelAdapterProviders } from "./adapter.js";
export type {
  ApprovalCard,
  ChannelAdapter,
  InboundChannelMessage,
  InboundDecision,
  InboundQuestionAnswer,
  QuestionCard,
  QuestionMode,
} from "./adapter.js";
