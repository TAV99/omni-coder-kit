import test from "node:test";
import assert from "node:assert/strict";
import { V4_SCHEMA_VERSION } from "../../src/v4/index";

test("v4 exports schema version 1", () => {
  assert.equal(V4_SCHEMA_VERSION, 1);
});
