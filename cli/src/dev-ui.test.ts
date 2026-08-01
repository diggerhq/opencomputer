import assert from "node:assert/strict";
import test from "node:test";

import { renderDevUI } from "./dev-ui.js";

test("the dev UI shell escapes the agent name and loads bundled assets", () => {
  const html = renderDevUI('Inbox </title><script>alert("x")</script>');
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /Inbox &lt;\/title&gt;&lt;script&gt;/);
  assert.match(html, /<script src="\/assets\/dev-ui\.js" defer>/);
  assert.match(html, /<link rel="stylesheet" href="\/assets\/dev-ui\.css">/);
});
