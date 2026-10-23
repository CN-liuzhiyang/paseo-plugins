import assert from "node:assert/strict";
import { test } from "node:test";
import { go, jumpOf, openPluginScreenOf, pluginScreenRoute } from "../client/jump";

// Going to another plugin's screen from the item page, in the three cases that exist: the host has
// `navigation.openPluginScreen` (positional), the host does not but the app is on the web, nothing
// can be done from here.

const target = { plugin: "flows", screen: "runs", params: { run: "r1", node: "n 2" } };

test("the host's own way, called positionally and on the navigation object, is the first choice", () => {
  const calls: unknown[][] = [];
  const navigation = {
    marker: "nav",
    openPluginScreen(this: { marker: string }, ...args: unknown[]) {
      calls.push([this.marker, ...args]);
    },
  };
  const jump = jumpOf({ navigation, hostId: "h1", routes: true, ...target });
  assert.equal(jump.how, "host", "even on the web: the host's way does not reload the page");
  const assigned: string[] = [];
  go(jump, target, (url) => assigned.push(url));
  assert.deepEqual(calls, [["nav", "flows", "runs", { run: "r1", node: "n 2" }]]);
  assert.deepEqual(assigned, []);
});

test("a host that cannot throws: the person is told by the host, and the screen does not fall over or go elsewhere", () => {
  const navigation = {
    openPluginScreen() {
      throw new Error("no such screen");
    },
  };
  const assigned: string[] = [];
  assert.doesNotThrow(() => go(jumpOf({ navigation, hostId: "h1", routes: true, ...target }), target, (url) => assigned.push(url)));
  assert.deepEqual(assigned, []);
});

test("a host without it, on the web: the route of the screen, which loads the page again", () => {
  const jump = jumpOf({ navigation: { openAgent() {} }, hostId: "my host", routes: true, ...target });
  assert.deepEqual(jump, { how: "route", route: "/h/my%20host/plugin/flows/surface/runs?param.run=r1&param.node=n%202" });
  const assigned: string[] = [];
  go(jump, target, (url) => assigned.push(url));
  assert.deepEqual(assigned, ["/h/my%20host/plugin/flows/surface/runs?param.run=r1&param.node=n%202"]);
  assert.equal(pluginScreenRoute("h", "p", "s", {}), "/h/h/plugin/p/surface/s", "no params, no query");
});

test("a host without it, not on the web (or no host id): nothing to do from here, and go does nothing", () => {
  for (const input of [
    { navigation: {}, hostId: "h1", routes: false },
    { navigation: undefined, hostId: null, routes: true },
    { navigation: null, hostId: undefined, routes: false },
  ]) {
    const jump = jumpOf({ ...input, ...target });
    assert.deepEqual(jump, { how: "none" });
    const assigned: string[] = [];
    go(jump, target, (url) => assigned.push(url));
    assert.deepEqual(assigned, []);
  }
  assert.equal(openPluginScreenOf({ openPluginScreen: "not a function" }), null);
});
